import { Hono } from "hono";
import { isTrialPlan, KV } from "../../../../../shared/types";
import type { Order, Presence, Token } from "../../../../../shared/types";
import { deleteTokenCascade, getTokenPresence, listKeys, listTickets, mapBatched, mergeTokenSettlement, saveOrder, savePresenceIfChanged } from "../../lib/kv";
import { sendExpire24hEmail, sendTrialConvertEmail } from "../../lib/risk-notify";
import { claimNotification, releaseNotification } from "../../lib/notify-dedup";
import { pushAuthRefresh } from "../../lib/authpush";
import type { Env } from "../../types";

export const adminNotifyScanRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/admin/notify-claim —— 运维工具：手动认领/释放通知幂等键。
 * 用途：notify_log → DO 认领的一次性迁移、人工压制某类通知（body: {key, release?}）。
 */
adminNotifyScanRoutes.post("/notify-claim", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { key?: string; release?: boolean } | null;
  if (!body?.key) return c.json({ ok: false, error: "missing key" }, 400);
  if (body.release) {
    await releaseNotification(c.env, body.key);
    return c.json({ ok: true, data: { released: body.key } });
  }
  const claimed = await claimNotification(c.env, body.key);
  return c.json({ ok: true, data: { key: body.key, claimed } });
});

/**
 * POST /api/admin/notify-scan —— 定时风险扫描（cron 每 15 分钟调用）
 * 做五件事：清理过期 90 天的 token 与已结工单；
 * 清理超 5 天未激活的免费体验 token（白嫖/假邮箱垃圾）；
 * 试用 token 到期翻转 expired 时发一次性转化邮件（同 token 充值引导，存量不补发）；
 * 付费 token 进入到期前 24 小时窗口时发一次性续费提醒（免登录续费按钮，幂等键 expire_24h）；
 * 超 3 天仍 pending 的订单自动取消（用户放弃支付，抵扣在发货时才扣、取消无需归还）。
 * （节点失联告警由 probe-nodes.sh 主动探测承担，agent 事件驱动后 last_seen 不再可靠）
 */
adminNotifyScanRoutes.post("/notify-scan", async (c) => {
  const now = Date.now();
  const RETENTION_MS = 90 * 86_400_000;
  const EXPIRE_REMIND_MS = 24 * 3_600_000;

  const keys = await listKeys(c.env.TOKENS, KV.TOKEN);
  // 全表扫的瓶颈是 N 次串行 get：分批并发读回（只读，任意并发安全），
  // 处理段（写库/邮件/presence 清扫）保持原有串行语义不变
  const tokenRaws = await mapBatched(keys, (k) => c.env.TOKENS.get(k.name));
  let scanned = 0;
  let notified = 0;
  let purgedTokens = 0;
  let expiredNow = 0;
  for (const raw of tokenRaws) {
    if (!raw) continue;
    const token = JSON.parse(raw) as Token;

    // 未激活的免费体验 token 超 5 天：白嫖/假邮箱留下的垃圾（永远不会激活，90 天规则扫不到
    // paid 状态），直接清掉。trial 领取标记保留——该邮箱仍算已领过，防同址反复领取
    if (
      isTrialPlan(token.plan_id) &&
      token.status === "paid" &&
      (token.purchased_at ?? 0) > 0 &&
      (token.purchased_at ?? 0) < now - 5 * 86_400_000
    ) {
      await deleteTokenCascade(c.env, token);
      purgedTokens++;
      continue;
    }

    // 过期/撤销满 90 天：删除主键 + id 索引 + presence + 全部设备索引。
    // 试用 token 同样适用——转正激励锚定邮箱的试用标记（trial:{email}），token 清掉
    // 不影响「邮箱随时付费继续用 + 首次付费送 30 天」（标记永存，见 issue-token.ts）
    const endAt = token.expires_at ?? token.purchased_at ?? 0;
    if (
      (token.status === "expired" || token.status === "revoked") &&
      endAt > 0 &&
      endAt < now - RETENTION_MS
    ) {
      await deleteTokenCascade(c.env, token, { devices: true });
      purgedTokens++;
      continue;
    }

    scanned++;

    // active 但已过有效期：置 expired，否则永远留在 KV 且状态失真。
    // 重读-合并写，只覆盖 status，不覆盖结算路径并发更新的其他字段
    if (token.status === "active" && token.expires_at && token.expires_at < now) {
      token.status = "expired";
      // 试用到期：发一次性转化邮件（同 token 充值引导 + 转正激励），dedup 键
      // trial_convert:{token.id} 只在此翻转分支发送——存量已 expired 的试用 token 不补发
      if (isTrialPlan(token.plan_id)) {
        await sendTrialConvertEmail(c.env, token);
      }
      await mergeTokenSettlement(c.env, token.uuid, { status: "expired" });
      expiredNow++;
      continue;
    }

    // 付费 token 进入到期前 24 小时窗口：发一次性续费提醒（dedup 键 expire_24h:{token.id}）。
    // 试用 token 不参与——它走 trial_convert 转化邮件
    if (
      token.status === "active" &&
      !isTrialPlan(token.plan_id) &&
      token.expires_at &&
      token.expires_at > now &&
      token.expires_at < now + EXPIRE_REMIND_MS
    ) {
      if (await sendExpire24hEmail(c.env, token)) {
        notified++;
      }
    }

    // 在线状态清扫：Xray 只在用户在线时才有 online 计数器，离线即消失，
    // 所以离线靠这里的窗口过期来判定。窗口与 agent 结算节奏对齐（30 分钟兜底上报 + 富余）。
    // 在线状态存 presence:{uuid}（键缺失时回退 token 旧字段），有变化才写。
    // 只扫 active token：paid/expired/revoked 不可能在线（不在授权名单），
    // 省掉每轮 96 次/天 × 非活跃 token 数的 presence 读——这是读配额最大单一消耗。
    // 代价：刚翻转 expired 的 token presence.online 标志可能残留 true（时间戳照样过期），
    // 无消费者关心非活跃 token 的在线标志，可接受
    if (token.status !== "active") continue;
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

  // 超 3 天仍 pending 的订单自动取消：收款码过渡方案下用户可能下单后放弃支付，
  // 订单永久挂 pending 会拖累管理端列表与「我已支付」接口。推广抵扣在发货成功时才扣，
  // 取消时本来就没占额度，无需归还。订单量小，读同样走并发批读
  const PENDING_ORDER_TTL_MS = 3 * 86_400_000;
  let cancelledOrders = 0;
  const orderKeys = await listKeys(c.env.ORDERS, KV.ORDER);
  const orderRaws = await mapBatched(orderKeys, (k) => c.env.ORDERS.get(k.name));
  for (const raw of orderRaws) {
    if (!raw) continue;
    const order = JSON.parse(raw) as Order;
    if (order.status !== "pending" || order.created_at >= now - PENDING_ORDER_TTL_MS) continue;
    order.status = "failed";
    // Order 类型定义在 shared/（本次改动范围仅限 workers/api），用交叉类型补取消原因字段
    (order as Order & { cancel_reason?: string }).cancel_reason = "pending 超 3 天未支付，系统自动取消";
    await saveOrder(c.env, order);
    cancelledOrders++;
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
      cancelled_orders: cancelledOrders,
    },
  });
});
