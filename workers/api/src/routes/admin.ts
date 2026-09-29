import { Hono } from "hono";
import { KV } from "../../../../shared/types";
import type { Registration } from "../../../../shared/types";
import { adminAuth } from "../middleware/admin";
import { getOrder, getTicket, getTokenById, listKeys, listOrders, listTickets, listTokensByContact, saveOrder, saveTicket } from "../lib/kv";
import { notifyAdmin, sendServiceEmail } from "../lib/risk-notify";
import { sendMail, shouldSendEmail } from "../lib/email-aliyun";
import { fulfillOrder } from "../lib/issue-token";
import { buildGeoStats } from "../lib/geo-stats";
import { escapeHtml } from "../lib/escape-html";
import type { Env } from "../types";
import { adminPlansRoutes } from "./admin/plans";
import { adminTokensRoutes } from "./admin/tokens";
import { adminRefundRoutes } from "./admin/refund";
import { adminNotifyScanRoutes } from "./admin/notify-scan";

export const adminRoutes = new Hono<{ Bindings: Env }>();
adminRoutes.use("*", adminAuth);

// 按域拆分的子路由（路径/方法逐字保持；use("*") 先注册，鉴权对全部子路由生效）
adminRoutes.route("/", adminPlansRoutes); // GET /plans、POST /seed（DEFAULT_PLANS 唯一数据源）
adminRoutes.route("/", adminTokensRoutes); // token 列表/删除/rotate/重置续用/设备解绑/PUT 调整
adminRoutes.route("/", adminRefundRoutes); // POST /orders/:id/refund（epay 休眠链，原样保留）
adminRoutes.route("/", adminNotifyScanRoutes); // POST /notify-scan（cron 巡检）

/**
 * GET /api/admin/geo-stats —— 用户地理分布聚合：全部 token 的接入 IP 按归属地聚合成
 * 城市/国家两级统计（ip-api 解析，geo:{ip} 缓存 30 天；解析失败 fail-open 计入未解析）。
 * 供管理端「分布」tab 画地图用。
 */
adminRoutes.get("/geo-stats", async (c) => {
  const stats = await buildGeoStats(c.env);
  return c.json({ ok: true, data: stats });
});

/** GET /api/admin/registrations —— 导出全部防失联登记（批量通知用） */
adminRoutes.get("/registrations", async (c) => {
  const keys = await listKeys(c.env.TOKENS, KV.REG);
  const regs: Registration[] = [];
  for (const key of keys) {
    const raw = await c.env.TOKENS.get(key.name);
    if (!raw) continue;
    try {
      regs.push(JSON.parse(raw) as Registration);
    } catch {
      // 跳过坏数据
    }
  }
  regs.sort((a, b) => b.updated_at - a.updated_at);
  return c.json({ ok: true, data: regs });
});

/**
 * POST /api/admin/notify-user —— 给指定 token 的联系人发服务邮件（公告/售后）
 * body: { token_id, title, text }；text 按空行分段渲染为 HTML 段落（自动转义）。
 * 邮件带 72h 免登录管理链接，文案与工单回复同一模板（shell）。
 */
adminRoutes.post("/notify-user", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    token_id?: string;
    title?: string;
    text?: string;
  } | null;
  const title = body?.title?.trim();
  const text = body?.text?.trim();
  if (!body?.token_id || !title || !text) {
    return c.json({ ok: false, error: "token_id/title/text 均为必填" }, 400);
  }
  if (title.length > 100 || text.length > 4000) {
    return c.json({ ok: false, error: "title ≤100 字，text ≤4000 字" }, 400);
  }
  const token = await getTokenById(c.env, body.token_id);
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  if (!token.contact || !shouldSendEmail(token.contact)) {
    return c.json({ ok: false, error: "该用户联系方式不是有效邮箱" }, 400);
  }

  const html = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  const sent = await sendServiceEmail(c.env, token, title, html, text);
  if (!sent) return c.json({ ok: false, error: "邮件发送失败" }, 502);
  return c.json({ ok: true, data: { sent: true } });
});

/**
 * POST /api/admin/alert —— 通用管理员告警入口
 * 供本机运维脚本（probe-nodes.sh 节点可达性探测）触发邮件告警
 * body: { title: string, text: string }
 */
adminRoutes.post("/alert", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { title?: string; text?: string } | null;
  const title = body?.title?.trim();
  const text = body?.text?.trim();
  if (!title || !text) return c.json({ ok: false, error: "title and text are required" }, 400);
  if (title.length > 200 || text.length > 2000) {
    return c.json({ ok: false, error: "title/text too long" }, 400);
  }
  await notifyAdmin(c.env, title, `<p>${text.replace(/</g, "&lt;")}</p>`, text);
  return c.json({ ok: true });
});

/**
 * GET /api/admin/customers?contact=xx@yy.com —— 按邮箱查客户 token
 * 用于客服售后：收到 support@ 来信后先查发件人是否有 token，只回复真实客户
 */
adminRoutes.get("/customers", async (c) => {
  const contact = c.req.query("contact")?.trim();
  if (!contact) return c.json({ ok: false, error: "contact is required" }, 400);
  const tokens = await listTokensByContact(c.env, contact);
  return c.json({ ok: true, data: tokens });
});

/** GET /api/admin/orders —— 列出所有订单（含联系方式） */
adminRoutes.get("/orders", async (c) => {
  const orders = await listOrders(c.env);
  return c.json({ ok: true, data: orders });
});

