/**
 * Clash 订阅配置生成：每个 active 节点生成一个代理，
 * 「自动选择」url-test 分组做故障切换，「选择节点」select 分组供手动指定。
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
}

export const buildClashConfig = ({ uuid, nodes }: BuildConfigInput): string => {
  const lines: string[] = [];
  lines.push("mixed-port: 7890", "allow-lan: false", "mode: rule", "log-level: info", "");

  const proxies: { name: string; server: string; port: number; tls: boolean; wsPath: string }[] = [];

  for (const node of nodes ?? []) {
    if (!node.active) continue;
    proxies.push({
      name: `${node.region} ${node.name}`,
      server: node.host,
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
      ...(p.tls ? [`    servername: ${p.server}`] : []),
      "    ws-opts:",
      `      path: "${p.wsPath}"`
    );
  }

  lines.push("", "proxy-groups:");
  // url-test 分组：客户端按延迟自动切换可用节点，单节点故障时无需手动干预
  lines.push(
    `  - name: "🚀 自动选择"`,
    "    type: url-test",
    "    proxies:"
  );
  for (const p of proxies) lines.push(`      - "${p.name}"`);
  lines.push(
    "    url: http://www.gstatic.com/generate_204",
    "    interval: 300",
    "    tolerance: 50"
  );
  // select 分组默认选中「自动选择」，用户也可手动指定节点
  lines.push(`  - name: "🚀 选择节点"`, "    type: select", "    proxies:");
  lines.push(`      - "🚀 自动选择"`);
  for (const p of proxies) lines.push(`      - "${p.name}"`);

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
  // 国内流量直连：避免银行/政务类 App 因境外 IP 触发风控，也省节点流量
  lines.push("  - GEOIP,CN,DIRECT");
  lines.push(`  - MATCH,🚀 选择节点`);

  return lines.join("\n");
};
