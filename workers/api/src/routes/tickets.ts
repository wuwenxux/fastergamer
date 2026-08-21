/**
 * 用户反馈渠道（公开接口，无需登录）
 *
 * POST /api/feedback  提交问题（安装失败等），自动回执邮件，可选通知管理员
 * GET  /api/faq       公开 FAQ（由管理员标记 publish_faq 的已回复工单沉淀而来）
 */
import { Hono } from "hono";
import type { FaqItem, Ticket } from "../../../../shared/types";
import { isEmail, sendMail } from "../lib/email-aliyun";
import { listTickets, saveTicket } from "../lib/kv";
import type { Env } from "../types";

export const ticketsRoutes = new Hono<{ Bindings: Env }>();

const CATEGORIES = new Set(["install", "connect", "speed", "other"]);

/**
 * POST /api/feedback
 * body: { contact: 邮箱, message: 问题描述, category?, token_id? }
 */
ticketsRoutes.post("/feedback", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    contact?: string;
    message?: string;
    category?: string;
    token_id?: string;
  } | null;

  const contact = body?.contact?.trim() ?? "";
  const message = body?.message?.trim() ?? "";
  if (!isEmail(contact)) {
    return c.json({ ok: false, error: "请填写有效的邮箱，回复将发送到这里" }, 400);
  }
  if (message.length < 5 || message.length > 2000) {
    return c.json({ ok: false, error: "问题描述需 5-2000 字" }, 400);
  }
  const category = body?.category && CATEGORIES.has(body.category) ? body.category : "other";

  const ticket: Ticket = {
    id: `fb_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    contact: contact.toLowerCase(),
    category,
    message,
    token_id: body?.token_id?.trim() || undefined,
    status: "open",
    created_at: Date.now(),
  };
  await saveTicket(c.env, ticket);

  // 回执邮件（尽力发送，失败不影响提交）
  const site = (c.env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
  sendMail(
    c.env,
    contact,
    "【GameBoost】我们已收到你的问题反馈",
    `<p>你好，我们已收到你的问题反馈（工单号 <strong>${ticket.id}</strong>），客服会尽快通过本邮箱回复你。</p>
     <p style="color:#64748b;font-size:13px;">你的问题：${escapeHtml(message.slice(0, 500))}</p>`,
    `我们已收到你的问题反馈（工单号 ${ticket.id}），客服会尽快通过本邮箱回复你。\n\n你的问题：${message.slice(0, 500)}`
  ).catch(() => {});

  // 管理员通知（配置了 ADMIN_NOTIFY_EMAIL 才发）
  if (c.env.ADMIN_NOTIFY_EMAIL) {
    sendMail(
      c.env,
      c.env.ADMIN_NOTIFY_EMAIL,
      `【GameBoost】新反馈工单 ${ticket.id}（${category}）`,
      `<p><strong>${escapeHtml(contact)}</strong> 提交了反馈（${ticket.id}，分类 ${category}）：</p>
       <p>${escapeHtml(message)}</p>
       ${ticket.token_id ? `<p>Token：${ticket.token_id}</p>` : ""}
       <p style="color:#64748b;font-size:13px;">回复：POST ${site}/api/admin/tickets/${ticket.id}/reply</p>`,
      `${contact} 提交了反馈（${ticket.id}，分类 ${category}）：\n${message}\n${ticket.token_id ? `Token：${ticket.token_id}\n` : ""}回复接口：POST ${site}/api/admin/tickets/${ticket.id}/reply`
    ).catch(() => {});
  }

  console.log(`[feedback] new ticket ${ticket.id} from ${contact} category=${category}`);
  return c.json({ ok: true, data: { id: ticket.id } });
});

/** GET /api/faq —— 公开常见问题（已回复且管理员标记沉淀的工单） */
ticketsRoutes.get("/faq", async (c) => {
  const tickets = await listTickets(c.env);
  const faq: FaqItem[] = tickets
    .filter((t) => t.publish_faq && t.reply)
    .map((t) => ({ question: t.message, answer: t.reply as string, category: t.category }));
  return c.json({ ok: true, data: faq });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
