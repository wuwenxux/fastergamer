#!/usr/bin/env node
// Cloudflare WAF 自定义规则管理（fastergamer.click），与 cf-dns.mjs 同风格。
// 用法：
//   CLOUDFLARE_API_TOKEN=xxx node scripts/cf-waf.mjs status   # 查看当前自定义规则
//   CLOUDFLARE_API_TOKEN=xxx node scripts/cf-waf.mjs apply    # 幂等下发下方 RULES（整体替换该 phase）
// token 需「Zone → WAF → Edit」。规则语义见每条 description；改动先改 RULES 再 apply。
// 注意：apply 是 http_request_firewall_custom phase 的整体替换，dashboard 手工加的规则会被覆盖。
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE_ID = "d7cebab6160f1fb76c179c4b53e0a0af"; // fastergamer.click

// 匿名写接口的边缘防护：应用层已有 rateLimit + Turnstile，这里是更靠前的一层。
// /api/agent/*（节点回写，境外 IP 且 UA 为 python）与 /api/admin/*（x-admin-key + IP 白名单）
// 必须排除，否则会误伤节点与管理链路。
const RULES = [
  {
    description: "匿名 API POST 仅限中国大陆来源（节点 agent 与管理端除外），其余人机挑战",
    expression:
      '(http.request.method eq "POST" and http.request.uri.path contains "/api/" and not http.request.uri.path contains "/api/agent/" and not starts_with(http.request.uri.path, "/api/admin/") and ip.geoip.country ne "CN")',
    action: "managed_challenge",
    enabled: true,
  },
  {
    description: "空 UA 的 API POST 直接拒绝（脚本/CC 特征；agent 与管理端除外）",
    expression:
      '(http.request.method eq "POST" and http.request.uri.path contains "/api/" and not http.request.uri.path contains "/api/agent/" and not starts_with(http.request.uri.path, "/api/admin/") and http.user_agent eq "")',
    action: "block",
    enabled: true,
  },
];

if (!TOKEN) {
  console.error("缺少 CLOUDFLARE_API_TOKEN（需 Zone→WAF→Edit）");
  process.exit(1);
}

async function api(path, init) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
  return res.json();
}

const cmd = process.argv[2];
const entrypoint = `/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint`;

if (cmd === "status") {
  const d = await api(entrypoint);
  if (!d.success) {
    console.log("当前无自定义规则（或权限不足）:", JSON.stringify(d.errors));
    process.exit(0);
  }
  for (const r of d.result.rules ?? [])
    console.log(`- [${r.enabled ? "启用" : "停用"}] ${r.action}: ${r.description}`);
} else if (cmd === "apply") {
  const d = await api(entrypoint, { method: "PUT", body: JSON.stringify({ rules: RULES }) });
  if (!d.success) {
    console.error("[cf-waf] 下发失败:", JSON.stringify(d.errors));
    process.exit(1);
  }
  console.log(`[cf-waf] 已下发 ${RULES.length} 条规则（ruleset ${d.result.id}）`);
} else {
  console.error("用法: node scripts/cf-waf.mjs status | apply");
  process.exit(1);
}
