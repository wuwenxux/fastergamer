import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, type Token } from "../../../../shared/types";
import { tokensRoutes } from "../routes/tokens";
import type { Env } from "../types";

/** 假 KV：map 实现，支持 list 前缀扫描（listTokensByContact 依赖） */
const fakeNs = () => {
  const store = new Map<string, string>();
  const list = vi.fn(async ({ prefix }: { prefix?: string }) => ({
    keys: [...store.keys()]
      .filter((k) => !prefix || k.startsWith(prefix))
      .map((name) => ({ name })),
    list_complete: true,
  }));
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    list,
  } as unknown as KVNamespace;
  return { ns, store, list };
};

const makeEnv = (ns: KVNamespace) =>
  ({ TOKENS: ns, SITE_URL: "https://fastergamer.cn" }) as unknown as Env;

const seedToken = (store: Map<string, string>, contact: string, id: string) => {
  const token: Token = {
    id,
    uuid: crypto.randomUUID(),
    plan_id: "plan_monthly",
    status: "active",
    contact,
    traffic_limit_gb: 20,
    traffic_used_gb: 3,
    purchased_at: Date.now(),
    expires_at: Date.now() + 86_400_000,
  };
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  return token;
};

const post = (app: Hono<{ Bindings: Env }>, path: string, contact: string, env: Env) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contact }),
    },
    env
  );

describe("POST /api/tokens/recover（不在响应泄露 token 数据）", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/tokens", tokensRoutes);

  it("邮箱格式非法返回 400", async () => {
    const res = await post(app, "/api/tokens/recover", "not-an-email", makeEnv(fakeNs().ns));
    expect(res.status).toBe(400);
  });

  it("无该邮箱客户也返回固定 { ok: true }（不区分是否存在）", async () => {
    const res = await post(app, "/api/tokens/recover", "ghost@example.com", makeEnv(fakeNs().ns));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("有 token 时响应同样只有 { ok: true }，不携带任何 token 数据", async () => {
    const { ns, store } = fakeNs();
    const token = seedToken(store, "user@example.com", "tk_secret_1");
    const res = await post(app, "/api/tokens/recover", "user@example.com", makeEnv(ns));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain(token.id);
    expect(JSON.stringify(body)).not.toContain("user@example.com");
  });

  it("收件人节流：同一邮箱第 4 次起静默 ok，不再跑全量 list", async () => {
    const { ns, store, list } = fakeNs();
    seedToken(store, "user@example.com", "tk_throttle_1");
    const env = makeEnv(ns);
    for (let i = 0; i < 3; i++) {
      await post(app, "/api/tokens/recover", "user@example.com", env);
    }
    expect(list).toHaveBeenCalledTimes(3);
    const res = await post(app, "/api/tokens/recover", "user@example.com", env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(list).toHaveBeenCalledTimes(3); // 被节流，未触发全量 KV list
  });
});

describe("POST /api/tokens/login-link（收件人节流）", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/tokens", tokensRoutes);

  it("同一邮箱第 4 次起静默 ok，不发信（不跑 list）", async () => {
    const { ns, store, list } = fakeNs();
    seedToken(store, "user@example.com", "tk_login_1");
    const env = makeEnv(ns);
    for (let i = 0; i < 3; i++) {
      const res = await post(app, "/api/tokens/login-link", "user@example.com", env);
      expect(res.status).toBe(200);
    }
    expect(list).toHaveBeenCalledTimes(3);
    const res = await post(app, "/api/tokens/login-link", "user@example.com", env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(list).toHaveBeenCalledTimes(3);
  });
});
