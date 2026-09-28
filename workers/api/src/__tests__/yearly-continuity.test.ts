import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, YEARLY_PLAN_ID, YEARLY_STD_PLAN_ID, type Order, type Plan, type Token } from "../../../../shared/types";
import { YEARLY_STD_RENEW_BONUS_MS, YEARLY_SUB_WINDOW_MS } from "../lib/continuity";
import { activatePaidToken } from "../lib/activate";
import { ordersRoutes } from "../routes/orders";
import { tokensRoutes } from "../routes/tokens";
import { adminRoutes } from "../routes/admin";
import type { Env } from "../types";
import { stubCtx, makeEnv as baseEnv } from "./helpers";

/**
 * 年付连续付费双轨（仿 monthly-sub.test.ts）：
 * - plan_yearly（¥110 连续包年）：首购放行；395 天（365 周期 + 30 宽限）内有 subyear
 *   支付记录放行；断缴超期拒绝并引导 ¥120 年付；upgrade（试用转正）同一规则；
 *   发货写 subyear marker。存量用户无 marker 首次续费按首购放行（平滑迁移，即首购用例）
 * - plan_yearly_std（¥120 年付套餐）：随时可买无门槛；首次发货 365 天；
 *   395 天内续费发货 395 天（+30 天奖励，新购记 bonus_ms 激活并入、升级直接加 expires_at）；
 *   发货写 yrstd marker
 * - subyear / yrstd 两个 marker 互不串写
 * 邮件未配密钥静默失败；ctx 吞掉 waitUntil 副作用（推送/返利），不触网。
 */

const PLANS: Plan[] = [
  { id: "plan_trial", name: "7 天免费体验", duration_days: 7, price_cny: 0, description: "", traffic_limit_gb: 8, max_devices: 1 },
  { id: "plan_monthly", name: "月付套餐", duration_days: 30, price_cny: 12, description: "", traffic_limit_gb: 20, max_devices: 3 },
  { id: YEARLY_PLAN_ID, name: "连续包年", duration_days: 395, bonus_days: 30, price_cny: 110, description: "", traffic_limit_gb: 260, max_devices: 3, monthly_quota_gb: 20 },
  { id: YEARLY_STD_PLAN_ID, name: "年付套餐", duration_days: 365, price_cny: 120, description: "", traffic_limit_gb: 260, max_devices: 3, monthly_quota_gb: 20 },
];

const ADMIN_KEY = "test-admin-key";
const EMAIL = "yearly@example.com";

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

const seedMarker = (tokens: ReturnType<typeof baseEnv>["tokens"], prefix: string, contact: string, lastPaidAt: number) =>
  tokens.store.set(prefix + contact, JSON.stringify({ last_paid_at: lastPaidAt }));

const readMarker = (tokens: ReturnType<typeof baseEnv>["tokens"], prefix: string, contact: string): { last_paid_at: number } | null => {
  const raw = tokens.store.get(prefix + contact);
  return raw ? (JSON.parse(raw) as { last_paid_at: number }) : null;
};

let orderSeq = 0;
/** 落 pending 订单并经管理端确认收款发货，返回发货的 token id */
const fulfillNewOrder = async (env: Env, orders: ReturnType<typeof baseEnv>["tokens"], planId: string, contact = EMAIL) => {
  orderSeq += 1;
  const order: Order = {
    id: `ord_y_${orderSeq}`,
    plan_id: planId,
    status: "pending",
    contact,
    created_at: Date.now(),
  };
  orders.store.set(KV.ORDER + order.id, JSON.stringify(order));
  const res = await app.request(
    `/api/admin/orders/${order.id}/paid`,
    { method: "POST", headers: { "x-admin-key": ADMIN_KEY } },
    env,
    ctx
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; data: { token_id: string } };
  return body.data.token_id;
};

const readTokenById = (tokens: ReturnType<typeof baseEnv>["tokens"], tokenId: string): Token => {
  const idx = JSON.parse(tokens.store.get(KV.TOKEN_BY_ID + tokenId)!) as { uuid: string };
  return JSON.parse(tokens.store.get(KV.TOKEN + idx.uuid)!) as Token;
};

