import { Hono } from "hono";
import { getPlans } from "../lib/kv";
import type { Env } from "../types";

export const plansRoutes = new Hono<{ Bindings: Env }>();

/** GET /api/plans —— 列出所有可用套餐（前端定价页展示）。企业套餐（plan_biz_*）只在 fastergamer.cn 展示，click 站已下架 */
plansRoutes.get("/", async (c) => {
  const plans = await getPlans(c.env);
  return c.json({ ok: true, data: plans.filter((p) => !p.id.startsWith("plan_biz")) });
});
