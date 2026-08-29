/**
 * 会话与 magic link 免密登录
 *
 * 账号体系已简化为「邮箱即身份」：没有密码/注册，用户点邮件里的一次性
 * magic 链接换取 30 天会话。会话与 ticket 都存 TOKENS namespace。
 * 注意：KV TTL 不作为过期依据，过期时间一律手动判断。
 */
import { KV, type MagicTicket } from "../../../../shared/types";
import type { Env } from "../types";

/** 会话有效期 180 天，覆盖套餐周期，用户基本感知不到"登录" */
export const SESSION_TTL_MS = 180 * 86_400_000;
/** magic ticket 有效期 15 分钟，一次性使用 */
export const MAGIC_TTL_MS = 15 * 60_000;

interface SessionData {
  email: string;
  created_at: number;
}

export const createSession = async (env: Env, email: string): Promise<string> => {
  const token = crypto.randomUUID() + crypto.randomUUID(); // 72 位 hex，足够不可猜
  const data: SessionData = { email, created_at: Date.now() };
  await env.TOKENS.put(KV.SESSION + token, JSON.stringify(data));
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

/** 签发一次性 magic ticket，返回票据串（拼进登录链接） */
export const createMagicTicket = async (
  env: Env,
  email: string,
  tokenId: string
): Promise<string> => {
  const ticket = crypto.randomUUID() + crypto.randomUUID();
  const data: MagicTicket = { email, token_id: tokenId, created_at: Date.now() };
  await env.TOKENS.put(KV.MAGIC + ticket, JSON.stringify(data));
  return ticket;
};

/** 核销 magic ticket：无论成功与否都立即焚毁（一次性），过期/不存在返回 null */
export const consumeMagicTicket = async (
  env: Env,
  ticket: string
): Promise<MagicTicket | null> => {
  if (!/^[0-9a-f-]{36,}$/.test(ticket)) return null;
  const raw = await env.TOKENS.get(KV.MAGIC + ticket);
  // 用后即焚，防重放；注意 workerd 磁盘 KV 删除不存在的 key 会抛 404，须先判断
  if (raw) await env.TOKENS.delete(KV.MAGIC + ticket);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as MagicTicket;
    if (Date.now() - data.created_at > MAGIC_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
};
