import { Hono } from "hono";
import { KV, type Device, type Node, type Plan, type Presence, type Token } from "../../../../shared/types";
import { getNodeByKey, saveNodeStat, currentMonthKey, isBudgetExhausted } from "../lib/nodes";
import {
  getTokenByAnyUuid,
  getPlans,
  getTokenPresence,
  savePresenceIfChanged,
  mergeTokenSettlement,
  type TokenSettlementPatch,
} from "../lib/kv";
import { checkNodeBudget, checkTokenRisks, updateSpikeWindow, sendSpikeAlert, notifyBorrow, notifyMonth80, notifyIpChange } from "../lib/risk-notify";
import { getAuthSnapshot, TRAFFIC_GRACE_MS } from "../lib/authsnapshot";
import { pushAuthRefresh } from "../lib/authpush";
import type { Env } from "../types";

export const agentRoutes = new Hono<{ Bindings: Env }>();

/** 单 token 最多保留的接入 IP 条数（防分享滥用导致 KV 记录膨胀），超出按估算流量截断 */
const MAX_IP_ENTRIES = 20;

/**
 * 把本周期流量增量按连接数比例分摊到各接入 IP（access log 无逐连接字节数，属估算口径）。
 * delta 为 0 时只更新连接数与最近接入时间。写 presence（高频动态状态），不进 token 主键。
 */
function attributeIpTraffic(presence: Presence, conns: Record<string, number>, delta: number, now: number) {
  const total = Object.values(conns).reduce((s, v) => s + v, 0);
  if (total <= 0) return;
  presence.traffic_by_ip = presence.traffic_by_ip ?? {};
  const table = presence.traffic_by_ip;
  for (const [ip, n] of Object.entries(conns)) {
    if (n <= 0) continue;
    const rec = (table[ip] = table[ip] ?? { bytes: 0, conns: 0, last_seen_at: 0 });
    rec.bytes += Math.round((delta * n) / total);
    rec.conns += n;
    rec.last_seen_at = now;
  }
  const keys = Object.keys(table);
  if (keys.length > MAX_IP_ENTRIES) {
    const kept = keys.sort((a, b) => table[b].bytes - table[a].bytes).slice(0, MAX_IP_ENTRIES);
    presence.traffic_by_ip = Object.fromEntries(kept.map((k) => [k, table[k]]));
  }
}

/**
 * 接入地址变更检测：比较本周期活跃 IP 与上一周期（按 节点:凭证 记录）。
 * 返回变更后新出现的 IP；首次使用（无基线）不视为变更。本周期无连接时不更新基线。
 */
function detectIpChange(presence: Presence, key: string, conns: Record<string, number>): string[] {
  const curr = Object.entries(conns)
    .filter(([, n]) => n > 0)
    .map(([ip]) => ip);
  if (curr.length === 0) return [];
  presence.active_ips = presence.active_ips ?? {};
  const prev = presence.active_ips[key] ?? [];
  presence.active_ips[key] = curr;
  if (prev.length === 0) return [];
  return curr.filter((ip) => !prev.includes(ip));
}

/** nodestat 动态状态的最小写入间隔：流量累计按计数器差值计算，跳过中间写不丢量 */
export const NODE_STAT_WRITE_MIN_INTERVAL_MS = 30 * 60_000;

/**
 * GET /api/agent/config —— 节点 Agent 拉取本节点配置
 * 认证方式：header x-node-key
 * 返回：{ node: {...}, nodes: [...全部可用节点], uuids: [...active token uuid] }
 * nodes 仅用于节点侧 /api/metrics 的 nodes_cached 指标；订阅统一由中心 /api/sub 渲染
 */
