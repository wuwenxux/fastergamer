import { Hono } from "hono";
import { isDataPackPlan } from "../../../../../shared/types";
import { getOrder, getPlans, getTokenById, saveOrder, saveToken } from "../../lib/kv";
import { sendMail, shouldSendEmail } from "../../lib/email-aliyun";
import { getEpayConfig, refundEpayOrder } from "../../lib/epay";
import { computeRefundQuote } from "../../lib/refund";
import { pushAuthRefresh } from "../../lib/authpush";
import type { Env } from "../../types";

export const adminRefundRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/admin/orders/:id/refund —— 订单退款（售后）
 * 默认折算（lib/refund.ts）：月付按剩余天数退；季付/年付扣当月退剩余整月，
 * 促销赠送月不参与折算，消耗进入赠送期则无可退余额。
 * body 可传 { money } 覆盖为指定金额（不超过实付）。
 * 调易支付退款接口原路退回，成功后撤销对应 token。
 * 需在商户后台开启「订单退款API接口开关」；已退过的订单幂等拒绝。
 */
adminRefundRoutes.post("/orders/:id/refund", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  if (order.refunded_at) {
    return c.json({ ok: false, error: "该订单已退款" }, 409);
  }
  if (order.status !== "paid") {
    return c.json({ ok: false, error: "只有已支付订单可退款" }, 400);
  }

  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === order.plan_id);
  // 流量包售出不退（购买页已明示「虚拟商品售出不退」），在折算前直接拒绝
  if (plan && isDataPackPlan(plan.id)) {
    return c.json({ ok: false, error: "流量包售出不退" }, 400);
  }
  const paid = order.payable_cny ?? plan?.price_cny ?? 0;
  if (paid <= 0) {
    return c.json({ ok: false, error: "0 元订单无需退款，直接撤销 token 即可" }, 400);
  }

  // 默认折算：月付按剩余天数退，季付/年付扣当月、赠送月不参与；body.money 可人工覆盖
  const body = (await c.req.json().catch(() => null)) as { money?: number } | null;
  const quote = computeRefundQuote(plan, paid, order.paid_at ?? order.created_at);
  const amount =
    body?.money !== undefined && Number.isFinite(body.money)
      ? Math.min(Math.max(body.money, 0), paid)
      : quote.amount;
  if (amount <= 0) {
    const detail =
      quote.basis === "days"
        ? `剩余可退 ${quote.daysRemaining} 天`
        : `已用 ${quote.monthsUsed}/${quote.totalMonths} 个付费月`;
    return c.json(
      { ok: false, error: `扣除已消耗费用后无可退余额（${detail}）；如需特殊处理请传 body.money 指定金额` },
      400
    );
  }
  const money = amount.toFixed(2);

  const epay = getEpayConfig(c.env);
  if (!epay) {
    return c.json({ ok: false, error: "易支付未配置" }, 503);
  }

  let refundNo: string | undefined;
  try {
    const r = await refundEpayOrder(epay, {
      tradeNo: order.trade_no,
      outTradeNo: order.id,
      money,
      outRefundNo: order.id, // 防重复退款
    });
    refundNo = r.refundNo;
  } catch (e) {
    console.error(`[refund] order ${order.id}: ${(e as Error).message}`);
    return c.json({ ok: false, error: "退款失败，请查看日志或稍后再试" }, 502);
  }

  order.refunded_at = Date.now();
  order.refund_no = refundNo;
  await saveOrder(c.env, order);

  // 撤销该订单发放的 token（含升级订单的原 token）
  if (order.token_id) {
    const token = await getTokenById(c.env, order.token_id);
    if (token && token.status !== "revoked") {
      token.status = "revoked";
      await saveToken(c.env, token);
    }
  }
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 撤销立即从各节点白名单摘除

  if (shouldSendEmail(order.contact)) {
    // 人工覆盖金额时不带折算明细（quote 的手续费只适用于默认折算）
    const breakdown =
      body?.money !== undefined
        ? `实付 ${paid.toFixed(2)} 元`
        : `实付 ${paid.toFixed(2)} 元，扣除已消耗费用与 1% 退款手续费（按实付总额计，${quote.fee.toFixed(2)} 元）后折算`;
    const res = await sendMail(
      c.env,
      order.contact,
      "【GameBoost】订单退款成功",
      `<p>你好，订单 <strong>${order.id}</strong> 已退款 <strong>${money} 元</strong>（${breakdown}），原路退回支付账户。</p>
       <p>对应服务已停用。如有疑问请回复本邮件联系售后。</p>`,
      `订单 ${order.id} 已退款 ${money} 元（${breakdown}），原路退回。对应服务已停用。`
    );
    if (!res.ok) console.error(`[refund] mail failed ${order.id}: ${res.error}`);
  }

  return c.json({ ok: true, data: { order_id: order.id, refund_no: refundNo, money, paid: paid.toFixed(2), quote } });
});
