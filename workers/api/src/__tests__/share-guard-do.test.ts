import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Device, type Plan, type Token } from "../../../../shared/types";
import {
  EVAL_PACE_MS,
  NODE_STALE_MS,
  SHARE_CANDIDATE_MIN_CONNS,
  ShareGuardDO,
  applyDgBaseline,
  evaluateGlobalConns,
  perUuidTotals,
  type DgMemEntry,
  type NodeEntry,
} from "../do/share-guard";
import { DG_CONFIRM_MS } from "../lib/device-guard";
import { CONN_SUSPEND_THRESHOLD, SHARE_WARN_COOLDOWN_MS } from "../lib/share-guard";
import { makeEnv as baseEnv } from "./helpers";
import type { Env } from "../types";

/**
 * DO 实时防共享（src/do/share-guard.ts）：
 * - evaluateGlobalConns 纯函数全分支：跨节点凑数、单节点多 IP pending→3min 确认→阻断裁决、
 *   基线收养/首见不判/可疑离线重记、allowed_ips/transition_ips 剔除、plan_biz 跳过、同 token 去重
 * - ShareGuardDO 类：心跳 prune/快照替换、节拍限制、裁决执行落 KV（blocked_ips 台账 /
 *   share_suspended_at）、authpush 触发
 * - /api/agent/presence 端点：鉴权、nodeId 注入（不信 agent 自报）、无绑定时 ack 降级
 * fetch 全部假成功（geo 查询/节点 refresh 推送），sendMail mock 掉。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});
import { sendMail } from "../lib/email-aliyun";

const PLANS = [
  { id: "plan_pack_5g", name: "5GB 流量包", duration_days: 0, price_cny: 3, traffic_limit_gb: 5, max_devices: 1 },
  { id: "plan_monthly", name: "月付套餐", duration_days: 30, price_cny: 12, traffic_limit_gb: 200, max_devices: 3 },
  { id: "plan_biz_yearly", name: "企业年付", duration_days: 365, price_cny: 999, traffic_limit_gb: 5000, max_devices: 20 },
] as Plan[];

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

const T0 = 1_800_000_000_000;
let seq = 0;
const makeToken = (over: Partial<Token> = {}): Token => {
  seq += 1;
  return {
    id: `tk_do${seq}`,
    uuid: `uuid-do-${seq}`,
    plan_id: "plan_pack_5g",
    status: "active",
    traffic_limit_gb: 5,
    traffic_used_gb: 0,
    purchased_at: T0,
    contact: `do${seq}@example.com`,
    expires_at: T0 + 30 * 86_400_000,
    ...over,
  };
};

/** 纯函数夹具：构造节点表 */
const nodeEntry = (at: number, uuids: Record<string, { count: number; ips: string[] }>): NodeEntry => ({
  at,
  uuids: new Map(Object.entries(uuids)),
});

