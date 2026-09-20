import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Token } from "../../../../shared/types";
import { getAuthSnapshot } from "../lib/authsnapshot";
import { ABUSE_DAILY_BYTES } from "../lib/abuse";
import type { Env } from "../types";

/**
 * 机房 IP 滥用识别与限速（POST /api/agent/traffic 结算链路驱动）：
 * - 只处理 plan_trial 的 active token，付费 token 不检查
 * - 判定：机房流量 > 0.5GB 且占接入总流量 > 50%（与 scripts/user-audit.mjs 同口径）
 * - 命中不撤销：打 abuse_machine 标记 + notify_log 幂等键 + 站长邮件一次；二次触发不重复
 * - 被标记 token 每日定额 500MB：窗口内超限 → abuse_suspended_until 暂停到 24h 窗口终点，
 *   授权快照摘除该 uuid；窗口过期后快照自动重新包含
 * - ip-api 查询失败 fail-open（本次跳过，不误标）；分类结果缓存 ipinfo:{ip} 30 天
 * 只拦截 ip-api.com 的 fetch，其余出站请求（节点 refresh 推送）假成功，不触网。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});
import { sendMail } from "../lib/email-aliyun";

/** 假 KV：map 实现（put 忽略 TTL；list 支持前缀过滤，授权快照重建需要） */
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

const ctx = {
  waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const TRIAL_PLAN = {
  id: "plan_trial",
  name: "3 天免费体验",
  duration_days: 3,
  price_cny: 0,
  traffic_limit_gb: 20,
  max_devices: 1,
};
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

const makeEnv = () => {
  const tokens = fakeNs();
  const nodes = fakeNs();
  nodes.store.set(KV.NODES, JSON.stringify([NODE]));
  const env = {
    TOKENS: tokens.ns,
    PLANS: fakeNs().ns,
    ORDERS: fakeNs().ns,
    NODES: nodes.ns,
    TICKETS: fakeNs().ns,
    DEFAULT_PLANS: JSON.stringify([TRIAL_PLAN, MONTHLY_PLAN]),
    SITE_URL: "https://fastergamer.click",
    ADMIN_NOTIFY_EMAIL: "admin@test.com",
  } as unknown as Env;
  return { env, tokens };
};

const IP_API_PREFIX = "http://ip-api.com/batch";

/** 只拦截 ip-api.com 批量接口；其余出站（节点 refresh 推送等）一律假成功 */
const stubFetch = (ipApi: (ips: string[]) => unknown) => {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(IP_API_PREFIX)) {
      const ips = JSON.parse(String(init?.body ?? "[]")) as string[];
      return Response.json(await ipApi(ips));
    }
    return new Response("ok");
  });
  vi.stubGlobal("fetch", spy);
  return spy;
};

/** 只数 ip-api 调用：spy 也会收到节点 refresh 推送等无关请求（waitUntil 异步执行，时机不定） */
const ipApiCallCount = (spy: ReturnType<typeof stubFetch>) =>
  spy.mock.calls.filter(([input]) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(IP_API_PREFIX);
  }).length;

let seq = 0;
const seedToken = (store: Map<string, string>, over: Partial<Token> = {}): Token => {
  seq += 1;
  const token: Token = {
    id: `tk_abuse${seq}`,
    uuid: `uuid-abuse-${seq}`,
    plan_id: "plan_trial",
    status: "active",
    traffic_limit_gb: 20,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
    contact: `abuser${seq}@example.com`,
    expires_at: Date.now() + 3 * 86_400_000,
    ...over,
  };
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
  return token;
};

const readToken = (store: Map<string, string>, uuid: string): Token =>
  JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;

/** v2 结算制上报：settled 增量 + ip_conns 连接数（流量按连接数比例分摊到 IP） */
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

