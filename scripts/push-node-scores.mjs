#!/usr/bin/env node
/**
 * 把最近一次全国拨测结果回写到节点注册表（Node.probe），订阅排序据此把
 * 当前最快的节点排到各分组最前（url-test 首成员有粘滞优势）。
 *
 * 用法：
 *   node scripts/push-node-scores.mjs [probe文件]   # 缺省取 scripts/.probe/ 最新全量 JSON
 *   node scripts/push-node-scores.mjs --dry-run     # 只打印不写
 *
 * 数据源格式（scripts/ali-node-eval.mjs 产出）：[{node, ip, province, isp, rtt, err}]
 * 注意：节点名做空格/下划线归一后匹配注册表（拨测参数里空格被换成下划线）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://fastergamer.click";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
let file = args.find((a) => !a.startsWith("--"));
if (!file) {
  const dir = path.join(ROOT, "scripts", ".probe");
  file = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().pop();
  file = path.join(dir, file);
}

const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const rows = Array.isArray(raw) ? raw : raw.results ?? raw.data ?? [];
if (!rows.length) { console.error(`拨测文件为空: ${file}`); process.exit(1); }

// ---------- 聚合：节点 → 全国中位/P95 + 分运营商中位 ----------
const norm = (s) => s.replace(/[\s_]/g, "");
const byNode = new Map(); // normName → { all: number[], isp: Map<string, number[]> }
for (const r of rows) {
  if (r.err || typeof r.rtt !== "number" || r.rtt > 5000) continue; // 失败/超时(20s)样本不计
  const k = norm(r.node);
  if (!byNode.has(k)) byNode.set(k, { all: [], isp: new Map() });
  const e = byNode.get(k);
  e.all.push(r.rtt);
  if (r.isp) {
    if (!e.isp.has(r.isp)) e.isp.set(r.isp, []);
    e.isp.get(r.isp).push(r.rtt);
  }
}
const median = (a) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
const p95 = (a) => { const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(v.length * 0.95))]; };

// ---------- 匹配注册表并回写 ----------
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "workers/api/.dev.vars"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => l.split("=", 2).map((s) => s.trim()))
);
const res = await fetch(`${API}/api/admin/nodes`, { headers: { "x-admin-key": env.ADMIN_KEY } });
if (!res.ok) { console.error(`拉节点失败: ${res.status}`); process.exit(1); }
const nodes = (await res.json()).data;
const now = Date.now();

let updated = 0;
for (const n of nodes.filter((x) => x.active)) {
  const e = byNode.get(norm(n.name));
  if (!e) { console.log(`跳过 ${n.name}：拨测无有效样本（失联则靠 staleness 自然沉底）`); continue; }
  const probe = {
    median: Math.round(median(e.all)),
    p95: Math.round(p95(e.all)),
    per_isp: Object.fromEntries([...e.isp].map(([k, v]) => [k, Math.round(median(v))])),
    at: now,
  };
  console.log(`${n.name}: 中位 ${probe.median}ms  P95 ${probe.p95}ms  ${JSON.stringify(probe.per_isp)}`);
  if (DRY) continue;
  const r = await fetch(`${API}/api/admin/nodes/${n.id}`, {
    method: "PUT",
    headers: { "x-admin-key": env.ADMIN_KEY, "content-type": "application/json" },
    body: JSON.stringify({ probe }),
  });
  if (!r.ok) { console.error(`  回写失败: ${r.status} ${await r.text()}`); continue; }
  updated++;
}
console.log(DRY ? "--dry-run，未写入" : `已回写 ${updated} 个节点`);
