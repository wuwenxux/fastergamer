import { describe, expect, it, vi } from "vitest";
import { DATA_PACK_PLAN_ID, KV, type Plan, type Token } from "../../../../shared/types";
import {
  consumeCredit,
  getCredit,
  getOrCreateRefCode,
  orderDiscount,
  rewardReferrerOnPayment,
  tryAutoRenewWithBalance,
  tryIssueRewardToken,
} from "../lib/referral";
import type { Env } from "../types";
import { mockNs } from "./helpers";

/** 内存版 TOKENS namespace */
const mockEnv = () => {
  const { ns, store } = mockNs();
  return { env: { TOKENS: ns } as unknown as Env, store, ns };
};

const seedCredit = (store: Map<string, string>, email: string, earned: number, used: number) => {
  store.set(KV.REFCREDIT + email, JSON.stringify({ earned, used }));
};

describe("orderDiscount（抵扣向下取整到 5 的倍数）", () => {
  it("12 元月付抵 10（零头不抵，避免按个数记账漏损）", () => {
    expect(orderDiscount(30, 12)).toBe(10);
  });

  it("7 元套餐抵 5（零头不足一个额度单位不抵）", () => {
    expect(orderDiscount(30, 7)).toBe(5);
  });

  it("25 元套餐余额 20 抵 20", () => {
    expect(orderDiscount(20, 25)).toBe(20);
  });

  it("余额不足时按余额抵", () => {
    expect(orderDiscount(10, 120)).toBe(10);
  });

  it("价格为 5 的倍数可全额抵", () => {
    expect(orderDiscount(30, 30)).toBe(30);
  });
});

describe("consumeCredit（check-and-set 收在函数内，防并发双花）", () => {
  it("足额：扣减成功并落库", async () => {
    const { env, store } = mockEnv();
    seedCredit(store, "a@example.com", 5, 0);
    await expect(consumeCredit(env, "a@example.com", 20)).resolves.toBe(true);
    expect(await getCredit(env, "a@example.com")).toEqual({ earned: 5, used: 4 });
  });

  it("不足额：返回 false 且不写库（可用额度不被透支）", async () => {
    const { env, store, ns } = mockEnv();
    seedCredit(store, "a@example.com", 1, 0);
    await expect(consumeCredit(env, "a@example.com", 20)).resolves.toBe(false);
    expect(await getCredit(env, "a@example.com")).toEqual({ earned: 1, used: 0 });
    expect(ns.put).not.toHaveBeenCalled();
  });

  it("无额度记录（从未获得推广余额）：扣减失败", async () => {
    const { env } = mockEnv();
    await expect(consumeCredit(env, "ghost@example.com", 10)).resolves.toBe(false);
    expect(await getCredit(env, "ghost@example.com")).toEqual({ earned: 0, used: 0 });
  });

  it("discountCny <= 0：幂等放行，不读不写", async () => {
    const { env, ns } = mockEnv();
    await expect(consumeCredit(env, "a@example.com", 0)).resolves.toBe(true);
    expect(ns.put).not.toHaveBeenCalled();
  });
});

describe("getOrCreateRefCode（refowner 反查键免全表扫）", () => {
  /** 带 list 断言的内存 ns（全表扫兜底路径要用） */
  const mockEnvWithList = () => {
    const { ns, store } = mockNs();
    return { env: { TOKENS: ns } as unknown as Env, store, ns };
  };

  it("反查键命中：1 次读直接返回，不 list 全表", async () => {
    const { env, ns } = mockEnvWithList();
    await ns.put(KV.REFOWNER + "a@example.com", JSON.stringify({ code: "abcd1234" }));
    await expect(getOrCreateRefCode(env, "a@example.com")).resolves.toBe("abcd1234");
    expect(ns.list).not.toHaveBeenCalled();
  });

  it("历史数据（只有 refcode 键）：全表扫命中并回写反查键自愈", async () => {
    const { env, store, ns } = mockEnvWithList();
    store.set(KV.REFCODE + "beef5678", JSON.stringify({ email: "old@example.com" }));
    await expect(getOrCreateRefCode(env, "old@example.com")).resolves.toBe("beef5678");
    expect(JSON.parse(store.get(KV.REFOWNER + "old@example.com")!)).toEqual({ code: "beef5678" });
    // 自愈后第二次走反查键，不再 list
    (ns.list as ReturnType<typeof vi.fn>).mockClear();
    await expect(getOrCreateRefCode(env, "old@example.com")).resolves.toBe("beef5678");
    expect(ns.list).not.toHaveBeenCalled();
  });

  it("全新邮箱：创建推广码并同时写 refcode/refowner 双键", async () => {
    const { env, store } = mockEnvWithList();
    const code = await getOrCreateRefCode(env, "new@example.com");
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.parse(store.get(KV.REFCODE + code)!)).toEqual({ email: "new@example.com" });
    expect(JSON.parse(store.get(KV.REFOWNER + "new@example.com")!)).toEqual({ code });
  });
});

