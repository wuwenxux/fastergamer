import { Hono } from "hono";
import type { Device, Token } from "../../../../shared/types";
import { deleteDeviceIndex, getPlans, getTokenById, listTokensByContact, saveDeviceIndex, saveToken } from "../lib/kv";
import { sendMail, shouldSendEmail } from "../lib/email-aliyun";
import { currentMonthKey } from "../lib/nodes";
import type { Env } from "../types";

export const tokensRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/tokens/recover —— 凭联系方式找回 token
 * 返回匹配的 token 列表（不含 uuid，只返回 id/status/有效期等概要）
 */
tokensRoutes.post("/recover", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { contact?: string } | null;
  const contact = body?.contact?.trim();
  if (!contact) {
    return c.json({ ok: false, error: "联系方式不能为空" }, 400);
  }

  const tokens = await listTokensByContact(c.env, contact);
  if (tokens.length === 0) {
    return c.json({ ok: false, error: "未找到与该联系方式关联的 token" }, 404);
  }

  const data = tokens.map((t) => ({
    id: t.id,
    status: t.status,
    plan_id: t.plan_id,
    purchased_at: t.purchased_at,
    activated_at: t.activated_at,
    expires_at: t.expires_at,
    traffic_limit_gb: t.traffic_limit_gb,
    traffic_used_gb: t.traffic_used_gb,
    contact: t.contact,
  }));
  return c.json({ ok: true, data });
});

/** GET /api/tokens/:id —— 查询 token 详情（含 UUID 与有效期） */
tokensRoutes.get("/:id", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  return c.json({ ok: true, data: token });
});

/**
 * POST /api/tokens/login-link —— 免密登录链接
 * 输入购买邮箱，把带 token ID 的管理页链接发到邮箱（点击即进入，免输 token）。
 * 安全考量：完整 token（含 uuid）绝不能凭邮箱直接返回，必须经邮箱所有权验证，
 * 所以固定返回 ok，不泄露该邮箱是否注册过。
 */
tokensRoutes.post("/login-link", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { contact?: string } | null;
  const contact = body?.contact?.trim().toLowerCase() ?? "";
  if (!shouldSendEmail(contact)) {
    return c.json({ ok: false, error: "请输入有效的邮箱地址" }, 400);
  }

  const tokens = await listTokensByContact(c.env, contact);
  if (tokens.length > 0) {
    const site = (c.env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
    const items = tokens
      .map((t) => {
        const url = `${site}/tokens?id=${t.id}`;
        const statusLabel =
          t.status === "active" ? "使用中" : t.status === "paid" ? "待激活" : t.status === "expired" ? "已过期" : "已撤销";
        const expiry = t.expires_at ? `（有效期至 ${new Date(t.expires_at).toLocaleString("zh-CN")}）` : "";
        return { url, label: `${t.id} · ${statusLabel}${expiry}` };
      });
    const html = `
      <p>你好，点击以下链接即可进入你的 Token 管理页（查看订阅链接、设备与用量）：</p>
      ${items.map((i) => `<p style="margin:12px 0;"><a href="${i.url}" style="color:#0ea5e9;">${i.label}</a></p>`).join("")}
      <p style="color:#64748b;font-size:13px;">如果这不是你本人的操作，请忽略本邮件。链接即凭证，请勿转发给他人。</p>`.trim();
    const text = `点击以下链接进入你的 Token 管理页：\n\n${items.map((i) => `${i.label}\n${i.url}`).join("\n\n")}\n\n如非本人操作请忽略。链接即凭证，请勿转发。`;
    const res = await sendMail(c.env, contact, "【GameBoost】你的 Token 登录链接", html, text);
    if (!res.ok) console.error(`[login-link] mail failed for ${contact}: ${res.error}`);
  }
  return c.json({ ok: true });
});

/**
 * POST /api/tokens/:id/activate —— 激活 token，开始计时
 * 仅 paid 状态可激活；已激活且未过期时幂等返回。
 * 已过期不可重新激活（防止免费续期），撤销不可恢复。
 */
tokensRoutes.post("/:id/activate", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  if (token.status === "revoked") {
    return c.json({ ok: false, error: "token has been revoked" }, 403);
  }

  const now = Date.now();
  // 已激活且在有效期内 → 幂等返回
  if (token.status === "active" && token.expires_at && token.expires_at > now) {
    return c.json({ ok: true, data: token });
  }
  // 已过期（含 active 但有效期已过）→ 拒绝，引导购买新套餐
  if (token.status === "expired" || token.status === "active") {
    return c.json({ ok: false, error: "token 已过期，请购买新套餐" }, 403);
  }

  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === token.plan_id);
  const durationDays = plan?.duration_days ?? 30;

  const activated: Token = {
    ...token,
    status: "active",
    activated_at: now,
    expires_at: now + durationDays * 86_400_000,
  };
  // 月度配额制初始化：记录原始到期时间作为预支扣减基准
  if (plan?.monthly_quota_gb) {
    activated.base_expires_at = activated.expires_at;
    activated.months_borrowed = 0;
    activated.month_used_bytes = 0;
    activated.month_key = currentMonthKey();
  }
  await saveToken(c.env, activated);
  return c.json({ ok: true, data: activated });
});

/**
 * POST /api/tokens/:id/devices —— 绑定新设备（生成独立 uuid 用于 per-device 审计）
 * body: { name: "我的 iPhone" }
 * 上限：plan.max_devices（缺省 2，含主设备），即主 uuid + 最多 max-1 个设备槽位
 */
tokensRoutes.post("/:id/devices", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as { name?: string } | null;
  const name = body?.name?.trim() ?? "";
  if (!name || name.length > 30) {
    return c.json({ ok: false, error: "设备名称必填，最长 30 字" }, 400);
  }

  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === token.plan_id);
  const maxDevices = plan?.max_devices ?? 2;
  const current = 1 + (token.devices?.length ?? 0); // 主设备 + 已绑定槽位
  if (current >= maxDevices) {
    return c.json(
      { ok: false, error: `该套餐最多绑定 ${maxDevices} 台设备，请先移除不用的设备` },
      409
    );
  }

  const device: Device = {
    id: `dv_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    uuid: crypto.randomUUID(),
    name,
    traffic_used_gb: 0,
    created_at: Date.now(),
  };
  token.devices = [...(token.devices ?? []), device];
  await saveToken(c.env, token);
  await saveDeviceIndex(c.env, device.uuid, token.id);
  return c.json({ ok: true, data: device });
});

/** DELETE /api/tokens/:id/devices/:deviceId —— 解绑设备（uuid 立即失效） */
tokensRoutes.delete("/:id/devices/:deviceId", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  const deviceId = c.req.param("deviceId");
  const device = token.devices?.find((d) => d.id === deviceId);
  if (!device) return c.json({ ok: false, error: "device not found" }, 404);

  token.devices = (token.devices ?? []).filter((d) => d.id !== deviceId);
  await saveToken(c.env, token);
  await deleteDeviceIndex(c.env, device.uuid);
  return c.json({ ok: true, data: { id: deviceId } });
});
