import { Hono } from "hono";
import { KV } from "../../../../shared/types";
import type { Device, Token } from "../../../../shared/types";
import { deleteDeviceIndex, getPlans, getTokenById, getTokenPresence, listTokensByContact, rotateTokenUuid, saveDeviceIndex, saveToken } from "../lib/kv";
import { isEmail, sendMail, sendTokenEmail, shouldSendEmail } from "../lib/email-aliyun";
import { createMagicTicket, consumeMagicTicket, createSession, getSessionAccount } from "../lib/accounts";
import { recordReferral } from "../lib/referral";
import { newTokenId } from "../lib/ids";
import { activatePaidToken } from "../lib/activate";
import { pushAuthRefresh } from "../lib/authpush";
import type { Env } from "../types";

export const tokensRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/tokens/trial —— 新用户免费体验：每个邮箱限领一次 30 天体验 token
 * 以 paid 状态发放（激活或首次导入订阅后才计时），凭证发到邮箱，
 * 响应只回 token 短 ID，不含 uuid。
 */
tokensRoutes.post("/trial", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { email?: string; ref?: string } | null;
  const email = body?.email?.trim().toLowerCase() ?? "";
  const refCode = body?.ref?.trim().toLowerCase() ?? "";
  if (!isEmail(email)) {
    return c.json({ ok: false, error: "请填写真实可用的邮箱，体验凭证通过邮件发送" }, 400);
  }

  const markerKey = KV.TRIAL + email;
  if (await c.env.TOKENS.get(markerKey)) {
    return c.json({ ok: false, error: "该邮箱已领取过免费体验" }, 409);
  }

  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === "plan_3days");
  const token: Token = {
    id: newTokenId(),
    uuid: crypto.randomUUID(),
    plan_id: plan?.id ?? "plan_3days",
    status: "paid", // 待激活，点击「激活」后开始计时
    contact: email,
    traffic_limit_gb: plan?.traffic_limit_gb ?? 20,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
  };
  await saveToken(c.env, token);
  await c.env.TOKENS.put(
    markerKey,
    JSON.stringify({ token_id: token.id, created_at: Date.now() })
  );

  // 推广归因：只记录待结算标记，被邀请人首次付费成功（订单发货）时才给邀请人结算余额
  if (refCode) {
    c.executionCtx.waitUntil(
      (async () => {
        const referrer = await recordReferral(c.env, refCode, email);
        if (referrer) console.log(`[referral] pending: ${email} ← ${referrer}`);
      })()
    );
  }

  c.executionCtx.waitUntil(
    (async () => {
      const site = (c.env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
      const ticket = await createMagicTicket(c.env, email, token.id);
      await sendTokenEmail(c.env, {
        tokenId: token.id,
        uuid: token.uuid,
        planName: plan?.name ?? "30 天免费体验",
        status: "paid",
        contact: email,
        magicUrl: `${site}/auth/magic?ticket=${ticket}`,
      });
    })()
  );

  return c.json({ ok: true, data: { token_id: token.id } }, 201);
});

/**
 * 非本人可见的概要：剥离 uuid、设备、计费内部字段与联系方式。
 * uuid 是连接凭证，只对登录账号且邮箱匹配 token.contact 的本人返回。
 */
const toSummary = (token: Token) => ({
  id: token.id,
  status: token.status,
  plan_id: token.plan_id,
  purchased_at: token.purchased_at,
  activated_at: token.activated_at,
  expires_at: token.expires_at,
  traffic_limit_gb: token.traffic_limit_gb,
  traffic_used_gb: token.traffic_used_gb,
  month_used_bytes: token.month_used_bytes,
  online: token.online,
  restricted: true as const,
});

/** 是否本人：登录账号邮箱与 token 购买邮箱一致 */
const isOwner = async (
  env: Env,
  authHeader: string | undefined,
  token: Token
): Promise<boolean> => {
  const account = await getSessionAccount(env, authHeader);
  return !!account && !!token.contact && account.email === token.contact.trim().toLowerCase();
};

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

/** GET /api/tokens/:id —— 查询 token；本人（登录账号邮箱=购买邮箱）返回完整信息，否则只返回概要 */
tokensRoutes.get("/:id", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  // 在线状态/最近活跃/接入 IP 统计等高频字段已拆到 presence:{uuid}，合并进响应视图
  // （presence 键缺失时 getTokenPresence 回退 token 旧字段，存量数据兼容）
  const view = { ...token, ...(await getTokenPresence(c.env, token)) };
  const owner = await isOwner(c.env, c.req.header("authorization"), token);
  return c.json({ ok: true, data: owner ? view : toSummary(view) });
});

