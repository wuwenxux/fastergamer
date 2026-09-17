/**
 * sing-box JSON 订阅（第一期基础版）：SFA / SFI 等 sing-box 系客户端。
 *
 * 节点条目命名/排序与 Clash 共用 clash.ts 的 buildProxyEntries 系列，
 * selector/urltest 分组与 Clash 的「🚀 节点选择 / ♻️ 自动选择」同名同口径
 * （urltest 目标同为共享域名 ping.fastergamer.click 本地终结，interval 5m /
 * tolerance 50）。
 *
 * CN 分流与 clash 同口径（geosite-cn 直连 / geosite-gfw 代理 / geoip-cn 兜底直连），
 * 规则集（.srs）不走 GitHub（国内不可达，启动即下载失败），由 update-clients.py
 * 每日同步到 R2 后引用 dl.fastergamer.click 固定地址；download_detour 固定 direct
 * 避免规则未加载时代理不可用的自举循环。
 */
import type { Node } from "../../../../shared/types";
import {
  buildHy2Entries,
  buildProxyEntries,
  buildRealityEntries,
  parseRegions,
  SPEED_TEST_URL,
  type ClashRegion,
} from "./clash";

export interface BuildSingboxInput {
  uuid: string;
  /** 每个 active 节点生成 outbound */
  nodes?: Node[];
  /** 区域元数据（emoji/显示名/排序），来自 CLASH_REGIONS；缺省用内置列表 */
  regions?: ClashRegion[];
  /** 节点域名 → IP（订阅下发前由 Worker 通过 DoH 解析），命中时 server 写 IP */
  nodeIps?: Record<string, string>;
}

/** 与 clash.ts 的 MAIN_GROUP / AUTO_GROUP 同名：用户跨客户端看到的分组一致 */
const SELECTOR_TAG = "🚀 节点选择";
const URLTEST_TAG = "♻️ 自动选择";

/** 规则集固定地址：R2 桶 fg-clients 的 rules/ 前缀，update-clients.py 每日同步 */
const RULE_SET_BASE = "https://dl.fastergamer.click/rules";

type Outbound = Record<string, unknown>;

export const buildSingboxConfig = ({ uuid, nodes, regions, nodeIps }: BuildSingboxInput): string => {
  const wsEntries = buildProxyEntries(nodes, regions ?? parseRegions(undefined), nodeIps);
  const realityEntries = buildRealityEntries(wsEntries);
  const hy2Entries = buildHy2Entries(wsEntries, realityEntries);
  // 测速池顺序与 clash 自动组同口径：🚀Hy2 → ⚡Reality → WS（延迟实测递增 + tolerance 粘滞）
  const autoPool = [...hy2Entries, ...realityEntries, ...wsEntries];

  const nodeOutbounds: Outbound[] = [];
  for (const p of wsEntries) {
    nodeOutbounds.push({
      type: "vless",
      tag: p.name,
      server: p.server,
      server_port: p.port,
      uuid,
      // tls.server_name 始终用节点域名：server 可能是 nodeIps 直发的 IP，
      // 证书链/SNI 校验与 server 是否为 IP 无关
      ...(p.tls ? { tls: { enabled: true, server_name: p.host } } : {}),
      transport: {
        // sing-box 的 WS 传输枚举值是 "ws"，写 "websocket" 会直接报 unknown transport type
        type: "ws",
        path: p.wsPath,
        // server 是 IP 时 Host 头必须显式带域名，否则 Caddy 按 IP 匹配不到站点
        headers: { Host: p.host },
      },
    });
  }
  for (const p of realityEntries) {
    const r = p.reality!;
    nodeOutbounds.push({
      type: "vless",
      tag: p.name,
      server: p.server,
      server_port: r.port,
      uuid,
      flow: "xtls-rprx-vision",
      tls: {
        enabled: true,
        // Reality 的 SNI 是借用伪装站的域名，与节点自身域名无关
        server_name: r.server_name,
        utls: { enabled: true, fingerprint: "chrome" },
        reality: { enabled: true, public_key: r.password, short_id: r.short_id },
      },
    });
  }
  for (const p of hy2Entries) {
    nodeOutbounds.push({
      type: "hysteria2",
      tag: p.name,
      server: p.server,
      server_port: p.hy2!.port,
      // 与服务端 auth userpass {uuid: "x"} 对应；TLS 证书是节点域名的真实证书
      password: `${uuid}:x`,
      tls: { enabled: true, server_name: p.host },
    });
  }

  const config = {
    log: { level: "info" },
    outbounds: [
      {
        type: "selector",
        tag: SELECTOR_TAG,
        outbounds: [URLTEST_TAG, ...autoPool.map((p) => p.name)],
        default: URLTEST_TAG,
      },
      {
        type: "urltest",
        tag: URLTEST_TAG,
        outbounds: autoPool.map((p) => p.name),
        url: SPEED_TEST_URL,
        interval: "5m",
        tolerance: 50,
      },
      ...nodeOutbounds,
      { type: "direct", tag: "direct" },
    ],
    route: {
      rules: [
        { ip_is_private: true, outbound: "direct" },
        // 小红书例外直连：其 CDN 有境外边缘 IP，geoip 兜底判不准，按域名后缀强判
        { domain_suffix: ["xiaohongshu.com", "xhscdn.com", "xhslink.com"], outbound: "direct" },
        // 与 clash 同口径三层：cn 域名直连 → 已知境外域名代理 → cn IP 兜底直连
        { rule_set: ["geosite-cn"], outbound: "direct" },
        { rule_set: ["geosite-gfw"], outbound: SELECTOR_TAG },
        { rule_set: ["geoip-cn"], outbound: "direct" },
      ],
      rule_set: [
        { tag: "geosite-cn", type: "remote", format: "binary", url: `${RULE_SET_BASE}/geosite-cn.srs`, download_detour: "direct" },
        { tag: "geosite-gfw", type: "remote", format: "binary", url: `${RULE_SET_BASE}/geosite-gfw.srs`, download_detour: "direct" },
        { tag: "geoip-cn", type: "remote", format: "binary", url: `${RULE_SET_BASE}/geoip-cn.srs`, download_detour: "direct" },
      ],
      final: SELECTOR_TAG,
    },
  };
  return JSON.stringify(config, null, 2);
};
