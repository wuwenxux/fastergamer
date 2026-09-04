/**
 * KV 数据访问层
 * 键规则见 shared/types.ts 的 KV 常量
 */
import { KV, type Device, type Order, type Plan, type Presence, type Ticket, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * KV list 封装：按前缀列出键名。
 * list 单次最多返回 1000 键，用 cursor 翻页拿全，避免超量后静默截断。
 */
export const listKeys = async (
  ns: KVNamespace,
  prefix: string
): Promise<{ name: string }[]> => {
  const keys: { name: string }[] = [];
  let cursor: string | undefined;
  do {
    const result = await ns.list({ prefix, cursor });
    keys.push(...result.keys);
    cursor = result.list_complete ? undefined : result.cursor || undefined;
  } while (cursor);
  return keys;
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

/**
 * 只写 token 主键。反查索引（tokenid:）自创建后内容不变，
 * 流量结算这类高频路径用它省掉一次冗余索引写（CF KV 免费版 1k 写/天）。
 * 注意：token.id 变更（rotate）后必须走 saveToken 补索引。
 */
export const saveTokenValue = (env: Env, token: Token): Promise<void> =>
  env.TOKENS.put(KV.TOKEN + token.uuid, JSON.stringify(token));

/** 删除某个 uuid 的 token 主键（rotate-uuid 时清理旧凭证用） */
export const deleteTokenByUuid = (env: Env, uuid: string): Promise<void> =>
  env.TOKENS.delete(KV.TOKEN + uuid);

/**
 * 重置 token 的连接凭证（UUID）：旧 uuid 立即失效（主键 + presence 一并删除），
 * 新 uuid 落库；多设备标记/在线状态随旧凭证清掉。套餐、到期时间、已用流量不变。
 * 调用方负责鉴权与 pushAuthRefresh。
 */
export const rotateTokenUuid = async (env: Env, token: Token): Promise<void> => {
  const oldUuid = token.uuid;
  token.uuid = crypto.randomUUID();
  // 重置凭证后旧的多设备标记/在线状态失去意义，一并清掉
  delete token.multi_device_detected_at;
  delete token.online_by_node;
  token.online = false;
  delete token.notify_log?.multi_device;
  await deleteTokenByUuid(env, oldUuid);
  // 在线状态存 presence:{uuid}（按旧 uuid 索引），随旧凭证一并清理
  await env.TOKENS.delete(KV.PRESENCE + oldUuid);
  await saveToken(env, token);
};

// ---------- Presence（高频动态状态，与 token 主键解耦） ----------
export const getPresence = async (env: Env, uuid: string): Promise<Presence | null> => {
  const raw = await env.TOKENS.get(KV.PRESENCE + uuid);
  return raw ? (JSON.parse(raw) as Presence) : null;
};

/** 从 token JSON 旧字段构造 Presence（存量数据兼容回退用） */
const presenceFromToken = (token: Token): Presence => ({
  online: token.online,
  online_updated_at: token.online_updated_at,
  online_by_node: token.online_by_node,
  last_active_at: token.last_active_at,
  traffic_by_ip: token.traffic_by_ip,
  active_ips: token.active_ips,
});

/**
 * 读取 token 的动态状态：presence:{uuid} 键存在则以它为准；
 * 不存在时回退 token JSON 内的旧字段（存量数据兼容）。
 */
export const getTokenPresence = async (env: Env, token: Token): Promise<Presence> =>
  (await getPresence(env, token.uuid)) ?? presenceFromToken(token);

/**
 * presence 有变化才写（与读取时的基准做 JSON 比较），无变化跳过，省 KV 写配额。
 * base 必须是读取后、修改前的深拷贝（嵌套对象会被原地修改）。
 */
export const savePresenceIfChanged = async (
  env: Env,
  uuid: string,
  base: Presence,
  next: Presence
): Promise<void> => {
  if (JSON.stringify(base) === JSON.stringify(next)) return;
  await env.TOKENS.put(KV.PRESENCE + uuid, JSON.stringify(next));
};

/** 结算补丁：只含结算路径拥有的 token 字段 */
export interface TokenSettlementPatch extends Partial<Token> {
  /** 设备级结算字段按设备 uuid 定点合并，避免整体覆盖并发增删的设备槽位 */
  device_usage?: { uuid: string; traffic_used_gb?: number; last_active_at?: number };
}

/**
 * 结算字段的「重读-合并」写：重新读取 token 最新副本，只把补丁里的结算字段覆盖上去再写回，
 * 并发用户操作（加设备/封 IP 等）改过的其他字段不丢。
 * - notify_log 按键级合并：并发路径（结算/notify-scan）各自新增的提醒记录互不覆盖；
 * - traffic_by_node / traffic_total_by_node / billing_by_node 同样按键级合并：
 *   每个结算写者只动自己节点的键，整 map 覆盖会让并发跨节点结算互相顶回旧值
 *   （丢量 + 基线回滚导致下轮重复计）；这些字段不存在"清空"语义（重置走
 *   traffic_offset_bytes 偏移），逐键合并安全；
 * - patch 里值为 undefined 的键会被忽略（不会误删最新副本上的既有字段）；
 * - token 已不存在（删除/rotate）时直接丢弃本次结算。
 */
export const mergeTokenSettlement = async (
  env: Env,
  uuid: string,
  patch: TokenSettlementPatch
): Promise<void> => {
  const fresh = await getTokenByUuid(env, uuid);
  if (!fresh) return;
  const { device_usage, ...fields } = patch;
  if (fields.notify_log) {
    fresh.notify_log = { ...fresh.notify_log, ...fields.notify_log };
    delete fields.notify_log;
  }
  for (const f of ["traffic_by_node", "traffic_total_by_node", "billing_by_node"] as const) {
    const m = fields[f] as Record<string, unknown> | undefined;
    if (m) {
      const bag = fresh as unknown as Record<string, Record<string, unknown> | undefined>;
      bag[f] = { ...(bag[f] ?? {}), ...m };
      delete fields[f];
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) (fresh as unknown as Record<string, unknown>)[k] = v;
  }
  if (device_usage) {
    const dev = fresh.devices?.find((d) => d.uuid === device_usage.uuid);
    if (dev) {
      if (device_usage.traffic_used_gb !== undefined) dev.traffic_used_gb = device_usage.traffic_used_gb;
      if (device_usage.last_active_at !== undefined) dev.last_active_at = device_usage.last_active_at;
    }
  }
  await saveTokenValue(env, fresh);
};

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

