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
    expect(main).toContain('"HK 香港 CN2 01"');
    expect(main).toContain('"HK 香港 IPLC 02"');
    expect(main).toContain('"JP 日本 BGP 03"');
  });

  it("每个区域 url-test 组只含本区域节点", () => {
    const hk = groupBlock(config, "🇭🇰 香港");
    expect(hk).toContain("type: url-test");
    expect(hk).toContain('"HK 香港 CN2 01"');
    expect(hk).toContain('"HK 香港 IPLC 02"');
    expect(hk).not.toContain('"JP 日本 BGP 03"');

    const jp = groupBlock(config, "🇯🇵 日本");
    expect(jp).toContain("type: url-test");
    expect(jp).toContain('"JP 日本 BGP 03"');
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
    expect(config).toContain('"geosite:cn": [https://dns.alidns.com/dns-query, 223.5.5.5]');
  });

  it("新 UA：geolocation-!cn 直接代理抢在 GEOIP 前，且不再下发 1.1.1.1 DoH policy", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA });
    const gfwRule = config.indexOf("GEOSITE,geolocation-!cn,🚀 节点选择");
    expect(gfwRule).toBeGreaterThan(-1);
    // 必须在 GEOIP,CN 之前，否则境外域名仍会为判 GEOIP 触发一次本地解析
    expect(gfwRule).toBeLessThan(config.indexOf("GEOIP,CN,DIRECT"));
    // 1.1.1.1 DoH 在国内实测不可达，且规则前置后该 policy 已是死代码
    expect(config).not.toContain("1.1.1.1");
  });

  it("老 UA：不下发 geolocation-!cn 规则", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: OLD_UA });
    expect(config).not.toContain("geolocation-!cn");
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

describe("OpenAI/Claude 定向规则", () => {
  it("有日本节点时 OpenAI/Claude 域名固定走日本区域组（新老内核一致）", () => {
    for (const ua of [NEW_UA, OLD_UA]) {
      const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: ua });
      expect(config).toContain("DOMAIN-SUFFIX,chatgpt.com,🇯🇵 日本");
      expect(config).toContain("DOMAIN-SUFFIX,openai.com,🇯🇵 日本");
      expect(config).toContain("DOMAIN-SUFFIX,oaistatic.com,🇯🇵 日本");
      expect(config).toContain("DOMAIN-SUFFIX,oaiusercontent.com,🇯🇵 日本");
      expect(config).toContain("DOMAIN-SUFFIX,claude.ai,🇯🇵 日本");
      expect(config).toContain("DOMAIN-SUFFIX,anthropic.com,🇯🇵 日本");
    }
  });

  it("无日本节点时不下发 OpenAI/Claude 定向规则", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES.filter((n) => n.region !== "JP"), userAgent: NEW_UA });
    expect(config).not.toContain("chatgpt.com");
    expect(config).not.toContain("claude.ai");
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

describe("Reality 直连条目（⚡）", () => {
  const R_NODES: Node[] = [
    { ...NODES[0], reality: { port: 8444, password: "PUBKEY", short_id: "abcd1234", server_name: "gateway.icloud.com" } },
    NODES[2], // 无 reality 的节点不出 ⚡ 条目
  ];

  it("mihomo UA：带 reality 的节点生成 ⚡ 条目，字段完整", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: R_NODES, userAgent: NEW_UA });
    expect(config).toContain('"HK 香港 CN2 ⚡03"'); // 序号接在 WS 条目（2 个）之后
    expect(config).toContain("flow: xtls-rprx-vision");
    expect(config).toContain("client-fingerprint: chrome");
    expect(config).toContain("reality-opts:");
    expect(config).toContain("public-key: PUBKEY");
    expect(config).toContain("short-id: abcd1234");
    // Reality 的 SNI 是伪装站，不是节点域名
    expect(config).toContain("servername: gateway.icloud.com");
    // 无 reality 的节点不生成 ⚡
    expect(config).not.toContain("JP 日本 ⚡");
  });

  it("⚡ 条目进全部分组，自动组里排在 WS 前", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: R_NODES, userAgent: NEW_UA });
    expect(groupBlock(config, "🚀 节点选择")).toContain('"HK 香港 CN2 ⚡03"');
    const auto = groupBlock(config, "♻️ 自动选择");
    expect(auto).toContain('"HK 香港 CN2 ⚡03"');
    expect(auto.indexOf('"HK 香港 CN2 ⚡03"')).toBeLessThan(auto.indexOf('"HK 香港 CN2 01"'));
    const hk = groupBlock(config, "🇭🇰 香港");
    expect(hk).toContain('"HK 香港 CN2 ⚡03"');
    expect(hk.indexOf('"HK 香港 CN2 ⚡03"')).toBeLessThan(hk.indexOf('"HK 香港 CN2 01"'));
  });

  it("老内核 UA：不下发 ⚡ 条目，WS 兜底不受影响", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: R_NODES, userAgent: OLD_UA });
    expect(config).not.toContain("⚡");
    expect(config).not.toContain("reality-opts");
    expect(config).toContain('"HK 香港 CN2 01"');
  });
});

