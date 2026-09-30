import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Ticket } from "../../../../shared/types";
import { sendMail, handleMailBatch, type MailMessage } from "../lib/email-aliyun";
import { TICKET_SENDER, ORDER_SENDER, ACCOUNT_SENDER, OPS_SENDER, cfSenderFor } from "../lib/email-cf";
import type { Env } from "../types";

/**
 * CF Email Service 发信通道（lib/email-cf.ts + email-aliyun.ts sendMailDispatch）：
 * - 已知 kind（ticket/order/account/magic/notify）且 EMAIL binding 在 → CF 通道，按四桶分发件人：
 *   ticket→support@（双向，回信进 Email Routing 闭环）、order→service@、account/magic→account@、
 *   notify→ops@；非工单邮件统一带 Reply-To: support@
 * - 无 EMAIL binding → 回退阿里云 DM（本地 dev / 未配置行为不变）
 * - kind 缺失/未知即使 EMAIL 在也保守走 DM
 * - CF 通道抛错 → 回退 DM（邮件不因单通道故障丢失）
 * - consumer handleMailBatch 按消息 kind 在消费时分发通道（入队不定通道，binding 运行时探测）
 * - 端到端：POST /api/feedback 的回执与站长通知都经 CF 通道发出（各自桶的发件人）
 * DM API 走 fetch stub；EMAIL 用 vi.fn 假 binding。
 */

const CREDS = { ALIYUN_ACCESS_KEY_ID: "k", ALIYUN_ACCESS_KEY_SECRET: "s" };

const fakeEmailBinding = (failing = false) => {
  const send = vi.fn(async (_msg: unknown) => {
    if (failing) throw new Error("cf email unavailable");
    return { messageId: "cf-msg-1" };
  });
  return { binding: { send } as unknown as SendEmail, send };
};

const stubDmOk = () =>
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ RequestId: "req-1", EnvId: "e1" })));

type SentMail = { from: string; to: string; subject: string; html: string; text: string; replyTo?: string };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("cfSenderFor 四桶发件人映射", () => {
  it("kind → 发件人：ticket→support@、order→service@、account/magic→account@、notify→ops@", () => {
    expect(cfSenderFor("ticket")).toBe(TICKET_SENDER);
    expect(cfSenderFor("order")).toBe(ORDER_SENDER);
    expect(cfSenderFor("account")).toBe(ACCOUNT_SENDER);
    expect(cfSenderFor("magic")).toBe(ACCOUNT_SENDER); // 历史 kind 归 account 桶
    expect(cfSenderFor("notify")).toBe(OPS_SENDER);
    // 主域四桶规划的实际地址
    expect(TICKET_SENDER).toBe("support@fastergamer.click");
    expect(ORDER_SENDER).toBe("service@fastergamer.click");
    expect(ACCOUNT_SENDER).toBe("account@fastergamer.click");
    expect(OPS_SENDER).toBe("ops@fastergamer.click");
  });

  it("kind 缺失/未知：返回 undefined（调用方保守回退 DM）", () => {
    expect(cfSenderFor(undefined)).toBeUndefined();
    expect(cfSenderFor("whatever")).toBeUndefined();
  });
});