/**
 * POST /api/tokens/login-link —— 发送免密登录链接（magic link）
 * 输入购买邮箱，把一次性登录链接发到邮箱（点开即登录进入管理页）。
 * 安全考量：链接带一次性 ticket（15 分钟有效、用后即焚），完整 token（含 uuid）
 * 只在登录后的 session 下返回。固定返回 ok，不泄露该邮箱是否购买过。
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
    const items = await Promise.all(
      tokens.map(async (t) => {
        const ticket = await createMagicTicket(c.env, contact, t.id);
        const url = `${site}/auth/magic?ticket=${ticket}`;
        const statusLabel =
          t.status === "active" ? "使用中" : t.status === "paid" ? "待激活" : t.status === "expired" ? "已过期" : "已撤销";
        const expiry = t.expires_at ? `（有效期至 ${new Date(t.expires_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}）` : "";
        return { url, label: `${t.id} · ${statusLabel}${expiry}` };
      })
    );
    const html = `
      <p>你好，点击以下链接即可直接登录并进入你的 Token 管理页（查看订阅链接、设备与用量）：</p>
      ${items.map((i) => `<p style="margin:12px 0;"><a href="${i.url}" style="color:#0ea5e9;">${i.label}</a></p>`).join("")}
      <p style="color:#64748b;font-size:13px;">链接 15 分钟内有效、用一次即失效。如果这不是你本人的操作，请忽略本邮件；链接即登录凭证，请勿转发给他人。</p>`.trim();
    const text = `点击以下链接直接登录你的 Token 管理页：\n\n${items.map((i) => `${i.label}\n${i.url}`).join("\n\n")}\n\n链接 15 分钟内有效、用一次即失效。如非本人操作请忽略。`;
    const res = await sendMail(c.env, contact, "【GameBoost】一键登录链接", html, text);
    if (!res.ok) console.error(`[login-link] mail failed for ${contact}: ${res.error}`);
  }
  return c.json({ ok: true });
});

/**
 * GET /api/tokens/magic/consume?ticket=xxx —— 核销一次性 ticket，换取 30 天 session
 * ticket 无论成功与否都会立即焚毁（防重放）
 */
tokensRoutes.get("/magic/consume", async (c) => {
  const ticket = c.req.query("ticket") ?? "";
  const data = await consumeMagicTicket(c.env, ticket);
  if (!data) {
    return c.json({ ok: false, error: "登录链接已失效（过期或已被使用），请重新获取" }, 401);
  }
  const sessionToken = await createSession(c.env, data.email);
  return c.json({
    ok: true,
    data: { session_token: sessionToken, email: data.email, token_id: data.token_id },
  });
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
    const owner = await isOwner(c.env, c.req.header("authorization"), token);
    return c.json({ ok: true, data: owner ? token : toSummary(token) });
  }
  // 已过期（含 active 但有效期已过）→ 拒绝，引导购买新套餐
  if (token.status === "expired" || token.status === "active") {
    return c.json({ ok: false, error: "token 已过期，请购买新套餐" }, 403);
  }

  const activated = await activatePaidToken(c.env, token);
  // 新激活的 uuid 需要立刻进各节点白名单：推送事件刷新，不等兜底轮询
  c.executionCtx.waitUntil(pushAuthRefresh(c.env));
  const owner = await isOwner(c.env, c.req.header("authorization"), activated);
  return c.json({ ok: true, data: owner ? activated : toSummary(activated) });
});

/**
 * POST /api/tokens/:id/devices —— 绑定新设备（生成独立 uuid 用于 per-device 审计）
 * 仅本人可操作（会生成新凭证，必须登录账号）
 * body: { name: "我的 iPhone" }
 * 上限：plan.max_devices（缺省 2，含主设备），即主 uuid + 最多 max-1 个设备槽位
 */
tokensRoutes.post("/:id/devices", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  if (!(await isOwner(c.env, c.req.header("authorization"), token))) {
    return c.json({ ok: false, error: "请先通过邮箱登录链接进入后再管理设备" }, 401);
  }

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
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 新设备 uuid 立即进白名单
  return c.json({ ok: true, data: device });
});

