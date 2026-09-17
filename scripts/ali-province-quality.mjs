#!/usr/bin/env node
/**
 * 香港/日本节点 全国省份×运营商 每日链路质量拨测（阿里云 NAM 一次性任务，晚高峰跑）。
 * 与 node-quality.mjs（本机单点 + 隧道内下载测速）互补：本脚本从全国 IDC 探测点（约 134 个，
 * 覆盖各省三网）发起，只测 HK/JP 节点，输出分省分运营商矩阵。
 *
 * 指标口径：
 *   - RTT / P95 RTT：ICMP PING，每点报均值；P95 取「点均值」的分布
 *   - jitter：同一探测点 3 轮 PING 的相邻样本差值绝对值平均（单轮一次性任务测不了抖动）
 *   - 丢包率：3 轮 PING 中失败样本占比（点级 0/33/67/100%）
 *   - TCP 建连时间：TCP:443 拨测的建连耗时（1 轮）
 *   - 下载速度：NAM 探针是裸 TCP/ICMP，跑不了 VLESS 隧道，本脚本不测；
 *     真实代理吞吐看 node-quality.mjs（本机视角）
 *
 * 用法：
 *   node scripts/ali-province-quality.mjs                 # HK+JP 全部 active 节点，全国 IDC 点，3 轮
 *   node scripts/ali-province-quality.mjs --rounds 2      # 少一轮省 1/4 费用（jitter 变粗）
 *   node scripts/ali-province-quality.mjs --regions HK    # 只测香港
 *   node scripts/ali-province-quality.mjs --isp 移动      # 只测移动点；电信/联通复用最近一次全量数据
 *   node scripts/ali-province-quality.mjs --exclude 日本06  # 排除已知差的节点（逗号分隔多个）
 *
 * 计费：0.001 元/次 ≈ 点数 × 节点数 × (轮数+1)。全量 10 节点 3 轮 ≈ ¥5.3/晚；
 * 仅移动（约 44 点）9 节点 ≈ ¥1.6/晚。
 * 密钥：workers/api/.dev.vars 的 ALIYUN_ACCESS_KEY_ID/SECRET + ADMIN_KEY。
 * cron: 14 21 * * * node /home/wafer/cloudflare/scripts/ali-province-quality.mjs --isp 移动 --exclude 日本06 >> /home/wafer/cloudflare/scripts/.probe/province-quality.log 2>&1
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
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
const opt = { rounds: 3, regions: ["HK", "JP"], isp: null, exclude: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--rounds") opt.rounds = Number(args[++i]);
  else if (args[i] === "--regions") opt.regions = args[++i].split(",").map((s) => s.trim().toUpperCase());
  else if (args[i] === "--isp") opt.isp = args[++i];
  else if (args[i] === "--exclude") opt.exclude = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------- 密钥 ----------
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "workers/api/.dev.vars"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
if (!env.ALIYUN_ACCESS_KEY_ID || !env.ADMIN_KEY) {
  console.error("缺少 ALIYUN_ACCESS_KEY_ID/SECRET 或 ADMIN_KEY（.dev.vars）");
  process.exit(1);
}

// ---------- 阿里云签名调用 ----------
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

// ---------- 节点清单（HK/JP active，解析 IP） ----------
const res = await fetch("https://fastergamer.click/api/admin/nodes", { headers: { "x-admin-key": env.ADMIN_KEY } });
const { data } = await res.json();
const targets = [];
for (const n of (data ?? []).filter((n) => n.active && opt.regions.includes((n.region ?? "").toUpperCase()))) {
  const name = n.name.replace(/\s+/g, "");
  if (opt.exclude.includes(name) || opt.exclude.includes(n.name)) {
    console.log(`已排除：${n.name}`);
    continue;
  }
  const ip = (await dns.resolve4(n.host).catch(() => []))[0];
  if (ip) targets.push({ name, host: n.host, region: n.region, ip });
  else console.log(`⚠ ${n.name} 解析失败，跳过`);
}
if (!targets.length) { console.error("没有匹配的 HK/JP active 节点"); process.exit(1); }

// ---------- 探测点（境内 IDC；--isp 限定单一运营商） ----------
const ispCode = opt.isp
  ? (ISP_NAME[opt.isp] ? opt.isp : Object.keys(ISP_NAME).find((k) => ISP_NAME[k] === opt.isp))
  : null;
if (opt.isp && !ispCode) { console.error(`--isp 只支持 ${Object.values(ISP_NAME).join("/")}`); process.exit(1); }
const ispListJson = await call("DescribeSiteMonitorISPCityList");
const points = (ispListJson.IspCityList?.IspCity ?? [])
  .filter((x) => x.Country === "629" && ISP_NAME[x.Isp] && x.IPV4ProbeCount > 0)
  .filter((x) => !ispCode || x.Isp === ispCode)
  .map((x) => ({ city: x.City, isp: x.Isp }));
const chunks = [];
for (let i = 0; i < points.length; i += CHUNK) chunks.push(points.slice(i, i + CHUNK));
const totalProbes = points.length * targets.length * (opt.rounds + 1);
console.log(`节点 ${targets.length} 个（${targets.map((t) => t.name).join("、")}）`);
console.log(`探测点 ${points.length} 个 × ${targets.length} 节点 × (${opt.rounds} 轮 PING + 1 轮 TCP) = ${totalProbes} 次（约 ¥${(totalProbes * 0.001).toFixed(2)}）`);

// ---------- 建任务：每节点 rounds 轮 PING + 1 轮 TCP:443 ----------
const tasks = []; // { target, kind: "ping"|"tcp", round, expect, id }
for (const t of targets) {
  const specs = [
    ...Array.from({ length: opt.rounds }, (_, r) => ({ kind: "ping", round: r, type: "PING" })),
    { kind: "tcp", round: 0, type: "TCP" },
  ];
  for (const s of specs) {
    for (let c = 0; c < chunks.length; c++) {
      const r = await call("CreateInstantSiteMonitor", {
        TaskName: `pq-${t.name}-${s.kind}${s.round}-${c}`,
        Address: t.ip, TaskType: s.type,
        ...(s.type === "TCP" ? { OptionsJson: JSON.stringify({ port: 443 }) } : {}),
        IspCities: JSON.stringify(chunks[c].map(({ city, isp }) => ({ city, isp, type: "IDC" }))),
      });
      const id = r.CreateResultList?.[0]?.TaskId ?? r.TaskId;
      tasks.push({ target: t, ...s, expect: chunks[c].length, id });
    }
  }
}
console.log(`✓ 已建 ${tasks.length} 个任务，等待执行（每 20s 轮询，最多 10 分钟）...`);

// ---------- 收结果 ----------
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
const incomplete = tasks.filter((t) => !t.items);
if (incomplete.length) console.log(`⚠ ${incomplete.length} 个任务数据不全，按已返回部分分析`);

// ---------- 汇总成 点×节点 样本 ----------
// samples[node][pointKey] = { province, isp, pings: [ms|null×rounds], tcp: ms|null }
const samples = {};
for (const t of tasks) {
  const byNode = (samples[t.target.name] ??= {});
  for (const it of t.items ?? []) {
    const key = `${it.provinceCN ?? ""}|${it.cityCN ?? ""}|${it.ispCN ?? "?"}`;
    const p = (byNode[key] ??= { province: it.provinceCN ?? "", isp: it.ispCN ?? "?", pings: Array(opt.rounds).fill(null), tcp: null, fresh: true });
    const v = !it.errorCode && it.TotalTime != null ? Number(it.TotalTime) : null;
    if (t.kind === "ping") p.pings[t.round] = v;
    else p.tcp = v;
  }
}

// --isp 限定单运营商时，其余运营商复用最近一次全量拨测数据（只补展示，不进趋势 CSV）
let reusedFrom = null;
if (opt.isp) {
  // 从最新往最旧找第一份「含其他运营商数据」的明细（移动-only 的明细只有移动点，得跳过）
  const files = fs.existsSync(OUT_DIR)
    ? fs.readdirSync(OUT_DIR).filter((f) => /^province-quality-.+\.json$/.test(f)).sort().reverse()
    : [];
  for (const f of files) {
    const old = JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8"));
    const hasOther = Object.values(old.samples ?? {}).some((pts) =>
      Object.values(pts).some((p) => p.isp && p.isp !== opt.isp));
    if (!hasOther) continue;
    reusedFrom = old.at;
    for (const t of targets) {
      const byNode = (samples[t.name] ??= {});
      for (const [key, p] of Object.entries(old.samples?.[t.name] ?? {})) {
        if (p.isp !== opt.isp && !(key in byNode)) byNode[key] = { ...p, fresh: false };
      }
    }
    console.log(`其他运营商数据复用自 ${f}（${old.at}）`);
    break;
  }
  if (!reusedFrom) console.log("⚠ 没有找到可复用的历史全量数据，其他运营商列为空");
}

const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const fmt = (v) => (v == null ? "-" : v.toFixed(0));

// ---------- 每节点总览 ----------
console.log("\n══ 节点总览（RTT/jitter/丢包 来自 3 轮 PING；TCP 为 443 建连耗时；单位 ms）");
if (reusedFrom) console.log(`（仅 ${opt.isp}为本次实测，其余运营商复用 ${reusedFrom} 的全量数据）`);
console.log("节点".padEnd(12) + "可达率".padStart(8) + "RTT".padStart(6) + "P95".padStart(6) + "jitter".padStart(8)
  + "丢包%".padStart(7) + "TCP".padStart(6)
  + "电信".padStart(6) + "联通".padStart(6) + "移动".padStart(6));
const overview = [];
for (const t of targets) {
  const pts = Object.values(samples[t.name] ?? {});
  const pointAvgs = [], jitters = [], tcps = [];
  let fails = 0, total = 0;
  for (const p of pts) {
    const ok = p.pings.filter((v) => v != null);
    total += p.pings.length; fails += p.pings.length - ok.length;
    if (ok.length) pointAvgs.push(avg(ok));
    const diffs = ok.slice(1).map((v, i) => Math.abs(v - ok[i]));
    if (diffs.length) jitters.push(avg(diffs));
    if (p.tcp != null) tcps.push(p.tcp);
  }
  const byIsp = {};
  for (const isp of ["电信", "联通", "移动"]) {
    byIsp[isp] = avg(pts.filter((p) => p.isp === isp).map((p) => avg(p.pings.filter((v) => v != null))).filter((v) => v != null));
  }
  const st = {
    reach: total ? ((total - fails) / total) * 100 : 0,
    rtt: avg(pointAvgs), p95: pct(pointAvgs, 95), jitter: avg(jitters),
    loss: total ? (fails / total) * 100 : 100, tcp: avg(tcps), byIsp,
  };
  overview.push({ node: t.name, region: t.region, ...st });
  console.log(t.name.padEnd(12) + `${st.reach.toFixed(0)}%`.padStart(8) + fmt(st.rtt).padStart(6)
    + fmt(st.p95).padStart(6) + fmt(st.jitter).padStart(8) + st.loss.toFixed(1).padStart(7)
    + fmt(st.tcp).padStart(6)
    + fmt(st.byIsp["电信"]).padStart(6) + fmt(st.byIsp["联通"]).padStart(6) + fmt(st.byIsp["移动"]).padStart(6));
}

// ---------- 省份×运营商矩阵（省内多城市取平均） ----------
const provKeys = [...new Set(
  targets.flatMap((t) => Object.values(samples[t.name] ?? {}).map((p) => `${p.province}|${p.isp}`))
)].sort();
console.log("\n══ 省份×运营商 平均 RTT（ms, E=失败/无数据）");
console.log("省份|运营商".padEnd(16) + targets.map((t) => t.name.slice(0, 8).padStart(9)).join(""));
const blind = [];
for (const key of provKeys) {
  let row = key.padEnd(16);
  let best = { n: null, v: Infinity };
  for (const t of targets) {
    const vs = Object.entries(samples[t.name] ?? {})
      .filter(([k]) => `${samples[t.name][k].province}|${samples[t.name][k].isp}` === key)
      .map(([, p]) => avg(p.pings.filter((v) => v != null)))
      .filter((v) => v != null);
    const v = avg(vs);
    row += (v == null ? "E" : fmt(v)).padStart(9);
    if (v != null && v < best.v) best = { n: t.name, v };
  }
  if (best.v > 100 || !best.n) blind.push(`${key} 最优=${best.n ?? "全部失败"}${best.v === Infinity ? "" : ` ${fmt(best.v)}ms`}`);
  console.log(row);
}
console.log("\n══ 盲区（最优仍 >100ms 或不可达）");
console.log(blind.length ? blind.map((b) => `  · ${b}`).join("\n") : "  无");

// ---------- 存档 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
fs.mkdirSync(OUT_DIR, { recursive: true });
// 明细与趋势只存本次实测的点（fresh），复用的旧数据不落盘，避免复用链逐晚传递陈旧副本
const freshSamples = Object.fromEntries(
  Object.entries(samples).map(([node, pts]) => [
    node,
    Object.fromEntries(Object.entries(pts).filter(([, p]) => p.fresh !== false)),
  ])
);
const detail = {
  at: new Date().toISOString(), rounds: opt.rounds, points: points.length,
  isp: opt.isp ?? "三网", excluded: opt.exclude, reused_from: reusedFrom,
  targets: targets.map((t) => ({ name: t.name, host: t.host, region: t.region, ip: t.ip })),
  overview, samples: freshSamples,
};
fs.writeFileSync(path.join(OUT_DIR, `province-quality-${stamp}.json`), JSON.stringify(detail, null, 1));

const csvPath = path.join(OUT_DIR, "province-quality-history.csv");
if (!fs.existsSync(csvPath)) {
  fs.writeFileSync(csvPath, "at,node,province,isp,rtt_ms,jitter_ms,loss_pct,tcp_ms\n");
}
for (const t of targets) {
  for (const [key, p] of Object.entries(freshSamples[t.name] ?? {})) {
    const ok = p.pings.filter((v) => v != null);
    const diffs = ok.slice(1).map((v, i) => Math.abs(v - ok[i]));
    const [province, , isp] = key.split("|");
    fs.appendFileSync(csvPath, [
      stamp, t.name, province, isp,
      avg(ok)?.toFixed(1) ?? "", avg(diffs)?.toFixed(1) ?? "",
      ((p.pings.length - ok.length) / p.pings.length * 100).toFixed(0), p.tcp?.toFixed(1) ?? "",
    ].join(",") + "\n");
  }
}
console.log(`\n明细存 scripts/.probe/province-quality-${stamp}.json，点级趋势追加 province-quality-history.csv`);
