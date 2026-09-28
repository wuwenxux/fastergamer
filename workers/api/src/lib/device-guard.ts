/**
 * 设备级防护：单凭证多地并发时自动阻断新接入 IP（付费 token 专用）。
 *
 * 规则（与用户确认）：
 * - 换 IP 直接用（旧 IP 下线、新 IP 上线是顺序行为）：不触发任何判定；
 * - 同凭证并发 ≥2 个来源 IP，且持续 2 个结算周期确认后（吸收 WiFi↔5G 切换的瞬时双 IP），
 *   只自动阻断「新出现的 IP」（有历史基线的老 IP 不动，老设备不断线），邮件通知机主决策；
 * - 机主决策（管理页操作）：「允许」= 迁移流程——自动为新设备创建独立槽位（共用链接只能是
 *   过渡，长期必须一台设备一条凭证），被拦 IP 解封并记入该凭证的迁移过渡名单（7 天），
 *   引导新设备导入专属订阅链接；槽位已满则 409，阻断保持。「拒绝」= 保持阻断并停止重复提醒。
 *
 * 适用范围：付费个人 token（!isTrialPlan && !plan_biz*，流量包含在内——付费且最易被分享）；
 * 企业套餐排除（团队共享是设计用途），免费用户不做任何设备管理（免登录原则）。
 *
 * 关键设计决策：
 * 1. 阻断复用 token.blocked_ips 链路（authpush 快照 → agent iptables FG-BLOCK 链 DROP），
 *    不新增节点侧机制。代价：它是全局阻断——该 IP 对所有节点所有用户失效，同 NAT 出口
 *    的其他用户/设备会被误伤。因此必须配台账字段 token.device_guard 区分自动/手动阻断
 *   （手动封禁不进台账），管理页据此提供一键救济（允许/拒绝），并把误伤面在邮件里告知机主。
 * 2. 「新 IP」判定 = 与上周期基线对比：presence.active_ips[nodeKey] 是现成的逐周期基线，
 *    currIps - prevIps = 新 IP；基线为空的首次使用不判定。
 * 3. 持续确认用 presence.dg_pending 暂存首周期可疑新 IP；下周期并发仍 ≥2 且其中仍有
 *    在线者才执行阻断。presence 高频动态状态，读写走 savePresenceIfChanged 有变化才写。
 * 4. 迁移过渡名单（token/device 的 transition_ips，ip → 截止时间）：未到期视同白名单跳过
 *    判定；每次判定前核查到期项——仍活跃则移出名单按新 IP 重新走 pending→确认→阻断
 *   （防止两台设备长期共用一条凭证绕过槽位计量），已不活跃则静默移除（换绑完成/自然离开）。
 * 5. 作用域：检测是单节点内的 per-uuid 并发（ip_conns 按节点上报）；跨节点同凭证并发
 *    仍由 token 级 share-guard / 多地并发在线提醒覆盖，本功能不重复造。
 *
 * 写库纪律：结算路径的字段写必须走 mergeDeviceGuardFields 重读-合并补丁（与
 * mergeTokenSettlement 并发互不覆盖）；邮件 await 在写库之后；notify_log 原地改，
 * 由调用方（applyTrafficDelta 通知段末尾的集中比对）键级合并收走。
 * 用户操作端点（允许/拒绝）走整 JSON 写先例（tokens.ts 设备改名同款，低频无并发问题）。
 */
import { isTrialPlan } from "../../../../shared/types";
import type { Device, DeviceGuardEntry, Presence, Token } from "../../../../shared/types";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { getPlans, getTokenByUuid, saveDeviceIndex, saveToken, saveTokenValue } from "./kv";
import { lookupIpGeo, shell } from "./risk-notify";
import { siteUrl } from "./site-url";
import type { Env } from "../types";

