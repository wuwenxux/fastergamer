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
 * 另有两个 alarm 巡检能力（ctx.storage.setAlarm 每 2 分钟，首次心跳 arm，alarm 末尾
 * 无条件 re-arm，异常 catch 记日志——闹钟断档 = 巡检静默失效）：
 * - 节点失联告警：lastBeat（nodeId→最近心跳，不随 3min prune）里沉默超 5 分钟的节点，
 *   先查注册表确认 active===true（下线节点停止心跳是正常退役，绝不误报），一次性
 *   认领键 node_silent:{nodeId} 告警站长；恢复（心跳回新鲜）释放认领键并发恢复邮件
 *   （node_silent_back:{nodeId} 节流 1h 防抖动刷屏）。从未上报过心跳的老 agent 节点
 *   不在 lastBeat 里，天然不告警。这管「agent→CF 链路/agent 死活」的分钟级发现，
 *   probe-nodes 的 5 分钟 cron 仍管大陆→节点的用户视角探测，两者互补。
 * - 扫号/异常来源 IP 检测（只告警不自动封）：ipHits（ip→uuid→lastSeen，内存，DO 重启
 *   丢窗口数据可接受——窗口只 10 分钟）里同一来源 IP 10 分钟触碰 ≥5 个不同 uuid →
 *   告警站长（scan_ip:{ip} 节流 24h）。校园网/企业 NAT 出口可能误报，邮件注明先观察。
 * - GET /stats：从内存聚合实时在线（per-node 在线凭证数/连接数 + 全局去重合计），
 *   供 /api/admin/online-live 的管理端看板 30s 轮询；5 分钟未心跳的节点标 stale。
 *
 * 认领存储的死锁纪律：DO handler（含 alarm）内不能 fetch 自身 stub 走 /notify-claim
 * （持有输入门时自调用会死锁），一律用 claimLocal 直写 ctx.storage（同一套语义）。
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
import { getNodes } from "../lib/nodes";
import { DG_CONFIRM_MS, mergeDeviceGuardFields, sendDeviceGuardEmail } from "../lib/device-guard";
import { CONN_OBSERVE_THRESHOLD, evaluateShareConns } from "../lib/share-guard";
import { lookupIpGeo, notifyAdmin } from "../lib/risk-notify";
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

