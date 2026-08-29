import { Hono } from "hono";
import { KV } from "../../../../shared/types";
import type { Order, Plan, Token } from "../../../../shared/types";
import { adminAuth } from "../middleware/admin";
import { deleteDeviceIndex, deleteTokenByUuid, getOrder, getPlans, getTicket, getTokenById, listKeys, listOrders, listTickets, listTokensByContact, saveOrder, savePlans, saveTicket, saveToken } from "../lib/kv";
import { checkExpiringToken, notifyAdmin } from "../lib/risk-notify";
import { getNodes } from "../lib/nodes";
import { sendMail, shouldSendEmail } from "../lib/email-aliyun";
import { fulfillOrder, type WaitUntilCtx } from "../lib/issue-token";
import { restoreCredit } from "../lib/referral";
import { withinTrafficAllowance } from "../lib/authsnapshot";
import { pushAuthRefresh } from "../lib/authpush";
import type { Env } from "../types";

export const adminRoutes = new Hono<{ Bindings: Env }>();
adminRoutes.use("*", adminAuth);

export const QR_NAMES = new Set(["alipay"]);

/**
 * PUT /api/admin/qr/:name —— 上传收款码图片（仅 alipay）
 * body 为图片二进制（png/jpeg，≤2MB），存 KV，由 GET /api/qr/:name 对外供图
 */
adminRoutes.put("/qr/:name", async (c) => {
  const name = c.req.param("name");
  if (!QR_NAMES.has(name)) {
    return c.json({ ok: false, error: "name must be alipay or wechat" }, 400);
  }
  const buf = await c.req.arrayBuffer();
  if (!buf.byteLength) return c.json({ ok: false, error: "empty body" }, 400);
  if (buf.byteLength > 2 * 1024 * 1024) {
    return c.json({ ok: false, error: "image too large (max 2MB)" }, 413);
  }
  // 校验 PNG / JPEG 魔数
  const head = new Uint8Array(buf.slice(0, 4));
  const isPng = head[0] === 0x89 && head[1] === 0x50;
  const isJpg = head[0] === 0xff && head[1] === 0xd8;
  if (!isPng && !isJpg) {
    return c.json({ ok: false, error: "only png or jpeg images" }, 415);
  }
  const contentType = isPng ? "image/png" : "image/jpeg";
  await c.env.PLANS.put(KV.QR + name, buf, { metadata: { contentType } });
  return c.json({ ok: true, data: { name, bytes: buf.byteLength } });
});

