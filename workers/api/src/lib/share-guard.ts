/**
 * 共享检测（并发连接数判定）→ 警告 → 暂停 → 续费自动解锁。
 *
 * 背景：一个 token（VLESS UUID 体系）被多人同时挂用时流量维度抓不快，
 * 改用并发连接数判定——正常一人 2~5 台设备，共享群 10+ 并发。
 * 处置不踢不删：首次连续超标发警告邮件，警告后 7 天内再犯置 share_suspended_at
 * （授权快照生成侧剔除，连接随节点配置刷新被切断），续费任意套餐后自动解锁恢复，
 * 把共享转化为续费收入。
 *
 * 触发点：/api/agent/traffic 携带的 conns（uuid → 当前并发连接数，xray online 计数）。
 * 幂等与省写：未超标不写库；strikes 只在超标周期更新；已暂停 token 直接跳过。
 */
import type { Plan, Token } from "../../../../shared/types";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { getTokenByUuid, listTokensByContact, saveTokenValue } from "./kv";
import { siteUrl } from "./site-url";
import type { Env } from "../types";

/** 并发容差：套餐设备上限 + 2。总和超过即记一次超标 */
export const SHARE_CONN_TOLERANCE = 2;
/** 套餐设备上限取不到时的兜底值 */
export const SHARE_FALLBACK_MAX_DEVICES = 3;
/** strikes 连续窗口：距上次超标超过此时长则重新计数（agent 结算周期远小于窗口，2 个连续周期即 count>=2） */
export const SHARE_STRIKE_WINDOW_MS = 30 * 60_000;
/** 警告冷却期：7 天内再犯直接暂停；超过则重新警告一轮 */
export const SHARE_WARN_COOLDOWN_MS = 7 * 86_400_000;

/** 共享字段的定点合并写补丁；null = 删除该字段 */
export interface ShareFieldsPatch {
  share_suspended_at?: number | null;
  share_warned_at?: number | null;
  share_conn_strikes?: Token["share_conn_strikes"] | null;
  notify_log?: Record<string, number>;
}

/**
 * 共享字段的「重读-合并」写：重新读取 token 最新副本，只覆盖补丁字段再写回，
 * 与结算路径（mergeTokenSettlement）并发时互不覆盖。notify_log 键级合并。
 */
export const mergeShareFields = async (env: Env, uuid: string, patch: ShareFieldsPatch): Promise<void> => {
  const fresh = await getTokenByUuid(env, uuid);
  if (!fresh) return;
  const bag = fresh as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "notify_log") {
      fresh.notify_log = { ...fresh.notify_log, ...(v as Record<string, number>) };
    } else if (v === null) {
      delete bag[k];
    } else {
      bag[k] = v;
    }
  }
  await saveTokenValue(env, fresh);
};

/** 共享警告邮件：检测到异常并发连接，提醒重置订阅链接；7 天内再犯将暂停服务 */
export async function sendShareWarnEmail(
  env: Env,
  token: Token,
  conns: number,
  limit: number
): Promise<boolean> {
  if (!shouldSendEmail(token.contact)) return false;
  token.notify_log = token.notify_log ?? {};
  // 幂等：冷却期内不重复发（与 share_warned_at 同窗口，双保险防并发重复触达）
  if (Date.now() - (token.notify_log.share_warn ?? 0) < SHARE_WARN_COOLDOWN_MS) return false;
  const manageUrl = `${siteUrl(env)}/tokens?id=${token.id}`;
  const res = await sendMail(
    env,
    token.contact,
    "【GameBoost】账号安全提醒：检测到异常并发连接",
    `<p>你好，系统检测到你的 Token（<strong>${token.id}</strong>）当前有 <strong>${conns}</strong> 个并发连接，超出套餐允许的设备规模（${limit}）。</p>
     <p>如果是你本人在多台设备上使用，可以忽略本邮件；否则说明你的订阅链接可能已被转发共享。</p>
     <p><strong>如非本人使用，请尽快登录管理页重置订阅链接</strong>（旧链接立即失效）。<strong>7 天内再次检测到异常并发，服务将被暂停。</strong></p>
     <p style="color:#64748b;font-size:13px;">管理页：<a href="${manageUrl}" style="color:#0ea5e9;">${manageUrl}</a></p>`,
    `检测到你的 Token（${token.id}）当前有 ${conns} 个并发连接，超出套餐允许的设备规模（${limit}）。\n如非本人使用，请尽快登录管理页重置订阅链接（旧链接立即失效）：${manageUrl}\n7 天内再次检测到异常并发，服务将被暂停。`
  );
  if (res.ok) {
    token.notify_log.share_warn = Date.now();
    console.log(`[share] warned ${token.id} conns=${conns}`);
  } else {
    console.error(`[share] warn mail failed ${token.id}: ${res.error}`);
  }
  return res.ok;
}

