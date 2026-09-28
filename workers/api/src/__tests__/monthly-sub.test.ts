import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, MONTHLY_SUB_PLAN_ID, type Order, type Plan, type Token } from "../../../../shared/types";
import { MONTHLY_SUB_WINDOW_MS } from "../lib/continuity";
import { ordersRoutes } from "../routes/orders";
import { tokensRoutes } from "../routes/tokens";
import { adminRoutes } from "../routes/admin";
import type { Env } from "../types";
import { stubCtx, makeEnv as baseEnv } from "./helpers";

/**
 * 连续包月（plan_monthly_sub，¥10 与 ¥12 月付同规格）续费资格：
 * - 首购（无 submon 记录）放行；37 天（30 天周期 + 7 天宽限）内有支付记录放行；
 *   断缴超宽限拒绝并引导回 ¥12 月付；无 contact 专属 400 文案
 * - 支付成功发货（fulfillOrder 新购 / 升级两条路径）写 submon:{contact} marker；
 *   以支付时间计连续性，不依赖激活时间
 * - marker 只影响本套餐：其他套餐下单不受断缴记录影响
 * - 试用转正走 /api/tokens/:id/upgrade，同一资格规则（首购放行）
 * 邮件未配密钥静默失败；ctx 吞掉 waitUntil 副作用（推送/返利），不触网。
 */

const PLANS: Plan[] = [
  { id: "plan_trial", name: "7 天免费体验", duration_days: 7, price_cny: 0, description: "", traffic_limit_gb: 8, max_devices: 1 },
  { id: MONTHLY_SUB_PLAN_ID, name: "连续包月", duration_days: 30, price_cny: 10, description: "", traffic_limit_gb: 20, max_devices: 3 },
  { id: "plan_monthly", name: "月付套餐", duration_days: 30, price_cny: 12, description: "", traffic_limit_gb: 20, max_devices: 3 },
];

const ADMIN_KEY = "test-admin-key";
const EMAIL = "suber@example.com";

const mockEnv = () => baseEnv({ plans: PLANS, adminKey: ADMIN_KEY, mock: true });

const app = new Hono<{ Bindings: Env }>();
app.route("/api/orders", ordersRoutes);
app.route("/api/tokens", tokensRoutes);
app.route("/api/admin", adminRoutes);

const ctx = stubCtx();

const createOrder = (env: Env, body: Record<string, unknown>) =>
  app.request(
    "/api/orders",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
    ctx
  );

const seedMarker = (tokens: ReturnType<typeof baseEnv>["tokens"], contact: string, lastPaidAt: number) =>
  tokens.store.set(KV.SUBMON + contact, JSON.stringify({ last_paid_at: lastPaidAt }));

const readMarker = (tokens: ReturnType<typeof baseEnv>["tokens"], contact: string): { last_paid_at: number } | null => {
  const raw = tokens.store.get(KV.SUBMON + contact);
  return raw ? (JSON.parse(raw) as { last_paid_at: number }) : null;
};

describe("连续包月下单资格（POST /api/orders）", () => {
  it("首购（无记录）放行", async () => {
    const { env } = mockEnv();
    const res = await createOrder(env, { plan_id: MONTHLY_SUB_PLAN_ID, contact: EMAIL });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; data: { order: Order } };
    expect(body.data.order.plan_id).toBe(MONTHLY_SUB_PLAN_ID);
    expect(body.data.order.status).toBe("pending");
  });

  it("37 天窗口内有支付记录：续购放行", async () => {
    const { env, tokens } = mockEnv();
    seedMarker(tokens, EMAIL, Date.now() - 30 * 86_400_000);
    const res = await createOrder(env, { plan_id: MONTHLY_SUB_PLAN_ID, contact: EMAIL });
    expect(res.status).toBe(201);
  });

  it("断缴超 37 天：拒绝下单，文案引导回 ¥12 月付", async () => {
    const { env, tokens } = mockEnv();
    seedMarker(tokens, EMAIL, Date.now() - MONTHLY_SUB_WINDOW_MS - 86_400_000);
    const res = await createOrder(env, { plan_id: MONTHLY_SUB_PLAN_ID, contact: EMAIL });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("月付");
    expect(body.error).toContain("12");
  });

  it("无 contact：400 专属文案（先于通用 contact 必填校验）", async () => {
    const { env } = mockEnv();
    const res = await createOrder(env, { plan_id: MONTHLY_SUB_PLAN_ID });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("连续包月需留联系方式");
  });

  it("marker 不影响其他套餐：断缴记录存在时 ¥12 月付照常下单", async () => {
    const { env, tokens } = mockEnv();
    seedMarker(tokens, EMAIL, Date.now() - MONTHLY_SUB_WINDOW_MS - 86_400_000);
    const res = await createOrder(env, { plan_id: "plan_monthly", contact: EMAIL });
    expect(res.status).toBe(201);
  });
});