describe("连续包年 plan_yearly 下单资格（¥110，395 天窗口）", () => {
  it("首购（无记录）放行——存量用户平滑迁移同此口径", async () => {
    const { env } = mockEnv();
    const res = await createOrder(env, { plan_id: YEARLY_PLAN_ID, contact: EMAIL });
    expect(res.status).toBe(201);
  });

  it("395 天窗口内有支付记录：续购放行", async () => {
    const { env, tokens } = mockEnv();
    seedMarker(tokens, KV.SUBYEAR, EMAIL, Date.now() - 365 * 86_400_000);
    const res = await createOrder(env, { plan_id: YEARLY_PLAN_ID, contact: EMAIL });
    expect(res.status).toBe(201);
  });

  it("断缴超 395 天：拒绝下单，文案引导 ¥120 年付", async () => {
    const { env, tokens } = mockEnv();
    seedMarker(tokens, KV.SUBYEAR, EMAIL, Date.now() - YEARLY_SUB_WINDOW_MS - 86_400_000);
    const res = await createOrder(env, { plan_id: YEARLY_PLAN_ID, contact: EMAIL });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("年付套餐");
    expect(body.error).toContain("120");
  });

  it("无 contact：400 专属文案", async () => {
    const { env } = mockEnv();
    const res = await createOrder(env, { plan_id: YEARLY_PLAN_ID });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("连续包年需留联系方式");
  });

  it("发货（管理端确认收款）写 subyear marker，不写 yrstd", async () => {
    const { env, tokens, orders } = mockEnv();
    await fulfillNewOrder(env, orders, YEARLY_PLAN_ID);
    expect(readMarker(tokens, KV.SUBYEAR, EMAIL)?.last_paid_at).toBeGreaterThan(0);
    expect(readMarker(tokens, KV.YRSTD, EMAIL)).toBeNull();
  });
});

describe("连续包年 upgrade 目标校验（试用转正）", () => {
  const seedTrialToken = (tokens: ReturnType<typeof baseEnv>["tokens"]) => {
    const token: Token = {
      id: "tk_y_trial",
      uuid: "uuid-y-trial",
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
    tokens.store.set(KV.SESSION + "sess-y", JSON.stringify({ email: EMAIL, created_at: Date.now() }));
  };

  const upgrade = (env: Env, target: string) =>
    app.request(
      "/api/tokens/tk_y_trial/upgrade",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sess-y" },
        body: JSON.stringify({ target_plan_id: target }),
      },
      env,
      ctx
    );

  it("首购连续包年：放行", async () => {
    const { env, tokens } = mockEnv();
    seedTrialToken(tokens);
    const res = await upgrade(env, YEARLY_PLAN_ID);
    expect(res.status).toBe(201);
  });

  it("断缴超 395 天：拒绝并引导 ¥120 年付", async () => {
    const { env, tokens } = mockEnv();
    seedTrialToken(tokens);
    seedMarker(tokens, KV.SUBYEAR, EMAIL, Date.now() - YEARLY_SUB_WINDOW_MS - 86_400_000);
    const res = await upgrade(env, YEARLY_PLAN_ID);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("年付套餐");
  });

  it("年付套餐（¥120）作为升级目标：无资格门槛，断缴记录不影响", async () => {
    const { env, tokens } = mockEnv();
    seedTrialToken(tokens);
    // subyear 断缴记录存在也不拦 ¥120
    seedMarker(tokens, KV.SUBYEAR, EMAIL, Date.now() - 1000 * 86_400_000);
    const res = await upgrade(env, YEARLY_STD_PLAN_ID);
    expect(res.status).toBe(201);
  });
});

