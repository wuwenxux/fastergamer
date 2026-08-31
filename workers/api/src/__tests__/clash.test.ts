import { describe, expect, it } from "vitest";
import type { Node } from "../../../../shared/types";
import { buildClashConfig, supportsGeosite } from "../lib/clash";

const NODES: Node[] = [
  { id: "n1", key: "k", name: "香港 CN2", region: "HK", host: "hk1.example.com", port: 443, tls: true, ws_path: "/ws", active: true },
  { id: "n2", key: "k", name: "香港 IPLC", region: "HK", host: "hk2.example.com", port: 443, tls: true, ws_path: "/ws", active: true },
  { id: "n3", key: "k", name: "日本 BGP", region: "JP", host: "jp1.example.com", port: 8443, tls: true, ws_path: "/ws", active: true },
  { id: "n4", key: "k", name: "下线节点", region: "US", host: "us1.example.com", port: 443, tls: true, ws_path: "/ws", active: false },
];

const UUID = "11111111-2222-3333-4444-555555555555";
const NEW_UA = "clash-verge/v2.0";
const OLD_UA = "ClashforWindows/0.20.39";

/** 截取 proxy-groups 中某个分组的文本块（到下一个分组或文件尾） */
function groupBlock(config: string, name: string): string {
  const groups = config.slice(config.indexOf("proxy-groups:"));
  const start = groups.indexOf(`  - name: "${name}"`);
  expect(start, `group ${name} should exist`).toBeGreaterThanOrEqual(0);
  const rest = groups.slice(start);
  const next = rest.indexOf("\n  - name:", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("buildClashConfig 分组结构", () => {
  const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA });

  it("主 select 组含自动选择 + 各区域组 + 单节点", () => {
    const main = groupBlock(config, "🚀 节点选择");
    expect(main).toContain("type: select");
    expect(main).toContain('"♻️ 自动选择"');
    expect(main).toContain('"🇭🇰 香港"');
    expect(main).toContain('"🇯🇵 日本"');
    expect(main).toContain('"HK 香港 01"');
    expect(main).toContain('"HK 香港 02"');
    expect(main).toContain('"JP 日本 03"');
  });

  it("每个区域 url-test 组只含本区域节点", () => {
    const hk = groupBlock(config, "🇭🇰 香港");
    expect(hk).toContain("type: url-test");
    expect(hk).toContain('"HK 香港 01"');
    expect(hk).toContain('"HK 香港 02"');
    expect(hk).not.toContain('"JP 日本 03"');

    const jp = groupBlock(config, "🇯🇵 日本");
    expect(jp).toContain("type: url-test");
    expect(jp).toContain('"JP 日本 03"');
    expect(jp).not.toContain("香港");
  });

  it("inactive 节点不出现在配置里", () => {
    expect(config).not.toContain("下线节点");
    expect(config).not.toContain("us1.example.com");
  });

  it("每个代理开启 UDP 中继", () => {
    const udpCount = (config.match(/^\s+udp: true$/gm) ?? []).length;
    const activeCount = NODES.filter((n) => n.active).length;
    expect(udpCount).toBe(activeCount);
  });
});

describe("supportsGeosite UA 判断", () => {
  it.each(["mihomo/v1.18", "clash-verge/v2.0", "Clash.Meta", "Stash/2.5", "FlClash/v0.8"])(
    "%s → true",
    (ua) => {
      expect(supportsGeosite(ua)).toBe(true);
    }
  );

  it.each(["ClashforWindows/0.20.39", "ClashX/1.0", ""])("%s → false", (ua) => {
    expect(supportsGeosite(ua)).toBe(false);
  });

  it("undefined → false", () => {
    expect(supportsGeosite(undefined)).toBe(false);
  });
});

describe("GEOSITE 规则按 UA 降级", () => {
  it("老 UA：无 GEOSITE,CN 规则，dns 用 +.cn policy", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: OLD_UA });
    expect(config).not.toContain("GEOSITE,CN");
    expect(config).toContain('"+.cn": 223.5.5.5');
    expect(config).not.toContain('"geosite:cn"');
  });

  it("新 UA：GEOSITE,CN 规则与 geosite dns policy 都在", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA });
    expect(config).toContain("GEOSITE,CN,DIRECT");
    expect(config).toContain('"geosite:cn": 223.5.5.5');
  });

  it("缺省 UA 按老内核处理", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES });
    expect(config).not.toContain("GEOSITE,CN");
    expect(config).toContain('"+.cn": 223.5.5.5');
  });
});

describe("直连规则", () => {
  it("fastergamer.cn / fastergamer.click 均直连", () => {
    for (const ua of [NEW_UA, OLD_UA]) {
      const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: ua });
      expect(config).toContain("DOMAIN-SUFFIX,fastergamer.cn,DIRECT");
      expect(config).toContain("DOMAIN-SUFFIX,fastergamer.click,DIRECT");
    }
  });
});

describe("节点 IP 直发（nodeIps）", () => {
  it("命中时 server 用 IP，servername / WS Host 保留域名", () => {
    const config = buildClashConfig({
      uuid: UUID,
      nodes: NODES,
      userAgent: NEW_UA,
      nodeIps: { "hk1.example.com": "1.2.3.4" },
    });
    expect(config).toContain("server: 1.2.3.4");
    expect(config).toContain("servername: hk1.example.com");
    expect(config).toContain("Host: hk1.example.com");
  });

  it("未命中的节点仍用域名，且不带 WS Host 头", () => {
    const config = buildClashConfig({
      uuid: UUID,
      nodes: NODES,
      userAgent: NEW_UA,
      nodeIps: { "hk1.example.com": "1.2.3.4" },
    });
    expect(config).toContain("server: hk2.example.com");
    const hk2Block = config.slice(config.indexOf("server: hk2.example.com"));
    expect(hk2Block.slice(0, hk2Block.indexOf("- name:", 1) || undefined)).not.toContain("headers:");
  });

  it("不传 nodeIps 时与旧行为一致（全域名）", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA });
    expect(config).toContain("server: hk1.example.com");
    expect(config).not.toContain("headers:");
  });
});

describe("DNS 解析", () => {
  it("nameserver 含阿里 DoH 加速，proxy-server-nameserver 保持单路兜底", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA });
    const nsBlock = config.slice(
      config.indexOf("  nameserver:"),
      config.indexOf("  proxy-server-nameserver:")
    );
    expect(nsBlock).toContain("- https://dns.alidns.com/dns-query");
    expect(nsBlock).toContain("- 223.5.5.5");
    expect(nsBlock).toContain("- 119.29.29.29");
    const psBlock = config.slice(
      config.indexOf("  proxy-server-nameserver:"),
      config.indexOf("  nameserver-policy:")
    );
    expect(psBlock).toContain("- 223.5.5.5");
    expect(psBlock).not.toContain("119.29.29.29");
    expect(psBlock).not.toContain("https://");
  });
});
