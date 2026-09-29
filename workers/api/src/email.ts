/**
 * Cloudflare Email Routing 工单邮件闭环（接收侧）。
 *
 * 背景：工单外发邮件走阿里云 DM（AccountName service@mail.fastergamer.cn，回信地址
 * 在控制台配置为 support@tickets.fastergamer.click）。用户直接回复邮件时，CF Email
 * Routing（子域名 tickets.fastergamer.click，绝不碰主域 MX——主域 MX 是阿里企业邮箱）
 * 把邮件路由到本 Worker 的 email handler，解析后追加进工单对话（Ticket.thread）。
 *
 * 串线：外发工单邮件主题统一带 [工单 fb_xxx] 标签，用户回复时邮件客户端保留该标签，
 * handler 用正则 /fb_[0-9a-z]{4,}/i 从 Subject 提取工单号；To 的 plus-addressing
 * （support+fb_xxx@tickets...）作为兜底。提取不到工单号的来信不入库，只通知站长。
 *
 * 安全口径：
 * - 来信 From 必须等于 ticket.contact（防陌生人往别人的工单里灌内容）；
 * - closed 工单拒收并回信告知；
 * - 同一 From 邮箱 1 小时最多追加 10 条（KV 计数节流，与 mail-throttle 同套路）；
 * - 正文只取 text 部分（HTML 丢弃），剥引用段/签名，截断 2000 字。
 *
 * 写库纪律：KV 写先于一切外发邮件完成；邮件发送失败只记日志，不影响入库。
 */
import PostalMime from "postal-mime";
import { KV } from "../../../shared/types";
import { sendMail } from "./lib/email-aliyun";
import { getTicket, saveTicket } from "./lib/kv";
import { escapeHtml } from "./lib/escape-html";
import { maskEmail } from "./lib/mask-email";
import type { Env } from "./types";

/** 工单号提取：主题 [工单 fb_xxx] 标签 / To plus 段共用同一正则 */
const TICKET_ID_RE = /fb_[0-9a-z]{4,}/i;
/** 单封追加正文上限（与 feedback 创建端点同口径） */
const THREAD_TEXT_MAX = 2000;
/** 来信追加节流：同一 From 邮箱 1 小时最多 10 条（防邮件循环/轰炸把工单撑爆） */
const MAILIN_LIMIT = 10;
const MAILIN_WINDOW_SECONDS = 3600;

/**
 * 正文清理：去掉引用段（"> " 开头的行、"On ... wrote:" 及之后、中文客户端的
 * 「在 ... 写道：」及之后）与签名分隔（"-- " 行及之后），截断到上限。
 * 只处理纯文本（HTML 部分直接不取），宁可多剥不可把整串引用灌进工单。
 */
export function cleanReplyText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^On .+ wrote:$/i.test(t)) break; // Gmail/Outlook 英文引用头
    if (/^在 .+ 写道：?$/.test(t) || t.startsWith("发件人：")) break; // 中文客户端引用头
    if (t === "--" || t === "-- ") break; // 签名分隔
    if (t.startsWith(">")) continue; // 引用行
    kept.push(line);
  }
  return kept.join("\n").trim().slice(0, THREAD_TEXT_MAX);
}

/** 来信追加节流（固定窗口，与 mail-throttle.ts 同口径：首发设 TTL，递增不刷新） */
async function mailInAllows(env: Env, from: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(from.trim().toLowerCase()));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = KV.MAILIN + hex;
  const raw = await env.TICKETS.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= MAILIN_LIMIT) return false;
  await env.TICKETS.put(key, String(count + 1), count === 0 ? { expirationTtl: MAILIN_WINDOW_SECONDS } : undefined);
  return true;
}

