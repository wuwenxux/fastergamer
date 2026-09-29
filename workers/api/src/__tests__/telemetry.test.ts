import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Node, type Token } from "../../../../shared/types";
import { invalidateNodesCache } from "../lib/nodes";
import type { Env } from "../types";

/**
 * Analytics Engine 遥测（lib/telemetry.ts 统一出口，绑定可选）：
 * - order_created / order_fulfilled：下单与发货两条路径各记一笔，index=订单 id 可对账
 * - token_activated：激活事件，来源区分 trial_converted / direct
 * - traffic_settled：结算增量（delta>0 才记）
 * - sub_fetched：订阅成功下发（format + 客户端家族）
 * - 无 TELEMETRY 绑定 / writeDataPoint 抛异常：业务路径照常，不炸不报错
 * TELEMETRY 用 vi.fn 假绑定；DoH 桩成无解析结果；邮件未配置自动 skip。
 */

import { makeEnv, noopCtx, stubCtx } from "./helpers";

interface Point {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

/** 假 TELEMETRY 绑定：收集 writeDataPoint 入参供断言 */
const fakeTelemetry = (throwing = false) => {
  const points: Point[] = [];
  const ds = {
    writeDataPoint: (p: Point) => {
      if (throwing) throw new Error("ae unavailable");
      points.push(JSON.parse(JSON.stringify(p)) as Point);
    },
  } as unknown as AnalyticsEngineDataset;
  return { ds, points };
};

const MONTHLY = { id: "plan_monthly", name: "月付", duration_days: 30, price_cny: 12, traffic_limit_gb: 20 };

const NODE: Node = {
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

let seq = 0;
const seedToken = (store: Map<string, string>, over: Partial<Token> = {}): Token => {
  seq += 1;
  const t: Token = {
    id: `tk_tel${seq}`,
    uuid: `uuid-tel-${seq}`,
    plan_id: "plan_monthly",
    status: "active",
    traffic_limit_gb: 20,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
    contact: `user${seq}@example.com`,
    expires_at: Date.now() + 30 * 86_400_000,
    ...over,
  };
  store.set(KV.TOKEN + t.uuid, JSON.stringify(t));
  store.set(KV.TOKEN_BY_ID + t.id, JSON.stringify({ uuid: t.uuid }));
  return t;
};

const setup = (pointsSink?: { ds: AnalyticsEngineDataset }, adminKey = "adm") => {
  const { env, tokens, nodes, orders } = makeEnv({
    nodes: [NODE],
    defaultPlans: [MONTHLY],
    adminKey,
    extra: {
      SITE_URL: "https://fastergamer.click",
      ADMIN_NOTIFY_EMAIL: "admin@test.com",
      ...(pointsSink ? { TELEMETRY: pointsSink.ds } : {}),
    },
  });
  invalidateNodesCache(); // getNodes 有 60s isolate 缓存，跨用例必须失效
  return { env, tokens, nodes, orders };
};

beforeEach(() => {
  vi.clearAllMocks();
  // resolveNodeIps / pushAuthRefresh 等出站全部桩掉，不触网
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => ({ Answer: [] }), ok: true }) as unknown as typeof fetch)
  );
});

