import { Hono } from "hono";
import { KV } from "../../../../shared/types";
import type { Plan, Presence, Registration, Token } from "../../../../shared/types";
import { adminAuth } from "../middleware/admin";
import { deleteDeviceIndex, deleteTokenByUuid, getOrder, getPlans, getTicket, getTokenById, getTokenPresence, listKeys, listOrders, listTickets, listTokensByContact, mergeTokenSettlement, rotateTokenUuid, saveOrder, savePlans, savePresenceIfChanged, saveTicket, saveToken } from "../lib/kv";
import { checkExpiringToken, notifyAdmin } from "../lib/risk-notify";
import { getNodes } from "../lib/nodes";
import { isEmail, sendMail, shouldSendEmail } from "../lib/email-aliyun";
import { getEpayConfig, refundEpayOrder } from "../lib/epay";
import { computeRefundQuote } from "../lib/refund";
import { resetPenalty } from "../lib/reset-penalty";
import { restoreCredit } from "../lib/referral";
import { withinTrafficAllowance } from "../lib/authsnapshot";
import { pushAuthRefresh } from "../lib/authpush";
import { escapeHtml } from "../lib/escape-html";
import type { Env } from "../types";

export const adminRoutes = new Hono<{ Bindings: Env }>();
adminRoutes.use("*", adminAuth);