/** 确认窗口：首周期记下可疑新 IP 后，隔这么久再看下周期（结算周期约 90s，3 分钟覆盖 2 个周期） */
export const DG_CONFIRM_MS = 3 * 60_000;
/** 机主通知邮件节流：同一 token 12h 最多一封（与 notifyIpChange 的 ip_change 节流同口径） */
export const DG_NOTIFY_THROTTLE_MS = 12 * 3_600_000;
/** 迁移过渡时长：「允许」后被拦 IP 视同白名单的时间，期内新设备应导入专属槽位链接 */
export const TRANSITION_MS = 7 * 86_400_000;
/** blocked_ips 总量上限（与 tokens.ts 手动封禁端点同一上限）：满时自动阻断放弃并记日志 */
export const BLOCKED_IPS_MAX = 50;

/** 设备防护字段的「重读-合并」补丁；device_guard 值 null = 删除该键 */
export interface DeviceGuardPatch {
  /** 追加进 blocked_ips（与现有取并集） */
  blocked_ips_add?: string[];
  /** 台账键级合并（key = 被阻断 IP） */
  device_guard?: Record<string, DeviceGuardEntry | null>;
  /** 迁移过渡名单按键合并（按凭证 uuid 定位：主 uuid → token.transition_ips，槽位 → 该 device.transition_ips） */
  transition_ips?: { uuid: string; set?: Record<string, number>; remove?: string[] };
}

/**
 * 设备防护字段的「重读-合并」写（仿 mergeShareFields）：重新读取 token 最新副本，
 * blocked_ips 数组取并集、device_guard / transition_ips 按键合并，与结算路径并发时互不覆盖。
 * 并集超 BLOCKED_IPS_MAX 时整批放弃（不写 blocked_ips 也不记台账），返回 false 并记日志——
 * 阻断不生效却记台账会让管理页出现「待授权」假条目。
 */
export const mergeDeviceGuardFields = async (env: Env, uuid: string, patch: DeviceGuardPatch): Promise<boolean> => {
  const fresh = await getTokenByUuid(env, uuid);
  if (!fresh) return false;
  if (patch.blocked_ips_add?.length) {
    const union = [...new Set([...(fresh.blocked_ips ?? []), ...patch.blocked_ips_add])];
    if (union.length > BLOCKED_IPS_MAX) {
      console.error(
        `[device-guard] ${fresh.id} blocked_ips 已满 ${BLOCKED_IPS_MAX} 条，放弃自动阻断 ${patch.blocked_ips_add.length} 个 IP`
      );
      return false;
    }
    fresh.blocked_ips = union;
  }
  if (patch.device_guard) {
    fresh.device_guard = { ...fresh.device_guard };
    for (const [k, v] of Object.entries(patch.device_guard)) {
      if (v === null) delete fresh.device_guard[k];
      else fresh.device_guard[k] = v;
    }
    if (Object.keys(fresh.device_guard).length === 0) delete fresh.device_guard;
  }
  if (patch.transition_ips) {
    const { uuid: credUuid, set, remove } = patch.transition_ips;
    // 涉事凭证定位：主 uuid 落 token，槽位 uuid 落对应 device；槽位已删则本次跳过（凭证不在名单无意义）
    const target: Token | Device | undefined =
      credUuid === fresh.uuid ? fresh : fresh.devices?.find((d) => d.uuid === credUuid);
    if (target) {
      const cur = { ...(target.transition_ips ?? {}) };
      for (const [k, v] of Object.entries(set ?? {})) cur[k] = v;
      for (const k of remove ?? []) delete cur[k];
      if (Object.keys(cur).length > 0) target.transition_ips = cur;
      else delete target.transition_ips;
    }
  }
  await saveTokenValue(env, fresh);
  return true;
};

/** 邮件/台账展示用归属地：查 geo 缓存（失败返回 undefined，不影响主流程） */
const geoDisplayOf = async (env: Env, ip: string): Promise<string | undefined> => {
  const g = await lookupIpGeo(env, ip);
  return g ? [g.country, g.region, g.city, g.isp].filter(Boolean).join(" / ") : undefined;
};

