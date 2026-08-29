#!/usr/bin/env node
/**
 * 阿里云 DNS（alidns）记录管理，复用 workers/api/.dev.vars 里的 RAM 密钥。
 * 用法：
 *   node scripts/alidns.mjs list [rr关键字]           # 列出 A 记录
 *   node scripts/alidns.mjs add <RR> <IP> [备注]      # 新增 A 记录，如 add nx6 1.2.3.4 新加坡
 *   node scripts/alidns.mjs sync                      # 以节点 KV 为准校准备注，报告缺失记录
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOMAIN = "fastergamer.cn";

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
    Version: "2015-01-09",
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
    "https://alidns.aliyuncs.com/?" +
    Object.entries(params)
      .map(([k, v]) => `${enc(k)}=${enc(v)}`)
      .join("&");
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.Code) {
    console.error(`[alidns] ${action} 失败:`, json?.Message ?? (await res.text()));
    process.exit(1);
  }
  return json;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") {
  const json = await call("DescribeDomainRecords", {
    DomainName: DOMAIN,
    RRKeyWord: args[0] ?? "nx",
    PageSize: "100",
  });
  for (const r of json.DomainRecords?.Record ?? []) {
    console.log(`${r.RR}\t${r.Type}\t${r.Value}\t${r.Remark ?? ""}`);
  }
} else if (cmd === "add") {
  const [rr, ip, remark = ""] = args;
  if (!rr || !ip) {
    console.error("用法: node scripts/alidns.mjs add <RR> <IP> [备注]");
    process.exit(1);
  }
  const json = await call("AddDomainRecord", {
    DomainName: DOMAIN,
    RR: rr,
    Type: "A",
    Value: ip,
    Remark: remark,
  });
  console.log(`[alidns] 已添加 ${rr}.${DOMAIN} -> ${ip} (RecordId ${json.RecordId})`);
} else if (cmd === "set") {
  const [rr, ip, remark] = args;
  if (!rr || !ip) {
    console.error("用法: node scripts/alidns.mjs set <RR> <IP> [备注]");
    process.exit(1);
  }
  const found = await call("DescribeDomainRecords", {
    DomainName: DOMAIN,
    SubDomain: rr === "@" ? DOMAIN : `${rr}.${DOMAIN}`,
    PageSize: "100",
  });
  const rec = found.DomainRecords?.Record?.find((r) => r.RR === rr && r.Type === "A");
  if (!rec) {
    console.error(`[alidns] 未找到 ${rr}.${DOMAIN} 的 A 记录，请先用 add 创建`);
    process.exit(1);
  }
  await call("UpdateDomainRecord", {
    RecordId: rec.RecordId,
    RR: rr,
    Type: "A",
    Value: ip,
  });
  if (remark !== undefined) {
    await call("UpdateDomainRecordRemark", { RecordId: rec.RecordId, Remark: remark });
  }
  console.log(`[alidns] 已更新 ${rr}.${DOMAIN}: ${rec.Value} -> ${ip}`);
} else if (cmd === "del") {
  const [rr] = args;
  if (!rr) {
    console.error("用法: node scripts/alidns.mjs del <RR>");
    process.exit(1);
  }
  const found = await call("DescribeDomainRecords", {
    DomainName: DOMAIN,
    SubDomain: rr === "@" ? DOMAIN : `${rr}.${DOMAIN}`,
    PageSize: "100",
  });
  const recs = (found.DomainRecords?.Record ?? []).filter((r) => r.RR === rr && r.Type === "A");
  if (!recs.length) console.log(`[alidns] ${rr}.${DOMAIN} 无 A 记录，跳过`);
  for (const r of recs) {
    await call("DeleteDomainRecord", { RecordId: r.RecordId });
    console.log(`[alidns] 已删除 ${rr}.${DOMAIN} -> ${r.Value}`);
  }
} else if (cmd === "sync") {
  const NODES_KV = "/home/wafer/fastergamer/kv/NODES/nodes";
  const nodes = JSON.parse(fs.readFileSync(NODES_KV, "utf8"));
  const json = await call("DescribeDomainRecords", {
    DomainName: DOMAIN,
    RRKeyWord: "nx",
    PageSize: "100",
  });
  const records = json.DomainRecords?.Record ?? [];
  for (const n of nodes) {
    const rr = n.host.split(".")[0];
    const rec = records.find((r) => r.RR === rr && r.Type === "A");
    if (!rec) {
      // KV 只存域名不存 IP，缺失的记录无法自动补，需要手动 add
      console.log(`✗ ${rr}（${n.name}）在阿里云缺失，请手动 add（KV 未存 IP）`);
      continue;
    }
    if ((rec.Remark ?? "") === n.name) {
      console.log(`✓ ${rr} ${rec.Value} 备注一致（${n.name}）`);
      continue;
    }
    await call("UpdateDomainRecordRemark", {
      RecordId: rec.RecordId,
      Remark: n.name,
    });
    console.log(`✓ ${rr} ${rec.Value} 备注已更新 -> ${n.name}`);
  }
} else {
  console.error("用法: node scripts/alidns.mjs list [rr关键字] | add <RR> <IP> [备注] | set <RR> <IP> [备注] | del <RR> | sync");
  process.exit(1);
}
