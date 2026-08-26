import { Hono } from "hono";
import { KV } from "../../../../shared/types";
import { getSessionAccount } from "../lib/accounts";
import { listKeys } from "../lib/kv";
import { getCredit, getOrCreateRefCode, DISCOUNT_PER_CREDIT } from "../lib/referral";
import type { Env } from "../types";

export const referralRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/referral/me —— 我的推广信息（需邮箱免密登录的 session）
 * 返回推广码/推广链接/已结算人数/待结算人数/可用余额；推广码首次访问时懒创建。
 */
referralRoutes.get("/me", async (c) => {
  const account = await getSessionAccount(c.env, c.req.header("authorization"));
  if (!account) {
    return c.json({ ok: false, error: "请先登录（在我的 Token 页输入邮箱获取登录链接）" }, 401);
  }
  const email = account.email;
  const code = await getOrCreateRefCode(c.env, email);
  const credit = await getCredit(c.env, email);

  // 待结算：已归因但尚未付费（rewarded:false）的被邀请人数量
  let pending = 0;
  for (const k of await listKeys(c.env.TOKENS, KV.REFERRAL)) {
    const raw = await c.env.TOKENS.get(k.name);
    if (!raw) continue;
    try {
      const m = JSON.parse(raw) as { referrer_email: string; rewarded?: boolean };
      if (m.referrer_email === email && m.rewarded === false) pending += 1;
    } catch {
      /* 忽略脏数据 */
    }
  }

  const site = (c.env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
  return c.json({
    ok: true,
    data: {
      code,
      link: `${site}/?ref=${code}`,
      invited_count: credit.earned,
      pending_count: pending,
      available_credits: Math.max(0, credit.earned - credit.used),
      discount_per_credit: DISCOUNT_PER_CREDIT,
    },
  });
});
