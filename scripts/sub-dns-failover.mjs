#!/usr/bin/env node
// sub.fastergamer.click 解析容灾切换：阿里云委派 ⇄ Cloudflare 直连
//
// 背景：sub 子域平时委派给阿里云解析（国内 ~60ms）；若阿里云处置该 zone（停析/回收），
// 由于委派记录在 CF zone 内部，CF 自己无法再应答 sub —— 必须删掉 NS 委派、改回 A 记录直连。
// 本脚本一键完成两个方向的切换（幂等）。
//
// 用法：
//   CLOUDFLARE_API_TOKEN=xxx node scripts/sub-dns-failover.mjs cf      # 应急：切回 CF 直连（慢但不断）
//   CLOUDFLARE_API_TOKEN=xxx node scripts/sub-dns-failover.mjs aliyun  # 恢复：重新委派阿里云
//
// 注意：只切 DNS 指向；阿里云侧 zone 数据（5 条 A 记录）不被动，CF 侧切回时写入同样的 5 条。

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ZONE_ID = "d7cebab6160f1fb76c179c4b53e0a0af"; // fastergamer.click
const SUB = "sub.fastergamer.click";
const NODE_IPS = [
  ["64.90.26.88", "hk02"],
  ["154.64.250.200", "hk01"],
  ["154.64.250.144", "hk03"],
  ["64.83.33.244", "jp01"],
  ["64.83.43.171", "jp02"],
];
const ALIYUN_NS = ["ns1.alidns.com", "ns2.alidns.com"];

if (!TOKEN) {
  console.error("缺少 CLOUDFLARE_API_TOKEN");
  process.exit(1);
}

async function api(path, init) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = await res.json();
  if (!json.success) {
    console.error("[failover] 失败:", JSON.stringify(json.errors));
    process.exit(1);
  }
  return json.result;
}

const records = async (type) =>
  api(`/zones/${ZONE_ID}/dns_records?type=${type}&name=${SUB}&per_page=100`);

const del = async (id) => api(`/zones/${ZONE_ID}/dns_records/${id}`, { method: "DELETE" });

const mode = process.argv[2];
if (mode === "cf") {
  for (const r of await records("NS")) {
    await del(r.id);
    console.log(`删除 NS -> ${r.content}`);
  }
  const existing = (await records("A")).map((r) => r.content);
  for (const [ip, name] of NODE_IPS) {
    if (existing.includes(ip)) { console.log(`A ${ip} 已存在，跳过`); continue; }
    await api(`/zones/${ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "A", name: "sub", content: ip, proxied: false, ttl: 300, comment: `订阅入口 ${name}（应急 CF 直连）` }),
    });
    console.log(`添加 A -> ${ip} (${name})`);
  }
  console.log("✓ 已切回 CF 直连（国内解析变慢但恢复可用）；验证: dig +short A sub.fastergamer.click @223.5.5.5");
} else if (mode === "aliyun") {
  for (const r of await records("A")) {
    await del(r.id);
    console.log(`删除 A -> ${r.content}`);
  }
  const existing = (await records("NS")).map((r) => r.content);
  for (const ns of ALIYUN_NS) {
    if (existing.includes(ns)) { console.log(`NS ${ns} 已存在，跳过`); continue; }
    await api(`/zones/${ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "NS", name: "sub", content: ns, ttl: 300 }),
    });
    console.log(`添加 NS -> ${ns}`);
  }
  console.log("✓ 已恢复阿里云委派（需确认阿里云侧 zone 仍在且 5 条 A 记录完好）");
} else {
  console.error("用法: node scripts/sub-dns-failover.mjs cf | aliyun");
  process.exit(1);
}
