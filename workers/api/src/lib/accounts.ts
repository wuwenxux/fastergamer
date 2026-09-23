/**
 * 会话与 magic link 免密登录
 *
 * 账号体系已简化为「邮箱即身份」：没有密码/注册，用户点邮件里的 magic
 * 链接换取长期会话。会话与 ticket 都存 TOKENS namespace。
 * 写入时直接带 KV TTL 兜底清理（永不被访问的过期键不残留）；
 * 读取时的手动过期判断保留作语义兜底（KV TTL 不保证精确准时，且语义口径以这里为准）。
 */
import { KV, type MagicTicket } from "../../../../shared/types";
import type { Env } from "../types";

/** 会话有效期 180 天，覆盖套餐周期，用户基本感知不到"登录" */
export const SESSION_TTL_MS = 180 * 86_400_000;
/** magic ticket 有效期 72 小时：邮件里的链接会被邮箱客户端预扫描、也会被用户
 *  隔天/重复打开，15 分钟一次性会导致大量「链接已失效」误报。邮件正文本身已携带
 *  完整订阅链接（uuid 直连凭证），ticket 在 TTL 内可重复核销不扩大风险面 */
export const MAGIC_TTL_MS = 72 * 3_600_000;

interface SessionData {
  email: string;
  created_at: number;
}

export const createSession = async (env: Env, email: string): Promise<string> => {
  const token = crypto.randomUUID() + crypto.randomUUID(); // 72 位 hex，足够不可猜
  const data: SessionData = { email, created_at: Date.now() };
  await env.TOKENS.put(KV.SESSION + token, JSON.stringify(data), {
    expirationTtl: Math.ceil(SESSION_TTL_MS / 1000),
  });
  return token;
};

/** 按 Bearer token 取登录邮箱；会话缺失或过期返回 null */
export const getSessionAccount = async (
  env: Env,
  authHeader?: string
): Promise<{ email: string } | null> => {
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return null;
  const raw = await env.TOKENS.get(KV.SESSION + token);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as SessionData;
    if (Date.now() - data.created_at > SESSION_TTL_MS) {
      await env.TOKENS.delete(KV.SESSION + token);
      return null;
    }
    return { email: data.email };
  } catch {
    return null;
  }
};

/** 签发 magic ticket，返回票据串（拼进登录链接）；purpose 见 MagicTicket */
export const createMagicTicket = async (
  env: Env,
  email: string,
  tokenId: string,
  purpose?: MagicTicket["purpose"]
): Promise<string> => {
  const ticket = crypto.randomUUID() + crypto.randomUUID();
  const data: MagicTicket = { email, token_id: tokenId, created_at: Date.now(), purpose };
  await env.TOKENS.put(KV.MAGIC + ticket, JSON.stringify(data), {
    expirationTtl: Math.ceil(MAGIC_TTL_MS / 1000),
  });
  return ticket;
};

/** 核销 magic ticket：TTL 内可重复核销（邮箱预扫描/用户重复打开都安全），
 *  过期或不存在返回 null。不再用后即焚——见 MAGIC_TTL_MS 注释 */
export const consumeMagicTicket = async (
  env: Env,
  ticket: string
): Promise<MagicTicket | null> => {
  if (!/^[0-9a-f-]{36,}$/.test(ticket)) return null;
  const raw = await env.TOKENS.get(KV.MAGIC + ticket);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as MagicTicket;
    if (Date.now() - data.created_at > MAGIC_TTL_MS) {
      // 过期才焚毁，腾出 KV；有效期内的票据保留供重复打开
      await env.TOKENS.delete(KV.MAGIC + ticket);
      return null;
    }
    return data;
  } catch {
    return null;
  }
};
