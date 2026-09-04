import { describe, expect, it, vi } from "vitest";
import { KV, type Order, type Plan, type Token } from "../../../../shared/types";
import { fulfillOrder, type WaitUntilCtx } from "../lib/issue-token";
import { resetPenalty } from "../lib/reset-penalty";
import type { Env } from "../types";

/** 内存版 KV namespace（Map 实现 get/put/delete） */
const mockNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  } as unknown as KVNamespace;
  return { store, ns };
};

const PLANS: Plan[] = [
  { id: "plan_monthly", name: "月付套餐", duration_days: 30, price_cny: 12, description: "", traffic_limit_gb: 20, max_devices: 2 },
  { id: "plan_quarterly", name: "季付套餐", duration_days: 90, price_cny: 30, description: "", traffic_limit_gb: 60, max_devices: 3, monthly_quota_gb: 20 },
];

const mockEnv = () => {
  const tokens = mockNs();
  const orders = mockNs();
  const plans = mockNs();
  const nodes = mockNs();
  plans.store.set("plans", JSON.stringify(PLANS));
  const env = { TOKENS: tokens.ns, ORDERS: orders.ns, PLANS: plans.ns, NODES: nodes.ns } as unknown as Env;
  return { env, tokens, orders };
};

/** waitUntil 收集但不阻塞断言；吞掉副作用（邮件/推送）在测试环境里的预期失败 */
const mockCtx = (): WaitUntilCtx => ({ waitUntil: (p) => void Promise.resolve(p).catch(() => {}) });

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_upg",
  uuid: "uuid-upg",
  plan_id: "plan_monthly",
  status: "active",
  contact: "user@example.com",
  traffic_limit_gb: 20,
  traffic_used_gb: 18,
  purchased_at: Date.now() - 10 * 86_400_000,
  activated_at: Date.now() - 10 * 86_400_000,
  expires_at: Date.now() + 20 * 86_400_000,
  ...overrides,
});

const seedToken = (tokens: ReturnType<typeof mockNs>, token: Token) => {
  tokens.store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  tokens.store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

describe("fulfillOrder · 升级订单（upgrade_token_id）", () => {
  it("支付成功后升级既有 token：uuid/设备保留，套餐/流量/有效期换新", async () => {
    const { env, tokens, orders } = mockEnv();
    const token = makeToken({
      devices: [{ id: "dv_1", uuid: "uuid-dev1", name: "iPhone", traffic_used_gb: 1, created_at: 1 }],
      traffic_by_node: { "node-hk": 18 * 1024 ** 3 },
      traffic_exhausted_at: Date.now(),
      notify_log: { traffic_80: 1, exhausted: 2, expiry_3d: 3 },
    });
    seedToken(tokens, token);
    const order: Order = {
      id: "or_upg1",
      plan_id: "plan_quarterly",
      status: "pending",
      contact: "user@example.com",
      payable_cny: 18,
      upgrade_token_id: token.id,
      created_at: Date.now(),
    };
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));

    const before = Date.now();
    const result = await fulfillOrder(env, mockCtx(), order);

    expect(result.already).toBe(false);
    const upgraded = result.token!;
    // 同一 token：id/uuid/设备保留
    expect(upgraded.id).toBe("tk_upg");
    expect(upgraded.uuid).toBe("uuid-upg");
    expect(upgraded.devices?.[0]?.uuid).toBe("uuid-dev1");
    // 套餐/额度换新
    expect(upgraded.plan_id).toBe("plan_quarterly");
    expect(upgraded.traffic_limit_gb).toBe(60);
    expect(upgraded.max_devices).toBe(3);
    // 有效期按新套餐时长从升级时刻重计
    expect(upgraded.expires_at!).toBeGreaterThanOrEqual(before + 90 * 86_400_000);
    // 月度配额账期初始化
    expect(upgraded.base_expires_at).toBe(upgraded.expires_at);
    expect(upgraded.months_borrowed).toBe(0);
    expect(upgraded.month_used_bytes).toBe(0);
    expect(upgraded.month_key).toMatch(/^\d{4}-\d{2}$/);
    // 流量记账清零：offset 对齐当前 Xray 累计值
    expect(upgraded.traffic_used_gb).toBe(0);
    expect(upgraded.traffic_offset_bytes).toBe(18 * 1024 ** 3);
    expect(upgraded.traffic_exhausted_at).toBeUndefined();
    // 流量类提醒清除，到期提醒保留
    expect(upgraded.notify_log?.traffic_80).toBeUndefined();
    expect(upgraded.notify_log?.exhausted).toBeUndefined();
    expect(upgraded.notify_log?.expiry_3d).toBe(3);

    // 订单落库为 paid 且指向同一 token
    const savedOrder = JSON.parse(orders.store.get(KV.ORDER + order.id)!) as Order;
    expect(savedOrder.status).toBe("paid");
    expect(savedOrder.token_id).toBe("tk_upg");
    // KV 中的 token 同样已更新
    const savedToken = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-upg")!) as Token;
    expect(savedToken.plan_id).toBe("plan_quarterly");
  });

  it("过期 token 升级后恢复 active；已 paid 订单幂等返回", async () => {
    const { env, tokens, orders } = mockEnv();
    const token = makeToken({ status: "expired", expires_at: Date.now() - 86_400_000 });
    seedToken(tokens, token);
    const order: Order = {
      id: "or_upg2",
      plan_id: "plan_quarterly",
      status: "pending",
      payable_cny: 30,
      upgrade_token_id: token.id,
      created_at: Date.now(),
    };
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));

    const result = await fulfillOrder(env, mockCtx(), order);
    expect(result.token!.status).toBe("active");

    // 幂等：重放已 paid 订单不重复升级
    const replay = await fulfillOrder(env, mockCtx(), { ...order, status: "paid", token_id: token.id });
    expect(replay.already).toBe(true);
    expect(replay.token!.id).toBe("tk_upg");
  });

  it("升级目标 token 不存在时抛错", async () => {
    const { env, orders } = mockEnv();
    const order: Order = {
      id: "or_upg3",
      plan_id: "plan_quarterly",
      status: "pending",
      upgrade_token_id: "tk_missing",
      created_at: Date.now(),
    };
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));
    await expect(fulfillOrder(env, mockCtx(), order)).rejects.toThrow("not found");
  });
});

