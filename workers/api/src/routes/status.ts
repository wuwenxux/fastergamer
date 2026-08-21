import { Hono } from "hono";
import { getNodes, isBudgetExhausted } from "../lib/nodes";
import type { Env } from "../types";

export const statusRoutes = new Hono<{ Bindings: Env }>();

const ONLINE_THRESHOLD_MS = 90_000;

/**
 * GET /api/nodes/status —— 公开的节点在线状态
 * 返回节点列表及最近心跳时间，供前端状态页展示
 */
statusRoutes.get("/", async (c) => {
  const nodes = await getNodes(c.env);
  const now = Date.now();
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
      online: (rest.last_seen_at ?? 0) > now - ONLINE_THRESHOLD_MS,
      total_bytes: rest.total_bytes ?? 0,
      month_bytes: rest.month_bytes ?? 0,
      monthly_budget_gb: rest.monthly_budget_gb,
      online_count: rest.online_count ?? 0,
      stats_updated_at: rest.stats_updated_at,
    }));
  return c.json({ ok: true, data });
});
