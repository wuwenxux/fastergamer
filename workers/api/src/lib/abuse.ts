/**
 * 机房 IP 滥用识别与限速（仅免费体验 token）
 *
 * 背景：滥用者领免费体验后把订阅搬到数据中心服务器跑爬虫/中转，大量流量从机房 IP 走，
 * 会把节点出口 IP 搞进黑名单连累真实用户。中心在结算路径上自动识别这类 token。
 *
 * 处置策略是限速而非撤销（撤销太猛，误伤即流失）：
 * 判定为机器的 token 打 abuse_machine 标记，转每日流量定额（ABUSE_DAILY_BYTES），
 * 超限暂停到 24h 窗口终点——机器不够用但不断线，正常用户无感知。
 *
 * 判定口径与运维脚本 scripts/user-audit.mjs 保持一致（worker 不能 import scripts，逻辑复制于此）：
 *   机房/代理 IP 的估算流量 > 0.5GB 且占全部接入流量 > 50%（绝对量阈值排除移动端 NAT 出口误判）。
 * 只处理 plan_3days 的 active token：付费用户误伤成本高，公司专线/云桌面也可能是正常场景。
 *
 * fail-open 语义：IP 分类查询失败（网络异常/ip-api 限速）时本次结算跳过判定，
 * 绝不因分类失败误标；下个结算周期有新 IP 时会重试。
 *
 * KV 成本：IP 分类结果缓存 ipinfo:{ip}（TTL 30 天，IP 归属短期不变）；
 * 只对新出现的 IP 调 ip-api 批量接口（免费限速 45 次/分钟，单次结算的新 IP 数量很小，一批即可）。
 */
import { KV, type Presence, type Token } from "../../../../shared/types";
import { mergeTokenSettlement } from "./kv";
import { notifyAdmin } from "./risk-notify";
import type { Env } from "../types";

/** 已知机房/代理网络关键词（与 user-audit.mjs 同一份名单；ip-api 免费版无 hosting 字段时的兜底判定） */
export const HOSTING_RE =
  /datacamp|alibaba|tencent|huawei|amazon|aws|digitalocean|hetzner|ovh|vultr|linode|akamai|choopa|contabo|oracle|google cloud|microsoft|lease web|leaseweb|m247|rackspace|quadra|sharktech|colocrossing|hostwinds|kamatera|gcore|cdn77/i;

/** 判定阈值：机房流量绝对量 > 0.5GB（十进制 GB，与 user-audit.mjs 口径一致） */
export const ABUSE_HOSTING_MIN_BYTES = 0.5e9;
/** 判定阈值：机房流量占全部接入流量的比例 > 50% */
export const ABUSE_HOSTING_RATIO = 0.5;

/**
 * 机器标记 token 的每日流量定额（500MB/天）。
 * 参照正常体验用量（7 天 8GB 套餐 ≈ 1.1GB/天）：
 * 给机器 500MB/天让它跑爬虫/中转不够用，但不断线、不撤销，误伤时用户仍可用。
 */
export const ABUSE_DAILY_BYTES = 500e6;
/** 限速窗口：24h 滚动（复用 rate_window 的模式） */
export const ABUSE_WINDOW_MS = 24 * 3_600_000;

/** ip-api 分类结果缓存 30 天：IP 归属短期不变，避免每次结算重复查询 */
const IPINFO_TTL_SECONDS = 30 * 86_400;

/** ip-api.com 批量接口返回的单 IP 画像（免费版无 hosting/proxy 字段，缺省时走 HOSTING_RE 兜底） */
interface IpInfo {
  hosting?: boolean;
  proxy?: boolean;
  isp?: string;
  org?: string;
  as?: string;
}

/** 机房/代理判定：字段优先，缺失时用 isp/org/as 关键词命中已知机房名单（与 user-audit.mjs 同口径） */
const isHostingIp = (g: IpInfo): boolean =>
  g.hosting === true ||
  g.proxy === true ||
  HOSTING_RE.test(`${g.isp ?? ""} ${g.org ?? ""} ${g.as ?? ""}`);

