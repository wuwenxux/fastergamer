import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { adminAuth } from "../middleware/admin";
import type { Env } from "../types";

/** 只挂 adminAuth 的最小 app，专注鉴权行为本身 */
const makeApp = () => {
  const app = new Hono<{ Bindings: Env }>();
  app.use("/admin/*", adminAuth);
  app.get("/admin/ping", (c) => c.json({ ok: true }));
  return app;
};

const makeEnv = (adminIps?: string) =>
  ({ ADMIN_KEY: "secret-key", ADMIN_IPS: adminIps }) as unknown as Env;

const getWithEnv = (env: Env, headers: Record<string, string>) =>
  makeApp().request("/admin/ping", { headers }, env);

describe("adminAuth 鉴权", () => {
  it("key 正确且未配置 IP 白名单：放行", async () => {
    const res = await getWithEnv(makeEnv(), { "x-admin-key": "secret-key" });
    expect(res.status).toBe(200);
  });

  it("key 缺失或错误：401", async () => {
    expect((await getWithEnv(makeEnv(), {})).status).toBe(401);
    expect((await getWithEnv(makeEnv(), { "x-admin-key": "wrong" })).status).toBe(401);
  });

  it("白名单内精确 IP：放行", async () => {
    const env = makeEnv("154.64.250.200");
    const res = await getWithEnv(env, { "x-admin-key": "secret-key", "cf-connecting-ip": "154.64.250.200" });
    expect(res.status).toBe(200);
  });

  it("白名单 CIDR 命中（家宽拨号换 IP 场景）：放行", async () => {
    const env = makeEnv("110.185.0.0/16,222.212.0.0/16");
    const res = await getWithEnv(env, { "x-admin-key": "secret-key", "cf-connecting-ip": "222.212.131.123" });
    expect(res.status).toBe(200);
  });

  it("CIDR 边界：网段外地址不放行", async () => {
    const env = makeEnv("110.185.0.0/16");
    const res = await getWithEnv(env, { "x-admin-key": "secret-key", "cf-connecting-ip": "110.186.0.1" });
    expect(res.status).toBe(403);
  });

  it("白名单开启后取不到来源 IP：拒绝（fail-closed）", async () => {
    const env = makeEnv("110.185.0.0/16");
    const res = await getWithEnv(env, { "x-admin-key": "secret-key" });
    expect(res.status).toBe(403);
  });

  it("非法规则不误伤：非法 CIDR 视为不匹配", async () => {
    const env = makeEnv("not-an-ip/16,10.0.0.0/33");
    const res = await getWithEnv(env, { "x-admin-key": "secret-key", "cf-connecting-ip": "10.1.2.3" });
    expect(res.status).toBe(403);
  });
});
