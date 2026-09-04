/**
 * 推广邀请：邀请人持有推广码，新用户通过推广链接领取试用或下单即记录归因（待结算），
 * 被邀请人首次付费成功（订单发货）时才计为「成功邀请」，邀请人余额 +10 元。
 * 余额三种用法：
 *   1. 已开通（有激活中的付费 token）：余额满 100 元（年付续费价）自动为其套餐续期一年；
 *   2. 未开通且余额满 100 元：直接发放一个年付 token（待激活，首次导入订阅开始计时）；
 *   3. 未开通且余额不足 100 元：下单时直接抵扣，可叠加，最多减到 0 元。
 *
 * 防刷设计：试用每邮箱限领一次（trial 标记），referral 记录以被邀请人邮箱去重且只结算一次，
 * 自己邀请自己被忽略。所有记录存 TOKENS namespace。
 */
import { KV, type Token } from "../../../../shared/types";
import { createMagicTicket } from "./accounts";
import { sendMail, sendTokenEmail } from "./email-aliyun";
import { maskEmail } from "./mask-email";
import { newTokenId } from "./ids";
import { getPlans, listKeys, listTokensByContact, saveToken } from "./kv";
import type { Env } from "../types";

/** 每邀请 1 人余额增加的金额（元） */
export const DISCOUNT_PER_CREDIT = 10;

export interface RefCredit {
  /** 累计获得的额度 */
  earned: number;
  /** 已下单抵扣的额度 */
  used: number;
}

/** 取（或懒创建）某邮箱的推广码 */
export const getOrCreateRefCode = async (env: Env, email: string): Promise<string> => {
  const keys = await listKeys(env.TOKENS, KV.REFCODE);
  for (const k of keys) {
    const raw = await env.TOKENS.get(k.name);
    if (!raw) continue;
    try {
      if ((JSON.parse(raw) as { email: string }).email === email) {
        return k.name.slice(KV.REFCODE.length);
      }
    } catch {
      /* 忽略脏数据 */
    }
  }
  const code = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  await env.TOKENS.put(KV.REFCODE + code, JSON.stringify({ email }));
  return code;
};

/** 按推广码反查邀请人邮箱；码不存在返回 null */
export const resolveRefCode = async (env: Env, code: string): Promise<string | null> => {
  if (!/^[0-9a-f]{8}$/.test(code)) return null;
  const raw = await env.TOKENS.get(KV.REFCODE + code);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { email: string }).email;
  } catch {
    return null;
  }
};

export const getCredit = async (env: Env, email: string): Promise<RefCredit> => {
  const raw = await env.TOKENS.get(KV.REFCREDIT + email);
  if (!raw) return { earned: 0, used: 0 };
  try {
    return JSON.parse(raw) as RefCredit;
  } catch {
    return { earned: 0, used: 0 };
  }
};

const saveCredit = (env: Env, email: string, credit: RefCredit): Promise<void> =>
  env.TOKENS.put(KV.REFCREDIT + email, JSON.stringify(credit));

/**
 * 记录一次待结算邀请（被邀请人领取试用或带推广码下单时调用）。
 * 只写归因标记，不结算余额——被邀请人首次付费成功（订单发货）时才结算，
 * 见 rewardReferrerOnPayment。返回是否真正记录了归因（自邀/重复/无效码返回 null）。
 */
export const recordReferral = async (
  env: Env,
  refCode: string,
  inviteeEmail: string
): Promise<string | null> => {
  const referrer = await resolveRefCode(env, refCode);
  if (!referrer || referrer === inviteeEmail) return null;
  // 同一被邀请人只归因一次
  if (await env.TOKENS.get(KV.REFERRAL + inviteeEmail)) return null;
  await env.TOKENS.put(
    KV.REFERRAL + inviteeEmail,
    JSON.stringify({ referrer_email: referrer, created_at: Date.now(), rewarded: false })
  );
  return referrer;
};

interface ReferralMarker {
  referrer_email: string;
  created_at: number;
  /** false=待结算；true=已结算；旧数据无此字段=上线前已按领取即结算，不重复发放 */
  rewarded?: boolean;
}

/**
 * 被邀请人首次付费成功（订单发货）时给邀请人结算：余额 +10 元并邮件通知；
 * 邀请人有激活中的付费套餐且余额满续费价时自动续期一年。幂等：每个被邀请人只结算一次。
 * 返回 true 表示授权名单有变化（自动续期复活了已过期 token），调用方应推送节点刷新。
 */
