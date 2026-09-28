import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, type Plan, type Token } from "../../../../shared/types";
import { plansRoutes } from "../routes/plans";
import { ordersRoutes } from "../routes/orders";
import { tokensRoutes } from "../routes/tokens";
import type { Env } from "../types";
import { makeEnv as baseEnv, noopCtx } from "./helpers";

/**
 * 企业套餐（plan_biz_*）在 click 站已下架：公开套餐列表不返回、
 * 公开下单拒绝、升级不可选；只在 fastergamer.cn 展示、邮件洽谈。
 * KV 里的企业套餐数据保留（dormant），仅公开 API 层拦截。
 */

const PLANS: Plan[] = [
  { id: "plan_trial", name: "3 天免费体验", duration_days: 3, price_cny: 0, description: "", traffic_limit_gb: 20, max_devices: 1 },
  { id: "plan_monthly", name: "月付套餐", duration_days: 30, price_cny: 12, description: "", traffic_limit_gb: 20, max_devices: 2 },
  { id: "plan_biz_yearly", name: "企业年付", duration_days: 365, price_cny: 999, description: "", traffic_limit_gb: 500, max_devices: 20 },
];

const makeEnv = () => baseEnv({ plans: PLANS });

const app = new Hono<{ Bindings: Env }>();
app.route("/api/plans", plansRoutes);
app.route("/api/orders", ordersRoutes);
app.route("/api/tokens", tokensRoutes);

const ctx = noopCtx();

describe("企业套餐下架（click 站）", () => {
  it("GET /api/plans 不返回企业套餐", async () => {
    const { env } = makeEnv();
    const res = await app.request("/api/plans", {}, env, ctx);
    const body = (await res.json()) as { data: Plan[] };
    expect(res.status).toBe(200);
    expect(body.data.map((p) => p.id)).toEqual(["plan_trial", "plan_monthly"]);
  });

  it("POST /api/orders 企业套餐拒绝下单", async () => {
    const { env } = makeEnv();
    const res = await app.request(
      "/api/orders",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "plan_biz_yearly", contact: "boss@example.com" }),
      },
      env,
      ctx
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("fastergamer.cn");
  });

  it("POST /api/tokens/:id/upgrade 企业套餐不可作为升级目标", async () => {
    const { env, tokens } = makeEnv();
    const token: Token = {
      id: "tk_biz",
      uuid: "uuid-biz",
      plan_id: "plan_monthly",
      status: "active",
      contact: "user@example.com",
      traffic_limit_gb: 20,
      traffic_used_gb: 1,
      purchased_at: Date.now(),
      expires_at: Date.now() + 20 * 86_400_000,
    };
    tokens.store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
    tokens.store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
    // 本人会话：Bearer → 邮箱与 token.contact 一致
    tokens.store.set(KV.SESSION + "sess-1", JSON.stringify({ email: "user@example.com", created_at: Date.now() }));

    const res = await app.request(
      "/api/tokens/tk_biz/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sess-1" },
        body: JSON.stringify({ target_plan_id: "plan_biz_yearly" }),
      },
      env,
      ctx
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("fastergamer.cn");
  });
});
