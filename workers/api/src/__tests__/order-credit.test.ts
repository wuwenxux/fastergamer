import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, type Order, type Plan } from "../../../../shared/types";
import { ordersRoutes } from "../routes/orders";
import { adminRoutes } from "../routes/admin";
import { createSession } from "../lib/accounts";
import { getCredit } from "../lib/referral";
import { fulfillOrder, type WaitUntilCtx } from "../lib/issue-token";
import type { Env } from "../types";

/**
 * 推广抵扣的扣减时机：下单（pending）只试算不扣额度，发货成功（fulfillOrder）才扣；
 * 订单取消/超时被自动取消时本来就没扣，无需归还。
 * 0 元抵扣单发货失败（fulfillOrder 抛错）不得扣额度。
 */

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

const PLANS: Plan[] = [
  { id: "plan_monthly", name: "月付套餐", duration_days: 30, price_cny: 12, description: "", traffic_limit_gb: 20, max_devices: 2 },
  { id: "plan_ten", name: "十元套餐", duration_days: 30, price_cny: 10, description: "", traffic_limit_gb: 20, max_devices: 2 },
];

const ADMIN_KEY = "test-admin-key";
const BUYER = "buyer@example.com";

const mockEnv = () => {
  const tokens = mockNs();
  const orders = mockNs();
  const plans = mockNs();
  plans.store.set("plans", JSON.stringify(PLANS));
  const env = {
    TOKENS: tokens.ns,
    ORDERS: orders.ns,
    PLANS: plans.ns,
    NODES: mockNs().ns,
    TICKETS: mockNs().ns,
    ADMIN_KEY,
  } as unknown as Env;
  return { env, tokens, orders };
};

/** 给买家预置推广额度（earned 个 ×10 元） */
const seedCredit = (tokens: ReturnType<typeof mockNs>, earned: number, used = 0) => {
  tokens.store.set(KV.REFCREDIT + BUYER, JSON.stringify({ earned, used }));
};

const app = new Hono<{ Bindings: Env }>();
app.route("/api/orders", ordersRoutes);
app.route("/api/admin", adminRoutes);

const ctx = {
  waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const mockCtx = (): WaitUntilCtx => ({ waitUntil: (p) => void Promise.resolve(p).catch(() => {}) });

/** 带买家登录 session 下单（session 邮箱与下单邮箱一致才享抵扣） */
const createOrder = async (env: Env, planId: string) => {
  const session = await createSession(env, BUYER);
  return app.request(
    "/api/orders",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
      body: JSON.stringify({ plan_id: planId, contact: BUYER }),
    },
    env,
    ctx
  );
};

const adminPaid = (env: Env, id: string) =>
  app.request(`/api/admin/orders/${id}/paid`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY } }, env, ctx);

const adminCancel = (env: Env, id: string) =>
  app.request(`/api/admin/orders/${id}/cancel`, { method: "POST", headers: { "x-admin-key": ADMIN_KEY } }, env, ctx);

const readOrder = (orders: ReturnType<typeof mockNs>, id: string): Order =>
  JSON.parse(orders.store.get(KV.ORDER + id)!) as Order;

