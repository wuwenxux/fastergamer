import { Hono } from "hono";
import { getTokenByAnyUuid } from "../lib/kv";
import { activatePaidToken } from "../lib/activate";
import { buildClashConfig, parseRegions } from "../lib/clash";
import { getNodes, isBudgetExhausted } from "../lib/nodes";
import { pushAuthRefresh } from "../lib/authpush";
import type { Env } from "../types";

export const subRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/sub?uuid={uuid} —— 生成 Clash 订阅配置
 * uuid 可以是 token 主 uuid 或某个设备槽位的 uuid（每台设备独立订阅）
 * 待激活（paid）的 token 首次拉取时自动激活并开始计时；过期/撤销返回 403
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
  let { token } = found;

  const now = Date.now();
  // 导入即激活：待激活（paid）的 token 首次被 Clash 拉取订阅时自动激活并开始计时，
  // 避免"复制订阅链接→导入→403"的新手卡点
  if (token.status === "paid") {
    token = await activatePaidToken(c.env, token);
    // 导入即激活的新 uuid 立即进各节点白名单，否则首次连接要等兜底轮询
    c.executionCtx.waitUntil(pushAuthRefresh(c.env));
  }
  if (token.status !== "active" || (token.expires_at && token.expires_at <= now)) {
    return c.text("token 已过期或被撤销，请登录网站查看", 403);
  }

  const nodes = (await getNodes(c.env)).filter((n) => !isBudgetExhausted(n));
  const yaml = buildClashConfig({ uuid, nodes, regions: parseRegions(c.env.CLASH_REGIONS) });

  // subscription-userinfo：Clash/Stash 客户端可直接显示已用流量与到期时间
  // （不区分上下行，已用量统一计入 download）
  const usedBytes = Math.round(token.traffic_used_gb * 1024 ** 3);
  const totalBytes = Math.round(token.traffic_limit_gb * 1024 ** 3);
  const expireSec = token.expires_at ? Math.floor(token.expires_at / 1000) : 0;
  c.header(
    "subscription-userinfo",
    `upload=0; download=${usedBytes}; total=${totalBytes}; expire=${expireSec}`
  );
  // 客户端启动时会检查距上次更新是否超过该间隔（小时），超过才拉取；
  // 设 24 = 实际效果是每次打开客户端时更新一次，不频繁刷
  c.header("profile-update-interval", "24");
  c.header("content-type", "text/yaml; charset=utf-8");
  c.header("content-disposition", "attachment; filename=fastergamer.yaml");
  return c.body(yaml);
});