/** 从 Subject（优先）或 To plus 段提取工单号 */
export function extractTicketId(subject: string, to: string): string | null {
  const m = subject.match(TICKET_ID_RE) ?? to.match(TICKET_ID_RE);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Email Routing 入口（index.ts 与 fetch 并列导出）。
 * 不抛异常：handler 抛错会让 CF 认为投递失败反复重试，所有失败路径只记日志。
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  try {
    const parsed = await new PostalMime().parse(await new Response(message.raw).arrayBuffer());
    const subject = parsed.subject ?? message.headers.get("subject") ?? "";
    // envelope from 优先（裸地址）；解析头的 from.address 兜底（带显示名的场景）
    const from = (message.from || parsed.from?.address || "").trim().toLowerCase();
    const ticketId = extractTicketId(subject, message.to ?? "");

    // 无工单号：不入库，通知站长人工看一眼（可能是直接写信求助的新用户）
    if (!ticketId) {
      console.log(`[email-ticket] 无法识别的来信 from=${maskEmail(from)} subject=${subject.slice(0, 80)}`);
      if (env.ADMIN_NOTIFY_EMAIL) {
        ctx.waitUntil(
          sendMail(
            env,
            env.ADMIN_NOTIFY_EMAIL,
            `【GameBoost】收到无法识别的工单来信（${from || "未知发件人"}）`,
            `<p>收到一封无法关联工单的来信（主题不含 [工单 fb_xxx] 标签）：</p>
             <p>发件人：${escapeHtml(from || "未知")}<br>主题：${escapeHtml(subject || "（无）")}</p>
             <p style="color:#64748b;font-size:13px;">正文摘要：${escapeHtml(cleanReplyText(parsed.text ?? "").slice(0, 500)) || "（空）"}</p>`,
            `收到无法关联工单的来信：\n发件人：${from || "未知"}\n主题：${subject || "（无）"}\n正文摘要：${cleanReplyText(parsed.text ?? "").slice(0, 500) || "（空）"}`
          ).catch(() => {})
        );
      }
      return;
    }

    const ticket = await getTicket(env, ticketId);
    if (!ticket) {
      console.log(`[email-ticket] 工单不存在 ${ticketId} from=${maskEmail(from)}`);
      return;
    }
    // From 必须等于工单联系人：防陌生人拿到主题格式后往别人工单灌内容
    if (from !== ticket.contact.toLowerCase()) {
      console.log(`[email-ticket] From 不匹配 ${ticketId} from=${maskEmail(from)}`);
      return;
    }
    if (ticket.status === "closed") {
      ctx.waitUntil(
        sendMail(
          env,
          ticket.contact,
          `Re: [工单 ${ticket.id}] 该工单已关闭`,
          `<p>你好，工单 <strong>${ticket.id}</strong> 已关闭，回复内容未收录。如问题仍未解决，请重新提交反馈：<a href="https://fastergamer.click">fastergamer.click</a>（页脚「问题反馈」）。</p>`,
          `工单 ${ticket.id} 已关闭，回复内容未收录。如问题仍未解决，请到 fastergamer.click 重新提交反馈。`
        ).catch(() => {})
      );
      return;
    }

    const text = cleanReplyText(parsed.text ?? "");
    if (!text) {
      console.log(`[email-ticket] 正文为空（剥引用后无内容）${ticketId} from=${maskEmail(from)}`);
      return;
    }
    if (!(await mailInAllows(env, from))) {
      console.log(`[email-ticket] 追加节流命中 ${ticketId} from=${maskEmail(from)}`);
      return;
    }

    // 追加对话记录；用户补充后工单重新浮出水面（replied → open），管理员列表按 open 过滤能看到
    ticket.thread = [...(ticket.thread ?? []), { from: "user", text, at: Date.now() }];
    if (ticket.status === "replied") ticket.status = "open";
    // KV 写先于一切外发完成；后续邮件失败只记日志不影响入库
    await saveTicket(env, ticket);
    console.log(`[email-ticket] 追加来信 ${ticket.id} from=${maskEmail(from)} len=${text.length}`);

    ctx.waitUntil(
      (async () => {
        // 用户确认回执（主题带工单标签，继续回复仍可串线）
        const ack = await sendMail(
          env,
          ticket.contact,
          `Re: [工单 ${ticket.id}] 我们已收到你的补充`,
          `<p>你好，你的补充已收录到工单 <strong>${ticket.id}</strong>，客服会尽快通过本邮箱回复你。</p>
           <p style="color:#64748b;font-size:13px;">你的补充：${escapeHtml(text.slice(0, 500))}</p>`,
          `你的补充已收录到工单 ${ticket.id}，客服会尽快通过本邮箱回复你。\n\n你的补充：${text.slice(0, 500)}`
        );
        if (!ack.ok) console.error(`[email-ticket] 回执发送失败 ${ticket.id}: ${ack.error}`);
        // 站长通知：含正文摘要，不用登管理端也能直接看
        if (env.ADMIN_NOTIFY_EMAIL) {
          const notice = await sendMail(
            env,
            env.ADMIN_NOTIFY_EMAIL,
            `【GameBoost】工单 ${ticket.id} 有新补充（${ticket.contact}）`,
            `<p><strong>${escapeHtml(ticket.contact)}</strong> 通过邮件补充了工单 ${ticket.id}：</p>
             <div style="padding:16px;background:#f0f9ff;border-radius:8px;margin:16px 0;">${escapeHtml(text).replace(/\n/g, "<br>")}</div>
             <p style="color:#64748b;font-size:13px;">回复：管理页工单标签，或 POST /api/admin/tickets/${ticket.id}/reply</p>`,
            `${ticket.contact} 通过邮件补充了工单 ${ticket.id}：\n\n${text}\n\n回复：管理页工单标签，或 POST /api/admin/tickets/${ticket.id}/reply`
          );
          if (!notice.ok) console.error(`[email-ticket] 站长通知发送失败 ${ticket.id}: ${notice.error}`);
        }
      })().catch((e) => console.error(`[email-ticket] 外发异常 ${ticket.id}:`, e))
    );
  } catch (e) {
    // 兜底：解析/存储异常都不能外抛（CF 会按投递失败重试，同一封邮件反复灌入）
    console.error("[email-ticket] handler 异常:", e);
  }
}