agentRoutes.get("/config", async (c) => {
  const key = c.req.header("x-node-key");
  if (!key) {
    return c.json({ ok: false, error: "missing x-node-key" }, 401);
  }

  const node = await getNodeByKey(c.env, key);
  if (!node || !node.active) {
    return c.json({ ok: false, error: "invalid or inactive node" }, 403);
  }

  const snap = await getAuthSnapshot(c.env);

  // 月流量超配额的节点返回空名单，agent 会清空 Xray clients，已连接设备随连接断开被切断
  const uuids = isBudgetExhausted(node) ? [] : snap.uuids;
  const allow = new Set(uuids);
  // 部署初期 KV 里可能还躺着旧格式快照（无 usage/blockedByUuid 字段），兜底为空表
  const usage = Object.fromEntries(
    Object.entries(snap.usage ?? {}).filter(([u]) => allow.has(u))
  );
  // per-(uuid, IP) 封禁表同样只下发名单内 uuid（节点超配时随空名单一起收敛）
  const blockedByUuid = Object.fromEntries(
    Object.entries(snap.blockedByUuid ?? {}).filter(([u]) => allow.has(u))
  );

  return c.json({
    ok: true,
    data: {
      node: {
        id: node.id,
        name: node.name,
        region: node.region,
        host: node.host,
        port: node.port,
        tls: node.tls,
        ws_path: node.ws_path,
      },
      nodes: snap.nodes,
      uuids,
      blocked_ips: snap.blockedIps, // 旧 agent 兼容（全局 iptables 封禁）；新 agent 用 blocked_by_uuid
      blocked_by_uuid: blockedByUuid,
      usage,
    },
  });
});

/**
 * 单 uuid 的流量增量记账（新旧两种上报格式共用）：
 * 累加按节点分账 → IP 分摊/变更检测 → 设备审计 → 总量与月度配额 → 耗尽宽限 → 风险通知。
 *
 * 并发安全（与 tokens.ts 加设备/封 IP、admin.ts rotate 等低频写共存）：
 * 1. 纯计算段先把全部新值在首次读取的副本上算好（不穿插任何 await）；
 * 2. 写库用 mergeTokenSettlement 重读-合并，只覆盖结算字段，用户并发改的其他字段不丢；
 *    在线/IP 等高频动态状态写独立的 presence:{uuid} 键，有变化才写；
 * 3. 邮件等 await 全部挪到写库之后；通知产生的 notify_log 变更再走一次键级合并写。
 *
 * 返回 true 表示发生了授权相关变更（新耗尽/宽限期结束过期），调用方应推送节点刷新。
 */
