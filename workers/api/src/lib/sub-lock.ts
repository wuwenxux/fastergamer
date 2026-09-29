/**
 * 订阅设备锁：每条订阅链接（主 uuid / 设备槽位 uuid 各自独立）绑定首个拉取它的
 * 客户端家族指纹；不同家族指纹再拉取 → 拒绝下发，单设备套餐另邮件通知机主
 * （多设备套餐出现多家族是正常用法，只拒发不通知）。
 *
 * 背景：订阅链接被转发后多人持有，流量/并发维度只能事后发现；设备锁在订阅下发
 * 这一必经之路上直接拦住第二个客户端。指纹取「客户端家族」而非 UA 原文——
 * 客户端升级版本号不掉绑定。
 *
 * 适用范围：仅单设备套餐（试用/流量包，有效 max_devices = 1）生效——
 * 多设备套餐（个人付费/企业）同一用户多台设备拉同一链接是正常用法，
 * 任何家族都放行；recordBinding 仍照常记录指纹（管理页「订阅客户端」展示用），
 * 只是不再产生 403 与冲突邮件（邮件门控同样只发单设备套餐，两处口径一致）。
 *
 * 存储：presence:{主uuid}.sub_fps（订阅 uuid → 指纹 → 绑定信息），与 sub_fetches 并存。
 * 容量每链接 1 个指纹；单设备套餐受众没有建槽入口，冲突邮件文案明说「仅支持 1 台设备」
 * 并引导购买多设备套餐（不再误导去加设备槽位）。
 * 绑定 30 天未拉取自动过期（自愈，减少售后）；机主换手机走自助解绑（7 天冷却）。
 *
 * 浏览器/未知 UA 不建立绑定；但链接已有绑定时未知 UA 同样拒绝
 * （堵住「浏览器打开链接抄配置」的旁路）；无绑定时放行（存量灰度期兼容，
 * 存量已分享链接由首个拉取者认领，另一方被锁后机主可自助解绑重绑）。
 *
 * 无 kill switch：参数均为常量，要下线只能 redeploy。
 */
import { KV, type SubFetch, type Token } from "../../../../shared/types";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { getPlans, getPresence, mergeTokenSettlement } from "./kv";
import { shell } from "./risk-notify";
import { siteUrl } from "./site-url";
import type { Env } from "../types";

/** 绑定条目 30 天未拉取自动过期（自愈：客户端卸载/弃用后绑定自然释放） */
export const SUB_FP_EXPIRE_MS = 30 * 86_400_000;
/** 自助解绑冷却：7 天。无冷却会被分享者当成「随时挤掉机主」的工具 */
export const SUB_UNBIND_COOLDOWN_MS = 7 * 86_400_000;
/** 冲突提醒邮件节流：同一 token 24 小时最多一封 */
export const SUB_BIND_NOTIFY_COOLDOWN_MS = 24 * 3_600_000;

export const FP_UNKNOWN = "unknown";

/** 指纹家族的中文展示名（邮件与前端展示同口径；前端副本在 pages/src/lib/sub-fp.ts） */
export const SUB_FP_LABEL: Record<string, string> = {
  shadowrocket: "Shadowrocket",
  stash: "Stash",
  singbox: "sing-box",
  v2rayng: "v2rayNG",
  nekobox: "NekoBox",
  "clash-meta": "Clash（mihomo 系）",
  "clash-other": "Clash（老内核）",
  [FP_UNKNOWN]: "未知客户端",
};

/**
 * UA → 客户端家族（忽略版本号，升级不掉绑定）。
 * 判据与 sub.ts 的 detectSubFormat / clash.ts 的 supportsGeosite 现有正则对齐；
 * 浏览器、curl 与空 UA 一律归 unknown（不参与绑定）。
 * 顺序敏感：verge/meta/flclash 必须先于 clash 通配（clash-verge 含 "clash"）。
 */
export function clientFamily(ua: string): string {
  if (!ua) return FP_UNKNOWN;
  if (/shadowrocket/i.test(ua)) return "shadowrocket";
  if (/stash/i.test(ua)) return "stash";
  // SFA/SFI 大写精确匹配（同 sub.ts）：避免误伤 UA 里含 "sfa"/"sfi" 子串的其他客户端
  if (/sing-box|SFA|SFI/.test(ua)) return "singbox";
  if (/v2rayng/i.test(ua)) return "v2rayng";
  if (/nekobox/i.test(ua)) return "nekobox";
  if (/mihomo|verge|meta|flclash/i.test(ua)) return "clash-meta";
  if (/clash/i.test(ua)) return "clash-other";
  return FP_UNKNOWN;
}

