import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, TRIAL_PLAN_ID, type DeviceGuardEntry, type Presence, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * 设备级防护（lib/device-guard.ts，结算链路驱动）：
 * - 换 IP（顺序行为）不触发；单周期并发不触发（记 dg_pending 等下周期确认）
 * - 持续 2 个周期并发 → 只阻断新出现的 IP（老 IP 不动），台账 status=pending，邮件机主
 * - 白名单 IP 跳过；企业 token 不判定（试用/流量包 max_devices=1 纳入，邮件为单设备口径）
 * - 机主决策：allow（多设备有余量→建槽迁移；单设备/槽位满→临时解封 7 天不建槽）/ deny（阻断保持+置 denied）
 * - blocked_ips 满 50 不写 + 记日志；device_guard 行动后 12h 内抑制 notifyIpChange；邮件 12h 节流
 * 邮件 mock 掉；geo 走 KV 缓存（KV.GEO）或 ip-api 批量接口 stub；其余出站请求假成功，不触网。
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
  price_cny: 12,
  traffic_limit_gb: 20,
};

// 试用套餐 max_devices=1：device-guard 邮件据此走单设备口径（临时解封，不承诺建槽）
const TRIAL_PLAN = {
  id: TRIAL_PLAN_ID,
  name: "试用",
  duration_days: 3,
  price_cny: 0,
  traffic_limit_gb: 1,
  max_devices: 1,
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

// 当前测试 env 的认领存储（fakeShareGuard.claims）：seedToken 默认占用 ip_change 键，
// 压掉多地并发提醒——本文件多数用例只关心 device_guard 邮件
let claimStore: Map<string, number>;

const makeEnv = () => {
  const r = baseEnv({
    nodes: [NODE],
    defaultPlans: [MONTHLY_PLAN, TRIAL_PLAN],
    extra: { SITE_URL: "https://fastergamer.click", ADMIN_NOTIFY_EMAIL: "admin@test.com" },
  });
  claimStore = r.shareGuard.claims;
  return r;
};

let seq = 0;
const seedToken = (store: Map<string, string>, over: Partial<Token> = {}): Token => {
  seq += 1;
  const token: Token = {
    id: `tk_dg${seq}`,
    uuid: `uuid-dg-${seq}`,
    plan_id: "plan_monthly",
    status: "active",
    traffic_limit_gb: 20,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
    contact: `user${seq}@example.com`,
    expires_at: Date.now() + 30 * 86_400_000,
    ...over,
  };
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
  // 默认占用 ip_change 认领键（12h 窗口内）：等价于 ip_change 提醒刚发过，不再打扰
  claimStore?.set(`ip_change:${token.id}`, Date.now());
  return token;
};

const seedOwnerSession = (store: Map<string, string>, token: Token, session = "sess-owner") => {
  store.set(KV.SESSION + session, JSON.stringify({ email: token.contact, created_at: Date.now() }));
  return session;
};

const readToken = (store: Map<string, string>, uuid: string): Token =>
  JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;
const readPresence = (store: Map<string, string>, uuid: string): Presence =>
  JSON.parse(store.get(KV.PRESENCE + uuid)!) as Presence;

/** 铺 geo 缓存（KV.GEO），避免邮件归属地格式化触发 ip-api 请求 */
const seedGeo = (store: Map<string, string>, ip: string, region = "四川", city = "成都") => {
  store.set(
    KV.GEO + ip,
    JSON.stringify({ country: "中国", countryCode: "CN", region, city, lat: 30, lon: 104, isp: "电信" })
  );
};

/** 出站请求默认假成功（pushAuthRefresh 推送等）；可选按 IP 应答 ip-api 批量接口 */
const stubFetch = (geoMap?: Record<string, { region: string; city: string }>) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (geoMap && url.startsWith("http://ip-api.com/batch") && init?.body) {
        const ips = JSON.parse(init.body as string) as string[];
        return Response.json(
          ips.map((ip) => {
            const g = geoMap[ip];
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
    })
  );
};

/** v2 结算制上报：settled 增量 + ip_conns 连接数 */
const report = (env: Env, uuid: string, conns: Record<string, number>) =>
  worker.fetch(
    new Request("https://api.test/api/agent/traffic", {
      method: "POST",
      headers: { "content-type": "application/json", "x-node-key": "node-key-1" },
      body: JSON.stringify({ v: 2, settled: { [uuid]: 1e6 }, ip_conns: { [uuid]: conns } }),
    }),
    env,
    ctx
  );

const guardAction = (env: Env, tokenId: string, action: "allow" | "deny", ip: string, session?: string) =>
  worker.fetch(
    new Request(`https://api.test/api/tokens/${tokenId}/device-guard/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(session ? { authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify({ ip }),
    }),
    env,
    ctx
  );

const IP_A = "1.2.3.4"; // 老 IP（成都）
const IP_B = "5.6.7.8"; // 新 IP（广州）
const CONFIRM_MS = 3 * 60_000 + 1_000; // 比 DG_CONFIRM_MS 多一点

let clock = 0;
beforeEach(() => {
  vi.clearAllMocks();
  clock = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const advance = (ms: number) => {
  clock += ms;
  vi.setSystemTime(clock);
};

describe("设备级防护：判定与自动阻断", () => {
  it("换 IP（旧下线新上线，顺序行为）：不触发任何判定", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store);

    await report(env, t.uuid, { [IP_A]: 2 });
    advance(CONFIRM_MS);
    await report(env, t.uuid, { [IP_B]: 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(saved.device_guard ?? {}).toEqual({});
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("单周期并发（WiFi↔5G 瞬时双 IP）：只记 dg_pending，不阻断不发邮件", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store);

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
    // 可疑新 IP 已暂存，等下周期确认
    expect(readPresence(tokens.store, t.uuid).dg_pending?.[t.uuid]?.ips).toEqual([IP_B]);
  });

  it("持续 2 个周期并发：阻断新 IP（老 IP 不动），台账 pending + 邮件机主", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    // 两个 IP 同城（无 geo 冲突）：ip_change 提醒本身不会触发，其认领键只能来自 device-guard 行动
    seedGeo(tokens.store, IP_A);
    seedGeo(tokens.store, IP_B);
    const t = seedToken(tokens.store);
    // 撤掉默认的 ip_change 占用：验证 device-guard 行动会自己占用它（抑制 12h 内的 ip_change）
    claimStore.delete(`ip_change:${t.id}`);

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    advance(CONFIRM_MS);
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips).toEqual([IP_B]); // 只阻断新 IP，老 IP 不动
    expect(saved.device_guard?.[IP_B]).toMatchObject({ uuid: t.uuid, status: "pending" });
    expect(saved.device_guard?.[IP_B]?.geo).toContain("成都");
    // pending 已清
    expect(readPresence(tokens.store, t.uuid).dg_pending ?? {}).toEqual({});
    // 邮件机主：device_guard 一封；行动已占用 ip_change 键，并发在线提醒被抑制
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe(t.contact);
    expect(subject).toContain("自动拦截");
    expect(html).toContain(IP_B);
    // 多设备口径：引导建槽迁移，不出现单设备文案
    expect(html).toContain("独立槽位");
    expect(html).not.toContain("仅支持 1 台设备");
    // 认领存储：device_guard 键已占用（12h 节流），ip_change 键被行动占用（抑制并发提醒）
    expect(claimStore.has(`device_guard:${t.id}`)).toBe(true);
    expect(claimStore.has(`ip_change:${t.id}`)).toBe(true);
  });

  it("可疑 IP 下周期已离线（只是一次网络切换）：重新记 pending，不阻断", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store);

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    advance(CONFIRM_MS);
    // 下周期并发仍在，但可疑的 IP_B 已离线，换成另一个新 IP
    await report(env, t.uuid, { [IP_A]: 1, "9.9.9.9": 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(readPresence(tokens.store, t.uuid).dg_pending?.[t.uuid]?.ips).toEqual(["9.9.9.9"]);
  });

  it("白名单 IP（token.allowed_ips）不参与判定", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store, { allowed_ips: [IP_B] });

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    advance(CONFIRM_MS);
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(readPresence(tokens.store, t.uuid).dg_pending ?? {}).toEqual({});
  });

  it("试用 token（max_devices=1）纳入判定：两周期并发 → 阻断新 IP，邮件为单设备口径（不承诺建槽）", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    seedGeo(tokens.store, IP_A);
    seedGeo(tokens.store, IP_B, "广东", "广州");
    const t = seedToken(tokens.store, { plan_id: TRIAL_PLAN_ID, traffic_limit_gb: 1 });

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    advance(CONFIRM_MS);
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips).toEqual([IP_B]);
    expect(saved.device_guard?.[IP_B]).toMatchObject({ uuid: t.uuid, status: "pending" });
    // 邮件文案是单设备口径：明说仅支持 1 台设备、临时解封，不承诺创建槽位
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, , html] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe(t.contact);
    expect(html).toContain("仅支持 1 台设备");
    expect(html).toContain("临时解封");
    expect(html).not.toContain("独立槽位");
  });

  it("企业 token（plan_biz_*）仍不判定：团队共享是设计用途", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const biz = seedToken(tokens.store, { plan_id: "plan_biz_yearly", traffic_limit_gb: 0 });

    await report(env, biz.uuid, { [IP_A]: 2 });
    await report(env, biz.uuid, { [IP_A]: 1, [IP_B]: 2 });
    advance(CONFIRM_MS);
    await report(env, biz.uuid, { [IP_A]: 1, [IP_B]: 2 });

    const saved = readToken(tokens.store, biz.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(saved.device_guard ?? {}).toEqual({});
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("blocked_ips 满 50 条：放弃阻断 + 记日志，不发邮件不记台账", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store, {
      blocked_ips: Array.from({ length: 50 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`),
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    advance(CONFIRM_MS);
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips).toHaveLength(50); // 没写进新 IP
    expect(saved.device_guard ?? {}).toEqual({}); // 阻断没生效就不记台账（防假条目）
    expect(sendMail).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("blocked_ips 已满"));
    errSpy.mockRestore();
  });

  it("device_guard 邮件 12h 节流：认领键在窗口内时阻断照做、邮件不发", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store);
    // device_guard 认领键在 12h 窗口内（等价于 1 分钟前刚发过机主邮件）
    claimStore.set(`device_guard:${t.id}`, Date.now() - 60_000);

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    advance(CONFIRM_MS);
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips).toEqual([IP_B]); // 阻断不受节流影响
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("device_guard 行动后 12h 内：多地并发在线提醒（ip_change）被抑制", async () => {
    const { env, tokens } = makeEnv();
    // ip-api 批量接口：IP_A 成都 / IP_B 广州，跨城并发本应收 ip_change 邮件
    stubFetch({ [IP_A]: { region: "四川", city: "成都" }, [IP_B]: { region: "广东", city: "广州" } });
    // ip_change 认领键 1 分钟前被占用（等价于 device-guard 刚行动过：行动会占用该键 12h）
    const t = seedToken(tokens.store);
    claimStore.set(`ip_change:${t.id}`, Date.now() - 60_000);

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    expect(sendMail).not.toHaveBeenCalled(); // 没有 ip_change，也没有 device_guard（单周期只记 pending）
  });
});