/** 默认套餐（可通过请求体覆盖，见 /api/admin/seed） */
const DEFAULT_PLANS: Plan[] = [
  {
    id: "plan_3days",
    pitch: "先试用，好用再买",
    name: "30 天免费体验",
    duration_days: 30,
    price_cny: 0,
    traffic_limit_gb: 20,
    max_devices: 1,
    tag: "新用户体验",
    description: "30 天免费体验，20 GB 总流量，1 台设备（首页免费领取，不出售）",
    features: [
        "20 GB 流量",
        "1 台设备",
        "全部节点可用",
      ],
  },
  {
    id: "plan_monthly",
    pitch: "一个人的日常加速",
    name: "月付套餐",
    duration_days: 30,
    price_cny: 12,
    traffic_limit_gb: 20,
    max_devices: 2,
    tag: "个人轻量",
    description: "30 天有效，20 GB 总流量，2 台设备",
    features: [
        "20 GB / 30 天",
        "2 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_quarterly",
    pitch: "手机电脑同时在线",
    name: "季付套餐",
    duration_days: 90,
    price_cny: 30,
    traffic_limit_gb: 60,
    max_devices: 3,
    tag: "个人常用",
    description: "90 天有效，60 GB 总流量，3 台设备",
    features: [
        "60 GB / 90 天",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_yearly",
    pitch: "全家用一年，最划算",
    name: "年付套餐",
    duration_days: 365,
    price_cny: 120,
    traffic_limit_gb: 240,
    max_devices: 5,
    monthly_quota_gb: 20,
    tag: "家庭多设备",
    description: "一年有效，每月 20GB（用超预支下月，有效期提前），5 台设备",
    features: [
        "每月 20 GB",
        "5 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_yearly_renew",
    pitch: "老用户续一年，省 20 元",
    name: "年付续费",
    duration_days: 365,
    price_cny: 100,
    traffic_limit_gb: 240,
    max_devices: 5,
    monthly_quota_gb: 20,
    tag: "老用户优惠",
    description: "连续包年，每月 20GB（用超预支下月，有效期提前），5 台设备",
    features: [
        "每月 20 GB",
        "5 台设备",
        "年付到期续费专用",
      ],
  },
  {
    id: "plan_biz_yearly",
    pitch: "10~20 人团队，流量不限量",
    name: "企业年付",
    duration_days: 365,
    price_cny: 588,
    traffic_limit_gb: 0,
    max_devices: 20,
    tag: "企业团队",
    description: "不限量流量（公平使用），20 台设备，共享节点池",
    features: [
        "流量不限量",
        "20 台设备",
        "500 Mbps 共享节点",
        "故障自动切换",
      ],
  },
  {
    id: "plan_biz_dedicated",
    pitch: "独享节点，晚高峰也稳",
    name: "企业专用节点",
    duration_days: 365,
    price_cny: 988,
    traffic_limit_gb: 0,
    max_devices: 30,
    tag: "确定性首选",
    description: "不限量流量（公平使用），30 台设备，独享一台专用节点",
    features: [
        "流量不限量",
        "30 台设备",
        "500 Mbps 独享节点",
        "故障自动回落共享池",
      ],
  },
];

/**
 * GET /api/admin/plans —— 查看当前套餐列表
 */
adminRoutes.get("/plans", async (c) => {
  const plans = await getPlans(c.env);
  return c.json({ ok: true, data: plans });
});

/**
 * POST /api/admin/seed —— 初始化套餐数据
 * 请求体可选：{ "plans": [...] }，省略则写入默认套餐
 */
adminRoutes.post("/seed", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { plans?: Plan[] } | null;
  const plans = body?.plans?.length ? body.plans : DEFAULT_PLANS;
  await savePlans(c.env, plans);
  return c.json({ ok: true, data: { count: plans.length, plans } });
});

/**
 * GET /api/admin/xray-clients —— 返回当前允许接入的 token UUID 列表（active、未过期、流量在额度或宽限期内）
 * 供 VPS 上的 Xray 同步脚本拉取使用
 * query raw=1 时只返回每行一个 UUID 的纯文本，方便 shell 处理
 */
adminRoutes.get("/xray-clients", async (c) => {
  const keys = await listKeys(c.env.TOKENS, KV.TOKEN);
  const now = Date.now();
  const uuids: string[] = [];
  for (const key of keys) {
    const raw = await c.env.TOKENS.get(key.name);
    if (!raw) continue;
    const token = JSON.parse(raw) as Token;
    if (
      token.status === "active" &&
      (token.expires_at ?? 0) > now &&
      withinTrafficAllowance(token, now)
    ) {
      uuids.push(token.uuid);
      for (const d of token.devices ?? []) uuids.push(d.uuid);
    }
  }

  if (c.req.query("raw") === "1") {
    return c.text(uuids.join("\n"), 200, { "content-type": "text/plain" });
  }
  return c.json({ ok: true, data: { count: uuids.length, uuids } });
});

/** GET /api/admin/tokens —— 列出所有 token（含流量、在线状态） */
adminRoutes.get("/tokens", async (c) => {
  const keys = await listKeys(c.env.TOKENS, KV.TOKEN);
  const tokens: Token[] = [];
  for (const key of keys) {
    const raw = await c.env.TOKENS.get(key.name);
    if (raw) tokens.push(JSON.parse(raw) as Token);
  }
  tokens.sort((a, b) => (b.purchased_at ?? 0) - (a.purchased_at ?? 0));
  return c.json({ ok: true, data: tokens });
});

/**
 * POST /api/admin/tokens/:id/reset-penalty —— 重置续用（流量耗尽后的售后处置）
 * 用量清零、剩余流量恢复满额，服务恢复；代价仅为有效期 -30 天（可用 body 覆盖天数）。
 * 记账用 offset 基准（Xray 计数器不可清零），重置后上报只计增量。
 * body 可选：{ days_penalty?: number }
 */
adminRoutes.post("/tokens/:id/reset-penalty", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    days_penalty?: number;
  } | null;
  const daysPenalty = body?.days_penalty ?? 30;

  const now = Date.now();
  // 以当前 Xray 累计值为新基准，用量从零重计（上限不变，剩余恢复满额）
  token.traffic_offset_bytes = Object.values(token.traffic_by_node ?? {}).reduce((s, v) => s + v, 0);
  token.traffic_used_gb = 0;
  delete token.rate_window_start;
  delete token.rate_window_bytes;
  delete token.traffic_exhausted_at;

  if (token.expires_at) {
    token.expires_at -= daysPenalty * 86_400_000;
  }

  // 重置后重新评估状态：未撤销且仍在有效期则恢复 active
  if (token.status !== "revoked") {
    token.status = (token.expires_at ?? Infinity) > now ? "active" : "expired";
    if (!token.activated_at) token.activated_at = now;
  }
  // 流量类提醒重置后可重新触发
  if (token.notify_log) {
    delete token.notify_log.traffic_80;
    delete token.notify_log.exhausted;
    delete token.notify_log.traffic_spike;
  }

  await saveToken(c.env, token);
  // 用量清零/状态恢复属于授权变更：推送节点更新配额基数与名单
  c.executionCtx.waitUntil(pushAuthRefresh(c.env));

  // 通知客户重置结果
  if (shouldSendEmail(token.contact)) {
    const res = await sendMail(
      c.env,
      token.contact,
      "【GameBoost】你的流量额度已重置",
      `<p>你好，你的 Token（<strong>${token.id}</strong>）流量已重置为满额 <strong>${token.traffic_limit_gb} GB</strong>，服务已恢复。</p>
       <p>本次重置后有效期至 <strong>${token.expires_at ? new Date(token.expires_at).toLocaleString("zh-CN") : "未知"}</strong>（提前 ${daysPenalty} 天）。</p>
       <p>如流量消耗异常，请登录管理页检查设备列表。</p>`,
      `你的 Token（${token.id}）流量已重置为满额 ${token.traffic_limit_gb} GB，服务已恢复。\n有效期至 ${token.expires_at ? new Date(token.expires_at).toLocaleString("zh-CN") : "未知"}（提前 ${daysPenalty} 天）。\n如流量消耗异常请检查设备列表。`
    );
    if (!res.ok) console.error(`[reset-penalty] mail failed ${token.id}: ${res.error}`);
  }

  return c.json({ ok: true, data: token });
});

