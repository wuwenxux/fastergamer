/**
 * Clash 订阅配置生成：每个 active 节点生成一个代理。
 * 节点显示名统一为「区域代码 中文地区名 全局序号」，如 "MY 马来西亚 01"（序号按节点列表顺序全局递增）。
 * 分组结构（按区域）：
 *   🚀 节点选择（select）→ ♻️ 自动选择（全部节点 url-test，gstatic 端到端）
 *                        → 🇭🇰 香港 / 🇯🇵 日本 …（各区域 url-test，测本区域节点 /generate_204，
 *                          显示值 ≈ 客户端→节点延迟）
 *                        → 各节点（手动指定）
 * 规则：局域网与国内流量（GEOIP CN）直连，其余走代理。
 */

import type { Node } from "../../../../shared/types";

export interface ClashRegion {
  code: string; // 国家/地区代码，如 HK、JP
  flag: string; // 节点名前缀 emoji
  name: string; // 显示名，如 香港
}

/** 从环境变量 JSON 解析地区列表，解析失败时回退到默认列表 */
export const parseRegions = (raw: string | undefined): ClashRegion[] => {
  try {
    const parsed = raw ? (JSON.parse(raw) as ClashRegion[]) : [];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    /* fall through */
  }
  return [
    { code: "HK", flag: "🇭🇰", name: "香港" },
    { code: "JP", flag: "🇯🇵", name: "日本" },
    { code: "SG", flag: "🇸🇬", name: "新加坡" },
    { code: "US", flag: "🇺🇸", name: "美国" },
  ];
};

export interface BuildConfigInput {
  uuid: string;
  /** 每个 active 节点生成一个代理 */
  nodes?: Node[];
  /** 区域元数据（emoji/显示名/排序），来自 CLASH_REGIONS；缺省用内置列表 */
  regions?: ClashRegion[];
  /** 订阅请求的 User-Agent，用于判断是否支持 GEOSITE 规则 */
  userAgent?: string;
  /** 节点域名 → IP（订阅下发前由 Worker 通过 DoH 解析）。
   *  命中时 server 直接写 IP：Cloudflare 权威 DNS 在国内解析不稳，
   *  客户端直连 IP 可完全跳过节点域名解析；未命中回退域名 */
  nodeIps?: Record<string, string>;
}

/** 支持 GEOSITE 规则的内核：mihomo 系（Verge/Meta/FlClash）与 Stash；
 *  Clash Premium（CFW/ClashX）不支持，碰到 GEOSITE 规则会直接加载失败 */
export const supportsGeosite = (ua: string | undefined): boolean =>
  /mihomo|verge|meta|stash|flclash/i.test(ua ?? "");

const AUTO_GROUP = "♻️ 自动选择";
const MAIN_GROUP = "🚀 节点选择";
const TEST_URL = "http://www.gstatic.com/generate_204";

