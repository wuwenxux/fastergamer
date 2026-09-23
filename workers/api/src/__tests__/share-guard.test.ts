import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Order, type Token } from "../../../../shared/types";
import { computeAuthSnapshot } from "../lib/authsnapshot";
import {
  SHARE_CONN_TOLERANCE,
  SHARE_FALLBACK_MAX_DEVICES,
  SHARE_STRIKE_WINDOW_MS,
  SHARE_WARN_COOLDOWN_MS,
} from "../lib/share-guard";
import type { Env } from "../types";

/**
 * 共享检测（并发连接数判定 → 警告 → 暂停 → 续费自动解锁）：
 * - 阈值 = token.max_devices ?? 套餐 max_devices ?? 3，再 + SHARE_CONN_TOLERANCE
 * - 未超标不动；首次连续超标（count>=2）只警告；7 天内警告过再犯才暂停
 * - 警告超 7 天则重新警告一轮；strikes 超 30 分钟窗口重新计数；未超标清零
 * - 暂停后授权快照剔除；续费发货（fulfillOrder）与管理端清除可解锁恢复
 * fetch 全部假成功（节点 refresh 推送），不触网。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});
import { sendMail } from "../lib/email-aliyun";

/** 假 KV：map 实现（put 忽略 TTL；list 支持前缀过滤，授权快照重建需要） */
const fakeNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async (opts?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((k) => !opts?.prefix || k.startsWith(opts.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
  } as unknown as KVNamespace;
  return { ns, store };
};

const ctx = {
  waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const PLANS = [
  { id: "plan_trial", name: "7 天免费体验", duration_days: 7, price_cny: 0, traffic_limit_gb: 8, max_devices: 1 },
  // max_devices 3 → 共享阈值 3 + 2 = 5 并发
  { id: "plan_monthly", name: "月付套餐", duration_days: 30, price_cny: 12, traffic_limit_gb: 200, max_devices: 3 },
];

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

const ADMIN_KEY = "test-admin-key";

const makeEnv = () => {
  const tokens = fakeNs();
  const orders = fakeNs();
  const nodes = fakeNs();
  nodes.store.set(KV.NODES, JSON.stringify([NODE]));
  const env = {
    TOKENS: tokens.ns,
    PLANS: fakeNs().ns,
    ORDERS: orders.ns,
    NODES: nodes.ns,
    TICKETS: fakeNs().ns,
    DEFAULT_PLANS: JSON.stringify(PLANS),
    SITE_URL: "https://fastergamer.click",
    ADMIN_KEY,
  } as unknown as Env;
  return { env, tokens, orders };
};

let seq = 0;
const seedToken = (store: Map<string, string>, over: Partial<Token> = {}): Token => {
  seq += 1;
  const token: Token = {
    id: `tk_share${seq}`,
    uuid: `uuid-share-${seq}`,
    plan_id: "plan_monthly",
    status: "active",
    traffic_limit_gb: 200,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
    contact: `sharer${seq}@example.com`,
    expires_at: Date.now() + 30 * 86_400_000,
    ...over,
  };
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
  return token;
};

const readToken = (store: Map<string, string>, uuid: string): Token =>
  JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;

/** v2 结算制上报：settled 增量 + 各 uuid 当前并发连接数 */
const report = (env: Env, body: Record<string, unknown>) =>
  worker.fetch(
    new Request("https://api.test/api/agent/traffic", {
      method: "POST",
      headers: { "content-type": "application/json", "x-node-key": "node-key-1" },
      body: JSON.stringify({ v: 2, ...body }),
    }),
    env,
    ctx
  );

/** 单 token 单 uuid 上报 n 个并发连接 */
const reportConns = (env: Env, uuid: string, conns: number, settled = 0) =>
  report(env, { settled: settled > 0 ? { [uuid]: settled } : {}, conns: { [uuid]: conns } });

beforeEach(() => {
  vi.clearAllMocks();
  // 节点 refresh 推送等出站请求一律假成功，不触网
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
});
afterEach(() => vi.unstubAllGlobals());

describe("共享检测：判定与处置", () => {
  it("阈值口径：套餐设备上限 + 容差；取不到套餐时兜底 3 + 容差", () => {
    expect(SHARE_CONN_TOLERANCE).toBe(2);
    expect(SHARE_FALLBACK_MAX_DEVICES).toBe(3);
    expect(SHARE_STRIKE_WINDOW_MS).toBe(30 * 60_000);
    expect(SHARE_WARN_COOLDOWN_MS).toBe(7 * 86_400_000);
  });

  it("未超标：不写 strikes、不发邮件、不暂停", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store); // plan_monthly max_devices 3 → 阈值 5
    await reportConns(env, t.uuid, 5); // == 阈值不超标
    await reportConns(env, t.uuid, 5);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_conn_strikes).toBeUndefined();
    expect(saved.share_warned_at).toBeUndefined();
    expect(saved.share_suspended_at).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("首次超标只警告：连续 2 周期超标发警告邮件，不暂停", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store);

    await reportConns(env, t.uuid, 6); // 第 1 周期超标：只记 strikes
    let saved = readToken(tokens.store, t.uuid);
    expect(saved.share_conn_strikes?.count).toBe(1);
    expect(saved.share_warned_at).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();

    await reportConns(env, t.uuid, 6); // 第 2 周期连续超标：警告
    saved = readToken(tokens.store, t.uuid);
    expect(saved.share_warned_at).toBeGreaterThan(0);
    expect(saved.notify_log?.share_warn).toBeGreaterThan(0);
    expect(saved.share_suspended_at).toBeUndefined(); // 只警告不暂停
    expect(saved.status).toBe("active");
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe(t.contact);
    expect(subject).toContain("异常并发连接");
    expect(html).toContain("重置订阅链接");
    expect(html).toContain("7 天内再次检测到异常并发，服务将被暂停");
  });

  it("警告后 7 天内再犯：置暂停 + 暂停邮件 + 快照剔除 + 推送节点刷新", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store, { share_warned_at: Date.now() - 3_600_000 });

    await reportConns(env, t.uuid, 6); // strikes count=1
    await reportConns(env, t.uuid, 6); // count=2 → 暂停

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_suspended_at).toBeGreaterThan(0);
    expect(saved.share_conn_strikes).toBeUndefined(); // 暂停后计数清除
    expect(saved.status).toBe("active"); // 暂停不是吊销/过期
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, , subject, html] = vi.mocked(sendMail).mock.calls[0];
    expect(subject).toContain("服务已暂停");
    expect(html).toContain("续费任意套餐后服务自动恢复");

    // 授权快照（生成侧）剔除该 uuid
    const snap = await computeAuthSnapshot(env);
    expect(snap.uuids).not.toContain(t.uuid);
    // 推送节点立即刷新（fire-and-forget）
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it("警告已是 7 天前：重新警告一轮，不直接暂停", async () => {
    const { env, tokens } = makeEnv();
    const oldWarn = Date.now() - 8 * 86_400_000;
    const t = seedToken(tokens.store, { share_warned_at: oldWarn });

    await reportConns(env, t.uuid, 6);
    await reportConns(env, t.uuid, 6);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_suspended_at).toBeUndefined();
    expect(saved.share_warned_at).toBeGreaterThan(oldWarn); // 警告时间已刷新
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, , subject] = vi.mocked(sendMail).mock.calls[0];
    expect(subject).toContain("异常并发连接"); // 警告邮件而非暂停邮件
  });

  it("strikes 超 30 分钟窗口重新计数：不连续不计处置", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store, {
      share_conn_strikes: { at: Date.now() - SHARE_STRIKE_WINDOW_MS - 60_000, count: 1 },
    });

    await reportConns(env, t.uuid, 6); // 距上次超标超窗口：重新从 1 计
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_conn_strikes?.count).toBe(1);
    expect(saved.share_warned_at).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("未超标时 strikes 清零：下次超标从 1 重新计", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store, { share_conn_strikes: { at: Date.now(), count: 1 } });

    await reportConns(env, t.uuid, 2); // 未超标
    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_conn_strikes).toBeUndefined();
  });

  it("多 uuid 按 token 聚合：主 uuid + 设备槽位并发数求和后判阈值", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store);
    const device = {
      id: "dv_1",
      uuid: "uuid-share-device-1",
      name: "设备",
      traffic_used_gb: 0,
      created_at: Date.now(),
    };
    t.devices = [device];
    tokens.store.set(KV.TOKEN + t.uuid, JSON.stringify(t));
    tokens.store.set(KV.DEVICE + device.uuid, JSON.stringify({ token_id: t.id }));

    // 主 uuid 3 + 设备 3 = 6 > 5，聚合后超标
    await report(env, { conns: { [t.uuid]: 3, [device.uuid]: 3 } });
    await report(env, { conns: { [t.uuid]: 3, [device.uuid]: 3 } });

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_warned_at).toBeGreaterThan(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("已暂停 token 不再重复判定/写库", async () => {
    const { env, tokens } = makeEnv();
    const suspendedAt = Date.now() - 1000;
    const t = seedToken(tokens.store, { share_suspended_at: suspendedAt });

    await reportConns(env, t.uuid, 20);
    await reportConns(env, t.uuid, 20);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_suspended_at).toBe(suspendedAt); // 原值不动
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("共享检测：续费自动解锁", () => {
  const seedOrder = (over: Partial<Order> = {}): Order => ({
    id: `ord_share_${seq}`,
    plan_id: "plan_monthly",
    status: "pending",
    contact: "sharer1@example.com",
    created_at: Date.now(),
    ...over,
  });

  it("续费发货（管理端确认收款）后：同 contact 被暂停 token 清除暂停恢复", async () => {
    const { env, tokens, orders } = makeEnv();
    const t = seedToken(tokens.store, {
      contact: "sharer1@example.com",
      share_suspended_at: Date.now(),
      share_conn_strikes: { at: Date.now(), count: 3 },
    });
    const order = seedOrder();
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));

    const res = await worker.fetch(
      new Request(`https://api.test/api/admin/orders/${order.id}/paid`, {
        method: "POST",
        headers: { "x-admin-key": ADMIN_KEY },
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_suspended_at).toBeUndefined();
    expect(saved.share_conn_strikes).toBeUndefined();
    // 快照（生成侧）恢复包含
    const snap = await computeAuthSnapshot(env);
    expect(snap.uuids).toContain(t.uuid);
  });

  it("升级订单发货同样解锁（同一 token 续期场景）", async () => {
    const { env, tokens, orders } = makeEnv();
    const t = seedToken(tokens.store, {
      contact: "sharer1@example.com",
      share_suspended_at: Date.now(),
    });
    const order = seedOrder({ upgrade_token_id: t.id });
    orders.store.set(KV.ORDER + order.id, JSON.stringify(order));

    const res = await worker.fetch(
      new Request(`https://api.test/api/admin/orders/${order.id}/paid`, {
        method: "POST",
        headers: { "x-admin-key": ADMIN_KEY },
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_suspended_at).toBeUndefined();
    expect(saved.plan_id).toBe("plan_monthly"); // 升级路径本身语义不受影响
  });
});

describe("共享检测：管理端误伤救济与用户侧状态", () => {
  it("PUT /api/admin/tokens/:id 清除 share_suspended_at", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store, {
      share_suspended_at: Date.now(),
      share_conn_strikes: { at: Date.now(), count: 2 },
    });

    const res = await worker.fetch(
      new Request(`https://api.test/api/admin/tokens/${t.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
        body: JSON.stringify({ clear_share_suspension: true }),
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { share_suspended_at?: number } };
    expect(body.data.share_suspended_at).toBeUndefined();

    const saved = readToken(tokens.store, t.uuid);
    expect(saved.share_suspended_at).toBeUndefined();
    expect(saved.share_conn_strikes).toBeUndefined();
    // 快照恢复包含
    const snap = await computeAuthSnapshot(env);
    expect(snap.uuids).toContain(t.uuid);
  });

  it("未暂停时 clear_share_suspension 不产生变更（nothing to update）", async () => {
    const { env, tokens } = makeEnv();
    const t = seedToken(tokens.store);

    const res = await worker.fetch(
      new Request(`https://api.test/api/admin/tokens/${t.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
        body: JSON.stringify({ clear_share_suspension: true }),
      }),
      env,
      ctx
    );
    expect(res.status).toBe(400);
  });

  it("GET /api/tokens/:id 响应带 share_suspended_at（TokenStatus 用）", async () => {
    const { env, tokens } = makeEnv();
    const suspendedAt = Date.now();
    const t = seedToken(tokens.store, { share_suspended_at: suspendedAt });

    // 非本人概要视图也带该字段（前端展示「已暂停」状态）
    const res = await worker.fetch(new Request(`https://api.test/api/tokens/${t.id}`), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { share_suspended_at?: number } };
    expect(body.data.share_suspended_at).toBe(suspendedAt);
  });
});
