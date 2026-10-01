/**
 * 实时防共享裁决（Durable Object 路径）：节点 agent 60s 心跳驱动的全局并发判定。
 *
 * 背景：结算路径（/api/agent/traffic）上的 device-guard / share-guard 是纯事件驱动的
 * 兜底——持续在线的共享者对中心静默最长 24h，且 share-guard 只见单节点视图（跨节点
 * 并发没人汇总）。本模块用单个全局 DO 收齐各节点心跳，把发现延迟压到分钟级：
 *
 *   agent 每 60s POST /api/agent/presence {conns, ips}（不带流量数据）
 *     → 路由鉴权后注入 node.id 转发给本 DO（idFromName("global")）
 *     → 心跳先 prune 3min 未见的节点条目，再整快照替换本节点条目
 *     → 候选凭证（单节点 ≥2 IP / 全局并发 ≥2）按 60s 节拍反查 token KV
 *     → evaluateGlobalConns（纯函数）产出裁决 → 复用现有 lib 执行 → pushAuthRefresh
 *
 * 心跳状态全内存（不用 storage/alarm）：DO 被逐出后由后续心跳数分钟内重建，pending
 * 计时重置可容忍——所有处置副作用都落在 KV 且幂等（blocked_ips 并集、
 * share_suspended_at 存在即跳过），DO 不另建去重状态。
 *
 * 例外：本 DO 同时托管「通知邮件认领存储」（/notify-claim /notify-release，用
 * ctx.storage 持久化）——全站一次性/节流邮件的幂等唯一权威（替代旧 notify_log
 * 口头约定，后者在「并发请求拿同一旧快照 + KV 边缘缓存整写抹掉标记」下会重复发信）。
 * DO 单线程串行 + 持久化存储，认领天然原子。键量级 = token 数 × 几种 kind，
 * 可忽略，不做清理任务（200 天硬过期兜底防无限残留）。
 *
 * 与结算路径的关系：两条路径跑同一套状态机语义（阈值常量直接复用 lib 导出），
 * 结算路径保留作老 agent 未升级时的兜底；撞车时的幂等同样靠上述 KV 字段。
 *
 * 写库纪律：一律走现有合并函数（mergeDeviceGuardFields / mergeShareFields 经
 * evaluateShareConns / mergeTokenSettlement），绝不整 JSON 覆盖 token。
 */
import { DurableObject } from "cloudflare:workers";
import type { Device, DeviceGuardEntry, Plan, Token } from "../../../../shared/types";
import { getPlans, getTokenByAnyUuid, mapBatched } from "../lib/kv";
import { DG_CONFIRM_MS, mergeDeviceGuardFields, sendDeviceGuardEmail } from "../lib/device-guard";
import { CONN_OBSERVE_THRESHOLD, evaluateShareConns } from "../lib/share-guard";
import { lookupIpGeo } from "../lib/risk-notify";
import { pushAuthRefresh } from "../lib/authpush";
import type { Env } from "../types";

/** 节点条目过期：3min 未心跳的节点整体移除（agent 心跳 60s，容忍 2 次丢失） */
export const NODE_STALE_MS = 3 * 60_000;
/** 候选凭证的裁决节拍：同一 uuid 最多每 60s 反查一次 token KV 并推进状态机 */
export const EVAL_PACE_MS = 60_000;
/**
 * share 候选门槛：单凭证全局并发 ≥2 才反查 token 求同 token 跨凭证总和。
 * 取 2 而非观测带下沿 3：两台设备各 2 连接（单设备套餐已超标）需要靠求和才能抓到；
 * 低于 2 不可能构成任何超标。代价只是每分钟一次 token KV 读，当前规模可忽略。
 */
export const SHARE_CANDIDATE_MIN_CONNS = 2;