export const rewardReferrerOnPayment = async (env: Env, inviteeEmail: string): Promise<boolean> => {
  const raw = await env.TOKENS.get(KV.REFERRAL + inviteeEmail);
  if (!raw) return false;
  let marker: ReferralMarker;
  try {
    marker = JSON.parse(raw) as ReferralMarker;
  } catch {
    return false;
  }
  if (marker.rewarded !== false) return false;
  marker.rewarded = true;
  await env.TOKENS.put(KV.REFERRAL + inviteeEmail, JSON.stringify(marker));

  const referrer = marker.referrer_email;
  const credit = await getCredit(env, referrer);
  credit.earned += 1;
  await saveCredit(env, referrer, credit);
  console.log(`[referral] ${maskEmail(inviteeEmail)} paid, +${DISCOUNT_PER_CREDIT} CNY to ${maskEmail(referrer)}`);

  const balance = Math.max(0, credit.earned - credit.used) * DISCOUNT_PER_CREDIT;
  const res = await sendMail(
    env,
    referrer,
    "【GameBoost】你邀请的用户已完成付费",
    `<p>你好，你邀请的用户（${inviteeEmail}）已成功付费开通。</p>
     <p>你的推广余额 <strong>+${DISCOUNT_PER_CREDIT} 元</strong>，当前余额 <strong>${balance} 元</strong>。</p>
     <p>余额满 <strong>100 元</strong>（累计 10 人付费）：已开通套餐的自动<strong>续期一年</strong>；未开通的直接<strong>送一年年付套餐</strong>，也可在下单时抵扣。</p>`,
    `你邀请的用户（${inviteeEmail}）已成功付费开通，推广余额 +${DISCOUNT_PER_CREDIT} 元（当前 ${balance} 元）。余额满 100 元：已开通套餐的自动续期一年，未开通的直接送一年年付套餐，也可下单抵扣。`
  );
  if (!res.ok) console.error(`[referral] reward mail failed for ${maskEmail(referrer)}: ${res.error}`);

  // 余额满续费价：自动给激活中的付费套餐续期一年
  const renew = await tryAutoRenewWithBalance(env, referrer);
  if (renew.renewed) {
    console.log(`[referral] auto-renewed ${renew.tokenId} for ${maskEmail(referrer)}, new expires_at=${renew.newExpiresAt}`);
    const expiry = new Date(renew.newExpiresAt ?? Date.now()).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
    const renewRes = await sendMail(
      env,
      referrer,
      "【GameBoost】推广余额已为你续期一年",
      `<p>你好，你的推广余额已满 <strong>${renew.renewCostCny} 元</strong>，已自动为你的套餐（${renew.tokenId}）<strong>续期一年</strong>。</p>
       <p>新的到期时间：<strong>${expiry}</strong>。继续邀请可继续累积余额，满 ${renew.renewCostCny} 元再次自动续期。</p>`,
      `你的推广余额已满 ${renew.renewCostCny} 元，已自动为套餐（${renew.tokenId}）续期一年，新到期时间：${expiry}。`
    );
    if (!renewRes.ok) console.error(`[referral] renew mail failed for ${maskEmail(referrer)}: ${renewRes.error}`);
    return true; // 续期可能复活已过期的 token，授权名单有变
  }

  // 未开通付费套餐：余额满额直接发放年付 token（待激活）
  const reward = await tryIssueRewardToken(env, referrer);
  if (reward.issued) {
    console.log(`[referral] reward token ${reward.tokenId} issued to ${maskEmail(referrer)}`);
  }
  return false; // 奖励 token 为 paid 待激活状态，不进授权名单
};

/** 可用额度 → 最大可减金额（元），按 10 的倍数返回，下单时调用方再与套餐价对齐 */
export const availableDiscount = async (env: Env, email: string): Promise<number> => {
  const credit = await getCredit(env, email);
  return Math.max(0, credit.earned - credit.used) * DISCOUNT_PER_CREDIT;
};

/**
 * 下单抵扣金额：额度按个数记账（1 个 = 10 元），抵扣向下取整到 10 的倍数，
 * 保证 consumeCredit 折算回个数时不漏损；返回 0 表示不抵扣。
 */
export const orderDiscount = (availableCny: number, priceCny: number): number =>
  Math.min(availableCny, Math.floor(priceCny / DISCOUNT_PER_CREDIT) * DISCOUNT_PER_CREDIT);

/** 下单时消耗额度（按实际抵扣金额折算个数） */
export const consumeCredit = async (env: Env, email: string, discountCny: number): Promise<void> => {
  if (discountCny <= 0) return;
  const credit = await getCredit(env, email);
  credit.used += Math.round(discountCny / DISCOUNT_PER_CREDIT);
  await saveCredit(env, email, credit);
};

/** 订单取消时归还额度 */
export const restoreCredit = async (env: Env, email: string, discountCny: number): Promise<void> => {
  if (discountCny <= 0) return;
  const credit = await getCredit(env, email);
  credit.used = Math.max(0, credit.used - Math.round(discountCny / DISCOUNT_PER_CREDIT));
  await saveCredit(env, email, credit);
};

