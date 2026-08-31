import { Hono } from "hono";
import { KV } from "../../../../shared/types";
import type { Registration } from "../../../../shared/types";
import { getSessionAccount } from "../lib/accounts";
import { isEmail } from "../lib/email-aliyun";
import type { Env } from "../types";

export const registerRoutes = new Hono<{ Bindings: Env }>();

const readReg = async (env: Env, accountEmail: string): Promise<Registration | null> => {
  const raw = await env.TOKENS.get(KV.REG + accountEmail);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Registration;
  } catch {
    return null;
  }
};

/**
 * GET /api/register —— 查询当前账号的防失联登记；需登录会话。
 * 未登记返回 data: null（不 404，前端据此显示空表单）。
 */
registerRoutes.get("/", async (c) => {
  const account = await getSessionAccount(c.env, c.req.header("authorization"));
  if (!account) {
    return c.json({ ok: false, error: "请先通过邮箱登录链接进入后再登记" }, 401);
  }
  return c.json({ ok: true, data: await readReg(c.env, account.email) });
});

/**
 * POST /api/register —— 登记/更新通知联系方式；需登录会话。
 * body: { notify_email?, telegram? }，至少填一项；notify_email 可与账号邮箱不同（备用邮箱）。
 * 用途：入口域名迁移/被封时批量通知，不对非登录用户开放。
 */
registerRoutes.post("/", async (c) => {
  const account = await getSessionAccount(c.env, c.req.header("authorization"));
  if (!account) {
    return c.json({ ok: false, error: "请先通过邮箱登录链接进入后再登记" }, 401);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { notify_email?: string; telegram?: string }
    | null;
  const notifyEmail = body?.notify_email?.trim().toLowerCase() ?? "";
  const telegram = body?.telegram?.trim() ?? "";

  if (notifyEmail && !isEmail(notifyEmail)) {
    return c.json({ ok: false, error: "通知邮箱格式不正确" }, 400);
  }
  if (telegram && telegram.length > 64) {
    return c.json({ ok: false, error: "Telegram 账号最长 64 字" }, 400);
  }
  if (!notifyEmail && !telegram) {
    return c.json({ ok: false, error: "通知邮箱和 Telegram 至少填一项" }, 400);
  }

  const reg: Registration = {
    account_email: account.email,
    notify_email: notifyEmail || undefined,
    telegram: telegram || undefined,
    updated_at: Date.now(),
  };
  await c.env.TOKENS.put(KV.REG + account.email, JSON.stringify(reg));
  return c.json({ ok: true, data: reg });
});
