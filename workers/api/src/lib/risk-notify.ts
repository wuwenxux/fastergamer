/**
 * 风险检测与客户提醒
 *
 * 触发点：/api/agent/traffic（每 30s）与 /api/admin/notify-scan（cron 每 6h）
 * 幂等：token.notify_log 记录每类提醒的发送时间，同类提醒不重复发送
 *   - traffic_80 / exhausted / multi_device：每个 token 只发一次
 *   - expire_24h：每个 token 只发一次
 */

import type { Node, Token } from "../../../../shared/types";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { currentMonthKey } from "./nodes";
import type { Env } from "../types";

function siteUrl(env: Env): string {
  return (env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
}

function shell(env: Env, title: string, bodyHtml: string, bodyText: string) {
  const tokenUrl = `${siteUrl(env)}/tokens`;
  const subject = `【GameBoost】${title}`;
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>${subject}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px; text-align: center;">
    <h1 style="margin: 0; font-size: 22px;">🎮 GameBoost</h1>
    <p style="margin: 8px 0 0; color: #94a3b8;">${title}</p>
  </div>
  <div style="margin-top: 24px; padding: 20px; background: #f8fafc; border-radius: 12px;">
    ${bodyHtml}
    <div style="text-align: center; margin: 24px 0;">
      <a href="${tokenUrl}" style="display: inline-block; background: #0ea5e9; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 500;">查看我的 Token</a>
    </div>
  </div>
  <p style="margin-top: 24px; font-size: 13px; color: #94a3b8; text-align: center;">
    本邮件由 GameBoost 自动发送，请勿直接回复。如有疑问请联系售后。
  </p>
</body>
</html>
  `.trim();
  const text = `${title}\n\n${bodyText}\n\n查看 Token：${tokenUrl}\n\n本邮件由 GameBoost 自动发送，如有疑问请联系售后。`;
  return { subject, html, text };
}

/** 发送一次某类提醒（已发过则跳过），返回是否实际发送 */
async function notifyOnce(
  env: Env,
  token: Token,
  kind: string,
  title: string,
  bodyHtml: string,
  bodyText: string
): Promise<boolean> {
  if (!shouldSendEmail(token.contact)) return false;
  token.notify_log = token.notify_log ?? {};
  if (token.notify_log[kind]) return false;
  const { subject, html, text } = shell(env, title, bodyHtml, bodyText);
  const res = await sendMail(env, token.contact, subject, html, text);
  if (res.ok) {
    token.notify_log[kind] = Date.now();
    console.log(`[risk] notified ${token.id} kind=${kind}`);
  } else {
    console.error(`[risk] notify failed ${token.id} kind=${kind}: ${res.error}`);
  }
  return res.ok;
}

const fmtGb = (n: number) => n.toFixed(2);

/**
 * 在 token 数据更新后调用：检查流量阈值与多设备风险，必要时提醒客户。
 * 注意：调用方负责在此函数返回后 saveToken（本函数可能修改 notify_log）。
 */
export async function checkTokenRisks(env: Env, token: Token): Promise<void> {
  const limit = token.traffic_limit_gb ?? 0;
  const used = token.traffic_used_gb ?? 0;

  // 流量用到 80%
  if (limit > 0 && used >= limit * 0.8 && used < limit) {
    await notifyOnce(
      env,
      token,
      "traffic_80",
      "流量余额提醒",
      `<p>你好，你的 Token（<strong>${token.id}</strong>）流量已使用 <strong>${fmtGb(used)} / ${limit} GB</strong>（80%）。</p>
       <p>剩余流量约 <strong>${fmtGb(limit - used)} GB</strong>。用完后还有 <strong>48 小时宽限期</strong>可以正常使用，建议提前到 <a href="${siteUrl(env)}" style="color: #0ea5e9;">官网</a> 续费，避免宽限期结束后服务暂停。</p>`,
      `你的 Token（${token.id}）流量已使用 ${fmtGb(used)} / ${limit} GB（80%）。\n剩余约 ${fmtGb(limit - used)} GB。用完后还有 48 小时宽限期，建议提前到官网续费：${siteUrl(env)}`
    );
  }

  // 流量耗尽：进入 48 小时宽限期，优先引导续费，不立即断连
  if (limit > 0 && used >= limit) {
    await notifyOnce(
      env,
      token,
      "exhausted",
      "流量已用完，请续费",
      `<p>你好，你的 Token（<strong>${token.id}</strong>）流量额度 <strong>${limit} GB</strong> 已全部用完。</p>
       <p>不会立即断线：<strong>48 小时内服务照常可用</strong>。请尽快到 <a href="${siteUrl(env)}" style="color: #0ea5e9;">官网</a> 购买新套餐；超过 48 小时未续费，服务才会暂停。</p>`,
      `你的 Token（${token.id}）流量 ${limit} GB 已用完。\n48 小时内服务照常可用，请尽快到官网续费：${siteUrl(env)}\n超过 48 小时未续费，服务将暂停。`
    );
  }

  // 疑似多设备/分享使用
  if (token.multi_device_detected_at) {
    await notifyOnce(
      env,
      token,
      "multi_device",
      "账号安全提醒：检测到多处同时使用",
      `<p>你好，系统检测到你的 Token（<strong>${token.id}</strong>）于 ${new Date(token.multi_device_detected_at).toLocaleString("zh-CN")} 在<strong>多个节点同时在线</strong>。</p>
       <p>如果你自己在多台设备上使用，可以忽略本邮件；否则说明你的订阅链接可能已泄露，他人正在盗用你的流量。</p>
       <p><strong>建议措施：</strong>联系售后重置连接凭证（UUID）。重置后旧凭证立即失效，你的设备更新订阅即可恢复，盗用者将被断开。</p>`,
      `检测到你的 Token（${token.id}）在多个节点同时在线。\n如果是你自己多台设备使用可忽略；否则订阅链接可能已泄露。\n建议：联系售后重置连接凭证（UUID），旧凭证将立即失效。`
    );
  }
}

/**
 * 到期提醒（由 notify-scan 定时调用）：active 且 24h 内到期时提醒一次
 */
export async function checkExpiringToken(env: Env, token: Token): Promise<void> {
  const now = Date.now();
  if (token.status !== "active" || !token.expires_at) return;
  if (token.expires_at <= now || token.expires_at > now + 24 * 3_600_000) return;
  await notifyOnce(
    env,
    token,
    "expire_24h",
    "服务即将到期",
    `<p>你好，你的 Token（<strong>${token.id}</strong>）将于 <strong>${new Date(token.expires_at).toLocaleString("zh-CN")}</strong> 到期。</p>
     <p>到期后服务自动停止。如需继续使用，请提前购买新套餐。</p>`,
    `你的 Token（${token.id}）将于 ${new Date(token.expires_at).toLocaleString("zh-CN")} 到期，到期后服务自动停止。\n如需继续使用请提前购买新套餐。`
  );
}

/**
 * 月度配额预支提醒：当月用量每预支一个月档位时通知客户一次（borrow_1 / borrow_2 …）。
 * 调用方负责在此函数返回后 saveToken（本函数可能修改 notify_log）。
 */
/**
 * 月度配额 80% 提前预警（每自然月一次）。
 * 在流量上报循环里调用（此时 month_used_bytes 已含本次增量）。
 * 文案同步说明预支机制，让用户在「被扣有效期」之前有心理预期。
 */
export async function notifyMonth80(
  env: Env,
  token: Token,
  quotaGb: number
): Promise<void> {
  if (!quotaGb || quotaGb <= 0 || !shouldSendEmail(token.contact)) return;
  const usedGb = (token.month_used_bytes ?? 0) / 1024 ** 3;
  if (usedGb < quotaGb * 0.8) return;

  token.notify_log = token.notify_log ?? {};
  const key = `month80_${token.month_key ?? currentMonthKey()}`;
  if (token.notify_log[key]) return;

  const { subject, html, text } = shell(
    env,
    "本月流量即将用完",
    `<p>你好，你的 Token（<strong>${token.id}</strong>）本月额度已使用 <strong>${fmtGb(usedGb)} / ${quotaGb} GB</strong>（80%）。</p>
     <p>本月额度用完后不会断网：系统将自动<strong>预支后续月份的额度</strong>继续为你服务，每预支一个月，总有效期提前一个月。下月 1 日（UTC）恢复新的 ${quotaGb} GB 额度。</p>
     <p>如非本人大量使用，请登录管理页检查设备列表，解绑可疑设备。</p>`,
    `你的 Token（${token.id}）本月额度已用 ${fmtGb(usedGb)} / ${quotaGb} GB（80%）。\n用完后将自动预支后续月份额度继续使用（每预支一个月，总有效期提前一个月）。\n下月 1 日恢复新的月度额度。如非本人使用请检查设备列表。`
  );
  const res = await sendMail(env, token.contact, subject, html, text);
  if (res.ok) {
    token.notify_log[key] = Date.now();
    console.log(`[risk] month80 notified ${token.id} (${usedGb.toFixed(1)}/${quotaGb} GB)`);
  } else {
    console.error(`[risk] month80 mail failed ${token.id}: ${res.error}`);
  }
}

export async function notifyBorrow(
  env: Env,
  token: Token,
  borrowed: number,
  quotaGb: number
): Promise<void> {
  if (borrowed <= 0 || !shouldSendEmail(token.contact)) return;
  token.notify_log = token.notify_log ?? {};
  const key = `borrow_${borrowed}`;
  if (token.notify_log[key]) return;

  const expiryText = token.expires_at
    ? new Date(token.expires_at).toLocaleString("zh-CN")
    : "未知";
  const { subject, html, text } = shell(
    env,
    "本月流量已用完，已预支下月额度",
    `<p>你好，你的 Token（<strong>${token.id}</strong>）本月 ${quotaGb} GB 额度已用完，已自动<strong>预支后续月份额度</strong>继续为你服务（第 ${borrowed} 次预支）。</p>
     <p>注意：每预支一个月，有效期永久提前一个月，当前有效期至 <strong>${expiryText}</strong>。下月 1 日（UTC）将恢复新的 ${quotaGb} GB 月度额度。</p>
     <p>如非本人大量使用，请登录管理页检查设备列表，解绑可疑设备。</p>`,
    `你的 Token（${token.id}）本月 ${quotaGb} GB 已用完，已自动预支后续月份额度（第 ${borrowed} 次）。\n每预支一个月，有效期永久提前一个月，当前有效期至 ${expiryText}。\n下月 1 日恢复新的月度额度。如非本人使用请检查设备列表。`
  );
  const res = await sendMail(env, token.contact, subject, html, text);
  if (res.ok) {
    token.notify_log[key] = Date.now();
    console.log(`[risk] borrow notified ${token.id} level=${borrowed}`);
  } else {
    console.error(`[risk] borrow mail failed ${token.id}: ${res.error}`);
  }
}

// ---------- 管理员告警 ----------

/** IP 归属地查询（ipwho.is 免费接口，3s 超时；失败返回 null 不影响主流程） */
async function lookupIpGeo(ip: string): Promise<string | null> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = (await res.json()) as {
      success?: boolean;
      country?: string;
      region?: string;
      city?: string;
      connection?: { isp?: string };
    };
    if (!data.success) return null;
    const parts = [data.country, data.region, data.city, data.connection?.isp].filter(Boolean);
    return parts.length > 0 ? parts.join(" / ") : null;
  } catch {
    return null;
  }
}

/**
 * 接入地址变更提醒：当前活跃接入 IP 与上一上报周期不一致时邮件通知本人。
 * 触发即「地址变了」，无论该 IP 是否历史见过；首次使用建基线不提醒。
 * 限流：每个 token 12 小时最多一封（动态 IP 用户换地址是常态，不能刷屏）。
 * 调用方负责 saveToken（本函数改 notify_log）。
 */
export async function notifyIpChange(env: Env, token: Token, ips: string[]): Promise<void> {
  if (ips.length === 0 || !shouldSendEmail(token.contact)) return;
  token.notify_log = token.notify_log ?? {};
  const now = Date.now();
  if (now - (token.notify_log["ip_change"] ?? 0) < 12 * 3_600_000) return;

  const ip = ips[0];
  const geo = await lookupIpGeo(ip);
  const geoText = geo ?? "归属地查询失败";
  const manageUrl = `${siteUrl(env)}/tokens?id=${token.id}`;
  const { subject, html, text } = shell(
    env,
    "账号安全提醒：接入地址发生变更",
    `<p>你好，你的 Token（<strong>${token.id}</strong>）的接入地址刚刚发生变更，新接入 IP：</p>
     <p style="font-size:16px;"><strong>${ip}</strong>（${geoText}）</p>
     <p>如果是你本人换了网络（如 WiFi 切到 4G/5G、换了宽带、开了手机热点），可忽略本邮件；否则说明订阅链接可能已泄露，他人正在盗用你的流量。</p>
     <p><strong>你可以自己处理：</strong>登录 <a href="${manageUrl}">Token 管理页</a>，在「接入 IP 统计」里点击该 IP 旁的「封禁」，该 IP 将在 30 秒内被所有节点拒绝连接；误封可随时解除。</p>`,
    `你的 Token（${token.id}）接入地址发生变更，新 IP：${ip}（${geoText}）。\n如果是你本人换网络可忽略；否则订阅可能泄露。\n处理：登录管理页 ${manageUrl} 在「接入 IP 统计」中封禁该 IP（30 秒内全节点生效，可随时解除）。`
  );
  const res = await sendMail(env, token.contact, subject, html, text);
  if (res.ok) {
    token.notify_log["ip_change"] = now;
    console.log(`[risk] ip-change notified ${token.id} ips=${ips.join(",")}`);
  } else {
    console.error(`[risk] ip-change mail failed ${token.id}: ${res.error}`);
  }
}

/** 给管理员发告警邮件（未配置 ADMIN_NOTIFY_EMAIL 则只记日志） */
export async function notifyAdmin(
  env: Env,
  title: string,
  bodyHtml: string,
  bodyText: string
): Promise<void> {
  if (!env.ADMIN_NOTIFY_EMAIL) {
    console.log(`[admin-alert] ${title}（未配置 ADMIN_NOTIFY_EMAIL，仅记日志）`);
    return;
  }
  const res = await sendMail(env, env.ADMIN_NOTIFY_EMAIL, `【GameBoost 告警】${title}`, bodyHtml, bodyText);
  if (!res.ok) console.error(`[admin-alert] mail failed: ${title}: ${res.error}`);
}

/** 流量暴增告警阈值：单 token 1 小时内新增 10 GB */
export const SPIKE_WINDOW_MS = 3_600_000;
export const SPIKE_THRESHOLD_BYTES = 10 * 1024 ** 3;

/**
 * 流量暴增检测（在 agent 流量入账时调用，deltaBytes 为本次上报新增量）。
 * 超阈值时告警客户与管理员，24h 内最多一次。调用方负责 saveToken。
 */
export async function checkTrafficSpike(env: Env, token: Token, deltaBytes: number): Promise<void> {
  if (deltaBytes <= 0) return;
  const now = Date.now();
  if (!token.rate_window_start || now - token.rate_window_start > SPIKE_WINDOW_MS) {
    token.rate_window_start = now;
    token.rate_window_bytes = 0;
  }
  token.rate_window_bytes = (token.rate_window_bytes ?? 0) + deltaBytes;
  if (token.rate_window_bytes < SPIKE_THRESHOLD_BYTES) return;

  const last = token.notify_log?.traffic_spike ?? 0;
  if (now - last < 24 * 3_600_000) return;

  const gb = (token.rate_window_bytes / 1024 ** 3).toFixed(1);
  console.log(`[risk] traffic spike ${token.id}: ${gb} GB in 1h`);
  token.notify_log = token.notify_log ?? {};
  token.notify_log.traffic_spike = now;

  if (shouldSendEmail(token.contact)) {
    const { subject, html, text } = shell(
      env,
      "流量异常提醒",
      `<p>你好，你的 Token（<strong>${token.id}</strong>）在过去 1 小时内消耗了 <strong>${gb} GB</strong> 流量，远超正常游戏用量。</p>
       <p>如果不是你本人大量使用（如下载、看高清视频），说明订阅链接可能已泄露被他人盗用，建议立即登录管理页解绑可疑设备，或联系售后重置凭证。</p>`,
      `你的 Token（${token.id}）过去 1 小时消耗 ${gb} GB，远超正常游戏用量。\n如非本人使用，请登录管理页解绑可疑设备或联系售后重置凭证。`
    );
    const res = await sendMail(env, token.contact, subject, html, text);
    if (!res.ok) console.error(`[risk] spike mail failed ${token.id}: ${res.error}`);
  }
  await notifyAdmin(
    env,
    `流量暴增：${token.id} 1 小时 ${gb} GB`,
    `<p>Token <strong>${token.id}</strong>（${token.contact ?? "无联系方式"}）过去 1 小时新增流量 <strong>${gb} GB</strong>。</p>
     <p>已用 ${token.traffic_used_gb.toFixed(2)} / ${token.traffic_limit_gb} GB。如需止血：rotate-uuid 或撤销 token。</p>`,
    `Token ${token.id}（${token.contact ?? "-"}）1 小时新增 ${gb} GB，已用 ${token.traffic_used_gb.toFixed(2)}/${token.traffic_limit_gb} GB。止血手段：rotate-uuid 或撤销。`
  );
}

/**
 * 节点月度配额检查（在 agent 上报节点流量后调用）。
 * 到 80% 告警一次；到 100% 告警并从订阅/同步摘除（由 isBudgetExhausted 生效）。
 * 账期跨月时调用方已重置 month_bytes / budget_alert_level。
 */
export async function checkNodeBudget(env: Env, node: Node): Promise<void> {
  if (!node.monthly_budget_gb) return;
  if (node.month_key !== currentMonthKey()) return;
  const usedGb = (node.month_bytes ?? 0) / 1024 ** 3;
  const pct = (usedGb / node.monthly_budget_gb) * 100;
  const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
  if (level === 0 || level <= (node.budget_alert_level ?? 0)) return;
  node.budget_alert_level = level;

  const base = `节点 <strong>${node.name}</strong>（${node.id}）本月已用 <strong>${usedGb.toFixed(1)} / ${node.monthly_budget_gb} GB</strong>（${pct.toFixed(0)}%）。`;
  if (level === 100) {
    await notifyAdmin(
      env,
      `节点月流量超支：${node.name} 已自动摘除`,
      `<p>${base}</p><p>已自动从订阅与节点同步中摘除，流量切到其他节点。恢复方法：提高 monthly_budget_gb 或等下月账期重置后自动恢复。</p>`,
      `节点 ${node.name}（${node.id}）本月已用 ${usedGb.toFixed(1)}/${node.monthly_budget_gb} GB，已自动摘除。恢复：提高配额或等下月重置。`
    );
  } else {
    await notifyAdmin(
      env,
      `节点月流量 80%：${node.name}`,
      `<p>${base}</p><p>到达 100% 时将自动摘除该节点。请留意 VPS 带宽余量。</p>`,
      `节点 ${node.name}（${node.id}）本月已用 ${usedGb.toFixed(1)}/${node.monthly_budget_gb} GB（80%）。到 100% 将自动摘除。`
    );
  }
}

/**
 * 节点失联检测（由 notify-scan 每 15min 调用）：
 * - last_seen_at 超过 5 分钟 → agent 失联（可能 Xray 仍在免密跑量）
 * - 心跳正常但 stats_updated_at 超过 5 分钟 → Xray 统计异常
 * 恢复后自动清零告警标记。
 */
export async function checkNodeHealth(env: Env, nodes: Node[]): Promise<boolean> {
  const now = Date.now();
  const STALE_MS = 5 * 60_000;
  let changed = false;
  for (const node of nodes) {
    if (!node.active) continue;
    const agentStale = (node.last_seen_at ?? 0) < now - STALE_MS;
    const statsStale = !agentStale && (node.stats_updated_at ?? 0) < now - STALE_MS;
    const unhealthy = agentStale || statsStale;

    if (unhealthy && (node.offline_alerted_at ?? 0) < now - 6 * 3_600_000) {
      node.offline_alerted_at = now;
      changed = true;
      const kind = agentStale ? "agent 失联" : "Xray 统计异常";
      await notifyAdmin(
        env,
        `节点${kind}：${node.name}`,
        `<p>节点 <strong>${node.name}</strong>（${node.id}）${kind}，超过 5 分钟未上报。</p>
         <p>注意：agent 失联期间若 Xray 仍在运行，用户流量将不被记账（可超量使用）。请尽快登录 ${node.host} 检查 vpn-agent / xray 服务。</p>`,
        `节点 ${node.name}（${node.id}）${kind} 超过 5 分钟。agent 失联期间流量不记账，请尽快检查 ${node.host}。`
      );
    } else if (!unhealthy && node.offline_alerted_at) {
      node.offline_alerted_at = undefined;
      changed = true;
    }
  }
  return changed;
}
