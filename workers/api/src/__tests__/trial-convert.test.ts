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
    ADMIN_KEY: "secret-key",
    ALIYUN_ACCESS_KEY_ID: "test-id",
    ALIYUN_ACCESS_KEY_SECRET: "test-secret",
    SITE_URL: "https://fastergamer.click",
  }) as unknown as Env;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const makeTrial = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_trial",
  uuid: "uuid-trial",
  plan_id: "plan_trial",
  status: "active",
  contact: "user@example.com",
  traffic_limit_gb: 20,
  traffic_used_gb: 5,
  purchased_at: Date.now() - 2 * 86_400_000,
  activated_at: Date.now() - 2 * 86_400_000,
  expires_at: Date.now() - 60_000, // 刚过期
  ...overrides,
});

const seedToken = (store: Map<string, string>, token: Token) => {
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

const runScan = (app: Hono<{ Bindings: Env }>, env: Env) =>
  app.request("/api/admin/notify-scan", { method: "POST", headers: { "x-admin-key": "secret-key" } }, env, ctx);

describe("notify-scan 试用到期转化邮件", () => {
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

  it("试用到期翻转 expired 时发一次性转化邮件（含免登录链接），幂等键落库", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makeTrial());
    const fetchMock = stubMailOk();

    const res = await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 邮件正文含免登录充值链接
    const body = fetchMock.mock.calls[0][1]?.body as string;
    expect(decodeURIComponent(body)).toContain("/auth/magic?ticket=");

    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-trial")!) as Token;
    expect(saved.status).toBe("expired");
    expect(saved.notify_log?.trial_convert).toBeGreaterThan(0);
    // magic ticket 已签发
    expect([...tokens.store.keys()].some((k) => k.startsWith(KV.MAGIC))).toBe(true);
  });

  it("二次扫描不重复发（幂等键已存在）", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makeTrial());
    const fetchMock = stubMailOk();

    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("存量已 expired 的试用 token 不补发", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makeTrial({ status: "expired", expires_at: Date.now() - 86_400_000 }));
    const fetchMock = stubMailOk();

    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("历史 id（plan_3days）的存量试用 token 仍按试用处理：到期翻转 + 发转化邮件", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    // 试用套餐改名 plan_trial 前的存量数据：plan_id 仍是 plan_3days
    seedToken(tokens.store, makeTrial({ plan_id: "plan_3days" }));
    const fetchMock = stubMailOk();

    const res = await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-trial")!) as Token;
    expect(saved.status).toBe("expired");
    expect(saved.notify_log?.trial_convert).toBeGreaterThan(0);
  });

  it("付费 token 到期只翻转状态，不发邮件", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(
      tokens.store,
      makeTrial({ id: "tk_paid", uuid: "uuid-paid", plan_id: "plan_yearly", expires_at: Date.now() - 60_000 })
    );
    const fetchMock = stubMailOk();

    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(fetchMock).not.toHaveBeenCalled();
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-paid")!) as Token;
    expect(saved.status).toBe("expired");
    expect(saved.notify_log?.trial_convert).toBeUndefined();
  });

  it("联系方式非邮箱：状态照常翻转但不发邮件、不打幂等键", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    seedToken(tokens.store, makeTrial({ contact: "wechat_user" }));
    const fetchMock = stubMailOk();

    await runScan(app, makeEnv(tokens.ns, tickets.ns));
    expect(fetchMock).not.toHaveBeenCalled();
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-trial")!) as Token;
    expect(saved.status).toBe("expired");
    expect(saved.notify_log?.trial_convert).toBeUndefined();
  });

  it("过期满 90 天的 token 统一清理（含试用）——转正激励锚定邮箱标记，不依赖 token 存活", async () => {
    const tokens = mockNs();
    const tickets = mockNs();
    const old = Date.now() - 100 * 86_400_000;
    seedToken(tokens.store, makeTrial({ status: "expired", expires_at: old, purchased_at: old }));
    seedToken(
      tokens.store,
      makeTrial({ id: "tk_rev", uuid: "uuid-rev", status: "revoked", expires_at: old, purchased_at: old })
    );
    seedToken(
      tokens.store,
      makeTrial({ id: "tk_old", uuid: "uuid-old", plan_id: "plan_yearly", status: "expired", expires_at: old, purchased_at: old })
    );
    const fetchMock = stubMailOk();

    const res = await runScan(app, makeEnv(tokens.ns, tickets.ns));
    const body = (await res.json()) as { data: { purged_tokens: number } };
    expect(fetchMock).not.toHaveBeenCalled(); // 存量翻转不补发
    expect(body.data.purged_tokens).toBe(3);
    expect(tokens.store.has(KV.TOKEN + "uuid-trial")).toBe(false);
    expect(tokens.store.has(KV.TOKEN + "uuid-rev")).toBe(false);
    expect(tokens.store.has(KV.TOKEN + "uuid-old")).toBe(false);
  });
});
