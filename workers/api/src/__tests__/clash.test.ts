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
    expect(main).toContain('"HK 香港 CN2"');
    expect(main).toContain('"HK 香港 IPLC"');
    expect(main).toContain('"JP 日本 BGP"');
  });

  it("每个区域 url-test 组只含本区域节点", () => {
    const hk = groupBlock(config, "🇭🇰 香港");
    expect(hk).toContain("type: url-test");
    expect(hk).toContain('"HK 香港 CN2"');
    expect(hk).toContain('"HK 香港 IPLC"');
    expect(hk).not.toContain('"JP 日本 BGP"');

    const jp = groupBlock(config, "🇯🇵 日本");
    expect(jp).toContain("type: url-test");
    expect(jp).toContain('"JP 日本 BGP"');
    expect(jp).not.toContain("香港");
  });

  it("inactive 节点不出现在配置里", () => {
    expect(config).not.toContain("下线节点");
    expect(config).not.toContain("us1.example.com");
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
