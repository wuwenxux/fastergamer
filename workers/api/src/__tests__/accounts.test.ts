import { describe, expect, it, vi } from "vitest";
import { KV } from "../../../../shared/types";
import {
  consumeMagicTicket,
  createMagicTicket,
  createSession,
  getSessionAccount,
  MAGIC_TTL_MS,
  SESSION_TTL_MS,
} from "../lib/accounts";
import type { Env } from "../types";

/**
 * session / magic ticket 写入必须带 KV TTL（永不被访问的过期键不残留）；
 * 读取时的手动过期判断保留作语义兜底（KV TTL 不保证精确准时）。
 */

const mockNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  } as unknown as KVNamespace;
  return { store, ns };
};

const mockEnv = () => {
  const tokens = mockNs();
  return { env: { TOKENS: tokens.ns } as unknown as Env, tokens };
};

describe("createSession 写入带 KV TTL", () => {
  it("expirationTtl 与 180 天口径一致", async () => {
    const { env, tokens } = mockEnv();
    const session = await createSession(env, "user@example.com");
    expect(tokens.ns.put).toHaveBeenCalledTimes(1);
    const [key, , opts] = tokens.ns.put.mock.calls[0] as unknown as [string, string, { expirationTtl: number }];
    expect(key).toBe(KV.SESSION + session);
    expect(opts.expirationTtl).toBe(Math.ceil(SESSION_TTL_MS / 1000));
    // 写入后凭 session 可取回邮箱
    await expect(getSessionAccount(env, `Bearer ${session}`)).resolves.toEqual({ email: "user@example.com" });
  });
});

describe("createMagicTicket 写入带 KV TTL", () => {
  it("expirationTtl 与 72 小时口径一致", async () => {
    const { env, tokens } = mockEnv();
    const ticket = await createMagicTicket(env, "user@example.com", "tk_1", "login");
    expect(tokens.ns.put).toHaveBeenCalledTimes(1);
    const [key, , opts] = tokens.ns.put.mock.calls[0] as unknown as [string, string, { expirationTtl: number }];
    expect(key).toBe(KV.MAGIC + ticket);
    expect(opts.expirationTtl).toBe(Math.ceil(MAGIC_TTL_MS / 1000));
  });
});

describe("手动过期判断保留作语义兜底", () => {
  it("session 键仍在但已超 180 天：判过期并删除", async () => {
    const { env, tokens } = mockEnv();
    tokens.store.set(
      KV.SESSION + "stale",
      JSON.stringify({ email: "user@example.com", created_at: Date.now() - SESSION_TTL_MS - 1000 })
    );
    await expect(getSessionAccount(env, "Bearer stale")).resolves.toBeNull();
    expect(tokens.store.has(KV.SESSION + "stale")).toBe(false);
  });

  it("magic ticket 键仍在但已超 72 小时：判过期并焚毁", async () => {
    const { env, tokens } = mockEnv();
    const ticket = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"; // 需过 consumeMagicTicket 的格式闸
    tokens.store.set(
      KV.MAGIC + ticket,
      JSON.stringify({ email: "user@example.com", token_id: "tk_1", created_at: Date.now() - MAGIC_TTL_MS - 1000 })
    );
    await expect(consumeMagicTicket(env, ticket)).resolves.toBeNull();
    expect(tokens.store.has(KV.MAGIC + ticket)).toBe(false);
  });
});
