/**
 * 节点变更通知的订阅/退订链接签名与构造。
 *
 * 链接随邮件发出（匿名、无登录态），安全性靠 HMAC-SHA256 签名：
 * 密钥用 ADMIN_KEY 派生（项目里没有独立的用户链接签名体系——magic link 是 KV 随机票据，
 * 不适合嵌进邮件模板），签名内容含 tid + action，改 tid 或把 sub 改成 unsub 都验不过。
 *
 * GET /api/notify-pref 只渲染确认页不生效：邮件客户端/安全网关会预取链接，
 * GET 直接生效会被预取器全员误订阅；真正生效走确认页表单的 POST。
 */

import type { Env } from "../types";

export type NotifyPrefAction = "sub" | "unsub";

/** 链接 host 固定主域（邮件里的链接必须长期有效，不随 SITE_URL 配置漂移） */
const LINK_BASE = "https://fastergamer.click";

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256(ADMIN_KEY, "notify-pref:{tid}:{action}") 的 hex 签名 */
export const notifyPrefSig = async (env: Env, tid: string, action: NotifyPrefAction): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.ADMIN_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`notify-pref:${tid}:${action}`)
  );
  return hex(sig);
};

export const verifyNotifyPrefSig = async (
  env: Env,
  tid: string,
  action: NotifyPrefAction,
  sig: string
): Promise<boolean> => (await notifyPrefSig(env, tid, action)) === sig;

/** 邮件里的订阅/退订链接（GET 确认页地址） */
export const notifyPrefUrl = async (
  env: Env,
  tid: string,
  action: NotifyPrefAction
): Promise<string> => {
  const sig = await notifyPrefSig(env, tid, action);
  return `${LINK_BASE}/api/notify-pref?tid=${encodeURIComponent(tid)}&action=${action}&sig=${sig}`;
};
