import { describe, expect, it } from "vitest";
import { orderDiscount } from "../lib/referral";

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