/** DELETE /api/admin/tokens/:id —— 删除指定 token（测试清理用） */
adminRoutes.delete("/tokens/:id", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  await c.env.TOKENS.delete(KV.TOKEN + token.uuid);
  await c.env.TOKENS.delete(KV.TOKEN_BY_ID + token.id);
  return c.json({ ok: true });
});

/**
 * POST /api/admin/alert —— 中心巡检脚本上报可用性告警，转发到管理员邮箱
 * body: { title: string, message: string }（message 按纯文本转义展示）
 */
adminRoutes.post("/alert", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { title?: string; message?: string }
    | null;
  if (!body?.title?.trim() || !body?.message?.trim()) {
    return c.json({ ok: false, error: "title and message are required" }, 400);
  }
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const title = body.title.trim().slice(0, 80);
  const message = body.message.trim().slice(0, 4000);
  await notifyAdmin(
    c.env,
    title,
    `<pre style="white-space: pre-wrap; font-size: 13px;">${esc(message)}</pre>`,
    message
  );
  return c.json({ ok: true });
});

/**
 * POST /api/admin/tokens/:id/rotate-uuid —— 重置 token 的连接凭证（UUID）
 * 用于泄露处置：旧 UUID 立即从 KV 删除，各节点 agent 下一轮同步（≤30s）后旧凭证全节点失效，
 * 等同于"断开所有正在使用该凭证的设备"；客户更新订阅即可获得新凭证。
 * 套餐、到期时间、已用流量、Token ID 均保持不变。
 */