describe("resetPenalty", () => {
  it("用量清零、有效期 -30 天（含 base_expires_at 同步），恢复 active", async () => {
    const tokens = mockNs();
    const env = { TOKENS: tokens.ns } as unknown as Env;
    const base = Date.now() + 90 * 86_400_000;
    const token = makeToken({
      traffic_by_node: { "node-hk": 20 * 1024 ** 3 },
      expires_at: base - 30 * 86_400_000, // 已被预支扣掉 30 天
      base_expires_at: base,
      months_borrowed: 1,
      traffic_exhausted_at: Date.now(),
      rate_window_start: 1,
      rate_window_bytes: 2,
      notify_log: { traffic_80: 1, exhausted: 2, expiry_3d: 3 },
    });
    seedToken(tokens, token);

    await resetPenalty(env, token, 30);

    const saved = JSON.parse(tokens.store.get(KV.TOKEN + token.uuid)!) as Token;
    expect(saved.traffic_used_gb).toBe(0);
    expect(saved.traffic_offset_bytes).toBe(20 * 1024 ** 3);
    expect(saved.rate_window_start).toBeUndefined();
    expect(saved.traffic_exhausted_at).toBeUndefined();
    // expires_at 与 base_expires_at 同步 -30 天（处罚不被月度重算抹掉）
    expect(saved.expires_at).toBe(base - 60 * 86_400_000);
    expect(saved.base_expires_at).toBe(base - 30 * 86_400_000);
    expect(saved.status).toBe("active");
    expect(saved.notify_log?.traffic_80).toBeUndefined();
    expect(saved.notify_log?.expiry_3d).toBe(3);
  });

  it("撤销的 token 不恢复状态", async () => {
    const tokens = mockNs();
    const env = { TOKENS: tokens.ns } as unknown as Env;
    const token = makeToken({ status: "revoked", expires_at: Date.now() + 60 * 86_400_000 });
    seedToken(tokens, token);

    await resetPenalty(env, token, 30);

    const saved = JSON.parse(tokens.store.get(KV.TOKEN + token.uuid)!) as Token;
    expect(saved.status).toBe("revoked");
    expect(saved.traffic_used_gb).toBe(0);
  });
});
