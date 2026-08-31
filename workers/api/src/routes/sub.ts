import { Hono } from "hono";
import { getTokenByAnyUuid } from "../lib/kv";
import { activatePaidToken } from "../lib/activate";
import { buildClashConfig, parseRegions } from "../lib/clash";
import { getNodes, isBudgetExhausted } from "../lib/nodes";
import { pushAuthRefresh } from "../lib/authpush";
import type { Env } from "../types";

export const subRoutes = new Hono<{ Bindings: Env }>();

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * 订阅下发前把节点域名解析成 IP（DoH 查询，3s 超时，失败静默回退域名）。
 * 背景：节点域名挂在 Cloudflare 权威 DNS，国内递归解析不稳定；
 * 配置里 server 直接写 IP 后客户端完全跳过节点域名解析。
 */
const resolveNodeIps = async (hosts: string[]): Promise<Record<string, string>> => {
  const uniq = [...new Set(hosts.filter((h) => h && !IPV4_RE.test(h)))];
  const entries = await Promise.all(
    uniq.map(async (h): Promise<[string, string] | null> => {
      try {
        const res = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=A`,
          { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) }
        );
        const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
        const ip = json.Answer?.find((a) => a.type === 1)?.data;
        return ip && IPV4_RE.test(ip) ? [h, ip] : null;
      } catch {
        return null;
      }
    })
  );
  return Object.fromEntries(entries.filter((e): e is [string, string] => e !== null));
};

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
  const nodeIps = await resolveNodeIps(nodes.filter((n) => n.active).map((n) => n.host));
  const yaml = buildClashConfig({
    uuid,
    nodes,
    regions: parseRegions(c.env.CLASH_REGIONS),
    userAgent: c.req.header("user-agent"),
    nodeIps,
  });

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
