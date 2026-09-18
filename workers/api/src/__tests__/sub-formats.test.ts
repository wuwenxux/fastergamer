import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, type Node, type Token } from "../../../../shared/types";
import { subRoutes } from "../routes/sub";
import { invalidateNodesCache } from "../lib/nodes";
import type { Env } from "../types";

/** 假 KV：map 实现（put 忽略 TTL 等选项，测试只关心存在性） */
const fakeNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
  return { ns, store };
};

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const NODES: Node[] = [
  {
    id: "n1",
    key: "k",
    name: "香港 CN2",
    region: "HK",
    host: "hk1.example.com",
    port: 443,
    tls: true,
    ws_path: "/ws",
    active: true,
    reality: { port: 8444, password: "PUBKEY", short_id: "abcd1234", server_name: "gateway.icloud.com" },
    hy2: { port: 8445 },
  },
  { id: "n2", key: "k", name: "日本 BGP", region: "JP", host: "jp1.example.com", port: 8443, tls: true, ws_path: "/ws", active: true },
  // tls=false 节点：vless 行应省略 security/sni
  { id: "n3", key: "k", name: "直连节点", region: "US", host: "us1.example.com", port: 80, tls: false, ws_path: "/ws", active: true },
  { id: "n4", key: "k", name: "下线节点", region: "US", host: "down.example.com", port: 443, tls: true, ws_path: "/ws", active: false },
];

const UUID = "11111111-2222-3333-4444-555555555555";

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_test1",
  uuid: UUID,
  plan_id: "plan_monthly",
  status: "active",
  traffic_limit_gb: 100,
  traffic_used_gb: 12.5,
  purchased_at: Date.now() - 86_400_000,
  expires_at: Date.now() + 30 * 86_400_000,
  ...overrides,
});

const makeEnv = (tokens: KVNamespace, nodes: KVNamespace) =>
  ({
    TOKENS: tokens,
    NODES: nodes,
    PLANS: fakeNs().ns,
    ORDERS: fakeNs().ns,
    TICKETS: fakeNs().ns,
    DEFAULT_PLANS: JSON.stringify([
      { id: "plan_monthly", name: "月付", duration_days: 30, price_cny: 15, description: "" },
    ]),
    SITE_URL: "https://fastergamer.click",
  }) as unknown as Env;

const app = new Hono<{ Bindings: Env }>();
app.route("/api/sub", subRoutes);

interface Fixture {
  env: Env;
  tokens: ReturnType<typeof fakeNs>;
}

/** 每个用例独立 KV：写入节点注册表 + 指定 token；getNodes 有 60s isolate 缓存，必须失效 */
const setup = async (token?: Token): Promise<Fixture> => {
  const tokens = fakeNs();
  const nodes = fakeNs();
  await nodes.ns.put(KV.NODES, JSON.stringify(NODES));
  if (token) {
    await tokens.ns.put(KV.TOKEN + token.uuid, JSON.stringify(token));
    await tokens.ns.put(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
  }
  invalidateNodesCache();
  return { env: makeEnv(tokens.ns, nodes.ns), tokens };
};

const getSub = (env: Env, uuid: string, opts: { ua?: string; format?: string } = {}) => {
  const url = `/api/sub?uuid=${uuid}${opts.format !== undefined ? `&format=${opts.format}` : ""}`;
  return app.request(url, { headers: opts.ua ? { "user-agent": opts.ua } : {} }, env, ctx);
};

/** base64 → UTF-8 文本（验证输出确实是可解码的标准 base64）；不用 Buffer，与 Worker 运行时同口径 */
const decodeB64 = (b64: string): string => {
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
};

beforeEach(() => {
  // resolveNodeIps 会对非 IP 节点域名打 DoH：测试环境禁外网，桩成无解析结果（回退域名）
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => ({ Answer: [] }) }) as unknown as typeof fetch)
  );
});

