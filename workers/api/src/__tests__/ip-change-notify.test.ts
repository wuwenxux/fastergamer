import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Presence, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * 多地并发在线安全提醒（POST /api/agent/traffic 结算链路驱动）：
 * - 触发：本周期该 token 出现 ≥2 个不同地点的接入 IP（含 30 分钟窗口内最近活跃的 IP）
 * - 单链接换城市（出差/漫游）：只更新 active_geo 基线，不发邮件
 * - 同城多 IP（本人新设备）：不发邮件
 * - 12h 限流：dedup 键 `ip_change:{tokenId}` 由认领存储裁决
 * 只拦截 ip-api.com 批量接口的 fetch，其余出站请求（节点 refresh 推送等）假成功，不触网。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  const { dedupAwareSendMailMock } = await import("./helpers");
  return { ...orig, sendMail: dedupAwareSendMailMock() };
});
import { sendMail } from "../lib/email-aliyun";

import { stubCtx, makeEnv as baseEnv } from "./helpers";

const ctx = stubCtx();

const MONTHLY_PLAN = {
  id: "plan_monthly",
  name: "月付",
  duration_days: 30,
  price_cny: 25,
  traffic_limit_gb: 200,
};

const NODE = {
  id: "node-hk-01",
  key: "node-key-1",
  name: "香港 01",
  region: "HK",
  host: "hk01.example.com",
  port: 443,
  tls: true,
  ws_path: "/vless-ws",
  active: true,
};

// 付费套餐：机房 IP 滥用检查（checkTrialAbuse）只盯体验 token，不会发起 ip-api 请求
const makeEnv = () =>
  baseEnv({
    nodes: [NODE],
    defaultPlans: [MONTHLY_PLAN],
    extra: { SITE_URL: "https://fastergamer.click", ADMIN_NOTIFY_EMAIL: "admin@test.com" },
  });

const IP_API_BATCH = "http://ip-api.com/batch";

/** 按 IP 分别应答 ip-api 批量接口（POST body 为 IP 数组）；未登记的 IP 查询失败；其余出站请求假成功 */
const stubGeoFetch = (map: Record<string, { region: string; city: string } | null>) => {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(IP_API_BATCH) && init?.body) {
      const ips = JSON.parse(init.body as string) as string[];
      return Response.json(
        ips.map((ip) => {
          const g = map[ip];
          if (!g) return { status: "fail", query: ip };
          return {
            status: "success",
            query: ip,
            country: "中国",
            countryCode: "CN",
            regionName: g.region,
            city: g.city,
            lat: 30,
            lon: 104,
            isp: "电信",
          };
        })
      );
    }
    return new Response("ok");
  });
  vi.stubGlobal("fetch", spy);
  return spy;
};

let seq = 0;
const seedToken = (store: Map<string, string>, over: Partial<Token> = {}): Token => {
  seq += 1;
  const token: Token = {
    id: `tk_geo${seq}`,
    uuid: `uuid-geo-${seq}`,
    plan_id: "plan_monthly",
    status: "active",
    traffic_limit_gb: 200,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
    contact: `user${seq}@example.com`,
    expires_at: Date.now() + 30 * 86_400_000,
    ...over,
  };
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
  return token;
};

const readPresence = (store: Map<string, string>, uuid: string): Presence =>
  JSON.parse(store.get(KV.PRESENCE + uuid)!) as Presence;

/** v2 结算制上报：settled 增量 + ip_conns 连接数 */
const report = (env: Env, uuid: string, bytes: number, conns: Record<string, number>) =>
  worker.fetch(
    new Request("https://api.test/api/agent/traffic", {
      method: "POST",
      headers: { "content-type": "application/json", "x-node-key": "node-key-1" },
      body: JSON.stringify({ v: 2, settled: { [uuid]: bytes }, ip_conns: { [uuid]: conns } }),
    }),
    env,
    ctx
  );

