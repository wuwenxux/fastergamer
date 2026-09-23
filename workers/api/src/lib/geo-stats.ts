/**
 * 管理端用户地理分布聚合（GET /api/admin/geo-stats 的数据源）。
 *
 * 数据源是 presence:{uuid} 的 traffic_by_ip（节点 access log 解析、结算时写入），
 * KV 里只有原始 IP，没有归属地——本模块负责解析与聚合：
 *   1. 全量 token → 各 token 的 (IP, bytes) 列表；
 *   2. IP 归属解析走 ip-api.com 批量接口，结果按 IP 缓存 geo:{ip}（TTL 30 天，
 *      与 abuse.ts 的 ipinfo:{ip} 同模式但独立键——那份只有机房字段不含城市）；
 *   3. 聚合纯函数 aggregateGeoStats 与城市/国家两级聚合计数，便于单测。
 *
 * fail-open 语义同 abuse.ts：归属查询失败/超限速的 IP 本次按未解析处理，
 * 不写缓存，下次刷新自动重试，绝不阻塞接口返回。
 */
import {
  KV,
  TEST_CONTACT_RE,
  type GeoCityStat,
  type GeoCountryStat,
  type GeoStats,
  type IpGeo,
  type Token,
} from "../../../../shared/types";
import { getTokenPresence, listKeys, mapBatched } from "./kv";
import type { Env } from "../types";

/** 归属缓存 TTL：IP 归属短期不变，与 ipinfo:{ip} 同口径 30 天 */
const GEO_TTL_SECONDS = 30 * 86_400;
/** ip-api 免费批量接口单批上限 15 个 IP，限速 45 批/分钟 */
const BATCH_SIZE = 15;
/** 单次请求最多补查的批数：管理端打开频率低，控制 ip-api 消耗；超出的 IP 下次刷新再解析 */
const MAX_BATCHES = 4;
/** ip-api 单批请求超时（与 abuse.ts 同口径） */
const FETCH_TIMEOUT_MS = 4000;

