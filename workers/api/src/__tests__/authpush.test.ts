import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KV, type Token } from "../../../../shared/types";
import { pushAuthRefresh } from "../lib/authpush";
import { computeAuthSnapshot } from "../lib/authsnapshot";
import type { Env } from "../types";

/**
 * pushAuthRefresh 防抖：60s 窗口内只推第一次（结算高峰期授权事件密集触发，
 * 每次都全量重建快照 + 推送全部节点会放大 KV 与出站开销）；
 * 防抖标记读写失败必须 fail-open 照常推送（宁可多推不能丢刷新）。
 * computeAuthSnapshot 改分批并发读后结果须与串行完全一致。
 */

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

/** 内存版 KV namespace（put 捕获 options 供 TTL 断言） */
const mockNs = () => {
  const store = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
    void opts;
    store.set(key, value);
  });
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put,
    delete: vi.fn(async (key: string) => void store.delete(key)),
    list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    })),
  } as unknown as KVNamespace;
  return { store, ns, put };
};

const seedToken = (store: Map<string, string>, seq: number, over: Partial<Token> = {}): Token => {
  const token: Token = {
    id: `tk_${seq}`,
    uuid: `uuid-${seq}`,
    plan_id: "plan_monthly",
    status: "active",
    traffic_limit_gb: 20,
    traffic_used_gb: 1,
    purchased_at: Date.now(),
    expires_at: Date.now() + 30 * 86_400_000,
    ...over,
  };
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  return token;
};

const makeEnv = () => {
  const tokens = mockNs();
  const nodes = mockNs();
  nodes.store.set(KV.NODES, JSON.stringify([NODE]));
  const env = {
    TOKENS: tokens.ns,
    NODES: nodes.ns,
    PLANS: mockNs().ns,
    ORDERS: mockNs().ns,
    TICKETS: mockNs().ns,
  } as unknown as Env;
  return { env, tokens, nodes };
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("pushAuthRefresh 防抖", () => {
  it("首次推送：写 60s 防抖标记 + 重建快照 + 通知节点", async () => {
    const { env, tokens } = makeEnv();
    seedToken(tokens.store, 1);

    await pushAuthRefresh(env);

    // 防抖标记已设置（60s TTL）
    expect(tokens.store.has("authrefresh:pending")).toBe(true);
    const markerPut = tokens.put.mock.calls.find((c) => c[0] === "authrefresh:pending");
    expect(markerPut?.[2]).toEqual({ expirationTtl: 60 });
    // 快照已重建写入
    expect(tokens.store.has("authcache:snapshot")).toBe(true);
    // 节点收到 refresh 推送
    const refreshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/agent/refresh"));
    expect(refreshCalls.length).toBe(1);
  });

  it("60s 内已有 pending 标记：跳过（不重建快照、不通知节点）", async () => {
    const { env, tokens } = makeEnv();
    seedToken(tokens.store, 1);
    tokens.store.set("authrefresh:pending", "1"); // 上一次推送留下的标记（60s TTL 内）

    await pushAuthRefresh(env);

    expect(tokens.store.has("authcache:snapshot")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("防抖标记读取失败：fail-open 照常推送", async () => {
    const { env, tokens } = makeEnv();
    seedToken(tokens.store, 1);
    // 仅防抖标记键读失败，其余键正常
    const failingEnv = {
      ...env,
      TOKENS: {
        ...tokens.ns,
        get: async (key: string) => {
          if (key === "authrefresh:pending") throw new Error("KV read timeout");
          return tokens.ns.get(key);
        },
      },
    } as unknown as Env;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await pushAuthRefresh(failingEnv);

    expect(tokens.store.has("authcache:snapshot")).toBe(true);
    const refreshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/agent/refresh"));
    expect(refreshCalls.length).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("[authpush] debounce marker failed"));
    errSpy.mockRestore();
  });
});

describe("computeAuthSnapshot 分批并发读", () => {
  it("25 个 token（跨 3 批）：名单与用量基数完整正确", async () => {
    const { env, tokens } = makeEnv();
    const expected: Token[] = [];
    for (let i = 1; i <= 25; i++) {
      expected.push(seedToken(tokens.store, i, { traffic_used_gb: i / 10 }));
    }
    // 非 active 的 token 不进名单
    seedToken(tokens.store, 99, { status: "expired", expires_at: Date.now() - 1000 });

    const snap = await computeAuthSnapshot(env);

    expect(snap.uuids.length).toBe(25);
    for (const t of expected) {
      expect(snap.uuids).toContain(t.uuid);
      expect(snap.usage[t.uuid].used).toBe(Math.round(t.traffic_used_gb * 1024 ** 3));
      expect(snap.usage[t.uuid].limit).toBe(Math.round(20 * 1024 ** 3));
    }
    expect(snap.uuids).not.toContain("uuid-99");
  });
});
