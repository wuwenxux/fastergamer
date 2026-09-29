import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMailBatch, MAIL_MAX_RETRIES, sendMail, type MailMessage } from "../lib/email-aliyun";
import type { Env } from "../types";

/**
 * Queues 邮件异步化（lib/email-aliyun.ts）：
 * - 有 MAIL_QUEUE 绑定：sendMail 默认入队立即返回 queued，不直发；sync:true 强制直发；入队失败降级直发
 * - 无绑定：走原有同步直发（本地/测试回退路径）
 * - consumer handleMailBatch：DM 成功 ack；失败 retry；重试耗尽（attempts > max_retries）记 mail_failed 遥测
 * DM API 走 fetch stub；Queue/TELEMETRY 用 vi.fn 假绑定；HMAC 签名用 node webcrypto 真实跑。
 */

const CREDS = { ALIYUN_ACCESS_KEY_ID: "k", ALIYUN_ACCESS_KEY_SECRET: "s" };

const fakeQueue = (failing = false) => {
  const send = vi.fn(async (_body: MailMessage) => {
    if (failing) throw new Error("queue unavailable");
  });
  return { queue: { send } as unknown as Queue<MailMessage>, send };
};

const stubDm = (ok: boolean) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(ok ? { RequestId: "req-1", EnvId: "e1" } : { Code: "InvalidToAddress", Message: "boom", RequestId: "req-2" })
    )
  );

const fetchSpy = () => vi.mocked(fetch);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("sendMail 队列生产者侧", () => {
  it("有 MAIL_QUEUE 绑定：默认入队立即返回 queued，不调 DM 直发", async () => {
    const { queue, send } = fakeQueue();
    stubDm(true);
    const env = { ...CREDS, MAIL_QUEUE: queue } as Env;

    const res = await sendMail(env, "u@example.com", "主题", "<p>h</p>", "t", { kind: "ticket" });

    expect(res).toEqual({ ok: true, queued: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ to: "u@example.com", subject: "主题", html: "<p>h</p>", text: "t", kind: "ticket" });
    expect(fetchSpy()).not.toHaveBeenCalled(); // 没有直发
  });

  it("无绑定：走同步直发回退（本地/测试路径不变）", async () => {
    stubDm(true);
    const env = { ...CREDS } as Env;

    const res = await sendMail(env, "u@example.com", "主题", "<p>h</p>", "t");

    expect(res.ok).toBe(true);
    expect(res.queued).toBeUndefined();
    expect(fetchSpy()).toHaveBeenCalledTimes(1);
  });

  it("sync:true 绕过队列强制直发（magic 登录链接等时效敏感链路）", async () => {
    const { queue, send } = fakeQueue();
    stubDm(true);
    const env = { ...CREDS, MAIL_QUEUE: queue } as Env;

    const res = await sendMail(env, "u@example.com", "登录链接", "<p>h</p>", "t", { sync: true, kind: "magic" });

    expect(res.ok).toBe(true);
    expect(res.queued).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy()).toHaveBeenCalledTimes(1);
  });

  it("入队失败（队列不可用）：降级直发，不丢邮件", async () => {
    const { queue } = fakeQueue(true);
    stubDm(true);
    const env = { ...CREDS, MAIL_QUEUE: queue } as Env;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await sendMail(env, "u@example.com", "主题", "<p>h</p>", "t");

    expect(res.ok).toBe(true);
    expect(fetchSpy()).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe("handleMailBatch consumer", () => {
  /** 假 Queues 消息：ack/retry 可断言 */
  const fakeMessage = (body: MailMessage, attempts = 1) => ({
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  });

  it("DM 发送成功：ack，不 retry", async () => {
    stubDm(true);
    const m = fakeMessage({ to: "u@example.com", subject: "s", html: "h", text: "t", kind: "notify" });

    await handleMailBatch({ messages: [m] } as unknown as MessageBatch<MailMessage>, { ...CREDS } as Env);

    expect(m.ack).toHaveBeenCalledTimes(1);
    expect(m.retry).not.toHaveBeenCalled();
    expect(fetchSpy()).toHaveBeenCalledTimes(1);
  });

  it("DM 发送失败：retry 交给 Queues 重试，不 ack", async () => {
    stubDm(false);
    const m = fakeMessage({ to: "u@example.com", subject: "s", html: "h", text: "t" }, 1);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleMailBatch({ messages: [m] } as unknown as MessageBatch<MailMessage>, { ...CREDS } as Env);

    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(m.ack).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("重试耗尽（attempts > max_retries）仍失败：记 mail_failed 遥测 + 日志带 kind/收件人", async () => {
    stubDm(false);
    const points: unknown[] = [];
    const telemetry = { writeDataPoint: (p: unknown) => points.push(JSON.parse(JSON.stringify(p))) } as unknown as AnalyticsEngineDataset;
    const m = fakeMessage({ to: "u@example.com", subject: "s", html: "h", text: "t", kind: "ticket" }, MAIL_MAX_RETRIES + 1);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleMailBatch(
      { messages: [m] } as unknown as MessageBatch<MailMessage>,
      { ...CREDS, TELEMETRY: telemetry } as Env
    );

    expect(m.retry).toHaveBeenCalledTimes(1);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ blobs: ["mail_failed", "ticket"] });
    errSpy.mockRestore();
  });

  it("批量内逐条独立：一条失败不影响另一条 ack", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return Response.json(call === 1 ? { RequestId: "r" } : { Code: "Err", Message: "boom" });
      })
    );
    const okMsg = fakeMessage({ to: "a@example.com", subject: "s", html: "h", text: "t" });
    const badMsg = fakeMessage({ to: "b@example.com", subject: "s", html: "h", text: "t" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleMailBatch({ messages: [okMsg, badMsg] } as unknown as MessageBatch<MailMessage>, { ...CREDS } as Env);

    expect(okMsg.ack).toHaveBeenCalledTimes(1);
    expect(badMsg.retry).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});
