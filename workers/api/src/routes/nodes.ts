import { Hono } from "hono";
import { KV, type Node } from "../../../../shared/types";
import { getNodes, saveNodes } from "../lib/nodes";
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

const ONLINE_THRESHOLD_MS = 90_000;

/** GET /api/admin/nodes —— 列出所有节点（含在线状态） */
nodesRoutes.get("/", async (c) => {
  const nodes = await getNodes(c.env);
  const now = Date.now();
  // 返回时隐藏 key，需要 key 时通过创建/查看详情暴露
  const safe = nodes.map(({ key, ...rest }) => ({
    ...rest,
    online: (rest.last_seen_at ?? 0) > now - ONLINE_THRESHOLD_MS,
  }));
  return c.json({ ok: true, data: safe });
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
  };

  nodes.push(node);
  await saveNodes(c.env, nodes);
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
