import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, type Order, type Plan, type Token } from "../../../../shared/types";
import { ordersRoutes } from "../routes/orders";
import { adminRoutes } from "../routes/admin";
import type { Env } from "../types";

/**
 * 人工收款码过渡支付：
 * - 用户端 POST /api/orders/:id/notify-paid（「我已支付」，节流通知站长）
 * - 管理端 POST /api/admin/orders/:id/paid（确认收款，复用 fulfillOrder 发货）
 * - GET /api/orders/:id 补 payable_cny/plan_id 供刷新后展示
 * 测试环境未配 ALIYUN 密钥与 ADMIN_NOTIFY_EMAIL，notifyAdmin 静默跳过，
 * 故通知断言落在节流字段 paid_notify_at 的写入上。
 */

/** 内存版 KV namespace（Map 实现 get/put/delete/list，fulfillOrder 链路会用到 list） */
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
];

const ADMIN_KEY = "test-admin-key";

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

const app = new Hono<{ Bindings: Env }>();
app.route("/api/orders", ordersRoutes);
app.route("/api/admin", adminRoutes);

const ctx = {
  waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const makeOrder = (overrides: Partial<Order> = {}): Order => ({
  id: "ord_manual",
  plan_id: "plan_monthly",
  status: "pending",
  contact: "buyer@example.com",
  created_at: Date.now(),
  ...overrides,
});

const seedOrder = (orders: ReturnType<typeof mockNs>, order: Order) => {
  orders.store.set(KV.ORDER + order.id, JSON.stringify(order));
};

const readOrder = (orders: ReturnType<typeof mockNs>, id: string): Order =>
  JSON.parse(orders.store.get(KV.ORDER + id)!) as Order;

const notifyPaid = (env: Env, id: string) =>
  app.request(`/api/orders/${id}/notify-paid`, { method: "POST" }, env, ctx);

const adminPaid = (env: Env, id: string, key: string | null = ADMIN_KEY) =>
  app.request(
    `/api/admin/orders/${id}/paid`,
    { method: "POST", headers: key ? { "x-admin-key": key } : {} },
    env,
    ctx
  );

describe("POST /api/orders/:id/notify-paid（用户端「我已支付」）", () => {
  it("pending 订单：通知站长并写入 paid_notify_at", async () => {
    const { env, orders } = mockEnv();
    seedOrder(orders, makeOrder());
    const res = await notifyPaid(env, "ord_manual");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { notified: boolean } };
    expect(body.data.notified).toBe(true);
    // 未配 ADMIN_NOTIFY_EMAIL 时 notifyAdmin 静默跳过，节流字段即「已通知」的凭据
    expect(readOrder(orders, "ord_manual").paid_notify_at).toBeGreaterThan(0);
  });

  it("6 小时内重复点击不再通知，paid_notify_at 不刷新", async () => {
    const { env, orders } = mockEnv();
    seedOrder(orders, makeOrder({ paid_notify_at: Date.now() - 3_600_000 }));
    const before = readOrder(orders, "ord_manual").paid_notify_at;
    const res = await notifyPaid(env, "ord_manual");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { notified: boolean } };
    expect(body.data.notified).toBe(false);
    expect(readOrder(orders, "ord_manual").paid_notify_at).toBe(before);
  });

  it("已 paid 订单：不通知，返回 paid: true", async () => {
    const { env, orders } = mockEnv();
    seedOrder(orders, makeOrder({ status: "paid", token_id: "tk_x" }));
    const res = await notifyPaid(env, "ord_manual");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { notified: boolean; paid: boolean } };
    expect(body.data).toEqual({ notified: false, paid: true });
    expect(readOrder(orders, "ord_manual").paid_notify_at).toBeUndefined();
  });

  it("已取消（failed）订单：409", async () => {
    const { env, orders } = mockEnv();
    seedOrder(orders, makeOrder({ status: "failed" }));
    const res = await notifyPaid(env, "ord_manual");
    expect(res.status).toBe(409);
  });

  it("订单不存在：404", async () => {
    const { env } = mockEnv();
    const res = await notifyPaid(env, "ord_missing");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/orders/:id/paid（管理端确认收款）", () => {
  it("pending 订单：发货成功，token 落 KV，订单置 paid 并回 token_id", async () => {
    const { env, tokens, orders } = mockEnv();
    seedOrder(orders, makeOrder());
    const res = await adminPaid(env, "ord_manual");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { token_id: string } };
    expect(body.data.token_id).toBeTruthy();

    const saved = readOrder(orders, "ord_manual");
    expect(saved.status).toBe("paid");
    expect(saved.token_id).toBe(body.data.token_id);
    expect(saved.paid_at).toBeGreaterThan(0);

    // token 本体与 id 索引均已落库
    const idx = JSON.parse(tokens.store.get(KV.TOKEN_BY_ID + body.data.token_id)!) as { uuid: string };
    const token = JSON.parse(tokens.store.get(KV.TOKEN + idx.uuid)!) as Token;
    expect(token.id).toBe(body.data.token_id);
    expect(token.contact).toBe("buyer@example.com");
  });

  it("重复确认：已 paid 订单返回 409，不重复发货", async () => {
    const { env, tokens, orders } = mockEnv();
    seedOrder(orders, makeOrder());
    const first = await adminPaid(env, "ord_manual");
    expect(first.status).toBe(200);
    const tokenCount = [...tokens.store.keys()].filter((k) => k.startsWith(KV.TOKEN)).length;

    const second = await adminPaid(env, "ord_manual");
    expect(second.status).toBe(409);
    expect([...tokens.store.keys()].filter((k) => k.startsWith(KV.TOKEN)).length).toBe(tokenCount);
  });

  it("已取消（failed）订单：409", async () => {
    const { env, orders } = mockEnv();
    seedOrder(orders, makeOrder({ status: "failed" }));
    const res = await adminPaid(env, "ord_manual");
    expect(res.status).toBe(409);
  });

  it("订单不存在：404", async () => {
    const { env } = mockEnv();
    const res = await adminPaid(env, "ord_missing");
    expect(res.status).toBe(404);
  });

  it("无 x-admin-key：401", async () => {
    const { env, orders } = mockEnv();
    seedOrder(orders, makeOrder());
    const res = await adminPaid(env, "ord_manual", null);
    expect(res.status).toBe(401);
    expect(readOrder(orders, "ord_manual").status).toBe("pending");
  });
});

describe("GET /api/orders/:id 补充返回字段", () => {
  it("返回 payable_cny 与 plan_id，不返回联系方式", async () => {
    const { env, orders } = mockEnv();
    seedOrder(orders, makeOrder({ payable_cny: 2 }));
    const res = await app.request("/api/orders/ord_manual", {}, env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(body.data.status).toBe("pending");
    expect(body.data.payable_cny).toBe(2);
    expect(body.data.plan_id).toBe("plan_monthly");
    expect(body.data.contact).toBeUndefined();
    // 未支付不泄露 token_id
    expect(body.data.token_id).toBeUndefined();
  });
});
