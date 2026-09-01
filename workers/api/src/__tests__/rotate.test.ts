import { describe, expect, it, vi } from "vitest";
import { KV, type Token } from "../../../../shared/types";
import { rotateTokenUuid } from "../lib/kv";
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
  uuid: "uuid-old",
  plan_id: "plan_monthly",
  status: "active",
  traffic_limit_gb: 20,
  traffic_used_gb: 1,
  purchased_at: 1_000,
  ...overrides,
});

describe("rotateTokenUuid", () => {
  it("旧 uuid 主键与 presence 一并删除，新 uuid 落库且套餐/用量不变", async () => {
    const { store, ns } = mockTokensNs();
    const env = mockEnv(ns);
    const token = makeToken({
      online: true,
      online_by_node: { "node-hk": 123 },
      multi_device_detected_at: 456,
      notify_log: { multi_device: 789, traffic_80: 100 },
    });
    store.set(KV.TOKEN + "uuid-old", JSON.stringify(token));
    store.set(KV.PRESENCE + "uuid-old", JSON.stringify({ online: true }));

    await rotateTokenUuid(env, token);

    // 旧凭证痕迹清除
    expect(store.has(KV.TOKEN + "uuid-old")).toBe(false);
    expect(store.has(KV.PRESENCE + "uuid-old")).toBe(false);
    // 新凭证落库，id 索引同步（saveToken 会写 token_by_id）
    expect(token.uuid).not.toBe("uuid-old");
    const saved = JSON.parse(store.get(KV.TOKEN + token.uuid)!) as Token;
    expect(saved.id).toBe("tk_test");
    expect(JSON.parse(store.get(KV.TOKEN_BY_ID + "tk_test")!).uuid).toBe(token.uuid);
    // 套餐/到期/用量保持
    expect(saved.plan_id).toBe("plan_monthly");
    expect(saved.traffic_used_gb).toBe(1);
    // 多设备/在线标记清掉；其他提醒记录保留
    expect(saved.multi_device_detected_at).toBeUndefined();
    expect(saved.online).toBe(false);
    expect(saved.notify_log?.multi_device).toBeUndefined();
    expect(saved.notify_log?.traffic_80).toBe(100);
  });
});
