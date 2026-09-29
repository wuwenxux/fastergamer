/**
 * 不可能旅行检测：结算路径上比对相邻两周期接入来源的地理跳变，
 * 速度超过物理极限判定为多人持有确证（一个人不可能 1 分钟从深圳到北京）。
 *
 * 判定口径：
 * - 城市键（active_geo 基线）不同才进入判定；同城换 IP 由基线刷新自然吸收；
 * - 两侧都有经纬度（geo:{ip} 缓存）→ haversine 距离 / 时间差 > 1000 km/h 命中
 *   （高铁 ~350、民航 ~900，1000 留出余量，正常差旅不命中）；
 * - 旧位置缺经纬度（缓存未命中）→ 兜底：时间差 < 2h 即命中（跨城移动 2h 内
 *   可达的距离有限，宁可宽松漏判也不误伤）。
 *
 * 处置：只提醒不处置——累积 token.travel_strikes（仿 share_conn_strikes，
 * 30 分钟未再犯重计）+ 节流邮件（notify_log.travel_warn，7 天）。后续要升级
 * 自动处置再单开任务。
 *
 * 触发点：/api/agent/traffic 的 IP 变更管线（routes/agent.ts），
 * resolveIpLocationChange 判定跨城市变更后调用；全部写库走重读-合并补丁，
 * 邮件 await 在写库之后。
 */
import { KV, type IpGeo, type Token } from "../../../../shared/types";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { mergeTokenSettlement } from "./kv";
import { geoLocationKey, shell } from "./risk-notify";
import { siteUrl } from "./site-url";
import type { Env } from "../types";

/** 物理速度上限（km/h）：民航巡航 ~900，1000 留余量 */
export const TRAVEL_SPEED_LIMIT_KMH = 1000;
/** 缺经纬度时的兜底时间窗：跨城移动 < 2h 即视为不可能 */
export const TRAVEL_FALLBACK_WINDOW_MS = 2 * 3_600_000;
/** strikes 连续窗口：距上次命中超过此时长重新计数（仿 SHARE_STRIKE_WINDOW_MS） */
export const TRAVEL_STRIKE_WINDOW_MS = 30 * 60_000;
/** 提醒邮件节流：同一 token 7 天最多一封 */
export const TRAVEL_WARN_COOLDOWN_MS = 7 * 86_400_000;

/** 旧位置基线（来自 resolveIpLocationChange 的 oldLocation/oldAt + 变更前的 active_ips） */
export interface TravelBaseline {
  /** 旧位置键（country / region / city） */
  locationKey: string;
  /** 旧位置最后确认时间；存量裸字符串基线无此值 → 本次只更新基线不判定 */
  at?: number;
  /** 上一周期的接入 IP（查 geo:{ip} 缓存取旧位置经纬度用） */
  ips: string[];
}

/** haversine 球面距离（km） */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 旧位置经纬度：从上周期接入 IP 的 geo:{ip} 缓存取（IP 变更才触发，低频路径一次 KV 读） */
async function lookupOldGeo(env: Env, ips: string[]): Promise<IpGeo | null> {
  for (const ip of ips) {
    const raw = await env.TOKENS.get(KV.GEO + ip);
    if (!raw) continue;
    try {
      const g = JSON.parse(raw) as IpGeo;
      if (g.lat && g.lon) return g;
    } catch {
      // 缓存损坏按下一条处理
    }
  }
  return null;
}

/**
 * 不可能旅行判定与提醒。命中时：
 * 1. 重读-合并写 travel_strikes（先写库）；
 * 2. 发节流邮件（7 天，内容 = 两城市 + 时间差 + 引导重置订阅）；
 * 3. 发送成功才把 notify_log.travel_warn 键级合并写回。
 * 不命中/无法判定（无 oldAt、同城）时完全不写库、不发邮件。
 */
