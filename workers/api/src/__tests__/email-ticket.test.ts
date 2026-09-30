import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Ticket } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * Email Routing 工单邮件闭环（src/email.ts，handler 由 index.ts 以 email 方法导出）：
 * - Subject 的 [工单 fb_xxx] 标签（优先）或 To plus 段（兜底）提取工单号
 * - From 必须等于 ticket.contact；closed 工单拒收并回信告知
 * - 正文剥引用段/签名只留用户新写的内容，追加进 ticket.thread（replied → open 重新浮出水面）
 * - 无工单号/工单不存在不入库；无工单号会通知站长
 * - 同一 From 1 小时最多追加 10 条（KV 计数节流）
 * - 成功后给用户确认回执 + 站长通知（外发在 KV 写之后，失败只记日志）
 * 邮件 mock 掉；KV 用内存假实现；collectCtx 收 waitUntil 里的外发承诺。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});
import { sendMail } from "../lib/email-aliyun";

import { collectCtx, makeEnv } from "./helpers";

const TICKET_ID = "fb_a1b2c3";
const USER = "user@example.com";
const ADMIN = "admin@test.com";

const seedTicket = (store: Map<string, string>, over: Partial<Ticket> = {}): Ticket => {
  const t: Ticket = {
    id: TICKET_ID,
    contact: USER,
    category: "connect",
    message: "连不上节点",
    status: "replied",
    reply: "试试换节点",
    created_at: Date.now(),
    replied_at: Date.now(),
    ...over,
  };
  store.set(KV.TICKET + t.id, JSON.stringify(t));
  return t;
};

const readTicket = (store: Map<string, string>): Ticket =>
  JSON.parse(store.get(KV.TICKET + TICKET_ID)!) as Ticket;

