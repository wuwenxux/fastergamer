/**
 * 确认收款后发放 token。触发路径：0 元订单/免费升级在下单瞬间直接 fulfillOrder；
 * 人工收款码过渡方案下，站长经 POST /api/admin/orders/:id/paid 确认收款也会走到这里。
 * 发货锁（isOrderLocked）与对账（reconcileFulfillment/deleteTokenCascade）
 * 机制为并发触发（人工重复确认、将来新支付通道的回调重推）兜底。
 */
import { isTrialPlan, KV, type Order, type Plan, type Token } from "../../../../shared/types";
import { isEmail, sendMail, sendTokenEmail, shouldSendEmail } from "./email-aliyun";
import { createMagicTicket } from "./accounts";
import { deleteTokenCascade, getPlans, getTokenById, getTrialMarker, hasPlanBonus, listTokensByContact, markPlanBonusGranted, markTrialConverted, saveOrder, saveToken } from "./kv";
import { newTokenId } from "./ids";
import { currentMonthKey } from "./nodes";
import { rewardReferrerOnPayment, consumeCredit } from "./referral";
import { pushAuthRefresh } from "./authpush";
import { siteUrl } from "./site-url";
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
  // 试用转正合并：同邮箱有仍在有效期内的体验 token 时，剩余时长记 bonus_ms（激活计时时并入），
  // 体验 token 随即吊销，避免双份并行使用。剩余流量不并入（客户决策：提前充值不送流量）。
  if (order.contact && isEmail(order.contact)) {
    const email = order.contact.trim().toLowerCase();
    const now = Date.now();
    const trials = (await listTokensByContact(env, email)).filter(
      (t) => isTrialPlan(t.plan_id) && t.status === "active" && (t.expires_at ?? 0) > now
    );
    for (const t of trials) {
      token.bonus_ms = (token.bonus_ms ?? 0) + Math.max(0, t.expires_at! - now);
      t.status = "revoked";
      await saveToken(env, t);
    }
    // 试用转正激励（一次性，锚定邮箱的试用标记而非 token 存活）：
    // 有激活中的试用 → 并入剩余时长 + 送 30 天；试用 token 已清理/从未激活 → 也送 30 天。
    // 邮箱不变即权益不变——token 可以失效被清理，邮箱永远是续用凭证
    const marker = await getTrialMarker(env, email);
    if ((trials.length > 0 || marker) && !marker?.converted_at) {
      token.bonus_ms = (token.bonus_ms ?? 0) + TRIAL_CONVERT_BONUS_MS;
      if (marker) await markTrialConverted(env, email);
    }
  }
  await saveToken(env, token);

  // 试用转正合并的时长说明（发货邮件里告知用户）
  const remainingDays = Math.max(0, Math.round(((token.bonus_ms ?? 0) - TRIAL_CONVERT_BONUS_MS) / 86_400_000));
  const mergeNote =
    (token.bonus_ms ?? 0) > 0
      ? `新用户专享：另赠 30 天${remainingDays > 0 ? `；试用剩余 ${remainingDays} 天已并入本套餐，不会浪费` : ""}`
      : undefined;

  // 如果联系方式是邮箱，自动发送凭证邮件（附带免登录管理链接，免去手动登录）
  if (shouldSendEmail(order.contact)) {
    ctx.waitUntil(
      (async () => {
        const site = siteUrl(env);
        const ticket = await createMagicTicket(env, order.contact!, token.id, "import");
        await sendTokenEmail(env, {
          tokenId: token.id,
          uuid: token.uuid,
          planName: plan.name,
          status: "paid", // 发货即 paid，激活后才开始计时
          contact: order.contact!,
          magicUrl: `${site}/auth/magic?ticket=${ticket}`,
          mergeNote,
        });
      })()
    );
  }

  return token;
};

/** 试用转正激励：赠送时长（30 天）。试用 token 充值/合并到付费套餐时生效，天然一次性（转正后 plan_id 已变更） */
export const TRIAL_CONVERT_BONUS_MS = 30 * 86_400_000;

