/**
 * 激活 paid 状态的 token 并开始计时。
 * 两个入口共用同一逻辑：用户在管理页手动激活（/api/tokens/:id/activate）、
 * Clash 首次拉取订阅时自动激活（/api/sub，导入即激活）。
 */
import type { Token } from "../../../../shared/types";
import { getPlans, saveToken } from "./kv";
import { currentMonthKey } from "./nodes";
import type { Env } from "../types";

export const activatePaidToken = async (env: Env, token: Token): Promise<Token> => {
  const plans = await getPlans(env);
  const plan = plans.find((p) => p.id === token.plan_id);
  const durationDays = plan?.duration_days ?? 30;

  const now = Date.now();
  const activated: Token = {
    ...token,
    status: "active",
    activated_at: now,
    expires_at: now + durationDays * 86_400_000,
  };
  // 月度配额制初始化：记录原始到期时间作为预支扣减基准
  if (plan?.monthly_quota_gb) {
    activated.base_expires_at = activated.expires_at;
    activated.months_borrowed = 0;
    activated.month_used_bytes = 0;
    activated.month_key = currentMonthKey();
  }
  await saveToken(env, activated);
  return activated;
};
