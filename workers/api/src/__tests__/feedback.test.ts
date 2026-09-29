import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";
import { collectCtx, fakeNs } from "./helpers";

/**
 * 反馈工单的两封邮件（用户回执 + 管理员通知）必须经 executionCtx.waitUntil 发出：
 * 裸 async 在响应返回后可能随 Worker 被杀静默丢邮件。
 * 测试用收集型 ctx 模拟 Worker 等待后台任务，断言邮件真实走到阿里云发送。
 */

const makeEnv = (over: Partial<Env> = {}) =>
  ({
    TOKENS: fakeNs().ns,
    TICKETS: fakeNs().ns,
    PLANS: fakeNs().ns,
    ORDERS: fakeNs().ns,
    NODES: fakeNs().ns,
    ADMIN_KEY: "test-admin-key",
    ALIYUN_ACCESS_KEY_ID: "test-id",
    ALIYUN_ACCESS_KEY_SECRET: "test-secret",
    ADMIN_NOTIFY_EMAIL: "admin@example.com",
    SITE_URL: "https://fastergamer.click",
    ...over,
  }) as unknown as Env;

let ipSeq = 0;
const postFeedback = (env: Env, ctx: ExecutionContext) => {
  ipSeq += 1;
  return worker.fetch(
    new Request("https://api.test/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": `10.8.0.${ipSeq}` },
      body: JSON.stringify({ contact: `user${ipSeq}@example.com`, message: "安装后连接不上节点" }),
    }),
    env,
    ctx
  );
};

describe("POST /api/feedback 邮件经 waitUntil 发出", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("回执与管理员通知都注册 waitUntil，响应返回后邮件仍真实发出", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ RequestId: "r1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = collectCtx();

    const res = await postFeedback(makeEnv(), ctx);
    expect(res.status).toBe(200);
    // 两封邮件 + AI 草稿（无 AI 绑定静默跳过但仍注册 waitUntil）都挂在 waitUntil 上
    expect(pending.length).toBe(3);
    await Promise.all(pending);

    const mails = fetchMock.mock.calls.filter((c) => String(c[0]).includes("dm.aliyuncs.com"));
    expect(mails.length).toBe(2);
    const recipients = mails.map((c) => String((c[1] as RequestInit).body)).join("&");
    expect(recipients).toContain("user1%40example.com");
    expect(recipients).toContain("admin%40example.com");
  });

  it("未配置 ADMIN_NOTIFY_EMAIL：只发用户回执（仍走 waitUntil）", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ RequestId: "r1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, pending } = collectCtx();

    const res = await postFeedback(makeEnv({ ADMIN_NOTIFY_EMAIL: undefined }), ctx);
    expect(res.status).toBe(200);
    // 用户回执 + AI 草稿（同上）两条 waitUntil
    expect(pending.length).toBe(2);
    await Promise.all(pending);

    const mails = fetchMock.mock.calls.filter((c) => String(c[0]).includes("dm.aliyuncs.com"));
    expect(mails.length).toBe(1);
  });
});
