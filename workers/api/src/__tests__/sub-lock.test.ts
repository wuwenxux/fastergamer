import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KV, type Node, type Presence, type Token } from "../../../../shared/types";
import { subRoutes } from "../routes/sub";
import { tokensRoutes } from "../routes/tokens";
import { invalidateNodesCache } from "../lib/nodes";
import {
  clientFamily,
  SUB_FP_EXPIRE_MS,
  SUB_UNBIND_COOLDOWN_MS,
} from "../lib/sub-lock";
import type { Env } from "../types";
import { collectCtx, fakeNs } from "./helpers";

/**
 * 订阅设备锁 + 自助解绑：
 * - clientFamily 家族归一化（忽略版本号）
 * - 锁仅单设备套餐（试用/流量包，有效 max_devices=1）生效：首个拉取者懒惰认领绑定，
 *   同家族放行、新家族拒绝（403 文案明说「仅支持 1 台设备」，引导解绑/购买多设备套餐）
 * - 多设备套餐一律放行任何家族（同一人多台设备是正常用法），指纹仍照常记录供展示
 * - 浏览器/未知 UA：无绑定放行（灰度兼容），有绑定拒绝（堵抄配置旁路）
 * - 绑定 30 天未拉取自动过期（自愈）；冲突邮件节流 24h 且仅单设备套餐发送
 * - POST /api/tokens/:id/sub-unbind：本人成功 / 冷却中 429 / 非本人 401
 * fetch 桩成 DoH 无解析结果（回退域名），不触网。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});
import { sendMail } from "../lib/email-aliyun";

const NODES: Node[] = [
  { id: "n1", key: "k", name: "香港 CN2", region: "HK", host: "hk1.example.com", port: 443, tls: true, ws_path: "/ws", active: true },
];

const UUID = "11111111-2222-3333-4444-555555555555";
const EMAIL = "owner@example.com";
const SESSION = "sess-sublock";

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_lock1",
  uuid: UUID,
  plan_id: "plan_monthly",
  status: "active",
  contact: EMAIL,
  traffic_limit_gb: 100,
  traffic_used_gb: 0,
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
      { id: "plan_monthly", name: "月付", duration_days: 30, price_cny: 15, description: "", max_devices: 3 },
      { id: "plan_pack_5g", name: "5G 流量包", duration_days: 90, price_cny: 8, description: "", max_devices: 1 },
    ]),
    SITE_URL: "https://fastergamer.click",
  }) as unknown as Env;

const app = new Hono<{ Bindings: Env }>();
app.route("/api/sub", subRoutes);
app.route("/api/tokens", tokensRoutes);

const setup = async (token?: Token) => {
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

/** 拉取订阅并等 waitUntil 副作用落库 */
const fetchSub = async (env: Env, uuid: string, opts: { ua?: string; ip?: string } = {}) => {
  const c = collectCtx();
  const headers: Record<string, string> = {};
  if (opts.ua) headers["user-agent"] = opts.ua;
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  const res = await app.request(`/api/sub?uuid=${uuid}`, { headers }, env, c.ctx);
  await Promise.all(c.pending);
  return res;
};

const readPresence = (store: Map<string, string>, uuid: string): Presence | null => {
  const raw = store.get(KV.PRESENCE + uuid);
  return raw ? (JSON.parse(raw) as Presence) : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  // resolveNodeIps 会对节点域名打 DoH：测试环境禁外网，桩成无解析结果（回退域名）
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => ({ Answer: [] }) }) as unknown as typeof fetch)
  );
});

