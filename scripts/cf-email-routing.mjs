#!/usr/bin/env node
/**
 * Cloudflare Email Routing 工单收件配置（主域 support@fastergamer.click）。
 *
 * 用途：工单外发邮件优先走 CF Email Service（发件人即 support@fastergamer.click），
 * 用户直接回复邮件时由 CF Email Routing 路由到 Worker vpn-api 的 email handler
 * （workers/api/src/email.ts），追加进工单对话 thread。
 *
 * 现状（2026-09）：主域 MX 已指向 Cloudflare（route*.mx.cloudflare.net，zone 级
 * Email Routing 由控制台开启；阿里企业邮箱在 fastergamer.cn 上，互不冲突）。收件
 * 规则 support@fastergamer.click → worker:vpn-api 已建好。历史子域 tickets.
 * fastergamer.click 的 MX/SPF 与旧规则已下线，DNS 残留记录无害保留（不删）。
 *
 * 红线：本脚本只读状态 + 幂等建「support@主域 → worker」这一条规则；绝不修改/删除
 * 任何 DNS 记录（Email Routing 的 zone 级 DNS 由 CF 托管，手工改动会断收件）。
 *
 * 用法：
 *   node scripts/cf-email-routing.mjs status   # 查看 Email Routing 状态/规则/主域 MX（只读）
 *   node scripts/cf-email-routing.mjs setup    # 幂等建 support@主域 → worker 路由规则
 *
 * token：从 workers/api/.dev.vars 读 CLOUDFLARE_API_TOKEN，需「区域→Email Routing→编辑」
 * 权限（现有 token 若只有 DNS 编辑权限，setup 会 403——到 CF 控制台给 token 加
 * Email Routing 权限后再跑）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ZONE_ID = "d7cebab6160f1fb76c179c4b53e0a0af"; // fastergamer.click（同 cf-dns.mjs）
const INBOUND = "support@fastergamer.click"; // 工单回信地址（主域）
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
  return json; // 错误处理留给调用方
}

/** 主域 MX 检查：打印当前 MX，期望是 CF Email Routing（route*.mx.cloudflare.net），异常大字报警 */
async function checkMx() {
  const j = await api(`/zones/${ZONE_ID}/dns_records?type=MX&per_page=100`);
  if (!j.success) {
    console.error("[cf-email] 读取 MX 失败:", JSON.stringify(j.errors));
    return;
  }
  const mx = j.result.filter((r) => r.name === "fastergamer.click");
  console.log("主域 MX 记录（本脚本绝不修改）:");
  if (!mx.length) {
    console.log("\n⚠️⚠️⚠️ 警告：主域没有 MX 记录！Email Routing 收件会断，请到 CF 控制台重新启用 ⚠️⚠️⚠️\n");
    return;
  }
  for (const r of mx) console.log(`  ${r.name} -> ${r.content} (优先级 ${r.priority})`);
  if (!mx.every((r) => /mx\.cloudflare\.net$/i.test(r.content))) {
    console.log("\n⚠️⚠️⚠️ 警告：主域 MX 不全是 Cloudflare Email Routing！有人动过主域 MX，请立即人工核对 ⚠️⚠️⚠️\n");
  }
}

async function status() {
  const r = await api(`/zones/${ZONE_ID}/email/routing`);
  let ok = true;
  if (!r.success) {
    // settings 读接口要的权限比 rules 高，现有 token 可能读不了；规则能列就说明链路正常，降级为提示
    console.log(`Email Routing 状态: 读取失败（${JSON.stringify(r.errors)}），跳过（不影响规则检查）`);
  } else {
    console.log(`Email Routing 状态: ${r.result.status}（enabled 即正常）`);
  }
  {
    const rules = await api(`/zones/${ZONE_ID}/email/routing/rules?per_page=100`);
    if (rules.success) {
      console.log(`自定义规则（${rules.result.length} 条）:`);
      for (const rule of rules.result) {
        const to = rule.matchers?.map((m) => `${m.type}:${m.value}`).join(", ");
        const act = rule.actions?.map((a) => `${a.type}→${(a.value ?? []).join(",")}`).join(", ");
        console.log(`  [${rule.enabled ? "启用" : "停用"}] ${rule.name ?? "(无名)"}  ${to}  =>  ${act}`);
      }
      if (!rules.result.some((rule) => rule.enabled && rule.matchers?.some((m) => m.value === INBOUND))) {
        console.log(`\n⚠️ 缺少 ${INBOUND} → worker:${WORKER} 的启用规则，跑 setup 补建\n`);
        ok = false;
      }
    } else {
      console.error("[cf-email] 读取规则失败:", JSON.stringify(rules.errors));
      ok = false;
    }
  }
  // MX 检查不受 Email Routing 权限影响（走 DNS 权限），照样执行
  await checkMx();
  if (!ok) process.exit(1);
}

async function setup() {
  // zone 级 Email Routing 已在控制台启用（主域 MX 由 CF 托管），这里只幂等建收件规则
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
      console.error("若 403：token 缺 Email Routing 权限，请到 CF 控制台给 token 加「区域→Email Routing→编辑」后再跑");
      process.exit(1);
    }
    console.log(`[cf-email] 已创建规则：${INBOUND} → worker:${WORKER}`);
  }

  await status();
  console.log(`
后续人工步骤（脚本做不了）：
1. 部署 Worker（email handler 需在线上）：bash scripts/deploy-cf.sh；
2. 给自己发一封测试工单，收到回执后直接回复，确认工单出现 thread 追加。`);
}

const [cmd] = process.argv.slice(2);
if (cmd === "status") await status();
else if (cmd === "setup") await setup();
else {
  console.error("用法: node scripts/cf-email-routing.mjs status | setup");
  process.exit(1);
}
