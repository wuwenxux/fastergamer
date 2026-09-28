import { Hono } from "hono";
import { KV } from "../../../../../shared/types";
import type { Token } from "../../../../../shared/types";
import { deleteDeviceIndex, deleteTokenCascade, getTokenById, getTokenPresence, listKeys, rotateTokenUuid, saveToken } from "../../lib/kv";
import { clearSubBindings } from "../../lib/sub-lock";
import { resetPenalty, sendPenaltyNoticeEmail } from "../../lib/reset-penalty";
import { pushAuthRefresh } from "../../lib/authpush";
import type { Env } from "../../types";

export const adminTokensRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/admin/tokens —— 列出所有 token（含流量、在线状态）；?presence=1 时合并 presence（接入 IP 统计等），供运营分析 */
adminTokensRoutes.get("/tokens", async (c) => {
  const keys = await listKeys(c.env.TOKENS, KV.TOKEN);
  const tokens: Token[] = [];
  for (const key of keys) {
    const raw = await c.env.TOKENS.get(key.name);
    if (raw) tokens.push(JSON.parse(raw) as Token);
  }
  tokens.sort((a, b) => (b.purchased_at ?? 0) - (a.purchased_at ?? 0));
  if (c.req.query("presence") === "1") {
    const merged = [];
    for (const t of tokens) merged.push({ ...t, presence: await getTokenPresence(c.env, t) });
    return c.json({ ok: true, data: merged });
  }
  return c.json({ ok: true, data: tokens });
});

/**
 * POST /api/admin/tokens/:id/reset-penalty —— 重置续用（流量耗尽后的售后处置）
 * 用量清零、剩余流量恢复满额，服务恢复；代价仅为有效期 -30 天（可用 body 覆盖天数）。
 * 记账用 offset 基准（Xray 计数器不可清零），重置后上报只计增量。
 * body 可选：{ days_penalty?: number }
 */
adminTokensRoutes.post("/tokens/:id/reset-penalty", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    days_penalty?: number;
  } | null;
  const daysPenalty = body?.days_penalty ?? 30;

  await resetPenalty(c.env, token, daysPenalty);
  // 用量清零/状态恢复属于授权变更：推送节点更新配额基数与名单
  c.executionCtx.waitUntil(pushAuthRefresh(c.env));

  // 通知客户重置结果
  await sendPenaltyNoticeEmail(c.env, token, daysPenalty);

  return c.json({ ok: true, data: token });
});

/** DELETE /api/admin/tokens/:id —— 删除指定 token（测试清理用） */
adminTokensRoutes.delete("/tokens/:id", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  await deleteTokenCascade(c.env, token, { devices: true, trialMarker: true });
  // 删除活跃 token 需立即从各节点白名单摘除
  c.executionCtx.waitUntil(pushAuthRefresh(c.env));
  return c.json({ ok: true });
});

/**
 * POST /api/admin/tokens/:id/rotate-uuid —— 重置 token 的连接凭证（UUID）
 * 用于泄露处置：旧 UUID 立即从 KV 删除，各节点 agent 下一轮同步（≤30s）后旧凭证全节点失效，
 * 等同于"断开所有正在使用该凭证的设备"；客户更新订阅即可获得新凭证。
 * 套餐、到期时间、已用流量、Token ID 均保持不变。
 */
adminTokensRoutes.post("/tokens/:id/rotate-uuid", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  await rotateTokenUuid(c.env, token);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 旧 uuid 立即失效、新 uuid 立即生效
  return c.json({ ok: true, data: { id: token.id, uuid: token.uuid } });
});

/**
 * DELETE /api/admin/tokens/:id/devices/:deviceId —— 管理员解绑设备
 * 与用户自助解绑同逻辑（设备 uuid 从白名单摘除，全节点约 30s 失效），
 * 区别在于走 x-admin-key 免用户 session，用于售后场景（设备丢失/外借/异常占用槽位）。
 */