/** 默认套餐（可通过请求体覆盖，见 /api/admin/seed） */
const DEFAULT_PLANS: Plan[] = [
  {
    id: "plan_3days",
    pitch: "先试用，好用再买",
    name: "3 天免费体验",
    duration_days: 3,
    price_cny: 0,
    traffic_limit_gb: 20,
    max_devices: 1,
    tag: "新用户体验",
    description: "3 天免费体验，20 GB 总流量，1 台设备（首页免费领取，不出售）",
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
    monthly_quota_gb: 20,
    tag: "个人常用",
    description: "90 天有效，每月 20GB（用超预支下月，有效期提前），3 台设备",
    features: [
        "每月 20 GB",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_yearly",
    pitch: "买 12 个月送 1 个月，最划算",
    name: "年付套餐",
    duration_days: 395,
    bonus_days: 30,
    price_cny: 120,
    traffic_limit_gb: 260,
    monthly_quota_gb: 20,
    max_devices: 3,
    tag: "家庭多设备",
    description: "13 个月有效（买一年送一月），每月 20GB（用超预支下月，有效期提前），3 台设备",
    features: [
        "每月 20 GB",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_yearly_renew",
    pitch: "老用户续一年，省 20 元",
    name: "年付续费",
    duration_days: 395,
    bonus_days: 30,
    price_cny: 100,
    traffic_limit_gb: 260,
    monthly_quota_gb: 20,
    max_devices: 3,
    tag: "老用户优惠",
    description: "连续包年 13 个月（买一年送一月），每月 20GB（用超预支下月，有效期提前），3 台设备",
    features: [
        "每月 20 GB",
        "3 台设备",
        "年付到期续费专用",
      ],
  },
  {
    id: "plan_yearly_plus",
    pitch: "大流量随便用，5 台设备",
    name: "年付大流量",
    duration_days: 365,
    price_cny: 199,
    traffic_limit_gb: 480,
    monthly_quota_gb: 40,
    max_devices: 5,
    tag: "大流量多设备",
    description: "一年有效，每月 40GB（用超预支下月，有效期提前），5 台设备",
    features: [
        "每月 40 GB",
        "5 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_biz_yearly",
    pitch: "10~20 人团队，流量不限量",
    name: "企业年付",
    duration_days: 365,
    price_cny: 998,
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
    pitch: "独享 VPS 大带宽，性能到顶",
    name: "企业专用节点",
    duration_days: 365,
    price_cny: 1988,
    traffic_limit_gb: 0,
    max_devices: 30,
    tag: "顶尖旗舰",
    description: "不限量流量（公平使用），30 台设备，独享 VPS 大带宽专用节点",
    features: [
        "流量不限量",
        "30 台设备",
        "大带宽独享 VPS（≥500 Mbps）",
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

/** GET /api/admin/registrations —— 导出全部防失联登记（批量通知用） */
adminRoutes.get("/registrations", async (c) => {
  const keys = await listKeys(c.env.TOKENS, KV.REG);
  const regs: Registration[] = [];
  for (const key of keys) {
    const raw = await c.env.TOKENS.get(key.name);
    if (!raw) continue;
    try {
      regs.push(JSON.parse(raw) as Registration);
    } catch {
      // 跳过坏数据
    }
  }
  regs.sort((a, b) => b.updated_at - a.updated_at);
  return c.json({ ok: true, data: regs });
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

  await resetPenalty(c.env, token, daysPenalty);
  // 用量清零/状态恢复属于授权变更：推送节点更新配额基数与名单
  c.executionCtx.waitUntil(pushAuthRefresh(c.env));

  // 通知客户重置结果
  if (shouldSendEmail(token.contact)) {
    const res = await sendMail(
      c.env,
      token.contact,
      "【GameBoost】你的流量额度已重置",
      `<p>你好，你的 Token（<strong>${token.id}</strong>）流量已重置为满额 <strong>${token.traffic_limit_gb} GB</strong>，服务已恢复。</p>
       <p>本次重置后有效期至 <strong>${token.expires_at ? new Date(token.expires_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未知"}</strong>（提前 ${daysPenalty} 天）。</p>
       <p>如流量消耗异常，请登录管理页检查设备列表。</p>`,
      `你的 Token（${token.id}）流量已重置为满额 ${token.traffic_limit_gb} GB，服务已恢复。\n有效期至 ${token.expires_at ? new Date(token.expires_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未知"}（提前 ${daysPenalty} 天）。\n如流量消耗异常请检查设备列表。`
    );
    if (!res.ok) console.error(`[reset-penalty] mail failed ${token.id}: ${res.error}`);
  }

  return c.json({ ok: true, data: token });
});

/**
 * POST /api/admin/orders/:id/refund —— 订单退款（售后）
 * 默认折算（lib/refund.ts）：月付按剩余天数退；季付/年付扣当月退剩余整月，
 * 促销赠送月不参与折算，消耗进入赠送期则无可退余额。
 * body 可传 { money } 覆盖为指定金额（不超过实付）。
 * 调易支付退款接口原路退回，成功后撤销对应 token。
 * 需在商户后台开启「订单退款API接口开关」；已退过的订单幂等拒绝。
 */
adminRoutes.post("/orders/:id/refund", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  if (order.refunded_at) {
    return c.json({ ok: false, error: "该订单已退款" }, 409);
  }
  if (order.status !== "paid") {
    return c.json({ ok: false, error: "只有已支付订单可退款" }, 400);
  }

  const plans = await getPlans(c.env);
  const plan = plans.find((p) => p.id === order.plan_id);
  const paid = order.payable_cny ?? plan?.price_cny ?? 0;
  if (paid <= 0) {
    return c.json({ ok: false, error: "0 元订单无需退款，直接撤销 token 即可" }, 400);
  }

  // 默认折算：月付按剩余天数退，季付/年付扣当月、赠送月不参与；body.money 可人工覆盖
  const body = (await c.req.json().catch(() => null)) as { money?: number } | null;
  const quote = computeRefundQuote(plan, paid, order.paid_at ?? order.created_at);
  const amount =
    body?.money !== undefined && Number.isFinite(body.money)
      ? Math.min(Math.max(body.money, 0), paid)
      : quote.amount;
  if (amount <= 0) {
    const detail =
      quote.basis === "days"
        ? `剩余可退 ${quote.daysRemaining} 天`
        : `已用 ${quote.monthsUsed}/${quote.totalMonths} 个付费月`;
    return c.json(
      { ok: false, error: `扣除已消耗费用后无可退余额（${detail}）；如需特殊处理请传 body.money 指定金额` },
      400
    );
  }
  const money = amount.toFixed(2);

  const epay = getEpayConfig(c.env);
  if (!epay) {
    return c.json({ ok: false, error: "易支付未配置" }, 503);
  }

  let refundNo: string | undefined;
  try {
    const r = await refundEpayOrder(epay, {
      tradeNo: order.trade_no,
      outTradeNo: order.id,
      money,
      outRefundNo: order.id, // 防重复退款
    });
    refundNo = r.refundNo;
  } catch (e) {
    console.error(`[refund] order ${order.id}: ${(e as Error).message}`);
    return c.json({ ok: false, error: "退款失败，请查看日志或稍后再试" }, 502);
  }

  order.refunded_at = Date.now();
  order.refund_no = refundNo;
  await saveOrder(c.env, order);

  // 撤销该订单发放的 token（含升级订单的原 token）
  if (order.token_id) {
    const token = await getTokenById(c.env, order.token_id);
    if (token && token.status !== "revoked") {
      token.status = "revoked";
      await saveToken(c.env, token);
    }
  }
  c.executionCtx.waitUntil(pushAuthRefresh(c.env)); // 撤销立即从各节点白名单摘除

  if (shouldSendEmail(order.contact)) {
    // 人工覆盖金额时不带折算明细（quote 的手续费只适用于默认折算）
    const breakdown =
      body?.money !== undefined
        ? `实付 ${paid.toFixed(2)} 元`
        : `实付 ${paid.toFixed(2)} 元，扣除已消耗费用与 1% 退款手续费（按实付总额计，${quote.fee.toFixed(2)} 元）后折算`;
    const res = await sendMail(
      c.env,
      order.contact,
      "【GameBoost】订单退款成功",
      `<p>你好，订单 <strong>${order.id}</strong> 已退款 <strong>${money} 元</strong>（${breakdown}），原路退回支付账户。</p>
       <p>对应服务已停用。如有疑问请回复本邮件联系售后。</p>`,
      `订单 ${order.id} 已退款 ${money} 元（${breakdown}），原路退回。对应服务已停用。`
    );
    if (!res.ok) console.error(`[refund] mail failed ${order.id}: ${res.error}`);
  }

  return c.json({ ok: true, data: { order_id: order.id, refund_no: refundNo, money, paid: paid.toFixed(2), quote } });
});

/** DELETE /api/admin/tokens/:id —— 删除指定 token（测试清理用） */
adminRoutes.delete("/tokens/:id", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);
  await c.env.TOKENS.delete(KV.TOKEN + token.uuid);
  await c.env.TOKENS.delete(KV.TOKEN_BY_ID + token.id);
  await c.env.TOKENS.delete(KV.PRESENCE + token.uuid);
  // 清设备反查索引与试用领取标记，避免残留脏数据
  for (const d of token.devices ?? []) await deleteDeviceIndex(c.env, d.uuid);
  if (token.contact && isEmail(token.contact)) {
    await c.env.TOKENS.delete(KV.TRIAL + token.contact.trim().toLowerCase());
  }
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
adminRoutes.post("/tokens/:id/rotate-uuid", async (c) => {
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
adminRoutes.delete("/tokens/:id/devices/:deviceId", async (c) => {
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
 * body: { max_devices?: number, extend_days?: number }
 * - max_devices：token 级设备上限，覆盖套餐值（不影响同套餐其他用户）
 * - extend_days：有效期设为 当前时间 + N 天（base_expires_at 同步；months_borrowed 不动）
 */
adminRoutes.put("/tokens/:id", async (c) => {
  const token = await getTokenById(c.env, c.req.param("id"));
  if (!token) return c.json({ ok: false, error: "token not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    max_devices?: number;
    extend_days?: number;
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
  }
  if (!changed) return c.json({ ok: false, error: "nothing to update" }, 400);

  await saveToken(c.env, token);
  return c.json({
    ok: true,
    data: { id: token.id, max_devices: token.max_devices, expires_at: token.expires_at },
  });
});

/**
 * POST /api/admin/notify-scan —— 定时风险扫描（cron 每 15 分钟调用）
 * 做三件事：24h 内到期提醒；清理过期 90 天的 token 与已结工单；
 * 清理超 3 天未激活的免费体验 token（白嫖/假邮箱垃圾）
 * （节点失联告警由 probe-nodes.sh 主动探测承担，agent 事件驱动后 last_seen 不再可靠）
 */
adminRoutes.post("/notify-scan", async (c) => {
  const now = Date.now();
  const RETENTION_MS = 90 * 86_400_000;

  const keys = await listKeys(c.env.TOKENS, KV.TOKEN);
  let scanned = 0;
  let notified = 0;
  let purgedTokens = 0;
  let expiredNow = 0;
  for (const key of keys) {
    const raw = await c.env.TOKENS.get(key.name);
    if (!raw) continue;
    const token = JSON.parse(raw) as Token;

    // 未激活的免费体验 token 超 3 天：白嫖/假邮箱留下的垃圾（永远不会激活，90 天规则扫不到
    // paid 状态），直接清掉。trial 领取标记保留——该邮箱仍算已领过，防同址反复领取
    if (
      token.plan_id === "plan_3days" &&
      token.status === "paid" &&
      (token.purchased_at ?? 0) > 0 &&
      (token.purchased_at ?? 0) < now - 3 * 86_400_000
    ) {
      await c.env.TOKENS.delete(KV.TOKEN + token.uuid);
      await c.env.TOKENS.delete(KV.TOKEN_BY_ID + token.id);
      await c.env.TOKENS.delete(KV.PRESENCE + token.uuid);
      purgedTokens++;
      continue;
    }

    // 过期/撤销满 90 天：删除主键 + id 索引 + presence + 全部设备索引
    const endAt = token.expires_at ?? token.purchased_at ?? 0;
    if (
      (token.status === "expired" || token.status === "revoked") &&
      endAt > 0 &&
      endAt < now - RETENTION_MS
    ) {
      await c.env.TOKENS.delete(KV.TOKEN + token.uuid);
      await c.env.TOKENS.delete(KV.TOKEN_BY_ID + token.id);
      await c.env.TOKENS.delete(KV.PRESENCE + token.uuid);
      for (const d of token.devices ?? []) await deleteDeviceIndex(c.env, d.uuid);
      purgedTokens++;
      continue;
    }

    scanned++;

    // active 但已过有效期：置 expired，否则永远留在 KV 且状态失真。
    // 重读-合并写，只覆盖 status，不覆盖结算路径并发更新的其他字段
    if (token.status === "active" && token.expires_at && token.expires_at < now) {
      token.status = "expired";
      await mergeTokenSettlement(c.env, token.uuid, { status: "expired" });
      expiredNow++;
      continue;
    }

    // 在线状态清扫：Xray 只在用户在线时才有 online 计数器，离线即消失，
    // 所以离线靠这里的窗口过期来判定。窗口与 agent 结算节奏对齐（30 分钟兜底上报 + 富余）。
    // 在线状态存 presence:{uuid}（键缺失时回退 token 旧字段），有变化才写。
    const ONLINE_WINDOW_MS = 40 * 60_000;
    const presence = await getTokenPresence(c.env, token);
    const presenceBase: Presence = JSON.parse(JSON.stringify(presence));
    if (presence.online || Object.keys(presence.online_by_node ?? {}).length > 0) {
      const activeNodes = Object.entries(presence.online_by_node ?? {}).filter(
        ([, ts]) => ts > now - ONLINE_WINDOW_MS
      );
      const stillOnline = activeNodes.length > 0;
      if (!stillOnline || activeNodes.length !== Object.keys(presence.online_by_node ?? {}).length) {
        presence.online_by_node = Object.fromEntries(activeNodes);
        if (presence.online && !stillOnline) presence.online = false;
      }
    }
    await savePresenceIfChanged(c.env, token.uuid, presenceBase, presence);

    const before = token.notify_log?.expire_24h;
    await checkExpiringToken(c.env, token);
    if (token.notify_log?.expire_24h && token.notify_log.expire_24h !== before) {
      // 只键级合并 notify_log，不整写 token（结算路径可能正在并发更新流量字段）
      await mergeTokenSettlement(c.env, token.uuid, { notify_log: token.notify_log });
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

  // 有 token 过期转换：授权名单有变，推送节点立即刷新
  if (expiredNow > 0) c.executionCtx.waitUntil(pushAuthRefresh(c.env));

  return c.json({
    ok: true,
    data: {
      scanned,
      notified,
      expired_tokens: expiredNow,
      purged_tokens: purgedTokens,
      purged_tickets: purgedTickets,
    },
  });
});

/**
 * POST /api/admin/alert —— 通用管理员告警入口
 * 供本机运维脚本（probe-nodes.sh 节点可达性探测）触发邮件告警
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

/** POST /api/admin/orders/:id/cancel —— 取消未支付的订单（无效/刷单订单清理），已用的推广额度归还 */
adminRoutes.post("/orders/:id/cancel", async (c) => {
  const order = await getOrder(c.env, c.req.param("id"));
  if (!order) return c.json({ ok: false, error: "order not found" }, 404);
  if (order.status === "paid") {
    return c.json({ ok: false, error: "paid order cannot be cancelled" }, 409);
  }
  if (order.status !== "pending") {
    // failed 订单已取消过：拦截重复 cancel，防止 restoreCredit 重复刷余额
    return c.json({ ok: false, error: "订单已取消过" }, 409);
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

