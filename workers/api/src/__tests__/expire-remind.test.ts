import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, type Token } from "../../../../shared/types";
import { adminRoutes } from "../routes/admin";
import type { Env } from "../types";

/** 内存版 KV namespace（Map 实现 get/put/delete/list） */
const mockNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
    list: vi.fn(async ({ prefix, cursor }: { prefix?: string; cursor?: string }) => {
      const keys = [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: cursor ?? "" };
    }),
  } as unknown as KVNamespace;
  return { store, ns };
};

const makeEnv = (tokens: KVNamespace, tickets: KVNamespace) =>
  ({
    TOKENS: tokens,
    TICKETS: tickets,
    NODES: mockNs().ns, // notify-scan 翻转过期后会 pushAuthRefresh，需要 NODES 命名空间
    ORDERS: mockNs().ns, // notify-scan 顺带自动取消超 3 天 pending 订单，需要 ORDERS 命名空间
    ADMIN_KEY: "secret-key",
    ALIYUN_ACCESS_KEY_ID: "test-id",
    ALIYUN_ACCESS_KEY_SECRET: "test-secret",
    SITE_URL: "https://fastergamer.click",
  }) as unknown as Env;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const makePaid = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_paid",
  uuid: "uuid-paid",
  plan_id: "plan_yearly",
  status: "active",
  contact: "user@example.com",
  traffic_limit_gb: 500,
  traffic_used_gb: 100,
  purchased_at: Date.now() - 300 * 86_400_000,
  activated_at: Date.now() - 300 * 86_400_000,
  expires_at: Date.now() + 3_600_000, // 1 小时后到期，在 24h 提醒窗口内
  ...overrides,
});

const seedToken = (store: Map<string, string>, token: Token) => {
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

const runScan = (app: Hono<{ Bindings: Env }>, env: Env) =>
  app.request("/api/admin/notify-scan", { method: "POST", headers: { "x-admin-key": "secret-key" } }, env, ctx);

describe("notify-scan 付费 token 到期前 24h 续费提醒", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/admin", adminRoutes);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubMailOk = () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ RequestId: "r1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  it("进入 24h 窗口的付费 token 发一次性续费提醒（含免登录链接），幂等键落库", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makePaid());
    const fetchMock = stubMailOk();

    const res = await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { notified: number } };
    expect(body.data.notified).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 邮件正文含免登录续费链接
    const mailBody = fetchMock.mock.calls[0][1]?.body as string;
    expect(decodeURIComponent(mailBody)).toContain("/auth/magic?ticket=");

    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-paid")!) as Token;
    expect(saved.status).toBe("active"); // 提醒不改变状态
    expect(saved.notify_log?.expire_24h).toBeGreaterThan(0);
  });

  it("二次扫描不重复发（幂等键已存在）", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makePaid());
    const fetchMock = stubMailOk();

    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("距到期超过 24h 不发", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makePaid({ expires_at: Date.now() + 48 * 3_600_000 }));
    const fetchMock = stubMailOk();

    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("试用 token 进入 24h 窗口不发（走 trial_convert 转化路径）", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makePaid({ plan_id: "plan_trial" }));
    const fetchMock = stubMailOk();

    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(fetchMock).not.toHaveBeenCalled();
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-paid")!) as Token;
    expect(saved.notify_log?.expire_24h).toBeUndefined();
  });

  it("联系方式非邮箱：不发邮件、不打幂等键（下轮窗口内还会重试）", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makePaid({ contact: "wechat_user" }));
    const fetchMock = stubMailOk();

    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(fetchMock).not.toHaveBeenCalled();
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-paid")!) as Token;
    expect(saved.notify_log?.expire_24h).toBeUndefined();
  });
});
