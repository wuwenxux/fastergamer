import { Hono } from "hono";
import { getNodes, isBudgetExhausted, isNodeOnline } from "../lib/nodes";
import type { Env } from "../types";

export const statusRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/nodes/status —— 公开的节点在线状态
 * 返回节点列表及在线状态，供前端状态页展示。
 * 在线判定以中心主动探测（probe_online）为准，agent 上报的 last_seen_at 仅作兜底。
 */
statusRoutes.get("/", async (c) => {
  c.header("Cache-Control", "no-store");
  const nodes = await getNodes(c.env);
  const data = nodes
    .filter((n) => n.active && !isBudgetExhausted(n))
    .map(({ key, ...rest }) => ({
      id: rest.id,
      name: rest.name,
      region: rest.region,
      host: rest.host,
      port: rest.port,
      tls: rest.tls,
      ws_path: rest.ws_path,
      last_seen_at: rest.last_seen_at,
      online: isNodeOnline(rest),
      total_bytes: rest.total_bytes ?? 0,
      month_bytes: rest.month_bytes ?? 0,
      monthly_budget_gb: rest.monthly_budget_gb,
      online_count: rest.online_count ?? 0,
      stats_updated_at: rest.stats_updated_at,
    }));
  return c.json({ ok: true, data });
});