describe("订阅格式路由（UA 识别）", () => {
  it.each([
    ["v2rayNG/1.8.19", "text/plain"],
    ["NekoBox/Android/1.3.0", "text/plain"],
    // Shadowrocket 改发 Clash YAML：官方兼容导入，规则/分组/url-test 测速地址随之生效
    ["Shadowrocket/2.2.50", "text/yaml"],
    ["sing-box/1.11.4", "application/json"],
    ["SFA/1.11.0", "application/json"],
    ["SFI/1.10.0", "application/json"],
    ["clash-verge/v2.0", "text/yaml"],
    ["ClashforWindows/0.20.39", "text/yaml"],
  ])("UA %s → %s", async (ua, contentType) => {
    const { env } = await setup(makeToken());
    const res = await getSub(env, UUID, { ua });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain(contentType);
  });

  it("无 UA → 默认 clash", async () => {
    const { env } = await setup(makeToken());
    const res = await getSub(env, UUID);
    expect(res.headers.get("content-type")).toContain("text/yaml");
  });
});

describe("订阅格式路由（format 参数）", () => {
  it("format 参数优先于 UA", async () => {
    const { env } = await setup(makeToken());
    const res1 = await getSub(env, UUID, { ua: "clash-verge/v2.0", format: "vless" });
    expect(res1.headers.get("content-type")).toContain("text/plain");
    const res2 = await getSub(env, UUID, { ua: "v2rayNG/1.8.19", format: "clash" });
    expect(res2.headers.get("content-type")).toContain("text/yaml");
    const res3 = await getSub(env, UUID, { format: "singbox" });
    expect(res3.headers.get("content-type")).toContain("application/json");
  });

  it("非法 format 值回退 clash", async () => {
    const { env } = await setup(makeToken());
    const res = await getSub(env, UUID, { ua: "v2rayNG/1.8.19", format: "bogus" });
    expect(res.headers.get("content-type")).toContain("text/yaml");
  });

  it("三种格式都带 userinfo / 更新间隔头，文件名随格式", async () => {
    const { env } = await setup(makeToken());
    const cases: [string | undefined, string, string][] = [
      [undefined, "text/yaml", "fastergamer.yaml"],
      ["vless", "text/plain", "fastergamer.txt"],
      ["singbox", "application/json", "fastergamer.json"],
    ];
    for (const [format, contentType, filename] of cases) {
      const res = await getSub(env, UUID, { format });
      expect(res.headers.get("content-type")).toContain(contentType);
      expect(res.headers.get("content-disposition")).toContain(filename);
      const info = res.headers.get("subscription-userinfo");
      expect(info).toContain(`download=${Math.round(12.5 * 1024 ** 3)}`);
      expect(info).toContain(`total=${Math.round(100 * 1024 ** 3)}`);
      expect(res.headers.get("profile-update-interval")).toBe("24");
    }
  });
});

