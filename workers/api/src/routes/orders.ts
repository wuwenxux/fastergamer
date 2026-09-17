import { Hono } from "hono";
import type { CreateOrderRequest, CreateOrderResponse, Order } from "../../../../shared/types";
import { getSessionAccount } from "../lib/accounts";
import { isDisposableEmail } from "../lib/disposable-email";
import { isEmail } from "../lib/email-aliyun";
import { escapeHtml } from "../lib/escape-html";
import { getOrder, getPlans, saveOrder } from "../lib/kv";
import { newOrderId } from "../lib/ids";
import { fulfillOrder } from "../lib/issue-token";
import { availableDiscount, consumeCredit, orderDiscount, recordReferral } from "../lib/referral";
import { notifyAdmin } from "../lib/risk-notify";
import type { Env } from "../types";

export const ordersRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/orders —— 创建购买订单
 *
 * 交易状态机保留：订单照常落 pending，前端轮询 GET /:id 查状态，管理端可取消。
 * 支付通道（易支付）已摘除。过渡方案为人工收款码：前端支付页展示站长收款码，
 * 用户转账后点「我已支付」（POST /:id/notify-paid 邮件通知站长），站长管理端确认收款
 * （POST /api/admin/orders/:id/paid）后 fulfillOrder 自动发货。
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
  // 企业套餐已从 click 站下架，只在 fastergamer.cn 展示、邮件洽谈
  if (plan.id.startsWith("plan_biz")) {
    return c.json({ ok: false, error: "企业套餐请前往 fastergamer.cn 邮件洽谈" }, 400);
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
      // result.busy 当前不可达（下单瞬间 fulfill，无并发回调），只取 token；
      // busy 分支为将来新支付通道的并发回调保留
      const result = await fulfillOrder(c.env, c.executionCtx, order);
      const res: CreateOrderResponse = { order, token: result.token ?? undefined, paid: true };
      return c.json({ ok: true, data: res }, 201);
    } catch (e) {
      // 对外固定文案，内部错误详情只记日志（避免泄露内部实现/字段信息）
      console.error(`[orders] fulfill failed for order ${order.id}: ${(e as Error).message}`);
      return c.json({ ok: false, error: "internal error" }, 500);
    }
  }

  // 订单落 pending（交易状态机保留），支付页展示人工收款码引导转账备注订单号；
  // 站长确认收款后经 /api/admin/orders/:id/paid 触发发货
  await saveOrder(c.env, order);

  const res: CreateOrderResponse = { order, paid: false };
  return c.json({ ok: true, data: res }, 201);
});

/**
 * GET /api/orders/:id —— 公开查询订单支付状态（前端收款码页轮询用）
 * 只返回状态、（paid 时的）token 短 ID 与套餐/应付金额，不泄露联系方式等字段；
 * token_id 不是凭证，查询 token 详情仍需邮箱登录。
 * 收款码过渡方案补充 payable_cny/plan_id：页面刷新后要继续展示应付金额与套餐，
 * 订单 id 本身不可猜（随机生成），金额敏感度低，公开返回可接受。
 */
ordersRoutes.get("/:id", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  return c.json({
    ok: true,
    data: {
      status: order.status,
      token_id: order.status === "paid" ? order.token_id : undefined,
      payable_cny: order.payable_cny,
      plan_id: order.plan_id,
    },
  });
});

/** 「我已支付」通知邮件的节流窗口：6 小时内重复点击不再打扰站长 */
const PAID_NOTIFY_THROTTLE_MS = 6 * 3_600_000;

/**
 * POST /api/orders/:id/notify-paid —— 用户端「我已支付」（人工收款码过渡方案）
 * 用户扫站长收款码转账后点击，给站长发通知邮件，站长核账后经
 * POST /api/admin/orders/:id/paid 确认收款发货。
 * 响应统一 { notified }，不回带订单其他字段，避免公开接口泄露联系邮箱等信息。
 */
ordersRoutes.post("/:id/notify-paid", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  // 已 paid：不重复通知，但回 paid: true 让前端立刻跳到已支付态（站长可能已确认收款）
  if (order.status === "paid") {
    return c.json({ ok: true, data: { notified: false, paid: true } });
  }
  if (order.status !== "pending") {
    return c.json({ ok: false, error: "订单已取消，无法确认收款" }, 409);
  }

  // 幂等节流：窗口内重复点击只更新语义上的「已通知」结果，不再发邮件
  const now = Date.now();
  if (order.paid_notify_at && now - order.paid_notify_at < PAID_NOTIFY_THROTTLE_MS) {
    return c.json({ ok: true, data: { notified: false } });
  }

  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === order.plan_id);
  const payable = order.payable_cny ?? plan?.price_cny ?? 0;
  // 升级单是补差价，站长核账金额与新购不同，通知里必须区分
  const kindText = order.upgrade_token_id ? "升级补差价" : "新购";
  const contactHtml = escapeHtml(order.contact ?? "未留联系方式");
  const contactText = order.contact ?? "未留联系方式";
  await notifyAdmin(
    c.env,
    `用户已转账（${kindText}）：订单 ${order.id}，应收 ${payable.toFixed(2)} 元`,
    `<p>订单 <strong>${order.id}</strong>（${kindText}，套餐 <strong>${escapeHtml(order.plan_id)}</strong>）用户已点击「我已支付」。</p>
     <p>应收金额：<strong>${payable.toFixed(2)} 元</strong>；联系邮箱：<strong>${contactHtml}</strong></p>
     <p>请核对收款码到账后，在管理端确认收款（POST /api/admin/orders/${order.id}/paid），确认后系统自动发货。</p>
     <p style="color:#94a3b8;font-size:13px;">未到账请勿确认；刷单可忽略或在管理端取消订单。</p>`,
    `订单 ${order.id}（${kindText}，套餐 ${order.plan_id}）用户已点「我已支付」。\n应收 ${payable.toFixed(2)} 元，联系邮箱：${contactText}。\n核账到账后调 POST /api/admin/orders/${order.id}/paid 确认收款发货；未到账勿确认。`
  );

  order.paid_notify_at = now;
  await saveOrder(c.env, order);
  return c.json({ ok: true, data: { notified: true } });
});

