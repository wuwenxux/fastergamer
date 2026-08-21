import { Hono } from "hono";
import { getTokenByAnyUuid } from "../lib/kv";
import { buildClashConfig } from "../lib/clash";
import { getNodes, isBudgetExhausted } from "../lib/nodes";
import type { Env } from "../types";

export const subRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/sub?uuid={uuid} —— 生成 Clash 订阅配置
 * uuid 可以是 token 主 uuid 或某个设备槽位的 uuid（每台设备独立订阅）
 * 校验 token 处于 active 且未过期，返回 text/yaml
 */
subRoutes.get("/", async (c) => {
  const uuid = c.req.query("uuid");
  if (!uuid) {
    return c.json({ ok: false, error: "uuid parameter is required" }, 400);
  }

  const found = await getTokenByAnyUuid(c.env, uuid);
  if (!found) {
    return c.text("token not found", 404);
  }
  const { token } = found;

  const now = Date.now();
  if (token.status !== "active" || (token.expires_at && token.expires_at <= now)) {
    return c.text("token 未激活或已过期，请先在网站激活", 403);
  }

  const nodes = (await getNodes(c.env)).filter((n) => !isBudgetExhausted(n));
  const yaml = buildClashConfig({ uuid, nodes });

  // subscription-userinfo：Clash/Stash 客户端可直接显示已用流量与到期时间
  // （不区分上下行，已用量统一计入 download）
  const usedBytes = Math.round(token.traffic_used_gb * 1024 ** 3);
  const totalBytes = Math.round(token.traffic_limit_gb * 1024 ** 3);
  const expireSec = token.expires_at ? Math.floor(token.expires_at / 1000) : 0;
  c.header(
    "subscription-userinfo",
    `upload=0; download=${usedBytes}; total=${totalBytes}; expire=${expireSec}`
  );
  c.header("content-type", "text/yaml; charset=utf-8");
  c.header("content-disposition", 'attachment; filename="clash.yaml"');
  return c.body(yaml);
});