/**
 * 升级订单发货：支付成功后升级既有 token（保留 id/uuid/设备槽位）。
 * 套餐、流量上限、设备上限换新；有效期从升级时刻按新套餐时长重计；
 * 流量记账清零（offset 基准对齐当前 Xray 累计值），月度配额账期重置。
 *
 * 试用转正（plan_trial → 付费套餐，即「给试用 token 充值」）额外激励：
 * +30 天赠送时长（每邮箱一次性，由试用标记 trial:{email} 的 converted_at 把关，
 * 防止「新购已赠送后又给同一邮箱的过期试用充值」重复赠送）、
 * 试用期内的剩余时长并入有效期；剩余流量不结转（客户决策：提前充值不送流量）。
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
  const fromTrial = isTrialPlan(token.plan_id);
  const trialRemainingMs = fromTrial ? Math.max(0, (token.expires_at ?? 0) - now) : 0;
  // 30 天赠送每邮箱一次：标记缺失（存量数据/直接建站导入）视为未消费，照常赠送
  let grantBonus = fromTrial;
  if (fromTrial && token.contact && isEmail(token.contact)) {
    const marker = await getTrialMarker(env, token.contact);
    grantBonus = !marker?.converted_at;
    if (grantBonus && marker) await markTrialConverted(env, token.contact);
  }

  token.plan_id = plan.id;
  token.traffic_limit_gb = plan.traffic_limit_gb ?? 0;
  token.max_devices = plan.max_devices;
  if (!token.activated_at) token.activated_at = now;
  // 套餐赠送时长（买 12 送 1 等）每邮箱每套餐限首购一次，与激活路径同一标记口径：
  // 月付升年付算首购年付（照送）；年付到期再升/买年付是续费（不送）
  let planDays = plan.duration_days;
  if (plan.bonus_days && token.contact) {
    if (await hasPlanBonus(env, token.contact, plan.id)) {
      planDays -= plan.bonus_days;
    } else {
      await markPlanBonusGranted(env, token.contact, plan.id);
    }
  }
  token.expires_at =
    now + planDays * 86_400_000 + (grantBonus ? TRIAL_CONVERT_BONUS_MS : 0) + trialRemainingMs;
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
  // 流量类提醒升级后可重新触发；traffic_80 提醒已下线，删键仅为清理存量旧数据
  if (token.notify_log) {
    delete token.notify_log.traffic_80;
    delete token.notify_log.exhausted;
    delete token.notify_log.traffic_spike;
  }
  await saveToken(env, token);

  if (shouldSendEmail(order.contact)) {
    const bonusParts: string[] = [];
    if (grantBonus) bonusParts.push("已额外赠送 <strong>30 天</strong>");
    if (trialRemainingMs > 0) bonusParts.push("试用剩余时长已并入有效期");
    const bonusTextParts: string[] = [];
    if (grantBonus) bonusTextParts.push("已额外赠送 30 天");
    if (trialRemainingMs > 0) bonusTextParts.push("试用剩余时长已并入有效期");
    const bonusHtml = bonusParts.length > 0 ? `<p>新用户专享：${bonusParts.join("，")}。</p>` : "";
    const bonusText = bonusTextParts.length > 0 ? `\n新用户专享：${bonusTextParts.join("，")}。` : "";
    ctx.waitUntil(
      sendMail(
        env,
        order.contact!,
        "【GameBoost】套餐升级成功",
        `<p>你好，你的 Token（<strong>${token.id}</strong>）已升级为 <strong>${plan.name}</strong>。</p>
         ${bonusHtml}
         <p>新有效期至 <strong>${new Date(token.expires_at!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</strong>，流量额度已重置为满额。订阅链接与设备保持不变，无需重新配置。</p>`,
        `你的 Token（${token.id}）已升级为 ${plan.name}。${bonusText}\n新有效期至 ${new Date(token.expires_at!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}，流量已重置为满额。订阅链接与设备不变。`
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
  /**
   * true = 另一路发货正在进行（发货锁未过期），调用方应稍后重试。
   * 当前读取方：POST /api/admin/orders/:id/paid（人工确认收款，busy 回 409 让站长稍后重试）；
   * 将来新支付通道接入后的并发回调同样应回 failure 让平台重推。
   */
  busy?: boolean;
}

/**
 * 订单发货：确认收款后置 paid 并发放 token（幂等——已 paid 直接返回已有 token）。
 * 触发路径：0 元订单/免费升级在下单瞬间直接调用；人工收款码过渡方案下站长经
 * POST /api/admin/orders/:id/paid 确认收款也会走到这里。plan 缺失时抛错，由调用方兜底。
 * 推广抵扣（order.discount_cny）在本函数发货成功后才扣减，失败不扣。
 *
 * 免费层 best-effort 幂等说明：
 * CF KV 跨 PoP 有最长约 60s 读延迟，「读 order.status === "paid"」只是快照判断，
 * 挡不住将来支付回调与其他发货入口并发/接连触发造成的重复发货。这里用两道防线：
 * 1) 入口写 orderlock:{orderId} 锁，拦截最常见的秒级并发（回调快速重推、重复触发）；
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
  // 试用转正合并会吊销激活中的体验 token → 授权名单收缩，立即同步各节点
  if (token.bonus_ms) ctx.waitUntil(pushAuthRefresh(env));

  // 防线 2：发货后对账自愈。订单上 token_id 指向别人且那个 token 真实存在 →
  // 本次是竞态 loser（锁因 KV 读延迟没拦住）：清理刚发的游离 token，返回胜者的 token。
  // 注意：loser 的凭证邮件可能已通过 waitUntil 发出，无法撤回；对账只能保证 KV 数据收敛，
  // 这也是免费层 best-effort 的已知边界。
  const winner = await reconcileFulfillment(env, order.id, token);
  if (winner) {
    await deleteTokenCascade(env, token, { devices: true, trialMarker: true });
    // 游离 token 从未进入 active 状态，不在节点授权名单内，无需 pushAuthRefresh
    return { token: winner, already: true };
  }

  // 推广抵扣在发货成功后才扣（下单时只试算不落账）：pending 期间不占用额度，
  // 用户放弃支付/订单超时被取消都无需归还。扣减失败（并发下额度已被另一单用掉）
  // 不阻断已完成的发货，只告警由站长对账
  if (order.discount_cny && order.contact) {
    const consumed = await consumeCredit(env, order.contact.trim().toLowerCase(), order.discount_cny);
    if (!consumed) {
      console.error(
        `[orders] referral credit consume failed for order ${order.id}: insufficient credit (discount ${order.discount_cny})`
      );
    }
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
