import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, type Token } from "../../../../shared/types";
import { tokensRoutes } from "../routes/tokens";
import { MAGIC_TTL_MS } from "../lib/accounts";
import type { Env } from "../types";

/** 内存版 KV namespace（Map 实现 get/put/delete/list） */
const mockNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    })),
  } as unknown as KVNamespace;
  return { store, ns };
};

const makeEnv = (tokens: KVNamespace) =>
  ({
    TOKENS: tokens,
    SITE_URL: "https://fastergamer.click",
  }) as unknown as Env;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const makeApp = () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/tokens", tokensRoutes);
  return app;
};

const seedToken = (store: Map<string, string>, token: Token) => {
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

const TICKET = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const seedTicket = (store: Map<string, string>, createdAt = Date.now(), purpose?: string) => {
  store.set(
    KV.MAGIC + TICKET,
    JSON.stringify({ email: "user@example.com", token_id: "tk_1", created_at: createdAt, purpose })
  );
};

const token: Token = {
  id: "tk_1",
  uuid: "uuid-1",
  plan_id: "plan_monthly",
  status: "active",
  contact: "user@example.com",
  traffic_limit_gb: 20,
  traffic_used_gb: 0,
  purchased_at: Date.now(),
  expires_at: Date.now() + 30 * 86_400_000,
};

describe("magic ticket 核销", () => {
  it("核销成功：返回 session + sub_url + status", async () => {
    const { store, ns } = mockNs();
    seedToken(store, token);
    seedTicket(store);
    const res = await makeApp().request(`/api/tokens/magic/consume?ticket=${TICKET}`, {}, makeEnv(ns), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.email).toBe("user@example.com");
    expect(body.data.token_id).toBe("tk_1");
    expect(body.data.session_token).toBeTruthy();
    expect(body.data.sub_url).toBe("https://fastergamer.click/api/sub?uuid=uuid-1");
    expect(body.data.status).toBe("active");
    // 未标注用途的旧票据默认按 login 处理（落地进管理页）
    expect(body.data.purpose).toBe("login");
    // session 已写入 KV，可凭它取回邮箱
    const raw = store.get(KV.SESSION + body.data.session_token);
    expect(raw && JSON.parse(raw).email).toBe("user@example.com");
  });

  it("有效期内可重复核销：邮箱预扫描/重复打开不再失效", async () => {
    const { store, ns } = mockNs();
    seedToken(store, token);
    seedTicket(store);
    const app = makeApp();
    const env = makeEnv(ns);
    for (let i = 0; i < 3; i++) {
      const res = await app.request(`/api/tokens/magic/consume?ticket=${TICKET}`, {}, env, ctx);
      expect(res.status).toBe(200);
    }
  });

  it("purpose=import 的票据（新 token 凭证邮件）原样透传", async () => {
    const { store, ns } = mockNs();
    seedToken(store, { ...token, status: "paid", expires_at: undefined });
    seedTicket(store, Date.now(), "import");
    const res = await makeApp().request(`/api/tokens/magic/consume?ticket=${TICKET}`, {}, makeEnv(ns), ctx);
    const body = await res.json();
    expect(body.data.purpose).toBe("import");
    expect(body.data.status).toBe("paid");
  });

  it("过期 ticket：401 且焚毁", async () => {
    const { store, ns } = mockNs();
    seedToken(store, token);
    seedTicket(store, Date.now() - MAGIC_TTL_MS - 1000);
    const res = await makeApp().request(`/api/tokens/magic/consume?ticket=${TICKET}`, {}, makeEnv(ns), ctx);
    expect(res.status).toBe(401);
    expect(store.has(KV.MAGIC + TICKET)).toBe(false);
  });

  it("不存在/非法 ticket：401", async () => {
    const { ns } = mockNs();
    const app = makeApp();
    const env = makeEnv(ns);
    const res = await app.request(`/api/tokens/magic/consume?ticket=${TICKET}`, {}, env, ctx);
    expect(res.status).toBe(401);
    const bad = await app.request("/api/tokens/magic/consume?ticket=<script>", {}, env, ctx);
    expect(bad.status).toBe(401);
  });
});
