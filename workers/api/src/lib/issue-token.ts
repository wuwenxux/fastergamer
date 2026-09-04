/**
 * 确认收款后发放 token（易支付回调自动触发，或推广全额抵扣的
 * 0 元订单下单即触发；两者共用 fulfillOrder）
 */
import { KV, type Order, type Plan, type Token } from "../../../../shared/types";
import { isEmail, sendMail, sendTokenEmail, shouldSendEmail } from "./email-aliyun";
import { createMagicTicket } from "./accounts";
import { deleteDeviceIndex, getPlans, getTokenById, saveOrder, saveToken } from "./kv";
import { newTokenId } from "./ids";
import { currentMonthKey } from "./nodes";
import { rewardReferrerOnPayment } from "./referral";
import { pushAuthRefresh } from "./authpush";
import type { Env } from "../types";

/** 只需要 waitUntil，用最小结构类型兼容 Hono 与 workers-types 的 ExecutionContext 差异 */
export interface WaitUntilCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export const issueTokenForOrder = async (
  env: Env,
  ctx: WaitUntilCtx,
  order: Order,
  plan: Plan
): Promise<Token> => {
  const token: Token = {
    id: newTokenId(),
    uuid: crypto.randomUUID(),
    plan_id: plan.id,
    status: "paid", // 已购买、待激活；用户点击「激活」后才开始计时
    contact: order.contact,
    traffic_limit_gb: plan.traffic_limit_gb ?? 0,
    traffic_used_gb: 0,
    purchased_at: Date.now(),
  };
  await saveToken(env, token);

  // 如果联系方式是邮箱，自动发送凭证邮件（附带一次性免登录管理链接，免去手动登录）
  if (shouldSendEmail(order.contact)) {
    ctx.waitUntil(
      (async () => {
        const site = (env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
        const ticket = await createMagicTicket(env, order.contact!, token.id);
        await sendTokenEmail(env, {
          tokenId: token.id,
          uuid: token.uuid,
          planName: plan.name,
          status: "paid", // 发货即 paid，激活后才开始计时
          contact: order.contact!,
          magicUrl: `${site}/auth/magic?ticket=${ticket}`,
        });
      })()
    );
  }

  return token;
};

/**
 * 升级订单发货：支付成功后升级既有 token（保留 id/uuid/设备槽位）。
 * 套餐、流量上限、设备上限换新；有效期从升级时刻按新套餐时长重计；
 * 流量记账清零（offset 基准对齐当前 Xray 累计值），月度配额账期重置。
 */
export const upgradeTokenForOrder = async (
  env: Env,
  ctx: WaitUntilCtx,
  order: Order,
  plan: Plan
): Promise<Token> => {
  const token = await getTokenById(env, order.upgrade_token_id!);
  if (!token) throw new Error(`upgrade token '${order.upgrade_token_id}' not found`);

  const now = Date.now();
  token.plan_id = plan.id;
  token.traffic_limit_gb = plan.traffic_limit_gb ?? 0;
  token.max_devices = plan.max_devices;
  if (!token.activated_at) token.activated_at = now;
  token.expires_at = now + plan.duration_days * 86_400_000;
  if (plan.monthly_quota_gb) {
    token.base_expires_at = token.expires_at;
    token.months_borrowed = 0;
    token.month_used_bytes = 0;
    token.month_key = currentMonthKey();
  } else {
    delete token.base_expires_at;
    delete token.months_borrowed;
    delete token.month_used_bytes;
    delete token.month_key;
  }
  // 新套餐流量从零重计（Xray 计数器不可清零，用 offset 对齐基准）
  token.traffic_offset_bytes = Object.values(token.traffic_by_node ?? {}).reduce((s, v) => s + v, 0);
  token.traffic_used_gb = 0;
  delete token.rate_window_start;
  delete token.rate_window_bytes;
  delete token.traffic_exhausted_at;
  if (token.status !== "revoked") token.status = "active";
  // 流量类提醒升级后可重新触发
  if (token.notify_log) {
    delete token.notify_log.traffic_80;
    delete token.notify_log.exhausted;
    delete token.notify_log.traffic_spike;
  }
  await saveToken(env, token);

  if (shouldSendEmail(order.contact)) {
    ctx.waitUntil(
      sendMail(
        env,
        order.contact!,
        "【GameBoost】套餐升级成功",
        `<p>你好，你的 Token（<strong>${token.id}</strong>）已升级为 <strong>${plan.name}</strong>。</p>
         <p>新有效期至 <strong>${new Date(token.expires_at!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</strong>，流量额度已重置为满额。订阅链接与设备保持不变，无需重新配置。</p>`,
        `你的 Token（${token.id}）已升级为 ${plan.name}。新有效期至 ${new Date(token.expires_at!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}，流量已重置为满额。订阅链接与设备不变。`
      )
    );
  }
  return token;
};

/** 发货锁 TTL（秒）：兜底自动清理，进程崩溃也不会留下永久锁 */
const ORDER_LOCK_TTL_SEC = 60;
/** 锁的拦截窗口（毫秒）：窗口内的并发/接连触发直接拒绝，让调用方稍后重试 */
const ORDER_LOCK_BLOCK_MS = 30_000;

export interface FulfillResult {
  token: Token | null;
  /** true = 订单此前已发过货（幂等重放或竞态 loser），本次未产生新的有效 token */
  already: boolean;
  /** true = 另一路发货正在进行（发货锁未过期），调用方应稍后重试（确认接口回 409，支付宝回调回 failure） */
  busy?: boolean;
}

/**
 * 订单发货：确认收款后置 paid 并发放 token（幂等——已 paid 直接返回已有 token）。
 * 管理后台手动确认与支付宝回调共用此入口；plan 缺失时抛错，由调用方兜底。
 *
 * 免费层 best-effort 幂等说明：
 * CF KV 跨 PoP 有最长约 60s 读延迟，「读 order.status === "paid"」只是快照判断，
 * 挡不住支付宝回调与管理员确认并发/接连触发造成的重复发货。这里用两道防线：
 * 1) 入口写 orderlock:{orderId} 锁，拦截最常见的秒级并发（双击确认、支付宝快速重推）；
 *    KV 无 CAS，锁本身不保证原子，只缩小窗口。
 * 2) 发货后 cacheTtl:0 绕过缓存重读订单对账，发现并发胜者的 token 时清理本次发的
 *    游离 token，保证同订单最终只有一个有效 token。
 * 彻底原子化需要 Workers 付费版 + Durable Object 把发货串行化；
 * 届时只需替换 acquireOrderLock / reconcileFulfillment 两处实现，对外签名不变。
 */
export const fulfillOrder = async (
  env: Env,
  ctx: WaitUntilCtx,
  order: Order
): Promise<FulfillResult> => {
  if (order.status === "paid") {
    const token = order.token_id ? await getTokenById(env, order.token_id) : null;
    return { token, already: true };
  }

  // 防线 1：发货锁。已存在且未过拦截窗口 → 拒绝，让调用方稍后重试
  if (await isOrderLocked(env, order.id)) {
    return { token: null, already: false, busy: true };
  }

  const plans = await getPlans(env);
  const plan = plans.find((p) => p.id === order.plan_id);
  if (!plan) throw new Error(`plan '${order.plan_id}' not found`);

  // 升级订单：支付成功后升级既有 token（uuid/设备不变），而非新发货。
  // 升级不新造 token，竞态 loser 只是重复升级同一 token（幂等），无需游离 token 对账。
  if (order.upgrade_token_id) {
    const upgraded = await upgradeTokenForOrder(env, ctx, order, plan);
    order.status = "paid";
    order.token_id = upgraded.id;
    order.paid_at = Date.now();
    await saveOrder(env, order);
    ctx.waitUntil(pushAuthRefresh(env)); // 配额/状态变化立即同步各节点
    return { token: upgraded, already: false };
  }

  const token = await issueTokenForOrder(env, ctx, order, plan);
  order.status = "paid";
  order.token_id = token.id;
  order.paid_at = Date.now();
  await saveOrder(env, order);

  // 防线 2：发货后对账自愈。订单上 token_id 指向别人且那个 token 真实存在 →
  // 本次是竞态 loser（锁因 KV 读延迟没拦住）：清理刚发的游离 token，返回胜者的 token。
  // 注意：loser 的凭证邮件可能已通过 waitUntil 发出，无法撤回；对账只能保证 KV 数据收敛，
  // 这也是免费层 best-effort 的已知边界。
  const winner = await reconcileFulfillment(env, order.id, token);
  if (winner) {
    await cleanupIssuedToken(env, token);
    // 游离 token 从未进入 active 状态，不在节点授权名单内，无需 pushAuthRefresh
    return { token: winner, already: true };
  }

  // 推广结算：被邀请人首次付费成功，给邀请人结算余额（可能触发自动续期）。
  // 0 元订单（全额抵扣）不算付费，不结算返佣。
  // 续期可能复活已过期 token → 授权名单有变，结算完成后补一次推送（不能与本路径其他推送
  // 并行，否则快照重建可能赶在续期写库之前，漏掉复活）
  if (order.contact && (order.payable_cny ?? plan.price_cny) > 0) {
    ctx.waitUntil(
      rewardReferrerOnPayment(env, order.contact.trim().toLowerCase()).then((authChanged) =>
        authChanged ? pushAuthRefresh(env) : undefined
      )
    );
  }

  return { token, already: false };
};

/**
 * 发货锁：orderlock:{orderId}（TOKENS namespace，值 { at }，TTL 60s）。
 * 锁存在且距现在 < 30s → 返回 true（拒绝）；否则（重新）写锁并放行。
 */
const isOrderLocked = async (env: Env, orderId: string): Promise<boolean> => {
  const key = KV.ORDER_LOCK + orderId;
  const now = Date.now();
  const raw = await env.TOKENS.get(key);
  if (raw) {
    let at = 0;
    try {
      at = (JSON.parse(raw) as { at?: number }).at ?? 0;
    } catch {
      /* 锁值损坏视为无锁 */
    }
    if (now - at < ORDER_LOCK_BLOCK_MS) return true;
  }
  await env.TOKENS.put(key, JSON.stringify({ at: now }), { expirationTtl: ORDER_LOCK_TTL_SEC });
  return false;
};

/**
 * 发货后对账：cacheTtl:0 绕过边缘缓存重读订单，核对 token_id 是不是本次发的。
 * 指向别的 token 且那个 token 真实存在 → 返回胜者的 token（本次是竞态 loser）；
 * 读不到订单或胜者 token 不存在（对账不可判定）→ 返回 null，按正常发货处理，避免误删。
 */
const reconcileFulfillment = async (
  env: Env,
  orderId: string,
  issued: Token
): Promise<Token | null> => {
  const raw = await env.ORDERS.get(KV.ORDER + orderId, { cacheTtl: 0 });
  if (!raw) return null;
  const fresh = JSON.parse(raw) as Order;
  if (!fresh.token_id || fresh.token_id === issued.id) return null;
  return getTokenById(env, fresh.token_id);
};

/**
 * 清理竞态 loser 刚发放的游离 token。
 * 清理范围对齐 admin.ts 删除 token 的逻辑：主键、id 反查、presence、设备索引、试用领取标记。
 */
const cleanupIssuedToken = async (env: Env, token: Token): Promise<void> => {
  await env.TOKENS.delete(KV.TOKEN + token.uuid);
  await env.TOKENS.delete(KV.TOKEN_BY_ID + token.id);
  await env.TOKENS.delete(KV.PRESENCE + token.uuid);
  for (const d of token.devices ?? []) await deleteDeviceIndex(env, d.uuid);
  if (token.contact && isEmail(token.contact)) {
    await env.TOKENS.delete(KV.TRIAL + token.contact.trim().toLowerCase());
  }
};
