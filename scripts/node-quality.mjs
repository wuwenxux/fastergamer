#!/usr/bin/env node
/**
 * 节点链路质量每日拨测（客户端视角，晚高峰运行）。
 *
 * 每个 active 节点测：
 *   - TCP 建连时间：本机直连节点入口 host:port（不经隧道），多采样取平均
 *   - RTT / P95 RTT / jitter / 丢包率：经 VLESS+WS+TLS 隧道访问节点自身 /ping
 *     连续采样（loss = 失败样本占比，jitter = 相邻样本差值绝对值的平均）
 *   - 实际下载速度：经隧道下载自家客户端镜像站（dl.fastergamer.click，R2）测试文件，
 *     Range 取前 N MB（出口在被测节点，反映真实代理吞吐）
 *
 * 结果打印表格，并写入 scripts/.probe/quality-<时间戳>.json（明细）
 * 与 scripts/.probe/quality-history.csv（趋势）。
 *
 * 用法: node scripts/node-quality.mjs [--samples N] [--download-mb N]
 * cron: 14 21 * * * node /home/wafer/cloudflare/scripts/node-quality.mjs >> /home/wafer/cloudflare/scripts/.probe/quality.log 2>&1
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const DEV_VARS = "/home/wafer/cloudflare/workers/api/.dev.vars";
const API_BASE = "https://fastergamer.click";
const PROBE_DIR = "/home/wafer/cloudflare/scripts/.probe";
const XRAY_CANDIDATES = [
  `${process.env.HOME}/.cache/xray-client-test/xray`,
  "/home/wafer/tools/xray",
];

const argVal = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
};
const LATENCY_SAMPLES = argVal("--samples", 20); // 隧道内 /ping 采样次数
const DOWNLOAD_MB = argVal("--download-mb", 15); // 下载测速文件大小
const TCP_SAMPLES = 5; // 直连 TCP 建连采样次数

const ADMIN_KEY = fs
  .readFileSync(DEV_VARS, "utf8")
  .match(/^ADMIN_KEY=(.+)$/m)?.[1]
  ?.trim();
if (!ADMIN_KEY) throw new Error("缺少 ADMIN_KEY（.dev.vars）");

const XRAY_BIN = XRAY_CANDIDATES.find((p) => fs.existsSync(p));
if (!XRAY_BIN) throw new Error(`找不到 xray 客户端（试过 ${XRAY_CANDIDATES.join(", ")}）`);

// ---------- 中心 API：节点清单 + 测试凭证 ----------
const apiGet = async (p) => {
  const res = await fetch(`${API_BASE}${p}`, {
    headers: { "x-admin-key": ADMIN_KEY },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (!res.ok || !body?.ok) throw new Error(`${p} -> ${body?.error ?? res.status}`);
  return body.data;
};

const nodes = (await apiGet("/api/admin/nodes")).filter((n) => n.active);
if (!nodes.length) throw new Error("没有 active 节点");
const tokens = await apiGet("/api/admin/tokens");
const token = tokens.find((t) => t.status === "active" && (t.expires_at ?? 0) > Date.now());
if (!token) throw new Error("没有可用的 active token 作为测试凭证");
console.log(`节点 ${nodes.length} 个，测试凭证 ${token.id}`);

// ---------- curl 工具 ----------
// 经 socks 隧道请求，返回 { ok, timeMs }；--socks5-hostname 让 DNS 在出口侧解析
const curlTimed = async (url, socksPort, maxTimeSec) => {
  try {
    const { stdout } = await run("curl", [
      "-s", "-o", "/dev/null", "-w", "%{time_total}",
      "--max-time", String(maxTimeSec),
      ...(socksPort ? ["--socks5-hostname", `127.0.0.1:${socksPort}`] : []),
      url,
    ]);
    const t = Number(stdout);
    return Number.isFinite(t) && t > 0 ? { ok: true, timeMs: t * 1000 } : { ok: false };
  } catch {
    return { ok: false };
  }
};

// 直连节点入口测 TCP 建连时间（%{time_connect}，不含 TLS 与应用层）
const tcpConnectMs = async (host, port) => {
  const times = [];
  for (let i = 0; i < TCP_SAMPLES; i++) {
    try {
      const { stdout } = await run("curl", [
        "-s", "-o", "/dev/null", "-w", "%{time_connect}",
        "--max-time", "8", `https://${host}:${port}/ping`,
      ]);
      const t = Number(stdout);
      if (Number.isFinite(t) && t > 0) times.push(t * 1000);
    } catch { /* 单次失败忽略 */ }
  }
  if (!times.length) return null;
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
};

// 经隧道下载测速，返回 Mbps；失败返回 null
// 目标用自家客户端镜像站（R2，固定对象），Range 只取前 N MB；出口在被测节点，反映真实代理吞吐
const downloadMbps = async (socksPort) => {
  try {
    const { stdout } = await run("curl", [
      "-s", "-o", "/dev/null", "-w", "%{size_download} %{time_total}",
      "--max-time", "45",
      "-r", `0-${DOWNLOAD_MB * 1000 * 1000 - 1}`,
      "--socks5-hostname", `127.0.0.1:${socksPort}`,
      "https://dl.fastergamer.click/cmfa-android-arm64-v8a.apk",
    ]);
    const [bytes, secs] = stdout.split(" ").map(Number);
    if (!bytes || !secs) return null;
    return Math.round(((bytes * 8) / secs / 1e6) * 10) / 10;
  } catch {
    return null;
  }
};

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

