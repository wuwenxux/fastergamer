import { Hono } from "hono";
import { getTokenByAnyUuid, recordSubFetch } from "../lib/kv";
import { activatePaidToken } from "../lib/activate";
import { buildClashConfig, parseRegions } from "../lib/clash";
import { buildVlessSubscription } from "../lib/sub-links";
import { buildSingboxConfig } from "../lib/singbox";
import { getNodes, isBudgetExhausted } from "../lib/nodes";
import { ispFromAsn, orderNodesForIsp } from "../lib/isp";
import { pushAuthRefresh } from "../lib/authpush";
import { qrPng } from "../lib/qr-png";
import type { Env } from "../types";

export const subRoutes = new Hono<{ Bindings: Env }>();

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 订阅输出格式：clash（默认）/ vless 链接 / sing-box JSON */
type SubFormat = "clash" | "vless" | "singbox";

/**
 * 格式判定：?format= 显式指定优先（非法值回退 clash）；未指定时按 UA 识别。
 * UA 表：v2rayNG/NekoBox → vless 链接；sing-box/SFA/SFI → singbox；
 * 其余（Clash 系、Shadowrocket 与未知客户端）→ clash。SFA/SFI 大写精确匹配，
 * 避免误伤 UA 里含 "sfa"/"sfi" 子串的其他客户端。
 * Shadowrocket 走 clash：它官方兼容 Clash YAML 配置导入，YAML 里的规则/分组/
 * url-test 测速地址随之生效——vless 链接列表什么都带不了（clash.ts 里对
 * Shadowrocket 只放开 Reality/Hy2 协议条目，GEOSITE 规则仍按老内核口径省略）。
 */
const detectSubFormat = (format: string | undefined, ua: string): SubFormat => {
  if (format !== undefined) {
    return format === "vless" || format === "singbox" ? format : "clash";
  }
  if (/v2rayNG|NekoBox/i.test(ua)) return "vless";
  if (/sing-box|SFA|SFI/.test(ua)) return "singbox";
  return "clash";
};

/**
 * 订阅下发前把节点域名解析成 IP（DoH 查询，3s 超时，失败静默回退域名）。
 * 背景：节点域名挂在 Cloudflare 权威 DNS，国内递归解析不稳定；
 * 配置里 server 直接写 IP 后客户端完全跳过节点域名解析。
 * 结果按 host 在 isolate 内存缓存 1h：节点 IP 极少变化，每次拉订阅都打 6 次 DoH
 * 是子请求的主要来源；host 复指新 IP 时调用 invalidateNodeIpsCache 主动失效。
 */
const NODE_IP_TTL = 3600_000;
const nodeIpCache = new Map<string, { ip: string; at: number }>();

/** 节点 host 复指到新 IP（如 VPS 重建）后调用，清本 isolate 的解析缓存 */
export const invalidateNodeIpsCache = (): void => {
  nodeIpCache.clear();
};

const resolveNodeIps = async (hosts: string[]): Promise<Record<string, string>> => {
  const now = Date.now();
  const result: Record<string, string> = {};
  const stale: string[] = [];
  for (const h of [...new Set(hosts.filter((x) => x && !IPV4_RE.test(x)))]) {
    const hit = nodeIpCache.get(h);
    if (hit && now - hit.at < NODE_IP_TTL) result[h] = hit.ip;
    else stale.push(h);
  }
  if (!stale.length) return result;
  const entries = await Promise.all(
    stale.map(async (h): Promise<[string, string] | null> => {
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
  for (const e of entries) {
    if (!e) continue;
    nodeIpCache.set(e[0], { ip: e[1], at: now });
    result[e[0]] = e[1];
  }
  return result;
};

/**
 * GET /api/sub/qr?uuid={uuid} —— 订阅链接二维码（PNG）。
 * 凭证邮件内嵌 + 移动端「扫一扫」导入用（很多用户不知道链接该粘贴到哪）。
 * 编码内容用请求源 origin 拼接，备用域名访问时二维码跟着指备用域名。
 * 先校验 token 存在：不校验就成了免费匿名二维码服务，且扫出来的链接本来也是无效的。
 */
subRoutes.get("/qr", async (c) => {
  const uuid = c.req.query("uuid");
  if (!uuid) {
    return c.json({ ok: false, error: "uuid parameter is required" }, 400);
  }
  const found = await getTokenByAnyUuid(c.env, uuid);
  if (!found) {
    return c.text("token not found", 404);
  }
  const subUrl = `${new URL(c.req.url).origin}/api/sub?uuid=${encodeURIComponent(uuid)}`;
  const png = await qrPng(subUrl);
  c.header("content-type", "image/png");
  // 内容只随 uuid 变化：邮件客户端/浏览器可长缓存（rotate 换 uuid 后自然是新 URL）
  c.header("cache-control", "public, max-age=86400");
  return c.body(png.buffer as ArrayBuffer);
});

/**
 * GET /api/sub?uuid={uuid}[&format=clash|vless|singbox] —— 订阅下发
 * uuid 可以是 token 主 uuid 或某个设备槽位的 uuid（每台设备独立订阅）
 * 待激活（paid）的 token 首次拉取时自动激活并开始计时；过期/撤销返回 403。
 * 三种格式共用同一份节点过滤（超配额摘除）/ ISP 排序 / DoH 解析结果，
 * 激活/过期/撤销语义与格式无关。
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
  // 按用户运营商（CF 边缘 ASN）静默重排：线路匹配节点排前，首屏即落最优线路
  const isp = ispFromAsn((c.req.raw.cf as { asn?: number } | undefined)?.asn);
  const orderedNodes = orderNodesForIsp(nodes, isp);
  const nodeIps = await resolveNodeIps(orderedNodes.filter((n) => n.active).map((n) => n.host));
  const ua = c.req.header("user-agent") ?? "";
  const regions = parseRegions(c.env.CLASH_REGIONS);
  const format = detectSubFormat(c.req.query("format"), ua);

  // 记录订阅拉取的客户端 UA / 来源 IP（客户端类型识别，管理页「订阅客户端」展示）；
  // 低频路径，waitUntil 不阻塞下发
  c.executionCtx.waitUntil(
    recordSubFetch(c.env, token.uuid, uuid, ua, c.req.header("cf-connecting-ip"))
  );

  let body: string;
  let contentType: string;
  let filename: string;
  if (format === "vless") {
    body = buildVlessSubscription({ uuid, nodes: orderedNodes, regions, nodeIps });
    contentType = "text/plain; charset=utf-8";
    filename = "fastergamer.txt";
  } else if (format === "singbox") {
    body = buildSingboxConfig({ uuid, nodes: orderedNodes, regions, nodeIps });
    contentType = "application/json; charset=utf-8";
    filename = "fastergamer.json";
  } else {
    body = buildClashConfig({ uuid, nodes: orderedNodes, regions, userAgent: ua, nodeIps, isp });
    contentType = "text/yaml; charset=utf-8";
    filename = "fastergamer.yaml";
  }

  // subscription-userinfo：Clash/Stash 客户端可直接显示已用流量与到期时间
  // （不区分上下行，已用量统一计入 download）；三种格式都发——Shadowrocket 等
  // 非 Clash 客户端同样读这个头展示流量
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
  // Clash/Stash 系客户端扫码或添加订阅时用此头做配置文件名，
  // 与 deep link 的 name=fastergamer 保持同名（纯 ASCII 避免 base64 变体兼容问题）
  c.header("profile-title", "fastergamer");
  c.header("content-type", contentType);
  c.header("content-disposition", `attachment; filename=${filename}`);
  return c.body(body);
});
