/**
 * 节点管理 KV 数据访问层
 *
 * 存储分两层：
 * - 注册表：KV.NODES -> Node[]（id/key/name/host 等静态配置，仅管理接口写，低频单写者）
 * - 动态状态：nodestat:<id> -> 心跳/流量/告警水位（agent 每 30s 高频写）
 *
 * 拆分原因：Cloudflare KV 是最终一致 + 多 PoP 并发写同一键会互相覆盖（丢更新），
 * 心跳/流量若走整表读-改-写会导致其他节点的时间戳被旧快照顶回去。
 * 读取时 getNodes 把两层合并，调用方无感知。
 */
import { KV, type Node } from "../../../../shared/types";
import type { Env } from "../types";

/** 动态字段：写入 nodestat:<id>，不进注册表 */
const STAT_FIELDS = [
  "last_seen_at",
  "stats_updated_at",
  "total_bytes",
  "last_node_total_bytes",
  "month_key",
  "month_bytes",
  "online_count",
  "budget_alert_level",
  "billing_mode",
  "offline_alerted_at",
  "probe_online",
  "probe_at",
] as const;

const statKey = (id: string): string => `nodestat:${id}`;

/**
 * getNodes 的 isolate 内存缓存（TTL 60s）：/api/sub、agent 鉴权快照、authpush
 * 都是读高频路径，每次 1+N 次 KV get；节点注册表是低频单写者（管理接口），
 * 动态状态（心跳/流量）60s 内的滞后对订阅与配额判定无影响。
 * 注意多 isolate 各有缓存，saveNodes 的失效只清本 isolate，其余最晚 TTL 到期收敛。
 */
const NODES_CACHE_TTL = 60_000;
let nodesCache: { at: number; nodes: Node[] } | null = null;

/** 注册表变更后调用：清本 isolate 的节点缓存（其他 isolate 最晚 60s 后收敛） */
export const invalidateNodesCache = (): void => {
  nodesCache = null;
};

export const getNodes = async (env: Env): Promise<Node[]> => {
  // 返回深拷贝：多个调用方（probe-state / POST / PUT）会原地改数组与节点对象，
  // 直接给缓存引用会污染后续命中者
  if (nodesCache && Date.now() - nodesCache.at < NODES_CACHE_TTL) {
    return structuredClone(nodesCache.nodes);
  }
  const raw = await env.NODES.get(KV.NODES);
  let registry: Node[] = [];
  if (raw) {
    try {
      registry = JSON.parse(raw) as Node[];
    } catch {
      return [];
    }
  }
  if (registry.length === 0) return [];
  // 按注册表 id 直取各节点状态键：不用 list（KV list 配额极低且贵），
  // get 计入 reads（额度远高于 list），且节点数少、并发开销可忽略
  const entries = await Promise.all(
    registry.map(async (n) => {
      const v = await env.NODES.get(statKey(n.id));
      let stat: Partial<Node> = {};
      try {
        if (v) stat = JSON.parse(v) as Partial<Node>;
      } catch {
        // 单条损坏不影响整体
      }
      return [n.id, stat] as const;
    })
  );
  const statsById = new Map(entries);
  const merged = registry.map((n) => ({ ...n, ...(statsById.get(n.id) ?? {}) }));
  nodesCache = { at: Date.now(), nodes: merged };
  return structuredClone(merged);
};

/** 保存注册表（静态配置）。动态字段会被剥离，由 saveNodeStat 单独持久化 */
export const saveNodes = async (env: Env, nodes: Node[]): Promise<void> => {
  await env.NODES.put(
    KV.NODES,
    JSON.stringify(
      nodes.map((n) => {
        const copy = { ...n } as Record<string, unknown>;
        for (const f of STAT_FIELDS) delete copy[f];
        return copy;
      })
    )
  );
  invalidateNodesCache();
};

/** 保存单节点动态状态（合并写，单键单写者，无整表竞争） */
export const saveNodeStat = async (env: Env, node: Node): Promise<void> => {
  const key = statKey(node.id);
  let stat: Record<string, unknown> = {};
  try {
    const raw = await env.NODES.get(key);
    if (raw) stat = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // 损坏则以空为基础重写
  }
  const src = node as unknown as Record<string, unknown>;
  for (const f of STAT_FIELDS) {
    if (src[f] !== undefined) stat[f] = src[f];
  }
  await env.NODES.put(key, JSON.stringify(stat));
};

export const deleteNodeStat = (env: Env, id: string): Promise<void> =>
  env.NODES.delete(statKey(id));

export const getNodeByKey = async (env: Env, key: string): Promise<Node | null> => {
  const nodes = await getNodes(env);
  return nodes.find((n) => n.key === key) ?? null;
};

export const getNodeById = async (env: Env, id: string): Promise<Node | null> => {
  const nodes = await getNodes(env);
  return nodes.find((n) => n.id === id) ?? null;
};

/** 当前自然月账期标识（UTC），如 "2026-08" */
export const currentMonthKey = (now = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * 节点在线判定。优先用中心主动探测结果（probe-nodes.sh 从国内 ping 节点，
 * 只在状态翻转时写 KV）；没有探测数据时回退到 agent 上报的 last_seen_at。
 * agent 已是纯事件驱动（断联/超量才上报），last_seen 粒度很粗，仅作兜底。
 */
export const isNodeOnline = (
  node: Pick<Node, "probe_online" | "probe_at" | "last_seen_at">,
  now = Date.now()
): boolean => {
  // 探测结果 90 分钟内有效（探测每 5 分钟一次，状态不变时每 60 分钟刷新一次时间戳）；
  // 更旧说明探测本身停了，回退到 last_seen 兜底
  if (node.probe_at && now - node.probe_at < 90 * 60_000) return node.probe_online ?? false;
  return (node.last_seen_at ?? 0) > now - 40 * 60_000;
};

/** 节点当月流量是否已超配额（超配额节点应从订阅与同步中摘除） */
export const isBudgetExhausted = (node: Node, now = new Date()): boolean => {
  if (!node.monthly_budget_gb) return false;
  if (node.month_key !== currentMonthKey(now)) return false; // 跨月未重置时视为未超
  const usedGb = (node.month_bytes ?? 0) / 1024 ** 3;
  return usedGb >= node.monthly_budget_gb;
};
