import { afterEach, describe, expect, it, vi } from "vitest";
import { KV, type IpGeo } from "../../../../shared/types";
import { aggregateGeoStats, buildGeoStats, resolveIpGeo, type GeoRow } from "../lib/geo-stats";
import type { Env } from "../types";

/**
 * 管理端地理分布（lib/geo-stats.ts）：
 * - aggregateGeoStats 纯函数：城市/国家两级聚合计数去重、按流量降序、未解析 IP 计 unresolved
 * - resolveIpGeo：geo:{ip} 缓存命中不再请求；查询失败的 IP 不写缓存；超出单批补查上限的本次放弃
 * - buildGeoStats：token 列表 → presence 里的 traffic_by_ip → 聚合（presence 键缺失回退 token 旧字段）
 * fetch 全部 mock，不触网。
 */

const fakeNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async (opts?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
  } as unknown as KVNamespace;
  return { ns, store };
};

const makeEnv = () => {
  const tokens = fakeNs();
  return { env: { TOKENS: tokens.ns } as unknown as Env, store: tokens.store };
};

const CD: IpGeo = { country: "China", countryCode: "CN", region: "Sichuan", city: "Chengdu", lat: 30.57, lon: 104.07 };
const BJ: IpGeo = { country: "China", countryCode: "CN", region: "Beijing", city: "Beijing", lat: 39.9, lon: 116.4 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("aggregateGeoStats", () => {
  it("城市/国家聚合计数去重，按流量降序，未解析 IP 计入 unresolved", () => {
    const rows: GeoRow[] = [
      { tokenId: "tk_1", trafficByIp: { "1.1.1.1": { bytes: 100 }, "2.2.2.2": { bytes: 300 } } },
      // tk_2 与 tk_1 共用出口 IP 2.2.2.2（NAT），tokens/ips 去重后不应重复计
      { tokenId: "tk_2", trafficByIp: { "2.2.2.2": { bytes: 50 }, "9.9.9.9": { bytes: 10 } } },
    ];
    const stats = aggregateGeoStats(rows, { "1.1.1.1": CD, "2.2.2.2": BJ });
    expect(stats.total_ips).toBe(3);
    expect(stats.unresolved_ips).toBe(1); // 仅 9.9.9.9 未解析
    // 北京（350B）排在成都（100B）前
    expect(stats.cities.map((c) => c.name)).toEqual(["Beijing", "Chengdu"]);
    const bj = stats.cities[0];
    expect(bj).toMatchObject({ region: "Beijing", country: "China", countryCode: "CN", tokens: 2, ips: 1, bytes: 350 });
    expect(stats.countries).toEqual([{ name: "China", countryCode: "CN", tokens: 2, ips: 2, bytes: 450 }]);
  });

  it("同一 token 多 IP 聚到同城市只计一个 token", () => {
    const rows: GeoRow[] = [
      { tokenId: "tk_1", trafficByIp: { "1.1.1.1": { bytes: 10 }, "1.1.1.2": { bytes: 20 } } },
    ];
    const stats = aggregateGeoStats(rows, { "1.1.1.1": CD, "1.1.1.2": CD });
    expect(stats.cities).toHaveLength(1);
    expect(stats.cities[0]).toMatchObject({ name: "Chengdu", countryCode: "CN", tokens: 1, ips: 2, bytes: 30 });
  });

  it("城市名缺失时回退省份/国家名", () => {
    const rows: GeoRow[] = [{ tokenId: "tk_1", trafficByIp: { "1.1.1.1": { bytes: 1 } } }];
    const stats = aggregateGeoStats(rows, {
      "1.1.1.1": { country: "China", countryCode: "CN", region: "Sichuan", city: "", lat: 30, lon: 104 },
    });
    expect(stats.cities[0].name).toBe("Sichuan");
  });

  it("空数据返回空聚合", () => {
    expect(aggregateGeoStats([], {})).toEqual({
      cities: [],
      countries: [],
      total_ips: 0,
      unresolved_ips: 0,
    });
  });
});

describe("resolveIpGeo", () => {
  it("缓存命中不再发起请求；未命中的查 ip-api 并写缓存", async () => {
    const { env, store } = makeEnv();
    store.set(KV.GEO + "2.2.2.2", JSON.stringify(BJ));
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify([{ status: "success", query: "1.1.1.1", country: "China", countryCode: "CN", regionName: "Sichuan", city: "Chengdu", lat: 30.57, lon: 104.07 }]),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchSpy);

    const geo = await resolveIpGeo(env, ["1.1.1.1", "2.2.2.2"]);
    expect(geo["2.2.2.2"]).toEqual(BJ);
    expect(geo["1.1.1.1"]).toEqual(CD);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get(KV.GEO + "1.1.1.1")!)).toEqual(CD);
    // 2.2.2.2 命中缓存，不应被重复写
    expect(store.get(KV.GEO + "2.2.2.2")).toBe(JSON.stringify(BJ));
  });

  it("ip-api 整体失败时 fail-open：不返回归属也不写缓存", async () => {
    const { env, store } = makeEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 429 })));
    const geo = await resolveIpGeo(env, ["1.1.1.1"]);
    expect(geo).toEqual({});
    expect(store.has(KV.GEO + "1.1.1.1")).toBe(false);
  });

  it("单条失败的 IP 不写缓存，成功的正常缓存", async () => {
    const { env, store } = makeEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { status: "fail", query: "1.1.1.1" },
              { status: "success", query: "2.2.2.2", country: "China", countryCode: "CN", regionName: "Beijing", city: "Beijing", lat: 39.9, lon: 116.4 },
            ]),
            { status: 200 }
          )
      )
    );
    const geo = await resolveIpGeo(env, ["1.1.1.1", "2.2.2.2"]);
    expect(geo["1.1.1.1"]).toBeUndefined();
    expect(geo["2.2.2.2"]).toEqual(BJ);
    expect(store.has(KV.GEO + "1.1.1.1")).toBe(false);
    expect(store.has(KV.GEO + "2.2.2.2")).toBe(true);
  });

  it("超出单批补查上限的 IP 本次放弃，不计缓存不请求", async () => {
    const { env, store } = makeEnv();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    // 上限 4 批 × 15 = 60 个，给 61 个新 IP：只有前 60 个被请求
    const ips = Array.from({ length: 61 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`);
    await resolveIpGeo(env, ips);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    // 第 61 个 IP 未轮到补查
    const lastIp = ips[60];
    const requested = fetchSpy.mock.calls.flatMap((c) => JSON.parse(c[1].body as string) as string[]);
    expect(requested).not.toContain(lastIp);
    expect(store.size).toBe(0);
  });
});

describe("buildGeoStats", () => {
  it("presence 键缺失时回退 token 旧字段聚合", async () => {
    const { env, store } = makeEnv();
    const token = {
      id: "tk_1",
      uuid: "u-1",
      plan_id: "plan_monthly",
      status: "active",
      traffic_limit_gb: 20,
      traffic_used_gb: 1,
      purchased_at: 1,
      // 存量字段：没有 presence 键时从这里回退
      traffic_by_ip: { "1.1.1.1": { bytes: 100, conns: 1, last_seen_at: 1 } },
    };
    store.set(KV.TOKEN + "u-1", JSON.stringify(token));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ status: "success", query: "1.1.1.1", country: "China", countryCode: "CN", regionName: "Sichuan", city: "Chengdu", lat: 30.57, lon: 104.07 }]),
            { status: 200 }
          )
      )
    );
    const stats = await buildGeoStats(env);
    expect(stats.cities).toHaveLength(1);
    expect(stats.cities[0]).toMatchObject({ name: "Chengdu", tokens: 1, bytes: 100 });
    expect(stats.unresolved_ips).toBe(0);
  });

  it("presence 键存在时以 presence 为准", async () => {
    const { env, store } = makeEnv();
    const token = {
      id: "tk_1",
      uuid: "u-1",
      plan_id: "plan_monthly",
      status: "active",
      traffic_limit_gb: 20,
      traffic_used_gb: 1,
      purchased_at: 1,
      traffic_by_ip: { "1.1.1.1": { bytes: 100, conns: 1, last_seen_at: 1 } },
    };
    store.set(KV.TOKEN + "u-1", JSON.stringify(token));
    store.set(
      KV.PRESENCE + "u-1",
      JSON.stringify({ traffic_by_ip: { "2.2.2.2": { bytes: 200, conns: 2, last_seen_at: 2 } } })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ status: "success", query: "2.2.2.2", country: "China", countryCode: "CN", regionName: "Beijing", city: "Beijing", lat: 39.9, lon: 116.4 }]),
            { status: 200 }
          )
      )
    );
    const stats = await buildGeoStats(env);
    expect(stats.cities[0]).toMatchObject({ name: "Beijing", bytes: 200 });
  });

  it("测试账号（TEST_CONTACT_RE 命中）不参与聚合", async () => {
    const { env, store } = makeEnv();
    const mk = (id: string, uuid: string, contact: string) => ({
      id,
      uuid,
      contact,
      plan_id: "plan_monthly",
      status: "active",
      traffic_limit_gb: 20,
      traffic_used_gb: 1,
      purchased_at: 1,
      traffic_by_ip: { "1.1.1.1": { bytes: 100, conns: 1, last_seen_at: 1 } },
    });
    store.set(KV.TOKEN + "u-1", JSON.stringify(mk("tk_1", "u-1", "settle-test@fastergamer.cn")));
    store.set(KV.TOKEN + "u-2", JSON.stringify(mk("tk_2", "u-2", "test-plan@auto-1")));
    store.set(KV.TOKEN + "u-3", JSON.stringify(mk("tk_3", "u-3", "real@gmail.com")));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ status: "success", query: "1.1.1.1", country: "China", countryCode: "CN", regionName: "Sichuan", city: "Chengdu", lat: 30.57, lon: 104.07 }]),
            { status: 200 }
          )
      )
    );
    const stats = await buildGeoStats(env);
    // 只有两个测试 token 被排除，真实用户保留
    expect(stats.cities).toHaveLength(1);
    expect(stats.cities[0]).toMatchObject({ name: "Chengdu", tokens: 1 });
    expect(stats.total_ips).toBe(1);
  });
});