/** 调 ip-api 批量接口查一批 IP 的归属；任何失败返回 null（调用方按未解析处理） */
async function fetchGeoBatch(ips: string[]): Promise<Record<string, IpGeo> | null> {
  try {
    const res = await fetch(
      "http://ip-api.com/batch?fields=status,country,countryCode,regionName,city,lat,lon,isp,query",
      {
        method: "POST",
        body: JSON.stringify(ips),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as {
      status?: string;
      query?: string;
      country?: string;
      countryCode?: string;
      regionName?: string;
      city?: string;
      lat?: number;
      lon?: number;
      isp?: string;
    }[];
    if (!Array.isArray(arr)) return null;
    const out: Record<string, IpGeo> = {};
    for (const it of arr) {
      if (it.status !== "success" || !it.query) continue;
      out[it.query] = {
        country: it.country ?? "",
        countryCode: it.countryCode ?? "",
        region: it.regionName ?? "",
        city: it.city ?? "",
        lat: it.lat ?? 0,
        lon: it.lon ?? 0,
        isp: it.isp,
      };
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 解析一批 IP 的归属：先批量读 geo:{ip} 缓存，未命中的按批调 ip-api（最多 MAX_BATCHES 批），
 * 结果写缓存。返回 ip → 归属映射；未解析（含没轮到补查的）不出现在映射里，由聚合侧计为未解析。
 */
export async function resolveIpGeo(
  env: Env,
  ips: string[]
): Promise<Record<string, IpGeo>> {
  const geo: Record<string, IpGeo> = {};
  const cached = await mapBatched(ips, async (ip) => {
    const raw = await env.TOKENS.get(KV.GEO + ip);
    if (!raw) return null;
    try {
      return { ip, geo: JSON.parse(raw) as IpGeo };
    } catch {
      return null; // 缓存损坏按未缓存处理
    }
  });
  const missing: string[] = [];
  for (let i = 0; i < ips.length; i++) {
    if (cached[i]) geo[ips[i]] = cached[i]!.geo;
    else missing.push(ips[i]);
  }

  // 只补查前 MAX_BATCHES 批，其余 IP 本次放弃（前端展示覆盖率，下次刷新再解析）
  const batches: string[][] = [];
  for (let i = 0; i < missing.length && batches.length < MAX_BATCHES; i += BATCH_SIZE) {
    batches.push(missing.slice(i, i + BATCH_SIZE));
  }
  for (const batch of batches) {
    const fetched = await fetchGeoBatch(batch);
    if (!fetched) continue; // fail-open：失败不写缓存，下次重试
    for (const [ip, g] of Object.entries(fetched)) {
      geo[ip] = g;
      await env.TOKENS.put(KV.GEO + ip, JSON.stringify(g), {
        expirationTtl: GEO_TTL_SECONDS,
      });
    }
  }
  return geo;
}

/** 聚合输入：每个 token 的接入 IP 流量表 */
export interface GeoRow {
  tokenId: string;
  trafficByIp: Record<string, { bytes: number }>;
}

/**
 * 地理分布聚合（纯函数，可单测）：城市/国家两级，tokens/ips 去重计数，按流量降序。
 * geo 映射里缺失的 IP 计入 unresolved_ips（私网 IP/查询失败/超出补查上限都会走到这里）。
 */
export function aggregateGeoStats(rows: GeoRow[], geo: Record<string, IpGeo>): GeoStats {
  const cities = new Map<string, GeoCityStat & { tokenSet: Set<string>; ipSet: Set<string> }>();
  const countries = new Map<string, GeoCountryStat & { tokenSet: Set<string>; ipSet: Set<string> }>();
  const allIps = new Set<string>();
  const unresolvedIps = new Set<string>();

  for (const row of rows) {
    for (const [ip, stat] of Object.entries(row.trafficByIp)) {
      allIps.add(ip);
      const g = geo[ip];
      if (!g) {
        unresolvedIps.add(ip);
        continue;
      }
      const cityName = g.city || g.region || g.country || "未知";
      const cityKey = `${g.countryCode}/${g.region}/${cityName}`;
      let city = cities.get(cityKey);
      if (!city) {
        city = {
          name: cityName,
          region: g.region,
          country: g.country,
          countryCode: g.countryCode,
          lat: g.lat,
          lon: g.lon,
          tokens: 0,
          ips: 0,
          bytes: 0,
          tokenSet: new Set<string>(),
          ipSet: new Set<string>(),
        };
        cities.set(cityKey, city);
      }
      city.tokenSet.add(row.tokenId);
      city.tokens = city.tokenSet.size;
      city.ipSet.add(ip);
      city.ips = city.ipSet.size;
      city.bytes += stat.bytes;

      const countryKey = g.countryCode || g.country || "未知";
      let country = countries.get(countryKey);
      if (!country) {
        country = { name: g.country || "未知", countryCode: g.countryCode, tokens: 0, ips: 0, bytes: 0, tokenSet: new Set<string>(), ipSet: new Set<string>() };
        countries.set(countryKey, country);
      }
      country.tokenSet.add(row.tokenId);
      country.tokens = country.tokenSet.size;
      country.ipSet.add(ip);
      country.ips = country.ipSet.size;
      country.bytes += stat.bytes;
    }
  }

  const strip = <T extends { tokenSet: Set<string>; ipSet: Set<string> }>(v: T): Omit<T, "tokenSet" | "ipSet"> => {
    const { tokenSet: _t, ipSet: _i, ...rest } = v;
    return rest;
  };
  return {
    cities: [...cities.values()].map(strip).sort((a, b) => b.bytes - a.bytes),
    countries: [...countries.values()].map(strip).sort((a, b) => b.bytes - a.bytes),
    total_ips: allIps.size,
    unresolved_ips: unresolvedIps.size,
  };
}

/**
 * 构建完整地理分布：全量 token → presence 里的接入 IP → 归属解析 → 聚合。
 * presence 读取与 /api/admin/tokens?presence=1 同口径（键缺失回退 token 旧字段）。
 * 测试账号（settle-test/support@fastergamer.cn 等，TEST_CONTACT_RE 口径）不参与聚合，
 * 避免管理端自己的联调流量污染分布。
 */
export async function buildGeoStats(env: Env): Promise<GeoStats> {
  const keys = await listKeys(env.TOKENS, KV.TOKEN);
  const tokens = await mapBatched(keys, async (k) => {
    const raw = await env.TOKENS.get(k.name);
    return raw ? (JSON.parse(raw) as Token) : null;
  });
  const rows: GeoRow[] = [];
  const allIps = new Set<string>();
  await mapBatched(
    tokens.filter((t): t is Token => t !== null && !TEST_CONTACT_RE.test(t.contact ?? "")),
    async (t) => {
      const p = await getTokenPresence(env, t);
      const table = p.traffic_by_ip ?? {};
      if (Object.keys(table).length === 0) return;
      rows.push({ tokenId: t.id, trafficByIp: table });
      for (const ip of Object.keys(table)) allIps.add(ip);
    }
  );
  const geo = await resolveIpGeo(env, [...allIps]);
  return aggregateGeoStats(rows, geo);
}
