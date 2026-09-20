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

const makeEnv = (tokens: KVNamespace) =>
  ({
    TOKENS: tokens,
    TICKETS: mockNs().ns,
    NODES: mockNs().ns, // 延期恢复 active 会 pushAuthRefresh，需要 NODES 命名空间
    ADMIN_KEY: "secret-key",
    ALIYUN_ACCESS_KEY_ID: "test-id",
    ALIYUN_ACCESS_KEY_SECRET: "test-secret",
    SITE_URL: "https://fastergamer.click",
  }) as unknown as Env;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_test",
  uuid: "uuid-test",
  plan_id: "plan_trial",
  status: "active",
  contact: "user@example.com",
  traffic_limit_gb: 8,
  traffic_used_gb: 1,
  purchased_at: Date.now() - 86_400_000,
  activated_at: Date.now() - 86_400_000,
  expires_at: Date.now() + 86_400_000,
  ...overrides,
});

const seedToken = (store: Map<string, string>, token: Token) => {
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

const stubMailOk = () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ RequestId: "r1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("PUT /api/admin/tokens/:id extend_days", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/admin", adminRoutes);

  const putExtend = (env: Env, id: string, days: number) =>
    app.request(
      `/api/admin/tokens/${id}`,
      {
        method: "PUT",
        headers: { "x-admin-key": "secret-key", "content-type": "application/json" },
        body: JSON.stringify({ extend_days: days }),
      },
      env,
      ctx
    );

  it("延长未过期 token：只改有效期，状态不动", async () => {
    const tokens = mockNs();
    seedToken(tokens.store, makeToken());

    const res = await putExtend(makeEnv(tokens.ns), "tk_test", 90);
    expect(res.status).toBe(200);
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-test")!) as Token;
    expect(saved.status).toBe("active");
    expect(saved.expires_at).toBeGreaterThan(Date.now() + 89 * 86_400_000);
  });

  it("延长已过期 token：自动恢复 active（延期即恢复服务）", async () => {
    const tokens = mockNs();
    seedToken(tokens.store, makeToken({ status: "expired", expires_at: Date.now() - 86_400_000 }));

    const res = await putExtend(makeEnv(tokens.ns), "tk_test", 90);
    expect(res.status).toBe(200);
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-test")!) as Token;
    expect(saved.status).toBe("active");
    expect(saved.expires_at).toBeGreaterThan(Date.now() + 89 * 86_400_000);
  });

  it("revoked token：延期不静默恢复；显式 reactivate 才翻回 active", async () => {
    const tokens = mockNs();
    seedToken(tokens.store, makeToken({ status: "revoked", expires_at: Date.now() - 86_400_000 }));
    const env = makeEnv(tokens.ns);

    // 不带 reactivate：只延期，状态保持 revoked
    const res1 = await putExtend(env, "tk_test", 90);
    expect(res1.status).toBe(200);
    let saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-test")!) as Token;
    expect(saved.status).toBe("revoked");

    // 显式 reactivate：恢复 active
    const res2 = await app.request(
      "/api/admin/tokens/tk_test",
      {
        method: "PUT",
        headers: { "x-admin-key": "secret-key", "content-type": "application/json" },
        body: JSON.stringify({ extend_days: 90, reactivate: true }),
      },
      env,
      ctx
    );
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { data: { status: string } };
    expect(body.data.status).toBe("active");
    saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-test")!) as Token;
    expect(saved.status).toBe("active");
  });

  it("参数校验：天数缺失/超界拒绝", async () => {
    const tokens = mockNs();
    seedToken(tokens.store, makeToken());
    const env = makeEnv(tokens.ns);

    const res = await putExtend(env, "tk_test", 0);
    expect(res.status).toBe(400);
    const res2 = await app.request(
      "/api/admin/tokens/tk_test",
      {
        method: "PUT",
        headers: { "x-admin-key": "secret-key", "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
      ctx
    );
    expect(res2.status).toBe(400);
  });
});

describe("POST /api/admin/notify-user 服务邮件", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/admin", adminRoutes);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const notify = (env: Env, body: unknown) =>
    app.request(
      "/api/admin/notify-user",
      {
        method: "POST",
        headers: { "x-admin-key": "secret-key", "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      env,
      ctx
    );

  it("发送成功：带免登录链接，正文按段渲染并转义", async () => {
    const tokens = mockNs();
    seedToken(tokens.store, makeToken());
    const fetchMock = stubMailOk();

    const res = await notify(makeEnv(tokens.ns), {
      token_id: "tk_test",
      title: "服务公告",
      text: "第一段 <b>不解析</b>\n\n第二段",
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const mailBody = decodeURIComponent(fetchMock.mock.calls[0][1]?.body as string);
    expect(mailBody).toContain("/auth/magic?ticket=");
    expect(mailBody).toContain("第一段");
    // HTML 转义：正文里的 <b> 必须被转义，不能进入邮件解析
    expect(mailBody).toContain("&lt;b&gt;");
    // magic ticket 已签发
    expect([...tokens.store.keys()].some((k) => k.startsWith(KV.MAGIC))).toBe(true);
  });

  it("token 不存在 404；联系方式非邮箱 400；缺字段 400", async () => {
    const tokens = mockNs();
    seedToken(tokens.store, makeToken({ contact: "wechat_user" }));
    stubMailOk();
    const env = makeEnv(tokens.ns);

    expect((await notify(env, { token_id: "tk_none", title: "t", text: "x" })).status).toBe(404);
    expect((await notify(env, { token_id: "tk_test", title: "t", text: "x" })).status).toBe(400);
    expect((await notify(env, { token_id: "tk_test", title: "t" })).status).toBe(400);
  });
});
