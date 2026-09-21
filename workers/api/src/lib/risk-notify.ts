/**
 * 风险检测与客户提醒
 *
 * 触发点：/api/agent/traffic（结算事件）
 * 幂等：token.notify_log 记录每类提醒的发送时间，同类提醒不重复发送
 *   - exhausted / multi_device：每个 token 只发一次
 *
 * 提醒类邮件现状：traffic_80（流量 80%）、month80（月度配额预警）、borrow_N（预支提醒）
 * 等预警类邮件已全部下线；保留的交易/安全类触达：
 *   - trial_convert（试用转化）——试用到期/流量耗尽时发一次性的同 token 充值引导；
 *   - expire_24h（付费 token 到期前 24h 续费提醒，带免登录续费按钮，notify-scan 触发）；
 *   - exhausted / multi_device / 接入地点变更等安全类提醒。
 * 两条 trial_convert 触发路径共用幂等键，只发一次。
 */

import { isTrialPlan, type Node, type Plan, type Presence, type Token } from "../../../../shared/types";
import { createMagicTicket } from "./accounts";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { getPlans } from "./kv";
import { currentMonthKey } from "./nodes";
import { siteUrl } from "./site-url";
import type { Env } from "../types";

/** 在售个人付费套餐（排除试用与企业套餐），转化邮件里列价格用 */
const paidPlans = (plans: Plan[]): Plan[] =>
  plans.filter((p) => p.price_cny > 0 && !isTrialPlan(p.id) && !p.id.startsWith("plan_biz"));

