import { Hono } from "hono";
import type { CreateOrderRequest, CreateOrderResponse, Order } from "../../../../shared/types";
import { getSessionAccount } from "../lib/accounts";
import { getAlipayConfig, precreate, verifyNotify } from "../lib/alipay";
import { isEmail, sendMail } from "../lib/email-aliyun";
import { escapeHtml } from "../lib/escape-html";
import { getOrder, getPlans, saveOrder } from "../lib/kv";
import { newOrderId, newPaymentRef } from "../lib/ids";
import { fulfillOrder } from "../lib/issue-token";
import { availableDiscount, consumeCredit, recordReferral } from "../lib/referral";
import type { Env } from "../types";

export const ordersRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/orders —— 创建购买订单
 *
 * 配置了支付宝当面付（ALIPAY_* 三项齐全）时，同时调用 precreate 生成动态二维码，
 * 买家支付后由 /alipay-notify 回调自动发放 token；
 * 未配置或 precreate 失败时回退到静态收款码 + 管理员人工确认到账。
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
  // 试用套餐只能在首页免费领取，不出售
  if (plan.id === "plan_3days") {
    return c.json({ ok: false, error: "该套餐为免费体验，请在首页输入邮箱直接领取" }, 400);
  }

  const order: Order = {
    id: newOrderId(),
    plan_id: plan.id,
    payment_ref: newPaymentRef(),
    status: "pending",
    contact: body.contact.trim().toLowerCase(),
    created_at: Date.now(),
  };

  // 推广归因：带推广码直接下单（没领过试用）也记录待结算邀请；已归因过则自动忽略
  const refCode = body.ref?.trim().toLowerCase();
  if (refCode) {
    c.executionCtx.waitUntil(recordReferral(c.env, refCode, order.contact!.toLowerCase()));
  }

  // 推广减免：登录 session 邮箱与下单邮箱一致时，用可用额度抵扣（每额度 10 元，可叠加）
  const account = await getSessionAccount(c.env, c.req.header("authorization"));
  if (account && account.email === order.contact!.toLowerCase()) {
    const discount = Math.min(await availableDiscount(c.env, account.email), plan.price_cny);
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
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  // 当面付：生成动态二维码。失败不阻塞下单，前端回退静态收款码
  const alipay = getAlipayConfig(c.env);
  const siteUrl = c.env.SITE_URL?.trim();
  if (alipay && siteUrl) {
    try {
      const r = await precreate(alipay, {
        outTradeNo: order.id,
        totalAmount: payable.toFixed(2),
        subject: plan.name,
        notifyUrl: `${siteUrl}/api/orders/alipay-notify`,
      });
      order.alipay_qr_code = r.qrCode;
    } catch (e) {
      console.error("alipay precreate error:", (e as Error).message);
    }
  }

  await saveOrder(c.env, order);

  // 静态转账（人工确认）订单：通知管理员尽快核对到账（当面付订单走回调，无需人工）
  if (!order.alipay_qr_code && c.env.ADMIN_NOTIFY_EMAIL) {
    const adminEmail = c.env.ADMIN_NOTIFY_EMAIL;
    const site = (c.env.SITE_URL ?? "").trim().replace(/\/$/, "");
    const confirmUrl = `${site}/api/admin/orders/${order.id}/confirm?key=${c.env.ADMIN_KEY}`;
    c.executionCtx.waitUntil(
      sendMail(
        c.env,
        adminEmail,
        `【GameBoost】新订单待确认收款 ¥${payable}`,
        `<p>订单 <strong>${order.id}</strong>：${plan.name}，应付 <strong>¥${payable}</strong>，联系方式 ${order.contact}。</p>
         <p>请在支付宝核对到账（备注应为买家邮箱），到账后点此一键发货：<a href="${confirmUrl}">${confirmUrl}</a></p>`,
        `新订单 ${order.id}：${plan.name} ¥${payable}，${order.contact}。核对到账（备注应为买家邮箱）后一键发货：${confirmUrl}`
      ).then((r) => {
        if (!r.ok) console.error(`[orders] admin notify failed: ${r.error}`);
      })
    );
  }

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

/**
 * POST /api/orders/:id/claim-paid —— 买家声明「我已转账」（静态收款模式）
 * body: { amount_cny?, note? }（均可选，辅助管理员对账）
 * 首次声明时邮件提醒管理员（内附一键确认链接）；重复声明只更新信息不再发邮件，防骚扰。
 */
ordersRoutes.post("/:id/claim-paid", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  if (order.status === "paid") {
    return c.json({ ok: false, error: "订单已确认收款，token 已发放" }, 409);
  }
  if (order.status !== "pending") {
    return c.json({ ok: false, error: "订单已关闭" }, 409);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { amount_cny?: number; note?: string }
    | null;
  const amount =
    typeof body?.amount_cny === "number" && body.amount_cny > 0 && body.amount_cny < 100000
      ? Math.round(body.amount_cny * 100) / 100
      : undefined;
  const note = body?.note?.trim().slice(0, 100) || undefined;

  const firstClaim = !order.paid_claim;
  order.paid_claim = { at: Date.now(), amount_cny: amount, note };
  await saveOrder(c.env, order);

  if (firstClaim && c.env.ADMIN_NOTIFY_EMAIL) {
    const plans = await getPlans(c.env);
    const plan = plans.find((p) => p.id === order.plan_id);
    const payable = order.payable_cny ?? plan?.price_cny ?? 0;
    const site = (c.env.SITE_URL ?? "").trim().replace(/\/$/, "");
    const confirmUrl = `${site}/api/admin/orders/${order.id}/confirm?key=${c.env.ADMIN_KEY}`;
    const claimInfo = [
      amount !== undefined ? `自述转账金额 ¥${amount}` : null,
      note ? `付款账号：${note}` : null,
    ]
      .filter(Boolean)
      .join("；");
    c.executionCtx.waitUntil(
      sendMail(
        c.env,
        c.env.ADMIN_NOTIFY_EMAIL,
        `【GameBoost】买家已声明付款 ¥${payable}，请核对`,
        `<p>订单 <strong>${order.id}</strong>（${plan?.name ?? order.plan_id}，应付 <strong>¥${payable}</strong>，${order.contact}）买家声明已转账。${claimInfo ? `<br>${escapeHtml(claimInfo)}。` : ""}</p>
         <p>请在支付宝核对到账（备注应为买家邮箱），到账后点此一键发货：<a href="${confirmUrl}">${confirmUrl}</a></p>
         <p>未到账请勿点击；疑似刷单可忽略。</p>`,
        `订单 ${order.id}（¥${payable}，${order.contact}）买家声明已转账${claimInfo ? `，${claimInfo}` : ""}。核对到账后一键发货：${confirmUrl}`
      ).then((r) => {
        if (!r.ok) console.error(`[orders] claim-paid notify failed: ${r.error}`);
      })
    );
  }

  return c.json({ ok: true, data: { claimed: true, first: firstClaim } });
});

/**
 * POST /api/orders/alipay-notify —— 支付宝异步回调
 *
 * 验签 → 校验 app_id / trade_status / 金额 → 幂等发货。
 * 支付宝只认纯文本 "success"，其他响应会在 24h 内反复重推。
 */
ordersRoutes.post("/alipay-notify", async (c) => {
  const alipay = getAlipayConfig(c.env);
  if (!alipay) return c.text("failure", 400);

  const raw = await c.req.parseBody();
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") form[k] = v;
  }

  if (!(await verifyNotify(alipay, form))) {
    console.error("alipay notify: bad signature");
    return c.text("failure", 400);
  }
  if (form.app_id !== alipay.appid) {
    console.error("alipay notify: app_id mismatch");
    return c.text("failure", 400);
  }
  if (form.trade_status !== "TRADE_SUCCESS" && form.trade_status !== "TRADE_FINISHED") {
    // 等待付款等非终态不算异常，直接确认收货避免重推
    return c.text("success");
  }

  const order = await getOrder(c.env, form.out_trade_no ?? "");
  if (!order) {
    console.error(`alipay notify: order '${form.out_trade_no}' not found`);
    return c.text("failure", 400);
  }

  // 金额必须和下单时一致（含推广减免后的实付金额），防改价
  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === order.plan_id);
  const expected = (order.payable_cny ?? plan?.price_cny ?? -1).toFixed(2);
  if (!plan || form.total_amount !== expected) {
    console.error(
      `alipay notify: amount mismatch order=${order.id} got=${form.total_amount}`
    );
    return c.text("failure", 400);
  }

  if (order.status === "failed") {
    console.error(`alipay notify: order ${order.id} was cancelled`);
    return c.text("failure", 400);
  }

  try {
    order.trade_no = form.trade_no;
    await fulfillOrder(c.env, c.executionCtx, order);
  } catch (e) {
    console.error("alipay notify: fulfill error:", (e as Error).message);
    return c.text("failure", 500);
  }

  return c.text("success");
});