/** 单节点心跳快照里的凭证状态 */
export interface UuidConns {
  count: number;
  ips: string[];
}
/** DO 内存里的节点条目（at 为最近一次心跳时间，整节点过期用） */
export interface NodeEntry {
  at: number;
  uuids: Map<string, UuidConns>;
}
/**
 * device-guard 内存基线（key = `${nodeId}:${uuid}`）：DO 没有 presence.active_ips，
 * 用「首次见到的 IP 集」当基线，语义等价于结算路径的「新出现的 IP」；
 * seen=false 的首次并发只建基线不判定（与结算路径 prevIps 为空不判定一致）。
 */
export interface DgMemEntry {
  seen: boolean;
  baseline: Set<string>;
  pending?: { at: number; ips: string[] };
}

/** 裁决的候选凭证反查结果（getTokenByAnyUuid 同款形状） */
export interface CredInfo {
  token: Token;
  device?: Device;
}

export type Verdict =
  /** device-guard 实时版：单节点 per-uuid 多 IP 持续 3min 确认，阻断仍在在线的新 IP */
  | { kind: "dg"; nodeId: string; uuid: string; info: CredInfo; ips: string[]; prevIps: string[] }
  /** share-guard 实时版：同 token 全部凭证的跨节点并发总和，交 evaluateShareConns 走三轨状态机 */
  | { kind: "share"; info: CredInfo; total: number };

/** 跨节点聚合 per-uuid 并发总数（调用方已 prune 过期节点） */
export function perUuidTotals(nodes: Map<string, NodeEntry>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const entry of nodes.values()) {
    for (const [uuid, s] of entry.uuids) {
      totals.set(uuid, (totals.get(uuid) ?? 0) + s.count);
    }
  }
  return totals;
}

/**
 * 全局并发裁决（纯函数：只读写传入的内存结构，无任何 IO，单测直接构造夹具）。
 * infos 只含本拍反查到的候选凭证；不在 infos 里的 uuid 本轮不判定（节拍限制）。
 * dgMem 会被原地推进（pending/基线迁移）， verdicts 由调用方执行。
 */