describe("年付套餐 plan_yearly_std（¥120）续费奖励", () => {
  it("随时可买无门槛：无任何记录直接下单放行", async () => {
    const { env } = mockEnv();
    const res = await createOrder(env, { plan_id: YEARLY_STD_PLAN_ID, contact: EMAIL });
    expect(res.status).toBe(201);
  });

  it("首次购买发货：365 天（无奖励，bonus_ms 为空），写 yrstd marker", async () => {
    const { env, tokens, orders } = mockEnv();
    const tokenId = await fulfillNewOrder(env, orders, YEARLY_STD_PLAN_ID);
    const token = readTokenById(tokens, tokenId);
    expect(token.bonus_ms ?? 0).toBe(0);
    expect(readMarker(tokens, KV.YRSTD, EMAIL)?.last_paid_at).toBeGreaterThan(0);
    expect(readMarker(tokens, KV.SUBYEAR, EMAIL)).toBeNull(); // 不串写连续包年资格

    // 激活后有效期 = 365 天（月度配额套餐 base_expires_at 同步）
    const activated = await activatePaidToken(env, token);
    const days = (activated.expires_at! - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);
  });

  it("395 天内续费发货：395 天（+30 天奖励记 bonus_ms，激活并入）", async () => {
    const { env, tokens, orders } = mockEnv();
    seedMarker(tokens, KV.YRSTD, EMAIL, Date.now() - 365 * 86_400_000);
    const tokenId = await fulfillNewOrder(env, orders, YEARLY_STD_PLAN_ID);
    const token = readTokenById(tokens, tokenId);
    expect(token.bonus_ms).toBe(YEARLY_STD_RENEW_BONUS_MS);

    const activated = await activatePaidToken(env, token);
    const days = (activated.expires_at! - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(394);
    expect(days).toBeLessThan(396);
  });

  it("断缴超 395 天再买：不送奖励，仍放行（¥120 无门槛）", async () => {
    const { env, tokens, orders } = mockEnv();
    seedMarker(tokens, KV.YRSTD, EMAIL, Date.now() - YEARLY_SUB_WINDOW_MS - 86_400_000);
    const res = await createOrder(env, { plan_id: YEARLY_STD_PLAN_ID, contact: EMAIL });
    expect(res.status).toBe(201);

    const tokenId = await fulfillNewOrder(env, orders, YEARLY_STD_PLAN_ID);
    expect(readTokenById(tokens, tokenId).bonus_ms ?? 0).toBe(0);
  });

  it("升级路径（immediate）：奖励直接加 expires_at 与 base_expires_at", async () => {
    const { env, tokens, orders } = mockEnv();
    const old: Token = {
      id: "tk_y_up",
      uuid: "uuid-y-up",
      plan_id: "plan_monthly",
      status: "active",
      contact: EMAIL,
      traffic_limit_gb: 20,
      traffic_used_gb: 1,
      purchased_at: Date.now() - 10 * 86_400_000,
      expires_at: Date.now() + 20 * 86_400_000,
    };
    tokens.store.set(KV.TOKEN + old.uuid, JSON.stringify(old));
    tokens.store.set(KV.TOKEN_BY_ID + old.id, JSON.stringify({ uuid: old.uuid }));
    seedMarker(tokens, KV.YRSTD, EMAIL, Date.now() - 300 * 86_400_000);
    const order: Order = {
      id: "ord_y_up",
      plan_id: YEARLY_STD_PLAN_ID,
      status: "pending",
      contact: EMAIL,
      created_at: Date.now(),
      upgrade_token_id: old.id,
    };
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));

    const res = await app.request(
      "/api/admin/orders/ord_y_up/paid",
      { method: "POST", headers: { "x-admin-key": ADMIN_KEY } },
      env,
      ctx
    );
    expect(res.status).toBe(200);

    const upgraded = readTokenById(tokens, old.id);
    const days = (upgraded.expires_at! - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(394); // 365 + 30 奖励
    expect(days).toBeLessThan(396);
    // 月度配额基准同步加 30 天
    expect(upgraded.base_expires_at).toBe(upgraded.expires_at);
  });

  it("两个 marker 互不串写：¥120 支付不刷新 ¥110 资格，反之亦然", async () => {
    const { env, tokens, orders } = mockEnv();
    // ¥110 断缴记录（400 天前）：¥120 支付后仍断缴
    const staleSubyear = Date.now() - 400 * 86_400_000;
    seedMarker(tokens, KV.SUBYEAR, EMAIL, staleSubyear);
    await fulfillNewOrder(env, orders, YEARLY_STD_PLAN_ID);
    expect(readMarker(tokens, KV.SUBYEAR, EMAIL)?.last_paid_at).toBe(staleSubyear);
    expect(readMarker(tokens, KV.YRSTD, EMAIL)?.last_paid_at).toBeGreaterThan(0);

    // 反向：先记 yrstd，¥110 支付后 yrstd 不动、subyear 刷新
    const { env: env2, tokens: tokens2, orders: orders2 } = mockEnv();
    const staleYrstd = Date.now() - 100 * 86_400_000;
    seedMarker(tokens2, KV.YRSTD, EMAIL, staleYrstd);
    await fulfillNewOrder(env2, orders2, YEARLY_PLAN_ID);
    expect(readMarker(tokens2, KV.SUBYEAR, EMAIL)?.last_paid_at).toBeGreaterThan(0);
    expect(readMarker(tokens2, KV.YRSTD, EMAIL)?.last_paid_at).toBe(staleYrstd);
  });
});
