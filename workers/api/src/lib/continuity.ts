/**
 * 连续付费资格（连续包月 plan_monthly_sub / 连续包年 plan_yearly）
 * 与年付套餐（plan_yearly_std）连续续费奖励的统一实现。
 *
 * 资格规则（连续价套餐，CONTINUITY_RULES）：
 * - 按订单 contact（联系方式字符串）判定，与试用转正激励同口径（锚定联系方式而非 token）；
 * - 首购（无记录）直接放行；有记录则要求上次该套餐订单「支付成功」时间在窗口内
 *   （套餐周期 + 断缴宽限），否则拒绝并引导回对应的常价套餐；
 * - 记录以支付成功（fulfillOrder 发货）时间为准，不依赖激活时间——避免「paid 未激活」
 *   的边缘情况导致连续性被误判断档；
 * - 断缴超宽限期即失去资格（marker 只由本套餐支付成功写入，回常价套餐不会刷新）。
 *
 * 平滑迁移：资格规则上线前的存量 plan_yearly 用户没有 subyear marker，
 * 首次续费按首购放行（有意为之），续费成功后才进入连续性约束。
 *
 * 年付套餐（plan_yearly_std，¥120）不是连续价套餐——随时可买无门槛，
 * 其 marker（KV.YRSTD）只决定续费是否送 1 个月奖励（settleYearlyStdRenewal）。
 *
 * 存储：{submon|subyear|yrstd}:{contact} → { last_paid_at }（TOKENS namespace）。
 * 读写频率低（下单读一次、发货写一次），不设 TTL——资格判定需要完整历史。
 */
import { KV, MONTHLY_SUB_PLAN_ID, YEARLY_PLAN_ID, YEARLY_STD_PLAN_ID } from "../../../../shared/types";
import { saveToken } from "./kv";
import type { Token } from "../../../../shared/types";
import type { Env } from "../types";

/** 连续包月连续性窗口：30 天套餐周期 + 7 天断缴宽限 */
export const MONTHLY_SUB_WINDOW_MS = 37 * 86_400_000;
/** 连续包年连续性窗口：365 天套餐周期 + 30 天断缴宽限（年付宽限比月付长，用户明确） */
export const YEARLY_SUB_WINDOW_MS = 395 * 86_400_000;
/** 年付套餐连续续费奖励窗口：与连续包年资格窗口同口径（365 + 30） */
export const YEARLY_STD_RENEW_WINDOW_MS = 395 * 86_400_000;
/** 年付套餐连续续费奖励时长：送 1 个月 */
export const YEARLY_STD_RENEW_BONUS_MS = 30 * 86_400_000;

/** 连续价套餐规则（逐套餐显式列出，拒绝做成隐式配置） */
export interface ContinuityRule {
  planId: string;
  /** marker 键前缀（KV 常量） */
  kvPrefix: string;
  /** 连续性窗口（套餐周期 + 断缴宽限） */
  windowMs: number;
  /** 展示名（contact 缺失时的专属报错用） */
  label: string;
  /** 断缴拒绝文案（引导回常价套餐） */
  rejectHint: string;
}

export const CONTINUITY_RULES: readonly ContinuityRule[] = [
  {
    planId: MONTHLY_SUB_PLAN_ID,
    kvPrefix: KV.SUBMON,
    windowMs: MONTHLY_SUB_WINDOW_MS,
    label: "连续包月",
    rejectHint: "连续包月需在到期后 7 天内续费，你已断缴超过宽限期，请改购月付套餐（¥12/月）",
  },
  {
    planId: YEARLY_PLAN_ID,
    kvPrefix: KV.SUBYEAR,
    windowMs: YEARLY_SUB_WINDOW_MS,
    label: "连续包年",
    rejectHint: "连续包年需在到期后 30 天内续费，你已断缴超过宽限期，请改购年付套餐（¥120/年）",
  },
];