export function evaluateGlobalConns(input: {
  nodes: Map<string, NodeEntry>;
  dgMem: Map<string, DgMemEntry>;
  infos: Map<string, CredInfo>;
  now: number;
}): Verdict[] {
  const { nodes, dgMem, infos, now } = input;
  const verdicts: Verdict[] = [];

  // ---- device-guard 实时版：单节点内 per-uuid ≥2 来源 IP → pending → 3min 确认 ----
  for (const [nodeId, entry] of nodes) {
    for (const [uuid, s] of entry.uuids) {
      if (s.ips.length < 2) continue;
      const info = infos.get(uuid);
      if (!info) continue; // 非本拍候选（节拍限制），下周跳再判
      const { token, device } = info;
      // 企业套餐团队共享是设计用途，不判定（与结算路径同口径）
      if (token.plan_id.startsWith("plan_biz")) continue;

      const key = `${nodeId}:${uuid}`;
      const mem = dgMem.get(key) ?? { seen: false, baseline: new Set<string>() };
      dgMem.set(key, mem);

      // 白名单 + 未到期过渡 IP 剔除；到期仍活跃的过渡 IP 是确证可疑（不受基线限制）
      const trans = (device ? device.transition_ips : token.transition_ips) ?? {};
      const expiredActive = Object.entries(trans)
        .filter(([ip, until]) => until <= now && s.ips.includes(ip))
        .map(([ip]) => ip);
      const allowed = new Set(device ? (device.allowed_ips ?? []) : (token.allowed_ips ?? []));
      for (const [ip, until] of Object.entries(trans)) if (until > now) allowed.add(ip);
      const effective = s.ips.filter((ip) => !allowed.has(ip));

      // 并发回落 <2：撤 pending；基线收养当前 IP（顺序换 IP/单设备是正常用法）
      if (effective.length < 2) {
        delete mem.pending;
        mem.baseline = new Set(effective);
        mem.seen = true;
        continue;
      }
      // 首次见到该凭证就并发：无法区分新老 IP，建基线不判定（同结算路径语义）
      if (!mem.seen) {
        mem.seen = true;
        mem.baseline = new Set(effective);
        continue;
      }
      const newIps = [...new Set([...effective.filter((ip) => !mem.baseline.has(ip)), ...expiredActive])];

      if (!mem.pending) {
        if (newIps.length > 0) mem.pending = { at: now, ips: newIps };
        continue;
      }
      if (now - mem.pending.at < DG_CONFIRM_MS) continue;
      const stillOnline = mem.pending.ips.filter((ip) => effective.includes(ip));
      if (stillOnline.length === 0) {
        // 可疑 IP 已全部离线（只是一次网络切换）：有新可疑就重记，否则清除
        if (newIps.length > 0) mem.pending = { at: now, ips: newIps };
        else delete mem.pending;
        continue;
      }
      // 确认成立：只阻断仍在在线的新 IP（老 IP 不动）；阻断过的 IP 并入基线防重复裁决
      verdicts.push({ kind: "dg", nodeId, uuid, info, ips: stillOnline, prevIps: [...mem.baseline] });
      delete mem.pending;
      for (const ip of stillOnline) mem.baseline.add(ip);
    }
  }

  // ---- share-guard 实时版：同 token 跨节点/跨凭证并发总和 ----
  const totals = perUuidTotals(nodes);
  const seenTokens = new Set<string>();
  for (const [uuid, info] of infos) {
    if ((totals.get(uuid) ?? 0) < SHARE_CANDIDATE_MIN_CONNS) continue;
    const tokenUuid = info.token.uuid;
    if (seenTokens.has(tokenUuid)) continue; // 同 token 多候选凭证只裁一次
    seenTokens.add(tokenUuid);
    // 同 token 的全部凭证（主 uuid + 设备槽位）求和——跨节点汇总正是 DO 路径的价值点
    let total = 0;
    for (const u of [info.token.uuid, ...(info.token.devices ?? []).map((d) => d.uuid)]) {
      total += totals.get(u) ?? 0;
    }
    // 出裁决的两种情形：越过观测带下沿（任何轨道都可能要行动，具体阈值交 evaluateShareConns）；
    // 或总量回落但 strikes 未清（让 evaluateShareConns 走清零分支——与结算路径同语义，
    // 部分节点心跳先到造成的欠载视图也会经这里自然纠正）
    if (total > CONN_OBSERVE_THRESHOLD || info.token.share_conn_strikes) {
      verdicts.push({ kind: "share", info, total });
    }
  }

  return verdicts;
}

/**
 * device-guard 基线随心跳维护（不等候选裁决）：首见/并发回落时收养当前原始 IP 集
 * （语义同结算路径 active_ips 逐周期覆写）。导出供 DO.applyHeartbeat 与单测夹具共用。
 */
export function applyDgBaseline(dgMem: Map<string, DgMemEntry>, nodeId: string, uuid: string, ips: string[]) {
  const key = `${nodeId}:${uuid}`;
  const mem = dgMem.get(key) ?? { seen: false, baseline: new Set<string>() };
  if (!mem.seen || ips.length < 2) {
    mem.seen = true;
    mem.baseline = new Set(ips);
    if (ips.length < 2) delete mem.pending; // 并发回落即撤销可疑（同裁决里的回落分支）
  }
  dgMem.set(key, mem);
}

/** POST /heartbeat 的请求体（路由侧注入鉴权后的 node.id，DO 不信任客户端自报） */
interface HeartbeatBody {
  nodeId?: string;
  conns?: Record<string, number>;
  ips?: Record<string, string[]>;
}

/** POST /notify-claim 的请求体：key 唯一标识一封通知（如 `trial_convert:{tokenId}`），ttlMs 供节流类键过期重领 */
interface NotifyClaimBody {
  key?: string;
  ttlMs?: number;
}

/** 认领键的硬过期兜底：200 天前的记录视为可重领（防一次性键永久残留，量级本就可忽略） */
export const NOTIFY_CLAIM_HARD_EXPIRE_MS = 200 * 86_400_000;

