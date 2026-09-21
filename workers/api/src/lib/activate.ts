/**
 * 激活 paid 状态的 token 并开始计时。
 * 两个入口共用同一逻辑：用户在管理页手动激活（/api/tokens/:id/activate）、
 * Clash 首次拉取订阅时自动激活（/api/sub，导入即激活）。
 */
import type { Token } from "../../../../shared/types";
import { getPlans, hasPlanBonus, markPlanBonusGranted, saveToken } from "./kv";
import { currentMonthKey } from "./nodes";
import type { Env } from "../types";

export const activatePaidToken = async (env: Env, token: Token): Promise<Token> => {
  const plans = await getPlans(env);
  const plan = plans.find((p) => p.id === token.plan_id);
  let durationDays = plan?.duration_days ?? 30;
  // 赠送时长（如年付买 12 送 1）每邮箱每套餐限首购一次：续费激活扣掉赠送天数。
  // 锚定邮箱永久标记——token 会被清理、订单可能重买，邮箱是续用凭证
  if (plan?.bonus_days && token.contact) {
    if (await hasPlanBonus(env, token.contact, plan.id)) {
      durationDays -= plan.bonus_days;
    } else {
      await markPlanBonusGranted(env, token.contact, plan.id);
    }
  }

  const now = Date.now();
  const activated: Token = {
    ...token,
    status: "active",
    activated_at: now,
    // bonus_ms：体验转正并入的剩余时长，激活这一刻才生效
    expires_at: now + durationDays * 86_400_000 + (token.bonus_ms ?? 0),
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
