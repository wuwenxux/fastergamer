import { beforeEach, describe, expect, it, vi } from "vitest";
import { KV, type IpGeo, type Token } from "../../../../shared/types";

/**
 * 不可能旅行检测（lib/travel-guard.ts）：
 * - 有经纬度：haversine 速度 > 1000 km/h 命中（深圳→北京 1 分钟）；
 *   高铁可达（~550km/1h）不命中；同城换 IP 不命中
 * - 旧位置缺经纬度（geo 缓存 miss）：2h 兜底
 * - 存量裸字符串基线（无 at）：只更新基线不判定
 * - travel_strikes 30 分钟未再犯重计；提醒邮件 7 天节流
 * KV 用内存假实现；sendMail mock，不触网。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  const { dedupAwareSendMailMock } = await import("./helpers");
  return { ...orig, sendMail: dedupAwareSendMailMock() };
});
import { sendMail } from "../lib/email-aliyun";
import {
  evaluateTravel,
  TRAVEL_FALLBACK_WINDOW_MS,
  TRAVEL_SPEED_LIMIT_KMH,
  TRAVEL_STRIKE_WINDOW_MS,
  TRAVEL_WARN_COOLDOWN_MS,
} from "../lib/travel-guard";
import type { Env } from "../types";
import { makeEnv as baseEnv } from "./helpers";

const makeEnv = () => baseEnv({ extra: { SITE_URL: "https://fastergamer.click" } });

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_travel",
  uuid: "uuid-travel-1",
  plan_id: "plan_monthly",
  status: "active",
  contact: "traveler@example.com",
  traffic_limit_gb: 100,
  traffic_used_gb: 0,
  purchased_at: 1_000,
  expires_at: Date.now() + 30 * 86_400_000,
  ...overrides,
});

/** 把 token 落库（evaluateTravel 的 strikes 走 mergeTokenSettlement 重读-合并，需要主键存在） */
const seedToken = (store: Map<string, string>, token: Token) => {
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

const readToken = (store: Map<string, string>, uuid: string): Token =>
  JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;

const SZ: IpGeo = { country: "中国", countryCode: "CN", region: "广东", city: "深圳", lat: 22.55, lon: 114.06 };
const BJ: IpGeo = { country: "中国", countryCode: "CN", region: "北京", city: "北京", lat: 39.9, lon: 116.4 };
// 深圳→长沙约 550km：高铁 1 小时跑不到，但 < 1000 km/h 阈值（民航才可能）→ 不命中
const CS: IpGeo = { country: "中国", countryCode: "CN", region: "湖南", city: "长沙", lat: 28.23, lon: 112.94 };

const OLD_IP = "1.1.1.1";
const SZ_KEY = "中国 / 广东 / 深圳";

/** 旧位置基线：深圳，oldAt 可配；oldIp 的 geo 缓存按需种入 */
const baseline = (at?: number, ips = [OLD_IP]) => ({
  locationKey: SZ_KEY,
  at,
  ips,
});

beforeEach(() => vi.clearAllMocks());

describe("不可能旅行检测", () => {
  it("常量口径：1000 km/h 阈值 / 2h 兜底 / 30min strikes 窗口 / 7 天邮件节流", () => {
    expect(TRAVEL_SPEED_LIMIT_KMH).toBe(1000);
    expect(TRAVEL_FALLBACK_WINDOW_MS).toBe(2 * 3_600_000);
    expect(TRAVEL_STRIKE_WINDOW_MS).toBe(30 * 60_000);
    expect(TRAVEL_WARN_COOLDOWN_MS).toBe(7 * 86_400_000);
  });

  it("深圳→北京 1 分钟（~1900km，远超物理极限）：命中，写 strikes + 发节流邮件", async () => {
    const { env, tokens, shareGuard } = makeEnv();
    const token = makeToken();
    seedToken(tokens.store, token);
    tokens.store.set(KV.GEO + OLD_IP, JSON.stringify(SZ));
    const now = Date.now();

    await evaluateTravel(env, token, baseline(now - 60_000), BJ, now);

    const saved = readToken(tokens.store, token.uuid);
    expect(saved.travel_strikes).toEqual({ at: now, count: 1 });
    expect(shareGuard.claims.get(`travel_warn:${token.id}`)).toBeGreaterThan(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe("traveler@example.com");
    expect(subject).toContain("位置跳变");
    expect(html).toContain("深圳");
    expect(html).toContain("北京");
    expect(html).toContain("重新生成订阅链接");
  });

  it("同城换 IP（位置键相同）：不命中", async () => {
    const { env, tokens } = makeEnv();
    const token = makeToken();
    seedToken(tokens.store, token);
    tokens.store.set(KV.GEO + OLD_IP, JSON.stringify(SZ));
    const now = Date.now();
    const sz2: IpGeo = { ...SZ }; // 同城另一个 IP 的归属

    await evaluateTravel(env, token, baseline(now - 60_000), sz2, now);

    expect(readToken(tokens.store, token.uuid).travel_strikes).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("高铁可达（深圳→长沙 ~550km / 1h ≈ 550 km/h < 1000）：不命中", async () => {
    const { env, tokens } = makeEnv();
    const token = makeToken();
    seedToken(tokens.store, token);
    tokens.store.set(KV.GEO + OLD_IP, JSON.stringify(SZ));
    const now = Date.now();

    await evaluateTravel(env, token, baseline(now - 3_600_000), CS, now);

    expect(readToken(tokens.store, token.uuid).travel_strikes).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("旧位置缺经纬度（geo 缓存 miss）走 2h 兜底：1h 跨城命中、3h 跨城不命中", async () => {
    // 不种 geo 缓存 → lookupOldGeo 取不到经纬度 → 兜底时间窗
    const { env, tokens } = makeEnv();
    const t1 = makeToken();
    seedToken(tokens.store, t1);
    const now = Date.now();
    await evaluateTravel(env, t1, baseline(now - 3_600_000), BJ, now);
    expect(readToken(tokens.store, t1.uuid).travel_strikes).toEqual({ at: now, count: 1 });
    expect(sendMail).toHaveBeenCalledTimes(1);

    const { env: env2, tokens: tokens2 } = makeEnv();
    const t2 = makeToken();
    seedToken(tokens2.store, t2);
    await evaluateTravel(env2, t2, baseline(now - 3 * 3_600_000), BJ, now);
    expect(readToken(tokens2.store, t2.uuid).travel_strikes).toBeUndefined();
    expect(sendMail).toHaveBeenCalledTimes(1); // 第二例不新增邮件
  });

  it("存量裸字符串基线（oldAt 缺失）：只更新基线不判定，不写库不发邮件", async () => {
    const { env, tokens } = makeEnv();
    const token = makeToken();
    seedToken(tokens.store, token);
    tokens.store.set(KV.GEO + OLD_IP, JSON.stringify(SZ));
    const now = Date.now();

    await evaluateTravel(env, token, baseline(undefined), BJ, now);

    expect(readToken(tokens.store, token.uuid).travel_strikes).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("travel_strikes：30 分钟窗口内连续命中累加，超窗重计", async () => {
    const { env, tokens } = makeEnv();
    const token = makeToken({
      travel_strikes: { at: 0, count: 0 }, // 占位，下方覆盖
    });
    seedToken(tokens.store, token);
    tokens.store.set(KV.GEO + OLD_IP, JSON.stringify(SZ));
    const now = Date.now();

    // 窗口内（上次命中 10 分钟前，count=2）→ 累加到 3
    token.travel_strikes = { at: now - 10 * 60_000, count: 2 };
    seedToken(tokens.store, token);
    await evaluateTravel(env, token, baseline(now - 60_000), BJ, now);
    expect(readToken(tokens.store, token.uuid).travel_strikes).toEqual({ at: now, count: 3 });

    // 超窗（上次命中 31 分钟前，count=5）→ 重计为 1
    const t2 = makeToken({ travel_strikes: { at: now - 31 * 60_000, count: 5 } });
    seedToken(tokens.store, t2);
    await evaluateTravel(env, t2, baseline(now - 60_000), BJ, now);
    expect(readToken(tokens.store, t2.uuid).travel_strikes).toEqual({ at: now, count: 1 });
  });

  it("邮件 7 天节流：节流期内命中只写 strikes 不发邮件，认领键不被刷新", async () => {
    const { env, tokens, shareGuard } = makeEnv();
    const lastWarn = Date.now() - 86_400_000; // 1 天前发过
    const token = makeToken();
    seedToken(tokens.store, token);
    tokens.store.set(KV.GEO + OLD_IP, JSON.stringify(SZ));
    // travel_warn 认领键在 7 天冷却窗口内
    shareGuard.claims.set(`travel_warn:${token.id}`, lastWarn);
    const now = Date.now();

    await evaluateTravel(env, token, baseline(now - 60_000), BJ, now);

    const saved = readToken(tokens.store, token.uuid);
    expect(saved.travel_strikes).toEqual({ at: now, count: 1 }); // strikes 照常累积
    expect(sendMail).not.toHaveBeenCalled();
    expect(shareGuard.claims.get(`travel_warn:${token.id}`)).toBe(lastWarn); // 认领键不刷新
  });

  it("非邮箱联系方式：strikes 照写，不发邮件", async () => {
    const { env, tokens } = makeEnv();
    const token = makeToken({ contact: "qq:12345" });
    seedToken(tokens.store, token);
    tokens.store.set(KV.GEO + OLD_IP, JSON.stringify(SZ));
    const now = Date.now();

    await evaluateTravel(env, token, baseline(now - 60_000), BJ, now);

    expect(readToken(tokens.store, token.uuid).travel_strikes).toEqual({ at: now, count: 1 });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
