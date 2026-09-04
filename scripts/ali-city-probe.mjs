#!/usr/bin/env node
/**
 * 指定城市×运营商的节点拨测（阿里云 NAM 一次性任务）。
 * 与 ali-node-eval.mjs（全国面扫）互补：本脚本聚焦单城市三网，支持三种协议口径。
 *
 * 用法：
 *   node scripts/ali-city-probe.mjs                          # 成都 × 三网 × TCP+UDP，全部在线节点
 *   node scripts/ali-city-probe.mjs --city 深圳 --isp 移动    # 深圳移动
 *   node scripts/ali-city-probe.mjs --proto http             # 域名 HTTPS /ping（含 DNS 成本，验域名可达性）
 *   node scripts/ali-city-probe.mjs --proto tcp,udp --type IDC
 *
 * 协议口径：
 *   tcp = IP:443 建连（纯接入 RTT，最接近客户端显示延迟）
 *   udp = IP:8445 QUIC Initial（hy2 握手 RTT）
 *   http = https://域名/ping（含 DNS，用于发现「域名在某运营商解析失败」类问题）
 * 每种口径跑 IDC + LASTMILE（末梢，贴近家宽/手机）双轮，--type 可限定。
 *
 * 节点清单：默认从注册表 API 拉 active 节点（ADMIN_KEY 鉴权），IP 用 223.5.5.5 解析 host；
 * 也可 --nodes "名=IP" "名2=IP2" 手动指定。
 * 计费：0.001 元/次 ≈ 节点数 × 运营商数 × 轮数 × 协议数（11 节点三网双轮 TCP+UDP ≈ ¥0.13）。
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINT = "https://metrics.cn-beijing.aliyuncs.com";
const ISP_CODE = { 移动: "5", 电信: "132", 联通: "232" };
const QUIC_INIT_HEX = ("c0ffffffff08" + "1122334455667788" + "00").padEnd(2400, "0");

// ---------- 参数 ----------
const args = process.argv.slice(2);
const opt = { city: "成都", isp: null, proto: "tcp,udp", type: null, nodes: [] };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--city") opt.city = args[++i];
  else if (args[i] === "--isp") opt.isp = args[++i];
  else if (args[i] === "--proto") opt.proto = args[++i];
  else if (args[i] === "--type") opt.type = args[++i].toUpperCase();
  else if (args[i] === "--nodes") { while (args[i + 1]?.includes("=")) opt.nodes.push(args[++i]); }
}
const protos = opt.proto.split(",").map((s) => s.trim().toLowerCase());
const ispEntries = opt.isp ? [[ISP_CODE[opt.isp], opt.isp]] : Object.entries(ISP_CODE).map(([k, v]) => [v, k]);
const pointTypes = opt.type ? [opt.type] : ["IDC", "LASTMILE"];

// ---------- 阿里云签名调用 ----------
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "workers/api/.dev.vars"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
async function call(action, extra = {}) {
  const params = { Action: action, Version: "2019-01-01", Format: "JSON", AccessKeyId: env.ALIYUN_ACCESS_KEY_ID,
    SignatureMethod: "HMAC-SHA1", SignatureNonce: crypto.randomUUID(), SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), ...extra };
  const qs = Object.keys(params).sort().map((k) => enc(k) + "=" + enc(params[k])).join("&");
  params.Signature = crypto.createHmac("sha1", env.ALIYUN_ACCESS_KEY_SECRET + "&").update("GET&%2F&" + enc(qs)).digest("base64");
  const r = await fetch(`${ENDPOINT}/?Signature=${enc(params.Signature)}&${qs}`);
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 城市名 → 城市代码 ----------
async function cityCode(name) {
  const r = await call("DescribeSiteMonitorIspCityList");
  const hit = (r.IspCityList?.IspCity ?? []).find(
    (p) => p.Country === "629" && (p["CityName.zh_CN"] ?? "").includes(name)
  );
  if (!hit) { console.error(`未找到城市「${name}」的探测点`); process.exit(1); }
  return hit.City;
}

// ---------- 节点清单 ----------
async function loadNodes() {
  if (opt.nodes.length) {
    return opt.nodes.map((s) => { const [name, ip] = s.split("="); return { name, ip }; });
  }
  const r = await fetch("https://fastergamer.click/api/admin/nodes", { headers: { "x-admin-key": env.ADMIN_KEY } });
  const { data } = await r.json();
  const out = [];
  for (const n of data.filter((n) => n.active)) {
    const ip = (await dns.resolve4(n.host).catch(() => []))[0];
    if (ip) out.push({ name: n.name.replace(/\s+/g, ""), host: n.host, ip });
  }
  return out;
}

// ---------- 拨测 ----------
async function run(proto, type, city, nodes) {
  const ispCities = JSON.stringify(ispEntries.map(([isp]) => ({ city, isp, type })));
  const tasks = [];
  for (const n of nodes) {
    const spec = proto === "http"
      ? { Address: `https://${n.host}/ping`, TaskType: "HTTP" }
      : proto === "udp"
      ? { Address: n.ip, TaskType: "UDP", OptionsJson: JSON.stringify({ port: 8445, request_format: "hex", request_content: QUIC_INIT_HEX }) }
      : { Address: n.ip, TaskType: "TCP", OptionsJson: JSON.stringify({ port: 443 }) };
    const r = await call("CreateInstantSiteMonitor", {
      TaskName: `fg-city-${n.name}-${proto}-${type}`, ...spec, IspCities: ispCities,
    });
    const t = r.CreateResultList?.[0];
    if (t?.TaskId) tasks.push({ ...n, taskId: t.TaskId });
    else console.log("任务创建失败", n.name, JSON.stringify(r).slice(0, 150));
  }
  const deadline = Date.now() + 240_000;
  const done = new Set();
  while (Date.now() < deadline && done.size < tasks.length) {
    await sleep(8_000);
    for (const t of tasks) {
      if (done.has(t.taskId)) continue;
      const log = await call("DescribeSiteMonitorLog", { TaskIds: t.taskId });
      const items = JSON.parse(log.Data || "[]");
      if (items.length >= ispEntries.length) { done.add(t.taskId); t.items = items; }
    }
  }
  console.log(`\n══ ${opt.city}三网 ${type} · ${proto.toUpperCase()} ══`);
  for (const t of tasks) {
    const cells = ispEntries.map(([isp, label]) => {
      const it = (t.items ?? []).find((x) => String(x.isp) === isp || x.ispCN === label);
      if (!it) return `${label}:无结果`;
      if (it.errorCode) return `${label}:✗${it.errorCode}`;
      return proto === "http"
        ? `${label}:tcp ${it.tcpConnectTime}/tls ${it.SSLConnectTime}/总 ${it.TotalTime}ms`
        : `${label}:${it.TotalTime}ms`;
    });
    console.log(`${t.name.padEnd(10)} ${cells.join("  ")}`);
  }
}

const [city, nodes] = await Promise.all([cityCode(opt.city), loadNodes()]);
console.log(`城市=${opt.city}(${city}) 运营商=${ispEntries.map(([, l]) => l).join("/")} 协议=${protos.join("+")} 轮次=${pointTypes.join("+")}`);
console.log(`节点: ${nodes.map((n) => n.name).join("、")}`);
for (const proto of protos) for (const type of pointTypes) await run(proto, type, city, nodes);
