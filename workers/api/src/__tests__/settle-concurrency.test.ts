import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * /api/agent/traffic 改分组有界并发后的正确性：
 * - 不同 token 的结算互不干扰（跨批 10 个边界也正常）
 * - 同一 token 的主 uuid 与设备 uuid 在同一 payload 里必须都结算（组内串行，不丢量）
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});

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

const PLANS = [
  { id: "plan_monthly", name: "月付", duration_days: 30, price_cny: 25, traffic_limit_gb: 200 },
];

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
  } as unknown as Env;
  return { env, tokens };
};

const ctx = {
  waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const seedToken = (store: Map<string, string>, seq: number, over: Partial<Token> = {}): Token => {
  const token: Token = {
    id: `tk_c${seq}`,
    uuid: `uuid-c-${seq}`,
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

const readToken = (store: Map<string, string>, uuid: string): Token =>
  JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;

const reportSettled = (env: Env, settled: Record<string, number>) =>
  worker.fetch(
    new Request("https://api.test/api/agent/traffic", {
      method: "POST",
      headers: { "content-type": "application/json", "x-node-key": "node-key-1" },
      body: JSON.stringify({ v: 2, settled }),
    }),
    env,
    ctx
  );

beforeEach(() => {
  // 节点 refresh 推送等出站请求一律假成功，不触网
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
});
afterEach(() => vi.unstubAllGlobals());

describe("/api/agent/traffic 分组有界并发结算", () => {
  it("12 个 token 跨两批：每个 token 的增量都正确入账", async () => {
    const { env, tokens } = makeEnv();
    const settled: Record<string, number> = {};
    for (let i = 1; i <= 12; i++) {
      const t = seedToken(tokens.store, i);
      settled[t.uuid] = i * 1e8;
    }

    const res = await reportSettled(env, settled);
    expect(res.status).toBe(200);

    for (let i = 1; i <= 12; i++) {
      const saved = readToken(tokens.store, `uuid-c-${i}`);
      expect(saved.traffic_total_by_node?.["node-hk-01"]).toBe(i * 1e8);
      expect(saved.traffic_used_gb).toBeCloseTo((i * 1e8) / 1024 ** 3, 6);
    }
  });

  it("同一 token 的主 uuid 与设备 uuid 同报：组内串行，两笔增量都在", async () => {
    const { env, tokens } = makeEnv();
    const dev = { id: "dv_1", uuid: "uuid-c-dev", name: "iPhone", traffic_used_gb: 0, created_at: 1 };
    const t = seedToken(tokens.store, 1, { devices: [dev] });
    tokens.store.set(KV.DEVICE + dev.uuid, JSON.stringify({ token_id: t.id }));

    const res = await reportSettled(env, { [t.uuid]: 1e9, [dev.uuid]: 5e8 });
    expect(res.status).toBe(200);

    const saved = readToken(tokens.store, t.uuid);
    // 主 uuid 与设备 uuid 的增量按键分开累计，互不覆盖
    expect(saved.traffic_total_by_node?.["node-hk-01"]).toBe(1e9);
    expect(saved.traffic_total_by_node?.["node-hk-01:uuid-c-dev"]).toBe(5e8);
    expect(saved.traffic_used_gb).toBeCloseTo((1.5e9) / 1024 ** 3, 6);
    // 设备级审计同步更新
    expect(saved.devices?.[0]?.traffic_used_gb).toBeCloseTo(5e8 / 1024 ** 3, 6);
  });
});