/**
 * 调 ip-api.com 批量接口分类一批 IP。任何失败（网络/限速/非数组应答）返回 null，
 * 调用方据此跳过本次判定（fail-open）。
 */
async function fetchIpInfo(ips: string[]): Promise<Record<string, IpInfo> | null> {
  try {
    const res = await fetch(
      "http://ip-api.com/batch?fields=status,isp,org,as,hosting,proxy,query",
      {
        method: "POST",
        body: JSON.stringify(ips),
        signal: AbortSignal.timeout(4000),
      }
    );
    if (!res.ok) return null;
    const arr = (await res.json()) as ({ status?: string; query?: string } & IpInfo)[];
    if (!Array.isArray(arr)) return null;
    const out: Record<string, IpInfo> = {};
    // 单条失败的 IP 不收录（按非机房处理，也不写缓存，下次重试）
    for (const it of arr) if (it.status === "success" && it.query) out[it.query] = it;
    return out;
  } catch {
    return null;
  }
}

/**
 * 机器标记 token 的每日定额记账（纯函数，无 await，与 updateSpikeWindow 同模式，
 * 在 token 写库前的纯计算段调用）：delta 累加进 24h 滚动窗口，窗口跨期重置。
 * 窗口字节超 ABUSE_DAILY_BYTES → 暂停到窗口终点（abuse_suspended_until = 窗口起点 + 24h）。
 * 返回 true 表示「本次新进入暂停」，调用方应推送授权刷新把 uuid 从节点摘除；
 * 反复暂停是常态，不写邮件，只记日志。暂停到期后由授权快照生成侧自然恢复（见 authsnapshot.ts）。
 */
export function applyAbuseWindow(token: Token, deltaBytes: number, now = Date.now()): boolean {
  if (!token.abuse_machine) return false;
  if (!token.abuse_window_start || now - token.abuse_window_start >= ABUSE_WINDOW_MS) {
    token.abuse_window_start = now;
    token.abuse_window_bytes = 0;
    // 暂停随窗口过期自然结束；显式归零是因为 mergeTokenSettlement 忽略 undefined，删不掉旧值
    token.abuse_suspended_until = 0;
  }
  token.abuse_window_bytes = (token.abuse_window_bytes ?? 0) + deltaBytes;
  if (token.abuse_window_bytes <= ABUSE_DAILY_BYTES) return false;
  const until = token.abuse_window_start + ABUSE_WINDOW_MS;
  // 已暂停到同一终点（推送传播期间的尾随结算）：不重复触发授权刷新
  if (token.abuse_suspended_until === until) return false;
  token.abuse_suspended_until = until;
  console.log(
    `[abuse] suspend ${token.id}: window=${(token.abuse_window_bytes / 1e6).toFixed(0)}MB > ${ABUSE_DAILY_BYTES / 1e6}MB/day, until=${new Date(until).toISOString()}`
  );
  return true;
}

/**
 * 体验 token 机房滥用检查：命中判定口径即打 abuse_machine 标记（限速，不撤销）
 * 并邮件通知站长一次，返回是否「本次新标记」。
 *
 * 必须在结算字段写库之后调用（内部含 ip-api/邮件 await，且标记走独立的重读-合并写）。
 * 标记本身不改变授权状态（超限才暂停），调用方无需因此推送节点刷新。
 * 幂等：notify_log.abuse_machine 已记录的直接跳过，不重复标记/通知/查询。
 */
