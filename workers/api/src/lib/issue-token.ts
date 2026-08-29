/**
 * 确认收款后发放 token（个人收款码过渡期间由管理员手动触发，
 * 接入支付宝当面付后由回调触发；两者共用 fulfillOrder）
 */
import type { Order, Plan, Token } from "../../../../shared/types";
import { sendTokenEmail, shouldSendEmail } from "./email-aliyun";
import { createMagicTicket } from "./accounts";
import { getPlans, getTokenById, saveOrder, saveToken } from "./kv";
import { newTokenId } from "./ids";
import { rewardReferrerOnPayment } from "./referral";
import { pushAuthRefresh } from "./authpush";
import type { Env } from "../types";

/** 只需要 waitUntil，用最小结构类型兼容 Hono 与 workers-types 的 ExecutionContext 差异 */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export const issueTokenForOrder = async (
  env: Env,
  ctx: WaitUntilCtx,
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

  // 如果联系方式是邮箱，自动发送凭证邮件（附带一次性免登录管理链接，免去手动登录）
  if (shouldSendEmail(order.contact)) {
    ctx.waitUntil(
      (async () => {
        const site = (env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
        const ticket = await createMagicTicket(env, order.contact!, token.id);
        await sendTokenEmail(env, {
          tokenId: token.id,
          uuid: token.uuid,
          planName: plan.name,
          status: token.status,
          contact: order.contact!,
          magicUrl: `${site}/auth/magic?ticket=${ticket}`,
        });
      })()
    );
  }

  return token;
};

/**
 * 订单发货：确认收款后置 paid 并发放 token（幂等——已 paid 直接返回已有 token）。
 * 管理后台手动确认与支付宝回调共用此入口；plan 缺失时抛错，由调用方兜底。
 */
export const fulfillOrder = async (
  env: Env,
  ctx: WaitUntilCtx,
  order: Order
): Promise<{ token: Token | null; already: boolean }> => {
  if (order.status === "paid") {
    const token = order.token_id ? await getTokenById(env, order.token_id) : null;
    return { token, already: true };
  }

  const plans = await getPlans(env);
  const plan = plans.find((p) => p.id === order.plan_id);
  if (!plan) throw new Error(`plan '${order.plan_id}' not found`);

  const token = await issueTokenForOrder(env, ctx, order, plan);
  order.status = "paid";
  order.token_id = token.id;
  order.paid_at = Date.now();
  await saveOrder(env, order);

  // 推广结算：被邀请人首次付费成功，给邀请人结算余额（可能触发自动续期）。
  // 续期可能复活已过期 token → 授权名单有变，结算完成后补一次推送（不能与本路径其他推送
  // 并行，否则快照重建可能赶在续期写库之前，漏掉复活）
  if (order.contact) {
    ctx.waitUntil(
      rewardReferrerOnPayment(env, order.contact.trim().toLowerCase()).then((authChanged) =>
        authChanged ? pushAuthRefresh(env) : undefined
      )
    );
  }

  return { token, already: false };
};
