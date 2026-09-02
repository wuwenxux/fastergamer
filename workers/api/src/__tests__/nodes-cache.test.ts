import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNodes, invalidateNodesCache, saveNodes } from "../lib/nodes";
import type { Env } from "../types";

/** 假 NODES 命名空间：注册表键 + nodestat 单键都走同一个 get/put 计数 */
const mockEnv = (registry: unknown[]) => {
  const store = new Map<string, string>([["nodes", JSON.stringify(registry)]]);
  const get = vi.fn(async (k: string) => store.get(k) ?? null);
  const put = vi.fn(async (k: string, v: string) => void store.set(k, v));
  return { env: { NODES: { get, put } } as unknown as Env, get, put, store };
};

const NODE = { id: "hk01", key: "nk_x", name: "hk01", region: "HK", host: "h1.example.com", port: 443, tls: true, ws_path: "/vless-ws", active: true };

describe("getNodes isolate 内存缓存", () => {
  beforeEach(() => invalidateNodesCache());

  it("TTL 内第二次读不打 KV", async () => {
    const { env, get } = mockEnv([NODE]);
    await getNodes(env);
    const calls = get.mock.calls.length;
    await getNodes(env);
    expect(get.mock.calls.length).toBe(calls);
  });

  it("返回值是深拷贝：调用方原地改数组不污染缓存", async () => {
    const { env } = mockEnv([NODE]);
    const first = await getNodes(env);
    first[0].host = "mutated.example.com";
    first.push({ ...NODE, id: "jp01" });
    const second = await getNodes(env);
    expect(second).toHaveLength(1);
    expect(second[0].host).toBe("h1.example.com");
  });

  it("invalidateNodesCache 后重新读 KV", async () => {
    const { env, get } = mockEnv([NODE]);
    await getNodes(env);
    const calls = get.mock.calls.length;
    invalidateNodesCache();
    await getNodes(env);
    expect(get.mock.calls.length).toBeGreaterThan(calls);
  });

  it("saveNodes 写注册表后自动失效，下次读到新数据", async () => {
    const { env } = mockEnv([NODE]);
    const before = await getNodes(env);
    expect(before).toHaveLength(1);
    await saveNodes(env, [NODE, { ...NODE, id: "jp01", host: "j1.example.com" }]);
    const after = await getNodes(env);
    expect(after.map((n) => n.id)).toEqual(["hk01", "jp01"]);
  });
});
