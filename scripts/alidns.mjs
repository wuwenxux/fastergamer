#!/usr/bin/env node
/**
 * 阿里云 DNS（alidns）记录管理，复用 workers/api/.dev.vars 里的 RAM 密钥。
 * 用法：
 *   node scripts/alidns.mjs list [rr关键字]           # 列出 A 记录
 *   node scripts/alidns.mjs add <RR> <IP> [备注]      # 新增 A 记录，如 add nx6 1.2.3.4 新加坡
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
} else {
  console.error("用法: node scripts/alidns.mjs list [rr关键字] | add <RR> <IP> [备注]");
  process.exit(1);
}