/** alarm 巡检节拍：节点失联告警 + 扫号检测共用一轮 */
export const ALARM_INTERVAL_MS = 2 * 60_000;
/** 节点沉默判定：5 分钟无心跳（agent 60s 节拍，容忍 ~4 次丢失；短于它容易把网络抖动当失联） */
export const NODE_SILENT_MS = 5 * 60_000;
/** 恢复通知节流：同节点 1h 最多一封（失联-恢复抖动不刷屏） */
export const NODE_BACK_NOTIFY_TTL_MS = 3_600_000;
/** 扫号窗口：同一来源 IP 在该窗口内触碰的不同 uuid 数 */
export const SCAN_WINDOW_MS = 10 * 60_000;
/** 扫号阈值：≥5 个不同 uuid 才告警（同人多设备/重启换指纹属正常，4 个以内不打扰） */
export const SCAN_UUID_THRESHOLD = 5;
/** 扫号告警节流：同 IP 24h 最多一封 */
export const SCAN_NOTIFY_TTL_MS = 24 * 3_600_000;
/** ipHits 内存上限：超过按最旧活跃淘汰（防扫段/伪造源打爆 DO 内存） */
export const SCAN_MAX_IPS = 10_000;

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
  /** nodeId → 最近一次心跳时间：不随 nodes 的 3min prune（失联告警要知道「最后心跳是多久前」）。
   *  量级 = 注册节点数（几十），不修剪；节点是否该告警由注册表 active 闸门裁决 */
  private lastBeat = new Map<string, number>();
  /** 已告警的沉默节点（内存镜像，持久真相是认领存储的 node_silent:* 键，DO 重启后首次 alarm 重建） */
  private alertedSilent = new Set<string>();
  private alertedLoaded = false;
  private alarmArmed = false;
  /** 扫号检测窗口数据：来源 ip → uuid → lastSeen（只进内存不落 KV，DO 重启丢窗口可接受） */
  private ipHits = new Map<string, Map<string, number>>();

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // 实时在线看板（管理端经 /api/admin/online-live 转发）：内存聚合，无 KV 读
    if (request.method === "GET" && path === "/stats") return this.handleStats();
    if (request.method !== "POST") return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
    if (path === "/notify-claim" || path === "/notify-release") return this.handleNotifyClaim(request, path);
    const body = (await request.json().catch(() => null)) as HeartbeatBody | null;
    if (!body?.nodeId) return Response.json({ ok: false, error: "missing nodeId" }, { status: 400 });
    const now = Date.now();
    this.applyHeartbeat(body.nodeId, body.conns ?? {}, body.ips ?? {}, now);
    // 首次心跳 arm 巡检闹钟（DO 重启后 alarm 持久化仍在、会自己 re-arm，这里只需补全新 DO 的第一次）
    if (!this.alarmArmed) {
      this.alarmArmed = true;
      this.ctx.waitUntil(this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS));
    }
    // 裁决含 KV 读/邮件/推送，不拖慢心跳应答；失败静默降级回结算路径兜底
    this.ctx.waitUntil(this.evaluate(now));
    return Response.json({ ok: true });
  }

  /**
   * 巡检闹钟：节点失联告警/恢复 + 扫号检测。无论成败都 re-arm（闹钟是巡检的唯一驱动，
   * 断档 = 告警静默失效）；异常只记日志，下一轮再试。
   */
  async alarm(): Promise<void> {
    try {
      await this.checkSilentNodes(Date.now());
      await this.checkScanIps(Date.now());
    } catch (e) {
      console.error("[share-guard-do] alarm failed:", (e as Error).message);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
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
    if (path === "/notify-release") {
      await this.ctx.storage.delete(`notify:${body.key}`);
      return Response.json({ ok: true });
    }
    return Response.json({ ok: true, claimed: await this.claimLocal(body.key, body.ttlMs) });
  }

  /**
   * 认领存储的本地裁决（与 /notify-claim 同一语义，供 alarm 等 DO 内部路径用——
   * handler 内 fetch 自身 stub 会卡输入门死锁，故直写 ctx.storage）。
   * 键不存在 / ttlMs 到期 / 老于硬过期 → put(now) 认领成功；否则 false。
   */
  private async claimLocal(key: string, ttlMs?: number): Promise<boolean> {
    const now = Date.now();
    const ts = await this.ctx.storage.get<number>(`notify:${key}`);
    const expired = ttlMs !== undefined && ts !== undefined && now - ts >= ttlMs;
    const hardExpired = ts !== undefined && now - ts >= NOTIFY_CLAIM_HARD_EXPIRE_MS;
    if (ts === undefined || expired || hardExpired) {
      await this.ctx.storage.put(`notify:${key}`, now);
      return true;
    }
    return false;
  }

  /**
   * 节点失联告警/恢复（alarm 驱动，分钟级发现「agent→CF 链路/agent 死活」）：
   * - lastBeat 里沉默超 NODE_SILENT_MS 的节点，先查注册表确认 active===true 再告警
   *  （下线的节点停止心跳是正常退役，绝不误报；注册表只在有候选时读一次）；
   * - 恢复（心跳回新鲜）：释放 node_silent 认领键 + 发恢复邮件（1h 节流防抖动刷屏）；
   * - 从未上报过心跳的节点不在 lastBeat 里，天然不告警。
   * alertedSilent 的持久真相是认领存储：DO 重启内存丢失后首次 alarm 从 storage 重建。
   */
  private async checkSilentNodes(now: number): Promise<void> {
    if (!this.alertedLoaded) {
      const stored = await this.ctx.storage.list({ prefix: "notify:node_silent:" });
      this.alertedSilent = new Set([...stored.keys()].map((k) => k.slice("notify:node_silent:".length)));
      this.alertedLoaded = true;
    }
    const silentIds = [...this.lastBeat.entries()]
      .filter(([, at]) => now - at > NODE_SILENT_MS)
      .map(([id]) => id);
    const recoveredIds = [...this.lastBeat.entries()]
      .filter(([id, at]) => now - at <= NODE_SILENT_MS && this.alertedSilent.has(id))
      .map(([id]) => id);
    if (silentIds.length === 0 && recoveredIds.length === 0) return;

    const byId = new Map((await getNodes(this.env)).map((n) => [n.id, n]));
    for (const id of silentIds) {
      if (this.alertedSilent.has(id)) continue;
      const node = byId.get(id);
      if (!node || node.active !== true) continue;
      this.alertedSilent.add(id); // 先记账：认领失败（极端竞争）也不会同轮重复发
      if (!(await this.claimLocal(`node_silent:${id}`))) continue; // 已告警过（存储真相）
      const agoMin = Math.round((now - (this.lastBeat.get(id) ?? now)) / 60_000);
      await notifyAdmin(
        this.env,
        `节点失联：${node.name}`,
        `<p>节点 <strong>${node.name}</strong>（${node.region}，${node.host}）已超过 ${agoMin} 分钟没有心跳上报。</p>
         <p>可能原因：VPS 宕机 / agent 进程挂掉 / 节点到 Cloudflare 链路中断。用户侧可用性请以 probe-nodes 探测为准；请登录服务器检查 agent 与 Xray 状态。</p>`,
        `节点 ${node.name}（${node.region}，${node.host}）已超过 ${agoMin} 分钟没有心跳上报。可能原因：VPS 宕机 / agent 挂掉 / 节点到 CF 链路中断。用户侧可用性以 probe-nodes 为准，请登录检查。`
      );
    }
    for (const id of recoveredIds) {
      this.alertedSilent.delete(id);
      await this.ctx.storage.delete(`notify:node_silent:${id}`);
      // 恢复邮件 1h 节流：失联-恢复反复抖动时只通知第一封
      if (!(await this.claimLocal(`node_silent_back:${id}`, NODE_BACK_NOTIFY_TTL_MS))) continue;
      const node = byId.get(id);
      const name = node ? `${node.name}（${node.region}）` : id;
      await notifyAdmin(
        this.env,
        `节点恢复：${name}`,
        `<p>节点 <strong>${name}</strong> 心跳已恢复（此前曾失联告警）。如非预期运维操作，建议检查节点稳定性。</p>`,
        `节点 ${name} 心跳已恢复（此前曾失联告警）。如非预期运维操作，建议检查节点稳定性。`
      );
    }
  }

  /**
   * 扫号/异常来源 IP 检测（只告警不自动封）：prune 窗口外记录后，同一来源 IP
   * 10 分钟内触碰 ≥SCAN_UUID_THRESHOLD 个不同 uuid → 告警站长（同 IP 24h 节流）。
   * 校园网/企业 NAT 出口可能误报，邮件注明先观察不处置。
   */
  private async checkScanIps(now: number): Promise<void> {
    for (const [ip, hits] of this.ipHits) {
      for (const [uuid, at] of hits) if (now - at > SCAN_WINDOW_MS) hits.delete(uuid);
      if (hits.size === 0) this.ipHits.delete(ip);
    }
    for (const [ip, hits] of this.ipHits) {
      if (hits.size < SCAN_UUID_THRESHOLD) continue;
      if (!(await this.claimLocal(`scan_ip:${ip}`, SCAN_NOTIFY_TTL_MS))) continue;
      // 涉及节点：内存 nodes 里哪些节点的快照见过该 IP（prune 过的沉默节点查不到，可接受）
      const nodeIds = [...this.nodes.entries()]
        .filter(([, e]) => [...e.uuids.values()].some((u) => u.ips.includes(ip)))
        .map(([id]) => id);
      const geo = await lookupIpGeo(this.env, ip).catch(() => null);
      const geoText = geo ? [geo.country, geo.region, geo.city, geo.isp].filter(Boolean).join(" / ") : "归属地未知";
      await notifyAdmin(
        this.env,
        `疑似扫号来源 IP：${ip}`,
        `<p>来源 IP <strong>${ip}</strong>（${geoText}）在 ${SCAN_WINDOW_MS / 60_000} 分钟内触碰了 <strong>${hits.size}</strong> 个不同凭证（uuid），涉及节点：${nodeIds.join("、") || "（快照已过期）"}。</p>
         <p>注意：校园网/企业 NAT 出口可能误报（多人共用同一出口 IP），<strong>先观察，不自动封禁</strong>；确认恶意后可在管理页按 IP 封禁。</p>`,
        `来源 IP ${ip}（${geoText}）在 ${SCAN_WINDOW_MS / 60_000} 分钟内触碰了 ${hits.size} 个不同凭证，涉及节点：${nodeIds.join("、") || "（快照已过期）"}。校园网/企业 NAT 出口可能误报，先观察不自动封；确认恶意可在管理页按 IP 封禁。`
      );
    }
  }

  /** GET /stats：实时在线聚合（管理端看板 30s 轮询）。节点清单取 lastBeat（含 stale 的沉默节点） */
  private handleStats(): Response {
    const now = Date.now();
    const onlineSet = new Set<string>(); // 全局在线凭证去重（同一 uuid 跨节点只算一次）
    let totalConns = 0;
    for (const entry of this.nodes.values()) {
      for (const [uuid, s] of entry.uuids) {
        if (s.count > 0) {
          onlineSet.add(uuid);
          totalConns += s.count;
        }
      }
    }
    const nodes = [...this.lastBeat.entries()].map(([nodeId, at]) => {
      const entry = this.nodes.get(nodeId);
      let onlineUuids = 0;
      let conns = 0;
      if (entry) {
        for (const s of entry.uuids.values()) {
          if (s.count > 0) {
            onlineUuids++;
            conns += s.count;
          }
        }
      }
      return {
        nodeId,
        lastBeatAgoSec: Math.max(0, Math.round((now - at) / 1000)),
        onlineUuids,
        conns,
        stale: now - at > NODE_SILENT_MS,
      };
    });
    return Response.json({ ok: true, now, totals: { onlineUuids: onlineSet.size, totalConns }, nodes });
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
    this.lastBeat.set(nodeId, now); // 失联告警的最后心跳时间（不随 3min prune）
    // 扫号检测窗口数据：ip → uuid → lastSeen（内存即可，超上限按最旧活跃淘汰防打爆）
    for (const [uuid, s] of uuids) {
      for (const ip of s.ips) {
        let hits = this.ipHits.get(ip);
        if (!hits) {
          hits = new Map();
          this.ipHits.set(ip, hits);
        }
        hits.set(uuid, now);
      }
    }
    if (this.ipHits.size > SCAN_MAX_IPS) {
      const byOldest = [...this.ipHits.entries()]
        .map(([ip, hits]) => [ip, Math.max(...hits.values())] as const)
        .sort((a, b) => a[1] - b[1]);
      for (const [ip] of byOldest.slice(0, this.ipHits.size - SCAN_MAX_IPS)) this.ipHits.delete(ip);
    }
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
