/**
 * KV 数据访问层
 * 键规则见 shared/types.ts 的 KV 常量
 */
import { KV, type Device, type Order, type Plan, type Ticket, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * KV list 兼容层：workerd 磁盘 KV（生产）返回 keys 数组，
 * miniflare/云端返回 { keys } 包装对象，统一为数组
 */
export const listKeys = async (
  ns: KVNamespace,
  prefix: string
): Promise<{ name: string }[]> => {
  const result = (await ns.list({ prefix })) as unknown;
  const keys = Array.isArray(result)
    ? (result as { name: string }[])
    : (result as { keys: { name: string }[] }).keys;
  // workerd 磁盘 KV 可能忽略 prefix 参数，统一在客户端再过滤一次
  return keys.filter((k) => k.name.startsWith(prefix));
};

// ---------- Plans ----------
/** 套餐存为单键 JSON 数组 */
export const getPlans = async (env: Env): Promise<Plan[]> => {
  const raw = await env.PLANS.get("plans");
  if (raw) return JSON.parse(raw) as Plan[];
  if (env.DEFAULT_PLANS && env.DEFAULT_PLANS !== "[]") return JSON.parse(env.DEFAULT_PLANS);
  return [];
};

export const savePlans = (env: Env, plans: Plan[]): Promise<void> =>
  env.PLANS.put("plans", JSON.stringify(plans));

// ---------- Tokens ----------
export const getTokenByUuid = async (env: Env, uuid: string): Promise<Token | null> => {
  const raw = await env.TOKENS.get(KV.TOKEN + uuid);
  return raw ? (JSON.parse(raw) as Token) : null;
};

/** 通过短 ID 反查 token（index 键存 uuid） */
export const getTokenById = async (env: Env, id: string): Promise<Token | null> => {
  const meta = await env.TOKENS.get(KV.TOKEN_BY_ID + id);
  if (!meta) return null;
  const { uuid } = JSON.parse(meta) as { uuid: string };
  return getTokenByUuid(env, uuid);
};

/** 写入 token（主键 + 反查索引各写一份） */
export const saveToken = async (env: Env, token: Token): Promise<void> => {
  await env.TOKENS.put(KV.TOKEN + token.uuid, JSON.stringify(token));
  await env.TOKENS.put(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

/** 删除某个 uuid 的 token 主键（rotate-uuid 时清理旧凭证用） */
export const deleteTokenByUuid = (env: Env, uuid: string): Promise<void> =>
  env.TOKENS.delete(KV.TOKEN + uuid);

// ---------- 设备槽位 ----------
/** 设备 uuid 反查索引：device:{uuid} → { token_id } */
export const saveDeviceIndex = (env: Env, uuid: string, tokenId: string): Promise<void> =>
  env.TOKENS.put(KV.DEVICE + uuid, JSON.stringify({ token_id: tokenId }));

export const deleteDeviceIndex = (env: Env, uuid: string): Promise<void> =>
  env.TOKENS.delete(KV.DEVICE + uuid);

/**
 * 按任意 uuid（主 uuid 或设备 uuid）定位 token。
 * 返回 token 与命中的设备（命中主 uuid 时 device 为 undefined）。
 */
export const getTokenByAnyUuid = async (
  env: Env,
  uuid: string
): Promise<{ token: Token; device?: Device } | null> => {
  const master = await getTokenByUuid(env, uuid);
  if (master) return { token: master };
  const idx = await env.TOKENS.get(KV.DEVICE + uuid);
  if (!idx) return null;
  const { token_id } = JSON.parse(idx) as { token_id: string };
  const token = await getTokenById(env, token_id);
  if (!token) return null;
  const device = token.devices?.find((d) => d.uuid === uuid);
  if (!device) return null;
  return { token, device };
};

// ---------- Tickets（用户反馈工单） ----------
export const getTicket = async (env: Env, id: string): Promise<Ticket | null> => {
  const raw = await env.TICKETS.get(KV.TICKET + id);
  return raw ? (JSON.parse(raw) as Ticket) : null;
};

export const saveTicket = (env: Env, ticket: Ticket): Promise<void> =>
  env.TICKETS.put(KV.TICKET + ticket.id, JSON.stringify(ticket));

/** 列出全部工单（按创建时间倒序） */
export const listTickets = async (env: Env): Promise<Ticket[]> => {
  const keys = await listKeys(env.TICKETS, KV.TICKET);
  const tickets: Ticket[] = [];
  for (const key of keys) {
    const raw = await env.TICKETS.get(key.name);
    if (raw) tickets.push(JSON.parse(raw) as Ticket);
  }
  return tickets.sort((a, b) => b.created_at - a.created_at);
};

// ---------- Orders ----------
export const getOrder = async (env: Env, id: string): Promise<Order | null> => {
  const raw = await env.ORDERS.get(KV.ORDER + id);
  return raw ? (JSON.parse(raw) as Order) : null;
};

/** 通过联系方式反查 token（找回功能） */
export const listTokensByContact = async (env: Env, contact: string): Promise<Token[]> => {
  const normalized = contact.trim().toLowerCase();
  const keys = await listKeys(env.TOKENS, KV.TOKEN);
  const tokens: Token[] = [];
  for (const key of keys) {
    const raw = await env.TOKENS.get(key.name);
    if (!raw) continue;
    const token = JSON.parse(raw) as Token;
    if ((token.contact ?? "").trim().toLowerCase() === normalized) {
      tokens.push(token);
    }
  }
  return tokens.sort((a, b) => (b.purchased_at ?? 0) - (a.purchased_at ?? 0));
};

/** 列出所有订单（按前缀扫描） */
export const listOrders = async (env: Env): Promise<Order[]> => {
  const keys = await listKeys(env.ORDERS, KV.ORDER);
  const orders: Order[] = [];
  for (const key of keys) {
    const raw = await env.ORDERS.get(key.name);
    if (raw) orders.push(JSON.parse(raw) as Order);
  }
  return orders.sort((a, b) => b.created_at - a.created_at);
};

export const saveOrder = (env: Env, order: Order): Promise<void> =>
  env.ORDERS.put(KV.ORDER + order.id, JSON.stringify(order));