export const buildClashConfig = ({ uuid, nodes, regions, userAgent, nodeIps }: BuildConfigInput): string => {
  const lines: string[] = [];
  lines.push("mixed-port: 7890", "allow-lan: false", "mode: rule", "log-level: info", "");

  // DNS 分流：国内域名走阿里/腾讯 DNS（结果真实、指向国内 CDN），境外域名走代理解析。
  // 没有这段时 GEOIP/GEOSITE 依赖系统 DNS，被污染或解析到境外 CDN 会导致国内站误判走代理。
  const geosite = supportsGeosite(userAgent);
  // nameserver-policy 的 key：新内核用 geosite 分类；老内核（Premium）用 +.cn 域名后缀
  const cnPolicyKey = geosite ? '"geosite:cn"' : '"+.cn"';
  const gfwPolicyKey = '"geosite:geolocation-!cn"';
  lines.push(
    "dns:",
    "  enable: true",
    "  ipv6: false",
    "  enhanced-mode: fake-ip",
    "  fake-ip-range: 198.18.0.1/16",
    // 目标域名解析：阿里 DoH 放最前（防 UDP 53 被劫持/慢），纯 IP 递归做 bootstrap 兜底
    "  nameserver:",
    "    - https://dns.alidns.com/dns-query",
    "    - 223.5.5.5",
    "    - 119.29.29.29",
    // 节点域名解析保持单路：节点 server 已由 nodeIps 直发 IP，这里仅兜底
    "  proxy-server-nameserver:",
    "    - 223.5.5.5",
    "  nameserver-policy:",
    `    ${cnPolicyKey}: 223.5.5.5`,
    ...(geosite ? [`    ${gfwPolicyKey}: https://1.1.1.1/dns-query`] : []),
    ""
  );
  // 区域元数据提前解析：节点显示名要用它拼中文地区名
  const regionMeta = regions ?? parseRegions(undefined);

  const proxies: {
    name: string;
    region: string;
    /** 客户端实际连接的地址：nodeIps 命中时是 IP，否则是域名 */
    server: string;
    /** 节点域名：TLS servername 与 WS Host 始终用它，不受 server 是否为 IP 影响 */
    host: string;
    port: number;
    tls: boolean;
    wsPath: string;
  }[] = [];

  // 显示名统一为「区域代码 中文地区名 全局序号」，如 "MY 马来西亚 01"、"HK 香港 02"，
  // 序号按节点列表顺序全局递增（跨区域不重排），与后台维护的节点顺序一致
  for (const node of nodes ?? []) {
    if (!node.active) continue;
    const meta = regionMeta.find((r) => r.code === node.region);
    const seq = String(proxies.length + 1).padStart(2, "0");
    proxies.push({
      name: `${node.region} ${meta?.name ?? node.name} ${seq}`,
      region: node.region,
      server: nodeIps?.[node.host] ?? node.host,
      host: node.host,
      port: node.port,
      tls: node.tls,
      wsPath: node.ws_path,
    });
  }

  lines.push("proxies:");
  for (const p of proxies) {
    lines.push(
      `  - name: "${p.name}"`,
      "    type: vless",
      `    server: ${p.server}`,
      `    port: ${p.port}`,
      `    uuid: ${uuid}`,
      "    network: ws",
      `    tls: ${p.tls}`,
      // UDP 中继（游戏/语音/QUIC 走代理依赖它）；VLESS 原生支持，UDP 包走 WS 隧道
      "    udp: true",
      // server 是 IP 时 TLS SNI 仍用域名，证书链校验不受影响
      ...(p.tls ? [`    servername: ${p.host}`] : []),
      "    ws-opts:",
      `      path: "${p.wsPath}"`,
      // server 是 IP 时 WS Host 头必须显式带域名，否则 Caddy 按 IP 匹配不到站点
      ...(p.server !== p.host ? ["      headers:", `        Host: ${p.host}`] : [])
    );
  }

  // 按区域归类：区域顺序跟随 CLASH_REGIONS，未登记的区域排在最后
  const byRegion = new Map<string, string[]>(); // region code -> proxy names
  for (const p of proxies) {
    const list = byRegion.get(p.region) ?? [];
    list.push(p.name);
    byRegion.set(p.region, list);
  }
  const orderedCodes = [
    ...regionMeta.map((r) => r.code).filter((c) => byRegion.has(c)),
    ...[...byRegion.keys()].filter((c) => !regionMeta.some((r) => r.code === c)),
  ];
  const regionGroupName = (code: string) => {
    const meta = regionMeta.find((r) => r.code === code);
    return meta ? `${meta.flag} ${meta.name}` : code;
  };

  lines.push("", "proxy-groups:");
  // 主分组：默认「自动选择」，可切到某区域（区域内自动测速切换）或手动指定单节点
  lines.push(`  - name: "${MAIN_GROUP}"`, "    type: select", "    proxies:");
  lines.push(`      - "${AUTO_GROUP}"`);
  for (const code of orderedCodes) lines.push(`      - "${regionGroupName(code)}"`);
  for (const p of proxies) lines.push(`      - "${p.name}"`);

  // 全局自动选择：url-test 覆盖全部节点，单节点故障无需手动干预。
  // 测速目标保持 gstatic 端到端——它决定实际用哪个节点，必须反映真实上网链路
  lines.push(`  - name: "${AUTO_GROUP}"`, "    type: url-test", "    proxies:");
  for (const p of proxies) lines.push(`      - "${p.name}"`);
  lines.push(`    url: ${TEST_URL}`, "    interval: 300", "    tolerance: 50");

  // 每个区域一个 url-test 分组：锁定区域时仍享受区域内故障切换。
  // 测速目标用本区域首节点的 /generate_204：显示值 ≈ 客户端→节点延迟（区域内核间 <1ms），
  // 不含节点→外网段；节点故障时该节点本身测速失败会被自动剔除，不影响选择正确性。
  const regionTestUrl = (code: string) => {
    const host = proxies.find((p) => p.region === code)?.host;
    return host ? `https://${host}/generate_204` : TEST_URL;
  };
  for (const code of orderedCodes) {
    lines.push(`  - name: "${regionGroupName(code)}"`, "    type: url-test", "    proxies:");
    for (const name of byRegion.get(code)!) lines.push(`      - "${name}"`);
    lines.push(`    url: ${regionTestUrl(code)}`, "    interval: 300", "    tolerance: 50");
  }

  lines.push("", "rules:");
  // 订阅/官网域名强制直连：防止全局模式或 TUN 下访问订阅域名被送进代理节点，
  // 节点异常时订阅更新失败（GEOIP 规则在全局模式下不生效）。
  // fastergamer.click 是订阅+API 中心，必须覆盖（GEOIP 判定为境外 CF IP，会走代理）
  lines.push("  - DOMAIN-SUFFIX,fastergamer.cn,DIRECT");
  lines.push("  - DOMAIN-SUFFIX,fastergamer.click,DIRECT");
  // 局域网/本机直连
  lines.push(
    "  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
    "  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
    "  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
    "  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve"
  );
  // 国内站点直连：
  // 1) GEOSITE,CN 按域名匹配（cn 域名列表），fake-ip / 域名先行场景也能命中——
  //    仅 mihomo/Stash 等新内核支持，老内核（Premium）下发会整个配置加载失败，按 UA 降级
  // 2) GEOIP,CN 按解析结果 IP 兜底（DNS 已分流到国内 DNS，判定可靠）
  if (geosite) lines.push("  - GEOSITE,CN,DIRECT");
  lines.push("  - GEOIP,CN,DIRECT");
  lines.push(`  - MATCH,${MAIN_GROUP}`);

  return lines.join("\n");
};