/** 自动续期结果：renewed 为 true 时表示已扣 100 元余额并给 token 续了一年 */
export interface AutoRenewResult {
  renewed: boolean;
  tokenId?: string;
  newExpiresAt?: number;
  renewCostCny: number;
}

/**
 * 已开通用户的余额自动续期：可用余额满年付续费价（plan_yearly_renew，默认 100 元）时，
 * 为其最新的激活中付费 token 延长一年（expires_at 与 base_expires_at 同步顺延，
 * 预支月数账务不变），并从余额扣费。余额够多年就连扣多年；没有激活中的付费
 * token（试用/未激活）时不扣，余额留着下单抵扣。
 */
export const tryAutoRenewWithBalance = async (env: Env, email: string): Promise<AutoRenewResult> => {
  const plans = await getPlans(env);
  const renewPlan = plans.find((p) => p.id === "plan_yearly_renew");
  const renewCost = renewPlan?.price_cny ?? 100;
  const renewMs = (renewPlan?.duration_days ?? 365) * 86_400_000;
  const result: AutoRenewResult = { renewed: false, renewCostCny: renewCost };

  const credit = await getCredit(env, email);
  const tokens = await listTokensByContact(env, email);
  const target = tokens
    .filter((t) => {
      if (t.status !== "active" || !t.expires_at) return false;
      const plan = plans.find((p) => p.id === t.plan_id);
      return (plan?.price_cny ?? 0) > 0; // 免费体验套餐不参与自动续期
    })
    .sort((a, b) => (b.expires_at ?? 0) - (a.expires_at ?? 0))[0];
  if (!target) return result;

  while (credit.earned - credit.used >= Math.ceil(renewCost / DISCOUNT_PER_CREDIT)) {
    credit.used += Math.ceil(renewCost / DISCOUNT_PER_CREDIT);
    target.expires_at = (target.expires_at ?? Date.now()) + renewMs;
    if (target.base_expires_at) target.base_expires_at += renewMs;
    result.renewed = true;
    result.tokenId = target.id;
    result.newExpiresAt = target.expires_at;
  }
  if (result.renewed) {
    await saveToken(env, target);
    await saveCredit(env, email, credit);
  }
  return result;
};

/** 未开通用户的余额兑现结果 */
export interface RewardTokenResult {
  issued: boolean;
  tokenId?: string;
}

/**
 * 未开通用户的余额兑现：没有激活中的付费 token 且余额满年付续费价（默认 100 元）时，
 * 扣 100 元余额发放一个年付 token（paid 待激活，首次导入订阅开始计时），
 * 邮件附带一键管理链接。余额够多份就连发多份。
 */
export const tryIssueRewardToken = async (env: Env, email: string): Promise<RewardTokenResult> => {
  const plans = await getPlans(env);
  const renewPlan = plans.find((p) => p.id === "plan_yearly_renew");
  const cost = renewPlan?.price_cny ?? 100;
  const yearly = plans.find((p) => p.id === "plan_yearly");
  const need = Math.ceil(cost / DISCOUNT_PER_CREDIT);

  const credit = await getCredit(env, email);
  const tokens = await listTokensByContact(env, email);
  const hasActivePaid = tokens.some((t) => {
    if (t.status !== "active" || !t.expires_at) return false;
    const plan = plans.find((p) => p.id === t.plan_id);
    return (plan?.price_cny ?? 0) > 0; // 有激活中的付费套餐时走自动续期，不发奖励 token
  });
  if (hasActivePaid || credit.earned - credit.used < need) return { issued: false };

  const result: RewardTokenResult = { issued: false };
  const site = (env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
  while (credit.earned - credit.used >= need) {
    const token: Token = {
      id: newTokenId(),
      uuid: crypto.randomUUID(),
      plan_id: yearly?.id ?? "plan_yearly",
      status: "paid", // 待激活，激活或首次导入订阅后开始计时
      contact: email,
      traffic_limit_gb: yearly?.traffic_limit_gb ?? 240,
      traffic_used_gb: 0,
      purchased_at: Date.now(),
    };
    await saveToken(env, token);
    credit.used += need;
    await saveCredit(env, email, credit);
    result.issued = true;
    result.tokenId = token.id;

    const ticket = await createMagicTicket(env, email, token.id);
    const res = await sendTokenEmail(env, {
      tokenId: token.id,
      uuid: token.uuid,
      planName: "推广奖励 · 年付套餐（一年）",
      status: "paid",
      contact: email,
      magicUrl: `${site}/auth/magic?ticket=${ticket}`,
    });
    if (!res.ok) console.error(`[referral] reward token mail failed for ${maskEmail(email)}: ${res.error}`);
  }
  return result;
};
