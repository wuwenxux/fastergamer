#!/usr/bin/env node
/**
 * 用户接入审计：接入点 / IP / 流量画像 + 异常标记。
 *
 * 与 user-stats.mjs（增长与流量大盘）互补：本脚本逐用户列出接入 IP 明细，
 * 重点识别三类异常——
 *   🚨 hosting   数据中心/代理 IP 接入（挂 VPS 领试用跑量、中转嫌疑）
 *   ⚠️ multi-ip  接入 IP 过多（订阅链接疑似泄露分享）
 *   ⚠️ trial-hot 体验用户用量逼近额度（潜在重度白嫖）
 *
 * 用法：
 *   node scripts/user-audit.mjs            # 默认最近 30 天有购买或接入的用户
 *   node scripts/user-audit.mjs 7          # 最近 7 天
 *   node scripts/user-audit.mjs --all      # 全量用户
 *
 * IP 地理/属性用 ip-api.com 批量接口（免费版无 hosting/proxy 字段，故机房判定
 * 双保险：字段优先，缺失时用 isp/org/as 关键词命中已知机房名单）。
 * 每次运行把异常 token 列表快照到 scripts/.stats/audit-latest.json，
 * 输出里「*」标记的是较上次运行新出现的异常，便于 cron 日常扫一眼：
 *   17 8 * * * node /home/wafer/cloudflare/scripts/user-audit.mjs >> /home/wafer/cloudflare/scripts/.stats/audit.log 2>&1
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATS_DIR = path.join(ROOT, "scripts", ".stats");
const SNAP_FILE = path.join(STATS_DIR, "audit-latest.json");
const TZ = 8 * 3600_000; // 北京时间

const args = process.argv.slice(2);
const ALL = args.includes("--all");
const DAYS = Number(args.find((a) => /^\d+$/.test(a)) ?? 30);

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "workers/api/.dev.vars"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => l.split("=", 2).map((s) => s.trim()))
);
const ADMIN_KEY = env.ADMIN_KEY;
const API = "https://fastergamer.click";

const dayKey = (ts) => new Date(ts + TZ).toISOString().slice(0, 10);
const gb = (b) => (b / 1e9).toFixed(2);

// 已知机房/代理网络关键词（ip-api 免费版无 hosting 字段时的兜底判定）
const HOSTING_RE =
  /datacamp|alibaba|tencent|huawei|amazon|aws|digitalocean|hetzner|ovh|vultr|linode|akamai|choopa|contabo|oracle|google cloud|microsoft|lease web|leaseweb|m247|rackspace|quadra|sharktech|colocrossing|hostwinds|kamatera|gcore|cdn77/i;

// ---------- 拉数据 ----------
const [tokensRes, nodesRes] = await Promise.all([
  fetch(`${API}/api/admin/tokens?presence=1`, { headers: { "x-admin-key": ADMIN_KEY } }),
  fetch(`${API}/api/admin/nodes`, { headers: { "x-admin-key": ADMIN_KEY } }),
]);
if (!tokensRes.ok) { console.error(`拉取 token 失败: ${tokensRes.status}`); process.exit(1); }
const tokens = (await tokensRes.json()).data;
const nodeName = Object.fromEntries(((await nodesRes.json()).data ?? []).map((n) => [n.id, n.name]));

// ---------- 过滤分析对象 ----------
const now = Date.now();
const since = now - DAYS * 86_400_000;
const targets = tokens
  .filter((t) => ALL || (t.purchased_at ?? 0) >= since || (t.presence?.last_active_at ?? 0) >= since)
  .sort((a, b) => (b.traffic_used_gb ?? 0) - (a.traffic_used_gb ?? 0));

// ---------- IP 批量画像 ----------
const allIps = [...new Set(targets.flatMap((t) => Object.keys(t.presence?.traffic_by_ip ?? {})))];
const ipInfo = {};
for (let i = 0; i < allIps.length; i += 15) {
  try {
    const r = await fetch(
      "http://ip-api.com/batch?fields=status,country,regionName,city,isp,org,as,hosting,proxy,query",
      { method: "POST", body: JSON.stringify(allIps.slice(i, i + 15)) }
    );
    for (const it of await r.json()) if (it.status === "success") ipInfo[it.query] = it;
  } catch { /* 解析失败跳过，不影响主流程 */ }
  if (i + 15 < allIps.length) await new Promise((r) => setTimeout(r, 1400)); // ip-api 免费限速 45/min
}
const ipLabel = (ip) => {
  const g = ipInfo[ip];
  if (!g) return ip;
  const dc = g.hosting || g.proxy || HOSTING_RE.test(`${g.isp} ${g.org} ${g.as}`) ? "🖥️" : "";
  return `${dc}${g.regionName || g.country} ${g.isp || ""}`.trim();
};
const isHostingIp = (ip) => {
  const g = ipInfo[ip];
  return !!g && (g.hosting === true || g.proxy === true || HOSTING_RE.test(`${g.isp} ${g.org} ${g.as}`));
};