const seedToken = (store: Map<string, string>, token: Token) => {
  store.set(KV.TOKEN + token.uuid, JSON.stringify(token));
  store.set(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
  for (const d of token.devices ?? []) {
    store.set(KV.DEVICE + d.uuid, JSON.stringify({ token_id: token.id }));
  }
};

const readToken = (store: Map<string, string>, uuid: string): Token =>
  JSON.parse(store.get(KV.TOKEN + uuid)!) as Token;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  // geo 查询（ip-api）与节点 refresh 推送一律假成功，不触网
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("perUuidTotals 跨节点聚合", () => {
  it("同 uuid 多节点并发求和；不同 uuid 各自独立", () => {
    const nodes = new Map<string, NodeEntry>([
      ["n1", nodeEntry(T0, { a: { count: 2, ips: [] }, b: { count: 1, ips: [] } })],
      ["n2", nodeEntry(T0, { a: { count: 3, ips: [] } })],
    ]);
    const totals = perUuidTotals(nodes);
    expect(totals.get("a")).toBe(5);
    expect(totals.get("b")).toBe(1);
  });
});

describe("evaluateGlobalConns 纯函数：share-guard 实时版", () => {
  const shareInput = (token: Token, nodes: Map<string, NodeEntry>, infos?: Map<string, { token: Token; device?: Device }>) => ({
    nodes,
    dgMem: new Map<string, DgMemEntry>(),
    infos: infos ?? new Map([[token.uuid, { token }]]),
    now: T0,
  });

  it("跨节点凑数触发：单节点视角都不超标，跨节点总和超标才出裁决（DO 的核心价值）", () => {
    // 单设备套餐 limit = 1+2 = 3；两个节点各 2 个并发，各自看不超标，总和 4 超标
    const token = makeToken();
    const nodes = new Map<string, NodeEntry>([
      ["n1", nodeEntry(T0, { [token.uuid]: { count: 2, ips: ["1.1.1.1"] } })],
      ["n2", nodeEntry(T0, { [token.uuid]: { count: 2, ips: ["2.2.2.2"] } })],
    ]);
    const verdicts = evaluateGlobalConns(shareInput(token, nodes));
    expect(verdicts).toEqual([{ kind: "share", info: { token }, total: 4 }]);
  });

  it("同 token 多凭证跨节点求和：主 uuid + 设备槽位一起计", () => {
    const slot: Device = { id: "dv_1", uuid: "uuid-slot-1", name: "副机", traffic_used_gb: 0, created_at: T0 };
    const token = makeToken({ plan_id: "plan_monthly", devices: [slot] });
    // 阶梯轨道处置阈值 >5：主 3 + 槽位 3 = 6
    const nodes = new Map<string, NodeEntry>([
      ["n1", nodeEntry(T0, { [token.uuid]: { count: 3, ips: [] } })],
      ["n2", nodeEntry(T0, { [slot.uuid]: { count: 3, ips: [] } })],
    ]);
    const infos = new Map([[token.uuid, { token }], [slot.uuid, { token, device: slot }]]);
    const verdicts = evaluateGlobalConns(shareInput(token, nodes, infos));
    expect(verdicts).toHaveLength(1); // 同 token 多候选凭证只裁一次
    expect(verdicts[0]).toMatchObject({ kind: "share", total: 6 });
  });

  it("低于候选门槛不出裁决；未反查到的凭证（节拍限制）不判定", () => {
    const token = makeToken();
    const nodes = new Map<string, NodeEntry>([
      ["n1", nodeEntry(T0, { [token.uuid]: { count: 1, ips: ["1.1.1.1"] } })],
    ]);
    expect(evaluateGlobalConns(shareInput(token, nodes))).toEqual([]);
    // 超标但没进 infos（本轮节拍未轮到）：不判
    const nodes2 = new Map<string, NodeEntry>([
      ["n1", nodeEntry(T0, { [token.uuid]: { count: 9, ips: [] } })],
    ]);
    expect(evaluateGlobalConns(shareInput(token, nodes2, new Map()))).toEqual([]);
  });

  it("过期节点条目不计入并发总和（调用方 prune 后的语义）", () => {
    const token = makeToken();
    // n2 条目 at 超过 NODE_STALE_MS，应被 prune；prune 后只剩 n1 的 2 个并发，不超标
    const nodes = new Map<string, NodeEntry>([
      ["n1", nodeEntry(T0, { [token.uuid]: { count: 2, ips: [] } })],
      ["n2", nodeEntry(T0 - NODE_STALE_MS - 1, { [token.uuid]: { count: 2, ips: [] } })],
    ]);
    // 模拟 DO 心跳入口的 prune
    for (const [id, e] of nodes) if (T0 - e.at > NODE_STALE_MS) nodes.delete(id);
    expect(evaluateGlobalConns(shareInput(token, nodes))).toEqual([]);
  });
});

describe("evaluateGlobalConns 纯函数：device-guard 实时版", () => {
  const dgNodes = (token: Token, ips: string[], nodeId = "n1") =>
    new Map<string, NodeEntry>([[nodeId, nodeEntry(T0, { [token.uuid]: { count: ips.length, ips } })]]);

  /** 模拟真实链路：心跳先做基线维护（applyDgBaseline），裁决再跑 evaluateGlobalConns */
  const dgRun = (dgMem: Map<string, DgMemEntry>, token: Token, now: number, ips: string[]) => {
    applyDgBaseline(dgMem, "n1", token.uuid, ips);
    return evaluateGlobalConns({
      nodes: new Map([["n1", nodeEntry(now, { [token.uuid]: { count: ips.length, ips } })]]),
      dgMem,
      infos: new Map([[token.uuid, { token }]]),
      now,
    });
  };

  it("首次见到并发 ≥2 IP：只建基线不出裁决（语义等价结算路径 prevIps 为空不判定）", () => {
    const token = makeToken();
    const dgMem = new Map<string, DgMemEntry>();
    const verdicts = evaluateGlobalConns({
      nodes: dgNodes(token, ["1.1.1.1", "2.2.2.2"]),
      dgMem,
      infos: new Map([[token.uuid, { token }]]),
      now: T0,
    });
    expect(verdicts.filter((v) => v.kind === "dg")).toEqual([]);
    expect(dgMem.get(`n1:${token.uuid}`)).toMatchObject({ seen: true });
  });

  it("新 IP 出现 → pending → 3min 内不裁 → 确认窗口后仍在线 → 出阻断裁决且并入基线", () => {
    const token = makeToken();
    const dgMem = new Map<string, DgMemEntry>();
    const run = (now: number, ips: string[]) => dgRun(dgMem, token, now, ips);
    expect(run(T0, ["1.1.1.1"])).toEqual([]); // 单 IP 建基线
    expect(run(T0 + 1000, ["1.1.1.1", "2.2.2.2"])).toEqual([]); // 新 IP → pending
    expect(dgMem.get(`n1:${token.uuid}`)?.pending?.ips).toEqual(["2.2.2.2"]);
    // 确认窗口内：不裁
    expect(run(T0 + 1000 + DG_CONFIRM_MS - 1000, ["1.1.1.1", "2.2.2.2"])).toEqual([]);
    // 窗口后仍在线：裁
    const verdicts = run(T0 + 1000 + DG_CONFIRM_MS, ["1.1.1.1", "2.2.2.2"]);
    const dg = verdicts.find((v) => v.kind === "dg");
    expect(dg).toMatchObject({ kind: "dg", nodeId: "n1", uuid: token.uuid, ips: ["2.2.2.2"], prevIps: ["1.1.1.1"] });
    // 裁决后 pending 清除、被裁 IP 并入基线（不重复裁决）
    const mem = dgMem.get(`n1:${token.uuid}`)!;
    expect(mem.pending).toBeUndefined();
    expect([...mem.baseline]).toContain("2.2.2.2");
    expect(run(T0 + 1000 + DG_CONFIRM_MS + 1000, ["1.1.1.1", "2.2.2.2"])).toEqual([]);
  });

  it("可疑 IP 确认前离线：清除 pending（一次网络切换）；仍有新可疑则重记", () => {
    const token = makeToken();
    const dgMem = new Map<string, DgMemEntry>();
    const run = (now: number, ips: string[]) => dgRun(dgMem, token, now, ips);
    run(T0, ["1.1.1.1", "9.9.9.9"]); // 首见建基线（两个都在基线里）
    run(T0 + 1000, ["1.1.1.1", "2.2.2.2"]); // 2.2.2.2 新 → pending
    // 确认时 2.2.2.2 已离线，无其他新 IP：清除
    expect(run(T0 + 1000 + DG_CONFIRM_MS, ["1.1.1.1", "9.9.9.9"])).toEqual([]);
    expect(dgMem.get(`n1:${token.uuid}`)?.pending).toBeUndefined();
    // 再现新 IP→pending；确认时原可疑离线但出现另一个新可疑：重记不裁
    run(T0 + 2000 + DG_CONFIRM_MS, ["1.1.1.1", "3.3.3.3"]);
    const t2 = T0 + 2000 + DG_CONFIRM_MS + DG_CONFIRM_MS;
    expect(run(t2, ["1.1.1.1", "4.4.4.4"])).toEqual([]);
    expect(dgMem.get(`n1:${token.uuid}`)?.pending?.ips).toEqual(["4.4.4.4"]);
  });

  it("并发回落 <2 IP：撤 pending 且基线收养当前 IP（顺序换 IP 不判）", () => {
    const token = makeToken();
    const dgMem = new Map<string, DgMemEntry>();
    const run = (now: number, ips: string[]) => dgRun(dgMem, token, now, ips);
    run(T0, ["1.1.1.1"]);
    run(T0 + 1000, ["1.1.1.1", "2.2.2.2"]); // pending
    run(T0 + 2000, ["2.2.2.2"]); // 旧 IP 下线、新 IP 单飞：顺序切换
    const mem = dgMem.get(`n1:${token.uuid}`)!;
    expect(mem.pending).toBeUndefined();
    expect([...mem.baseline]).toEqual(["2.2.2.2"]); // 收养后它不再是「新 IP」
  });

  it("allowed_ips 与未到期 transition_ips 剔除；到期仍活跃的过渡 IP 视为新 IP", () => {
    // allowed：另一个 IP 在白名单里 → effective <2 不判
    const allowedToken = makeToken({ allowed_ips: ["2.2.2.2"] });
    const dgMem1 = new Map<string, DgMemEntry>();
    const run1 = (now: number, ips: string[]) => dgRun(dgMem1, allowedToken, now, ips);
    run1(T0, ["1.1.1.1"]);
    expect(run1(T0 + 1000, ["1.1.1.1", "2.2.2.2"])).toEqual([]); // 白名单剔除后不并发
    expect(dgMem1.get(`n1:${allowedToken.uuid}`)?.pending).toBeUndefined();

    // 过渡期内剔除；到期仍活跃 → 确证可疑进 pending（不受基线限制）
    const transToken = makeToken({ transition_ips: { "2.2.2.2": T0 + 60_000 } });
    const dgMem2 = new Map<string, DgMemEntry>();
    const run2 = (now: number, ips: string[]) => dgRun(dgMem2, transToken, now, ips);
    run2(T0, ["1.1.1.1", "2.2.2.2"]); // 过渡期内剔除，effective=[1.1.1.1] 建基线
    expect(run2(T0 + 61_000, ["1.1.1.1", "2.2.2.2"])).toEqual([]); // 到期 → pending
    expect(dgMem2.get(`n1:${transToken.uuid}`)?.pending?.ips).toEqual(["2.2.2.2"]);
    const dg = run2(T0 + 61_000 + DG_CONFIRM_MS, ["1.1.1.1", "2.2.2.2"]).find((v) => v.kind === "dg");
    expect(dg).toMatchObject({ ips: ["2.2.2.2"] });
  });

  it("plan_biz 企业套餐不判定（团队共享是设计用途）", () => {
    const token = makeToken({ plan_id: "plan_biz_yearly" });
    const dgMem = new Map<string, DgMemEntry>();
    const run = (now: number) =>
      evaluateGlobalConns({
        nodes: new Map([["n1", nodeEntry(now, { [token.uuid]: { count: 3, ips: ["1.1.1.1", "2.2.2.2", "3.3.3.3"] } })]]),
        dgMem,
        infos: new Map([[token.uuid, { token }]]),
        now,
      });
    run(T0);
    expect(run(T0 + DG_CONFIRM_MS + 60_000)).toEqual([]);
  });
});

describe("ShareGuardDO 类：心跳与裁决执行", () => {
  const makeDo = (env: Env) => {
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => void pending.push(Promise.resolve(p).catch(() => {})),
    } as unknown as DurableObjectState;
    return { do: new ShareGuardDO(ctx, env), pending };
  };
  const beat = (d: ShareGuardDO, nodeId: string, conns: Record<string, number>, ips: Record<string, string[]>) =>
    d.fetch(new Request("https://share-guard.do/heartbeat", { method: "POST", body: JSON.stringify({ nodeId, conns, ips }) }));

  const makeDoEnv = () => baseEnv({ nodes: [NODE], defaultPlans: PLANS, extra: { SITE_URL: "https://fastergamer.click" } });

  it("端点形状：非 POST 405；缺 nodeId 400；正常心跳 200", async () => {
    const { env } = makeDoEnv();
    const { do: d } = makeDo(env);
    expect((await d.fetch(new Request("https://x/heartbeat"))).status).toBe(405);
    expect((await d.fetch(new Request("https://x/heartbeat", { method: "POST", body: "{}" }))).status).toBe(400);
    expect((await beat(d, "n1", {}, {})).status).toBe(200);
  });

  it("device-guard 端到端：心跳发现单节点多 IP → 3min 确认 → blocked_ips + 台账落 KV + 邮件", async () => {
    const { env, tokens } = makeDoEnv();
    const token = makeToken();
    seedToken(tokens.store, token);
    const { do: d, pending } = makeDo(env);

    await beat(d, "n1", { [token.uuid]: 1 }, { [token.uuid]: ["1.1.1.1"] });
    await Promise.all(pending);
    vi.setSystemTime(T0 + EVAL_PACE_MS + 1000);
    await beat(d, "n1", { [token.uuid]: 2 }, { [token.uuid]: ["1.1.1.1", "2.2.2.2"] });
    await Promise.all(pending);
    expect(readToken(tokens.store, token.uuid).blocked_ips ?? []).toEqual([]); // pending 期不阻断

    vi.setSystemTime(T0 + EVAL_PACE_MS + 1000 + DG_CONFIRM_MS + EVAL_PACE_MS);
    await beat(d, "n1", { [token.uuid]: 2 }, { [token.uuid]: ["1.1.1.1", "2.2.2.2"] });
    await Promise.all(pending);

    const saved = readToken(tokens.store, token.uuid);
    expect(saved.blocked_ips).toEqual(["2.2.2.2"]); // 只封新 IP，老 IP 不动
    expect(saved.device_guard?.["2.2.2.2"]).toMatchObject({ uuid: token.uuid, status: "pending" });
    expect(vi.mocked(sendMail)).toHaveBeenCalled(); // 机主决策邮件
    expect(vi.mocked(fetch)).toHaveBeenCalled(); // authpush 快照重建后的节点推送/地理查询
  });

  it("share-guard 端到端：strikes 累进后 7 天内警告过再犯 → share_suspended_at + authpush", async () => {
    const { env, tokens } = makeDoEnv();
    // 预置：strikes=1（30min 窗口内）+ 1h 前已警告（7 天冷却期内）→ 下一次超标即暂停
    const token = makeToken({
      share_conn_strikes: { at: T0 - 60_000, count: 1 },
      share_warned_at: T0 - 3_600_000,
    });
    seedToken(tokens.store, token);
    const { do: d, pending } = makeDo(env);

    // 单设备套餐 limit=3：单节点 4 个并发超标（跨节点凑数由纯函数用例覆盖）
    await beat(d, "n1", { [token.uuid]: 4 }, {});
    await Promise.all(pending);

    const saved = readToken(tokens.store, token.uuid);
    expect(saved.share_suspended_at).toBe(T0);
    expect(saved.share_conn_strikes).toBeUndefined(); // 暂停后清零
  });

  it("share-guard 节拍与观测带：首次超标只记 strikes；个人多设备 >3 ≤5 写 conn_observe", async () => {
    const { env, tokens } = makeDoEnv();
    const strict = makeToken();
    seedToken(tokens.store, strict);
    const ladder = makeToken({ plan_id: "plan_monthly" });
    seedToken(tokens.store, ladder);
    const { do: d, pending } = makeDo(env);

    await beat(d, "n1", { [strict.uuid]: 4, [ladder.uuid]: 4 }, {});
    await Promise.all(pending);
    let s1 = readToken(tokens.store, strict.uuid);
    expect(s1.share_conn_strikes).toMatchObject({ count: 1 }); // 首次只记 strikes 不警告
    expect(s1.share_warned_at).toBeUndefined();
    expect(readToken(tokens.store, ladder.uuid).conn_observe).toMatchObject({ conns: 4 }); // 观测带只记录

    // 节拍内（<60s）重复心跳不推进状态机
    vi.setSystemTime(T0 + 10_000);
    await beat(d, "n1", { [strict.uuid]: 4 }, {});
    await Promise.all(pending);
    expect(readToken(tokens.store, strict.uuid).share_conn_strikes).toMatchObject({ count: 1 });

    // 过节拍后第二次超标：count=2 → 警告（不暂停）
    vi.setSystemTime(T0 + EVAL_PACE_MS + 1000);
    await beat(d, "n1", { [strict.uuid]: 4 }, {});
    await Promise.all(pending);
    s1 = readToken(tokens.store, strict.uuid);
    expect(s1.share_conn_strikes).toMatchObject({ count: 2 });
    expect(s1.share_warned_at).toBe(T0 + EVAL_PACE_MS + 1000);
    expect(s1.share_suspended_at).toBeUndefined();
  });

  it("裁决幂等：已暂停 token 不再重复判定；DO 与结算路径撞车靠 KV 字段去重", async () => {
    const { env, tokens } = makeDoEnv();
    const token = makeToken({ share_suspended_at: T0 - 1000 });
    seedToken(tokens.store, token);
    const { do: d, pending } = makeDo(env);

    await beat(d, "n1", { [token.uuid]: 9 }, {});
    await beat(d, "n2", { [token.uuid]: 9 }, {});
    await Promise.all(pending);
    const saved = readToken(tokens.store, token.uuid);
    expect(saved.share_suspended_at).toBe(T0 - 1000); // 未被覆写
    expect(saved.notify_log?.share_suspended).toBeUndefined(); // 未重复发暂停邮件
  });

  it("心跳快照整替换 + 节点过期：停止上报的节点 3min 后不再贡献并发", async () => {
    const { env, tokens } = makeDoEnv();
    const token = makeToken();
    seedToken(tokens.store, token);
    const { do: d, pending } = makeDo(env);

    // 两条心跳同一拍：首拍裁决只见 n1（total 2 不超标）；过节拍后 n2 已在内存，总和 4 → strikes=1
    await beat(d, "n1", { [token.uuid]: 2 }, {});
    await beat(d, "n2", { [token.uuid]: 2 }, {});
    await Promise.all(pending);
    vi.setSystemTime(T0 + EVAL_PACE_MS + 1000);
    await beat(d, "n1", { [token.uuid]: 2 }, {});
    await Promise.all(pending);
    expect(readToken(tokens.store, token.uuid).share_conn_strikes).toMatchObject({ count: 1 });

    // n2 静默超 3min 后被 prune：只剩 n1 的 2 并发不超标，strikes 清零
    vi.setSystemTime(T0 + NODE_STALE_MS + 2 * EVAL_PACE_MS);
    await beat(d, "n1", { [token.uuid]: 2 }, {});
    await Promise.all(pending);
    expect(readToken(tokens.store, token.uuid).share_conn_strikes).toBeUndefined();
  });
});

