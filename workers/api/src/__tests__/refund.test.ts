import { describe, expect, it } from "vitest";
import type { Plan } from "../../../../shared/types";
import { computeRefundQuote } from "../lib/refund";

const DAY = 86_400_000;
const NOW = Date.now();

const yearly: Plan = {
  id: "plan_yearly",
  name: "年付套餐",
  duration_days: 395,
  bonus_days: 30,
  price_cny: 120,
  description: "",
};
const monthly: Plan = {
  id: "plan_monthly",
  name: "月付套餐",
  duration_days: 30,
  price_cny: 12,
  description: "",
};

describe("computeRefundQuote", () => {
  it("年付用 1 个月：按 12 个付费月折算，手续费按实付总额 1% 扣，赠送月不参与", () => {
    const q = computeRefundQuote(yearly, 120, NOW - 29 * DAY, NOW);
    expect(q.totalMonths).toBe(12);
    expect(q.monthsUsed).toBe(1);
    // 折算 120 × 11/12 = 110，手续费按总额 120 × 1% = 1.20 → 108.80
    expect(q.fee).toBe(1.2);
    expect(q.amount).toBe(108.8);
  });

  it("年付用满 12 个付费月（进入赠送期）：无可退余额", () => {
    const q = computeRefundQuote(yearly, 120, NOW - 370 * DAY, NOW);
    expect(q.monthsUsed).toBe(13);
    expect(q.amount).toBe(0);
  });

  it("月付按剩余天数折算：用 10 天退 20 天，手续费按总额扣", () => {
    const q = computeRefundQuote(monthly, 12, NOW - 10 * DAY, NOW);
    expect(q.basis).toBe("days");
    expect(q.daysRemaining).toBe(20);
    // 折算 12 × 20/30 = 8，手续费按总额 12 × 1% = 0.12 → 7.88
    expect(q.fee).toBe(0.12);
    expect(q.amount).toBe(7.88);
  });

  it("月付到期后无可退余额", () => {
    expect(computeRefundQuote(monthly, 12, NOW - 30 * DAY, NOW).amount).toBe(0);
  });

  it("刚支付（0 天）的年付扣当月：退 11 个月扣手续费", () => {
    const q = computeRefundQuote(yearly, 120, NOW, NOW);
    expect(q.monthsUsed).toBe(1);
    expect(q.amount).toBe(108.8);
  });

  it("无赠送月的套餐按实际月数折算（季付 3 个月用 1 退 2，手续费按总额扣）", () => {
    const quarterly: Plan = { id: "q", name: "季付", duration_days: 90, price_cny: 30, description: "" };
    const q = computeRefundQuote(quarterly, 30, NOW - 10 * DAY, NOW);
    expect(q.totalMonths).toBe(3);
    // 折算 30 × 2/3 = 20，手续费按总额 30 × 1% = 0.30 → 19.70
    expect(q.fee).toBe(0.3);
    expect(q.amount).toBe(19.7);
  });

  it("套餐缺失时按 30 天单月兜底（按天折算）", () => {
    const q = computeRefundQuote(undefined, 12, NOW - DAY, NOW);
    expect(q.basis).toBe("days");
    expect(q.daysRemaining).toBe(29);
  });
});