/** DELETE /api/tokens/:id/devices/:deviceId —— 解绑设备（uuid 立即失效），仅本人可操作 */
tokensRoutes.delete("/:id/devices/:deviceId", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  if (!(await isOwner(c.env, c.req.header("authorization"), token))) {
    return c.json({ ok: false, error: "请先通过邮箱登录链接进入后再管理设备" }, 401);
  }

  const deviceId = c.req.param("deviceId");
  const device = token.devices?.find((d) => d.id === deviceId);
  if (!device) return c.json({ ok: false, error: "device not found" }, 404);

  token.devices = (token.devices ?? []).filter((d) => d.id !== deviceId);
  await saveToken(c.env, token);
  await deleteDeviceIndex(c.env, device.uuid);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 解绑的设备 uuid 立即从白名单摘除
  return c.json({ ok: true, data: { id: deviceId } });
});

/**
 * POST /api/tokens/:id/rotate-uuid —— 免费重新生成订阅链接（每个 token 限一次）
 * 仅本人可操作。旧 UUID 立即从全节点失效；套餐、到期时间、已用流量不变。
 * 用于订阅域名迁移、链接泄露等自助场景，免找售后人工 rotate。
 */
tokensRoutes.post("/:id/rotate-uuid", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  if (!(await isOwner(c.env, c.req.header("authorization"), token))) {
    return c.json({ ok: false, error: "请先通过邮箱登录链接进入后再操作" }, 401);
  }
  if (token.rotated_at) {
    return c.json({ ok: false, error: "该 Token 已用过免费重新生成，如需再次更换请联系售后" }, 409);
  }

  token.rotated_at = Date.now();
  await rotateTokenUuid(c.env, token);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 旧 uuid 立即失效、新 uuid 立即生效
  return c.json({ ok: true, data: { id: token.id, uuid: token.uuid } });
});

const IPV4_RE = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^(?=.*:)[0-9a-fA-F:]+$/;

/**
 * 封禁 IP 的格式校验（简单校验，不做完整 IPv6 语法解析）：
 * IPv4 四段各 0-255；IPv6 仅限合法字符、至少含一个冒号与一个十六进制位、不允许连续三个冒号。
 */
export const isValidIp = (ip: string): boolean => {
  if (IPV4_RE.test(ip)) return true;
  return IPV6_RE.test(ip) && /[0-9a-fA-F]/.test(ip) && !/:::/.test(ip);
};

/**
 * POST /api/tokens/:id/blocked-ips —— 封禁接入 IP（30 秒内全节点生效），仅本人可操作
 * body: { ip: "1.2.3.4" }
 * 语义：仅「该用户从该 IP 的接入」被拒（节点 xray 路由 per-(uuid, IP) 阻断），
 * 同 NAT/同宽带出口下的其他用户不受影响。旧版 agent 仍是整节点防火墙阻断，逐步淘汰。
 */
tokensRoutes.post("/:id/blocked-ips", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  if (!(await isOwner(c.env, c.req.header("authorization"), token))) {
    return c.json({ ok: false, error: "请先通过邮箱登录链接进入后再封禁 IP" }, 401);
  }

  const body = (await c.req.json().catch(() => null)) as { ip?: string } | null;
  const ip = body?.ip?.trim() ?? "";
  if (!isValidIp(ip)) {
    return c.json({ ok: false, error: "IP 格式不正确" }, 400);
  }

  token.blocked_ips = token.blocked_ips ?? [];
  if (!token.blocked_ips.includes(ip)) {
    if (token.blocked_ips.length >= 50) {
      return c.json({ ok: false, error: "封禁列表已满（50 条），请先解除不再需要的条目" }, 409);
    }
    token.blocked_ips.push(ip);
    await saveToken(c.env, token);
    c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 封禁 IP 立即下发各节点防火墙
  }
  return c.json({ ok: true, data: { blocked_ips: token.blocked_ips } });
});

/** DELETE /api/tokens/:id/blocked-ips/:ip —— 解除封禁，仅本人可操作 */
tokensRoutes.delete("/:id/blocked-ips/:ip", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  if (!(await isOwner(c.env, c.req.header("authorization"), token))) {
    return c.json({ ok: false, error: "请先通过邮箱登录链接进入后再操作" }, 401);
  }

  const ip = c.req.param("ip");
  token.blocked_ips = (token.blocked_ips ?? []).filter((x) => x !== ip);
  await saveToken(c.env, token);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 解封同样立即下发
  return c.json({ ok: true, data: { blocked_ips: token.blocked_ips } });
});