/** 机主通知邮件：新 IP 已自动阻断，引导到管理页决策（允许=建槽迁移 / 保持拒绝）。节流 12h */
async function sendDeviceGuardEmail(
  env: Env,
  token: Token,
  deviceName: string,
  blocked: { ip: string; geo?: string }[],
  prevIps: string[],
  now: number
): Promise<void> {
  if (!shouldSendEmail(token.contact)) return;
  token.notify_log = token.notify_log ?? {};
  if (now - (token.notify_log.device_guard ?? 0) < DG_NOTIFY_THROTTLE_MS) return;
  const fmt = (ip: string, geo?: string) => `${ip}${geo ? `（${geo}）` : ""}`;
  const oldLines = await Promise.all(prevIps.map(async (ip) => fmt(ip, await geoDisplayOf(env, ip))));
  const newListHtml = blocked.map((b) => `<li>${fmt(b.ip, b.geo)}</li>`).join("\n       ");
  const newListText = blocked.map((b) => fmt(b.ip, b.geo)).join("；");
  const manageUrl = `${siteUrl(env)}/tokens?id=${token.id}`;
  const { subject, html, text } = shell(
    env,
    "账号安全提醒：检测到异常接入，已自动拦截新 IP",
    `<p>你好，系统检测到你的 Token（<strong>${token.id}</strong>）的「${deviceName}」凭证正在<strong>多个来源 IP 同时在线</strong>，且持续存在（非一次网络切换）：</p>
     <ul style="margin:8px 0;padding-left:20px;color:#334155;">
       ${newListHtml}
     </ul>
     <p>其中原有接入 ${oldLines.join("、") || "（无）"} 未受影响；<strong>上面列出的新 IP 已被自动拦截</strong>，无法再连接任何节点。</p>
     <p><strong>请到管理页做出决定：</strong>如果是你本人的新设备，点「允许」——系统会为它创建一个独立槽位（7 天过渡期内该 IP 可继续用旧链接，请尽快让新设备导入专属链接）；如果不是本人使用，点「保持拒绝」，并建议重新生成订阅链接（旧链接立即失效）。</p>
     <p style="color:#64748b;font-size:13px;">注意：拦截对 IP 全局生效，若该 IP 是多人共享的出口网络（如公司/校园网），同网络的其他设备也会无法连接，「允许」即可恢复。</p>
     <p style="color:#64748b;font-size:13px;">管理页：<a href="${manageUrl}" style="color:#0ea5e9;">${manageUrl}</a></p>`,
    `检测到你的 Token（${token.id}）的「${deviceName}」凭证在多个来源 IP 同时在线，新 IP ${newListText} 已被自动拦截。\n请到管理页决定：本人新设备点「允许」（自动创建独立槽位，7 天过渡期内请让新设备导入专属链接），非本人点「保持拒绝」并建议重新生成订阅链接：${manageUrl}\n注意：拦截对 IP 全局生效，共享出口网络下同网络设备会一并无法连接。`
  );
  const res = await sendMail(env, token.contact, subject, html, text);
  if (res.ok) {
    token.notify_log.device_guard = now;
    // 用户接入 IP 属敏感信息，日志只记条数不记具体 IP
    console.log(`[device-guard] notified ${token.id} blocked=${blocked.length}`);
  } else {
    console.error(`[device-guard] mail failed ${token.id}: ${res.error}`);
  }
}

/** 该凭证的过渡名单读取（主 uuid 看 token，槽位看 device） */
const transitionOf = (token: Token, device: Device | undefined): Record<string, number> | undefined =>
  device ? device.transition_ips : token.transition_ips;

/**
 * 单凭证（主 uuid 或某设备槽位 uuid）的多地并发判定，在结算路径上调用。
 * 参数 currIps/prevIps 由调用方快照（prevIps 必须在 active_ips 基线被覆写前取）。
 * 原地维护 presence.dg_pending；返回 true 表示发生了授权相关变更（新增阻断），
 * 调用方应推送授权刷新（blocked_ips 走快照下发）并补一次 savePresenceIfChanged。
 */