describe("sendMailDispatch 通道选择", () => {
  it("工单邮件（kind:ticket）+ EMAIL binding：走 CF 通道，from 为工单收件地址，不带 replyTo，不调 DM", async () => {
    const { binding, send } = fakeEmailBinding();
    stubDmOk();
    const env = { ...CREDS, EMAIL: binding } as Env;

    const res = await sendMail(env, "u@example.com", "[工单 fb_a1b2c3]【FrogLeap】你的反馈已有回复", "<p>h</p>", "t", {
      kind: "ticket",
    });

    expect(res).toEqual({ ok: true, id: "cf-msg-1" });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as SentMail;
    expect(msg.from).toBe(TICKET_SENDER);
    expect(msg.to).toBe("u@example.com");
    expect(msg.subject).toContain("[工单 fb_a1b2c3]"); // 串线标签保留
    expect(msg.replyTo).toBeUndefined(); // 工单件 From 即收件地址，无需 Reply-To
    expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // DM 未动
  });

  it.each([
    ["order", ORDER_SENDER],
    ["account", ACCOUNT_SENDER],
    ["magic", ACCOUNT_SENDER],
    ["notify", OPS_SENDER],
  ])("kind:%s + EMAIL binding：走 CF 通道，from 为对应桶，Reply-To 指 support@", async (kind, sender) => {
    const { binding, send } = fakeEmailBinding();
    stubDmOk();
    const env = { ...CREDS, EMAIL: binding } as Env;

    const res = await sendMail(env, "u@example.com", "主题", "<p>h</p>", "t", { kind });

    expect(res).toEqual({ ok: true, id: "cf-msg-1" });
    const msg = send.mock.calls[0][0] as SentMail;
    expect(msg.from).toBe(sender);
    // 非工单桶都指回 support@：用户随手回复任何邮件都进工单闭环
    expect(msg.replyTo).toBe(TICKET_SENDER);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("已知 kind 但无 EMAIL binding：回退阿里云 DM（本地 dev 行为不变）", async () => {
    stubDmOk();
    const env = { ...CREDS } as Env;

    const res = await sendMail(env, "u@example.com", "[工单 fb_a1b2c3] 回执", "<p>h</p>", "t", { kind: "ticket" });

    expect(res.ok).toBe(true);
    expect(res.id).toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as string;
    expect(body).toContain("SingleSendMail"); // 确认走的是阿里云 DM
  });

  it.each([[undefined], ["whatever"]])("kind 缺失/未知（%s）：EMAIL binding 在也保守走阿里云 DM", async (kind) => {
    const { binding, send } = fakeEmailBinding();
    stubDmOk();
    const env = { ...CREDS, EMAIL: binding } as Env;

    const res = await sendMail(env, "u@example.com", "【FrogLeap】你的 Token 已生成", "<p>h</p>", "t", { kind });

    expect(res.ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("CF 通道抛错：回退阿里云 DM 发出（邮件不因单通道故障丢失）", async () => {
    const { binding } = fakeEmailBinding(true);
    stubDmOk();
    const env = { ...CREDS, EMAIL: binding } as Env;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await sendMail(env, "u@example.com", "[工单 fb_x] 回执", "<p>h</p>", "t", { kind: "ticket" });

    expect(res.ok).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe("handleMailBatch 按通道分发", () => {
  const fakeMessage = (body: MailMessage) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() });

  it("队列消息消费时按 kind 分发：已知 kind 走 CF（各自桶），无 kind 走 DM，全部 ack", async () => {
    const { binding, send } = fakeEmailBinding();
    stubDmOk();
    const env = { ...CREDS, EMAIL: binding } as Env;
    const ticketMsg = fakeMessage({ to: "u@example.com", subject: "[工单 fb_x] 回执", html: "h", text: "t", kind: "ticket" });
    const magicMsg = fakeMessage({ to: "u@example.com", subject: "登录链接", html: "h", text: "t", kind: "magic" });
    const plainMsg = fakeMessage({ to: "u@example.com", subject: "无 kind", html: "h", text: "t" });

    await handleMailBatch({ messages: [ticketMsg, magicMsg, plainMsg] } as unknown as MessageBatch<MailMessage>, env);

    expect(send).toHaveBeenCalledTimes(2); // ticket + magic 走 CF
    const froms = send.mock.calls.map((c) => (c[0] as SentMail).from);
    expect(froms).toEqual([TICKET_SENDER, ACCOUNT_SENDER]);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // 无 kind 消息走 DM
    expect(ticketMsg.ack).toHaveBeenCalledTimes(1);
    expect(magicMsg.ack).toHaveBeenCalledTimes(1);
    expect(plainMsg.ack).toHaveBeenCalledTimes(1);
  });
});

describe("端到端：反馈回执与站长通知都经 CF 通道", () => {
  it("POST /api/feedback：回执（ticket 桶，带 [工单] 标签）与站长通知（notify 桶）都走 CF", async () => {
    const { binding, send } = fakeEmailBinding();
    stubDmOk();
    const store = new Map<string, string>();
    const ns = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      list: async () => ({ keys: [], list_complete: true, cursor: "" }),
    } as unknown as KVNamespace;
    const env = {
      TOKENS: ns, PLANS: ns, ORDERS: ns, NODES: ns, TICKETS: ns,
      ...CREDS,
      EMAIL: binding,
      ADMIN_NOTIFY_EMAIL: "admin@test.com",
      SITE_URL: "https://fastergamer.click",
      DEFAULT_PLANS: "[]",
    } as unknown as Env;
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void pending.push(Promise.resolve(p).catch(() => {})),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const res = await worker.fetch(
      new Request("https://api.test/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact: "user@example.com", message: "安装后连不上节点" }),
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    await Promise.all(pending); // 回执/站长通知都在 waitUntil 里

    const ticket = JSON.parse(store.get([...store.keys()].find((k) => k.startsWith(KV.TICKET))!)!) as Ticket;
    // 用户回执（ticket 桶）：from=support@、主题带标签；站长通知（notify 桶）：from=ops@、Reply-To 指 support@
    expect(send).toHaveBeenCalledTimes(2);
    const msgs = send.mock.calls.map((c) => c[0] as SentMail);
    const ack = msgs.find((m) => m.to === "user@example.com")!;
    expect(ack.from).toBe(TICKET_SENDER);
    expect(ack.subject).toContain(`[工单 ${ticket.id}]`);
    expect(ack.replyTo).toBeUndefined();
    const notice = msgs.find((m) => m.to === "admin@test.com")!;
    expect(notice.from).toBe(OPS_SENDER);
    expect(notice.replyTo).toBe(TICKET_SENDER);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // DM 全程未动
  });
});
