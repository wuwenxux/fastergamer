#!/usr/bin/env node
/**
 * 用户增长与流量使用分析：每天新增 token、激活转化、流量日增量。
 *
 * 用法：
 *   node scripts/user-stats.mjs            # 默认最近 14 天
 *   node scripts/user-stats.mjs 30         # 最近 30 天
 *
 * 数据源：中心 API /api/admin/tokens（ADMIN_KEY 从 workers/api/.dev.vars 读取）。
 * 流量是 token 上的累计值，日增量靠快照差分：每次运行把当日总量存到
 * scripts/.stats/daily-YYYY-MM-DD.json，与前一天快照对比得出增量（首次运行只有基线）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATS_DIR = path.join(ROOT, "scripts", ".stats");
const DAYS = Number(process.argv[2] ?? 14);
const TZ = 8 * 3600_000; // 北京时间

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "workers/api/.dev.vars"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => l.split("=", 2).map((s) => s.trim()))
);
const ADMIN_KEY = env.ADMIN_KEY;
const API = "https://fastergamer.click";

const dayKey = (ts) => new Date(ts + TZ).toISOString().slice(0, 10);
const hourOf = (ts) => new Date(ts + TZ).getUTCHours();

const res = await fetch(`${API}/api/admin/tokens?presence=1`, { headers: { "x-admin-key": ADMIN_KEY } });
if (!res.ok) { console.error(`拉取 token 失败: ${res.status}`); process.exit(1); }
const tokens = (await res.json()).data;
const nodesRes = await fetch(`${API}/api/admin/nodes`, { headers: { "x-admin-key": ADMIN_KEY } });
const nodeName = Object.fromEntries(((await nodesRes.json()).data ?? []).map((n) => [n.id, n.name]));

// ---------- 按天聚合 ----------
const now = Date.now();
const since = now - DAYS * 86_400_000;
const days = {}; // day → { new: {}, activated: 0 }
const bump = (day, plan, field) => {
  if (!days[day]) days[day] = { newByPlan: {}, activated: 0 };
  if (field === "new") days[day].newByPlan[plan] = (days[day].newByPlan[plan] ?? 0) + 1;
  else days[day].activated++;
};
const trialHours = new Array(24).fill(0);
let trialTotal = 0, trialActivated = 0, trialExhausted = 0;

for (const t of tokens) {
  if (t.purchased_at >= since) bump(dayKey(t.purchased_at), t.plan_id, "new");
  if (t.activated_at && t.activated_at >= since) bump(dayKey(t.activated_at), t.plan_id, "act");
  if (t.plan_id === "plan_3days") {
    trialTotal++;
    trialHours[hourOf(t.purchased_at)]++;
    if (t.activated_at) trialActivated++;
    if (t.traffic_exhausted_at || (t.traffic_limit_gb > 0 && t.traffic_used_gb >= t.traffic_limit_gb)) trialExhausted++;
  }
}

console.log(`== 最近 ${DAYS} 天新增 / 激活 ==`);
for (const day of Object.keys(days).sort()) {
  const d = days[day];
  const plans = Object.entries(d.newByPlan).map(([p, n]) => `${p.replace("plan_", "")}×${n}`).join(" ");
  console.log(`${day}  新增 ${plans || "0"}${d.activated ? `  激活 ${d.activated}` : ""}`);
}

console.log(`\n== 免费体验（全量 ${trialTotal} 个）==`);
console.log(`激活率 ${trialTotal ? (trialActivated / trialTotal * 100).toFixed(0) : 0}%（${trialActivated}/${trialTotal}），流量耗尽率 ${trialTotal ? (trialExhausted / trialTotal * 100).toFixed(0) : 0}%`);
const top = trialHours.map((n, h) => [h, n]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log(`领取高峰时段（北京时）: ${top.map(([h, n]) => `${h} 时(${n}个)`).join("、") || "无"}`);

// ---------- 新用户接入画像（接入地/运营商/常用节点） ----------
const recent = tokens.filter((t) => t.purchased_at >= since);
const allIps = [...new Set(recent.flatMap((t) => Object.keys(t.presence?.traffic_by_ip ?? {})))];
const ipInfo = {};
for (let i = 0; i < allIps.length; i += 15) {
  const batch = allIps.slice(i, i + 15);
  try {
    const r = await fetch("http://ip-api.com/batch?fields=status,country,regionName,city,isp,query", {
      method: "POST", body: JSON.stringify(batch),
    });
    for (const it of await r.json()) if (it.status === "success") ipInfo[it.query] = it;
  } catch { /* 解析失败跳过，不影响主流程 */ }
  if (i + 15 < allIps.length) await new Promise((r) => setTimeout(r, 1400)); // ip-api 免费限速 45/min
}