export async function evaluateDeviceConns(
  env: Env,
  token: Token,
  device: Device | undefined,
  uuid: string,
  currIps: string[],
  prevIps: string[],
  presence: Presence,
  now: number
): Promise<boolean> {
  // 范围门控：只覆盖付费个人 token；试用（免登录无管理入口）与企业（团队共享是设计用途）不判定
  if (isTrialPlan(token.plan_id) || token.plan_id.startsWith("plan_biz")) return false;

  // 迁移过渡核查（判定前先做，不受并发数门控影响）：该凭证 transition_ips 里已到期的 IP——
  // 仍在本周期活跃集合中：移出名单并按「新 IP」重新走 pending→确认→阻断（长期共用必须迁移）；
  // 已不活跃：静默移除（新设备已换绑专属槽位，或自然离开）。结算路径写走合并补丁
  const trans = { ...(transitionOf(token, device) ?? {}) };
  const expired = Object.entries(trans).filter(([, until]) => until <= now).map(([ip]) => ip);
  let expiredActive: string[] = [];
  if (expired.length > 0) {
    expiredActive = expired.filter((ip) => currIps.includes(ip));
    await mergeDeviceGuardFields(env, token.uuid, { transition_ips: { uuid, remove: expired } });
    for (const ip of expired) delete trans[ip]; // 本地副本同步，本周期后续判定用新值
  }

  // 白名单（allowed_ips，含一期限量遗留）与未到期过渡 IP 都跳过判定
  const allowed = new Set(device ? (device.allowed_ips ?? []) : (token.allowed_ips ?? []));
  for (const ip of Object.keys(trans)) allowed.add(ip);
  const effective = currIps.filter((ip) => !allowed.has(ip));
  const pending = presence.dg_pending?.[uuid];
  const clearPending = () => {
    if (presence.dg_pending && pending) {
      delete presence.dg_pending[uuid];
      if (Object.keys(presence.dg_pending).length === 0) delete presence.dg_pending;
    }
  };

  // 并发不足 2 个来源：顺序换 IP 或已回落单 IP，撤销可疑标记
  if (effective.length < 2) {
    clearPending();
    return false;
  }

  // 首次使用无基线（prevIps 为空）：无法区分新老 IP，不判定也不记 pending。
  // 例外：到期仍活跃的过渡 IP 是确证可疑（已给过 7 天迁移窗口），不受基线限制
  if (prevIps.length === 0 && expiredActive.length === 0) return false;
  const newIps =
    prevIps.length === 0
      ? [...expiredActive]
      : [...new Set([...effective.filter((ip) => !prevIps.includes(ip)), ...expiredActive])];

  if (!pending) {
    // 并发 ≥2 且出现可疑 IP：记下首周期可疑集，等下周期确认（吸收 WiFi↔5G 瞬时双 IP）
    if (newIps.length > 0) {
      presence.dg_pending = presence.dg_pending ?? {};
      presence.dg_pending[uuid] = { at: now, ips: newIps };
    }
    return false;
  }

  // 已有可疑记录：未到确认窗口，或可疑 IP 已全部离线（只是一次网络切换）→ 重新记/清除
  const stillOnline = pending.ips.filter((ip) => effective.includes(ip));
  if (now - pending.at < DG_CONFIRM_MS) return false;
  if (stillOnline.length === 0) {
    if (newIps.length > 0) {
      presence.dg_pending![uuid] = { at: now, ips: newIps };
    } else {
      clearPending();
    }
    return false;
  }

  // 持续确认：只阻断仍在在线的新 IP（老 IP 不动，老设备不断线）
  const blocked = await Promise.all(
    stillOnline.map(async (ip) => ({ ip, geo: await geoDisplayOf(env, ip) }))
  );
  const entries: Record<string, DeviceGuardEntry> = {};
  for (const b of blocked) entries[b.ip] = { uuid, at: now, status: "pending", ...(b.geo ? { geo: b.geo } : {}) };
  const written = await mergeDeviceGuardFields(env, token.uuid, {
    blocked_ips_add: stillOnline,
    device_guard: entries,
  });
  clearPending();
  if (!written) return false; // 封禁列表已满：已记日志，不发邮件（没有实际阻断）

  // 邮件机主决策（await 在写库之后；notify_log 原地改由调用方集中比对收走）
  const deviceName = device?.name ?? "主设备";
  await sendDeviceGuardEmail(env, token, deviceName, blocked, prevIps, now);
  return true;
}

