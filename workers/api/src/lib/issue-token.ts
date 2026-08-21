/**
 * 确认收款后发放 token（个人收款码过渡期间由管理员手动触发，
 * 将来接真实支付网关时在回调里调用同一个函数）
 */
import type { Order, Plan, Token } from "../../../../shared/types";
import { sendTokenEmail, shouldSendEmail } from "./email-aliyun";
import { saveToken } from "./kv";
import { newTokenId } from "./ids";
import type { Env } from "../types";

export const issueTokenForOrder = async (
  env: Env,
  ctx: ExecutionContext,
  order: Order,
  plan: Plan
): Promise<Token> => {
  const token: Token = {
    id: newTokenId(),
    uuid: crypto.randomUUID(),
    plan_id: plan.id,
    status: "paid", // 已购买、待激活；用户点击「激活」后才开始计时
    contact: order.contact,
    traffic_limit_gb: plan.traffic_limit_gb ?? 0,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
  };
  await saveToken(env, token);

  // 如果联系方式是邮箱，自动发送凭证邮件
  if (shouldSendEmail(order.contact)) {
    ctx.waitUntil(
      sendTokenEmail(env, {
        tokenId: token.id,
        uuid: token.uuid,
        planName: plan.name,
        status: token.status,
        contact: order.contact!,
      })
    );
  }

  return token;
};