adminTokensRoutes.delete("/tokens/:id/devices/:deviceId", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  const deviceId = c.req.param("deviceId");
  const device = token.devices?.find((d) => d.id === deviceId);
  if (!device) return c.json({ ok: false, error: "device not found" }, 404);

  token.devices = (token.devices ?? []).filter((d) => d.id !== deviceId);
  await saveToken(c.env, token);
  await deleteDeviceIndex(c.env, device.uuid);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 设备 uuid 立即从全节点白名单摘除
  return c.json({ ok: true, data: { id: deviceId, uuid: device.uuid } });
});

/**
 * PUT /api/admin/tokens/:id —— 管理员调整 token 属性（售后用）
 * body: { max_devices?: number, extend_days?: number, reactivate?: boolean, clear_share_suspension?: boolean, clear_sub_bindings?: boolean }
 * - max_devices：token 级设备上限，覆盖套餐值（不影响同套餐其他用户）
 * - extend_days：有效期设为 当前时间 + N 天（base_expires_at 同步；months_borrowed 不动）。
 *   延长已过期的 token 时自动恢复为 active 并推送授权刷新（延期就是为了恢复服务，
 *   只改时间不改状态等于没延）
 * - reactivate：显式为 true 时，revoked 的 token 也随延期恢复 active。
 *   revoked 通常对应滥用/退款，恢复必须是管理员的明确意图，不随延期静默发生
 * - clear_share_suspension：显式为 true 时，清除共享检测暂停（误伤救济），
 *   立即推送授权刷新让节点白名单加回
 * - clear_sub_bindings：显式为 true 时，清除全部订阅设备锁绑定（售后救济：
 *   用户换手机但自助解绑在 7 天冷却中），下一次拉取重新认领；写 presence，不动 token 主键
 */
adminTokensRoutes.put("/tokens/:id", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    max_devices?: number;
    extend_days?: number;
    reactivate?: boolean;
    clear_share_suspension?: boolean;
    clear_sub_bindings?: boolean;
  } | null;
  if (!body) return c.json({ ok: false, error: "invalid body" }, 400);

  let changed = false;
  if (body.max_devices !== undefined) {
    if (!Number.isInteger(body.max_devices) || body.max_devices < 1 || body.max_devices > 50) {
      return c.json({ ok: false, error: "max_devices 需为 1-50 的整数" }, 400);
    }
    token.max_devices = body.max_devices;
    changed = true;
  }
  if (body.extend_days !== undefined) {
    if (!Number.isFinite(body.extend_days) || body.extend_days <= 0 || body.extend_days > 3650) {
      return c.json({ ok: false, error: "extend_days 需为 1-3650 的数字" }, 400);
    }
    const to = Date.now() + body.extend_days * 86_400_000;
    token.expires_at = to;
    if (token.base_expires_at) token.base_expires_at = to;
    changed = true;
    // 已过期被延期 = 恢复使用：翻转回 active 并推送授权刷新，节点白名单立即加回；
    // revoked 通常对应滥用/退款，必须带显式 reactivate 才恢复
    if (token.status === "expired" || (token.status === "revoked" && body.reactivate === true)) {
      token.status = "active";
      c.executionCtx.waitUntil(pushAuthRefresh(c.env));
    }
  }
  if (body.clear_share_suspension === true && token.share_suspended_at) {
    delete token.share_suspended_at;
    delete token.share_conn_strikes;
    changed = true;
    // 误伤救济：立即恢复授权，节点白名单加回
    c.executionCtx.waitUntil(pushAuthRefresh(c.env));
  }
  if (body.clear_sub_bindings === true) {
    // 绑定存 presence（不在 token 主键）：有绑定清掉才算变更，无绑定视为 nothing to update
    if (await clearSubBindings(c.env, token.uuid)) changed = true;
  }
  if (!changed) return c.json({ ok: false, error: "nothing to update" }, 400);

  await saveToken(c.env, token);
  return c.json({
    ok: true,
    data: {
      id: token.id,
      status: token.status,
      max_devices: token.max_devices,
      expires_at: token.expires_at,
      share_suspended_at: token.share_suspended_at,
    },
  });
});