// ---------- 逐用户分析与异常标记 ----------
const prevSnap = fs.existsSync(SNAP_FILE) ? JSON.parse(fs.readFileSync(SNAP_FILE, "utf8")) : { flagged: {} };
const flagged = {}; // tokenId → [flags]，用于快照差分
const rows = [];
let hostingBytesTotal = 0, allBytesTotal = 0;

for (const t of targets) {
  const ips = Object.entries(t.presence?.traffic_by_ip ?? {}).sort((a, b) => b[1].bytes - a[1].bytes);
  const usedGb = t.traffic_used_gb ?? 0;
  const totalBytes = ips.reduce((a, [, s]) => a + s.bytes, 0);
  allBytesTotal += totalBytes;

  const flags = [];
  const hostingBytes = ips.filter(([ip]) => isHostingIp(ip)).reduce((a, [, s]) => a + s.bytes, 0);
  hostingBytesTotal += hostingBytes;
  // 机房流量过半且有一定量级才标记，排除移动端 NAT 出口误判
  if (hostingBytes > 0.5e9 && hostingBytes > totalBytes * 0.5) flags.push("hosting");
  if (ips.length >= 5) flags.push("multi-ip");
  if (t.plan_id === "plan_3days" && t.traffic_limit_gb > 0 && usedGb >= t.traffic_limit_gb * 0.8) flags.push("trial-hot");
  if (flags.length) flagged[t.id] = flags;

  const topIps = ips.slice(0, 3).map(([ip, s]) => `${ipLabel(ip)}(${gb(s.bytes)}GB)`).join("、") || "无接入";
  const byNode = Object.entries(t.traffic_total_by_node ?? t.traffic_by_node ?? {}).sort((a, b) => b[1] - a[1]);
  const topNodes = byNode.slice(0, 2).map(([id, b]) => `${nodeName[id] ?? id}(${gb(b)}GB)`).join("、") || "-";
  const lastActive = t.presence?.last_active_at ? dayKey(t.presence.last_active_at) : "-";
  const isNew = flags.length && !prevSnap.flagged?.[t.id];
  rows.push({
    flagStr: flags.length ? `${flags.join(",")}${isNew ? " *" : ""}` : "",
    line: `${t.id}  ${(t.contact ?? "-").padEnd(24)} ${t.plan_id.replace("plan_", "").padEnd(6)} ` +
      `${usedGb.toFixed(2).padStart(6)}GB  IP×${ips.length}  接入: ${topIps}  节点: ${topNodes}  最后活跃: ${lastActive}`,
    flags,
  });
}

// ---------- 输出 ----------
console.log(`== 用户接入审计（${ALL ? "全量" : `最近 ${DAYS} 天`}，${targets.length} 个 token）==`);
for (const r of rows) {
  console.log(`${r.flagStr ? `[${r.flagStr}] ` : ""}${r.line}`);
}

console.log(`\n== 汇总 ==`);
console.log(`审计流量合计 ${gb(allBytesTotal)} GB，其中机房/代理 IP ${gb(hostingBytesTotal)} GB（${allBytesTotal ? (hostingBytesTotal / allBytesTotal * 100).toFixed(0) : 0}%）`);
const regionCount = {}, ispCount = {};
for (const t of targets) for (const [ip, s] of Object.entries(t.presence?.traffic_by_ip ?? {})) {
  const g = ipInfo[ip];
  if (!g) continue;
  regionCount[g.country] = (regionCount[g.country] ?? 0) + s.bytes;
  ispCount[g.isp] = (ispCount[g.isp] ?? 0) + s.bytes;
}
const topByBytes = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, b]) => `${k}(${gb(b)}GB)`).join("、") || "无";
console.log(`接入国家/地区 TOP: ${topByBytes(regionCount)}`);
console.log(`运营商 TOP: ${topByBytes(ispCount)}`);

const flaggedCount = Object.keys(flagged).length;
console.log(`\n== 异常（${flaggedCount} 个 token，* 为较上次运行新增）==`);
if (flaggedCount) {
  for (const r of rows.filter((r) => r.flags.length)) console.log(`[${r.flagStr}] ${r.line}`);
} else {
  console.log("无");
}

fs.mkdirSync(STATS_DIR, { recursive: true });
fs.writeFileSync(SNAP_FILE, JSON.stringify({ at: now, flagged }, null, 2));