describe("POST /api/agent/presence 端点", () => {
  const fakeShareGuard = () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    return {
      binding: {
        idFromName: vi.fn(() => "id-global"),
        get: vi.fn(() => ({ fetch: fetchMock })),
      } as unknown as DurableObjectNamespace,
      fetchMock,
    };
  };
  const call = (env: Env, key?: string, body: unknown = { conns: {}, ips: {} }) =>
    worker.fetch(
      new Request("https://api.test/api/agent/presence", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "x-node-key": key } : {}) },
        body: JSON.stringify(body),
      }),
      env,
      { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
    );

  it("缺 x-node-key 401；无效节点 403", async () => {
    const { binding } = fakeShareGuard();
    const { env } = baseEnv({ nodes: [NODE], extra: { SHARE_GUARD: binding } });
    expect((await call(env)).status).toBe(401);
    expect((await call(env, "wrong-key")).status).toBe(403);
  });

  it("合法心跳转发全局 DO：nodeId 用鉴权后的注册表身份，不信 agent 自报", async () => {
    const { binding, fetchMock } = fakeShareGuard();
    const { env } = baseEnv({ nodes: [NODE], extra: { SHARE_GUARD: binding } });
    const res = await call(env, "node-key-1", { nodeId: "spoofed", conns: { u: 2 }, ips: { u: ["1.1.1.1"] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { forwarded: boolean } }).data.forwarded).toBe(true);
    expect(binding.idFromName).toHaveBeenCalledWith("global");
    const sent = JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as { body: string }).body);
    expect(sent.nodeId).toBe("node-hk-01"); // 注册表身份覆盖自报
    expect(sent.conns).toEqual({ u: 2 });
  });

  it("SHARE_GUARD 未绑定（本地 dev/老部署）：直接 ack 不报错，防共享退回结算路径兜底", async () => {
    const { env } = baseEnv({ nodes: [NODE] });
    const res = await call(env, "node-key-1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { forwarded: boolean } }).data.forwarded).toBe(false);
  });
});