/** 订阅绑定判定结果 */
export interface SubBindingCheck {
  allowed: boolean;
  /** 本次请求归一化后的客户端家族 */
  fp: string;
  /** 冲突时：该链接当前已绑定的家族 */
  conflictWith?: string;
}

/**
 * 订阅设备锁判定（只读，不写库；绑定/刷新由 recordBinding 在 waitUntil 里完成）。
 * 过期条目（30 天未拉取）视为不存在。
 * - 多设备套餐（有效 max_devices > 1）：锁不生效，一律放行——同一人多台设备
 *   拉同一链接是正常用法。此时连 presence 都不读（省一次 KV 读）；
 * - unknown UA：无存活绑定 → 放行；有存活绑定 → 拒绝（堵浏览器抄配置旁路）；
 * - 已绑定指纹命中 → 放行；
 * - 新指纹且无存活绑定 → 放行并认领（懒惰绑定，存量灰度）；
 * - 新指纹且有存活绑定 → 冲突拒绝。
 * 有效设备数口径与 tokens.ts 加设备处一致：token.max_devices ?? 套餐 max_devices ?? 2。
 * KV 开销：每次拉取 1 次 plans 读（单键，全页共享数据）+ 单设备套餐 1 次 presence 读；
 * 订阅拉取是低频路径（客户端 profile-update-interval=24h），可接受。
 */
export async function checkSubBinding(
  env: Env,
  token: Token,
  subUuid: string,
  ua: string,
  now: number
): Promise<SubBindingCheck> {
  const fp = clientFamily(ua);
  const plans = await getPlans(env);
  const maxDevices = token.max_devices ?? plans.find((p) => p.id === token.plan_id)?.max_devices ?? 2;
  if (maxDevices > 1) return { allowed: true, fp };

  const presence = await getPresence(env, token.uuid);
  const bindings = presence?.sub_fps?.[subUuid] ?? {};
  const live = Object.keys(bindings).filter((f) => now - bindings[f].at < SUB_FP_EXPIRE_MS);
  if (fp === FP_UNKNOWN) {
    return { allowed: live.length === 0, fp, conflictWith: live[0] };
  }
  if (live.length === 0 || live.includes(fp)) return { allowed: true, fp };
  return { allowed: false, fp, conflictWith: live[0] };
}

/**
 * 建立/刷新绑定（presence 重读-合并定点写，仿 mergeShareFields 的读-改-写模式）。
 * 调用方必须串行于 recordSubFetch 之后或之前 await——两者写同一 presence 键，
 * 并发各自读-改-写会互相覆盖；串行时后者重读前者落库的最新副本则不丢。
 * 同指纹且 UA/IP 未变 24h 内跳过 put（与 recordSubFetch 同口径省写配额；
 * 30 天过期判定用 at，24h 粒度足够）。
 */
export async function recordBinding(
  env: Env,
  tokenUuid: string,
  subUuid: string,
  fp: string,
  ua: string,
  ip: string | undefined,
  now: number
): Promise<void> {
  if (fp === FP_UNKNOWN) return; // 浏览器/未知 UA 不产生绑定
  const presence = (await getPresence(env, tokenUuid)) ?? {};
  const links: Record<string, SubFetch & { first_at: number }> = {
    ...(presence.sub_fps?.[subUuid] ?? {}),
  };
  // 剔除 30 天未拉取的过期条目（自愈）
  for (const [f, b] of Object.entries(links)) {
    if (now - b.at >= SUB_FP_EXPIRE_MS) delete links[f];
  }
  const prev = links[fp];
  const entry = { ua: ua.slice(0, 120), ip, at: now, first_at: prev?.first_at ?? now };
  if (prev && prev.ua === entry.ua && prev.ip === entry.ip && now - prev.at < 86_400_000) return;
  links[fp] = entry;
  presence.sub_fps = { ...(presence.sub_fps ?? {}), [subUuid]: links };
  await env.TOKENS.put(KV.PRESENCE + tokenUuid, JSON.stringify(presence));
}

/**
 * 清除本 token 全部订阅绑定（自助解绑/售后救济共用）。
 * 返回是否真的清掉了绑定（admin 端据此决定 changed 与否）。
 */
