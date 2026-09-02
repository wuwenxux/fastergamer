import { Hono } from "hono";
import { KV, type Node } from "../../../../shared/types";
import { getNodes, saveNodes, saveNodeStat, deleteNodeStat, isNodeOnline } from "../lib/nodes";
import { pushAuthRefresh } from "../lib/authpush";
import { adminAuth } from "../middleware/admin";
import type { Env } from "../types";

export const nodesRoutes = new Hono<{ Bindings: Env }>();
nodesRoutes.use("*", adminAuth);

const generateKey = () => {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `nk_${hex}`;
};

/** GET /api/admin/nodes —— 列出所有节点（含在线状态） */
nodesRoutes.get("/", async (c) => {
  const nodes = await getNodes(c.env);
  // 默认隐藏 key；运维脚本（node-metrics 等）可用 ?with_key=1 显式取回
  if (c.req.query("with_key") === "1") {
    return c.json({ ok: true, data: nodes.map((n) => ({ ...n, online: isNodeOnline(n) })) });
  }
  const safe = nodes.map(({ key, ...rest }) => ({
    ...rest,
    online: isNodeOnline(rest),
  }));
  return c.json({ ok: true, data: safe });
});

/**
 * POST /api/admin/nodes/probe-state —— probe-nodes.sh 上报节点可达性判定
 * 请求体：{ host, port, online }。只在状态翻转或 30 分钟刷新时调用，正常每天每节点 ≤48 次写。
 */
nodesRoutes.post("/probe-state", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    host?: string;
    port?: number;
    online?: boolean;
  } | null;
  if (!body?.host || typeof body.online !== "boolean") {
    return c.json({ ok: false, error: "host, online are required" }, 400);
  }
  const nodes = await getNodes(c.env);
  const node = nodes.find(
    (n) => n.host === body.host && (n.port || 443) === (body.port || 443)
  );
  if (!node) return c.json({ ok: false, error: "node not found" }, 404);
  node.probe_online = body.online;
  node.probe_at = Date.now();
  await saveNodeStat(c.env, node);
  return c.json({ ok: true });
});

/** POST /api/admin/nodes —— 新增节点 */
nodesRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<Node> | null;
  if (!body?.id || !body.host || !body.region) {
    return c.json({ ok: false, error: "id, host, region are required" }, 400);
  }

  const nodes = await getNodes(c.env);
  if (nodes.some((n) => n.id === body.id)) {
    return c.json({ ok: false, error: "node id already exists" }, 409);
  }

  const node: Node = {
    id: body.id,
    key: generateKey(),
    name: body.name ?? body.id,
    region: body.region,
    host: body.host,
    port: body.port ?? 443,
    tls: body.tls ?? true,
    ws_path: body.ws_path ?? "/vless-ws",
    active: body.active ?? true,
    ...(body.reality ? { reality: body.reality } : {}),
    ...(body.hy2 ? { hy2: body.hy2 } : {}),
  };

  nodes.push(node);
  await saveNodes(c.env, nodes);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 新节点进订阅/快照
  return c.json({ ok: true, data: { node: { ...node, key: node.key } } });
});

/** PUT /api/admin/nodes/:id —— 修改节点 */
nodesRoutes.put("/:id", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as Partial<Node> | null;
  if (!body) return c.json({ ok: false, error: "invalid body" }, 400);

  const nodes = await getNodes(c.env);
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx === -1) return c.json({ ok: false, error: "node not found" }, 404);

  // 不允许通过此接口修改 id 和 key，防止误操作破坏 Agent 认证
  const { id: _id, key: _key, ...rest } = body;
  nodes[idx] = { ...nodes[idx], ...rest };
  await saveNodes(c.env, nodes);
  // body 里若含动态字段（billing_mode / 月配额重置等），同步到 nodestat 单键
  await saveNodeStat(c.env, nodes[idx]);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 节点信息（host/port/active 等）变更进快照
  return c.json({ ok: true, data: nodes[idx] });
});

/** DELETE /api/admin/nodes/:id —— 删除节点 */
nodesRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const nodes = await getNodes(c.env);
  const filtered = nodes.filter((n) => n.id !== id);
  if (filtered.length === nodes.length) {
    return c.json({ ok: false, error: "node not found" }, 404);
  }
  await saveNodes(c.env, filtered);
  await deleteNodeStat(c.env, id);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 节点摘除进快照
  return c.json({ ok: true });
});

/** POST /api/admin/nodes/:id/rotate-key —— 重置节点 key */
nodesRoutes.post("/:id/rotate-key", async (c) => {
  const id = c.req.param("id");
  const nodes = await getNodes(c.env);
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx === -1) return c.json({ ok: false, error: "node not found" }, 404);

  nodes[idx].key = generateKey();
  await saveNodes(c.env, nodes);
  return c.json({ ok: true, data: { key: nodes[idx].key } });
});
