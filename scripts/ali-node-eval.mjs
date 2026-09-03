#!/usr/bin/env node
/**
 * 候选 VPS 全国三网拨测评估：测延迟 + 可达性 + 冗余覆盖，输出采购建议数据。
 *
 * 用法：
 *   node scripts/ali-node-eval.mjs "HK-候选A=1.2.3.4" "JP-候选B=5.6.7.8" [更多 NAME=IP 或裸 IP]
 *   node scripts/ali-node-eval.mjs --isp 移动 "HK-候选A=1.2.3.4"   # 只测某运营商（移动/电信/联通）
 *   node scripts/ali-node-eval.mjs --points 6 "HK-候选A=1.2.3.4"   # 少量点快速验证
 *   node scripts/ali-node-eval.mjs "hk01-reality=1.2.3.4:8444:TCP" "hk01-hy2=1.2.3.4:8445:UDP"  # 协议级对比
 *
 * 流程：DescribeSiteMonitorISPCityList 拉全国 IDC 三网探测点（约 134 个）
 *   → 每个目标建一次性拨测任务（PING/TCP/UDP，每任务最多 50 点，自动分批）
 *   → 轮询收结果 → 原始 JSON 存 scripts/.probe/ → 打印分析报告
 *
 * 计费：境内 IDC 点 0.001 元/次，全量 ≈ 0.001 × 134 × IP 数（6 个 IP ≈ 0.8 元）。
 * 密钥：复用 workers/api/.dev.vars 的 ALIYUN_ACCESS_KEY_ID/SECRET（需已开通 NAM）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "scripts", ".probe");
const ENDPOINT = "https://metrics.cn-beijing.aliyuncs.com";
const VERSION = "2019-01-01";
const CHUNK = 50; // 单任务 IspCities 上限留白
const ISP_NAME = { "5": "移动", "132": "电信", "232": "联通" };

// ---------- 参数 ----------
const args = process.argv.slice(2);
let maxPoints = Infinity;
let ispFilter = null; // --isp 移动|电信|联通（或代码 5/132/232）
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--points") { maxPoints = Number(args[++i]); continue; }
  if (args[i] === "--isp") { ispFilter = args[++i]; continue; }
  const m = args[i].match(/^([^=]+)=([\d.]+)(?::(\d+)(?::(PING|TCP|UDP))?)?$/i);
  if (m) targets.push({ name: m[1], ip: m[2], port: m[3] ? Number(m[3]) : null, type: (m[4] ?? (m[3] ? "TCP" : "PING")).toUpperCase() });
  else if (/^[\d.]+$/.test(args[i])) targets.push({ name: args[i], ip: args[i], port: null, type: "PING" });
}
if (!targets.length) {
  console.error('用法: node scripts/ali-node-eval.mjs [--points N] [--isp 移动|电信|联通] "名称=IP[:端口[:PING|TCP|UDP]]" [更多...]');
  process.exit(1);
}

// ---------- 阿里云签名调用 ----------
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "workers/api/.dev.vars"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
if (!env.ALIYUN_ACCESS_KEY_ID) { console.error("缺少 ALIYUN_ACCESS_KEY_ID/SECRET"); process.exit(1); }

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
async function call(action, extra = {}) {
  const params = {
    Action: action, Version: VERSION, Format: "JSON",
    AccessKeyId: env.ALIYUN_ACCESS_KEY_ID, SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(), SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"), ...extra,
  };
  const qs = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
  params.Signature = crypto.createHmac("sha1", env.ALIYUN_ACCESS_KEY_SECRET + "&")
    .update(`GET&${enc("/")}&${enc(qs)}`).digest("base64");
  const url = `${ENDPOINT}/?` + Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok || (json?.Code && json.Code !== "200" && !/success/i.test(json.Code)))
    throw new Error(`${action}: ${json?.Message ?? res.status}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 探测点 ----------
const ispListJson = await call("DescribeSiteMonitorISPCityList");
let points = (ispListJson.IspCityList?.IspCity ?? [])
  .filter((x) => x.Country === "629" && ISP_NAME[x.Isp] && x.IPV4ProbeCount > 0)
  .map((x) => ({
    city: x.City, isp: x.Isp,
    label: `${x["Region.zh_CN"]}/${x["CityName.zh_CN"]}/${x["IspName.zh_CN"]}`,
  }));
if (ispFilter) {
  const code = ISP_NAME[ispFilter] ? ispFilter
    : Object.keys(ISP_NAME).find((k) => ISP_NAME[k] === ispFilter);
  if (!code) { console.error(`--isp 只支持 ${Object.values(ISP_NAME).join("/")}（或代码 ${Object.keys(ISP_NAME).join("/")}）`); process.exit(1); }
  points = points.filter((p) => p.isp === code);
  if (!points.length) { console.error(`没有可用的「${ISP_NAME[code]}」探测点`); process.exit(1); }
}
if (points.length > maxPoints) points = points.slice(0, maxPoints);
const chunks = [];
for (let i = 0; i < points.length; i += CHUNK) chunks.push(points.slice(i, i + CHUNK));
console.log(`探测点 ${points.length} 个 × ${targets.length} IP = ${points.length * targets.length} 次（约 ${(points.length * targets.length * 0.001).toFixed(2)} 元）`);

// QUIC Initial（不支持的版本 0xFFFFFFFF + 填充到 1200B）：触发服务器版本协商响应，
// 让 UDP 探测能真实打到 Hy2 端口并测出往返延迟（裸 UDP 探测对 QUIC 服务全部超时）。
const QUIC_INIT_HEX = ("c0ffffffff08" + "1122334455667788" + "00").padEnd(2400, "0");

// ---------- 建任务 ----------
const tasks = [];
for (const t of targets) {
  for (let c = 0; c < chunks.length; c++) {
    const opts = t.port ? { port: t.port } : null;
    if (opts && t.type === "UDP") Object.assign(opts, { request_format: "hex", request_content: QUIC_INIT_HEX });
    const r = await call("CreateInstantSiteMonitor", {
      TaskName: `eval-${t.name}-${t.ip}${t.port ? `-${t.port}-${t.type}` : ""}-${c}`,
      Address: t.ip,
      TaskType: t.type,
      ...(opts ? { OptionsJson: JSON.stringify(opts) } : {}),
      IspCities: JSON.stringify(chunks[c].map(({ city, isp }) => ({ city, isp, type: "IDC" }))),
    });
    const id = r.CreateResultList?.[0]?.TaskId ?? r.TaskId;
    tasks.push({ ...t, expect: chunks[c].length, id });
  }
  console.log(`✓ ${t.name} (${t.ip}${t.port ? `:${t.port}/${t.type}` : "/PING"}) ${chunks.length} 个任务`);
}

// ---------- 收结果 ----------
console.log("等待执行（每 20s 轮询，最多 10 分钟）...");
for (let round = 0; round < 30; round++) {
  await sleep(20_000);
  let done = 0;
  for (const t of tasks) {
    if (t.items) { done++; continue; }
    try {
      const r = await call("DescribeSiteMonitorLog", { TaskIds: t.id });
      const items = JSON.parse(r.Data || "[]");
      if (items.length >= t.expect) { t.items = items; done++; }
    } catch { /* 下轮重试 */ }
  }
  if (done === tasks.length) break;
  if (round % 3 === 2) console.log(`  ${done}/${tasks.length} 任务完成`);
}

