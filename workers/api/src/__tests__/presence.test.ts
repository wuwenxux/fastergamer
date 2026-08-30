import { describe, expect, it, vi } from "vitest";
import { KV, type Presence, type Token } from "../../../../shared/types";
import {
  getTokenPresence,
  mergeTokenSettlement,
  savePresenceIfChanged,
} from "../lib/kv";
import type { Env } from "../types";

/** 内存版 KV namespace（Map 实现 get/put/delete） */
const mockTokensNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  } as unknown as KVNamespace;
  return { store, ns };
};

const mockEnv = (ns: KVNamespace) => ({ TOKENS: ns }) as unknown as Env;

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_test",
  uuid: "uuid-1",
  plan_id: "plan_monthly",
  status: "active",
  traffic_limit_gb: 20,
  traffic_used_gb: 1,
  purchased_at: 1_000,
  ...overrides,
});

describe("getTokenPresence 读取回退", () => {
  it("presence 键存在时以它为准，忽略 token 旧字段", async () => {
    const { store, ns } = mockTokensNs();
    const presence: Presence = {
      online: true,
      online_by_node: { "node-hk": 123 },
      last_active_at: 456,
    };
    store.set(KV.PRESENCE + "uuid-1", JSON.stringify(presence));
    const token = makeToken({
      online: false,
      last_active_at: 111,
      traffic_by_ip: { "1.2.3.4": { bytes: 1, conns: 1, last_seen_at: 1 } },
    });

    const got = await getTokenPresence(mockEnv(ns), token);
    expect(got).toEqual(presence);
    expect(got.traffic_by_ip).toBeUndefined();
  });

  it("presence 键不存在时回退 token JSON 里的旧字段（存量兼容）", async () => {
    const { ns } = mockTokensNs();
    const token = makeToken({
      online: true,
      online_updated_at: 100,
      online_by_node: { "node-jp": 200 },
      last_active_at: 300,
      traffic_by_ip: { "1.2.3.4": { bytes: 10, conns: 2, last_seen_at: 300 } },
      active_ips: { "node-jp": ["1.2.3.4"] },
    });

    const got = await getTokenPresence(mockEnv(ns), token);
    expect(got).toEqual({
      online: true,
      online_updated_at: 100,
      online_by_node: { "node-jp": 200 },
      last_active_at: 300,
      traffic_by_ip: { "1.2.3.4": { bytes: 10, conns: 2, last_seen_at: 300 } },
      active_ips: { "node-jp": ["1.2.3.4"] },
    });
  });
});

describe("savePresenceIfChanged 有变化才写", () => {
  it("与基准一致时不写 KV", async () => {
    const { ns } = mockTokensNs();
    const base: Presence = { online: true, last_active_at: 100 };
    await savePresenceIfChanged(mockEnv(ns), "uuid-1", base, { ...base });
    expect(ns.put).not.toHaveBeenCalled();
  });

  it("有变化时写 presence:{uuid}", async () => {
    const { store, ns } = mockTokensNs();
    const base: Presence = { online: false };
    const next: Presence = { online: true, online_updated_at: 100 };
    await savePresenceIfChanged(mockEnv(ns), "uuid-1", base, next);
    expect(ns.put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get(KV.PRESENCE + "uuid-1")!)).toEqual(next);
  });
});

describe("mergeTokenSettlement 重读-合并", () => {
  it("读-改之间 token 被并发更新（用户加了设备）：设备保留、结算字段更新", async () => {
    const { store, ns } = mockTokensNs();
    const uuid = "uuid-1";

    // 结算路径首次读到的旧副本：没有新设备，notify_log 为空
    const stale = makeToken({ uuid });
    store.set(KV.TOKEN + uuid, JSON.stringify(stale));

    // 结算基于旧副本算出补丁（流量字段 + spike 记账）
    const patch = {
      traffic_used_gb: 5.5,
      traffic_total_by_node: { "node-hk": 6_000_000_000 },
      rate_window_bytes: 6_000_000_000,
      notify_log: { traffic_spike: 999 },
    };

    // 并发：用户在结算读-改之间绑定了新设备、并收到 notify-scan 写入的到期提醒
    const concurrent: Token = {
      ...stale,
      devices: [
        { id: "dv_new", uuid: "uuid-dev", name: "我的 iPhone", traffic_used_gb: 0, created_at: 2000 },
      ],
      blocked_ips: ["9.9.9.9"],
      notify_log: { expire_24h: 888 },
    };
    store.set(KV.TOKEN + uuid, JSON.stringify(concurrent));

    await mergeTokenSettlement(mockEnv(ns), uuid, patch);

    const saved = JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;
    // 用户并发加的设备与封禁 IP 不丢
    expect(saved.devices?.map((d) => d.id)).toEqual(["dv_new"]);
    expect(saved.blocked_ips).toEqual(["9.9.9.9"]);
    // 结算字段更新
    expect(saved.traffic_used_gb).toBe(5.5);
    expect(saved.traffic_total_by_node).toEqual({ "node-hk": 6_000_000_000 });
    // notify_log 键级合并：两边的记录都在
    expect(saved.notify_log).toEqual({ expire_24h: 888, traffic_spike: 999 });
  });

  it("device_usage 按设备 uuid 定点合并，不整体覆盖 devices 数组", async () => {
    const { store, ns } = mockTokensNs();
    const uuid = "uuid-1";
    store.set(
      KV.TOKEN + uuid,
      JSON.stringify(
        makeToken({
          uuid,
          devices: [
            { id: "dv_a", uuid: "uuid-a", name: "A", traffic_used_gb: 0, created_at: 1 },
            { id: "dv_b", uuid: "uuid-b", name: "B", traffic_used_gb: 0, created_at: 2 },
          ],
        })
      )
    );

    await mergeTokenSettlement(mockEnv(ns), uuid, {
      device_usage: { uuid: "uuid-a", traffic_used_gb: 1.25, last_active_at: 777 },
    });

    const saved = JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;
    expect(saved.devices).toHaveLength(2);
    expect(saved.devices?.[0]).toMatchObject({ traffic_used_gb: 1.25, last_active_at: 777 });
    expect(saved.devices?.[1]).toMatchObject({ traffic_used_gb: 0 });
  });

  it("patch 里 undefined 的键不会抹掉最新副本上的既有字段", async () => {
    const { store, ns } = mockTokensNs();
    const uuid = "uuid-1";
    store.set(KV.TOKEN + uuid, JSON.stringify(makeToken({ uuid, traffic_exhausted_at: 555 })));

    await mergeTokenSettlement(mockEnv(ns), uuid, {
      traffic_used_gb: 2,
      traffic_exhausted_at: undefined,
    });

    const saved = JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;
    expect(saved.traffic_used_gb).toBe(2);
    expect(saved.traffic_exhausted_at).toBe(555);
  });

  it("token 已被删除/rotate 时直接丢弃，不写 KV", async () => {
    const { ns } = mockTokensNs();
    await mergeTokenSettlement(mockEnv(ns), "uuid-gone", { traffic_used_gb: 1 });
    expect(ns.put).not.toHaveBeenCalled();
  });
});