export class ShareGuardDO extends DurableObject<Env> {
  private nodes = new Map<string, NodeEntry>();
  private dgMem = new Map<string, DgMemEntry>();
  private lastEval = new Map<string, number>();

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
    const path = new URL(request.url).pathname;
    if (path === "/notify-claim" || path === "/notify-release") return this.handleNotifyClaim(request, path);
    const body = (await request.json().catch(() => null)) as HeartbeatBody | null;
    if (!body?.nodeId) return Response.json({ ok: false, error: "missing nodeId" }, { status: 400 });
    const now = Date.now();
    this.applyHeartbeat(body.nodeId, body.conns ?? {}, body.ips ?? {}, now);
    // 裁决含 KV 读/邮件/推送，不拖慢心跳应答；失败静默降级回结算路径兜底
    this.ctx.waitUntil(this.evaluate(now));
    return Response.json({ ok: true });
  }

  /**
   * 通知认领端点（邮件幂等的唯一权威，见文件头注释）：
   * - claim：键不存在 / 带 ttlMs 且已到期 / 老于 200 天硬过期 → put(now) 返回 claimed:true；
   *   否则 claimed:false。DO 单线程串行，读-判-写天然原子。
   * - release：删除认领键（重置类操作让同类通知可再发，如 reset-month 后月触顶可再通知）。
   */
  private async handleNotifyClaim(request: Request, path: string): Promise<Response> {
    const body = (await request.json().catch(() => null)) as NotifyClaimBody | null;
    if (!body?.key) return Response.json({ ok: false, error: "missing key" }, { status: 400 });
    const storeKey = `notify:${body.key}`;
    if (path === "/notify-release") {
      await this.ctx.storage.delete(storeKey);
      return Response.json({ ok: true });
    }
    const now = Date.now();
    const ts = await this.ctx.storage.get<number>(storeKey);
    const expired = body.ttlMs !== undefined && ts !== undefined && now - ts >= body.ttlMs;
    const hardExpired = ts !== undefined && now - ts >= NOTIFY_CLAIM_HARD_EXPIRE_MS;
    if (ts === undefined || expired || hardExpired) {
      await this.ctx.storage.put(storeKey, now);
      return Response.json({ ok: true, claimed: true });
    }
    return Response.json({ ok: true, claimed: false });
  }

  /** 心跳落内存：先 prune 过期节点，再整快照替换本节点条目（uuid 级不做 TTL，随快照全量覆盖） */
  private applyHeartbeat(nodeId: string, conns: Record<string, number>, ips: Record<string, string[]>, now: number) {
    for (const [id, entry] of this.nodes) {
      if (now - entry.at > NODE_STALE_MS) this.nodes.delete(id);
    }
    const uuids = new Map<string, UuidConns>();
    for (const u of new Set([...Object.keys(conns), ...Object.keys(ips)])) {
      const count = Math.max(0, Math.round(conns[u] ?? 0));
      const ipList = (ips[u] ?? []).filter((ip) => typeof ip === "string" && ip.length > 0);
      if (count <= 0 && ipList.length === 0) continue;
      uuids.set(u, { count, ips: ipList });
    }
    this.nodes.set(nodeId, { at: now, uuids });
    // device-guard 基线维护随心跳走（不等候选裁决）：否则「先单 IP 后双 IP」的场景会因
    // 裁决节拍没跑过而缺失基线，把首见并发直接当基线漏判
    for (const [uuid, s] of uuids) applyDgBaseline(this.dgMem, nodeId, uuid, s.ips);
    // 内存表惰性修剪：防 dgMem/lastEval 在长跑 DO 里无限增长（节点已过期/消失的条目清掉）
    if (this.dgMem.size > 5000) {
      for (const key of this.dgMem.keys()) {
        if (!this.nodes.has(key.slice(0, key.indexOf(":")))) this.dgMem.delete(key);
      }
    }
    if (this.lastEval.size > 10000) {
      for (const [u, at] of this.lastEval) if (now - at > 86_400_000) this.lastEval.delete(u);
    }
  }

  /** 一拍裁决：候选收集 → 节拍限制 → 反查 token → 纯函数裁决 → 执行 → 推送 */
  private async evaluate(now: number): Promise<void> {
    try {
      const totals = perUuidTotals(this.nodes);
      const candidates = new Set<string>();
      for (const entry of this.nodes.values()) {
        for (const [uuid, s] of entry.uuids) if (s.ips.length >= 2) candidates.add(uuid);
      }
      for (const [uuid, total] of totals) {
        if (total >= SHARE_CANDIDATE_MIN_CONNS) candidates.add(uuid);
      }
      const due = [...candidates].filter((u) => now - (this.lastEval.get(u) ?? 0) >= EVAL_PACE_MS);
      if (due.length === 0) return;

      const infos = new Map<string, CredInfo>();
      await mapBatched(due, async (uuid) => {
        this.lastEval.set(uuid, now); // 先占节拍：反查失败也等下一拍，防故障热循环
        const found = await getTokenByAnyUuid(this.env, uuid);
        // 只裁决 active token（与结算路径 settleByToken 的过滤一致）
        if (found && found.token.status === "active") infos.set(uuid, found);
      });
      if (infos.size === 0) return;

      const plansById = new Map((await getPlans(this.env)).map((p) => [p.id, p]));
      const verdicts = evaluateGlobalConns({ nodes: this.nodes, dgMem: this.dgMem, infos, now });

      let authChanged = false;
      for (const v of verdicts) {
        if (v.kind === "dg") {
          authChanged = (await this.executeDeviceGuard(v, plansById, now)) || authChanged;
        } else {
          // 状态机/阈值/邮件/节流全部复用结算路径同款函数
          authChanged = (await evaluateShareConns(this.env, v.info.token, v.total, plansById, now)) || authChanged;
        }
      }
      if (authChanged) await pushAuthRefresh(this.env);
    } catch (e) {
      // 裁决失败不抛：DO 是增强路径，故障时行为等同今天（结算路径兜底）
      console.error("[share-guard-do] evaluate failed:", (e as Error).message);
    }
  }

  /** device-guard 裁决执行：复用结算路径的合并写 + 通知邮件 + 台账语义 */
  private async executeDeviceGuard(
    v: Extract<Verdict, { kind: "dg" }>,
    plansById: Map<string, Plan>,
    now: number
  ): Promise<boolean> {
    const { token, device } = v.info;
    const blocked = await Promise.all(
      v.ips.map(async (ip) => {
        const g = await lookupIpGeo(this.env, ip).catch(() => null);
        return { ip, geo: g ? [g.country, g.region, g.city, g.isp].filter(Boolean).join(" / ") : undefined };
      })
    );
    const entries: Record<string, DeviceGuardEntry> = {};
    for (const b of blocked) entries[b.ip] = { uuid: v.uuid, at: now, status: "pending", ...(b.geo ? { geo: b.geo } : {}) };
    const written = await mergeDeviceGuardFields(this.env, token.uuid, {
      blocked_ips_add: v.ips,
      device_guard: entries,
    });
    if (!written) return false; // 封禁列表已满：mergeDeviceGuardFields 已记日志

    // 12h 内压掉 ip_change 提醒（阻断另有专函）。直接写认领存储而非走 /notify-claim HTTP：
    // 本对象正是 SHARE_GUARD 的 "global" 实例，handler 内 fetch 自身 stub 会卡输入门死锁
    await this.ctx.storage.put(`notify:ip_change:${token.id}`, now);

    // 邮件经队列消费者认领去重（dedup key），本路径不再碰 notify_log 节流键
    const maxDevices = token.max_devices ?? plansById.get(token.plan_id)?.max_devices ?? 2;
    await sendDeviceGuardEmail(this.env, token, device?.name ?? "主设备", blocked, v.prevIps, now, maxDevices);
    console.log(`[share-guard-do] dg blocked ${token.id} uuid=${v.uuid.slice(0, 8)}… ips=${v.ips.length}`);
    return true; // 新增阻断：推送全节点刷新，blocked_ips 随快照下发 iptables
  }
}