describe("流量包（plan_pack_5g）不参与推广返利", () => {
  const PACK_PLAN: Plan = {
    id: DATA_PACK_PLAN_ID,
    name: "5G 流量包",
    duration_days: 90,
    price_cny: 8,
    traffic_limit_gb: 5,
    max_devices: 1,
    description: "",
  };
  const MONTHLY_PLAN: Plan = {
    id: "plan_monthly",
    name: "月付套餐",
    duration_days: 30,
    price_cny: 12,
    description: "",
  };
  const YEARLY_PLAN: Plan = {
    id: "plan_yearly",
    name: "连续包年",
    duration_days: 395,
    bonus_days: 30,
    price_cny: 120,
    description: "",
  };
  const PLANS = [PACK_PLAN, MONTHLY_PLAN, YEARLY_PLAN];

  /** 带 list/delete 的内存 TOKENS + 内存 PLANS（续期/发奖路径要扫 token 全表、读套餐表） */
  const mockEnvFull = () => {
    const store = new Map<string, string>();
    const ns = {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      delete: vi.fn(async (key: string) => void store.delete(key)),
      list: vi.fn(async (opts: { prefix?: string }) => ({
        keys: [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).map((name) => ({ name })),
        list_complete: true,
        cursor: "",
      })),
    } as unknown as KVNamespace;
    const plansNs = {
      get: vi.fn(async () => JSON.stringify(PLANS)),
    } as unknown as KVNamespace;
    return { env: { TOKENS: ns, PLANS: plansNs } as unknown as Env, store };
  };

  const seedActiveToken = (
    store: Map<string, string>,
    contact: string,
    planId: string,
    expiresInMs = 30 * 86_400_000
  ): Token => {
    const token = {
      id: `tk_${crypto.randomUUID().slice(0, 8)}`,
      uuid: crypto.randomUUID(),
      plan_id: planId,
      status: "active",
      contact,
      traffic_limit_gb: 5,
      traffic_used_gb: 0,
      purchased_at: Date.now(),
      expires_at: Date.now() + expiresInMs,
    } as Token;
    store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
    store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
    return token;
  };

  const seedReferral = (store: Map<string, string>, invitee: string, referrer: string) => {
    store.set(
      KV.REFERRAL + invitee,
      JSON.stringify({ referrer_email: referrer, created_at: Date.now(), rewarded: false })
    );
  };

  it("被邀请人购买流量包：不给邀请人记额度，归因标记保持待结算", async () => {
    const { env, store } = mockEnvFull();
    seedReferral(store, "invitee@example.com", "ref@example.com");
    const changed = await rewardReferrerOnPayment(env, "invitee@example.com", DATA_PACK_PLAN_ID);
    expect(changed).toBe(false);
    // 同系列其他档位（plan_pack_ 前缀）同样不结算
    expect(await rewardReferrerOnPayment(env, "invitee@example.com", "plan_pack_1g")).toBe(false);
    // 额度不增加
    expect(await getCredit(env, "ref@example.com")).toEqual({ earned: 0, used: 0 });
    // 标记不被消费：之后购买正常付费套餐仍可结算
    const marker = JSON.parse(store.get(KV.REFERRAL + "invitee@example.com")!);
    expect(marker.rewarded).toBe(false);
  });

  it("流量包之后的正常付费购买仍触发结算（标记未被流量包消费掉）", async () => {
    const { env, store } = mockEnvFull();
    seedReferral(store, "invitee@example.com", "ref@example.com");
    await rewardReferrerOnPayment(env, "invitee@example.com", DATA_PACK_PLAN_ID);
    const changed = await rewardReferrerOnPayment(env, "invitee@example.com", MONTHLY_PLAN.id);
    expect(changed).toBe(false); // 余额未满续费价，无授权变更
    expect(await getCredit(env, "ref@example.com")).toEqual({ earned: 1, used: 0 });
    const marker = JSON.parse(store.get(KV.REFERRAL + "invitee@example.com")!);
    expect(marker.rewarded).toBe(true);
  });

  it("邀请人只持有激活中的流量包：余额满额不自动续期流量包", async () => {
    const { env, store } = mockEnvFull();
    const pack = seedActiveToken(store, "ref@example.com", DATA_PACK_PLAN_ID);
    seedCredit(store, "ref@example.com", 24, 0); // 满 120 元
    const res = await tryAutoRenewWithBalance(env, "ref@example.com");
    expect(res.renewed).toBe(false);
    // token 未被延期，额度未被扣
    const saved = JSON.parse(store.get(KV.TOKEN + pack.uuid)!) as Token;
    expect(saved.expires_at).toBe(pack.expires_at);
    expect(await getCredit(env, "ref@example.com")).toEqual({ earned: 24, used: 0 });
  });

  it("对照：邀请人持有正常付费套餐时余额满额照常自动续期", async () => {
    const { env, store } = mockEnvFull();
    const monthly = seedActiveToken(store, "ref@example.com", MONTHLY_PLAN.id);
    seedCredit(store, "ref@example.com", 24, 0);
    const res = await tryAutoRenewWithBalance(env, "ref@example.com");
    expect(res.renewed).toBe(true);
    expect(res.tokenId).toBe(monthly.id);
    const saved = JSON.parse(store.get(KV.TOKEN + monthly.uuid)!) as Token;
    // 续一年（年付净时长 365 天，不含赠送月）
    expect(saved.expires_at!).toBe(monthly.expires_at! + 365 * 86_400_000);
    expect(await getCredit(env, "ref@example.com")).toEqual({ earned: 24, used: 24 });
  });

  it("邀请人只持有流量包：按「未开通付费套餐」处理，余额满额发奖励年付 token", async () => {
    const { env, store } = mockEnvFull();
    seedActiveToken(store, "ref@example.com", DATA_PACK_PLAN_ID);
    seedCredit(store, "ref@example.com", 24, 0);
    const res = await tryIssueRewardToken(env, "ref@example.com");
    expect(res.issued).toBe(true);
    expect(res.tokenId).toBeDefined();
    expect(await getCredit(env, "ref@example.com")).toEqual({ earned: 24, used: 24 });
  });
});