/** 机主「允许」的结果：not_found = 该 IP 不在台账；slots_full = 设备数已达上限 */
export interface GuardAllowResult {
  ok: boolean;
  reason?: "not_found" | "slots_full";
  /** 为新设备自动创建的槽位（ok 时必有） */
  device?: Device;
  /** 迁移过渡截止时间（unix ms，ok 时必有） */
  transition_until?: number;
}

/**
 * 机主决策「允许」= 迁移流程：共用链接只能是过渡，长期必须一台设备一条凭证。
 * 1. 有效设备数余量检查（token.max_devices ?? 套餐 ?? 2，已用 = 1 + devices.length），
 *    无余量返回 slots_full（调用方 409），阻断与台账都不动；
 * 2. 自动创建新设备槽位（名字默认「新设备 · {城市}」，城市取台账 geo），先建槽成功再解封——
 *    建槽失败（抛错）时 blocked_ips / 台账保持原样，不残留半状态；
 * 3. 被拦 IP 解封但不进永久白名单：记入涉事凭证的 transition_ips（7 天），
 *    到期仍活跃由 evaluateDeviceConns 重新走 pending→确认→阻断；
 * 4. 台账条目删除。整 JSON 写（tokens.ts 设备改名同款先例：用户操作低频，无并发覆盖问题）。
 */
export const allowGuardedIp = async (env: Env, token: Token, ip: string): Promise<GuardAllowResult> => {
  const entry = token.device_guard?.[ip];
  if (!entry) return { ok: false, reason: "not_found" };

  const plans = await getPlans(env);
  const plan = plans.find((p) => p.id === token.plan_id);
  // token 级 max_devices 优先（管理员售后单独放宽），否则按套餐，缺省 2（与加设备端点同口径）
  const maxDevices = token.max_devices ?? plan?.max_devices ?? 2;
  if (1 + (token.devices?.length ?? 0) >= maxDevices) {
    return { ok: false, reason: "slots_full" };
  }

  // 先建槽：槽位名取台账归属地城市（geo 格式「国家 / 省 / 市 / 运营商」），无则「新设备」
  const city = entry.geo?.split("/").map((s) => s.trim())[2];
  const device: Device = {
    id: `dv_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    uuid: crypto.randomUUID(),
    name: city ? `新设备 · ${city}` : "新设备",
    traffic_used_gb: 0,
    created_at: Date.now(),
  };
  token.devices = [...(token.devices ?? []), device];
  await saveToken(env, token);
  await saveDeviceIndex(env, device.uuid, token.id);

  // 建槽成功后再解封：被拦 IP 记入涉事凭证的迁移过渡名单（7 天），不进永久白名单
  token.blocked_ips = (token.blocked_ips ?? []).filter((x) => x !== ip);
  if (token.blocked_ips.length === 0) delete token.blocked_ips;
  const until = Date.now() + TRANSITION_MS;
  const transTarget: Token | Device | undefined =
    entry.uuid === token.uuid ? token : token.devices?.find((d) => d.uuid === entry.uuid);
  // 涉事槽位可能已被删除（凭证不在授权名单，过渡无意义）：仅解封 + 清台账
  if (transTarget) {
    transTarget.transition_ips = { ...(transTarget.transition_ips ?? {}), [ip]: until };
  }
  delete token.device_guard![ip];
  if (Object.keys(token.device_guard!).length === 0) delete token.device_guard;
  await saveToken(env, token);
  return { ok: true, device, transition_until: until };
};

/**
 * 机主决策「拒绝」：台账 status → denied（阻断保持，不再重复提醒；blocked_ips 不动）。
 * 返回 false 表示该 IP 不在台账。
 */
export const denyGuardedIp = async (env: Env, token: Token, ip: string): Promise<boolean> => {
  const entry = token.device_guard?.[ip];
  if (!entry) return false;
  entry.status = "denied";
  await saveToken(env, token);
  return true;
};
