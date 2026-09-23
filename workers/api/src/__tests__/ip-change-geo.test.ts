import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KV, type IpGeo, type Presence, type Token } from "../../../../shared/types";

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});

import { sendMail } from "../lib/email-aliyun";
import {
  geoLocationKey,
  notifyIpChange,
  resolveConcurrentGeoConflict,
  resolveIpLocationChange,
  type ConcurrentGeoConflict,
} from "../lib/risk-notify";
import type { Env } from "../types";

/**
 * 归属地查询走 geo-stats 共享通道：geo:{ip} KV 缓存优先，miss 调 ip-api.com 批量接口并回写缓存。
 * 这里 mock ip-api 的批量 fetch（POST，body 为 IP 数组），KV 用内存假实现。
 */

const fakeNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cursor: "" }),
  } as unknown as KVNamespace;
  return { ns, store };
};

const tokens = fakeNs();
const env = { TOKENS: tokens.ns } as unknown as Env;

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_test",
  uuid: "uuid-1",
  plan_id: "plan_monthly",
  status: "active",
  traffic_limit_gb: 20,
  traffic_used_gb: 1,
  purchased_at: 1_000,
  contact: "user@example.com",
  ...overrides,
});

const geoOf = (country: string, region: string, city: string, isp?: string): IpGeo => ({
  country,
  countryCode: "CN",
  region,
  city,
  lat: 30,
  lon: 104,
  isp,
});

/** 批量接口应答构造：请求体 IP 数组 → 每条按 map 生成 success/fail */
const batchResponse = (
  map: Record<string, { country: string; region: string; city: string; isp?: string } | null>
) => {
  return (init: RequestInit) => {
    const ips = JSON.parse(init.body as string) as string[];
    return new Response(
      JSON.stringify(
        ips.map((ip) => {
          const g = map[ip];
          if (!g) return { status: "fail", query: ip };
          return {
            status: "success",
            query: ip,
            country: g.country,
            countryCode: "CN",
            regionName: g.region,
            city: g.city,
            lat: 30,
            lon: 104,
            isp: g.isp,
          };
        })
      ),
      { status: 200 }
    );
  };
};

/** mock ip-api 批量接口：所有 IP 返回同一归属地 */
const stubGeo = (country: string, region: string, city: string, isp?: string) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const ips = JSON.parse(init.body as string) as string[];
      const map: Record<string, { country: string; region: string; city: string; isp?: string }> = {};
      for (const ip of ips) map[ip] = { country, region, city, isp };
      return batchResponse(map)(init);
    })
  );
};

/** 按 IP 分别 mock ip-api 批量应答；map 里缺失或为 null 的 IP 模拟查询失败（status=fail） */
const stubGeoByIp = (
  map: Record<string, { country: string; region: string; city: string; isp?: string } | null>
) => {
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => batchResponse(map)(init)));
};

/** 整个批量请求失败（网络异常/限速）：fail-open，所有 IP 按未解析处理 */
const stubGeoFail = () => {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("timeout"))));
};

