import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthSnapshot } from "../lib/authsnapshot";
import { pushAuthRefresh } from "../lib/authpush";
import type { Env } from "../types";

/** TOKENS.list 抛错（模拟 KV 配额耗尽），NODES 空注册表 */
const failingEnv = () =>
  ({
    TOKENS: {
      get: async () => null,
      put: async () => {},
      list: async () => {
        throw new Error("KV list quota exceeded");
      },
    },
    NODES: { get: async () => null },
  }) as unknown as Env;

describe("授权快照失败告警（不再静默吞错）", () => {
  afterEach(() => vi.restoreAllMocks());

  it("getAuthSnapshot 重建失败且无缓存：console.error 告警后抛错", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getAuthSnapshot(failingEnv())).rejects.toThrow("auth snapshot unavailable");
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[authsnapshot] rebuild failed")
    );
  });

  it("pushAuthRefresh 快照重建失败：console.error 告警但推送流程不中断", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(pushAuthRefresh(failingEnv())).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[authpush] snapshot rebuild failed: KV list quota exceeded")
    );
  });
});
