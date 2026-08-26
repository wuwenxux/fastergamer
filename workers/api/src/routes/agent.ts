import { Hono } from "hono";
import { KV, type Token } from "../../../../shared/types";
import { getNodeByKey, getNodes, saveNodes, currentMonthKey, isBudgetExhausted } from "../lib/nodes";
import { getTokenByAnyUuid, getPlans, listKeys, saveToken } from "../lib/kv";
import { checkNodeBudget, checkTokenRisks, checkTrafficSpike, notifyBorrow, notifyMonth80, notifyIpChange } from "../lib/risk-notify";
import type { Env } from "../types";

export const agentRoutes = new Hono<{ Bindings: Env }>();

/** 单 token 最多保留的接入 IP 条数（防分享滥用导致 KV 记录膨胀），超出按估算流量截断 */
const MAX_IP_ENTRIES = 20;

/**
 * 把本周期流量增量按连接数比例分摊到各接入 IP（access log 无逐连接字节数，属估算口径）。
 * delta 为 0 时只更新连接数与最近接入时间。
 */
function attributeIpTraffic(token: Token, conns: Record<string, number>, delta: number, now: number) {
  const total = Object.values(conns).reduce((s, v) => s + v, 0);
  if (total <= 0) return;
  token.traffic_by_ip = token.traffic_by_ip ?? {};
  const table = token.traffic_by_ip;
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
    token.traffic_by_ip = Object.fromEntries(kept.map((k) => [k, table[k]]));
  }
}

/**
 * 接入地址变更检测：比较本周期活跃 IP 与上一周期（按 节点:凭证 记录）。
 * 返回变更后新出现的 IP；首次使用（无基线）不视为变更。本周期无连接时不更新基线。
 */
function detectIpChange(token: Token, key: string, conns: Record<string, number>): string[] {
  const curr = Object.entries(conns)
    .filter(([, n]) => n > 0)
    .map(([ip]) => ip);
  if (curr.length === 0) return [];
  token.active_ips = token.active_ips ?? {};
  const prev = token.active_ips[key] ?? [];
  token.active_ips[key] = curr;
  if (prev.length === 0) return [];
  return curr.filter((ip) => !prev.includes(ip));
}

/**
 * 流量耗尽后的宽限期：不立即断连，先邮件引导续费，宽限期内可正常接入，
 * 超过宽限期仍未处理（续费/重置）才切断。
 */
export const TRAFFIC_GRACE_MS = 48 * 3_600_000;

/** 流量准入：未超限，或超限但仍在宽限期内 */
export const withinTrafficAllowance = (token: Token, now: number): boolean => {
  if (token.traffic_used_gb < token.traffic_limit_gb) return true;
  return !!token.traffic_exhausted_at && now - token.traffic_exhausted_at < TRAFFIC_GRACE_MS;
};

/**
 * GET /api/agent/config —— 节点 Agent 拉取本节点配置
 * 认证方式：header x-node-key
 * 返回：{ node: {...}, uuids: [...active token uuid] }
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

  // 拉取所有 active、未过期且流量在可用额度内（含耗尽宽限期）的 token UUID（主 uuid + 各设备槽位 uuid）
  // 月流量超配额的节点返回空列表，agent 会清空 Xray clients，已连接设备随连接断开被切断
  const uuids: string[] = [];
  // 用户自助封禁的 IP 合集：agent 同步到节点防火墙，被封 IP 无法连接本节点
  const blockedIps = new Set<string>();
  if (!isBudgetExhausted(node)) {
    const keys = await listKeys(c.env.TOKENS, KV.TOKEN);
    const now = Date.now();
    for (const k of keys) {
      const raw = await c.env.TOKENS.get(k.name);
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
      }
    }
  }

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
      uuids,
      blocked_ips: [...blockedIps],
    },
  });
});

/**
 * POST /api/agent/heartbeat —— 节点 Agent 心跳
 * 用于中心判断节点是否在线
 */
agentRoutes.post("/heartbeat", async (c) => {
  const key = c.req.header("x-node-key");
  if (!key) {
    return c.json({ ok: false, error: "missing x-node-key" }, 401);
  }

  const nodes = await getNodes(c.env);
  const idx = nodes.findIndex((n) => n.key === key);
  if (idx === -1 || !nodes[idx].active) {
    return c.json({ ok: false, error: "invalid or inactive node" }, 403);
  }

  nodes[idx].last_seen_at = Date.now();
  await saveNodes(c.env, nodes);
  return c.json({ ok: true });
});