console.log(`\n== 新用户接入画像（最近 ${DAYS} 天，${recent.length} 个）==`);
for (const t of recent) {
  const p = t.presence ?? {};
  const ips = Object.entries(p.traffic_by_ip ?? {}).sort((a, b) => b[1].bytes - a[1].bytes);
  const where = ips.slice(0, 3).map(([ip, s]) => {
    const g = ipInfo[ip];
    const label = g ? `${g.regionName || g.country}${g.isp ? " " + g.isp : ""}` : ip;
    return `${label}(${(s.bytes / 1e9).toFixed(2)}GB)`;
  }).join("、") || "暂无接入记录";
  const byNode = Object.entries(t.traffic_total_by_node ?? t.traffic_by_node ?? {}).sort((a, b) => b[1] - a[1]);
  const mainNodes = byNode.slice(0, 2).map(([id, b]) => `${nodeName[id] ?? id}(${(b / 1e9).toFixed(2)}GB)`).join("、") || "-";
  console.log(`${dayKey(t.purchased_at)}  ${t.plan_id.replace("plan_", "").padEnd(8)} ${(t.traffic_used_gb ?? 0).toFixed(2).padStart(6)}GB  接入: ${where}  节点: ${mainNodes}`);
}
const ispCount = {};
for (const t of recent) for (const [ip] of Object.entries(t.presence?.traffic_by_ip ?? {})) {
  const g = ipInfo[ip]; if (!g) continue;
  const k = `${g.isp}`;
  ispCount[k] = (ispCount[k] ?? 0) + 1;
}
const topIsp = Object.entries(ispCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (topIsp.length) console.log(`运营商分布: ${topIsp.map(([k, n]) => `${k}×${n}`).join("、")}`);

// ---------- 流量日增量（快照差分） ----------
fs.mkdirSync(STATS_DIR, { recursive: true });
const totalBytes = tokens.reduce((a, t) => a + (t.traffic_used_gb ?? 0) * 1e9, 0);
const trialBytes = tokens.filter((t) => t.plan_id === "plan_3days").reduce((a, t) => a + (t.traffic_used_gb ?? 0) * 1e9, 0);
const today = dayKey(now);
const snap = { day: today, total_bytes: Math.round(totalBytes), trial_bytes: Math.round(trialBytes), token_count: tokens.length };
fs.writeFileSync(path.join(STATS_DIR, `daily-${today}.json`), JSON.stringify(snap));

const snaps = fs.readdirSync(STATS_DIR).filter((f) => f.startsWith("daily-") && f !== `daily-${today}.json`).sort();
console.log(`\n== 流量 ==`);
console.log(`全量累计 ${(totalBytes / 1e9).toFixed(1)} GB，其中体验用户 ${(trialBytes / 1e9).toFixed(1)} GB`);
if (snaps.length) {
  const prev = JSON.parse(fs.readFileSync(path.join(STATS_DIR, snaps[snaps.length - 1]), "utf8"));
  const dt = (now - new Date(prev.day + "T00:00:00Z").getTime() + TZ - TZ) / 86_400_000;
  const delta = (totalBytes - prev.total_bytes) / 1e9;
  const dTrial = (trialBytes - prev.trial_bytes) / 1e9;
  console.log(`较上次快照（${prev.day}）新增 ${delta.toFixed(2)} GB（体验用户贡献 ${dTrial.toFixed(2)} GB）`);
} else {
  console.log(`（首次运行，已存基线快照；明天起有日增量）`);
}
