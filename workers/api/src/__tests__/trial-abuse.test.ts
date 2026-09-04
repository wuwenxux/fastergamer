import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { KV } from "../../../../shared/types";
import { ordersRoutes } from "../routes/orders";
import { tokensRoutes } from "../routes/tokens";
import { isDisposableEmail } from "../lib/disposable-email";
import type { Env } from "../types";

/** 假 KV：map 实现（put 忽略 TTL 等选项，测试只关心存在性） */
const fakeNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
  return { ns, store };
};

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const TRIAL_PLAN = {
  id: "plan_3days",
  name: "3 天免费体验",
  duration_days: 3,
  price_cny: 0,
  traffic_limit_gb: 20,
  max_devices: 1,
};

const makeEnv = (tokens: KVNamespace) =>
  ({
    TOKENS: tokens,
    PLANS: fakeNs().ns,
    DEFAULT_PLANS: JSON.stringify([TRIAL_PLAN]),
    SITE_URL: "https://fastergamer.click",
  }) as unknown as Env;

const postJson = (
  app: Hono<{ Bindings: Env }>,
  path: string,
  body: unknown,
  env: Env,
  ip?: string
) =>
  app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ip ? { "cf-connecting-ip": ip } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
    ctx
  );

describe("isDisposableEmail", () => {
  it("命中常见临时邮箱域名", () => {
    expect(isDisposableEmail("a@10minutemail.com")).toBe(true);
    expect(isDisposableEmail("b@yopmail.com")).toBe(true);
    expect(isDisposableEmail("c@24mail.chacuo.net")).toBe(true);
  });

  it("放行正常邮箱（大小写不敏感）", () => {
    expect(isDisposableEmail("a@qq.com")).toBe(false);
    expect(isDisposableEmail("b@Gmail.com")).toBe(false);
    expect(isDisposableEmail("not-an-email")).toBe(false);
  });
});

describe("POST /api/tokens/trial（防白嫖）", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/tokens", tokensRoutes);

  it("临时邮箱直接 400，不落任何 KV", async () => {
    const tokens = fakeNs();
    const res = await postJson(app, "/api/tokens/trial", { email: "x@mailinator.com" }, makeEnv(tokens.ns));
    expect(res.status).toBe(400);
    expect(tokens.store.size).toBe(0);
  });

  it("正常领取 201，写入邮箱与 IP 双标记", async () => {
    const tokens = fakeNs();
    const res = await postJson(
      app,
      "/api/tokens/trial",
      { email: "user@qq.com" },
      makeEnv(tokens.ns),
      "1.1.1.1"
    );
    expect(res.status).toBe(201);
    expect(tokens.store.has(KV.TRIAL + "user@qq.com")).toBe(true);
    expect(tokens.store.has(KV.TRIAL_IP + "1.1.1.1")).toBe(true);
  });

  it("同邮箱重复领取 409", async () => {
    const tokens = fakeNs();
    const env = makeEnv(tokens.ns);
    await postJson(app, "/api/tokens/trial", { email: "user@qq.com" }, env, "1.1.1.1");
    const res = await postJson(app, "/api/tokens/trial", { email: "user@qq.com" }, env, "2.2.2.2");
    expect(res.status).toBe(409);
  });

  it("同 IP 换邮箱当天再领 429，换 IP 则可领", async () => {
    const tokens = fakeNs();
    const env = makeEnv(tokens.ns);
    await postJson(app, "/api/tokens/trial", { email: "a@qq.com" }, env, "1.1.1.1");
    const res2 = await postJson(app, "/api/tokens/trial", { email: "b@qq.com" }, env, "1.1.1.1");
    expect(res2.status).toBe(429);
    const res3 = await postJson(app, "/api/tokens/trial", { email: "b@qq.com" }, env, "3.3.3.3");
    expect(res3.status).toBe(201);
  });
});

describe("POST /api/orders（临时邮箱拦截）", () => {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/api/orders", ordersRoutes);

  it("临时邮箱下单 400（在校验套餐前拒绝，不查 KV）", async () => {
    const res = await postJson(
      app,
      "/api/orders",
      { plan_id: "plan_monthly", contact: "x@tempmail.com" },
      makeEnv(fakeNs().ns)
    );
    expect(res.status).toBe(400);
  });
});