adminRoutes.post("/tokens/:id/rotate-uuid", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  const oldUuid = token.uuid;
  token.uuid = crypto.randomUUID();
  // 重置凭证后旧的多设备标记/在线状态失去意义，一并清掉
  delete token.multi_device_detected_at;
  delete token.online_by_node;
  token.online = false;
  delete token.notify_log?.multi_device;

  await deleteTokenByUuid(c.env, oldUuid);
  await saveToken(c.env, token);
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 旧 uuid 立即失效、新 uuid 立即生效
  return c.json({ ok: true, data: { id: token.id, uuid: token.uuid } });
});

/**
 * POST /api/admin/notify-scan —— 定时风险扫描（cron 每 15 分钟调用）
 * 做两件事：24h 内到期提醒；清理过期 90 天的 token 与已结工单
 * （节点失联告警由 probe-nodes.sh 主动探测承担，agent 事件驱动后 last_seen 不再可靠）
 */
adminRoutes.post("/notify-scan", async (c) => {
  const now = Date.now();
  const RETENTION_MS = 90 * 86_400_000;

  const keys = await listKeys(c.env.TOKENS, KV.TOKEN);
  let scanned = 0;
  let notified = 0;
  let purgedTokens = 0;
  for (const key of keys) {
    const raw = await c.env.TOKENS.get(key.name);
    if (!raw) continue;
    const token = JSON.parse(raw) as Token;

    // 过期/撤销满 90 天：删除主键 + id 索引 + 全部设备索引
    const endAt = token.expires_at ?? token.purchased_at ?? 0;
    if (
      (token.status === "expired" || token.status === "revoked") &&
      endAt > 0 &&
      endAt < now - RETENTION_MS
    ) {
      await c.env.TOKENS.delete(KV.TOKEN + token.uuid);
      await c.env.TOKENS.delete(KV.TOKEN_BY_ID + token.id);
      for (const d of token.devices ?? []) await deleteDeviceIndex(c.env, d.uuid);
      purgedTokens++;
      continue;
    }

    scanned++;

    // 在线状态清扫：Xray 只在用户在线时才有 online 计数器，离线即消失，
    // 所以离线靠这里的窗口过期来判定。窗口与 agent 结算节奏对齐（30 分钟兜底上报 + 富余）。
    const ONLINE_WINDOW_MS = 40 * 60_000;
    if (token.online || Object.keys(token.online_by_node ?? {}).length > 0) {
      const activeNodes = Object.entries(token.online_by_node ?? {}).filter(
        ([, ts]) => ts > now - ONLINE_WINDOW_MS
      );
      const stillOnline = activeNodes.length > 0;
      if (!stillOnline || activeNodes.length !== Object.keys(token.online_by_node ?? {}).length) {
        token.online_by_node = Object.fromEntries(activeNodes);
        if (token.online && !stillOnline) token.online = false;
        await saveToken(c.env, token);
      }
    }

    const before = token.notify_log?.expire_24h;
    await checkExpiringToken(c.env, token);
    if (token.notify_log?.expire_24h && token.notify_log.expire_24h !== before) {
      await saveToken(c.env, token);
      notified++;
    }
  }

  // 已结工单满 90 天清理；沉淀为 FAQ 的保留
  let purgedTickets = 0;
  for (const t of await listTickets(c.env)) {
    const closedAt = t.replied_at ?? t.created_at;
    if (t.status === "closed" && !t.publish_faq && closedAt < now - RETENTION_MS) {
      await c.env.TICKETS.delete(KV.TICKET + t.id);
      purgedTickets++;
    }
  }

  return c.json({
    ok: true,
    data: { scanned, notified, purged_tokens: purgedTokens, purged_tickets: purgedTickets },
  });
});

