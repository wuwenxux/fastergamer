/**
 * 按收件人邮箱的邮件节流：防公开接口（找回/登录链接/反馈回执/试用）被用来邮件轰炸。
 * 限流中间件只按来源 IP，攻击者换 IP 即可对同一收件人无限发信；这里按收件人计数，
 * 每邮箱每小时最多 5 封（试用/找回/登录共享额度），超出后调用方按场景处理
 * （登录链接返回 throttled 标记提示用户，其余静默跳过，不泄露节流状态）。
 * KV 计数键 mailthrottle:<sha1(email)>（键里不放明文邮箱）；窗口自首发起算固定 1 小时
 * （只在首次写入时设 TTL，后续递增不刷新——滑动窗口会让「一小时后再试」永远顺延）。
 * best-effort：并发下允许少量超发，不追求完美精确。
 */
import { KV } from "../../../../shared/types";
import type { Env } from "../types";

export const MAIL_THROTTLE_LIMIT = 5;
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
  // 仅首发携带 TTL 固定窗口起点；递增重写不带 TTL，避免窗口被反复顺延
  await env.TOKENS.put(
    key,
    String(count + 1),
    count === 0 ? { expirationTtl: WINDOW_SECONDS } : undefined
  );
  return true;
}