/**
 * POST /api/admin/orders/:id/paid —— 人工确认收款（收款码过渡方案）
 * 站长核对收款码到账后调用，复用 fulfillOrder 完整发货
 * （幂等、发货锁、对账、推广结算、升级订单均由其内部处理，这里不重复做）。
 * 已 paid / 已取消的订单拒绝（409），不重复发货；发货锁冲突（busy）也回 409 让稍后重试。
 */
adminRoutes.post("/orders/:id/paid", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  if (order.status === "paid") {
    return c.json({ ok: false, error: "订单已确认收款并发货" }, 409);
  }
  if (order.status !== "pending") {
    return c.json({ ok: false, error: "订单已取消，无法确认收款" }, 409);
  }

  try {
    const result = await fulfillOrder(c.env, c.executionCtx, order);
    if (result.busy) {
      return c.json({ ok: false, error: "另一路发货正在进行，请稍后重试" }, 409);
    }
    return c.json({ ok: true, data: { token_id: result.token?.id ?? order.token_id } });
  } catch (e) {
    // 对外固定文案，内部错误详情只记日志（避免泄露内部实现/字段信息）
    console.error(`[admin] fulfill failed for order ${order.id}: ${(e as Error).message}`);
    return c.json({ ok: false, error: "internal error" }, 500);
  }
});

/**
 * POST /api/admin/orders/:id/cancel —— 取消未支付的订单（无效/刷单订单清理）。
 * 推广抵扣在发货成功时才扣减，pending 订单本来就没占额度，取消无需归还。
 */
adminRoutes.post("/orders/:id/cancel", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  if (order.status === "paid") {
    return c.json({ ok: false, error: "paid order cannot be cancelled" }, 409);
  }
  if (order.status !== "pending") {
    return c.json({ ok: false, error: "订单已取消过" }, 409);
  }
  order.status = "failed";
  await saveOrder(c.env, order);
  return c.json({ ok: true, data: order });
});

/** GET /api/admin/tickets?status=open —— 列出反馈工单（默认全部，可按状态过滤） */
adminRoutes.get("/tickets", async (c) => {
  const status = c.req.query("status");
  let tickets = await listTickets(c.env);
  if (status) tickets = tickets.filter((t) => t.status === status);
  return c.json({ ok: true, data: tickets });
});

/**
 * POST /api/admin/tickets/:id/reply —— 回复工单并邮件通知用户
 * body: { reply: string, publish_faq?: boolean, close?: boolean }
 * publish_faq=true 时该问答会出现在公开 /api/faq，沉淀给后来的新用户
 */
adminRoutes.post("/tickets/:id/reply", async (c) => {
  const ticket = await getTicket(c.env, c.req.param("id"));
  if (!ticket) return c.json({ ok: false, error: "ticket not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    reply?: string;
    publish_faq?: boolean;
    close?: boolean;
  } | null;
  const reply = body?.reply?.trim() ?? "";
  if (reply.length < 2 || reply.length > 4000) {
    return c.json({ ok: false, error: "reply 需 2-4000 字" }, 400);
  }

  const res = await sendMail(
    c.env,
    ticket.contact,
    // 主题带 [工单 {id}] 标签：用户直接回复本邮件可串线回工单（Email Routing 闭环）
    `[工单 ${ticket.id}]【GameBoost】你的反馈已有回复`,
    `<p>你好，你之前反馈的问题已有回复：</p>
     <div style="padding:16px;background:#f0f9ff;border-radius:8px;margin:16px 0;">${escapeHtml(reply).replace(/\n/g, "<br>")}</div>
     <p style="color:#64748b;font-size:13px;">你的原始问题：${escapeHtml(ticket.message.slice(0, 500))}</p>
     <p style="color:#64748b;font-size:13px;">如问题仍未解决，直接回复本邮件即可继续补充（请勿修改主题）。</p>`,
    `你之前反馈的问题已有回复：\n\n${reply}\n\n---\n你的原始问题：${ticket.message.slice(0, 500)}\n如问题仍未解决，直接回复本邮件即可继续补充（请勿修改主题）。`,
    // kind:ticket = 工单域邮件，生产走 CF Email Service（回信直接进闭环）
    { kind: "ticket" }
  );
  if (!res.ok) {
    return c.json({ ok: false, error: `邮件发送失败：${res.error}` }, 502);
  }

  ticket.reply = reply;
  ticket.replied_at = Date.now();
  // 管理员回复同步进对话流水（与用户邮件补充的 from:"user" 条目组成完整 thread）
  ticket.thread = [...(ticket.thread ?? []), { from: "admin", text: reply, at: ticket.replied_at }];
  ticket.status = body?.close === false ? "replied" : "closed";
  if (body?.publish_faq) ticket.publish_faq = true;
  await saveTicket(c.env, ticket);
  return c.json({ ok: true, data: ticket });
});

/** POST /api/admin/tickets/:id/close —— 不回复直接关闭工单 */
adminRoutes.post("/tickets/:id/close", async (c) => {
  const ticket = await getTicket(c.env, c.req.param("id"));
  if (!ticket) return c.json({ ok: false, error: "ticket not found" }, 404);
  ticket.status = "closed";
  await saveTicket(c.env, ticket);
  return c.json({ ok: true, data: { id: ticket.id, status: ticket.status } });
});
