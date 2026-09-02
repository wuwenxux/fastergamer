import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { getOrCreateOrderConfirmTicket, validateOrderConfirmTicket } from "../lib/kv";
import { adminAuth } from "../middleware/admin";
import type { Env } from "../types";

/** 假 KV：map 实现，cacheTtl 参数忽略 */
const fakeNs = () => {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
};

const makeEnv = () =>
  ({ ADMIN_KEY: "test-admin-key", ORDERS: fakeNs() }) as unknown as Env;

describe("订单确认票据", () => {
  it("同订单复用同一票据", async () => {
    const env = makeEnv();
    const t1 = await getOrCreateOrderConfirmTicket(env, "ord1");
    const t2 = await getOrCreateOrderConfirmTicket(env, "ord1");
    expect(t1).toBe(t2);
    expect(t1.length).toBeGreaterThan(32);
  });

  it("GET 只验不焚，POST 验后焚毁", async () => {
    const env = makeEnv();
    const ticket = await getOrCreateOrderConfirmTicket(env, "ord1");
    expect(await validateOrderConfirmTicket(env, "ord1", ticket, false)).toBe(true);
    // 网关预取（GET）后票据仍可用
    expect(await validateOrderConfirmTicket(env, "ord1", ticket, false)).toBe(true);
    expect(await validateOrderConfirmTicket(env, "ord1", ticket, true)).toBe(true);
    // 焚毁后重放失败
    expect(await validateOrderConfirmTicket(env, "ord1", ticket, true)).toBe(false);
  });

  it("错误票据 / 错订单号拒绝", async () => {
    const env = makeEnv();
    const ticket = await getOrCreateOrderConfirmTicket(env, "ord1");
    expect(await validateOrderConfirmTicket(env, "ord1", "wrong", false)).toBe(false);
    expect(await validateOrderConfirmTicket(env, "ord2", ticket, false)).toBe(false);
  });
});

describe("adminAuth 中间件", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/api/admin/*", adminAuth);
  app.get("/api/admin/orders/:id/confirm", (c) => c.json({ ok: true }));
  app.post("/api/admin/orders/:id/confirm", (c) => c.json({ ok: true }));
  app.get("/api/admin/tokens", (c) => c.json({ ok: true }));

  it("x-admin-key header 放行", async () => {
    const res = await app.request(
      "/api/admin/tokens",
      { headers: { "x-admin-key": "test-admin-key" } },
      makeEnv()
    );
    expect(res.status).toBe(200);
  });

  it("?key= 主 key 不再放行（含 confirm 路径）", async () => {
    const env = makeEnv();
    const ticket = await getOrCreateOrderConfirmTicket(env, "ord1");
    const res = await app.request(`/api/admin/orders/${"ord1"}/confirm?key=test-admin-key`, {}, env);
    expect(res.status).toBe(401);
    expect(ticket).toBeTruthy();
  });

  it("confirm 路径 ?ticket= 放行 GET 且不焚票，POST 焚票", async () => {
    const env = makeEnv();
    const ticket = await getOrCreateOrderConfirmTicket(env, "ord1");
    const get1 = await app.request(`/api/admin/orders/ord1/confirm?ticket=${ticket}`, {}, env);
    expect(get1.status).toBe(200);
    const get2 = await app.request(`/api/admin/orders/ord1/confirm?ticket=${ticket}`, {}, env);
    expect(get2.status).toBe(200);
    const post = await app.request(
      `/api/admin/orders/ord1/confirm?ticket=${ticket}`,
      { method: "POST" },
      env
    );
    expect(post.status).toBe(200);
    const replay = await app.request(
      `/api/admin/orders/ord1/confirm?ticket=${ticket}`,
      { method: "POST" },
      env
    );
    expect(replay.status).toBe(401);
  });

  it("ticket 不能用于其他 admin 路径", async () => {
    const env = makeEnv();
    const ticket = await getOrCreateOrderConfirmTicket(env, "ord1");
    const res = await app.request(`/api/admin/tokens?ticket=${ticket}`, {}, env);
    expect(res.status).toBe(401);
  });
});
