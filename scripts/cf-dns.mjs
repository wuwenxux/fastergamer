#!/usr/bin/env node
// Cloudflare DNS 记录管理（fastergamer.click 节点域名），替代 alidns.mjs 的角色。
// 用法：
//   CLOUDFLARE_API_TOKEN=xxx node scripts/cf-dns.mjs list [关键字]        # 列出 A 记录
//   CLOUDFLARE_API_TOKEN=xxx node scripts/cf-dns.mjs add <子域> <IP> [备注]  # 如 add sg01 1.2.3.4 新加坡
//   CLOUDFLARE_API_TOKEN=xxx node scripts/cf-dns.mjs set <子域> <IP> [备注]  # 更新已有记录
// 约定：节点域名一律 DNS-only（灰云，客户端直连），地理命名 hk01/jp01/…，与 KV 注册表 host 一致
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE_ID = "d7cebab6160f1fb76c179c4b53e0a0af"; // fastergamer.click
const DOMAIN = "fastergamer.click";

if (!TOKEN) {
  console.error("缺少 CLOUDFLARE_API_TOKEN（需 区域→DNS→编辑 权限）");
  process.exit(1);
}

async function api(path, init) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const json = await res.json();
  if (!json.success) {
    console.error("[cf-dns] 失败:", JSON.stringify(json.errors));
    process.exit(1);
  }
  return json.result;
}

const listRecords = () =>
  api(`/zones/${ZONE_ID}/dns_records?type=A&per_page=100`);

const [cmd, rr, ip, ...rest] = process.argv.slice(2);
const comment = rest.join(" ") || undefined;

if (cmd === "list") {
  const kw = rr ?? "";
  for (const r of await listRecords()) {
    if (!kw || r.name.includes(kw))
      console.log(`${r.name} -> ${r.content}${r.comment ? `  # ${r.comment}` : ""}`);
  }
} else if (cmd === "add") {
  if (!rr || !ip) {
    console.error("用法: node scripts/cf-dns.mjs add <子域> <IP> [备注]");
    process.exit(1);
  }
  const r = await api(`/zones/${ZONE_ID}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "A",
      name: `${rr}.${DOMAIN}`,
      content: ip,
      proxied: false, // 节点必须灰云直连；橙云会经 CF 中转拖慢且违反免费版用途限制
      comment,
    }),
  });
  console.log(`[cf-dns] 已添加 ${r.name} -> ${r.content}`);
} else if (cmd === "set") {
  if (!rr || !ip) {
    console.error("用法: node scripts/cf-dns.mjs set <子域> <IP> [备注]");
    process.exit(1);
  }
  const rec = (await listRecords()).find((r) => r.name === `${rr}.${DOMAIN}`);
  if (!rec) {
    console.error(`[cf-dns] 未找到 ${rr}.${DOMAIN}，请先用 add 创建`);
    process.exit(1);
  }
  const r = await api(`/zones/${ZONE_ID}/dns_records/${rec.id}`, {
    method: "PATCH",
    body: JSON.stringify({ content: ip, ...(comment ? { comment } : {}) }),
  });
  console.log(`[cf-dns] 已更新 ${r.name}: ${rec.content} -> ${r.content}`);
} else {
  console.error("用法: node scripts/cf-dns.mjs list [关键字] | add <子域> <IP> [备注] | set <子域> <IP> [备注]");
  process.exit(1);
}