/**
 * POST /api/agent/traffic —— 节点 Agent 上报每个 token 的流量
 * 请求体：{ "stats": { "uuid": used_bytes, ... } }
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
    stats?: Record<string, number>;
    online?: Record<string, boolean>;
    node_total_bytes?: number;
    online_count?: number;
    billing?: string;
    ip_conns?: Record<string, Record<string, number>>;
  } | null;
  const stats = body?.stats ?? {};
  const online = body?.online ?? {};
  const ipConns = body?.ip_conns ?? {};
  // 计费口径：默认历史双向计费；agent 上报 downlink 表示只计下行
  const billing = body?.billing === "downlink" ? "downlink" : "sum";
  const now = Date.now();

  // 月度配额需要套餐定义，循环前一次性加载
  const plans = Object.keys(stats).length > 0 ? await getPlans(c.env) : [];
  const plansById = new Map(plans.map((p) => [p.id, p]));

  for (const [uuid, bytes] of Object.entries(stats)) {
    const found = await getTokenByAnyUuid(c.env, uuid);
    if (!found || found.token.status !== "active") continue;
    const { token, device } = found;

    // 多节点流量聚合：traffic_by_node 存各节点最新计数器（用于清零检测），
    // traffic_total_by_node 按 delta 累计真实消耗（重启/rmu 不清零）
    token.traffic_by_node = token.traffic_by_node ?? {};
    token.billing_by_node = token.billing_by_node ?? {};
    // 迁移：老数据没有累计表，把当前计数器值视为已消耗量作为起点
    token.traffic_total_by_node = token.traffic_total_by_node ?? { ...token.traffic_by_node };
    const nodeKey = device ? `${node.id}:${uuid}` : node.id;
    const prev = token.traffic_by_node[nodeKey] ?? 0;
    let delta = bytes >= prev ? bytes - prev : bytes;
    // 计费口径切换（双向→下行）：该节点基线重置，当次不计增量，避免历史上行被重复计费
    if ((token.billing_by_node[nodeKey] ?? "sum") !== billing) {
      delta = 0;
      token.billing_by_node[nodeKey] = billing;
    }
    token.traffic_by_node[nodeKey] = bytes;
    token.traffic_total_by_node[nodeKey] =
      (token.traffic_total_by_node[nodeKey] ?? prev) + delta;

    // 流量暴增检测：1h 窗口内新增超阈值告警客户与管理员
    await checkTrafficSpike(c.env, token, delta);

    // 接入 IP 统计：把本周期增量按连接数比例分摊到各来源 IP（估算）
    // 活跃 IP 与上周期不一致 = 接入地址变更，提醒本人自查（本人换网络属正常）
    attributeIpTraffic(token, ipConns[uuid] ?? {}, delta, now);
    const changedIps = detectIpChange(token, nodeKey, ipConns[uuid] ?? {});
    delete ipConns[uuid];
    if (changedIps.length > 0) {
      await notifyIpChange(c.env, token, changedIps);
    }

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
    token.last_active_at = now;

    // 月度配额：当月用超自动预支下月额度，有效期永久提前一个月（每档邮件通知一次）
    const quotaGb = plansById.get(token.plan_id)?.monthly_quota_gb;
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
      const borrowed =
        (token.months_borrowed ?? 0) + Math.floor(token.month_used_bytes / quotaBytes);
      const base = token.base_expires_at ?? token.expires_at;
      if (base) {
        token.base_expires_at = base;
        token.expires_at = base - borrowed * 30 * 86_400_000;
        if (token.status === "active" && token.expires_at <= now) {
          token.status = "expired";
        }
      }
      // 80% 提前预警（每月一次）→ 用超时自动预支（每档一次）
      await notifyMonth80(c.env, token, quotaGb);
      await notifyBorrow(c.env, token, borrowed, quotaGb);
    }

    if (token.traffic_used_gb >= token.traffic_limit_gb) {
      if (!token.traffic_exhausted_at) {
        // 刚耗尽：进入宽限期，不断连，由 checkTokenRisks 发续费引导邮件
        token.traffic_exhausted_at = now;
      } else if (now - token.traffic_exhausted_at > TRAFFIC_GRACE_MS) {
        // 宽限期结束仍未续费/重置：才置过期并切断
        token.status = "expired";
      }
    }

    // 风险检测：流量 80% / 耗尽时提醒客户（幂等，每类只发一次）
    await checkTokenRisks(c.env, token);
    await saveToken(c.env, token);
  }

  // 本周期有连接但无流量增量的 uuid（stats 循环未覆盖）：只记连接数与最近接入时间
  for (const [uuid, conns] of Object.entries(ipConns)) {
    const found = await getTokenByAnyUuid(c.env, uuid);
    if (!found || found.token.status !== "active") continue;
    attributeIpTraffic(found.token, conns, 0, now);
    const ipKey = found.device ? `${node.id}:${uuid}` : node.id;
    const changedIps = detectIpChange(found.token, ipKey, conns);
    if (changedIps.length > 0) {
      await notifyIpChange(c.env, found.token, changedIps);
    }
    await saveToken(c.env, found.token);
  }

  // 更新用户在线状态与设备数（只有 active token 才更新）
  // 同一 token 在多个节点同时上线 = 多设备/分享使用，记录标记供运营处理
  const MULTI_DEVICE_WINDOW_MS = 90_000;
  for (const [uuid, isOnline] of Object.entries(online)) {
    const found = await getTokenByAnyUuid(c.env, uuid);
    if (!found || found.token.status !== "active") continue;
    const { token, device } = found;
    token.online_by_node = token.online_by_node ?? {};
    if (isOnline) {
      if (device) device.last_active_at = now;
      token.online_by_node[node.id] = now;
      // 只保留窗口内的记录，统计同时在线节点数
      const activeNodes = Object.entries(token.online_by_node).filter(
        ([, ts]) => ts > now - MULTI_DEVICE_WINDOW_MS
      );
      token.online_by_node = Object.fromEntries(activeNodes);
      token.online = true;
      token.online_updated_at = now;
      token.last_active_at = now;
      if (activeNodes.length >= 2) {
        token.multi_device_detected_at = now;
      }
      // 多设备标记产生时提醒客户（幂等）
      await checkTokenRisks(c.env, token);
      await saveToken(c.env, token);
    } else {
      // 离线：清除该节点的在线记录；窗口内无其他节点在线则判定下线
      if (token.online_by_node[node.id] === undefined && !token.online) continue;
      delete token.online_by_node[node.id];
      const activeNodes = Object.entries(token.online_by_node).filter(
        ([, ts]) => ts > now - MULTI_DEVICE_WINDOW_MS
      );
      token.online_by_node = Object.fromEntries(activeNodes);
      if (activeNodes.length === 0) {
        token.online = false;
      }
      token.online_updated_at = now;
      await saveToken(c.env, token);
    }
  }

  // 更新节点级总流量与在线连接数（含月度账期记账与配额检查）
  const nodes = await getNodes(c.env);
  const idx = nodes.findIndex((n) => n.key === key);
  if (idx !== -1) {
    const reported = body?.node_total_bytes ?? 0;
    const prev = nodes[idx].last_node_total_bytes ?? 0;
    // Xray 重启后统计会清零；如果上报值比上次小，按新的基准直接累加
    let delta = reported >= prev ? reported - prev : reported;
    // 计费口径切换（双向→下行）：节点基线重置，当次不计增量
    if ((nodes[idx].billing_mode ?? "sum") !== billing) {
      delta = 0;
      nodes[idx].billing_mode = billing;
    }
    nodes[idx].total_bytes = (nodes[idx].total_bytes ?? 0) + delta;
    nodes[idx].last_node_total_bytes = reported;
    // 月度账期：跨月归零重计，告警水位一并清零
    const mk = currentMonthKey();
    if (nodes[idx].month_key !== mk) {
      nodes[idx].month_key = mk;
      nodes[idx].month_bytes = 0;
      nodes[idx].budget_alert_level = 0;
    }
    nodes[idx].month_bytes = (nodes[idx].month_bytes ?? 0) + delta;
    nodes[idx].online_count = body?.online_count ?? nodes[idx].online_count ?? 0;
    nodes[idx].stats_updated_at = Date.now();
    await checkNodeBudget(c.env, nodes[idx]);
    await saveNodes(c.env, nodes);
  }

  return c.json({ ok: true });
});