export async function evaluateTravel(
  env: Env,
  token: Token,
  oldBaseline: TravelBaseline,
  newGeo: IpGeo,
  now: number
): Promise<void> {
  // 存量裸字符串基线没有时间基线：本次只更新基线（resolveIpLocationChange 已做），不判定
  if (!oldBaseline.at) return;
  const newKey = geoLocationKey(newGeo);
  if (!newKey || newKey === oldBaseline.locationKey) return;

  const elapsedMs = now - oldBaseline.at;
  let hit: boolean;
  const oldGeo = await lookupOldGeo(env, oldBaseline.ips);
  if (oldGeo && newGeo.lat && newGeo.lon) {
    const km = haversineKm(oldGeo.lat, oldGeo.lon, newGeo.lat, newGeo.lon);
    // elapsedMs ≤ 0（时钟异常）按瞬时移动处理：换城市即不可能
    const speed = elapsedMs <= 0 ? Infinity : km / (elapsedMs / 3_600_000);
    hit = speed > TRAVEL_SPEED_LIMIT_KMH;
    if (!hit) return;
    console.log(
      `[travel] hit ${token.id}: ${oldBaseline.locationKey} → ${newKey}, ${km.toFixed(0)}km in ${(elapsedMs / 60_000).toFixed(0)}min (${speed.toFixed(0)}km/h)`
    );
  } else {
    // 旧位置缺经纬度：2h 兜底
    hit = elapsedMs < TRAVEL_FALLBACK_WINDOW_MS;
    if (!hit) return;
    console.log(
      `[travel] hit ${token.id}: ${oldBaseline.locationKey} → ${newKey}, in ${(elapsedMs / 60_000).toFixed(0)}min（无经纬度，2h 兜底）`
    );
  }

  // 先写 strikes（重读-合并），再发邮件
  const prev = token.travel_strikes;
  const count = prev && now - prev.at <= TRAVEL_STRIKE_WINDOW_MS ? prev.count + 1 : 1;
  await mergeTokenSettlement(env, token.uuid, { travel_strikes: { at: now, count } });
  token.travel_strikes = { at: now, count };

  if (!shouldSendEmail(token.contact)) return;
  token.notify_log = token.notify_log ?? {};
  if (now - (token.notify_log.travel_warn ?? 0) < TRAVEL_WARN_COOLDOWN_MS) return;
  const manageUrl = `${siteUrl(env)}/tokens?id=${token.id}`;
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  const timeDesc = minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
  const { subject, html, text } = shell(
    env,
    "账号安全提醒：检测到异常的位置跳变",
    `<p>你好，系统检测到你的 Token（<strong>${token.id}</strong>）的接入位置在 <strong>${timeDesc}</strong>内从 <strong>${oldBaseline.locationKey}</strong> 跳变到 <strong>${newKey}</strong>，超出正常出行可达的速度。</p>
     <p>如果是你本人在使用（如刚落地开机、网络出口异常），可以忽略本邮件；否则说明订阅链接很可能已被转发共享，他人正在盗用你的流量。</p>
     <p><strong>如非本人使用，请尽快登录管理页重新生成订阅链接</strong>（旧链接立即失效，盗用者被断开）。</p>
     <p style="color:#64748b;font-size:13px;">本提醒每 7 天最多发送一次，服务不会因此中断。</p>`,
    `检测到你的 Token（${token.id}）的接入位置在 ${timeDesc}内从 ${oldBaseline.locationKey} 跳变到 ${newKey}，超出正常出行可达速度。\n如非本人使用，请尽快登录管理页重新生成订阅链接（旧链接立即失效）：${manageUrl}\n本提醒每 7 天最多一封，服务不会因此中断。`
  );
  const res = await sendMail(env, token.contact, subject, html, text, { kind: "account" });
  if (res.ok) {
    token.notify_log.travel_warn = now;
    await mergeTokenSettlement(env, token.uuid, { notify_log: token.notify_log });
  } else {
    console.error(`[travel] warn mail failed ${token.id}: ${res.error}`);
  }
}