describe("Analytics Engine 遥测：采集点", () => {
  it("下单（pending）记 order_created；站长确认收款发货后记 order_fulfilled，同一订单 id 可对账", async () => {
    const tel = fakeTelemetry();
    const { env } = setup(tel);

    const create = await worker.fetch(
      new Request("https://api.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "plan_monthly", contact: "buyer@example.com" }),
      }),
      env,
      stubCtx()
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { order: { id: string } } };
    const orderId = created.data.order.id;

    const createdPoint = tel.points.find((p) => p.blobs?.[0] === "order_created");
    expect(createdPoint).toBeDefined();
    expect(createdPoint!.blobs).toEqual(["order_created", "plan_monthly", "manual"]);
    expect(createdPoint!.doubles).toEqual([12]); // 实付金额（无抵扣=标价）
    expect(createdPoint!.indexes).toEqual([orderId]);

    const paid = await worker.fetch(
      new Request(`https://api.test/api/admin/orders/${orderId}/paid`, {
        method: "POST",
        headers: { "x-admin-key": "adm" },
      }),
      env,
      stubCtx()
    );
    expect(paid.status).toBe(200);

    const fulfilled = tel.points.filter((p) => p.blobs?.[0] === "order_fulfilled");
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].blobs).toEqual(["order_fulfilled", "plan_monthly"]);
    expect(fulfilled[0].doubles).toEqual([12]);
    expect(fulfilled[0].indexes).toEqual([orderId]); // 与 order_created 同 index
  });

  it("激活记 token_activated：试用转正标记 trial_converted，普通购买 direct", async () => {
    const tel = fakeTelemetry();
    const { env, tokens } = setup(tel);
    const converted = seedToken(tokens.store, { status: "paid", trial_converted: true, expires_at: undefined });
    const direct = seedToken(tokens.store, { status: "paid", expires_at: undefined });

    for (const t of [converted, direct]) {
      const res = await worker.fetch(
        new Request(`https://api.test/api/tokens/${t.id}/activate`, { method: "POST" }),
        env,
        stubCtx()
      );
      expect(res.status).toBe(200);
    }

    const events = tel.points.filter((p) => p.blobs?.[0] === "token_activated");
    expect(events).toHaveLength(2);
    expect(events[0].blobs).toEqual(["token_activated", "plan_monthly", "trial_converted"]);
    expect(events[0].indexes).toEqual([converted.id]);
    expect(events[1].blobs).toEqual(["token_activated", "plan_monthly", "direct"]);
    expect(events[1].indexes).toEqual([direct.id]);
  });

  it("流量结算记 traffic_settled（plan_id + node_id + bytes，index=token id）", async () => {
    const tel = fakeTelemetry();
    const { env, tokens } = setup(tel);
    const t = seedToken(tokens.store);

    const res = await worker.fetch(
      new Request("https://api.test/api/agent/traffic", {
        method: "POST",
        headers: { "content-type": "application/json", "x-node-key": "node-key-1" },
        body: JSON.stringify({ v: 2, settled: { [t.uuid]: 1e6 }, ip_conns: {} }),
      }),
      env,
      stubCtx()
    );
    expect(res.status).toBe(200);

    const p = tel.points.find((x) => x.blobs?.[0] === "traffic_settled");
    expect(p).toBeDefined();
    expect(p!.blobs).toEqual(["traffic_settled", "plan_monthly", "node-hk-01"]);
    expect(p!.doubles).toEqual([1e6]);
    expect(p!.indexes).toEqual([t.id]);
  });

  it("订阅拉取记 sub_fetched（format + 客户端家族，index=凭证 uuid）", async () => {
    const tel = fakeTelemetry();
    const { env, tokens } = setup(tel);
    const t = seedToken(tokens.store);

    const res = await worker.fetch(
      new Request(`https://api.test/api/sub?uuid=${t.uuid}`, {
        headers: { "user-agent": "clash-verge/v2.0" },
      }),
      env,
      stubCtx()
    );
    expect(res.status).toBe(200);

    const p = tel.points.find((x) => x.blobs?.[0] === "sub_fetched");
    expect(p).toBeDefined();
    expect(p!.blobs).toEqual(["sub_fetched", "clash", "clash-meta"]);
    expect(p!.indexes).toEqual([t.uuid]);
  });
});

describe("Analytics Engine 遥测：容错", () => {
  it("无 TELEMETRY 绑定：下单→发货→激活全链路照常，不炸不报错", async () => {
    const { env, orders } = setup(); // 不带 TELEMETRY

    const create = await worker.fetch(
      new Request("https://api.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: "plan_monthly", contact: "buyer@example.com" }),
      }),
      env,
      stubCtx()
    );
    expect(create.status).toBe(201);
    const { data } = (await create.json()) as { data: { order: { id: string } } };
    const paid = await worker.fetch(
      new Request(`https://api.test/api/admin/orders/${data.order.id}/paid`, {
        method: "POST",
        headers: { "x-admin-key": "adm" },
      }),
      env,
      stubCtx()
    );
    expect(paid.status).toBe(200);
    const order = JSON.parse(orders.store.get(KV.ORDER + data.order.id)!) as { status: string; token_id: string };
    expect(order.status).toBe("paid");
    const act = await worker.fetch(
      new Request(`https://api.test/api/tokens/${order.token_id}/activate`, { method: "POST" }),
      env,
      stubCtx()
    );
    expect(act.status).toBe(200);
  });

  it("writeDataPoint 抛异常：业务照常返回 200（观测设施绝不能影响业务）", async () => {
    const tel = fakeTelemetry(true);
    const { env, tokens } = setup(tel);
    const t = seedToken(tokens.store, { status: "paid", expires_at: undefined });

    const res = await worker.fetch(
      new Request(`https://api.test/api/tokens/${t.id}/activate`, { method: "POST" }),
      env,
      stubCtx()
    );
    expect(res.status).toBe(200);
  });
});