function shell(env: Env, title: string, bodyHtml: string, bodyText: string, cta?: { url: string; label: string }) {
  const ctaUrl = cta?.url ?? `${siteUrl(env)}/tokens`;
  const ctaLabel = cta?.label ?? "查看我的 Token";
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
      <a href="${ctaUrl}" style="display: inline-block; background: #0ea5e9; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 500;">${ctaLabel}</a>
    </div>
  </div>
  <p style="margin-top: 24px; font-size: 13px; color: #94a3b8; text-align: center;">
    本邮件由 GameBoost 自动发送，请勿直接回复。如有疑问请联系售后。
  </p>
</body>
</html>
  `.trim();
  const text = `${title}\n\n${bodyText}\n\n${ctaLabel}：${ctaUrl}\n\n本邮件由 GameBoost 自动发送，如有疑问请联系售后。`;
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

/**
 * 试用转化邮件（一次性）：试用到期（notify-scan 翻转 expired）或试用流量提前耗尽时发送。
 * 此刻剩余额度本就为零，不谈结转，只讲三件事：邮箱保留（token 可失效，邮箱永是续用凭证）、
 * 随时可用它付费继续用、现在开通送一个月。免登录链接直达管理页。
 * 两条触发路径共用幂等键 notify_log.trial_convert，不重复打扰；
 * 调用方负责在返回后把 notify_log 变更键级合并写回（与 checkTokenRisks 同一约定）。
 */
export async function sendTrialConvertEmail(env: Env, token: Token): Promise<boolean> {
  if (!shouldSendEmail(token.contact)) return false;
  token.notify_log = token.notify_log ?? {};
  if (token.notify_log.trial_convert) return false;
  const ticket = await createMagicTicket(env, token.contact!, token.id, "login");
  const magicUrl = `${siteUrl(env)}/auth/magic?ticket=${ticket}`;
  // 首页已弱化付费，价格决策信息直接带进邮件，用户不用回站找
  const paid = paidPlans(await getPlans(env));
  const priceListHtml =
    paid.length > 0
      ? `<p style="margin:12px 0 4px;font-weight:500;">套餐价格：</p>
     <ul style="margin:0;padding-left:20px;color:#334155;">
       ${paid.map((p) => `<li>${p.name} <strong>¥${p.price_cny}</strong>${p.pitch ? `（${p.pitch}）` : ""}</li>`).join("\n       ")}
     </ul>`
      : "";
  const priceListText =
    paid.length > 0
      ? `\n套餐价格：${paid.map((p) => `${p.name} ¥${p.price_cny}${p.pitch ? `（${p.pitch}）` : ""}`).join("；")}`
      : "";
  const { subject, html, text } = shell(
    env,
    "体验已结束，现在开通送一个月",
    `<p>你好，你的免费体验 Token（<strong>${token.id}</strong>）的额度已用完或已到期。</p>
     <p>你的邮箱会保留：<strong>随时可以用它付费继续用</strong>；90 天内原 Token 可直接充值，订阅链接和已配置的设备都不用动。</p>
     <p>现在开通付费套餐，<strong>额外赠送一个月（30 天）</strong>。</p>
     ${priceListHtml}
     <p style="color:#64748b;font-size:13px;">上面的按钮链接 72 小时内有效；过期了也没关系，随时可到 <a href="${siteUrl(env)}/recover" style="color:#0ea5e9;">找回页面</a> 输入邮箱重新获取。</p>`,
    `你的免费体验 Token（${token.id}）的额度已用完或已到期。\n你的邮箱会保留：随时可以用它付费继续用；90 天内原 Token 可直接充值，订阅链接和设备不变。\n现在开通付费套餐，额外赠送一个月（30 天）。${priceListText}\n按钮链接 72 小时内有效；过期后可到找回页面重新获取：${siteUrl(env)}/recover`,
    { url: magicUrl, label: "免登录开通，送一个月" }
  );
  const res = await sendMail(env, token.contact!, subject, html, text);
  if (res.ok) {
    token.notify_log.trial_convert = Date.now();
    console.log(`[risk] notified ${token.id} kind=trial_convert`);
  } else {
    console.error(`[risk] notify failed ${token.id} kind=trial_convert: ${res.error}`);
  }
  return res.ok;
}

/**
 * 付费 token 到期前 24 小时续费提醒（一次性，幂等键 expire_24h）：
 * notify-scan 每 15 分钟扫到 active 付费 token 进入最后 24 小时窗口时发送。
 * 带 72h 免登录链接直达管理页续费；过期后仍可凭邮箱从找回页重新进入。
 * 调用方负责在返回后把 notify_log 变更键级合并写回（与 checkTokenRisks 同一约定）。
 */
export async function sendExpire24hEmail(env: Env, token: Token): Promise<boolean> {
  if (!shouldSendEmail(token.contact)) return false;
  token.notify_log = token.notify_log ?? {};
  if (token.notify_log.expire_24h) return false;
  const ticket = await createMagicTicket(env, token.contact!, token.id, "login");
  const magicUrl = `${siteUrl(env)}/auth/magic?ticket=${ticket}`;
  const expiry = new Date(token.expires_at!).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const { subject, html, text } = shell(
    env,
    "你的套餐将于 24 小时内到期",
    `<p>你好，你的 Token（<strong>${token.id}</strong>）将于 <strong>${expiry}</strong>（北京时间）到期。</p>
     <p>到期后服务自动停止；点击下方按钮免登录进入管理页即可续费，订阅链接和已配置的设备都不受影响。</p>
     <p style="color:#64748b;font-size:13px;">按钮链接 72 小时内有效；过期后可到 <a href="${siteUrl(env)}/recover" style="color:#0ea5e9;">找回页面</a> 输入邮箱重新获取。</p>`,
    `你的 Token（${token.id}）将于 ${expiry}（北京时间）到期。\n到期后服务自动停止；免登录进入管理页即可续费，订阅链接和设备不受影响。\n按钮链接 72 小时内有效；过期后可到找回页面重新获取：${siteUrl(env)}/recover`,
    { url: magicUrl, label: "免登录续费" }
  );
  const res = await sendMail(env, token.contact!, subject, html, text);
  if (res.ok) {
    token.notify_log.expire_24h = Date.now();
    console.log(`[risk] notified ${token.id} kind=expire_24h`);
  } else {
    console.error(`[risk] notify failed ${token.id} kind=expire_24h: ${res.error}`);
  }
  return res.ok;
}

/**
 * 管理员主动触达用户的服务邮件（公告/售后；人工触发，无幂等键）：
 * 带 72h 免登录链接直达管理页。bodyHtml 由调用方负责转义拼接。
 */
export async function sendServiceEmail(
  env: Env,
  token: Token,
  title: string,
  bodyHtml: string,
  bodyText: string
): Promise<boolean> {
  if (!shouldSendEmail(token.contact)) return false;
  const ticket = await createMagicTicket(env, token.contact!, token.id, "login");
  const magicUrl = `${siteUrl(env)}/auth/magic?ticket=${ticket}`;
  const { subject, html, text } = shell(env, title, bodyHtml, bodyText, {
    url: magicUrl,
    label: "免登录查看我的 Token",
  });
  const res = await sendMail(env, token.contact!, subject, html, text);
  if (!res.ok) console.error(`[risk] service mail failed ${token.id}: ${res.error}`);
  return res.ok;
}

/**
 * 在 token 数据更新后调用：检查流量耗尽与多设备风险，必要时提醒客户。
 * 注意：本函数可能修改 notify_log；调用方负责在此函数返回后把 notify_log 变更
 * 键级合并写回（mergeTokenSettlement），且必须在结算字段写库之后调用。
 */
export async function checkTokenRisks(env: Env, token: Token): Promise<void> {
  const limit = token.traffic_limit_gb ?? 0;
  const used = token.traffic_used_gb ?? 0;

  // 客户要求只保留交易/安全类邮件，流量 80% 预警（traffic_80）已下线

  // 流量耗尽：进入 48 小时宽限期，优先引导续费，不立即断连
  if (limit > 0 && used >= limit) {
    // 试用 token 流量提前跑完：与到期共用转化邮件（同一幂等键），不发普通续费提醒
    if (isTrialPlan(token.plan_id)) {
      await sendTrialConvertEmail(env, token);
    } else {
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
  }

  // 疑似多设备/分享使用
  if (token.multi_device_detected_at) {
    await notifyOnce(
      env,
      token,
      "multi_device",
      "账号安全提醒：检测到多处同时使用",
      `<p>你好，系统检测到你的 Token（<strong>${token.id}</strong>）于 ${new Date(token.multi_device_detected_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} 在<strong>多个节点同时在线</strong>。</p>
       <p>如果你自己在多台设备上使用，可以忽略本邮件；否则说明你的订阅链接可能已泄露，他人正在盗用你的流量。</p>
       <p><strong>建议措施：</strong>联系售后重置连接凭证（UUID）。重置后旧凭证立即失效，你的设备更新订阅即可恢复，盗用者将被断开。</p>`,
      `检测到你的 Token（${token.id}）在多个节点同时在线。\n如果是你自己多台设备使用可忽略；否则订阅链接可能已泄露。\n建议：联系售后重置连接凭证（UUID），旧凭证将立即失效。`
    );
  }
}

// ---------- 管理员告警 ----------

/** IP 归属地查询结果（ipwho.is 免费接口） */
export interface IpGeo {
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
}

/** IP 归属地查询（ipwho.is 免费接口，3s 超时；失败返回 null 不影响主流程） */
export async function lookupIpGeo(ip: string): Promise<IpGeo | null> {
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
    return {
      country: data.country,
      region: data.region,
      city: data.city,
      isp: data.connection?.isp,
    };
  } catch {
    return null;
  }
}

/** 位置键：国家/省份/城市拼接。不含 isp——运营商标签抖动（家宽换 IP、WiFi 切 4G）不算接入地点变更 */
export function geoLocationKey(geo: IpGeo): string {
  return [geo.country, geo.region, geo.city].filter(Boolean).join(" / ");
}

/** 邮件展示用归属地：位置 + 运营商 */
function geoDisplay(geo: IpGeo): string {
  return [geo.country, geo.region, geo.city, geo.isp].filter(Boolean).join(" / ");
}

/** 接入地点变更判定结果 */
export interface IpLocationChange {
  /** 是否按「接入地点变更」处理（需要发邮件） */
  changed: boolean;
  /** 上次确认的接入位置键（首次建基线时无） */
  oldLocation?: string;
  /** 本次接入位置键（geo 查询失败时无） */
  newLocation?: string;
  /** 新 IP 归属地展示串（含运营商，查询失败时无） */
  display?: string;
}

/**
 * 接入地点变更判定：查新接入 IP 的地理位置，与 presence.active_geo[key] 基线比较。
 * - 首次建基线（无基线）：不提醒，只记录；
 * - 位置相同（同城动态 IP 漂移）：不提醒，基线原值不变；
 * - 位置不同：提醒并更新基线；
 * - geo 查询失败：保守按「位置不同」处理（安全提醒宁可误发），但基线不动，
 *   等下次查询成功再校准，避免把失败当新位置固化下来。
 * 会原地更新 presence.active_geo；调用方负责随后 savePresenceIfChanged 落库。
 */
export async function resolveIpLocationChange(
  presence: Presence,
  key: string,
  ips: string[]
): Promise<IpLocationChange> {
  const prev = presence.active_geo?.[key];
  const geo = await lookupIpGeo(ips[0]);
  const cur = geo ? geoLocationKey(geo) : "";
  if (!geo || !cur) {
    // 查询失败：有基线才提醒（无基线 = 首次使用，没有任何变更证据）
    return { changed: prev !== undefined, oldLocation: prev };
  }
  presence.active_geo = presence.active_geo ?? {};
  presence.active_geo[key] = cur;
  if (prev === undefined) return { changed: false, newLocation: cur, display: geoDisplay(geo) };
  return {
    changed: prev !== cur,
    oldLocation: prev,
    newLocation: cur,
    display: geoDisplay(geo),
  };
}

/**
 * 接入地点变更提醒：接入地理位置（城市级）发生变化时邮件通知本人。
 * 同城换 IP（家宽动态漂移、WiFi 切 4G）由 resolveIpLocationChange 拦下，不会走到这里。
 * 限流：每个 token 12 小时最多一封（差旅/跨省移动属常态，不能刷屏）。
 * 调用方负责把 notify_log 变更键级合并写回（mergeTokenSettlement）。
 */
export async function notifyIpChange(
  env: Env,
  token: Token,
  ips: string[],
  loc: IpLocationChange
): Promise<void> {
  if (ips.length === 0 || !shouldSendEmail(token.contact)) return;
  token.notify_log = token.notify_log ?? {};
  const now = Date.now();
  if (now - (token.notify_log["ip_change"] ?? 0) < 12 * 3_600_000) return;

  const ip = ips[0];
  const oldText = loc.oldLocation ?? "未知";
  const newText = loc.newLocation ?? "归属地查询失败";
  const ipText = loc.display ? `${ip}（${loc.display}）` : ip;
  const manageUrl = `${siteUrl(env)}/tokens?id=${token.id}`;
  const { subject, html, text } = shell(
    env,
    "账号安全提醒：接入地点发生变更",
    `<p>你好，你的 Token（<strong>${token.id}</strong>）的接入地点刚刚发生变更：</p>
     <p style="font-size:16px;">${oldText} → <strong>${newText}</strong></p>
     <p>新接入 IP：<strong>${ipText}</strong></p>
     <p>如果是你本人换了城市/网络（如出差、跨省移动），可忽略本邮件；否则说明订阅链接可能已泄露，他人正在盗用你的流量。</p>
     <p><strong>你可以自己处理：</strong>登录 <a href="${manageUrl}">Token 管理页</a>，在「接入 IP 统计」里点击该 IP 旁的「封禁」，该 IP 将在 30 秒内被所有节点拒绝连接；误封可随时解除。</p>`,
    `你的 Token（${token.id}）接入地点发生变更：${oldText} → ${newText}，新 IP：${ipText}。\n如果是你本人换城市/网络可忽略；否则订阅可能泄露。\n处理：登录管理页 ${manageUrl} 在「接入 IP 统计」中封禁该 IP（30 秒内全节点生效，可随时解除）。`
  );
  const res = await sendMail(env, token.contact, subject, html, text);
  if (res.ok) {
    token.notify_log["ip_change"] = now;
    // 用户接入 IP 属敏感信息，日志只记条数不记具体 IP
    console.log(`[risk] ip-change notified ${token.id} ip_count=${ips.length}`);
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

/** 流量暴增告警阈值：单 token 1 小时内新增 3 GB */
export const SPIKE_WINDOW_MS = 3_600_000;
export const SPIKE_THRESHOLD_BYTES = 3 * 1024 ** 3;

/**
 * 流量暴增检测的纯记账部分（无 await，在 token 写库前调用）：
 * 更新速率窗口；越过阈值且 24h 内未处置过时记录 notify_log.traffic_spike 并返回 true，
 * 调用方随后在写库段按分级处置并入结算 patch（体验：status="revoked"；付费：abuse_machine 标记），
 * 写库之后调用 sendSpikeAlert 通知站长。
 */
export function updateSpikeWindow(token: Token, deltaBytes: number, now = Date.now()): boolean {
  if (deltaBytes <= 0) return false;
  if (!token.rate_window_start || now - token.rate_window_start > SPIKE_WINDOW_MS) {
    token.rate_window_start = now;
    token.rate_window_bytes = 0;
  }
  token.rate_window_bytes = (token.rate_window_bytes ?? 0) + deltaBytes;
  if (token.rate_window_bytes < SPIKE_THRESHOLD_BYTES) return false;

  const last = token.notify_log?.traffic_spike ?? 0;
  if (now - last < 24 * 3_600_000) return false;
  token.notify_log = token.notify_log ?? {};
  token.notify_log.traffic_spike = now;
  return true;
}

/**
 * 流量暴增处置通知（只发站长，含 await）：必须在 token 结算字段写库之后调用，
 * 避免读-改-写之间穿插邮件 await 导致并发覆盖。
 * 处置动作本身由调用方在结算写库段完成（体验：status="revoked"；付费：abuse_machine 标记），
 * 本函数只负责按分级发通知。不通知客户：暴增多是滥用/泄露，惊动对方只会换号重来。
 */
export async function sendSpikeAlert(env: Env, token: Token): Promise<void> {
  const gb = ((token.rate_window_bytes ?? 0) / 1024 ** 3).toFixed(1);
  const trial = isTrialPlan(token.plan_id);
  console.log(`[risk] traffic spike ${trial ? "revoked" : "rate-limited"} ${token.id}: ${gb} GB in 1h`);

  const base = `Token <strong>${token.id}</strong>（${token.contact ?? "无联系方式"}）过去 1 小时新增流量 <strong>${gb} GB</strong>（阈值 3GB）`;
  const usage = `已用 ${token.traffic_used_gb.toFixed(2)} / ${token.traffic_limit_gb} GB。`;
  await notifyAdmin(
    env,
    trial
      ? `流量暴增已自动吊销：${token.id} 1 小时 ${gb} GB`
      : `流量暴增已限速：${token.id} 1 小时 ${gb} GB`,
    trial
      ? `<p>${base}，已自动吊销并全节点踢除。</p>
         <p>${usage}</p>
         <p>误杀恢复：管理端把 token 状态改回 active（24h 幂等窗口内再次暴增不会重复处置，必要时一并清除 notify_log.traffic_spike）。</p>`
      : `<p>${base}，已转<strong>每日 500MB 限速</strong>（abuse_machine 标记），超限暂停到 24h 窗口重置，不吊销不断线。</p>
         <p>${usage}</p>
         <p>误伤解除：管理端清除 token 的 abuse_machine 字段。</p>`,
    trial
      ? `Token ${token.id}（${token.contact ?? "-"}）1 小时新增 ${gb} GB（阈值 3GB），已自动吊销并全节点踢除。${usage}误杀恢复：管理端把状态改回 active。`
      : `Token ${token.id}（${token.contact ?? "-"}）1 小时新增 ${gb} GB（阈值 3GB），已转每日 500MB 限速（abuse_machine 标记），超限暂停到 24h 窗口重置。${usage}误伤解除：管理端清除 abuse_machine 字段。`
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