describe("设备级防护：机主决策端点", () => {
  /** 直接铺台账与阻断状态（等价于自动阻断后的落库结果）；geo 带城市，槽位名默认「新设备 · 广州」 */
  const seedGuarded = (store: Map<string, string>, over: Partial<Token> = {}) => {
    const entry: DeviceGuardEntry = { uuid: "", at: Date.now(), status: "pending", geo: "中国 / 广东 / 广州" };
    const t = seedToken(store, over);
    entry.uuid = t.uuid;
    t.blocked_ips = [IP_B];
    t.device_guard = { [IP_B]: entry };
    store.set(KV.TOKEN + t.uuid, JSON.stringify(t));
    return t;
  };

  it("allow 有余量：建新槽位 + 解封 + 过渡名单 7 天（不进永久白名单）+ 台账清除 + 响应带槽位；401/404 边界", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedGuarded(tokens.store);
    const session = seedOwnerSession(tokens.store, t);

    const res = await guardAction(env, t.id, "allow", IP_B, session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { slot_created: boolean; device: { id: string; uuid: string; name: string }; transition_until: number };
    };
    // 响应带新槽位（前端引导导入专属链接用）
    expect(body.data.slot_created).toBe(true);
    expect(body.data.device.name).toBe("新设备 · 广州");
    expect(body.data.transition_until).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(saved.device_guard ?? {}).toEqual({});
    // 不进永久白名单，记入涉事凭证（主 uuid）的迁移过渡名单，7 天
    expect(saved.allowed_ips ?? []).toEqual([]);
    expect(saved.transition_ips?.[IP_B]).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    // 新槽位落库 + 反查索引
    const slot = saved.devices?.find((d) => d.id === body.data.device.id);
    expect(slot?.uuid).toBe(body.data.device.uuid);
    expect(JSON.parse(tokens.store.get(KV.DEVICE + slot!.uuid)!)).toEqual({ token_id: t.id });

    // 未登录 401；台账不存在的 IP 404
    const noAuth = await guardAction(env, t.id, "allow", IP_B);
    expect(noAuth.status).toBe(401);
    const missing = await guardAction(env, t.id, "allow", "9.9.9.9", session);
    expect(missing.status).toBe(404);
  });

  it("allow：槽位凭证的过渡名单落到对应 device.transition_ips", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const device = { id: "dv_1", uuid: "uuid-dev-1", name: "我的 iPhone", traffic_used_gb: 0, created_at: 1 };
    const t = seedToken(tokens.store, {
      devices: [device],
      max_devices: 3, // 留出余量
      blocked_ips: [IP_B],
      device_guard: { [IP_B]: { uuid: device.uuid, at: Date.now(), status: "pending" } },
    });
    const session = seedOwnerSession(tokens.store, t);

    const res = await guardAction(env, t.id, "allow", IP_B, session);
    expect(res.status).toBe(200);
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.transition_ips ?? {}).toEqual({}); // 不落主 uuid
    expect(saved.devices?.[0]?.transition_ips?.[IP_B]).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(saved.devices).toHaveLength(2); // 原槽位 + 新槽位
    expect(saved.device_guard ?? {}).toEqual({});
  });

  it("allow 无余量（槽位已满/单设备套餐）：临时解封不建槽——解封 + 过渡名单 7 天 + 台账清除，返回 200", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    // plan_monthly 未设 max_devices → 缺省 2；已有 1 个槽位即满
    const t = seedGuarded(tokens.store, {
      devices: [{ id: "dv_1", uuid: "uuid-dev-1", name: "旧设备", traffic_used_gb: 0, created_at: 1 }],
    });
    const session = seedOwnerSession(tokens.store, t);

    const res = await guardAction(env, t.id, "allow", IP_B, session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { slot_created: boolean; device?: unknown; transition_until: number };
    };
    expect(body.data.slot_created).toBe(false);
    expect(body.data.device).toBeUndefined();
    expect(body.data.transition_until).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]); // 已解封
    expect(saved.device_guard ?? {}).toEqual({}); // 台账清除
    expect(saved.devices).toHaveLength(1); // 没建槽
    expect(saved.transition_ips?.[IP_B]).toBeGreaterThan(Date.now() + 6 * 86_400_000); // 临时解封 7 天
  });

  it("allow 单设备套餐（试用，max_devices=1）：同样只临时解封不建槽", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedGuarded(tokens.store, { plan_id: TRIAL_PLAN_ID, traffic_limit_gb: 1 });
    const session = seedOwnerSession(tokens.store, t);

    const res = await guardAction(env, t.id, "allow", IP_B, session);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { slot_created: boolean } };
    expect(body.data.slot_created).toBe(false);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(saved.device_guard ?? {}).toEqual({});
    expect(saved.devices ?? []).toEqual([]);
    expect(saved.transition_ips?.[IP_B]).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it("allow 建槽失败（KV 写异常）：不残留半状态，阻断与台账保持", async () => {
    const { env, tokens } = baseEnv({ mock: true, nodes: [NODE], defaultPlans: [MONTHLY_PLAN] });
    stubFetch();
    const t = seedGuarded(tokens.store);
    const session = seedOwnerSession(tokens.store, t);
    // 建槽的第一次 saveToken 写主键时失败
    vi.mocked(tokens.ns.put).mockRejectedValueOnce(new Error("kv write failed"));

    const res = await guardAction(env, t.id, "allow", IP_B, session);
    expect(res.status).toBe(500);
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips).toEqual([IP_B]); // 阻断不动
    expect(saved.device_guard?.[IP_B]?.status).toBe("pending");
    expect(saved.devices ?? []).toEqual([]);
    expect(saved.transition_ips ?? {}).toEqual({});
  });

  it("deny：阻断保持 + 台账置 denied；不再重复提醒", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedGuarded(tokens.store);
    const session = seedOwnerSession(tokens.store, t);

    const res = await guardAction(env, t.id, "deny", IP_B, session);
    expect(res.status).toBe(200);
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips).toEqual([IP_B]); // 阻断保持
    expect(saved.device_guard?.[IP_B]?.status).toBe("denied");
  });
});

