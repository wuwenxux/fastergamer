import { describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Device, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/** 内存版 KV namespace（Map 实现 get/put/delete） */
const mockNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  } as unknown as KVNamespace;
  return { store, ns };
};

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const DEVICE: Device = {
  id: "dv_1",
  uuid: "uuid-dev1",
  name: "旧名字",
  traffic_used_gb: 0,
  created_at: 1,
};

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_dev",
  uuid: "uuid-main",
  plan_id: "plan_monthly",
  status: "active",
  contact: "user@example.com",
  traffic_limit_gb: 20,
  traffic_used_gb: 1,
  purchased_at: 1_000,
  devices: [{ ...DEVICE }],
  ...overrides,
});

/** 种入 token（主键 + id 索引）与指定邮箱的登录会话，返回会话凭证 */
const setup = () => {
  const tokens = mockNs();
  const env = { TOKENS: tokens.ns } as unknown as Env;
  const token = makeToken();
  tokens.store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  tokens.store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
  tokens.store.set(
    KV.SESSION + "sess-owner",
    JSON.stringify({ email: "user@example.com", created_at: Date.now() })
  );
  return { env, tokens, token };
};

const patch = (env: Env, tokenId: string, deviceId: string, body: unknown, session?: string) =>
  worker.fetch(
    new Request(`https://fastergamer.click/api/tokens/${tokenId}/devices/${deviceId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(session ? { authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx
  );

describe("PATCH /api/tokens/:id/devices/:deviceId 设备改名", () => {
  it("本人改名成功：trim 后写回 token.devices", async () => {
    const { env, tokens, token } = setup();
    const res = await patch(env, token.id, "dv_1", { name: "  我的 iPhone  " }, "sess-owner");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Device };
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("我的 iPhone");
    // uuid 等其他字段不动
    expect(body.data.uuid).toBe("uuid-dev1");
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-main")!) as Token;
    expect(saved.devices?.[0]?.name).toBe("我的 iPhone");
  });

  it("设备不存在返回 404", async () => {
    const { env, token } = setup();
    const res = await patch(env, token.id, "dv_missing", { name: "x" }, "sess-owner");
    expect(res.status).toBe(404);
  });

  it("token 不存在返回 404", async () => {
    const { env } = setup();
    const res = await patch(env, "tk_missing", "dv_1", { name: "x" }, "sess-owner");
    expect(res.status).toBe(404);
  });

  it("未登录 / 非本人（邮箱不匹配）返回 401", async () => {
    const { env, tokens, token } = setup();
    tokens.store.set(
      KV.SESSION + "sess-other",
      JSON.stringify({ email: "other@example.com", created_at: Date.now() })
    );

    const noAuth = await patch(env, token.id, "dv_1", { name: "x" });
    expect(noAuth.status).toBe(401);

    const wrongOwner = await patch(env, token.id, "dv_1", { name: "x" }, "sess-other");
    expect(wrongOwner.status).toBe(401);
  });

  it("名称为空（含纯空白）返回 400，不写 KV", async () => {
    const { env, tokens, token } = setup();
    const empty = await patch(env, token.id, "dv_1", { name: "" }, "sess-owner");
    expect(empty.status).toBe(400);
    const blank = await patch(env, token.id, "dv_1", { name: "   " }, "sess-owner");
    expect(blank.status).toBe(400);
    const saved = JSON.parse(tokens.store.get(KV.TOKEN + "uuid-main")!) as Token;
    expect(saved.devices?.[0]?.name).toBe("旧名字");
  });

  it("名称超过 30 字返回 400", async () => {
    const { env, token } = setup();
    const res = await patch(env, token.id, "dv_1", { name: "长".repeat(31) }, "sess-owner");
    expect(res.status).toBe(400);
  });
});