const CD = "1.2.3.4"; // 成都
const GZ = "5.6.7.8"; // 广州
const GEO = {
  [CD]: { region: "四川", city: "成都" },
  [GZ]: { region: "广东", city: "广州" },
  "9.9.9.9": { region: "广东", city: "广州" },
  "8.8.8.8": { region: "四川", city: "成都" },
} as Record<string, { region: string; city: string } | null>;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("多地并发在线安全提醒（/api/agent/traffic 链路）", () => {
  it("先单 IP 上线建基线，随后同周期出现两个跨城 IP：发邮件", async () => {
    const { env, tokens } = makeEnv();
    stubGeoFetch(GEO);
    const t = seedToken(tokens.store);

    // 第一周期：只有成都 IP，首次使用建基线，不评估
    await report(env, t.uuid, 1e6, { [CD]: 2 });
    expect(sendMail).not.toHaveBeenCalled();

    // 第二周期：成都 + 广州同时出现（盗用特征），发邮件
    await report(env, t.uuid, 1e6, { [CD]: 1, [GZ]: 2 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe(t.contact);
    expect(subject).toContain("多个地点同时在线");
    expect(html).toContain(CD);
    expect(html).toContain(GZ);
  });

  it("同周期两个同城 IP（本人新设备）：不发邮件", async () => {
    const { env, tokens } = makeEnv();
    stubGeoFetch(GEO);
    const t = seedToken(tokens.store);

    await report(env, t.uuid, 1e6, { [CD]: 2 });
    await report(env, t.uuid, 1e6, { [CD]: 1, "8.8.8.8": 2 });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("单链接换城市（出差漫游）：不发邮件，但 active_geo 基线已更新", async () => {
    const { env, tokens } = makeEnv();
    stubGeoFetch(GEO);
    const t = seedToken(tokens.store);
    // 直接铺基线：上一周期成都单 IP
    tokens.store.set(
      KV.PRESENCE + t.uuid,
      JSON.stringify({
        active_ips: { "node-hk-01": [CD] },
        active_geo: { "node-hk-01": "中国 / 四川 / 成都" },
      } as Presence)
    );

    // 本周期只有广州单 IP：无并发证据，不打扰，基线漂移到广州
    // （存量裸字符串基线无时间基线：本次只更新基线，旅行检测不判定、不发旅行邮件）
    await report(env, t.uuid, 1e6, { [GZ]: 2 });
    expect(sendMail).not.toHaveBeenCalled();
    const presence = readPresence(tokens.store, t.uuid);
    expect(presence.active_geo?.["node-hk-01"]).toMatchObject({ g: "中国 / 广东 / 广州" });
  });

  it("30 分钟窗口内最近活跃的其他城市 IP 也算并发源：跨请求兜住盗用", async () => {
    const { env, tokens } = makeEnv();
    stubGeoFetch(GEO);
    const t = seedToken(tokens.store);
    // 另一节点/另一请求上报过的成都 IP，10 分钟前活跃
    tokens.store.set(
      KV.PRESENCE + t.uuid,
      JSON.stringify({
        active_ips: { "node-hk-01": [CD] },
        active_geo: { "node-hk-01": "中国 / 四川 / 成都" },
        traffic_by_ip: { [CD]: { bytes: 1000, conns: 5, last_seen_at: Date.now() - 600_000 } },
      } as Presence)
    );

    // 本周期只有广州 IP，但与窗口内的成都 IP 构成两地并发：发邮件
    await report(env, t.uuid, 1e6, { [GZ]: 2 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMail).mock.calls[0][2]).toContain("多个地点同时在线");
  });

  it("12 小时内已发过（认领键在窗口内）：限流不再发", async () => {
    const { env, tokens, shareGuard } = makeEnv();
    stubGeoFetch(GEO);
    const t = seedToken(tokens.store);
    // ip_change 认领键 1 分钟前已占用（12h 窗口内）
    shareGuard.claims.set(`ip_change:${t.id}`, Date.now() - 60_000);

    await report(env, t.uuid, 1e6, { [CD]: 2 });
    await report(env, t.uuid, 1e6, { [CD]: 1, [GZ]: 2 });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
