import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * 节点通知订阅/退订端点（routes/notify-pref.ts + lib/notify-pref.ts 签名）：
 * - GET 只渲染确认页不改状态（邮件客户端/安全网关预取链接不能误订阅）
 * - POST 才真正写入 token.notify_nodes_subscribed
 * - sig 是 HMAC(ADMIN_KEY, tid:action)：错签名 / 篡改 action 一律 403
 * KV 用内存假实现；rateLimit 按 IP 分桶，各用例用不同 IP 防互相挤占。
 */

import { notifyPrefSig } from "../lib/notify-pref";
import { noopCtx, makeEnv } from "./helpers";

const ADMIN_KEY = "test-admin-key";
let ipSeq = 0;

const makeToken = (over: Partial<Token> = {}): Token =>
  ({
    id: "tk_pref01",
    uuid: "uuid-pref-01",
    plan_id: "plan_monthly",
    status: "active",
    contact: "user@example.com",
    purchased_at: Date.now() - 86_400_000,
    ...over,
  }) as Token;

/** 主键 + id 反查索引都种上（getTokenById 走索引） */
const seedToken = (env: Env, token: Token) => {
  void env.TOKENS.put(KV.TOKEN + token.uuid, JSON.stringify(token));
  void env.TOKENS.put(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

const readToken = async (env: Env, uuid: string): Promise<Token> =>
  JSON.parse((await env.TOKENS.get(KV.TOKEN + uuid))!) as Token;

const call = (env: Env, method: string, path: string) =>
  worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { "cf-connecting-ip": `10.9.0.${++ipSeq}` },
    }),
    env,
    noopCtx()
  );

/** 合法签名链接的 query 串 */
const qs = async (env: Env, tid: string, action: "sub" | "unsub") =>
  `tid=${tid}&action=${action}&sig=${await notifyPrefSig(env, tid, action)}`;

beforeEach(() => vi.clearAllMocks());

describe("/api/notify-pref 订阅/退订", () => {
  it("GET 合法链接 → 200 确认页（含确认按钮），不改 token 状态", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken();
    seedToken(env, token);
    const res = await call(env, "GET", `/api/notify-pref?${await qs(env, token.id, "sub")}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("确认订阅节点更新通知");
    expect(html).toContain('method="POST"');
    // GET 预取无副作用
    const saved = await readToken(env, token.uuid);
    expect(saved.notify_nodes_subscribed).toBeUndefined();
  });

  it("POST action=sub → 订阅生效", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken();
    seedToken(env, token);
    const res = await call(env, "POST", `/api/notify-pref?${await qs(env, token.id, "sub")}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("已订阅节点更新通知");
    expect((await readToken(env, token.uuid)).notify_nodes_subscribed).toBe(true);
  });

  it("POST action=unsub → 退订生效", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken({ notify_nodes_subscribed: true });
    seedToken(env, token);
    const res = await call(env, "POST", `/api/notify-pref?${await qs(env, token.id, "unsub")}`);
    expect(res.status).toBe(200);
    expect((await readToken(env, token.uuid)).notify_nodes_subscribed).toBe(false);
  });

  it("sig 错误 → GET/POST 均 403 且不生效", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken();
    seedToken(env, token);
    const bad = `tid=${token.id}&action=sub&sig=deadbeef`;
    expect((await call(env, "GET", `/api/notify-pref?${bad}`)).status).toBe(403);
    expect((await call(env, "POST", `/api/notify-pref?${bad}`)).status).toBe(403);
    expect((await readToken(env, token.uuid)).notify_nodes_subscribed).toBeUndefined();
  });

  it("篡改 action（sub 的签名用到 unsub 上）→ 403", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken();
    seedToken(env, token);
    const sig = await notifyPrefSig(env, token.id, "sub");
    const res = await call(env, "POST", `/api/notify-pref?tid=${token.id}&action=unsub&sig=${sig}`);
    expect(res.status).toBe(403);
    expect((await readToken(env, token.uuid)).notify_nodes_subscribed).toBeUndefined();
  });

  it("tid 不存在 → POST 404", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const res = await call(env, "POST", `/api/notify-pref?${await qs(env, "tk_ghost", "sub")}`);
    expect(res.status).toBe(404);
  });
});