/** 暂停邮件：服务已暂停，续费任意套餐后自动恢复；如有疑问联系站长 */
export async function sendShareSuspendEmail(env: Env, token: Token): Promise<boolean> {
  if (!shouldSendEmail(token.contact)) return false;
  token.notify_log = token.notify_log ?? {};
  // 幂等：一次暂停只发一封（已暂停 token 在判定入口被跳过，这里防并发评估重复触达）
  if (token.notify_log.share_suspended) return false;
  const site = siteUrl(env);
  const res = await sendMail(
    env,
    token.contact,
    "【GameBoost】服务已暂停：检测到订阅共享",
    `<p>你好，你的 Token（<strong>${token.id}</strong>）因持续检测到异常并发连接（疑似订阅链接被多人共享），服务已暂停。</p>
     <p><strong>续费任意套餐后服务自动恢复</strong>，订阅链接与已配置的设备无需变动。如有疑问请联系站长。</p>
     <p style="color:#64748b;font-size:13px;">续费入口：<a href="${site}" style="color:#0ea5e9;">${site}</a></p>`,
    `你的 Token（${token.id}）因持续检测到异常并发连接（疑似订阅链接被多人共享），服务已暂停。\n续费任意套餐后服务自动恢复，订阅链接与设备无需变动。如有疑问请联系站长。\n续费入口：${site}`
  );
  if (res.ok) {
    token.notify_log.share_suspended = Date.now();
    console.log(`[share] suspended ${token.id}`);
  } else {
    console.error(`[share] suspend mail failed ${token.id}: ${res.error}`);
  }
  return res.ok;
}

/**
 * 单 token 的共享判定（调用方已按 token 聚合好全部 uuid 的并发数总和）。
 * 阈值：token.max_devices ?? 套餐 max_devices ?? 3，再加 SHARE_CONN_TOLERANCE。
 * 连续 2 个周期超标才处置（strikes.at 超 30 分钟重新计数）：
 * - 无 7 天内警告记录 → 发警告邮件，置 share_warned_at；
 * - 已有 7 天内警告 → 置 share_suspended_at 并返回 true（调用方推送授权刷新）。
 * 返回 true 表示授权名单有变化（新暂停），调用方应 pushAuthRefresh。
 */
export async function evaluateShareConns(
  env: Env,
  token: Token,
  totalConns: number,
  plansById: Map<string, Plan>,
  now: number
): Promise<boolean> {
  // 已暂停：不再重复判定/写库（解锁只能走续费或管理端清除）
  if (token.share_suspended_at) return false;
  const maxDevices =
    token.max_devices ?? plansById.get(token.plan_id)?.max_devices ?? SHARE_FALLBACK_MAX_DEVICES;
  const limit = maxDevices + SHARE_CONN_TOLERANCE;
  const patch: ShareFieldsPatch = {};
  let authChanged = false;

  if (totalConns > limit) {
    const prev = token.share_conn_strikes;
    const count = prev && now - prev.at <= SHARE_STRIKE_WINDOW_MS ? prev.count + 1 : 1;
    if (count < 2) {
      patch.share_conn_strikes = { at: now, count };
    } else if (now - (token.share_warned_at ?? 0) > SHARE_WARN_COOLDOWN_MS) {
      // 首次连续超标：只警告不处置。无邮箱联系方式时也置 warned_at，让状态机继续推进
      const sent = await sendShareWarnEmail(env, token, totalConns, limit);
      patch.share_warned_at = now;
      if (sent) patch.notify_log = { share_warn: now };
      patch.share_conn_strikes = { at: now, count };
    } else {
      // 警告后 7 天内再犯：暂停。快照生成侧剔除，推送节点刷新立即生效
      const sent = await sendShareSuspendEmail(env, token);
      patch.share_suspended_at = now;
      patch.share_conn_strikes = null; // 暂停后连续计数无意义
      if (sent) patch.notify_log = { share_suspended: now };
      authChanged = true;
    }
  } else if (token.share_conn_strikes) {
    // 未超标：连续计数清零（下次超标从 1 重新计）
    patch.share_conn_strikes = null;
  }

  if (Object.keys(patch).length > 0) await mergeShareFields(env, token.uuid, patch);
  return authChanged;
}

/**
 * 续费自动解锁：发货/续期成功后清除该 contact 名下被共享检测暂停的 token
 * （share_suspended_at + strikes；保留 share_warned_at，续费后短期内再犯直接暂停）。
 * 返回 true 表示有 token 被解锁，调用方应推送授权刷新让节点白名单加回。
 */
export async function unlockShareSuspendedByContact(env: Env, contact?: string): Promise<boolean> {
  if (!contact) return false;
  const tokens = await listTokensByContact(env, contact);
  let unlocked = false;
  for (const t of tokens) {
    if (!t.share_suspended_at) continue;
    delete t.share_suspended_at;
    delete t.share_conn_strikes;
    await saveTokenValue(env, t);
    unlocked = true;
    console.log(`[share] unlocked ${t.id} on renewal`);
  }
  return unlocked;
}