async function applyTrafficDelta(
  env: Env,
  node: Node,
  found: { token: Token; device?: Device },
  uuid: string,
  delta: number,
  billing: "sum" | "downlink",
  conns: Record<string, number>,
  plansById: Map<string, Plan>,
  now: number
): Promise<boolean> {
  const { token, device } = found;
  // 授权相关变更标记：新耗尽 / 宽限期结束过期 / 预支提前到期时置位
  let authChanged = false;

  // 高频动态状态读写 presence 键；键缺失时回退 token JSON 旧字段（存量兼容）。
  // base 为深拷贝基准，用于「有变化才写」。
  const presence = await getTokenPresence(env, token);
  const presenceBase: Presence = JSON.parse(JSON.stringify(presence));

  // ---------- 纯计算段（无 await） ----------
  // 多节点流量聚合：traffic_by_node 存各节点最新计数器（用于清零检测），
  // traffic_total_by_node 按 delta 累计真实消耗（重启/rmu 不清零）
  token.traffic_by_node = token.traffic_by_node ?? {};
  token.billing_by_node = token.billing_by_node ?? {};
  // 迁移：老数据没有累计表，把当前计数器值视为已消耗量作为起点
  token.traffic_total_by_node = token.traffic_total_by_node ?? { ...token.traffic_by_node };
  const nodeKey = device ? `${node.id}:${uuid}` : node.id;
  // 计费口径切换（双向→下行）：该节点基线重置，当次不计增量，避免历史上行被重复计费。
  // 无记录的键默认视为当前口径（?? billing）：双向计费的存量 token 早在口径切换时就已写入
  // 显式记录，没记录的都是切换后新建的，按老默认 "sum" 会把它们首次结算误清零。
  if ((token.billing_by_node[nodeKey] ?? billing) !== billing) {
    delta = 0;
    token.billing_by_node[nodeKey] = billing;
  }
  token.traffic_total_by_node[nodeKey] =
    (token.traffic_total_by_node[nodeKey] ?? token.traffic_by_node[nodeKey] ?? 0) + delta;

  // 流量暴增检测的窗口记账（纯计算）：1h 窗口内新增超阈值时，写库后告警客户与管理员
  const spike = updateSpikeWindow(token, delta, now);

  // 接入 IP 统计：把本次增量按连接数比例分摊到各来源 IP（估算，写 presence）
  // 活跃 IP 与上次不一致 = 接入地址变更，写库后提醒本人自查（本人换网络属正常）
  attributeIpTraffic(presence, conns, delta, now);
  const changedIps = detectIpChange(presence, nodeKey, conns);

  // 设备级流量审计：该设备 uuid 在各节点的累计消耗之和
  if (device) {
    const devTotal = Object.entries(token.traffic_total_by_node)
      .filter(([k]) => k.endsWith(`:${uuid}`))
      .reduce((sum, [, v]) => sum + v, 0);
    device.traffic_used_gb = devTotal / 1024 / 1024 / 1024;
    device.last_active_at = now;
  }

  const totalBytes = Math.max(
    0,
    Object.values(token.traffic_total_by_node).reduce((sum, v) => sum + v, 0) -
      (token.traffic_offset_bytes ?? 0)
  );
  token.traffic_used_gb = totalBytes / 1024 / 1024 / 1024;
  presence.last_active_at = now;

  // 月度配额：当月用超自动预支下月额度，有效期永久提前一个月（每档邮件通知一次）
  const quotaGb = plansById.get(token.plan_id)?.monthly_quota_gb;
  let borrowed = 0;
  if (quotaGb && quotaGb > 0) {
    const quotaBytes = quotaGb * 1024 ** 3;
    const mk = currentMonthKey();
    if (token.month_key !== mk) {
      // 跨月：锁定当月已预支月数，月度计数归零
      token.months_borrowed =
        (token.months_borrowed ?? 0) + Math.floor((token.month_used_bytes ?? 0) / quotaBytes);
      token.month_used_bytes = 0;
      token.month_key = mk;
    }
    token.month_used_bytes = (token.month_used_bytes ?? 0) + delta;
    borrowed = (token.months_borrowed ?? 0) + Math.floor(token.month_used_bytes / quotaBytes);
    const base = token.base_expires_at ?? token.expires_at;
    if (base) {
      token.base_expires_at = base;
      token.expires_at = base - borrowed * 30 * 86_400_000;
      if (token.status === "active" && token.expires_at <= now) {
        token.status = "expired";
        authChanged = true; // 预支耗尽提前到期：从授权名单摘除
      }
    }
  }

  // 不限量套餐（上限 ≤ 0）不参与耗尽判断；流量仍照常累计供审计
  if (token.traffic_limit_gb > 0 && token.traffic_used_gb >= token.traffic_limit_gb) {
    if (!token.traffic_exhausted_at) {
      // 刚耗尽：进入宽限期，不断连，由 checkTokenRisks 发续费引导邮件
      // 授权变更（用量基数超线）：推送节点更新本地配额基数
      token.traffic_exhausted_at = now;
      authChanged = true;
    } else if (now - token.traffic_exhausted_at > TRAFFIC_GRACE_MS) {
      // 宽限期结束仍未续费/重置：才置过期并切断
      token.status = "expired";
      authChanged = true;
    }
  }

  // ---------- 写库段 ----------
  // 重读-合并：只把结算字段覆盖到最新副本上，并发用户操作（加设备/封 IP 等）不丢。
  // notify_log 键级合并（含 updateSpikeWindow 的 traffic_spike 记账）。
  const patch: TokenSettlementPatch = {
    traffic_by_node: token.traffic_by_node,
    traffic_total_by_node: token.traffic_total_by_node,
    billing_by_node: token.billing_by_node,
    traffic_used_gb: token.traffic_used_gb,
    traffic_exhausted_at: token.traffic_exhausted_at,
    status: token.status,
    expires_at: token.expires_at,
    base_expires_at: token.base_expires_at,
    month_used_bytes: token.month_used_bytes,
    month_key: token.month_key,
    months_borrowed: token.months_borrowed,
    rate_window_start: token.rate_window_start,
    rate_window_bytes: token.rate_window_bytes,
    notify_log: token.notify_log,
  };
  if (device) {
    patch.device_usage = {
      uuid: device.uuid,
      traffic_used_gb: device.traffic_used_gb,
      last_active_at: device.last_active_at,
    };
  }
  await mergeTokenSettlement(env, token.uuid, patch);
  await savePresenceIfChanged(env, token.uuid, presenceBase, presence);

  // ---------- 通知段（邮件 await 全部在写库之后） ----------
  const notifyBase = JSON.stringify(token.notify_log ?? {});
  if (spike) await sendSpikeAlert(env, token);
  if (changedIps.length > 0) {
    await notifyIpChange(env, token, changedIps);
  }
  if (quotaGb && quotaGb > 0) {
    // 80% 提前预警（每月一次）→ 用超时自动预支（每档一次）
    await notifyMonth80(env, token, quotaGb);
    await notifyBorrow(env, token, borrowed, quotaGb);
  }
  // 风险检测：流量 80% / 耗尽时提醒客户（幂等，每类只发一次）
  await checkTokenRisks(env, token);
  // 通知产生的 notify_log 变更按键级合并写回（不覆盖并发路径新增的记录）
  if (JSON.stringify(token.notify_log ?? {}) !== notifyBase) {
    await mergeTokenSettlement(env, token.uuid, { notify_log: token.notify_log });
  }
  return authChanged;
}

