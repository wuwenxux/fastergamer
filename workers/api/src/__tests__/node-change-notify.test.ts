import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Node, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * 节点变更用户通知（lib/node-change-notify.ts + routes/nodes.ts 挂载点）：
 * - POST 新增节点 / DELETE 退役节点 → 活跃付费用户收到邮件（waitUntil 异步）
 * - PUT 只改 name 等非关键字段 → 不发信；host 变更 / active 翻转 → 发信
 * - 幂等：同事件同用户只发一次（notify_log 键 node_change.<eventId>）
 * - 过滤：过期/未激活/试用/无邮箱 token 不发
 * 邮件 mock 掉；KV 用内存假实现；collectCtx 收 waitUntil 承诺。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});
import { sendMail } from "../lib/email-aliyun";
import { notifyNodeAdded, notifyNodeRemoved } from "../lib/node-change-notify";
import { collectCtx, makeEnv } from "./helpers";

const ADMIN_KEY = "test-admin-key";
const sendMailMock = vi.mocked(sendMail);

const NODE: Node = {
  id: "node-jp-01",
  key: "nk_test",
  name: "日本 01",
  region: "JP",
  host: "jp01.fastergamer.click",
  port: 443,
  tls: true,
  ws_path: "/vless-ws",
  active: true,
};

const NOW = Date.now();

const makeToken = (over: Partial<Token> = {}): Token =>
  ({
    id: `tk_${Math.random().toString(36).slice(2, 8)}`,
    uuid: crypto.randomUUID(),
    plan_id: "plan_monthly",
    status: "active",
    contact: "user@example.com",
    purchased_at: NOW - 86_400_000,
    expires_at: NOW + 30 * 86_400_000,
    ...over,
  }) as Token;

const seedTokens = (env: Env, tokens: Token[]) => {
  for (const t of tokens) void env.TOKENS.put(KV.TOKEN + t.uuid, JSON.stringify(t));
};

/** 经路由打管理端点并等 waitUntil 跑完，返回响应 */
const callApi = async (env: Env, method: string, path: string, body?: unknown) => {
  const { pending, ctx } = collectCtx();
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx
  );
  await Promise.all(pending);
  return res;
};

/** 发出去的邮件收件人列表 */
const recipients = () => sendMailMock.mock.calls.map((c) => c[1]);

beforeEach(() => vi.clearAllMocks());

