#!/usr/bin/env node
/**
 * 阿里云网络分析与监控（NAM）一次性拨测：从全国随机探测点测各节点 /ping。
 * 复用 workers/api/.dev.vars 里的 RAM 密钥（需有 cms:CreateInstantSiteMonitor 权限，
 * 且账号已开通「网络分析与监控」；未开通时首个调用会报错提示）。
 *
 * 用法：
 *   node scripts/ali-sitemonitor.mjs probe [每节点探测点数，默认3]   # 建任务→等结果→出表
 *   node scripts/ali-sitemonitor.mjs probe-mobile [省份数=8] [nodes|URL] [lastmile]  # 移动全国各省 HTTPS 拨测
 *   node scripts/ali-sitemonitor.mjs result <TaskId>          # 单独查某个任务
 *
 * 计费：境内 IDC 探测点 0.001 元/次（无免费额度）。默认 6 节点 × 3 点 = 18 次 ≈ 0.018 元/轮。
 *
 * 与 probe-nodes.sh 的关系：那脚本只有中心服务器一个视角，本脚本覆盖全国多运营商，
 * 用于发现"被墙 / 单运营商路由爆炸"这类单点探测看不到的问题。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://metrics.cn-beijing.aliyuncs.com";
const VERSION = "2019-01-01";

// 当前节点表（legacy：节点域名挂 CF，国内解析慢；仅 probe nodes 怀旧模式用）
const NODES = [
  { name: "MY 马来西亚 01", host: "my01.fastergamer.click" },
  { name: "HK 香港 02", host: "hk01.fastergamer.click" },
  { name: "JP 日本 03", host: "jp01.fastergamer.click" },
  { name: "JP 日本 04", host: "jp02.fastergamer.click" },
  { name: "HK 香港 05", host: "hk02.fastergamer.click" },
  { name: "HK 香港 06", host: "hk03.fastergamer.click" },
];

// 默认探测目标：主站 /health（用户取订阅的入口域名，CF Worker）。
// 客户端连接节点已 IP 直发无需解析，拨测验证的就是入口域名的国内可达性。
const SITE_ENTRY = { name: "主站健康检查（CF Worker）", host: "fastergamer.click", path: "/health" };

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "workers/api/.dev.vars"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);
if (!env.ALIYUN_ACCESS_KEY_ID || !env.ALIYUN_ACCESS_KEY_SECRET) {
  console.error("缺少 ALIYUN_ACCESS_KEY_ID/SECRET（workers/api/.dev.vars）");
  process.exit(1);
}

const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function call(action, extra = {}) {
  const params = {
    Action: action,
    Version: VERSION,
    Format: "JSON",
    AccessKeyId: env.ALIYUN_ACCESS_KEY_ID,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    ...extra,
  };
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join("&");
  params.Signature = crypto
    .createHmac("sha1", env.ALIYUN_ACCESS_KEY_SECRET + "&")
    .update(`GET&${enc("/")}&${enc(qs)}`)
    .digest("base64");
  const url =
    `${ENDPOINT}/?` +
    Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok || (json?.Code && json.Code !== "200")) {
    const msg = json?.Message ?? (await res.text());
    console.error(`[cms] ${action} 失败: ${msg}`);
    if (/网络分析与监控/.test(msg)) {
      console.error("提示：需先在控制台开通「网络分析与监控」（免费），或检查 RAM 权限");
    }
    process.exit(1);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实用户接入场景：三大运营商 LASTMILE（家庭宽带）探测点，兼顾地域分布
const ISP_POINTS = [
  { city: "357", isp: "132", type: "LASTMILE", label: "上海电信" },
  { city: "738", isp: "232", type: "LASTMILE", label: "北京联通" },
  { city: "777", isp: "5", type: "LASTMILE", label: "广州移动" },
];

function pickTargets(targetUrl) {
  // 目标选择：默认 sub 入口（用户真实链路）；nodes = legacy 六节点；URL = 任意单目标
  return targetUrl === "nodes"
    ? NODES.map((n) => ({ ...n, url: `https://${n.host}/ping` }))
    : targetUrl
    ? [{ name: targetUrl, host: new URL(targetUrl).host, url: targetUrl }]
    : [{ ...SITE_ENTRY, url: `https://${SITE_ENTRY.host}${SITE_ENTRY.path}` }];
}

// 指定 IspCities 探测点集合的通用拨测：建任务 → 轮询 → 出表
async function runIspProbe(targets, ispCities, desc) {
  const total = targets.length * ispCities.length;
  console.log(`将创建 ${targets.length} 任务 × ${ispCities.length} 探测点（${desc}）= ${total} 次探测`);
  const tasks = [];
  for (const n of targets) {
    const r = await call("CreateInstantSiteMonitor", {
      TaskName: `fg-isp-${n.host.split(".")[0]}`,
      Address: n.url,
      TaskType: "HTTP",
      IspCities: JSON.stringify(ispCities),
      // 注意：不要传 OptionsJson——实测带 response_content/match_rule 的任务会静默不执行
    });
    const t = r.CreateResultList?.[0];
    if (t?.TaskId) tasks.push({ ...n, taskId: t.TaskId });
    console.log(`✓ 任务已创建 ${n.name} (${t?.TaskId ?? "?"})`);
  }

  console.log(`\n等待探测执行（${tasks.length} 任务 × ${ispCities.length} 点）...`);
  const deadline = Date.now() + 180_000;
  const done = new Set();
  while (Date.now() < deadline && done.size < tasks.length) {
    await sleep(10_000);
    for (const t of tasks) {
      if (done.has(t.taskId)) continue;
      const log = await call("DescribeSiteMonitorLog", { TaskIds: t.taskId });
      const items = JSON.parse(log.Data || "[]");
      if (items.length >= ispCities.length) done.add(t.taskId);
      t.items = items;
    }
  }

  for (const t of tasks) {
    console.log(`\n── ${t.name} (${t.host})`);
    const items = t.items ?? [];
    if (!items.length) {
      console.log(`   无结果（稍后可用 result ${t.taskId} 再查）`);
      continue;
    }
    for (const it of items) {
      const where = `${it.provinceCN ?? ""}${it.cityCN ?? ""}/${it.ispCN ?? it.isp ?? "?"}`;
      if (it.errorCode) {
        console.log(`   ✗ ${where}  errorCode=${it.errorCode} http=${it.HTTPResponseCode || "-"}`);
      } else {
        console.log(`   ✓ ${where}  总耗时 ${it.TotalTime}ms (dns ${it.HTTPDNSTime} / tcp ${it.tcpConnectTime} / tls ${it.SSLConnectTime}ms)`);
      }
    }
  }
}

async function probeIsp(targetUrl) {
  const ispCities = ISP_POINTS.map(({ city, isp, type }) => ({ city, isp, type }));
  await runIspProbe(pickTargets(targetUrl), ispCities, "LASTMILE 家庭宽带，单价高于 IDC");
}

// 移动全国：动态拉取探测点列表，每省取 IPV4 探测资源最多的一个移动城市，覆盖 n 个省份。
// 默认 IDC 点（0.001 元/次，每晚 8 省 × 1 目标 ≈ ¥0.008）；lastmile 换家庭宽带点（更贴近真实用户，单价更高）。
async function probeMobile(n = 8, targetUrl, lastmile = false) {
  const r = await call("DescribeSiteMonitorIspCityList");
  const all = r.IspCityList?.IspCity ?? [];
  const byRegion = new Map();
  for (const p of all) {
    // Country 629=中国，Isp 5=移动；IPV4ProbeCount=0 的点不可用
    if (p.Country !== "629" || p.Isp !== "5" || !(p.IPV4ProbeCount > 0)) continue;
    const cur = byRegion.get(p.Region);
    if (!cur || p.IPV4ProbeCount > cur.IPV4ProbeCount) byRegion.set(p.Region, p);
  }
  const points = [...byRegion.values()]
    .sort((a, b) => b.IPV4ProbeCount - a.IPV4ProbeCount)
    .slice(0, n);
  if (!points.length) {
    console.error("未拿到可用移动探测点（DescribeSiteMonitorIspCityList 为空）");
    process.exit(1);
  }
  const type = lastmile ? "LASTMILE" : "IDC";
  console.log(`移动探测点（${type}）：${points.map((p) => `${p["Region.zh_CN"]}${p["CityName.zh_CN"]}`).join("、")}`);
  const ispCities = points.map((p) => ({ city: p.City, isp: p.Isp, type }));
  await runIspProbe(pickTargets(targetUrl), ispCities, `移动 ${type}`);
}

async function probe(points = 3, legacyNodes = false) {
  const targets = legacyNodes ? NODES : [SITE_ENTRY];
  console.log(`将创建 ${targets.length} 任务 × ${points} 探测点 = ${targets.length * points} 次探测，预计 ¥${(targets.length * points * 0.001).toFixed(3)}`);
  // 1. 建一次性 HTTP 拨测任务：GET /ping，响应含 pong 判成功
  const tasks = [];
  for (const n of targets) {
    const r = await call("CreateInstantSiteMonitor", {
      TaskName: `fg-${n.host.split(".")[0]}`,
      Address: `https://${n.host}${n.path ?? "/ping"}`,
      TaskType: "HTTP",
      RandomIspCity: String(points),
      // 注意：不要传 OptionsJson——实测带 response_content/match_rule 的任务会静默不执行
    });
    const t = r.CreateResultList?.[0];
    if (t?.TaskId) tasks.push({ ...n, taskId: t.TaskId });
    console.log(`✓ 任务已创建 ${n.name} (${t?.TaskId ?? "?"})`);
  }

  // 2. 轮询结果（探测点执行需要时间，最多等 3 分钟）
  console.log(`\n等待探测执行（${tasks.length} 任务 × ${points} 探测点）...`);
  const deadline = Date.now() + 180_000;
  const done = new Set();
  while (Date.now() < deadline && done.size < tasks.length) {
    await sleep(10_000);
    for (const t of tasks) {
      if (done.has(t.taskId)) continue;
      const log = await call("DescribeSiteMonitorLog", { TaskIds: t.taskId });
      const items = JSON.parse(log.Data || "[]");
      if (items.length >= points) done.add(t.taskId);
      t.items = items;
    }
  }

  // 3. 出表：每节点列出各探测点结果（Data 是 JSON 字符串，字段含城市/运营商/耗时/错误码）
  for (const t of tasks) {
    console.log(`\n── ${t.name} (${t.host})  task=${t.taskId}`);
    const items = t.items ?? [];
    if (!items.length) {
      console.log("   无结果（超时未返回，可稍后 result 子命令再查）");
      continue;
    }
    for (const it of items) {
      const where = `${it.provinceCN ?? ""}${it.cityCN ?? ""}/${it.ispCN ?? it.isp ?? "?"}`;
      if (it.errorCode) {
        console.log(`   ✗ ${where}  errorCode=${it.errorCode} http=${it.HTTPResponseCode || "-"}`);
      } else {
        console.log(`   ✓ ${where}  总耗时 ${it.TotalTime}ms (dns ${it.HTTPDNSTime} / tcp ${it.tcpConnectTime} / tls ${it.SSLConnectTime} / 下载 ${it.HTTPDownloadTime}ms)`);
      }
    }
  }
}

async function result(taskId) {
  const log = await call("DescribeSiteMonitorLog", { TaskIds: taskId });
  const items = JSON.parse(log.Data || "[]");
  for (const it of items) {
    const where = `${it.provinceCN ?? ""}${it.cityCN ?? ""}/${it.ispCN ?? it.isp ?? "?"}`;
    if (it.errorCode) {
      console.log(`✗ ${where}  errorCode=${it.errorCode} http=${it.HTTPResponseCode || "-"}`);
    } else {
      console.log(`✓ ${where}  ${it.TotalTime}ms`);
    }
  }
  if (!items.length) console.log("（暂无数据，探测点可能仍在执行，稍后重试）");
}

const [cmd, arg, arg2, arg3] = process.argv.slice(2);
// probe / probe-isp / probe-mobile 默认测 sub 入口（用户真实链路）；加 nodes 参数怀旧测六节点 CF 域名
if (cmd === "probe") await probe(parseInt(arg2 ?? arg, 10) || 3, arg === "nodes" || arg2 === "nodes");
else if (cmd === "probe-isp") await probeIsp(arg);
else if (cmd === "probe-mobile") {
  // probe-mobile [省份数=8] [nodes|URL] [lastmile]
  const rest = [arg, arg2, arg3].filter(Boolean);
  const n = parseInt(rest.find((a) => /^\d+$/.test(a)) ?? "8", 10);
  const target = rest.find((a) => a === "nodes" || /^https?:\/\//.test(a));
  await probeMobile(n, target, rest.includes("lastmile"));
}
else if (cmd === "result" && arg) await result(arg);
else {
  console.error("用法: node scripts/ali-sitemonitor.mjs probe [点数|nodes] | probe-isp [URL|nodes] | probe-mobile [省份数=8] [nodes|URL] [lastmile] | result <TaskId>");
  process.exit(1);
}
