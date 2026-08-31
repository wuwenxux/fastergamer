/**
 * 授权名单 + 节点列表 + 用量基数的共享快照。各节点定期拉一次 /config，
 * 逐请求全量扫 token KV 在 Cloudflare 上会打爆 list/reads 配额（免费版 1k lists/天）。
 * 快照存 KV 单键 authcache:snapshot，TTL 内全局共享；平时每次请求仅 1 次 get。
 * usage 供 agent 本地做配额强制：本地用量 = usage.used + 本机未结算增量。
 * 代价：撤销/过期/续费的生效延迟最坏 ~TTL + agent 拉取周期，可接受；
 * 授权变更点（激活/撤销/设备/节点注册表等）会主动推送节点立即刷新（见 lib/authpush）。
 */
import { KV, type Node, type Token } from "../../../../shared/types";
import { listKeys } from "./kv";
import { getNodes, isBudgetExhausted } from "./nodes";
import type { Env } from "../types";

/**
 * 流量耗尽后的宽限期：不立即断连，先邮件引导续费，宽限期内可正常接入，
 * 超过宽限期仍未处理（续费/重置）才切断。
 */
export const TRAFFIC_GRACE_MS = 48 * 3_600_000;

/** 流量准入：不限量（上限 ≤ 0）直接放行；否则未超限，或超限但仍在宽限期内 */
export const withinTrafficAllowance = (token: Token, now: number): boolean => {
  if (token.traffic_limit_gb <= 0) return true;
  if (token.traffic_used_gb < token.traffic_limit_gb) return true;
  return !!token.traffic_exhausted_at && now - token.traffic_exhausted_at < TRAFFIC_GRACE_MS;
};

const AUTH_CACHE_TTL_MS = 300_000; // 5min：快照重建是 1 次写，≈288 写/天，免费版可承受
export const AUTH_SNAPSHOT_KEY = "authcache:snapshot";

export interface AuthSnapshot {
  ts: number;
  uuids: string[];
  /**
   * 全部 token 封禁 IP 的全局合集。保留给旧 agent 兼容（iptables 整节点阻断，
   * 同 NAT 用户会误伤）；新 agent 优先用 blockedByUuid 做 per-(uuid, IP) 阻断。
   */
  blockedIps: string[];
  /**
   * per-(uuid, IP) 封禁表：只含当前授权名单内 token（主 + 设备 uuid）的 blocked_ips。
   * 新 agent 据此生成 xray 路由规则（user + sourceIP → blackhole），
   * 只断该用户从被封 IP 的接入，同 NAT 出口下的其他用户不受影响。
   */
  blockedByUuid: Record<string, string[]>;
  nodes: Array<Pick<Node, "name" | "region" | "host" | "port" | "tls" | "ws_path">>;
  /** 每 uuid（主 + 设备）的用量基数与限额（字节）；limit=0 表示不限量 */
  usage: Record<string, { used: number; limit: number; exhausted_at: number | null }>;
}

export async function getAuthSnapshot(env: Env): Promise<AuthSnapshot> {
  const cached = await env.TOKENS.get<AuthSnapshot>(AUTH_SNAPSHOT_KEY, "json").catch(() => null);
  if (cached && Date.now() - cached.ts < AUTH_CACHE_TTL_MS) return cached;
  try {
    const snap = await computeAuthSnapshot(env);
    // 写快照也算一次 KV write；TTL 5min ≈ 288 写/天，免费版 1k/天 可承受
    await env.TOKENS.put(AUTH_SNAPSHOT_KEY, JSON.stringify(snap)).catch(() => {});
    return snap;
  } catch {
    // KV 配额耗尽（list/reads 打满）时用陈旧快照兜底，宁可名单滞后也不让节点同步全挂
    if (cached) return cached;
    throw new Error("auth snapshot unavailable");
  }
}

export async function computeAuthSnapshot(env: Env) {
  const now = Date.now();
  const uuids: string[] = [];
  const blockedIps = new Set<string>();
  const blockedByUuid: AuthSnapshot["blockedByUuid"] = {};
  const usage: AuthSnapshot["usage"] = {};
  const keys = await listKeys(env.TOKENS, KV.TOKEN);
  for (const k of keys) {
    const raw = await env.TOKENS.get(k.name);
    if (!raw) continue;
    const token = JSON.parse(raw) as Token;
    for (const ip of token.blocked_ips ?? []) blockedIps.add(ip);
    if (
      token.status === "active" &&
      (token.expires_at ?? 0) > now &&
      withinTrafficAllowance(token, now)
    ) {
      uuids.push(token.uuid);
      for (const d of token.devices ?? []) uuids.push(d.uuid);
      // per-(uuid, IP) 封禁表只给名单内 uuid（同设备 uuid 共享 token 的封禁列表），
      // 过期/撤销的 token 不下发，节点路由规则随名单同步收敛
      const ips = token.blocked_ips ?? [];
      if (ips.length > 0) {
        blockedByUuid[token.uuid] = ips;
        for (const d of token.devices ?? []) blockedByUuid[d.uuid] = ips;
      }
      // 用量基数只给名单内 uuid（agent 本地配额强制用：本地用量 = used + 未结算增量）
      const entry = {
        used: Math.round(token.traffic_used_gb * 1024 ** 3),
        limit: token.traffic_limit_gb > 0 ? Math.round(token.traffic_limit_gb * 1024 ** 3) : 0,
        exhausted_at: token.traffic_exhausted_at ?? null,
      };
      usage[token.uuid] = entry;
      for (const d of token.devices ?? []) usage[d.uuid] = entry;
    }
  }
  const nodes = (await getNodes(env))
    .filter((n) => n.active && !isBudgetExhausted(n))
    .map((n) => ({
      name: n.name,
      region: n.region,
      host: n.host,
      port: n.port,
      tls: n.tls,
      ws_path: n.ws_path,
    }));
  const snap: AuthSnapshot = { ts: now, uuids, blockedIps: [...blockedIps], blockedByUuid, nodes, usage };
  return snap;
}
