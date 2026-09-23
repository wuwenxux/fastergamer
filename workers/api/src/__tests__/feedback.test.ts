import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";

/**
 * 反馈工单的两封邮件（用户回执 + 管理员通知）必须经 executionCtx.waitUntil 发出：
 * 裸 async 在响应返回后可能随 Worker 被杀静默丢邮件。
 * 测试用收集型 ctx 模拟 Worker 等待后台任务，断言邮件真实走到阿里云发送。
 */

const fakeNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;
  return { ns, store };
};

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

/** 收集 waitUntil 注册的 promise（模拟 Worker 在响应返回后仍等待后台任务） */
const makeCtx = () => {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, pending };
};

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
    const { ctx, pending } = makeCtx();

    const res = await postFeedback(makeEnv(), ctx);
    expect(res.status).toBe(200);
    // 两封邮件都挂在 waitUntil 上
    expect(pending.length).toBe(2);
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
    const { ctx, pending } = makeCtx();

    const res = await postFeedback(makeEnv({ ADMIN_NOTIFY_EMAIL: undefined }), ctx);
    expect(res.status).toBe(200);
    expect(pending.length).toBe(1);
    await Promise.all(pending);

    const mails = fetchMock.mock.calls.filter((c) => String(c[0]).includes("dm.aliyuncs.com"));
    expect(mails.length).toBe(1);
  });
});