const HOSTING_IP = "203.0.113.10";
const HOME_IP = "110.110.110.110";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("体验 token 机房 IP 滥用识别与限速", () => {
  it("付费 token（非 plan_trial）不检查：大流量机房 IP 也不触发，连 ip-api 都不查", async () => {
    const { env, tokens } = makeEnv();
    const spy = stubFetch(() => {
      throw new Error("不应被调用");
    });
    const t = seedToken(tokens.store, { plan_id: "plan_monthly" });
    const res = await report(env, t.uuid, 1e9, { [HOSTING_IP]: 3 });
    expect(res.status).toBe(200);
    expect(ipApiCallCount(spy)).toBe(0);
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active");
    expect(saved.abuse_machine).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("绝对值不足（机房流量 ≤0.5GB）：不标记，且总量未到阈值时直接跳过分类查询", async () => {
    const { env, tokens } = makeEnv();
    const spy = stubFetch(() => {
      throw new Error("不应被调用");
    });
    const t = seedToken(tokens.store);
    // 0.4GB 全部来自机房 IP：占比 100% 但绝对值不到 0.5GB
    await report(env, t.uuid, 0.4e9, { [HOSTING_IP]: 3 });
    expect(ipApiCallCount(spy)).toBe(0);
    expect(readToken(tokens.store, t.uuid).abuse_machine).toBeUndefined();
  });

  it("占比不足（机房流量 >0.5GB 但占比 ≤50%）：分类照查但不标记", async () => {
    const { env, tokens } = makeEnv();
    const spy = stubFetch((ips) =>
      ips.map((query) => ({
        status: "success",
        query,
        hosting: query === HOSTING_IP,
        isp: query === HOSTING_IP ? "Datacamp" : "China Telecom",
        org: "",
        as: "",
      }))
    );
    const t = seedToken(tokens.store);
    // 机房/家庭各 0.8GB：机房占比恰好 50%，不触发
    await report(env, t.uuid, 1.6e9, { [HOSTING_IP]: 1, [HOME_IP]: 1 });
    expect(ipApiCallCount(spy)).toBe(1);
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active");
    expect(saved.abuse_machine).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("命中阈值（hosting 关键词兜底判定）：不撤销，打 abuse_machine 标记 + 幂等键 + 站长邮件；二次触发不重复", async () => {
    const { env, tokens } = makeEnv();
    // ip-api 免费版无 hosting 字段：靠 isp/org/as 命中 HOSTING_RE 兜底（与 user-audit.mjs 同口径）
    const spy = stubFetch((ips) =>
      ips.map((query) => ({
        status: "success",
        query,
        isp: "Hetzner Online GmbH",
        org: "Hetzner",
        as: "AS24940 Hetzner",
      }))
    );
    const t = seedToken(tokens.store);
    await report(env, t.uuid, 1e9, { [HOSTING_IP]: 5 });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active"); // 限速不撤销
    expect(saved.abuse_machine).toBe(true);
    expect(saved.notify_log?.abuse_machine).toBeGreaterThan(0);
    expect(tokens.store.has(KV.IPINFO + HOSTING_IP)).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe("admin@test.com");
    expect(subject).toContain("限速");
    expect(html).toContain(t.id);
    expect(html).toContain(HOSTING_IP);
    expect(html).toContain("Hetzner");

    // 二次触发：token 仍 active 会继续走结算，但幂等键早退——不重复发邮件、不重复查分类
    await report(env, t.uuid, 50e6, { [HOSTING_IP]: 5 });
    expect(readToken(tokens.store, t.uuid).status).toBe("active");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(ipApiCallCount(spy)).toBe(1);
  });

  it("被标记 token 窗口内累计超 500MB → 暂停到窗口终点，授权快照摘除该 uuid", async () => {
    const { env, tokens } = makeEnv();
    stubFetch((ips) =>
      ips.map((query) => ({ status: "success", query, hosting: true, isp: "Datacamp" }))
    );
    const t = seedToken(tokens.store);
    // 先结算 1GB 触发标记（标记前的流量不计入限速窗口）
    await report(env, t.uuid, 1e9, { [HOSTING_IP]: 5 });
    expect(readToken(tokens.store, t.uuid).abuse_machine).toBe(true);

    // 标记后窗口内累计 600MB > 500MB 定额 → 暂停
    await report(env, t.uuid, 600e6, { [HOSTING_IP]: 5 });
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active"); // 暂停不是撤销
    expect(saved.abuse_window_bytes).toBe(600e6);
    expect(saved.abuse_suspended_until).toBeGreaterThan(Date.now());
    // 暂停窗口终点 = 窗口起点 + 24h
    expect(saved.abuse_suspended_until).toBe(
      (saved.abuse_window_start ?? 0) + 24 * 3_600_000
    );

    const snap = await getAuthSnapshot(env);
    expect(snap.uuids).not.toContain(t.uuid);
  });

  it("窗口过期后快照重新包含该 uuid，新流量结算重置窗口并清除暂停标记", async () => {
    const { env, tokens } = makeEnv();
    stubFetch(() => {
      throw new Error("不应被调用");
    });
    const now = Date.now();
    const t = seedToken(tokens.store, {
      abuse_machine: true,
      abuse_window_start: now - 25 * 3_600_000, // 窗口已于 1h 前结束
      abuse_window_bytes: 600e6,
      abuse_suspended_until: now - 3_600_000, // 暂停已到期
      notify_log: { abuse_machine: now - 25 * 3_600_000 }, // 已通知过，不再查分类
    });
    // 暂停到期：快照恢复包含
    const snap = await getAuthSnapshot(env);
    expect(snap.uuids).toContain(t.uuid);

    // 新流量结算：旧窗口跨期 → 重置，暂停标记清零，重新累计
    await report(env, t.uuid, 50e6, { [HOSTING_IP]: 5 });
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.abuse_window_bytes).toBe(50e6);
    expect(saved.abuse_suspended_until).toBe(0);
    expect(saved.status).toBe("active");
  });

  it("ip-api 查询异常：fail-open 本次跳过，不误标、不发邮件、不写缓存", async () => {
    const { env, tokens } = makeEnv();
    stubFetch(() => {
      throw new Error("429 rate limited");
    });
    const t = seedToken(tokens.store);
    await report(env, t.uuid, 1e9, { [HOSTING_IP]: 5 });
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active");
    expect(saved.abuse_machine).toBeUndefined();
    expect(saved.notify_log?.abuse_machine).toBeUndefined();
    expect(tokens.store.has(KV.IPINFO + HOSTING_IP)).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("KV 分类缓存命中时不重复请求 ip-api（缓存判定为机房 → 照常标记限速）", async () => {
    const { env, tokens } = makeEnv();
    tokens.store.set(
      KV.IPINFO + HOSTING_IP,
      JSON.stringify({ hosting: true, isp: "Datacamp", org: "Datacamp Limited" })
    );
    const spy = stubFetch(() => {
      throw new Error("不应被调用");
    });
    const t = seedToken(tokens.store);
    await report(env, t.uuid, 1e9, { [HOSTING_IP]: 5 });
    expect(ipApiCallCount(spy)).toBe(0);
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active");
    expect(saved.abuse_machine).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("定额常量：500MB/天", () => {
    expect(ABUSE_DAILY_BYTES).toBe(500e6);
  });
});
