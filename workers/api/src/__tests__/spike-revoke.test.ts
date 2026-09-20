import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Token } from "../../../../shared/types";
import { getAuthSnapshot } from "../lib/authsnapshot";
import { SPIKE_THRESHOLD_BYTES } from "../lib/risk-notify";
import type { Env } from "../types";

/**
 * 流量暴增分级处置（POST /api/agent/traffic 结算链路驱动）：
 * - 1h 窗口内新增 >3GB，24h 幂等（notify_log.traffic_spike）两种处置共用
 * - 体验 token（plan_trial）：触发即吊销（revoked 并入结算写）+ authChanged 推送 + 站长邮件
 * - 付费 token：不吊销，打 abuse_machine 标记进入每日 500MB 限速（纯打标不推送、不摘除）；
 *   后续结算超 500MB 窗口才暂停，快照摘除
 * - 未超阈值不变；结算路径只处理 active token，重复吊销不会发生
 * fetch 全部假成功（节点 refresh 推送），不触网。
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

const PLANS = [
  { id: "plan_trial", name: "3 天免费体验", duration_days: 3, price_cny: 0, traffic_limit_gb: 20, max_devices: 1 },
  { id: "plan_monthly", name: "月付", duration_days: 30, price_cny: 25, traffic_limit_gb: 200 },
];

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
    DEFAULT_PLANS: JSON.stringify(PLANS),
    SITE_URL: "https://fastergamer.click",
    ADMIN_NOTIFY_EMAIL: "admin@test.com",
  } as unknown as Env;
  return { env, tokens };
};

let seq = 0;
const seedToken = (store: Map<string, string>, over: Partial<Token> = {}): Token => {
  seq += 1;
  const paid = over.plan_id !== "plan_trial";
  const token: Token = {
    id: `tk_spike${seq}`,
    uuid: `uuid-spike-${seq}`,
    plan_id: paid ? "plan_monthly" : "plan_trial",
    status: "active",
    traffic_limit_gb: paid ? 200 : 20,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
    contact: `spiker${seq}@example.com`,
    expires_at: Date.now() + (paid ? 30 : 3) * 86_400_000,
    ...over,
  };
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
  return token;
};

const readToken = (store: Map<string, string>, uuid: string): Token =>
  JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;

/** v2 结算制上报：settled 增量（无 ip_conns，暴增判定不依赖接入 IP） */
const report = (env: Env, uuid: string, bytes: number) =>
  worker.fetch(
    new Request("https://api.test/api/agent/traffic", {
      method: "POST",
      headers: { "content-type": "application/json", "x-node-key": "node-key-1" },
      body: JSON.stringify({ v: 2, settled: { [uuid]: bytes } }),
    }),
    env,
    ctx
  );

beforeEach(() => {
  vi.clearAllMocks();
  // 节点 refresh 推送等出站请求一律假成功，不触网
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
});
afterEach(() => vi.unstubAllGlobals());

describe("流量暴增分级处置", () => {
  it("体验 token 暴增：触发即吊销 + 幂等键 + 站长邮件（吊销文案）+ 快照摘除", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store, { plan_id: "plan_trial" });
    const res = await report(env, t.uuid, 4e9);
    expect(res.status).toBe(200);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("revoked");
    expect(saved.abuse_machine).toBeUndefined();
    expect(saved.notify_log?.traffic_spike).toBeGreaterThan(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe("admin@test.com");
    expect(subject).toContain("已自动吊销");
    expect(html).toContain(t.id);
    expect(html).toContain("改回 active");

    // 吊销后授权快照（生成侧）不再包含该 uuid
    const snap = await getAuthSnapshot(env);
    expect(snap.uuids).not.toContain(t.uuid);
  });

  it("付费 token 暴增：不吊销，打 abuse_machine 标记转每日 500MB 限速（邮件限速文案）", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store); // plan_monthly
    await report(env, t.uuid, 4e9);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active"); // 不吊销
    expect(saved.abuse_machine).toBe(true);
    expect(saved.notify_log?.traffic_spike).toBeGreaterThan(0);
    // 本次暴增的 delta 不进限速窗口（打标发生在 applyAbuseWindow 之后），未超限不暂停
    expect(saved.abuse_suspended_until ?? 0).toBe(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, , subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(subject).toContain("已限速");
    expect(html).toContain("500MB");
    expect(html).toContain("abuse_machine");

    // 纯打标不改变授权状态：快照仍包含该 uuid
    const snap = await getAuthSnapshot(env);
    expect(snap.uuids).toContain(t.uuid);
  });

  it("付费 token 打标后进入限速：后续结算超 500MB 窗口被暂停，快照摘除", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store);
    await report(env, t.uuid, 4e9); // 暴增打标
    expect(readToken(tokens.store, t.uuid).abuse_machine).toBe(true);

    // 标记后窗口内累计 600MB > 500MB 定额 → 暂停到窗口终点（不发邮件，只记日志）
    await report(env, t.uuid, 600e6);
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active"); // 暂停不是吊销
    expect(saved.abuse_window_bytes).toBe(600e6);
    expect(saved.abuse_suspended_until).toBeGreaterThan(Date.now());
    expect(sendMail).toHaveBeenCalledTimes(1); // 只有暴增那一次通知

    const snap = await getAuthSnapshot(env);
    expect(snap.uuids).not.toContain(t.uuid);
  });

  it("24h 幂等（体验）：站长改回 active 后窗口内再次暴增，不重复吊销、不重复通知", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store, { plan_id: "plan_trial" });
    await report(env, t.uuid, 4e9);
    expect(readToken(tokens.store, t.uuid).status).toBe("revoked");
    expect(sendMail).toHaveBeenCalledTimes(1);

    // 模拟误杀恢复：管理端把状态改回 active（notify_log.traffic_spike 保留）
    const saved = readToken(tokens.store, t.uuid);
    saved.status = "active";
    tokens.store.set(KV.TOKEN + t.uuid, JSON.stringify(saved));

    // 同一 1h 窗口内再次暴增：24h 幂等键拦截，updateSpikeWindow 返回 false
    await report(env, t.uuid, 4e9);
    const after = readToken(tokens.store, t.uuid);
    expect(after.status).toBe("active");
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("未超阈值：正常结算，不吊销不打标、不通知", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store);
    await report(env, t.uuid, 1e9); // 1GB < 3GB 阈值
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.status).toBe("active");
    expect(saved.abuse_machine).toBeUndefined();
    expect(saved.notify_log?.traffic_spike).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("阈值口径：1h 窗口 3 GiB", () => {
    expect(SPIKE_THRESHOLD_BYTES).toBe(3 * 1024 ** 3);
  });
});
