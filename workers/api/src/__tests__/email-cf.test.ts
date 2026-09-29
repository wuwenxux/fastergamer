import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Ticket } from "../../../../shared/types";
import { sendMail, handleMailBatch, type MailMessage } from "../lib/email-aliyun";
import { TICKET_SENDER } from "../lib/email-cf";
import type { Env } from "../types";

/**
 * CF Email Service 工单发信通道（lib/email-cf.ts + email-aliyun.ts sendMailDispatch）：
 * - kind:"ticket" 且 EMAIL binding 在 → CF 通道（from 固定 support@tickets.fastergamer.click），不调阿里云 DM
 * - 无 EMAIL binding → 回退阿里云 DM（本地 dev / 未配置行为不变）
 * - 非工单邮件（无 kind/"magic" 等）即使 EMAIL 在也走 DM
 * - CF 通道抛错 → 回退 DM（工单邮件不因单通道故障丢失）
 * - consumer handleMailBatch 按消息 kind 在消费时分发通道（入队不定通道，binding 运行时探测）
 * - 端到端：POST /api/feedback 的回执邮件（主题带 [工单] 标签）经 CF 通道发出
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

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("sendMailDispatch 通道选择", () => {
  it("工单邮件（kind:ticket）+ EMAIL binding：走 CF 通道，from 为工单收件地址，不调 DM", async () => {
    const { binding, send } = fakeEmailBinding();
    stubDmOk();
    const env = { ...CREDS, EMAIL: binding } as Env;

    const res = await sendMail(env, "u@example.com", "[工单 fb_a1b2c3]【GameBoost】你的反馈已有回复", "<p>h</p>", "t", {
      kind: "ticket",
    });

    expect(res).toEqual({ ok: true, id: "cf-msg-1" });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as { from: string; to: string; subject: string; html: string; text: string };
    expect(msg.from).toBe(TICKET_SENDER);
    expect(msg.from).toBe("support@tickets.fastergamer.click");
    expect(msg.to).toBe("u@example.com");
    expect(msg.subject).toContain("[工单 fb_a1b2c3]"); // 串线标签保留
    expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // DM 未动
  });

  it("工单邮件但无 EMAIL binding：回退阿里云 DM（本地 dev 行为不变）", async () => {
    stubDmOk();
    const env = { ...CREDS } as Env;

    const res = await sendMail(env, "u@example.com", "[工单 fb_a1b2c3] 回执", "<p>h</p>", "t", { kind: "ticket" });

    expect(res.ok).toBe(true);
    expect(res.id).toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as string;
    expect(body).toContain("SingleSendMail"); // 确认走的是阿里云 DM
  });

  it("非工单邮件（无 kind）：EMAIL binding 在也走阿里云 DM", async () => {
    const { binding, send } = fakeEmailBinding();
    stubDmOk();
    const env = { ...CREDS, EMAIL: binding } as Env;

    const res = await sendMail(env, "u@example.com", "【GameBoost】你的加速 Token 已生成", "<p>h</p>", "t");

    expect(res.ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("CF 通道抛错：回退阿里云 DM 发出（工单邮件不因单通道故障丢失）", async () => {
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

  it("队列里的工单消息：消费时走 CF 通道并 ack；非工单消息仍走 DM", async () => {
    const { binding, send } = fakeEmailBinding();
    stubDmOk();
    const env = { ...CREDS, EMAIL: binding } as Env;
    const ticketMsg = fakeMessage({ to: "u@example.com", subject: "[工单 fb_x] 回执", html: "h", text: "t", kind: "ticket" });
    const magicMsg = fakeMessage({ to: "u@example.com", subject: "登录链接", html: "h", text: "t", kind: "magic" });

    await handleMailBatch({ messages: [ticketMsg, magicMsg] } as unknown as MessageBatch<MailMessage>, env);

    expect(send).toHaveBeenCalledTimes(1); // 只有工单消息走 CF
    expect((send.mock.calls[0][0] as { subject: string }).subject).toContain("[工单 fb_x]");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1); // magic 消息走 DM
    expect(ticketMsg.ack).toHaveBeenCalledTimes(1);
    expect(magicMsg.ack).toHaveBeenCalledTimes(1);
  });
});

describe("端到端：反馈回执经 CF 通道", () => {
  it("POST /api/feedback：回执邮件（带 [工单] 标签）走 CF，站长通知仍走 DM", async () => {
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
    // 用户回执（kind:ticket）走 CF，from 正确、主题带标签
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0] as { from: string; to: string; subject: string };
    expect(msg.from).toBe(TICKET_SENDER);
    expect(msg.to).toBe("user@example.com");
    expect(msg.subject).toContain(`[工单 ${ticket.id}]`);
    // 站长通知（无 kind）走 DM
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
