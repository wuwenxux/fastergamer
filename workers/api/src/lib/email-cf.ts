/**
 * Cloudflare Email Service 发信通道（send_email binding，Workers 付费计划 +
 * Dashboard 域名 onboarding 后可用，CF 自动配好 SPF/DKIM）。
 *
 * 只承接工单域邮件：发件人固定 support@tickets.fastergamer.click（Email Routing
 * 收件地址）——用户直接回复就回到工单邮件闭环（src/email.ts），不再需要阿里云 DM
 * 控制台的回信地址配置。其他邮件（token 凭证/magic 链接/站长通知）仍走阿里云 DM。
 *
 * 通道选择在 email-aliyun.ts 的 sendMailDispatch（binding 只能在运行时探测，
 * 入队时不定通道，consumer 消费时才分发）；binding 缺失时由调用方回退阿里云 DM。
 */
import type { Env } from "../types";

/** 工单域发件人（= Email Routing 收件地址，回信自然进工单闭环） */
export const TICKET_SENDER = "support@tickets.fastergamer.click";

/** CF Email Service 直发；binding 缺失/发送失败返回 { ok:false }，由调用方决定回退 */
export async function sendMailCf(
  env: Env,
  msg: { to: string; subject: string; html: string; text: string }
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!env.EMAIL) return { ok: false, error: "EMAIL binding not configured" };
  try {
    const res = await env.EMAIL.send({
      from: TICKET_SENDER,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
    return { ok: true, id: res.messageId };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
