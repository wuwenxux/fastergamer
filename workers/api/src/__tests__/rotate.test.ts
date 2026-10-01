import { describe, expect, it, vi } from "vitest";
import { KV, type Token } from "../../../../shared/types";
import { rotateTokenUuid } from "../lib/kv";
import type { Env } from "../types";
import { mockNs as mockTokensNs, fakeShareGuard } from "./helpers";


const mockEnv = (ns: KVNamespace, guard: ReturnType<typeof fakeShareGuard>) =>
  ({ TOKENS: ns, SHARE_GUARD: guard.ns }) as unknown as Env;

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
    const guard = fakeShareGuard();
    const env = mockEnv(ns, guard);
    // multi_device 提醒的认领键已占用（发给旧 uuid 了）；rotate 后应释放让新 uuid 可再触发
    guard.claims.set("multi_device:tk_test", 789);
    const token = makeToken({
      online: true,
      online_by_node: { "node-hk": 123 },
      multi_device_detected_at: 456,
      notify_log: { traffic_80: 100 },
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
    // 多设备/在线标记清掉；其他提醒记录保留；multi_device 认领键已释放
    expect(saved.multi_device_detected_at).toBeUndefined();
    expect(saved.online).toBe(false);
    expect(guard.claims.has("multi_device:tk_test")).toBe(false);
    expect(saved.notify_log?.traffic_80).toBe(100);
  });
});