export const continuityRuleFor = (planId: string): ContinuityRule | undefined =>
  CONTINUITY_RULES.find((r) => r.planId === planId);

/** 无联系方式的拒绝文案：资格按 contact 判定，连续价套餐下单必须留 */
export const continuityContactError = (rule: ContinuityRule): string =>
  `${rule.label}需留联系方式以校验续费资格`;

/**
 * 资格校验：返回 null 放行，否则返回拒绝文案（下单 / 升级入口共用）。
 * 非连续价套餐直接放行（返回 null）。contact 需由调用方先归一化（trim + lowercase）。
 */
export const checkContinuityEligibility = async (
  env: Env,
  planId: string,
  contact: string,
  now: number
): Promise<string | null> => {
  const rule = continuityRuleFor(planId);
  if (!rule) return null;
  const raw = await env.TOKENS.get(rule.kvPrefix + contact);
  if (!raw) return null; // 首购放行（含存量用户平滑迁移）
  let lastPaidAt = 0;
  try {
    lastPaidAt = (JSON.parse(raw) as { last_paid_at?: number }).last_paid_at ?? 0;
  } catch {
    /* 记录损坏视为无记录，按首购放行 */
  }
  if (lastPaidAt > 0 && now - lastPaidAt <= rule.windowMs) return null;
  return rule.rejectHint;
};

/**
 * 支付成功发货时刷新连续性记录（新购发货与升级/试用转正发货两条路径都调）。
 * 非连续价套餐静默跳过。contact 需已归一化。
 */
export const recordContinuityPaid = async (
  env: Env,
  planId: string,
  contact: string,
  now: number
): Promise<void> => {
  const rule = continuityRuleFor(planId);
  if (!rule) return;
  await env.TOKENS.put(rule.kvPrefix + contact, JSON.stringify({ last_paid_at: now }));
};

/**
 * 年付套餐（plan_yearly_std）连续续费奖励结算（发货时调用）：
 * 上次 ¥120 支付在窗口内 → 本次发货 +30 天；否则不送。无论是否命中都刷新 yrstd marker。
 * mode：
 * - "deferred"（新购 token，激活才开始计时）：奖励记 token.bonus_ms，
 *   激活时并入 expires_at（与试用转正剩余时长合并同一机制）；
 * - "immediate"（升级既有 token，有效期立即重算）：直接加 expires_at，
 *   月度配额套餐的 base_expires_at 同步加（预支扣减基准随实际到期走）。
 * 判定必须先于 marker 刷新（读的是「上次」支付时间）。
 * 注意：套餐 duration_days 恒为 365，退款折算按 365 计——续费奖励的 30 天不参与退款折算
 * （多退不补，口径差异可接受，README 已注明）。
 */
export const settleYearlyStdRenewal = async (
  env: Env,
  contact: string,
  token: Token,
  mode: "deferred" | "immediate",
  now: number
): Promise<void> => {
  let lastPaidAt = 0;
  const raw = await env.TOKENS.get(KV.YRSTD + contact);
  if (raw) {
    try {
      lastPaidAt = (JSON.parse(raw) as { last_paid_at?: number }).last_paid_at ?? 0;
    } catch {
      /* 记录损坏视为首购，不送奖励 */
    }
  }
  if (lastPaidAt > 0 && now - lastPaidAt <= YEARLY_STD_RENEW_WINDOW_MS) {
    if (mode === "deferred") {
      token.bonus_ms = (token.bonus_ms ?? 0) + YEARLY_STD_RENEW_BONUS_MS;
    } else {
      token.expires_at = (token.expires_at ?? now) + YEARLY_STD_RENEW_BONUS_MS;
      if (token.base_expires_at) token.base_expires_at += YEARLY_STD_RENEW_BONUS_MS;
    }
    await saveToken(env, token);
  }
  await env.TOKENS.put(KV.YRSTD + contact, JSON.stringify({ last_paid_at: now }));
};
