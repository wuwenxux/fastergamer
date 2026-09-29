#!/usr/bin/env node
/**
 * Cloudflare Email Routing 工单收件配置（子域名 tickets.fastergamer.click）。
 *
 * 用途：工单外发邮件的回信地址（阿里云 DM 控制台配置）是 support@tickets.fastergamer.click，
 * 用户直接回复邮件时由 CF Email Routing 路由到 Worker vpn-api 的 email handler
 * （workers/api/src/email.ts），追加进工单对话 thread。
 *
 * 红线：不碰主域 DNS 的邮件相关记录（阿里企业邮箱在 fastergamer.cn 上；.click 主域
 * 实测无 MX，但同样不动）。本脚本只操作子域名 tickets 的 Email Routing DNS 与自定义
 * 规则；status 每次都会打印主域 MX 并在异常时大字报警。
 *
 * 用法：
 *   node scripts/cf-email-routing.mjs status   # 查看 Email Routing 状态/规则/主域 MX（只读）
 *   node scripts/cf-email-routing.mjs setup    # 幂等开子域收件 + 建 worker 路由规则
 *
 * token：从 workers/api/.dev.vars 读 CLOUDFLARE_API_TOKEN，需「区域→Email Routing→编辑」
 * 权限（现有 token 若只有 DNS 编辑权限，setup 会 403——到 CF 控制台给 token 加
 * Email Routing 权限后再跑）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ZONE_ID = "d7cebab6160f1fb76c179c4b53e0a0af"; // fastergamer.click（同 cf-dns.mjs）
const SUBDOMAIN = "tickets.fastergamer.click"; // 收件子域：只碰它，不碰主域
const INBOUND = `support@${SUBDOMAIN}`; // 工单回信地址
const WORKER = "vpn-api"; // email handler 所在 Worker（wrangler.cf.toml 的 name）

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, "workers/api/.dev.vars"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => l.split("=", 2).map((s) => s.trim()))
);
const TOKEN = env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error("workers/api/.dev.vars 缺少 CLOUDFLARE_API_TOKEN");
  process.exit(1);
}

async function api(path, init) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
  const json = await res.json();
  return json; // 错误处理留给调用方（setup 要把 409「已配置」当成功）
}

/** 主域 MX 红线检查：打印当前 MX，不是阿里企业邮箱就大字报警（绝不修改） */
async function checkMx() {
  const j = await api(`/zones/${ZONE_ID}/dns_records?type=MX&per_page=100`);
  if (!j.success) {
    console.error("[cf-email] 读取 MX 失败:", JSON.stringify(j.errors));
    return;
  }
  const mx = j.result.filter((r) => r.name === "fastergamer.click");
  console.log("主域 MX 记录（本脚本绝不修改）:");
  if (!mx.length) {
    // 现状（2026-09）：.click 主域无 MX——阿里企业邮箱配在 .cn 上；这里只提示不报警
    console.log("  （无）主域当前没有 MX 记录，不涉邮箱业务，子域收件不影响任何现有邮件链路");
    return;
  }
  for (const r of mx) console.log(`  ${r.name} -> ${r.content} (优先级 ${r.priority})`);
  if (!mx.some((r) => /aliyun/i.test(r.content))) {
    console.log("\n⚠️⚠️⚠️ 警告：主域 MX 不是阿里企业邮箱！有人动过主域 MX，请立即人工核对 ⚠️⚠️⚠️\n");
  }
}

async function status() {
  const r = await api(`/zones/${ZONE_ID}/email/routing`);
  let ok = r.success;
  if (!r.success) {
    console.error("[cf-email] 读取 Email Routing 状态失败:", JSON.stringify(r.errors));
    console.error("若 403/10000：token 缺 Email Routing 权限，请到 CF 控制台 → My Profile → API Tokens 给该 token 加「区域→Email Routing→编辑」");
  } else {
    console.log(`Email Routing 状态: ${r.result.status}（enabled 即正常；子域收件不依赖主域启用状态）`);
    const rules = await api(`/zones/${ZONE_ID}/email/routing/rules?per_page=100`);
    if (rules.success) {
      console.log(`自定义规则（${rules.result.length} 条）:`);
      for (const rule of rules.result) {
        const to = rule.matchers?.map((m) => `${m.type}:${m.value}`).join(", ");
        const act = rule.actions?.map((a) => `${a.type}→${(a.value ?? []).join(",")}`).join(", ");
        console.log(`  [${rule.enabled ? "启用" : "停用"}] ${rule.name ?? "(无名)"}  ${to}  =>  ${act}`);
      }
    } else {
      console.error("[cf-email] 读取规则失败:", JSON.stringify(rules.errors));
      ok = false;
    }
  }
  // MX 红线检查不受 Email Routing 权限影响（走 DNS 权限），照样执行
  await checkMx();
  if (!ok) process.exit(1);
}

async function setup() {
  // 1) 开子域名 Email Routing DNS（只给 tickets 子域配 MX/SPF；绝不发不带 name 的请求——那会动主域 MX）
  const dns = await api(`/zones/${ZONE_ID}/email/routing/dns`, {
    method: "POST",
    body: JSON.stringify({ name: SUBDOMAIN }),
  });
  if (dns.success) {
    console.log(`[cf-email] 已为 ${SUBDOMAIN} 配置 Email Routing DNS（MX/SPF）`);
  } else {
    const msg = JSON.stringify(dns.errors);
    // 已配置过会报 already/exists 类错误，幂等视为成功
    if (/already|exist|duplicate/i.test(msg)) console.log(`[cf-email] ${SUBDOMAIN} 的 Email Routing DNS 已存在，跳过`);
    else {
      console.error("[cf-email] 子域 DNS 配置失败:", msg);
      console.error("若 403：token 缺 Email Routing 权限，请到 CF 控制台给 token 加「区域→Email Routing→编辑」后再跑");
      process.exit(1);
    }
  }

  // 2) 建路由规则：support@tickets... → worker vpn-api（先查重，存在即跳过）
  const rules = await api(`/zones/${ZONE_ID}/email/routing/rules?per_page=100`);
  const exists = rules.success && rules.result.some(
    (r) => r.matchers?.some((m) => m.field === "to" && m.type === "literal" && m.value === INBOUND)
  );
  if (exists) {
    console.log(`[cf-email] 规则 ${INBOUND} → worker:${WORKER} 已存在，跳过`);
  } else {
    const created = await api(`/zones/${ZONE_ID}/email/routing/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "工单邮件闭环（回复追加进工单 thread）",
        enabled: true,
        matchers: [{ field: "to", type: "literal", value: INBOUND }],
        actions: [{ type: "worker", value: [WORKER] }],
      }),
    });
    if (!created.success) {
      console.error("[cf-email] 创建规则失败:", JSON.stringify(created.errors));
      process.exit(1);
    }
    console.log(`[cf-email] 已创建规则：${INBOUND} → worker:${WORKER}`);
  }

  await status();
  console.log(`
后续人工步骤（脚本做不了）：
1. 阿里云 DM 控制台 → service@mail.fastergamer.cn 的回信地址改为 ${INBOUND}
   （发信代码 ReplyToAddress=true，回信地址在控制台配置，API 改不了）；
2. 部署 Worker（email handler 需在线上）：bash scripts/deploy-cf.sh；
3. 给自己发一封测试工单，收到回执后直接回复，确认工单出现 thread 追加。`);
}

const [cmd] = process.argv.slice(2);
if (cmd === "status") await status();
else if (cmd === "setup") await setup();
else {
  console.error("用法: node scripts/cf-email-routing.mjs status | setup");
  process.exit(1);
}