/**
 * POST /api/admin/alert —— 通用管理员告警入口
 * 供本机运维脚本（如节点可达性探测）触发邮件告警
 * body: { title: string, text: string }
 */
adminRoutes.post("/alert", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { title?: string; text?: string } | null;
  const title = body?.title?.trim();
  const text = body?.text?.trim();
  if (!title || !text) return c.json({ ok: false, error: "title and text are required" }, 400);
  if (title.length > 200 || text.length > 2000) {
    return c.json({ ok: false, error: "title/text too long" }, 400);
  }
  await notifyAdmin(c.env, title, `<p>${text.replace(/</g, "&lt;")}</p>`, text);
  return c.json({ ok: true });
});

/**
 * GET /api/admin/customers?contact=xx@yy.com —— 按邮箱查客户 token
 * 用于客服售后：收到 support@ 来信后先查发件人是否有 token，只回复真实客户
 */
adminRoutes.get("/customers", async (c) => {
  const contact = c.req.query("contact")?.trim();
  if (!contact) return c.json({ ok: false, error: "contact is required" }, 400);
  const tokens = await listTokensByContact(c.env, contact);
  return c.json({ ok: true, data: tokens });
});

/** GET /api/admin/orders —— 列出所有订单（含联系方式） */
adminRoutes.get("/orders", async (c) => {
  const orders = await listOrders(c.env);
  return c.json({ ok: true, data: orders });
});

/** 确认收款并发货（POST 接口与邮件一键确认链接共用）；幂等：已 paid 直接返回已发放 token */
async function confirmOrderPaid(
  env: Env,
  ctx: WaitUntilCtx,
  id: string
): Promise<{ http: 200; order: Order; token: Token | null; already?: boolean } | { http: 404 | 409 | 500; error: string }> {
  const order = await getOrder(env, id);
  if (!order) return { http: 404, error: "order not found" };
  if (order.status === "failed") return { http: 409, error: "order has been cancelled" };
  try {
    const result = await fulfillOrder(env, ctx, order);
    // 发货产生新 token（或续期），授权名单有变：推送节点立即刷新；幂等重放不重复推
    if (!result.already) ctx.waitUntil(pushAuthRefresh(env));
    return { http: 200, order, token: result.token, already: result.already || undefined };
  } catch (e) {
    return { http: 500, error: (e as Error).message };
  }
}

/**
 * POST /api/admin/orders/:id/confirm —— 确认订单已收款，发放 token
 * 幂等：已 paid 的订单直接返回已发放的 token，不会重复发放
 */
adminRoutes.post("/orders/:id/confirm", async (c) => {
  const r = await confirmOrderPaid(c.env, c.executionCtx, c.req.param("id"));
  if ("error" in r) return c.json({ ok: false, error: r.error }, r.http);
  return c.json({ ok: true, data: { order: r.order, token: r.token, already: r.already } });
});

/**
 * GET /api/admin/orders/:id/confirm?key=... —— 邮件里的一键确认链接（浏览器直接打开）
 * 与 POST 等效，返回简单结果页
 */