describe("clientFamily 家族归一化", () => {
  it.each([
    ["Shadowrocket/2.2.50", "shadowrocket"],
    ["shadowrocket/2.2.66", "shadowrocket"], // 版本变化不变家族
    ["Stash/2.5.0", "stash"],
    ["sing-box/1.11.4", "singbox"],
    ["SFA/1.11.0", "singbox"],
    ["SFI/1.10.0", "singbox"],
    ["v2rayNG/1.8.19", "v2rayng"],
    ["v2rayNG/1.9.7", "v2rayng"],
    ["NekoBox/Android/1.3.0", "nekobox"],
    ["clash-verge/v2.0", "clash-meta"],
    ["Clash Verge/1.7.7", "clash-meta"],
    ["mihomo/v1.18.0", "clash-meta"],
    ["FlClash/v0.8", "clash-meta"],
    ["ClashMetaForAndroid/2.11", "clash-meta"],
    ["ClashforWindows/0.20.39", "clash-other"],
    ["ClashX/1.95.1", "clash-other"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1", "unknown"],
    ["curl/8.5.0", "unknown"],
    ["", "unknown"],
  ])("UA %j → %s", (ua, family) => {
    expect(clientFamily(ua)).toBe(family);
  });
});

describe("订阅设备锁判定与下发", () => {
  it("无绑定：首个拉取者认领，绑定写入 presence.sub_fps（含 first_at）", async () => {
    const { env, tokens } = await setup(makeToken());
    const res = await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    expect(res.status).toBe(200);
    const presence = readPresence(tokens.store, UUID);
    const binding = presence?.sub_fps?.[UUID]?.["clash-meta"];
    expect(binding).toBeDefined();
    expect(binding!.ua).toBe("clash-verge/v2.0");
    expect(binding!.ip).toBe("1.2.3.4");
    expect(binding!.first_at).toBeGreaterThan(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("同家族放行：版本升级（verge → mihomo 不同 UA 同家族）不掉绑定", async () => {
    const { env, tokens } = await setup(makeToken());
    await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    const res = await fetchSub(env, UUID, { ua: "mihomo/v1.18.0", ip: "1.2.3.4" });
    expect(res.status).toBe(200);
    // 家族不变，绑定条目仍只有一个
    const links = readPresence(tokens.store, UUID)?.sub_fps?.[UUID] ?? {};
    expect(Object.keys(links)).toEqual(["clash-meta"]);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("同指纹同 UA/IP 24h 内的重复拉取不重复写 presence（省写配额）", async () => {
    const { env, tokens } = await setup(makeToken());
    await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    const firstRaw = tokens.store.get(KV.PRESENCE + UUID)!;
    await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    expect(tokens.store.get(KV.PRESENCE + UUID)).toBe(firstRaw);
  });

  it("新家族指纹冲突（单设备套餐）：403 拒绝下发 + 文案为单设备口径（解绑/多设备套餐）+ 邮件通知机主", async () => {
    const { env } = await setup(makeToken({ plan_id: "plan_pack_5g" }));
    await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });

    const res = await fetchSub(env, UUID, { ua: "Shadowrocket/2.2.57", ip: "9.9.9.9" });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("仅支持 1 台设备");
    expect(text).toContain("解绑");
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe(EMAIL);
    expect(subject).toContain("订阅链接");
    expect(html).toContain("Shadowrocket");
    expect(html).toContain("9.9.9.9");
  });

  it("浏览器/未知 UA：无绑定时放行（灰度兼容）", async () => {
    const { env } = await setup(makeToken());
    const res = await fetchSub(env, UUID, { ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/120" });
    expect(res.status).toBe(200);
  });

  it("浏览器/未知 UA：已有绑定时拒绝（堵「浏览器抄配置」旁路），且浏览器拉取不产生绑定", async () => {
    const { env, tokens } = await setup(makeToken({ plan_id: "plan_pack_5g" }));
    await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    const res = await fetchSub(env, UUID, { ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/120" });
    expect(res.status).toBe(403);
    // unknown 指纹不落绑定表
    expect(readPresence(tokens.store, UUID)?.sub_fps?.[UUID]?.unknown).toBeUndefined();
  });

  it("绑定 30 天未拉取自动过期：新家族可重新认领（自愈）", async () => {
    const { env, tokens } = await setup(makeToken({ plan_id: "plan_pack_5g" }));
    const expiredAt = Date.now() - SUB_FP_EXPIRE_MS - 1000;
    await tokens.ns.put(
      KV.PRESENCE + UUID,
      JSON.stringify({
        sub_fps: { [UUID]: { "clash-meta": { ua: "clash-verge/v2.0", ip: "1.2.3.4", at: expiredAt, first_at: expiredAt } } },
      } satisfies Presence)
    );
    const res = await fetchSub(env, UUID, { ua: "Shadowrocket/2.2.57", ip: "9.9.9.9" });
    expect(res.status).toBe(200);
    const links = readPresence(tokens.store, UUID)?.sub_fps?.[UUID] ?? {};
    expect(Object.keys(links)).toEqual(["shadowrocket"]); // 过期条目被剔除
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("冲突邮件 24h 节流（单设备套餐）：连续冲突只发一封", async () => {
    const { env } = await setup(makeToken({ plan_id: "plan_pack_5g" }));
    await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    const r1 = await fetchSub(env, UUID, { ua: "Shadowrocket/2.2.57", ip: "9.9.9.9" });
    const r2 = await fetchSub(env, UUID, { ua: "v2rayNG/1.8.19", ip: "8.8.8.8" });
    expect(r1.status).toBe(403);
    expect(r2.status).toBe(403);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("多设备套餐锁不生效：新家族一律 200 放行，仍记录指纹供展示，不发邮件", async () => {
    const { env, tokens } = await setup(makeToken()); // plan_monthly max_devices=3
    await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    const res = await fetchSub(env, UUID, { ua: "Shadowrocket/2.2.57", ip: "9.9.9.9" });
    expect(res.status).toBe(200); // 同一人多台设备拉同一链接是正常用法
    // 两个家族的指纹都照常记录（管理页「订阅客户端」展示用）
    const links = readPresence(tokens.store, UUID)?.sub_fps?.[UUID] ?? {};
    expect(Object.keys(links).sort()).toEqual(["clash-meta", "shadowrocket"]);
    expect(sendMail).not.toHaveBeenCalled(); // 多设备套餐多家族不打扰机主
  });

  it("token.max_devices 覆盖套餐值：覆盖为 1 的多设备套餐锁生效（403+邮件）；覆盖为 3 的单设备套餐锁失效（放行）", async () => {
    // 套餐 max_devices=3，token 级覆盖为 1（售后收紧）→ 锁生效，按单设备口径拒绝+发邮件
    const { env: env1 } = await setup(makeToken({ max_devices: 1 }));
    await fetchSub(env1, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    const r1 = await fetchSub(env1, UUID, { ua: "Shadowrocket/2.2.57", ip: "9.9.9.9" });
    expect(r1.status).toBe(403);
    expect(sendMail).toHaveBeenCalledTimes(1);

    // 套餐 max_devices=1（流量包），token 级放宽为 3 → 锁失效，放行不发邮件
    const { env: env2 } = await setup(makeToken({ plan_id: "plan_pack_5g", max_devices: 3 }));
    await fetchSub(env2, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    const r2 = await fetchSub(env2, UUID, { ua: "Shadowrocket/2.2.57", ip: "9.9.9.9" });
    expect(r2.status).toBe(200);
    expect(sendMail).toHaveBeenCalledTimes(1); // 不新增
  });

  it("设备槽位链接独立绑定：主设备绑定不影响槽位链接的首拉认领", async () => {
    const devUuid = "aaaaaaaa-0000-0000-0000-000000000001";
    const { env, tokens } = await setup(
      makeToken({
        devices: [{ id: "dv_1", uuid: devUuid, name: "iPhone", traffic_used_gb: 0, created_at: 1 }],
      })
    );
    await tokens.ns.put(KV.DEVICE + devUuid, JSON.stringify({ token_id: "tk_lock1" }));

    await fetchSub(env, UUID, { ua: "clash-verge/v2.0", ip: "1.2.3.4" });
    // 槽位链接用 Shadowrocket 首拉：独立绑定，不与主设备冲突
    const res = await fetchSub(env, devUuid, { ua: "Shadowrocket/2.2.57", ip: "1.2.3.4" });
    expect(res.status).toBe(200);
    const presence = readPresence(tokens.store, UUID);
    expect(Object.keys(presence?.sub_fps?.[UUID] ?? {})).toEqual(["clash-meta"]);
    expect(Object.keys(presence?.sub_fps?.[devUuid] ?? {})).toEqual(["shadowrocket"]);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("POST /api/tokens/:id/sub-unbind 自助解绑", () => {
  const seedSession = async (ns: KVNamespace, email = EMAIL) => {
    await ns.put(KV.SESSION + SESSION, JSON.stringify({ email, created_at: Date.now() }));
  };
  const unbind = (env: Env, auth?: string) =>
    app.request(
      "/api/tokens/tk_lock1/sub-unbind",
      { method: "POST", headers: auth ? { authorization: `Bearer ${auth}` } : {} },
      env,
      collectCtx().ctx
    );

  it("本人解绑成功：绑定清空 + sub_unbind_at 落库", async () => {
    const { env, tokens } = await setup(makeToken());
    await seedSession(tokens.ns);
    await tokens.ns.put(
      KV.PRESENCE + UUID,
      JSON.stringify({
        sub_fps: { [UUID]: { "clash-meta": { ua: "clash-verge/v2.0", ip: "1.2.3.4", at: Date.now(), first_at: Date.now() } } },
      } satisfies Presence)
    );

    const res = await unbind(env, SESSION);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { sub_unbind_at: number } };
    expect(body.data.sub_unbind_at).toBeGreaterThan(0);
    expect(readPresence(tokens.store, UUID)?.sub_fps).toBeUndefined();
    const stored = JSON.parse(tokens.store.get(KV.TOKEN + UUID)!) as Token;
    expect(stored.sub_unbind_at).toBeGreaterThan(0);
  });

  it("冷却中（7 天内解绑过）：429 + 剩余天数提示", async () => {
    const { env, tokens } = await setup(makeToken({ sub_unbind_at: Date.now() - 86_400_000 }));
    await seedSession(tokens.ns);
    const res = await unbind(env, SESSION);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain("天后可再次解绑");
  });

  it("冷却期满后可再次解绑", async () => {
    const { env, tokens } = await setup(
      makeToken({ sub_unbind_at: Date.now() - SUB_UNBIND_COOLDOWN_MS - 1000 })
    );
    await seedSession(tokens.ns);
    const res = await unbind(env, SESSION);
    expect(res.status).toBe(200);
  });

  it("非本人（无会话/会话邮箱不匹配）：401，绑定不动", async () => {
    const { env, tokens } = await setup(makeToken());
    await seedSession(tokens.ns, "someone-else@example.com");
    const res1 = await unbind(env); // 无会话
    expect(res1.status).toBe(401);
    const res2 = await unbind(env, SESSION); // 会话邮箱 ≠ 购买邮箱
    expect(res2.status).toBe(401);
    const stored = JSON.parse(tokens.store.get(KV.TOKEN + UUID)!) as Token;
    expect(stored.sub_unbind_at).toBeUndefined();
  });
});
