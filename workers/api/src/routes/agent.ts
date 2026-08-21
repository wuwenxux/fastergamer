import { Hono } from "hono";
import { KV, type Token } from "../../../../shared/types";
import { getNodeByKey, getNodes, saveNodes, currentMonthKey, isBudgetExhausted } from "../lib/nodes";
import { getTokenByAnyUuid, getPlans, listKeys, saveToken } from "../lib/kv";
import { checkNodeBudget, checkTokenRisks, checkTrafficSpike, notifyBorrow } from "../lib/risk-notify";
import type { Env } from "../types";

export const agentRoutes = new Hono<{ Bindings: Env }>();

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

  // 拉取所有 active、未过期且流量未用完的 token UUID（主 uuid + 各设备槽位 uuid）
  // 月流量超配额的节点返回空列表，agent 会清空 Xray clients，已连接设备随连接断开被切断
  const uuids: string[] = [];
  if (!isBudgetExhausted(node)) {
    const keys = await listKeys(c.env.TOKENS, KV.TOKEN);
    const now = Date.now();
    for (const k of keys) {
      const raw = await c.env.TOKENS.get(k.name);
      if (!raw) continue;
      const token = JSON.parse(raw) as Token;
      if (
        token.status === "active" &&
        (token.expires_at ?? 0) > now &&
        token.traffic_used_gb < token.traffic_limit_gb
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
  } | null;
  const stats = body?.stats ?? {};
  const online = body?.online ?? {};
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
      await notifyBorrow(c.env, token, borrowed, quotaGb);
    }

    if (token.traffic_used_gb >= token.traffic_limit_gb && !token.traffic_exhausted_at) {
      token.status = "expired";
      token.traffic_exhausted_at = now;
    }

    // 风险检测：流量 80% / 耗尽时提醒客户（幂等，每类只发一次）
    await checkTokenRisks(c.env, token);
    await saveToken(c.env, token);
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