/**
 * POST /api/agent/traffic —— 节点 Agent 上报流量
 * 两种格式：
 * - 旧版（滚动升级兼容）：{ "stats": { uuid: 计数器累计值 } }，中心按计数器差值算增量
 * - v2 结算制：{ "v": 2, "settled": { uuid: 增量字节 } }，agent 本地记账，
 *   只在断联/配额事件/兜底周期时上报，中心直接累加
 */
agentRoutes.post("/traffic", async (c) => {
  const key = c.req.header("x-node-key");
  if (!key) {
    return c.json({ ok: false, error: "missing x-node-key" }, 401);
  }

  const node = await getNodeByKey(c.env, key);
  if (!node || !node.active) {
    return c.json({ ok: false, error: "invalid or inactive node" }, 403);
  }

  const body = (await c.req.json().catch(() => null)) as {
    v?: number;
    stats?: Record<string, number>;
    settled?: Record<string, number>;
    online?: Record<string, boolean>;
    node_total_bytes?: number;
    online_count?: number;
    billing?: string;
    ip_conns?: Record<string, Record<string, number>>;
  } | null;
  const stats = body?.stats ?? {};
  const settled = body?.settled ?? {};
  const online = body?.online ?? {};
  const ipConns = body?.ip_conns ?? {};
  // 计费口径：默认历史双向计费；agent 上报 downlink 表示只计下行
  const billing = body?.billing === "downlink" ? "downlink" : "sum";
  const now = Date.now();

  // 月度配额需要套餐定义，循环前一次性加载
  const plans = Object.keys(stats).length + Object.keys(settled).length > 0 ? await getPlans(c.env) : [];
  const plansById = new Map(plans.map((p) => [p.id, p]));

  // 有授权相关变更（新耗尽/宽限结束过期/预支提前到期）时，结束后推送全节点立即刷新
  let authChanged = false;

  // v2 结算制：settled 里是 agent 本地账本算好的增量，直接累加
  for (const [uuid, bytes] of Object.entries(settled)) {
    const delta = Math.max(0, Math.round(bytes));
    if (delta <= 0) {
      // 有连接但零增量：保留 ipConns 交给下方「只记连接数」的兜底循环，别丢 IP 统计
      continue;
    }
    const found = await getTokenByAnyUuid(c.env, uuid);
    if (!found || found.token.status !== "active") continue;
    authChanged =
      (await applyTrafficDelta(
        c.env, node, found, uuid, delta, billing, ipConns[uuid] ?? {}, plansById, now
      )) || authChanged;
    delete ipConns[uuid];
  }

  // 旧版格式：stats 里是 xray 计数器累计值，中心按差值算增量（滚动升级兼容，全量切换后可删）
  for (const [uuid, bytes] of Object.entries(stats)) {
    const found = await getTokenByAnyUuid(c.env, uuid);
    if (!found || found.token.status !== "active") continue;
    const { token } = found;

    token.traffic_by_node = token.traffic_by_node ?? {};
    const nodeKey = found.device ? `${node.id}:${uuid}` : node.id;
    const prev = token.traffic_by_node[nodeKey] ?? 0;
    // Xray 重启/rmu 后计数器清零；上报值变小按新基准把当前值全量计入
    const delta = bytes >= prev ? bytes - prev : bytes;
    token.traffic_by_node[nodeKey] = bytes;

    authChanged =
      (await applyTrafficDelta(
        c.env, node, found, uuid, delta, billing, ipConns[uuid] ?? {}, plansById, now
      )) || authChanged;
    delete ipConns[uuid];
  }

  // 本周期有连接但无流量增量的 uuid（上面两个循环未覆盖）：只记连接数与最近接入时间（写 presence）
  for (const [uuid, conns] of Object.entries(ipConns)) {
    const found = await getTokenByAnyUuid(c.env, uuid);
    if (!found || found.token.status !== "active") continue;
    const presence = await getTokenPresence(c.env, found.token);
    const presenceBase: Presence = JSON.parse(JSON.stringify(presence));
    attributeIpTraffic(presence, conns, 0, now);
    const ipKey = found.device ? `${node.id}:${uuid}` : node.id;
    const changedIps = detectIpChange(presence, ipKey, conns);
    await savePresenceIfChanged(c.env, found.token.uuid, presenceBase, presence);
    if (changedIps.length > 0) {
      // 邮件 await 在 presence 写库之后；notify_log 变更按键级合并写回
      const notifyBase = JSON.stringify(found.token.notify_log ?? {});
      await notifyIpChange(c.env, found.token, changedIps);
      if (JSON.stringify(found.token.notify_log ?? {}) !== notifyBase) {
        await mergeTokenSettlement(c.env, found.token.uuid, { notify_log: found.token.notify_log });
      }
    }
  }

  // 更新用户在线状态与设备数（只有 active token 才更新）
  // 同一 token 在多个节点同时上线 = 多设备/分享使用，记录标记供运营处理。
  // 窗口与结算节奏对齐：online 状态现在只在结算/兜底上报时刷新（30 分钟粒度），
  // 多设备判定随之变为「40 分钟内在多个节点有过活跃」，比原来粗，属可接受的口径变化。
  // 在线状态写独立的 presence:{uuid} 键（有变化才写），不再整写 token JSON。
  const MULTI_DEVICE_WINDOW_MS = 40 * 60_000;
  for (const [uuid, isOnline] of Object.entries(online)) {
    const found = await getTokenByAnyUuid(c.env, uuid);
    if (!found || found.token.status !== "active") continue;
    const { token, device } = found;
    const presence = await getTokenPresence(c.env, token);
    const presenceBase: Presence = JSON.parse(JSON.stringify(presence));
    presence.online_by_node = presence.online_by_node ?? {};
    if (isOnline) {
      presence.online_by_node[node.id] = now;
      // 只保留窗口内的记录，统计同时在线节点数
      const activeNodes = Object.entries(presence.online_by_node).filter(
        ([, ts]) => ts > now - MULTI_DEVICE_WINDOW_MS
      );
      presence.online_by_node = Object.fromEntries(activeNodes);
      presence.online = true;
      presence.online_updated_at = now;
      presence.last_active_at = now;

      // token 主键只补丁结算/审计字段（重读-合并），避免覆盖并发用户操作
      const patch: TokenSettlementPatch = {};
      if (activeNodes.length >= 2) {
        token.multi_device_detected_at = now;
        patch.multi_device_detected_at = now;
      }
      if (device) {
        device.last_active_at = now;
        patch.device_usage = { uuid: device.uuid, last_active_at: now };
      }
      if (Object.keys(patch).length > 0) {
        await mergeTokenSettlement(c.env, token.uuid, patch);
      }
      await savePresenceIfChanged(c.env, token.uuid, presenceBase, presence);

      // 多设备标记产生时提醒客户（幂等）；邮件 await 在写库之后
      const notifyBase = JSON.stringify(token.notify_log ?? {});
      await checkTokenRisks(c.env, token);
      if (JSON.stringify(token.notify_log ?? {}) !== notifyBase) {
        await mergeTokenSettlement(c.env, token.uuid, { notify_log: token.notify_log });
      }
    } else {
      // 离线：清除该节点的在线记录；窗口内无其他节点在线则判定下线
      if (presence.online_by_node[node.id] === undefined && !presence.online) continue;
      delete presence.online_by_node[node.id];
      const activeNodes = Object.entries(presence.online_by_node).filter(
        ([, ts]) => ts > now - MULTI_DEVICE_WINDOW_MS
      );
      presence.online_by_node = Object.fromEntries(activeNodes);
      if (activeNodes.length === 0) {
        presence.online = false;
      }
      presence.online_updated_at = now;
      await savePresenceIfChanged(c.env, token.uuid, presenceBase, presence);
    }
  }

  // 更新节点级总流量与在线连接数（含月度账期记账与配额检查）
  // 动态状态写 nodestat:<id> 单键，避免多节点并发写整表互相覆盖。
  // 写入按 NODE_STAT_WRITE_MIN_INTERVAL 节流：流量按计数器差值累计，跳过中间写不丢量；
  // 在线状态/节点流量的可见粒度降为 30 分钟（probe-nodes.sh 有独立的 5 分钟探测）。
  {
    const due = now - (node.stats_updated_at ?? 0) > NODE_STAT_WRITE_MIN_INTERVAL_MS;
    if (due) {
      const reported = body?.node_total_bytes ?? 0;
      const prev = node.last_node_total_bytes ?? 0;
      // Xray 重启后统计会清零；如果上报值比上次小，按新的基准直接累加
      let delta = reported >= prev ? reported - prev : reported;
      // 计费口径切换（双向→下行）：节点基线重置，当次不计增量。
      // 无记录默认当前口径（?? billing），理由同 applyTrafficDelta。
      if ((node.billing_mode ?? billing) !== billing) {
        delta = 0;
        node.billing_mode = billing;
      }
      node.total_bytes = (node.total_bytes ?? 0) + delta;
      node.last_node_total_bytes = reported;
      // 月度账期：跨月归零重计，告警水位一并清零
      const mk = currentMonthKey();
      if (node.month_key !== mk) {
        node.month_key = mk;
        node.month_bytes = 0;
        node.budget_alert_level = 0;
      }
      node.month_bytes = (node.month_bytes ?? 0) + delta;
      node.online_count = body?.online_count ?? node.online_count ?? 0;
      node.last_seen_at = now;
      node.stats_updated_at = now;
      await checkNodeBudget(c.env, node);
      await saveNodeStat(c.env, node);
    }
  }

  // 授权相关变更：重建快照并推送全节点立即刷新（fire-and-forget，不拖慢上报应答）
  if (authChanged) {
    c.executionCtx.waitUntil(pushAuthRefresh(c.env));
  }

  return c.json({ ok: true });
});
