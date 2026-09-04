import { Hono } from "hono";
import type { CreateOrderRequest, CreateOrderResponse, Order } from "../../../../shared/types";
import { getSessionAccount } from "../lib/accounts";
import { isDisposableEmail } from "../lib/disposable-email";
import { isEmail } from "../lib/email-aliyun";
import { getOrder, getPlans, saveOrder } from "../lib/kv";
import { newOrderId } from "../lib/ids";
import { fulfillOrder } from "../lib/issue-token";
import { availableDiscount, consumeCredit, orderDiscount, recordReferral } from "../lib/referral";
import type { Env } from "../types";

export const ordersRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/orders —— 创建购买订单
 *
 * 交易状态机保留：订单照常落 pending，前端轮询 GET /:id 查状态，管理端可取消。
 * 支付通道（易支付）已摘除：不再生成支付二维码，pending 订单暂无支付途径，
 * 待接入新通道时在 saveOrder 前补上支付凭证生成即可。
 * 推广抵扣后实付 0 元的订单仍直接发放 token。
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
  // 临时邮箱即弃，售后/续费提醒都无法触达，下单同样拒绝
  if (isDisposableEmail(body.contact)) {
    return c.json({ ok: false, error: "请使用常用邮箱，不支持临时邮箱" }, 400);
  }

  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === body.plan_id);
  if (!plan) {
    return c.json({ ok: false, error: `plan '${body.plan_id}' not found` }, 404);
  }
  // 试用套餐只能在首页免费领取，不出售
  if (plan.id === "plan_3days") {
    return c.json({ ok: false, error: "该套餐为免费体验，请在首页输入邮箱直接领取" }, 400);
  }

  const order: Order = {
    id: newOrderId(),
    plan_id: plan.id,
    status: "pending",
    contact: body.contact.trim().toLowerCase(),
    created_at: Date.now(),
  };

  // 推广归因：带推广码直接下单（没领过试用）也记录待结算邀请；已归因过则自动忽略
  const refCode = body.ref?.trim().toLowerCase();
  if (refCode) {
    c.executionCtx.waitUntil(recordReferral(c.env, refCode, order.contact!.toLowerCase()));
  }

  // 推广减免：登录 session 邮箱与下单邮箱一致时，用可用额度抵扣（每额度 10 元，可叠加）。
  // 抵扣金额向下取整到 10 的倍数，与 consumeCredit 按个数记账对齐，避免零头漏损。
  const account = await getSessionAccount(c.env, c.req.header("authorization"));
  if (account && account.email === order.contact!.toLowerCase()) {
    const discount = orderDiscount(await availableDiscount(c.env, account.email), plan.price_cny);
    if (discount > 0) {
      order.discount_cny = discount;
      order.payable_cny = plan.price_cny - discount;
      await consumeCredit(c.env, account.email, discount);
    }
  }
  const payable = order.payable_cny ?? plan.price_cny;

  // 减免后实付 0 元：无需支付，直接发放 token
  if (payable <= 0) {
    try {
      const result = await fulfillOrder(c.env, c.executionCtx, order);
      const res: CreateOrderResponse = { order, token: result.token ?? undefined, paid: true };
      return c.json({ ok: true, data: res }, 201);
    } catch (e) {
      // 对外固定文案，内部错误详情只记日志（避免泄露内部实现/字段信息）
      console.error(`[orders] fulfill failed for order ${order.id}: ${(e as Error).message}`);
      return c.json({ ok: false, error: "internal error" }, 500);
    }
  }

  // 支付通道已摘除：订单照常落 pending（交易状态机保留），但没有支付凭证可生成，
  // 前端扫码页会显示二维码生成失败；接入新通道时在此处生成凭证写入订单即可
  await saveOrder(c.env, order);

  const res: CreateOrderResponse = { order, paid: false };
  return c.json({ ok: true, data: res }, 201);
});

/**
 * GET /api/orders/:id —— 公开查询订单支付状态（前端扫码页轮询用）
 * 只返回状态与（paid 时的）token 短 ID，不泄露联系方式等字段；
 * token_id 不是凭证，查询 token 详情仍需邮箱登录。
 */
ordersRoutes.get("/:id", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  return c.json({
    ok: true,
    data: {
      status: order.status,
      token_id: order.status === "paid" ? order.token_id : undefined,
    },
  });
});

