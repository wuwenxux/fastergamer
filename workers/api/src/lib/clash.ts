/**
 * Clash 订阅配置生成
 * 支持两种模式：
 * 1. 多节点模式：传入 nodes，每个节点生成一个代理；
 * 2. 兜底模式：nodes 为空时回退到 FALLBACK_NODE_* 环境变量指定的单节点。
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
  /** 多节点模式：每个 active 节点生成一个代理 */
  nodes?: Node[];
  /** 兜底单节点参数（nodes 为空时使用） */
  fallbackHost?: string;
  fallbackPort?: number;
  fallbackTls?: boolean;
  fallbackWsPath?: string;
}

export const buildClashConfig = ({
  uuid,
  nodes,
  fallbackHost,
  fallbackPort,
  fallbackTls,
  fallbackWsPath,
}: BuildConfigInput): string => {
  const lines: string[] = [];
  lines.push("mixed-port: 7890", "allow-lan: false", "mode: rule", "log-level: info", "");

  const proxies: { name: string; server: string; port: number; tls: boolean; wsPath: string }[] = [];

  if (nodes && nodes.length > 0) {
    for (const node of nodes) {
      if (!node.active) continue;
      proxies.push({
        name: `${node.region} ${node.name}`,
        server: node.host,
        port: node.port,
        tls: node.tls,
        wsPath: node.ws_path,
      });
    }
  }

  // 兜底：nodes 注册表为空时回退到 FALLBACK_NODE_* 环境变量指定的单节点
  if (proxies.length === 0 && fallbackHost) {
    proxies.push({
      name: "自动",
      server: fallbackHost,
      port: fallbackPort ?? 443,
      tls: fallbackTls ?? true,
      wsPath: fallbackWsPath ?? "/vless-ws",
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
      ...(p.tls ? [`    servername: ${p.server}`] : []),
      "    ws-opts:",
      `      path: "${p.wsPath}"`
    );
  }

  lines.push("", "proxy-groups:");
  lines.push(`  - name: "🚀 选择节点"`, "    type: select", "    proxies:");
  for (const p of proxies) lines.push(`      - "${p.name}"`);

  lines.push("", "rules:");
  lines.push(`  - MATCH,🚀 选择节点`);

  return lines.join("\n");
};