// ---------- 逐节点测（串行，避免并行下载互相抢带宽） ----------
const results = [];
for (const [idx, n] of nodes.entries()) {
  const port = n.port || 443;
  const rec = { name: n.name, host: n.host, region: n.region };

  rec.tcp_connect_ms = await tcpConnectMs(n.host, port);

  const socksPort = 12808 + idx;
  const cfgPath = `/tmp/xray-quality-${socksPort}.json`;
  const cfg = {
    log: { loglevel: "none" },
    inbounds: [{ listen: "127.0.0.1", port: socksPort, protocol: "socks", settings: { udp: false } }],
    outbounds: [{
      protocol: "vless",
      settings: { vnext: [{ address: n.host, port, users: [{ id: token.uuid, encryption: "none" }] }] },
      streamSettings: {
        network: "ws",
        security: "tls",
        tlsSettings: { serverName: n.host },
        wsSettings: { path: n.ws_path || "/vless-ws" },
      },
    }],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const xray = execFile(XRAY_BIN, ["run", "-config", cfgPath], () => {});
  await new Promise((r) => setTimeout(r, 1500));

  try {
    // 预热 1 次（TLS 会话复用/路由收敛），不计入样本
    await curlTimed(`https://${n.host}/ping`, socksPort, 10);

    const times = [];
    let fails = 0;
    for (let i = 0; i < LATENCY_SAMPLES; i++) {
      const r = await curlTimed(`https://${n.host}/ping`, socksPort, 10);
      if (r.ok) times.push(r.timeMs);
      else fails++;
    }

    if (times.length) {
      const sorted = [...times].sort((a, b) => a - b);
      const diffs = times.slice(1).map((t, i) => Math.abs(t - times[i]));
      rec.rtt_ms = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      rec.p95_ms = Math.round(percentile(sorted, 95));
      rec.jitter_ms = diffs.length
        ? Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length)
        : 0;
    }
    rec.loss_pct = Math.round((fails / LATENCY_SAMPLES) * 1000) / 10;
    rec.download_mbps = times.length ? await downloadMbps(socksPort) : null;
  } finally {
    xray.kill();
    fs.rmSync(cfgPath, { force: true });
  }

  results.push(rec);
  console.log(
    `${rec.name} (${rec.host})  ` +
      `TCP ${rec.tcp_connect_ms ?? "-"}ms  RTT ${rec.rtt_ms ?? "-"}ms  ` +
      `P95 ${rec.p95_ms ?? "-"}ms  jitter ${rec.jitter_ms ?? "-"}ms  ` +
      `丢包 ${rec.loss_pct}%  下载 ${rec.download_mbps ?? "-"}Mbps`
  );
}

// ---------- 汇总、存档、阈值告警 ----------
const fmt = (v, unit) => (v == null ? "-".padStart(7) : String(v).padStart(7));
console.log("\n节点              TCP建连    RTT    P95  jitter   丢包%   下载Mbps");
for (const r of results) {
  console.log(
    `${r.name.padEnd(14)} ${fmt(r.tcp_connect_ms)} ${fmt(r.rtt_ms)} ${fmt(r.p95_ms)} ` +
      `${fmt(r.jitter_ms)} ${fmt(r.loss_pct)} ${fmt(r.download_mbps)}`
  );
}

const bad = results.filter(
  (r) => r.loss_pct > 5 || (r.p95_ms ?? 0) > 500 || (r.download_mbps != null && r.download_mbps < 10)
);
if (bad.length) {
  console.log(`\n⚠ 超阈值节点：${bad.map((r) => r.name).join("、")}（丢包>5% / P95>500ms / 下载<10Mbps）`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
fs.mkdirSync(PROBE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(PROBE_DIR, `quality-${stamp}.json`),
  JSON.stringify({ at: new Date().toISOString(), samples: LATENCY_SAMPLES, results }, null, 2)
);
const csvPath = path.join(PROBE_DIR, "quality-history.csv");
if (!fs.existsSync(csvPath)) {
  fs.writeFileSync(csvPath, "at,node,tcp_ms,rtt_ms,p95_ms,jitter_ms,loss_pct,download_mbps\n");
}
for (const r of results) {
  fs.appendFileSync(
    csvPath,
    [stamp, r.name, r.tcp_connect_ms ?? "", r.rtt_ms ?? "", r.p95_ms ?? "", r.jitter_ms ?? "", r.loss_pct, r.download_mbps ?? ""].join(",") + "\n"
  );
}
console.log(`\n明细已存 ${path.join(PROBE_DIR, `quality-${stamp}.json`)}，趋势追加到 quality-history.csv`);
