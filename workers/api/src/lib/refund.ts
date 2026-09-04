/**
 * 退款折算（售后默认规则，管理端 body.money 可覆盖）：
 * - 月付（付费时长 ≤31 天）：按剩余天数折算 —— 退款 = 实付 × 剩余天数 / 总天数
 * - 季付/年付：按剩余整月折算，已开始的当月视为已消耗；
 *   促销赠送天数（plan.bonus_days，如买 12 送 1 的 30 天）不参与折算，
 *   消耗进入赠送期后可退月数为 0——防止用赠送月套利
 * - 以上默认折算再扣除 1% 退款手续费（客户承担，按订单实付总额计，
 *   不是按折算余额计）；管理端 body.money 人工覆盖时为精确金额，不再扣手续费
 */
import type { Plan } from "../../../../shared/types";

const DAY_MS = 86_400_000;
/** 退款手续费率（客户承担） */
const FEE_RATE = 0.01;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface RefundQuote {
  /** 应退金额（元，两位小数，已扣手续费） */
  amount: number;
  /** 折算口径：days = 按剩余天数（月付），months = 按剩余整月（季付/年付） */
  basis: "days" | "months";
  /** 已消耗月数（含当月，仅 months 口径） */
  monthsUsed?: number;
  /** 参与折算的总月数（不含赠送月，仅 months 口径） */
  totalMonths?: number;
  /** 剩余可退天数（仅 days 口径） */
  daysRemaining?: number;
  /** 扣除的退款手续费（元，实付总额的 1%） */
  fee: number;
  /** 订单实付金额（元） */
  paid: number;
}

export const computeRefundQuote = (
  plan: Plan | undefined,
  paid: number,
  paidAt: number,
  now = Date.now()
): RefundQuote => {
  const durationDays = plan?.duration_days ?? 30;
  const paidDays = durationDays - (plan?.bonus_days ?? 0);

  // 手续费按实付总额计（客户承担），与折算口径无关
  const fee = round2(paid * FEE_RATE);

  // 月付按天折算：剩余几天退几天
  if (paidDays <= 31) {
    const elapsedDays = Math.max(0, Math.floor((now - paidAt) / DAY_MS));
    const daysRemaining = Math.max(0, durationDays - elapsedDays);
    const gross = round2((paid * daysRemaining) / durationDays);
    return { amount: Math.max(0, round2(gross - fee)), basis: "days", daysRemaining, fee, paid };
  }

  // 季付/年付按月折算：当月视为已消耗，赠送月不参与
  const totalMonths = Math.max(1, Math.round(paidDays / 30));
  const monthsUsed = Math.max(0, Math.floor((now - paidAt) / (30 * DAY_MS))) + 1;
  const refundableMonths = Math.max(0, totalMonths - monthsUsed);
  const gross = round2((paid * refundableMonths) / totalMonths);
  return { amount: Math.max(0, round2(gross - fee)), basis: "months", monthsUsed, totalMonths, fee, paid };
};
