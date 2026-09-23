import { describe, expect, it, vi } from "vitest";
import { KV } from "../../../../shared/types";
import { consumeCredit, getCredit, orderDiscount } from "../lib/referral";
import type { Env } from "../types";

/** 内存版 TOKENS namespace（Map 实现 get/put） */
const mockEnv = () => {
  const store = new Map<string, string>();
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
  } as unknown as KVNamespace;
  return { env: { TOKENS: ns } as unknown as Env, store, ns };
};

const seedCredit = (store: Map<string, string>, email: string, earned: number, used: number) => {
  store.set(KV.REFCREDIT + email, JSON.stringify({ earned, used }));
};

describe("orderDiscount（抵扣向下取整到 10 的倍数）", () => {
  it("12 元月付抵 10（零头不抵，避免按个数记账漏损）", () => {
    expect(orderDiscount(30, 12)).toBe(10);
  });

  it("7 元套餐抵 0（不足一个额度单位）", () => {
    expect(orderDiscount(30, 7)).toBe(0);
  });

  it("25 元套餐余额 20 抵 20", () => {
    expect(orderDiscount(20, 25)).toBe(20);
  });

  it("余额不足时按余额抵", () => {
    expect(orderDiscount(10, 120)).toBe(10);
  });

  it("价格为 10 的倍数可全额抵", () => {
    expect(orderDiscount(30, 30)).toBe(30);
  });
});

describe("consumeCredit（check-and-set 收在函数内，防并发双花）", () => {
  it("足额：扣减成功并落库", async () => {
    const { env, store } = mockEnv();
    seedCredit(store, "a@example.com", 3, 0);
    await expect(consumeCredit(env, "a@example.com", 20)).resolves.toBe(true);
    expect(await getCredit(env, "a@example.com")).toEqual({ earned: 3, used: 2 });
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