export async function clearSubBindings(env: Env, tokenUuid: string): Promise<boolean> {
  const presence = await getPresence(env, tokenUuid);
  if (!presence?.sub_fps || Object.keys(presence.sub_fps).length === 0) return false;
  delete presence.sub_fps;
  await env.TOKENS.put(KV.PRESENCE + tokenUuid, JSON.stringify(presence));
  return true;
}

/**
 * 绑定冲突时机主邮件：哪个链接、对方客户端家族/来源 IP/时间，引导登录管理页
 * 查看（订阅客户端卡片）或自助解绑。节流 notify_log.sub_bind_conflict 24h，
 * 发送成功才记录（mergeTokenSettlement 键级合并写回，与结算路径互不覆盖）。
 *
 * 只对单设备套餐发送：max_devices > 1 的套餐出现多客户端家族是正常用法
 * （用户本就有多台设备各拉同一链接的场景），通知是噪音——403 拒绝照常吃，
 * 只是不打扰机主。有效设备数口径与 tokens.ts 加设备处一致：
 * token.max_devices ?? 套餐 max_devices ?? 2（缺省 2 = 不发，保守不打扰）。
 * plans 读取放在节流检查之后：被节流的冲突连这一次 KV 读都省掉。
 */
export async function notifyBindConflict(
  env: Env,
  token: Token,
  info: { subLabel: string; fp: string; conflictWith?: string; ip?: string; now: number }
): Promise<void> {
  if (!shouldSendEmail(token.contact)) return;
  token.notify_log = token.notify_log ?? {};
  if (info.now - (token.notify_log.sub_bind_conflict ?? 0) < SUB_BIND_NOTIFY_COOLDOWN_MS) return;
  const plans = await getPlans(env);
  const maxDevices = token.max_devices ?? plans.find((p) => p.id === token.plan_id)?.max_devices ?? 2;
  if (maxDevices > 1) return;
  const manageUrl = `${siteUrl(env)}/tokens?id=${token.id}`;
  const fpLabel = SUB_FP_LABEL[info.fp] ?? info.fp;
  const boundLabel = SUB_FP_LABEL[info.conflictWith ?? ""] ?? "其他客户端";
  const when = new Date(info.now).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const { subject, html, text } = shell(
    env,
    "账号安全提醒：订阅链接被陌生客户端使用",
    `<p>你好，系统检测到你的 Token（<strong>${token.id}</strong>）的订阅链接（${info.subLabel}）被一个陌生客户端尝试拉取，已拒绝下发：</p>
     <ul style="margin:8px 0;padding-left:20px;color:#334155;">
       <li>对方客户端：${fpLabel}</li>
       <li>来源 IP：${info.ip ?? "未知"}</li>
       <li>时间：${when}（北京时间）</li>
     </ul>
     <p>该链接当前已绑定 <strong>${boundLabel}</strong>。如果是你刚换了手机/客户端，登录管理页在「订阅客户端」卡片点「解除订阅绑定」后重新导入即可。<strong>你的套餐仅支持 1 台设备</strong>；如有多设备需求，请购买支持多设备的套餐。</p>
     <p>如果都不是本人操作，说明订阅链接已泄露：解绑后请重新生成订阅链接（旧链接立即失效）。</p>`,
    `检测到你的 Token（${token.id}）的订阅链接（${info.subLabel}）被陌生客户端（${fpLabel}，IP ${info.ip ?? "未知"}，${when}）尝试拉取，已拒绝下发。\n该链接已绑定 ${boundLabel}。换手机/换客户端：登录管理页「订阅客户端」卡片解除订阅绑定后重新导入。你的套餐仅支持 1 台设备；多设备需求请购买多设备套餐。\n如非本人操作：解绑后重新生成订阅链接（旧链接立即失效）。\n管理页：${manageUrl}`
  );
  const res = await sendMail(env, token.contact, subject, html, text, { kind: "account" });
  if (res.ok) {
    token.notify_log.sub_bind_conflict = info.now;
    await mergeTokenSettlement(env, token.uuid, { notify_log: token.notify_log });
    console.log(`[sub-lock] bind conflict notified ${token.id} fp=${info.fp}`);
  } else {
    console.error(`[sub-lock] bind conflict mail failed ${token.id}: ${res.error}`);
  }
}