describe("连续包月 marker 写入（fulfillOrder 两条路径）", () => {
  it("新购发货（管理端确认收款）：写 submon:{contact} marker", async () => {
    const { env, tokens, orders } = mockEnv();
    const order: Order = {
      id: "ord_sub_new",
      plan_id: MONTHLY_SUB_PLAN_ID,
      status: "pending",
      contact: EMAIL,
      created_at: Date.now(),
    };
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));

    const res = await app.request(
      "/api/admin/orders/ord_sub_new/paid",
      { method: "POST", headers: { "x-admin-key": ADMIN_KEY } },
      env,
      ctx
    );
    expect(res.status).toBe(200);
    expect(readMarker(tokens, EMAIL)?.last_paid_at).toBeGreaterThan(0);
  });

  it("升级/续费发货（upgrade_token_id 路径）：同样写 marker", async () => {
    const { env, tokens, orders } = mockEnv();
    const old: Token = {
      id: "tk_sub_old",
      uuid: "uuid-sub-old",
      plan_id: MONTHLY_SUB_PLAN_ID, // 同套餐续费场景（到期后续买同一 token）
      status: "active",
      contact: EMAIL,
      traffic_limit_gb: 20,
      traffic_used_gb: 1,
      purchased_at: Date.now() - 30 * 86_400_000,
      expires_at: Date.now() - 1000, // 已到期续费
    };
    tokens.store.set(KV.TOKEN + old.uuid, JSON.stringify(old));
    tokens.store.set(KV.TOKEN_BY_ID + old.id, JSON.stringify({ uuid: old.uuid }));
    const order: Order = {
      id: "ord_sub_up",
      plan_id: MONTHLY_SUB_PLAN_ID,
      status: "pending",
      contact: EMAIL,
      created_at: Date.now(),
      upgrade_token_id: old.id,
    };
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));

    const res = await app.request(
      "/api/admin/orders/ord_sub_up/paid",
      { method: "POST", headers: { "x-admin-key": ADMIN_KEY } },
      env,
      ctx
    );
    expect(res.status).toBe(200);
    expect(readMarker(tokens, EMAIL)?.last_paid_at).toBeGreaterThan(0);
  });

  it("其他套餐发货不写 marker", async () => {
    const { env, tokens, orders } = mockEnv();
    const order: Order = {
      id: "ord_normal",
      plan_id: "plan_monthly",
      status: "pending",
      contact: EMAIL,
      created_at: Date.now(),
    };
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));

    const res = await app.request(
      "/api/admin/orders/ord_normal/paid",
      { method: "POST", headers: { "x-admin-key": ADMIN_KEY } },
      env,
      ctx
    );
    expect(res.status).toBe(200);
    expect(readMarker(tokens, EMAIL)).toBeNull();
  });
});

describe("连续包月升级入口（试用转正，POST /api/tokens/:id/upgrade）", () => {
  const seedTrialToken = (tokens: ReturnType<typeof mockNs>) => {
    const token: Token = {
      id: "tk_trial1",
      uuid: "uuid-trial-1",
      plan_id: "plan_trial",
      status: "active",
      contact: EMAIL,
      traffic_limit_gb: 8,
      traffic_used_gb: 0,
      purchased_at: Date.now() - 86_400_000,
      expires_at: Date.now() + 6 * 86_400_000,
    };
    tokens.store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
    tokens.store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
    tokens.store.set(KV.SESSION + "sess-1", JSON.stringify({ email: EMAIL, created_at: Date.now() }));
    return token;
  };

  const upgrade = (env: Env, target: string) =>
    app.request(
      "/api/tokens/tk_trial1/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sess-1" },
        body: JSON.stringify({ target_plan_id: target }),
      },
      env,
      ctx
    );

  it("试用转正首购连续包月：放行（落 pending 订单）", async () => {
    const { env, tokens } = mockEnv();
    seedTrialToken(tokens);
    const res = await upgrade(env, MONTHLY_SUB_PLAN_ID);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; data: { order: Order } };
    expect(body.data.order.plan_id).toBe(MONTHLY_SUB_PLAN_ID);
  });

  it("断缴超 37 天的试用转正连续包月：拒绝并引导回 ¥12 月付", async () => {
    const { env, tokens } = mockEnv();
    seedTrialToken(tokens);
    seedMarker(tokens, EMAIL, Date.now() - MONTHLY_SUB_WINDOW_MS - 86_400_000);
    const res = await upgrade(env, MONTHLY_SUB_PLAN_ID);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("月付");
  });
});