/** 拼一封 RFC822 纯文本来信 */
const mime = (opts: { from?: string; to?: string; subject?: string; body?: string } = {}) =>
  [
    `From: ${opts.from ?? `用户 <${USER}>`}`,
    `To: ${opts.to ?? "support@fastergamer.click"}`,
    `Subject: ${opts.subject ?? `Re: [工单 ${TICKET_ID}]【FrogLeap】你的反馈已有回复`}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body ?? "换了节点还是不行",
    "",
  ].join("\r\n");

/** 构造 ForwardableEmailMessage 形状的最小假对象 */
const makeMessage = (raw: string, from = USER, to = "support@fastergamer.click") =>
  ({
    from,
    to,
    raw: new Response(raw).body as ReadableStream<Uint8Array>,
    headers: new Headers({ from, to }),
    rawSize: raw.length,
    setReject: () => {},
    forward: async () => {},
    reply: async () => {},
  }) as unknown as ForwardableEmailMessage;

const receive = async (env: Env, raw: string, from?: string, to?: string) => {
  const { pending, ctx } = collectCtx();
  await worker.email!(makeMessage(raw, from, to), env, ctx);
  await Promise.all(pending); // 等确认回执/站长通知等 waitUntil 外发跑完
};

beforeEach(() => vi.clearAllMocks());

describe("Email Routing 工单闭环：来信追加", () => {
  it("正常来信：剥引用后追加 thread（from:user），replied → open，发确认回执 + 站长通知", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });
    seedTicket(tickets.store);

    await receive(
      env,
      mime({
        body: "换了节点还是不行，报错 timeout\r\n\r\n> 试试换节点\r\n> 客服",
      })
    );

    const saved = readTicket(tickets.store);
    expect(saved.thread).toHaveLength(1);
    expect(saved.thread![0].from).toBe("user");
    expect(saved.thread![0].text).toBe("换了节点还是不行，报错 timeout"); // 引用段已剥
    expect(saved.status).toBe("open"); // 用户补充后重新浮出水面
    // 确认回执给用户（主题带工单标签，继续回复仍可串线）+ 站长通知含摘要
    expect(sendMail).toHaveBeenCalledTimes(2);
    const [, toUser, subUser] = vi.mocked(sendMail).mock.calls[0];
    expect(toUser).toBe(USER);
    expect(subUser).toContain(`[工单 ${TICKET_ID}]`);
    const [, toAdmin, , htmlAdmin] = vi.mocked(sendMail).mock.calls[1];
    expect(toAdmin).toBe(ADMIN);
    expect(htmlAdmin).toContain("换了节点还是不行");
  });

  it("Subject 无标签时走 To plus 段兜底（support+fb_xxx@fastergamer.click）", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });
    seedTicket(tickets.store);

    await receive(
      env,
      mime({ subject: "Re: 你的反馈已有回复", to: `support+${TICKET_ID}@fastergamer.click` }),
      USER,
      `support+${TICKET_ID}@fastergamer.click`
    );

    expect(readTicket(tickets.store).thread).toHaveLength(1);
  });

  it("From 与工单联系人不匹配：拒收（不写 thread，不发任何邮件）", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });
    seedTicket(tickets.store);

    await receive(env, mime(), "stranger@example.com");

    expect(readTicket(tickets.store).thread ?? []).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("closed 工单：拒收并回信告知「工单已关闭」，thread 不动", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });
    seedTicket(tickets.store, { status: "closed" });

    await receive(env, mime());

    expect(readTicket(tickets.store).thread ?? []).toEqual([]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe(USER);
    expect(subject).toContain("已关闭");
  });

  it("无工单号（主题与 To 都无 fb_ 标签）：不入库，通知站长人工看", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });
    seedTicket(tickets.store);

    await receive(env, mime({ subject: "你好，咨询一下价格" }));

    expect(readTicket(tickets.store).thread ?? []).toEqual([]);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe(ADMIN);
    expect(subject).toContain("无法识别");
  });

  it("工单号不存在：静默丢弃（不通知不写信）", async () => {
    const { env } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });

    await receive(env, mime({ subject: "Re: [工单 fb_999999] xxx" }));

    expect(sendMail).not.toHaveBeenCalled();
  });

  it("引用段剥离：On ... wrote: / 中文引用头 / 签名分隔之后的内容全部丢弃", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });
    seedTicket(tickets.store);

    await receive(
      env,
      mime({
        body: "这是新内容\r\n-- \r\n我的签名\r\nOn Mon, Sep 29, 2026 at 10:00 AM 客服 <service@mail.fastergamer.cn> wrote:\r\n> 原回复",
      })
    );

    expect(readTicket(tickets.store).thread![0].text).toBe("这是新内容");
  });

  it("剥完引用后正文为空：不追加（防止纯顶帖灌水）", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });
    seedTicket(tickets.store);

    await receive(env, mime({ body: "\r\n> 全是引用\r\n> 没有新内容" }));

    expect(readTicket(tickets.store).thread ?? []).toEqual([]);
  });

  it("节流：同一 From 1 小时最多追加 10 条，第 11 条丢弃", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN } });
    seedTicket(tickets.store);

    for (let i = 0; i < 12; i++) {
      await receive(env, mime({ body: `补充第 ${i + 1} 条` }));
    }

    const saved = readTicket(tickets.store);
    expect(saved.thread).toHaveLength(10);
    expect(saved.thread![9].text).toBe("补充第 10 条");
  });

  it("追加成功后管理端回复再进 thread：from:admin 与用户条目按时间排列", async () => {
    const { env, tickets } = makeEnv({ extra: { ADMIN_NOTIFY_EMAIL: ADMIN, ADMIN_KEY: "k" } });
    seedTicket(tickets.store);

    await receive(env, mime({ body: "补充一下" }));
    const res = await worker.fetch(
      new Request(`https://api.test/api/admin/tickets/${TICKET_ID}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-key": "k" },
        body: JSON.stringify({ reply: "已在后台看到你的补充，请再试" }),
      }),
      env,
      collectCtx().ctx
    );

    expect(res.status).toBe(200);
    const saved = readTicket(tickets.store);
    expect(saved.thread!.map((t) => t.from)).toEqual(["user", "admin"]);
    expect(saved.thread![1].text).toBe("已在后台看到你的补充，请再试");
  });
});