describe("vless 通用订阅内容", () => {
  const getLines = async (): Promise<string[]> => {
    const { env } = await setup(makeToken());
    const res = await getSub(env, UUID, { format: "vless" });
    expect(res.status).toBe(200);
    return decodeB64(await res.text()).split("\n");
  };

  it("可 base64 解码，条目顺序 WS → ⚡Reality → 🚀Hy2，inactive 节点不出现", async () => {
    const lines = await getLines();
    expect(lines).toHaveLength(5); // WS ×3 + ⚡ ×1 + 🚀 ×1
    expect(lines[0]).toMatch(/^vless:\/\//);
    expect(lines[0]).toContain(encodeURIComponent("HK 香港 CN2 01"));
    expect(lines[1]).toContain(encodeURIComponent("JP 日本 BGP 02"));
    expect(lines[2]).toContain(encodeURIComponent("US 直连节点 03"));
    expect(lines[3]).toContain(encodeURIComponent("HK 香港 CN2 ⚡04"));
    expect(lines[4]).toMatch(/^hysteria2:\/\//);
    expect(lines[4]).toContain(encodeURIComponent("HK 香港 CN2 🚀05"));
    expect(lines.join("\n")).not.toContain("down.example.com");
  });

  it("WS 条目 query 字段正确（tls 节点带 security/sni，tls=false 省略）", async () => {
    const lines = await getLines();
    const q = new URLSearchParams(lines[0].split("?")[1].split("#")[0]);
    expect(lines[0]).toContain(`vless://${UUID}@hk1.example.com:443?`);
    expect(q.get("encryption")).toBe("none");
    expect(q.get("security")).toBe("tls");
    expect(q.get("sni")).toBe("hk1.example.com");
    expect(q.get("type")).toBe("ws");
    expect(q.get("path")).toBe("/ws");
    expect(q.get("host")).toBe("hk1.example.com");

    const qPlain = new URLSearchParams(lines[2].split("?")[1].split("#")[0]);
    expect(lines[2]).toContain(`vless://${UUID}@us1.example.com:80?`);
    expect(qPlain.get("security")).toBeNull();
    expect(qPlain.get("sni")).toBeNull();
    expect(qPlain.get("type")).toBe("ws");
  });

  it("⚡Reality 条目带 pbk/sid/flow，🚀Hy2 密码格式为 <uuid>:x", async () => {
    const lines = await getLines();
    const q = new URLSearchParams(lines[3].split("?")[1].split("#")[0]);
    expect(lines[3]).toContain(`vless://${UUID}@hk1.example.com:8444?`);
    expect(q.get("security")).toBe("reality");
    expect(q.get("flow")).toBe("xtls-rprx-vision");
    expect(q.get("pbk")).toBe("PUBKEY");
    expect(q.get("sid")).toBe("abcd1234");
    expect(q.get("sni")).toBe("gateway.icloud.com");
    expect(q.get("fp")).toBe("chrome");
    expect(q.get("type")).toBe("tcp");

    expect(lines[4]).toContain(`hysteria2://${UUID}:x@hk1.example.com:8445?`);
    const qHy2 = new URLSearchParams(lines[4].split("?")[1].split("#")[0]);
    expect(qHy2.get("sni")).toBe("hk1.example.com");
  });
});

describe("sing-box 订阅内容", () => {
  const getConfig = async (): Promise<Record<string, unknown>> => {
    const { env } = await setup(makeToken());
    const res = await getSub(env, UUID, { format: "singbox" });
    expect(res.status).toBe(200);
    return JSON.parse(await res.text()) as Record<string, unknown>;
  };

  it("输出是合法 JSON，outbound 必填字段齐全", async () => {
    const cfg = await getConfig();
    const outbounds = cfg.outbounds as Record<string, unknown>[];
    // 3 WS + 1 reality + 1 hy2 + selector + urltest + direct
    expect(outbounds).toHaveLength(8);
    const byTag = new Map(outbounds.map((o) => [o.tag as string, o]));

    const ws = byTag.get("HK 香港 CN2 01")!;
    expect(ws.type).toBe("vless");
    expect(ws.server).toBe("hk1.example.com");
    expect(ws.server_port).toBe(443);
    expect(ws.uuid).toBe(UUID);
    expect(ws.tls).toMatchObject({ enabled: true, server_name: "hk1.example.com" });
    expect(ws.transport).toMatchObject({
      type: "ws",
      path: "/ws",
      headers: { Host: "hk1.example.com" },
    });

    // tls=false 节点不下发 tls 块
    const plain = byTag.get("US 直连节点 03")!;
    expect(plain.type).toBe("vless");
    expect(plain.tls).toBeUndefined();

    const reality = byTag.get("HK 香港 CN2 ⚡04")!;
    expect(reality.type).toBe("vless");
    expect(reality.server_port).toBe(8444);
    expect(reality.flow).toBe("xtls-rprx-vision");
    expect(reality.tls).toMatchObject({
      enabled: true,
      server_name: "gateway.icloud.com",
      utls: { enabled: true, fingerprint: "chrome" },
      reality: { enabled: true, public_key: "PUBKEY", short_id: "abcd1234" },
    });

    const hy2 = byTag.get("HK 香港 CN2 🚀05")!;
    expect(hy2.type).toBe("hysteria2");
    expect(hy2.server_port).toBe(8445);
    expect(hy2.password).toBe(`${UUID}:x`);
    expect(hy2.tls).toMatchObject({ enabled: true, server_name: "hk1.example.com" });

    expect(byTag.has("下线节点")).toBe(false);
    expect(outbounds.some((o) => o.server === "down.example.com")).toBe(false);
  });

  it("selector / urltest 存在且口径与 clash 自动组一致", async () => {
    const cfg = await getConfig();
    const outbounds = cfg.outbounds as Record<string, unknown>[];
    const selector = outbounds.find((o) => o.type === "selector")!;
    expect(selector.tag).toBe("🚀 节点选择");
    const members = selector.outbounds as string[];
    expect(selector.default).toBe("♻️ 自动选择");
    expect(members[0]).toBe("♻️ 自动选择");
    // 顺序与 clash 自动组同口径：🚀 → ⚡ → WS
    expect(members.slice(1)).toEqual([
      "HK 香港 CN2 🚀05",
      "HK 香港 CN2 ⚡04",
      "HK 香港 CN2 01",
      "JP 日本 BGP 02",
      "US 直连节点 03",
    ]);

    const urltest = outbounds.find((o) => o.type === "urltest")!;
    expect(urltest.tag).toBe("♻️ 自动选择");
    expect(urltest.url).toBe("http://ping.fastergamer.click/generate_204");
    expect(urltest.interval).toBe("5m");
    expect(urltest.tolerance).toBe(50);
    expect(urltest.outbounds).toEqual(members.slice(1));
  });

  it("route 与 clash 同口径 CN 分流，规则集引用自托管 R2 地址", async () => {
    const cfg = await getConfig();
    const route = cfg.route as {
      rules: Record<string, unknown>[];
      rule_set: Record<string, unknown>[];
      final: string;
    };
    expect(route.rules).toEqual([
      { ip_is_private: true, outbound: "direct" },
      // 小红书 CDN 有境外边缘 IP，GEOIP 判不准，按域名后缀强制直连
      { domain_suffix: ["xiaohongshu.com", "xhscdn.com", "xhslink.com"], outbound: "direct" },
      { rule_set: ["geosite-cn"], outbound: "direct" },
      { rule_set: ["geosite-gfw"], outbound: "🚀 节点选择" },
      { rule_set: ["geoip-cn"], outbound: "direct" },
    ]);
    expect(route.final).toBe("🚀 节点选择");
    // 规则集必须全部指向自托管 R2（GitHub 国内不可达），且 direct 下载避免自举循环
    expect(route.rule_set.map((r) => r.tag)).toEqual(["geosite-cn", "geosite-gfw", "geoip-cn"]);
    for (const rs of route.rule_set) {
      expect(rs.type).toBe("remote");
      expect(rs.format).toBe("binary");
      expect(String(rs.url)).toMatch(/^https:\/\/dl\.fastergamer\.click\/rules\/.+\.srs$/);
      expect(rs.download_detour).toBe("direct");
    }
    expect(JSON.stringify(cfg)).not.toContain("github");
  });
});

describe("激活/过期/撤销语义（与格式无关）", () => {
  it("paid token 拉订阅自动激活并开始计时（vless 格式同样生效）", async () => {
    const { env, tokens } = await setup(makeToken({ status: "paid", expires_at: undefined }));
    const res = await getSub(env, UUID, { format: "vless" });
    expect(res.status).toBe(200);
    const stored = JSON.parse(tokens.store.get(KV.TOKEN + UUID)!) as Token;
    expect(stored.status).toBe("active");
    expect(stored.expires_at).toBeGreaterThan(Date.now());
  });

  it("过期 token 403（singbox 格式同样生效）", async () => {
    const { env } = await setup(makeToken({ expires_at: Date.now() - 1000 }));
    const res = await getSub(env, UUID, { format: "singbox" });
    expect(res.status).toBe(403);
  });

  it("未知 uuid 404", async () => {
    const { env } = await setup(makeToken());
    const res = await getSub(env, "00000000-0000-0000-0000-000000000000", { format: "vless" });
    expect(res.status).toBe(404);
  });
});

describe("订阅拉取的客户端识别记录", () => {
  /** 收集 waitUntil 承诺的 ctx，便于测试等到副作用落库 */
  const collectCtx = () => {
    const pending: Promise<unknown>[] = [];
    return {
      pending,
      ctx: {
        waitUntil: (p: Promise<unknown>) => {
          pending.push(Promise.resolve(p).catch(() => {}));
        },
        passThroughOnException: () => {},
      } as unknown as ExecutionContext,
    };
  };

  it("记录 UA/来源 IP/时间到 presence（主 uuid 与设备槽位按键分开）", async () => {
    const devUuid = "aaaaaaaa-0000-0000-0000-000000000001";
    const { env, tokens } = await setup(
      makeToken({
        devices: [{ id: "dv_1", uuid: devUuid, name: "iPhone", traffic_used_gb: 0, created_at: 1 }],
      })
    );
    // 设备槽位索引（getTokenByAnyUuid 反查用）
    await tokens.ns.put(KV.DEVICE + devUuid, JSON.stringify({ token_id: "tk_test1" }));

    const main = collectCtx();
    const res1 = await app.request(
      `/api/sub?uuid=${UUID}`,
      { headers: { "user-agent": "clash-verge/v2.0", "cf-connecting-ip": "1.2.3.4" } },
      env,
      main.ctx
    );
    expect(res1.status).toBe(200);
    const dev = collectCtx();
    const res2 = await app.request(
      `/api/sub?uuid=${devUuid}`,
      { headers: { "user-agent": "Shadowrocket/2.2.57", "cf-connecting-ip": "5.6.7.8" } },
      env,
      dev.ctx
    );
    expect(res2.status).toBe(200);
    await Promise.all([...main.pending, ...dev.pending]);

    const presence = JSON.parse(tokens.store.get(KV.PRESENCE + UUID)!);
    expect(presence.sub_fetches[UUID].ua).toBe("clash-verge/v2.0");
    expect(presence.sub_fetches[UUID].ip).toBe("1.2.3.4");
    expect(presence.sub_fetches[UUID].at).toBeGreaterThan(0);
    expect(presence.sub_fetches[devUuid].ua).toBe("Shadowrocket/2.2.57");
    expect(presence.sub_fetches[devUuid].ip).toBe("5.6.7.8");
  });

  it("过期 token 403，不产生拉取记录", async () => {
    const { env, tokens } = await setup(makeToken({ expires_at: Date.now() - 1000 }));
    const c = collectCtx();
    const res = await app.request(
      `/api/sub?uuid=${UUID}`,
      { headers: { "user-agent": "Shadowrocket/2.2.57" } },
      env,
      c.ctx
    );
    expect(res.status).toBe(403);
    await Promise.all(c.pending);
    expect(tokens.store.has(KV.PRESENCE + UUID)).toBe(false);
  });
});

describe("GET /api/sub/qr 订阅二维码", () => {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  it("存在的 uuid 返回 PNG 二维码，内容为裸订阅链接（不带名称片段）", async () => {
    const { env } = await setup(makeToken());
    const res = await app.request(`/api/sub/qr?uuid=${UUID}`, {}, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf.slice(0, 8)]).toEqual(PNG_SIG);
    // 宽度/高度在 IHDR（第 16 字节起）：35 模块 + 各 4 留白，×6px = 258
    const dv = new DataView(buf.buffer);
    expect(dv.getUint32(16)).toBe(dv.getUint32(20));
    expect(dv.getUint32(16)).toBeGreaterThan(150);
    expect(buf.length).toBeGreaterThan(500);
  });

  it("uuid 缺失 400；token 不存在 404（不对外开放成匿名二维码服务）", async () => {
    const { env } = await setup(makeToken());
    const noParam = await app.request(`/api/sub/qr`, {}, env, ctx);
    expect(noParam.status).toBe(400);
    const notFound = await app.request(`/api/sub/qr?uuid=00000000-0000-0000-0000-000000000000`, {}, env, ctx);
    expect(notFound.status).toBe(404);
  });
});
