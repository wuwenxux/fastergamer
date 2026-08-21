import { Hono } from "hono";
import type { CreateOrderRequest, CreateOrderResponse, Order } from "../../../../shared/types";
import { isEmail } from "../lib/email-aliyun";
import { getPlans, saveOrder } from "../lib/kv";
import { newOrderId, newPaymentRef } from "../lib/ids";
import type { Env } from "../types";

export const ordersRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/orders —— 创建购买订单
 *
 * 个人收款码过渡模式：订单创建后为 pending，页面展示收款码，
 * 管理员确认到账后通过 POST /api/admin/orders/:id/confirm 发放 token。
 * 将来接入真实支付网关时，confirm 逻辑由网关回调触发即可。
 */
ordersRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as CreateOrderRequest | null;
  if (!body?.plan_id) {
    return c.json({ ok: false, error: "plan_id is required" }, 400);
  }
  if (!body.contact?.trim()) {
    return c.json({ ok: false, error: "contact is required for token recovery" }, 400);
  }
  // 售后与 token 发放都走邮件，联系方式必须是有效邮箱
  if (!isEmail(body.contact)) {
    return c.json({ ok: false, error: "contact must be a valid email address" }, 400);
  }

  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === body.plan_id);
  if (!plan) {
    return c.json({ ok: false, error: `plan '${body.plan_id}' not found` }, 404);
  }

  const order: Order = {
    id: newOrderId(),
    plan_id: plan.id,
    payment_ref: newPaymentRef(),
    status: "pending",
    contact: body.contact.trim(),
    created_at: Date.now(),
  };
  await saveOrder(c.env, order);

  const res: CreateOrderResponse = { order, paid: false };
  return c.json({ ok: true, data: res }, 201);
});