beforeEach(() => {
  vi.clearAllMocks();
  tokens.store.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("geoLocationKey 位置键", () => {
  it("只含国家/省份/城市，不含运营商", () => {
    expect(geoLocationKey(geoOf("中国", "四川", "成都", "电信"))).toBe("中国 / 四川 / 成都");
  });
});

describe("resolveIpLocationChange 接入地点变更判定", () => {
  it("首次建基线：不发，只记录 active_geo", async () => {
    stubGeo("中国", "四川", "成都");
    const presence: Presence = {};
    const r = await resolveIpLocationChange(env, presence, "node-hk", ["1.2.3.4"]);
    expect(r.changed).toBe(false);
    expect(presence.active_geo).toEqual({ "node-hk": "中国 / 四川 / 成都" });
  });

  it("同城换 IP（家宽漂移/切运营商）：不发，基线原值不变", async () => {
    stubGeo("中国", "四川", "成都", "移动"); // 运营商标签抖动
    const presence: Presence = { active_geo: { "node-hk": "中国 / 四川 / 成都" } };
    const r = await resolveIpLocationChange(env, presence, "node-hk", ["5.6.7.8"]);
    expect(r.changed).toBe(false);
    expect(presence.active_geo!["node-hk"]).toBe("中国 / 四川 / 成都");
  });

  it("跨城市变更：发，基线更新为新位置", async () => {
    stubGeo("中国", "广东", "广州");
    const presence: Presence = { active_geo: { "node-hk": "中国 / 四川 / 成都" } };
    const r = await resolveIpLocationChange(env, presence, "node-hk", ["9.9.9.9"]);
    expect(r.changed).toBe(true);
    expect(r.oldLocation).toBe("中国 / 四川 / 成都");
    expect(r.newLocation).toBe("中国 / 广东 / 广州");
    expect(presence.active_geo!["node-hk"]).toBe("中国 / 广东 / 广州");
  });

  it("geo 查询失败（有基线）：保守按变更处理，基线不动", async () => {
    stubGeoFail();
    const presence: Presence = { active_geo: { "node-hk": "中国 / 四川 / 成都" } };
    const r = await resolveIpLocationChange(env, presence, "node-hk", ["9.9.9.9"]);
    expect(r.changed).toBe(true);
    expect(r.oldLocation).toBe("中国 / 四川 / 成都");
    expect(r.newLocation).toBeUndefined();
    expect(presence.active_geo!["node-hk"]).toBe("中国 / 四川 / 成都");
  });

  it("geo 查询失败（无基线）：首次使用没有变更证据，不发", async () => {
    stubGeoFail();
    const presence: Presence = {};
    const r = await resolveIpLocationChange(env, presence, "node-hk", ["9.9.9.9"]);
    expect(r.changed).toBe(false);
    expect(presence.active_geo).toBeUndefined();
  });

  it("geo 应答 success 但无任何位置字段：按查询失败处理", async () => {
    stubGeoByIp({ "9.9.9.9": { country: "", region: "", city: "" } });
    const presence: Presence = { active_geo: { "node-hk": "中国 / 四川 / 成都" } };
    const r = await resolveIpLocationChange(env, presence, "node-hk", ["9.9.9.9"]);
    expect(r.changed).toBe(true);
    expect(presence.active_geo!["node-hk"]).toBe("中国 / 四川 / 成都");
  });

  it("归属结果回写 geo:{ip} 缓存：同 IP 再查不再发请求", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init: RequestInit) =>
      batchResponse({ "1.2.3.4": { country: "中国", region: "四川", city: "成都" } })(init)
    );
    vi.stubGlobal("fetch", fetchSpy);
    await resolveIpLocationChange(env, {}, "node-hk", ["1.2.3.4"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const cached = tokens.store.get(KV.GEO + "1.2.3.4");
    expect(cached).toBeTruthy();
    // 第二次走缓存，不再请求
    const r = await resolveIpLocationChange(env, { active_geo: {} }, "node-hk", ["1.2.3.4"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.changed).toBe(false);
  });
});

describe("resolveConcurrentGeoConflict 多地并发在线判定", () => {
  it("少于 2 个不同 IP：不冲突，且不发 geo 请求", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("不应被调用");
      })
    );
    const r = await resolveConcurrentGeoConflict(env, ["1.2.3.4"]);
    expect(r.conflict).toBe(false);
    expect(r.sources).toEqual([]);
    const r2 = await resolveConcurrentGeoConflict(env, ["1.2.3.4", "1.2.3.4"]);
    expect(r2.conflict).toBe(false);
  });

  it("2 个 IP 同一城市（本人新设备/同地多设备）：不冲突", async () => {
    stubGeoByIp({
      "1.2.3.4": { country: "中国", region: "四川", city: "成都", isp: "电信" },
      "5.6.7.8": { country: "中国", region: "四川", city: "成都", isp: "移动" },
    });
    const r = await resolveConcurrentGeoConflict(env, ["1.2.3.4", "5.6.7.8"]);
    expect(r.conflict).toBe(false);
    expect(r.sources).toHaveLength(2);
  });

  it("2 个 IP 不同城市：冲突，sources 带展示串", async () => {
    stubGeoByIp({
      "1.2.3.4": { country: "中国", region: "四川", city: "成都", isp: "电信" },
      "5.6.7.8": { country: "中国", region: "广东", city: "广州", isp: "移动" },
    });
    const r = await resolveConcurrentGeoConflict(env, ["1.2.3.4", "5.6.7.8"]);
    expect(r.conflict).toBe(true);
    expect(r.sources.map((s) => s.display)).toEqual([
      "中国 / 四川 / 成都 / 电信",
      "中国 / 广东 / 广州 / 移动",
    ]);
  });

  it("任一查询失败且 ≥2 个 IP：保守判冲突", async () => {
    stubGeoByIp({
      "1.2.3.4": { country: "中国", region: "四川", city: "成都" },
      "5.6.7.8": null,
    });
    const r = await resolveConcurrentGeoConflict(env, ["1.2.3.4", "5.6.7.8"]);
    expect(r.conflict).toBe(true);
    expect(r.sources[1].display).toBe("归属地查询失败");
  });
});

describe("notifyIpChange 多地并发在线邮件", () => {
  const conflict: ConcurrentGeoConflict = {
    conflict: true,
    sources: [
      { ip: "1.2.3.4", locationKey: "中国 / 四川 / 成都", display: "中国 / 四川 / 成都 / 电信" },
      { ip: "5.6.7.8", locationKey: "中国 / 广东 / 广州", display: "中国 / 广东 / 广州 / 移动" },
    ],
  };

  it("发送邮件：标题为多地同时在线，正文列出各 IP 与归属地，记入 notify_log", async () => {
    const token = makeToken();
    await notifyIpChange(env, token, conflict);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html, text] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe("user@example.com");
    expect(subject).toContain("多个地点同时在线");
    expect(html).toContain("1.2.3.4");
    expect(html).toContain("中国 / 四川 / 成都 / 电信");
    expect(html).toContain("5.6.7.8");
    expect(html).toContain("中国 / 广东 / 广州 / 移动");
    expect(text).toContain("1.2.3.4（中国 / 四川 / 成都 / 电信）");
    expect(token.notify_log?.["ip_change"]).toBeGreaterThan(0);
  });

  it("conflict=false：不发", async () => {
    const token = makeToken();
    await notifyIpChange(env, token, { conflict: false, sources: [] });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("12 小时内已发过：限流不再发", async () => {
    const token = makeToken({ notify_log: { ip_change: Date.now() - 60_000 } });
    await notifyIpChange(env, token, conflict);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("非邮箱联系方式不发", async () => {
    const token = makeToken({ contact: "qq:12345" });
    await notifyIpChange(env, token, conflict);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