describe("设备级防护：迁移过渡名单到期核查", () => {
  it("过渡期内的 IP 视同白名单：并发也不触发判定", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store, {
      transition_ips: { [IP_B]: Date.now() + 7 * 86_400_000 },
    });

    await report(env, t.uuid, { [IP_A]: 2 });
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    advance(CONFIRM_MS);
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
    expect(readPresence(tokens.store, t.uuid).dg_pending ?? {}).toEqual({});
    // 未到期名单不动
    expect(saved.transition_ips?.[IP_B]).toBeGreaterThan(Date.now());
  });

  it("过渡到期且仍活跃：移出名单，重新走 pending→确认→阻断", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store, {
      transition_ips: { [IP_B]: Date.now() - 1_000 }, // 已到期
    });

    // 周期 1：到期 IP 仍活跃 → 移出名单 + 记 pending（即使无基线也视为可疑：已给过 7 天窗口）
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    expect(readToken(tokens.store, t.uuid).transition_ips ?? {}).toEqual({});
    expect(readPresence(tokens.store, t.uuid).dg_pending?.[t.uuid]?.ips).toEqual([IP_B]);
    expect(readToken(tokens.store, t.uuid).blocked_ips ?? []).toEqual([]);

    // 周期 2：持续并发 → 阻断
    advance(CONFIRM_MS);
    await report(env, t.uuid, { [IP_A]: 1, [IP_B]: 2 });
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.blocked_ips).toEqual([IP_B]);
    expect(saved.device_guard?.[IP_B]?.status).toBe("pending");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("过渡到期且不活跃：静默移除（换绑完成/自然离开），无任何后续动作", async () => {
    const { env, tokens } = makeEnv();
    stubFetch();
    const t = seedToken(tokens.store, {
      transition_ips: { [IP_B]: Date.now() - 1_000 },
    });

    await report(env, t.uuid, { [IP_A]: 2 }); // 只有老 IP 在线
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.transition_ips ?? {}).toEqual({}); // 静默清除
    expect(saved.blocked_ips ?? []).toEqual([]);
    expect(readPresence(tokens.store, t.uuid).dg_pending ?? {}).toEqual({});
    expect(sendMail).not.toHaveBeenCalled();
  });
});
