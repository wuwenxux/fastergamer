/**
 * Cloudflare Email Service 发信通道（send_email binding，Workers 付费计划 +
 * Dashboard 域名 onboarding 后可用，CF 自动配好 SPF/DKIM）。
 *
 * 按场景区分发件邮箱（主域 fastergamer.click，四桶规划）：
 * - support@ 工单/客服：双向，回信进 Email Routing 闭环（src/email.ts），工单外发的 From
 * - service@ 订单发货/token 凭证等交易邮件（仅外发，Reply-To 指 support@）
 * - account@ magic 登录链接/找回/账号安全提醒等账号邮件（仅外发，Reply-To 指 support@）
 * - ops@     站长告警通知（发往 ADMIN_NOTIFY_EMAIL，仅外发，Reply-To 指 support@）
 * 非工单邮件统一带 Reply-To: support@ —— 用户随手回复任何邮件都进工单闭环，
 * 而不是丢进无人看管的 service@/account@/ops@ 邮箱（它们根本没收件路由）。
 *
 * 通道选择在 email-aliyun.ts 的 sendMailDispatch（binding 只能运行时探测，
 * 入队时不定通道，consumer 消费时才分发）；binding 缺失时由调用方回退阿里云 DM。
 */
import type { MailMessage } from "./email-aliyun";
import type { Env } from "../types";

/** 工单发件人（= Email Routing 收件地址，双向，回信自然进工单闭环） */
export const TICKET_SENDER = "support@fastergamer.click";
/** 交易邮件发件人（订单发货/token 凭证，仅外发） */
export const ORDER_SENDER = "service@fastergamer.click";
/** 账号邮件发件人（magic 登录/找回/安全提醒，仅外发） */
export const ACCOUNT_SENDER = "account@fastergamer.click";
/** 站长告警发件人（发往 ADMIN_NOTIFY_EMAIL，仅外发） */
export const OPS_SENDER = "ops@fastergamer.click";

/** kind → 发件邮箱映射。"magic" 是登录链接的历史 kind 值，归 account 桶 */
const SENDER_BY_KIND: Record<string, string> = {
  ticket: TICKET_SENDER,
  order: ORDER_SENDER,
  account: ACCOUNT_SENDER,
  magic: ACCOUNT_SENDER,
  notify: OPS_SENDER,
};

/** kind 对应的 CF 发件人；未带 kind/未知 kind 返回 undefined（调用方据此保守回退 DM） */
export const cfSenderFor = (kind?: string): string | undefined => (kind ? SENDER_BY_KIND[kind] : undefined);

/** CF Email Service 直发；binding 缺失/发送失败返回 { ok:false }，由调用方决定回退 */
export async function sendMailCf(
  env: Env,
  msg: MailMessage
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const from = cfSenderFor(msg.kind);
  if (!env.EMAIL) return { ok: false, error: "EMAIL binding not configured" };
  if (!from) return { ok: false, error: `unknown mail kind '${msg.kind ?? ""}'` };
  try {
    const res = await env.EMAIL.send({
      from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      // 非工单邮件带 Reply-To 指回 support@：用户随手回复也进工单闭环
      // （SendEmail 对象形态原生支持 replyTo 字段，见 workers-types）
      ...(msg.kind !== "ticket" ? { replyTo: TICKET_SENDER } : {}),
    });
    return { ok: true, id: res.messageId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