describe("节点变更邮件通知", () => {
  it("POST 新增节点 → 活跃付费用户收到「新节点上线」邮件", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    seedTokens(env, [makeToken()]);
    const res = await callApi(env, "POST", "/api/admin/nodes", {
      id: NODE.id, host: NODE.host, region: NODE.region, name: NODE.name,
    });
    expect(res.status).toBe(200);
    expect(recipients()).toEqual(["user@example.com"]);
    const [, , subject, html] = sendMailMock.mock.calls[0];
    expect(subject).toContain("新节点上线");
    expect(subject).toContain("日本 01");
    expect(html).toContain("更新订阅");
    // 安全：邮件不含订阅链接
    expect(html).not.toContain("/api/sub");
  });

  it("DELETE 退役节点 → 收到「节点下线通知」邮件", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY, nodes: [NODE] });
    seedTokens(env, [makeToken()]);
    const res = await callApi(env, "DELETE", `/api/admin/nodes/${NODE.id}`);
    expect(res.status).toBe(200);
    expect(recipients()).toEqual(["user@example.com"]);
    expect(String(sendMailMock.mock.calls[0][2])).toContain("节点下线通知");
  });

  it("PUT 只改 name（非关键字段）→ 不发信", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY, nodes: [NODE] });
    seedTokens(env, [makeToken()]);
    const res = await callApi(env, "PUT", `/api/admin/nodes/${NODE.id}`, { name: "日本 01 改" });
    expect(res.status).toBe(200);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("PUT host 变更 → 收到「节点地址变更」邮件", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY, nodes: [NODE] });
    seedTokens(env, [makeToken()]);
    const res = await callApi(env, "PUT", `/api/admin/nodes/${NODE.id}`, { host: "jp02.fastergamer.click" });
    expect(res.status).toBe(200);
    expect(recipients()).toEqual(["user@example.com"]);
    expect(String(sendMailMock.mock.calls[0][2])).toContain("节点地址变更");
  });

  it("PUT active true→false 按退役发信；false→true 按新增发信（已订阅用户）", async () => {
    // 订阅制下未订阅用户只收首封样例；验证两个方向的文案映射用已订阅用户
    const { env } = makeEnv({ adminKey: ADMIN_KEY, nodes: [NODE] });
    seedTokens(env, [makeToken({ notify_nodes_subscribed: true })]);
    await callApi(env, "PUT", `/api/admin/nodes/${NODE.id}`, { active: false });
    expect(String(sendMailMock.mock.calls[0][2])).toContain("节点下线通知");
    await callApi(env, "PUT", `/api/admin/nodes/${NODE.id}`, { active: true });
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(String(sendMailMock.mock.calls[1][2])).toContain("新节点上线");
  });

  it("幂等：同一事件第二次触发不再发（notify_log 键级去重）", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken();
    seedTokens(env, [token]);
    const { pending: p1, ctx: c1 } = collectCtx();
    notifyNodeAdded(env, NODE, c1);
    await Promise.all(p1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    // 同事件（同 eventId）再来一次：notify_log 已记账，跳过
    const { pending: p2, ctx: c2 } = collectCtx();
    notifyNodeAdded(env, NODE, c2);
    await Promise.all(p2);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("过滤：过期 / 未激活 / 试用 / 无邮箱 token 一律不发", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    seedTokens(env, [
      makeToken({ contact: "expired@example.com", expires_at: NOW - 1000 }), // 已过有效期
      makeToken({ contact: "paid@example.com", status: "paid" }), // 未激活
      makeToken({ contact: "revoked@example.com", status: "revoked" }),
      makeToken({ contact: "trial@example.com", plan_id: "plan_trial" }), // 试用
      makeToken({ contact: undefined }), // 无邮箱
    ]);
    const { pending, ctx } = collectCtx();
    notifyNodeAdded(env, NODE, ctx);
    await Promise.all(pending);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe("订阅制（opt-in）：默认只发第一封样例，订阅后持续收，退订后停发", () => {
  const readToken = async (env: Env, uuid: string): Promise<Token> =>
    JSON.parse((await env.TOKENS.get(KV.TOKEN + uuid))!) as Token;

  const fire = async (env: Env, fn: (env: Env, node: Node, ctx: never) => void) => {
    const { pending, ctx } = collectCtx();
    fn(env, NODE, ctx as never);
    await Promise.all(pending);
  };

  it("首封为样例：发出 + 写回 notify_nodes_sampled_at + 带订阅链接", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken();
    seedTokens(env, [token]);
    await fire(env, notifyNodeAdded);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const html = String(sendMailMock.mock.calls[0][3]);
    expect(html).toContain("点击订阅");
    expect(html).toContain("/api/notify-pref");
    expect(html).toContain("action=sub");
    const saved = await readToken(env, token.uuid);
    expect(saved.notify_nodes_sampled_at).toBeGreaterThan(0);
  });

  it("未订阅：第二个事件（不同 eventId）不再发——样例只此一封", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken();
    seedTokens(env, [token]);
    await fire(env, notifyNodeAdded);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    // 另一个事件（退役）：sampled_at 已写且未订阅，跳过
    await fire(env, notifyNodeRemoved);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("已订阅用户：每个事件都收，带退订链接，不写 sampled_at", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const token = makeToken({ notify_nodes_subscribed: true });
    seedTokens(env, [token]);
    await fire(env, notifyNodeAdded);
    await fire(env, notifyNodeRemoved);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    const html = String(sendMailMock.mock.calls[0][3]);
    expect(html).toContain("点击退订");
    expect(html).toContain("action=unsub");
    const saved = await readToken(env, token.uuid);
    expect(saved.notify_nodes_sampled_at).toBeUndefined();
  });

  it("退订后（subscribed=false 且样例已发）不再发", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    seedTokens(env, [
      makeToken({ notify_nodes_subscribed: false, notify_nodes_sampled_at: NOW - 1000 }),
    ]);
    await fire(env, notifyNodeAdded);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("POST inactive 节点（active=false）→ 暂不上线不发信", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    seedTokens(env, [makeToken()]);
    const res = await callApi(env, "POST", "/api/admin/nodes", {
      id: NODE.id, host: NODE.host, region: NODE.region, name: NODE.name, active: false,
    });
    expect(res.status).toBe(200);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
