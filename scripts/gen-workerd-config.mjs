#!/usr/bin/env node
/**
 * 生成 workerd 生产配置 config.capnp
 *
 * 从 workers/api/wrangler.toml 的 [vars] 与 workers/api/.dev.vars（敏感值）读取环境变量，
 * 输出 workerd 原生配置：KV 用磁盘目录（每 key 一个文件），变量用 text 绑定。
 *
 * 用法: node scripts/gen-workerd-config.mjs <out_dir>
 *   <out_dir> 里应已有 index.js（wrangler deploy --dry-run 的产物）和 kv/ 数据目录
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(root, "workers/api");
const outDir = resolve(process.argv[2] ?? join(root, "prod"));
const port = Number(process.env.PORT ?? 8787);

if (!existsSync(join(outDir, "index.js"))) {
  console.error(`缺少 ${outDir}/index.js，先运行: cd workers/api && npx wrangler deploy --dry-run --outdir <out_dir>`);
  process.exit(2);
}

/** 解析 wrangler.toml 的顶层 [vars] 段 */
function parseTomlVars(text) {
  const m = text.match(/^\[vars\]\s*\n([\s\S]*?)(?=^\[|\s*$(?![\s\S]))/m);
  if (!m) return {};
  const vars = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    vars[key] = raw[0] === "'" ? raw.slice(1, -1) : JSON.parse(raw);
  }
  return vars;
}

/** 解析 .dev.vars（KEY=value，允许空值与 # 注释） */
function parseDevVars(text) {
  const vars = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    vars[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return vars;
}

/** capnp 文本字符串转义：非可打印 ASCII 全部 \xNN（UTF-8 字节） */
function capnpStr(s) {
  const bytes = Buffer.from(s, "utf8");
  let out = "";
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += "\\x" + b.toString(16).padStart(2, "0");
  }
  return `"${out}"`;
}

const vars = parseTomlVars(readFileSync(join(apiDir, "wrangler.toml"), "utf8"));
const devVarsPath = join(apiDir, ".dev.vars");
const devVars = existsSync(devVarsPath) ? parseDevVars(readFileSync(devVarsPath, "utf8")) : {};
const all = { ...vars, ...devVars }; // .dev.vars 覆盖 toml（与 wrangler 行为一致）

const KV = ["TOKENS", "PLANS", "ORDERS", "NODES", "TICKETS"];

const kvServices = KV.map(
  (ns) => `    ( name = "kv-${ns}", disk = ( path = ${capnpStr(join(outDir, "kv", ns))}, writable = true ) ),`
).join("\n");

const bindings = [
  ...KV.map((ns) => `          ( name = "${ns}", kvNamespace = "kv-${ns}" ),`),
  ...Object.entries(all).map(([k, v]) => `          ( name = "${k}", text = ${capnpStr(v)} ),`),
].join("\n");

const config = `using Workerd = import "/workerd/workerd.capnp";

# Fastergamer API —— workerd 生产配置（由 scripts/gen-workerd-config.mjs 生成，勿手改）
const config :Workerd.Config = (
  services = [
    (
      name = "api",
      worker = (
        modules = [
          ( name = "worker", esModule = embed "index.js" )
        ],
        compatibilityDate = "2025-01-01",
        compatibilityFlags = [ "nodejs_compat" ],
        bindings = [
${bindings}
        ]
      )
    ),
${kvServices}
  ],
  sockets = [
    ( name = "http", address = "0.0.0.0:${port}", http = (), service = "api" )
  ]
);
`;

writeFileSync(join(outDir, "config.capnp"), config);
console.log(`✓ 已生成 ${join(outDir, "config.capnp")}（${KV.length} 个 KV 绑定，${Object.keys(all).length} 个变量）`);