const results = [];
for (const t of tasks) {
  if (!t.items) console.log(`⚠ ${t.name} 有任务数据不全，按已返回部分分析`);
  for (const it of t.items ?? []) {
    results.push({
      node: t.name, ip: t.ip,
      province: it.provinceCN ?? "", city: it.cityCN ?? "", isp: it.ispCN ?? "?",
      rtt: it.TotalTime != null ? Number(it.TotalTime) : null,
      err: it.errorCode ? String(it.errorCode) : null,
    });
  }
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = path.join(OUT_DIR, `probe-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify({ targets, points: points.length, results }, null, 1));
console.log(`原始数据: ${outFile}（${results.length} 条）\n`);

// ---------- 分析 ----------
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (v) => (v == null ? "-" : v.toFixed(0));

// 1) 每节点总览：可达率 / 均值 / 分位 / 分运营商
console.log("══ 节点总览（可达率 = 有响应的省份×运营商组合占比）");
console.log("节点".padEnd(16) + "可达率".padStart(8) + "均值".padStart(7) + "P50".padStart(6) + "P95".padStart(6)
  + "电信".padStart(6) + "联通".padStart(6) + "移动".padStart(6));
const nodeStats = {};
for (const t of targets) {
  const rows = results.filter((r) => r.node === t.name);
  const ok = rows.filter((r) => !r.err && r.rtt != null);
  const byIsp = {};
  for (const isp of ["电信", "联通", "移动"]) byIsp[isp] = ok.filter((r) => r.isp === isp).map((r) => r.rtt);
  const st = {
    total: rows.length, ok: ok.length,
    reach: rows.length ? (ok.length / rows.length) * 100 : 0,
    avg: avg(ok.map((r) => r.rtt)), p50: pct(ok.map((r) => r.rtt), 50), p95: pct(ok.map((r) => r.rtt), 95),
    byIsp: Object.fromEntries(Object.entries(byIsp).map(([k, v]) => [k, avg(v)])),
  };
  nodeStats[t.name] = st;
  console.log(t.name.padEnd(16) + `${st.reach.toFixed(0)}%`.padStart(8) + fmt(st.avg).padStart(7)
    + fmt(st.p50).padStart(6) + fmt(st.p95).padStart(6)
    + fmt(st.byIsp["电信"]).padStart(6) + fmt(st.byIsp["联通"]).padStart(6) + fmt(st.byIsp["移动"]).padStart(6));
}

// 2) 不可达清单（可达性短板）
console.log("\n══ 不可达/失败点位（采购时重点排除大面积失败的机器）");
for (const t of targets) {
  const bad = results.filter((r) => r.node === t.name && (r.err || r.rtt == null));
  if (!bad.length) { console.log(`${t.name}: 全部可达`); continue; }
  console.log(`${t.name}: ${bad.length} 处失败`);
  for (const b of bad) console.log(`   ✗ ${b.province}${b.city}/${b.isp} err=${b.err ?? "no-rtt"}`);
}

// 3) 省份×运营商 明细表 + 每行最优
const keys = [...new Set(results.map((r) => `${r.province}|${r.isp}`))];
console.log("\n══ 省份×运营商 明细（ms, E=失败）");
console.log("省份|运营商".padEnd(14) + targets.map((t) => t.name.slice(0, 8).padStart(9)).join(""));
const wins = Object.fromEntries(targets.map((t) => [t.name, 0]));
const blindSpots = [];
for (const key of keys) {
  let row = key.padEnd(14);
  let best = { n: null, v: Infinity };
  for (const t of targets) {
    const rs = results.filter((r) => r.node === t.name && `${r.province}|${r.isp}` === key);
    const v = avg(rs.filter((r) => !r.err && r.rtt != null).map((r) => r.rtt));
    row += (v == null ? "E" : fmt(v)).padStart(9);
    if (v != null && v < best.v) best = { n: t.name, v };
  }
  if (best.n) wins[best.n]++;
  if (best.v > 80 || !best.n) blindSpots.push(`${key} 最优=${best.n ?? "全部失败"} ${best.v === Infinity ? "" : fmt(best.v) + "ms"}`);
  console.log(row);
}

// 4) 冗余覆盖结论
console.log("\n══ 冗余覆盖分析");
console.log("各地最优归属: " + targets.map((t) => `${t.name} 胜出 ${wins[t.name]}/${keys.length} 地`).join("，"));
if (blindSpots.length) {
  console.log(`盲区（最优仍 >80ms 或不可达，共 ${blindSpots.length} 地，多为物理极限）:`);
  for (const b of blindSpots) console.log(`   · ${b}`);
} else {
  console.log("无盲区：所有省份×运营商最优均在 80ms 内。");
}
