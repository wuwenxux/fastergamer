import { describe, expect, it, vi } from "vitest";
import { KV, type Order, type Plan, type Token } from "../../../../shared/types";
import { fulfillOrder, type WaitUntilCtx } from "../lib/issue-token";
import { activatePaidToken } from "../lib/activate";
import type { Env } from "../types";

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
  { id: "plan_3days", name: "3 天免费体验", duration_days: 3, price_cny: 0, description: "", traffic_limit_gb: 20, max_devices: 1 },
  { id: "plan_yearly", name: "年付套餐", duration_days: 395, price_cny: 120, description: "", traffic_limit_gb: 260, max_devices: 3, monthly_quota_gb: 20 },
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

const mockCtx = (): WaitUntilCtx => ({ waitUntil: (p) => void Promise.resolve(p).catch(() => {}) });

const makeTrial = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_trial",
  uuid: "uuid-trial",
  plan_id: "plan_3days",
  status: "active",
  contact: "user@example.com",
  traffic_limit_gb: 20,
  traffic_used_gb: 5,
  purchased_at: Date.now() - 86_400_000,
  activated_at: Date.now() - 86_400_000,
  expires_at: Date.now() + 2 * 86_400_000, // 还剩 2 天
  ...overrides,
});

const makeOrder = (overrides: Partial<Order> = {}): Order => ({
  id: "ord_merge",
  plan_id: "plan_yearly",
  contact: "user@example.com",
  amount_cny: 120,
  status: "pending",
  created_at: Date.now(),
  ...overrides,
} as Order);

const seedToken = (tokens: ReturnType<typeof mockNs>, token: Token) => {
  tokens.store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  tokens.store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

describe("试用转正合并（同邮箱下单并入体验剩余额度）", () => {
  it("剩余时长 + 赠送 30 天记 bonus_ms，流量不并入，体验 token 吊销", async () => {
    const { env, tokens } = mockEnv();
    seedToken(tokens, makeTrial());

    const res = await fulfillOrder(env, mockCtx(), makeOrder());
    const token = res.token!;
    // 流量不并入：仍是年付 260 GB
    expect(token.traffic_limit_gb).toBe(260);
    // 剩余 2 天 + 赠送 30 天 ≈ 32 天（容忍执行误差 5 秒）
    expect(token.bonus_ms).toBeGreaterThan(32 * 86_400_000 - 5000);
    expect(token.bonus_ms).toBeLessThanOrEqual(32 * 86_400_000);

    const trial = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-trial")!) as Token;
    expect(trial.status).toBe("revoked");
  });

  it("bonus_ms 在激活时并入有效期（含 30 天赠送）", async () => {
    const { env, tokens } = mockEnv();
    seedToken(tokens, makeTrial());
    const res = await fulfillOrder(env, mockCtx(), makeOrder());

    const before = Date.now();
    const activated = await activatePaidToken(env, res.token!);
    const expectedMin = before + 395 * 86_400_000 + 32 * 86_400_000 - 5000;
    expect(activated.expires_at!).toBeGreaterThanOrEqual(expectedMin);
    expect(activated.expires_at!).toBeLessThanOrEqual(before + 427 * 86_400_000 + 5000);
  });

  it("体验已过期/已耗尽时不合并剩余额度，但仍享 30 天转正赠送", async () => {
    const { env, tokens } = mockEnv();
    seedToken(tokens, makeTrial({ expires_at: Date.now() - 1000 })); // 已过期
    seedToken(tokens, makeTrial({ id: "tk_t2", uuid: "uuid-t2", traffic_used_gb: 20, expires_at: Date.now() + 86_400_000 })); // 流量耗尽

    const res = await fulfillOrder(env, mockCtx(), makeOrder());
    expect(res.token!.traffic_limit_gb).toBe(260); // 耗尽的不加流量（剩 0）
    // 剩余约 1 天 + 赠送 30 天 ≈ 31 天（执行耗时产生毫秒级损耗，容忍 5 秒误差）
    expect(res.token!.bonus_ms).toBeGreaterThan(31 * 86_400_000 - 5000);
    expect(res.token!.bonus_ms).toBeLessThanOrEqual(31 * 86_400_000);
  });

  it("不同邮箱的体验 token 不受影响", async () => {
    const { env, tokens } = mockEnv();
    seedToken(tokens, makeTrial({ contact: "other@example.com" }));

    const res = await fulfillOrder(env, mockCtx(), makeOrder());
    expect(res.token!.traffic_limit_gb).toBe(260);
    expect(res.token!.bonus_ms).toBeUndefined();
    const trial = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-trial")!) as Token;
    expect(trial.status).toBe("active");
  });
});

describe("试用转正激励锚定邮箱标记（token 可失效，邮箱永是续用凭证）", () => {
  const seedMarker = (tokens: ReturnType<typeof mockNs>, email: string, converted = false) => {
    tokens.store.set(
      KV.TRIAL + email,
      JSON.stringify({ token_id: "tk_trial", created_at: 1, ...(converted ? { converted_at: 2 } : {}) })
    );
  };

  it("试用 token 已清理/从未激活（只有标记）：照样送 30 天，并消费标记", async () => {
    const { env, tokens } = mockEnv();
    seedMarker(tokens, "user@example.com");

    const res = await fulfillOrder(env, mockCtx(), makeOrder());
    // 无额度可并，只送 30 天
    expect(res.token!.traffic_limit_gb).toBe(260);
    expect(res.token!.bonus_ms).toBe(30 * 86_400_000);

    const marker = JSON.parse(tokens.store.get(KV.TRIAL + "user@example.com")!);
    expect(marker.converted_at).toBeGreaterThan(0);
  });

  it("标记已消费（此前已转正过）：不再重复赠送", async () => {
    const { env, tokens } = mockEnv();
    seedMarker(tokens, "user@example.com", true);

    const res = await fulfillOrder(env, mockCtx(), makeOrder());
    expect(res.token!.bonus_ms).toBeUndefined();
  });

  it("激活中的试用合并 + 赠送后消费标记：再次购买不再赠送", async () => {
    const { env, tokens } = mockEnv();
    seedToken(tokens, makeTrial());
    seedMarker(tokens, "user@example.com");

    const res = await fulfillOrder(env, mockCtx(), makeOrder());
    expect(res.token!.bonus_ms).toBeGreaterThan(30 * 86_400_000); // 合并剩余 + 30 天
    const marker = JSON.parse(tokens.store.get(KV.TRIAL + "user@example.com")!);
    expect(marker.converted_at).toBeGreaterThan(0);

    // 第二次购买（试用 token 已被吊销、标记已消费）：无赠送
    const res2 = await fulfillOrder(env, mockCtx(), makeOrder({ id: "ord_2" }));
    expect(res2.token!.bonus_ms).toBeUndefined();
    expect(res2.token!.traffic_limit_gb).toBe(260);
  });
});