adminRoutes.get("/orders/:id/confirm", async (c) => {
  const r = await confirmOrderPaid(c.env, c.executionCtx, c.req.param("id"));
  const msg = "error" in r
    ? `操作失败：${r.error}`
    : r.already
      ? `订单 ${r.order.id} 此前已确认过，token 已发放（未重复发货）`
      : `订单 ${r.order.id} 已确认收款，token 已发放并邮件通知买家`;
  const ok = !("error" in r);
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center">` +
      `<h2>${ok ? "✅" : "❌"} ${msg}</h2><p style="color:#888">本页可关闭</p></body>`,
    "error" in r ? r.http : 200
  );
});

/** POST /api/admin/orders/:id/cancel —— 取消未支付的订单（无效/刷单订单清理），已用的推广额度归还 */
adminRoutes.post("/orders/:id/cancel", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  if (order.status === "paid") {
    return c.json({ ok: false, error: "paid order cannot be cancelled" }, 409);
  }
  order.status = "failed";
  await saveOrder(c.env, order);
  if (order.discount_cny && order.contact) {
    await restoreCredit(c.env, order.contact.trim().toLowerCase(), order.discount_cny);
  }
  return c.json({ ok: true, data: order });
});

/** GET /api/admin/tickets?status=open —— 列出反馈工单（默认全部，可按状态过滤） */
adminRoutes.get("/tickets", async (c) => {
  const status = c.req.query("status");
  let tickets = await listTickets(c.env);
  if (status) tickets = tickets.filter((t) => t.status === status);
  return c.json({ ok: true, data: tickets });
});

/**
 * POST /api/admin/tickets/:id/reply —— 回复工单并邮件通知用户
 * body: { reply: string, publish_faq?: boolean, close?: boolean }
 * publish_faq=true 时该问答会出现在公开 /api/faq，沉淀给后来的新用户
 */
adminRoutes.post("/tickets/:id/reply", async (c) => {
  const ticket = await getTicket(c.env, c.req.param("id"));
  if (!ticket) return c.json({ ok: false, error: "ticket not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    reply?: string;
    publish_faq?: boolean;
    close?: boolean;
  } | null;
  const reply = body?.reply?.trim() ?? "";
  if (reply.length < 2 || reply.length > 4000) {
    return c.json({ ok: false, error: "reply 需 2-4000 字" }, 400);
  }

  const res = await sendMail(
    c.env,
    ticket.contact,
    `【GameBoost】你的反馈已有回复（${ticket.id}）`,
    `<p>你好，你之前反馈的问题已有回复：</p>
     <div style="padding:16px;background:#f0f9ff;border-radius:8px;margin:16px 0;">${escapeHtml(reply).replace(/\n/g, "<br>")}</div>
     <p style="color:#64748b;font-size:13px;">你的原始问题：${escapeHtml(ticket.message.slice(0, 500))}</p>
     <p style="color:#64748b;font-size:13px;">如问题仍未解决，可直接回复本邮件继续咨询。</p>`,
    `你之前反馈的问题已有回复：\n\n${reply}\n\n---\n你的原始问题：${ticket.message.slice(0, 500)}\n如问题仍未解决，可直接回复本邮件继续咨询。`
  );
  if (!res.ok) {
    return c.json({ ok: false, error: `邮件发送失败：${res.error}` }, 502);
  }

  ticket.reply = reply;
  ticket.replied_at = Date.now();
  ticket.status = body?.close === false ? "replied" : "closed";
  if (body?.publish_faq) ticket.publish_faq = true;
  await saveTicket(c.env, ticket);
  return c.json({ ok: true, data: ticket });
});

/** POST /api/admin/tickets/:id/close —— 不回复直接关闭工单 */
adminRoutes.post("/tickets/:id/close", async (c) => {
  const ticket = await getTicket(c.env, c.req.param("id"));
  if (!ticket) return c.json({ ok: false, error: "ticket not found" }, 404);
  ticket.status = "closed";
  await saveTicket(c.env, ticket);
  return c.json({ ok: true, data: { id: ticket.id, status: ticket.status } });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