describe("推广抵扣扣减时机（发货成功才扣）", () => {
  it("pending 订单：下单只试算抵扣，不扣额度；站长确认收款发货后才扣", async () => {
    const { env, tokens, orders } = mockEnv();
    seedCredit(tokens, 3); // 30 元可用，月付 12 元抵 10

    const res = await createOrder(env, "plan_monthly");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; data: { order: Order; paid: boolean } };
    expect(body.data.paid).toBe(false);
    expect(body.data.order.discount_cny).toBe(10);
    expect(body.data.order.payable_cny).toBe(2);
    expect(body.data.order.status).toBe("pending");
    // 关键断言：pending 期间额度未被占用
    expect((await getCredit(env, BUYER)).used).toBe(0);

    const paid = await adminPaid(env, body.data.order.id);
    expect(paid.status).toBe(200);
    expect(readOrder(orders, body.data.order.id).status).toBe("paid");
    // 发货成功才扣（10 元 = 1 个额度）
    const credit = await getCredit(env, BUYER);
    expect(credit.used).toBe(1);
    expect(credit.earned).toBe(3);
  });

  it("0 元抵扣单：发货成功即扣额度", async () => {
    const { env, tokens } = mockEnv();
    seedCredit(tokens, 1); // 10 元可用，10 元套餐全额抵

    const res = await createOrder(env, "plan_ten");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; data: { order: Order; paid: boolean; token?: unknown } };
    expect(body.data.paid).toBe(true);
    expect(body.data.order.status).toBe("paid");
    expect(body.data.order.discount_cny).toBe(10);
    expect((await getCredit(env, BUYER)).used).toBe(1);
  });

  it("fulfillOrder 失败（plan 缺失抛错）：额度不扣", async () => {
    const { env, tokens } = mockEnv();
    seedCredit(tokens, 3);
    const order: Order = {
      id: "or_fail",
      plan_id: "plan_missing",
      status: "pending",
      contact: BUYER,
      discount_cny: 10,
      payable_cny: 0,
      created_at: Date.now(),
    };

    await expect(fulfillOrder(env, mockCtx(), order)).rejects.toThrow("not found");
    expect((await getCredit(env, BUYER)).used).toBe(0);
  });

  it("管理端取消 pending 订单：不扣也不还（额度本来就没动）", async () => {
    const { env, tokens, orders } = mockEnv();
    seedCredit(tokens, 3);

    const res = await createOrder(env, "plan_monthly");
    const body = (await res.json()) as { ok: boolean; data: { order: Order } };
    const cancelled = await adminCancel(env, body.data.order.id);
    expect(cancelled.status).toBe(200);
    expect(readOrder(orders, body.data.order.id).status).toBe("failed");
    expect((await getCredit(env, BUYER)).used).toBe(0);
  });
});

describe("notify-scan 自动取消超 3 天 pending 订单", () => {
  const runScan = (env: Env) =>
    app.request("/api/admin/notify-scan", { method: "POST", headers: { "x-admin-key": ADMIN_KEY } }, env, ctx);

  it("超 3 天 pending 订单置 failed 并写取消原因；额度不动", async () => {
    const { env, tokens, orders } = mockEnv();
    seedCredit(tokens, 3);
    const old: Order = {
      id: "or_old",
      plan_id: "plan_monthly",
      status: "pending",
      contact: BUYER,
      discount_cny: 10,
      payable_cny: 2,
      created_at: Date.now() - 4 * 86_400_000,
    };
    orders.store.set(KV.ORDER + old.id, JSON.stringify(old));

    const res = await runScan(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { cancelled_orders: number } };
    expect(body.data.cancelled_orders).toBe(1);

    const saved = readOrder(orders, "or_old");
    expect(saved.status).toBe("failed");
    expect((saved as Order & { cancel_reason?: string }).cancel_reason).toContain("超 3 天");
    // 抵扣在发货时才扣，自动取消无需归还，额度保持原样
    expect((await getCredit(env, BUYER)).used).toBe(0);
  });

  it("3 天内的 pending 与已 paid 订单不受影响", async () => {
    const { env, orders } = mockEnv();
    const recent: Order = {
      id: "or_recent",
      plan_id: "plan_monthly",
      status: "pending",
      contact: BUYER,
      created_at: Date.now() - 3_600_000,
    };
    const paid: Order = {
      id: "or_paid_old",
      plan_id: "plan_monthly",
      status: "paid",
      contact: BUYER,
      created_at: Date.now() - 10 * 86_400_000,
    };
    orders.store.set(KV.ORDER + recent.id, JSON.stringify(recent));
    orders.store.set(KV.ORDER + paid.id, JSON.stringify(paid));

    const res = await runScan(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { cancelled_orders: number } };
    expect(body.data.cancelled_orders).toBe(0);
    expect(readOrder(orders, "or_recent").status).toBe("pending");
    expect(readOrder(orders, "or_paid_old").status).toBe("paid");
  });
});