export async function checkTrialAbuse(
  env: Env,
  token: Token,
  presence: Presence
): Promise<boolean> {
  if (token.plan_id !== "plan_3days" || token.status !== "active") return false;
  if (token.notify_log?.abuse_machine) return false;

  const table = presence.traffic_by_ip ?? {};
  const ips = Object.keys(table);
  if (ips.length === 0) return false;
  const totalBytes = ips.reduce((s, ip) => s + (table[ip]?.bytes ?? 0), 0);
  // 机房字节数 ≤ 总字节数：总量没到绝对阈值必不命中，省下全部分类查询
  if (totalBytes <= ABUSE_HOSTING_MIN_BYTES) return false;

  // 先读 KV 分类缓存，只对新出现的 IP 发起查询
  const info: Record<string, IpInfo> = {};
  const missing: string[] = [];
  for (const ip of ips) {
    const raw = await env.TOKENS.get(KV.IPINFO + ip);
    if (!raw) {
      missing.push(ip);
      continue;
    }
    try {
      info[ip] = JSON.parse(raw) as IpInfo;
    } catch {
      missing.push(ip); // 缓存损坏按未缓存处理
    }
  }
  if (missing.length > 0) {
    const fetched = await fetchIpInfo(missing);
    // fail-open：分类失败本次跳过判定，绝不因查询失败误标
    if (!fetched) return false;
    for (const [ip, g] of Object.entries(fetched)) {
      info[ip] = g;
      await env.TOKENS.put(KV.IPINFO + ip, JSON.stringify(g), {
        expirationTtl: IPINFO_TTL_SECONDS,
      });
    }
  }

  const hostingIps = ips.filter((ip) => info[ip] && isHostingIp(info[ip]));
  const hostingBytes = hostingIps.reduce((s, ip) => s + table[ip].bytes, 0);
  if (hostingBytes <= ABUSE_HOSTING_MIN_BYTES || hostingBytes <= totalBytes * ABUSE_HOSTING_RATIO) {
    return false;
  }

  const now = Date.now();
  const gb = (b: number) => (b / 1e9).toFixed(2);
  const topHosting = hostingIps
    .sort((a, b) => table[b].bytes - table[a].bytes)
    .slice(0, 3)
    .map((ip) => {
      const g = info[ip];
      const label = [g.isp, g.org].filter(Boolean).join(" ") || "未知 ISP";
      return `${ip}（${label}，${gb(table[ip].bytes)}GB）`;
    })
    .join("、");
  // 日志不含敏感数据：只记 token 短 id 与流量数字
  console.log(`[abuse] mark machine ${token.id}: hosting=${gb(hostingBytes)}GB total=${gb(totalBytes)}GB`);

  // 重读-合并写（与结算路径同一约定）：只打 abuse_machine 标记与 notify_log 幂等键，
  // 并发结算/用户操作改的其他字段不丢；token 已删除时 mergeTokenSettlement 自动丢弃。
  await mergeTokenSettlement(env, token.uuid, {
    abuse_machine: true,
    notify_log: { abuse_machine: now },
  });

  await notifyAdmin(
    env,
    `体验 token 判定为机器，已限速：${token.id}`,
    `<p>体验 Token <strong>${token.id}</strong>（${token.contact ?? "无联系方式"}）的接入流量以机房 IP 为主，已标记为机器并限速：<strong>每日 500MB，超限暂停到 24h 窗口重置</strong>（不撤销、不断线）。</p>
     <p>机房流量 <strong>${gb(hostingBytes)} GB</strong> / 接入总流量 ${gb(totalBytes)} GB（阈值：&gt;0.5GB 且占比 &gt;50%）。</p>
     <p>TOP 机房 IP：${topHosting}</p>
     <p>误伤解除：管理端清除 token 的 abuse_machine 字段。</p>`,
    `体验 Token ${token.id}（${token.contact ?? "-"}）接入流量以机房 IP 为主，已标记为机器并限速：每日 500MB，超限暂停到 24h 窗口重置（不撤销）。\n机房流量 ${gb(hostingBytes)}GB / 总流量 ${gb(totalBytes)}GB（阈值 >0.5GB 且 >50%）。\nTOP 机房 IP：${topHosting}\n误伤解除：管理端清除 token 的 abuse_machine 字段。`
  );
  return true;
}