describe("Hysteria2 条目（🚀）", () => {
  const H_NODES: Node[] = [
    { ...NODES[0], hy2: { port: 8445 } },
    NODES[2], // 无 hy2 的节点不出 🚀 条目
  ];

  it("mihomo UA：带 hy2 的节点生成 🚀 条目，字段完整", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: H_NODES, userAgent: NEW_UA });
    expect(config).toContain('"HK 香港 CN2 🚀03"'); // 序号接在 WS 条目（2 个）之后
    const hy2Block = config.slice(config.indexOf('"HK 香港 CN2 🚀03"'));
    expect(hy2Block).toContain("type: hysteria2");
    expect(hy2Block).toContain("port: 8445");
    expect(hy2Block).toContain(`password: "${UUID}:x"`);
    expect(hy2Block).toContain("sni: hk1.example.com"); // sni 用节点域名（真实证书）
    // 无 hy2 的节点不生成 🚀
    expect(config).not.toContain("JP 日本 🚀");
    expect((config.match(/type: hysteria2/g) ?? []).length).toBe(1);
  });

  it("nodeIps 命中时 🚀 条目 server 用 IP，sni 仍为域名", () => {
    const config = buildClashConfig({
      uuid: UUID,
      nodes: H_NODES,
      userAgent: NEW_UA,
      nodeIps: { "hk1.example.com": "1.2.3.4" },
    });
    const hy2Block = config.slice(config.indexOf('"HK 香港 CN2 🚀03"'));
    expect(hy2Block).toContain("server: 1.2.3.4");
    expect(hy2Block).toContain("sni: hk1.example.com");
  });

  it("🚀 条目进全部分组且排最前", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: H_NODES, userAgent: NEW_UA });
    expect(groupBlock(config, "🚀 节点选择")).toContain('"HK 香港 CN2 🚀03"');
    const auto = groupBlock(config, "♻️ 自动选择");
    expect(auto).toContain('"HK 香港 CN2 🚀03"');
    expect(auto.indexOf('"HK 香港 CN2 🚀03"')).toBeLessThan(auto.indexOf('"HK 香港 CN2 01"'));
    const hk = groupBlock(config, "🇭🇰 香港");
    expect(hk).toContain('"HK 香港 CN2 🚀03"');
    expect(hk.indexOf('"HK 香港 CN2 🚀03"')).toBeLessThan(hk.indexOf('"HK 香港 CN2 01"'));
  });

  it("老内核 UA：不下发 🚀 条目，WS 兜底不受影响", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: H_NODES, userAgent: OLD_UA });
    expect(config).not.toContain("type: hysteria2");
    expect(config).not.toContain("🚀0");
    expect(config).toContain('"HK 香港 CN2 01"');
  });

  it("编号连续性：WS 2 个 + Reality 1 个时 hy2 序号从 04 开始", () => {
    const config = buildClashConfig({
      uuid: UUID,
      nodes: [
        { ...NODES[0], reality: { port: 8444, password: "PUBKEY", short_id: "abcd1234", server_name: "gateway.icloud.com" }, hy2: { port: 8445 } },
        { ...NODES[1], hy2: { port: 8445 } },
      ],
      userAgent: NEW_UA,
    });
    expect(config).toContain('"HK 香港 CN2 ⚡03"');
    expect(config).toContain('"HK 香港 CN2 🚀04"');
    expect(config).toContain('"HK 香港 IPLC 🚀05"');
    // 自动组内顺序：🚀 在 ⚡ 前（Hy2 优先 → Reality → WS）
    const auto = groupBlock(config, "♻️ 自动选择");
    expect(auto.indexOf('"HK 香港 CN2 🚀04"')).toBeLessThan(auto.indexOf('"HK 香港 CN2 ⚡03"'));
    expect(auto.indexOf('"HK 香港 CN2 ⚡03"')).toBeLessThan(auto.indexOf('"HK 香港 CN2 01"'));
  });
});

describe("DNS 解析", () => {
  it("全局开关：unified-delay + 顶层 ipv6 关闭", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA });
    expect(config).toContain("unified-delay: true");
    expect(config).toContain("ipv6: false");
  });

  it("fake-ip-filter 覆盖 NTP/STUN/系统检测域名", () => {
    const config = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA });
    expect(config).toContain("fake-ip-filter:");
    expect(config).toContain('"stun.*.*"');
    expect(config).toContain('"+.msftconnecttest.com"');
    expect(config).toContain("+.pool.ntp.org");
  });

  it("sniffer 仅对 mihomo 系下发，Premium 不下发", () => {
    const neo = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA });
    expect(neo).toContain("sniffer:");
    expect(neo).toContain("override-destination: true");
    const old = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: OLD_UA });
    expect(old).not.toContain("sniffer:");
  });

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

  it("按运营商调整 UDP 首选解析器与 cn policy 兜底", () => {
    const order = (cfg: string) => {
      const block = cfg.slice(cfg.indexOf("  nameserver:"), cfg.indexOf("  proxy-server-nameserver:"));
      return [block.indexOf("223.5.5.5"), block.indexOf("119.29.29.29")];
    };
    const dianxin = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA, isp: "电信" });
    const [a1, b1] = order(dianxin);
    expect(b1).toBeGreaterThan(-1);
    expect(b1).toBeLessThan(a1); // 电信首选 DNSPod
    expect(dianxin).toContain('"geosite:cn": [https://dns.alidns.com/dns-query, 119.29.29.29]');
    expect(dianxin).not.toContain("114.114.114.114");

    const yidong = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA, isp: "移动" });
    const [a2, b2] = order(yidong);
    expect(a2).toBeGreaterThan(-1);
    expect(a2).toBeLessThan(b2); // 移动首选 AliDNS
    expect(yidong).toContain("114.114.114.114"); // 移动附加 114DNS 兜底

    const unknown = buildClashConfig({ uuid: UUID, nodes: NODES, userAgent: NEW_UA, isp: null });
    const [a3, b3] = order(unknown);
    expect(a3).toBeLessThan(b3); // 默认 AliDNS 优先
    expect(unknown).not.toContain("114.114.114.114");
  });
});
