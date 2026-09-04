/**
 * 按收件人邮箱的邮件节流：防公开接口（找回/登录链接/反馈回执/试用）被用来邮件轰炸。
 * 限流中间件只按来源 IP，攻击者换 IP 即可对同一收件人无限发信；这里按收件人计数，
 * 每邮箱每小时最多 3 封，超出后调用方静默跳过发送（接口仍返回 ok，不泄露节流状态）。
 * KV 计数键 mailthrottle:<sha1(email)>（键里不放明文邮箱），1 小时自然过期；
 * best-effort：并发下允许少量超发，不追求完美精确。
 */
import { KV } from "../../../../shared/types";
import type { Env } from "../types";

export const MAIL_THROTTLE_LIMIT = 3;
const WINDOW_SECONDS = 3600;

/** 返回 true 表示可以发信（并计 1 次）；false 表示已超限，应静默跳过 */
export async function mailThrottleAllows(env: Env, email: string): Promise<boolean> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(email.trim().toLowerCase())
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = KV.MAILTHROTTLE + hex;
  const raw = await env.TOKENS.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= MAIL_THROTTLE_LIMIT) return false;
  await env.TOKENS.put(key, String(count + 1), { expirationTtl: WINDOW_SECONDS });
  return true;
}
