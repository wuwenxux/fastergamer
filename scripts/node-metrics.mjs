#!/usr/bin/env node
/**
 * 各节点监控指标一览——直接问节点本机的 /api/metrics，不经过中心 API。
 * 指标由节点 agent 每 30s 更新（无论中心是否可达），需用节点密钥鉴权。
 * 用法：
 *   node scripts/node-metrics.mjs           # 节点级汇总
 *   node scripts/node-metrics.mjs --users   # 展开每用户（uuid）流量/在线明细
 */
import fs from "node:fs";

// 节点清单从 CF 中心 API 实时取（本地磁盘 KV 已是冻结存档）
const DEV_VARS = "/home/wafer/cloudflare/workers/api/.dev.vars";
const ADMIN_KEY = fs
  .readFileSync(DEV_VARS, "utf8")
  .match(/^ADMIN_KEY=(.+)$/m)?.[1]
  .trim();
const res = await fetch("https://fastergamer.click/api/admin/nodes?with_key=1", {
  headers: { "x-admin-key": ADMIN_KEY },
  signal: AbortSignal.timeout(15000),
});
const nodes = ((await res.json()).data ?? []).filter((n) => n.active);
const showUsers = process.argv.includes("--users");
const gb = (b) => (b / 1024 ** 3).toFixed(2);

for (const n of nodes) {
  try {
    const res = await fetch(`https://${n.host}/api/metrics`, {
      headers: { "x-node-key": n.key },
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      console.log(`${n.name} (${n.host})  ✗ HTTP ${res.status}`);
      continue;
    }
    const d = json.data;
    const age = d.last_sync_at ? Math.max(0, Math.floor(Date.now() / 1000 - d.last_sync_at)) : "-";
    console.log(
      `${n.name} (${n.host})  总流量 ${gb(d.node_total_bytes)} GB  在线 ${d.online_count}  ` +
        `白名单 ${d.whitelist_size}  中心同步 ${d.last_sync_ok ? "正常" : "失败"} (${age}s 前)`
    );
    if (showUsers) {
      for (const [uuid, u] of Object.entries(d.users ?? {})) {
        console.log(`    ${uuid}  ${gb(u.downlink_bytes)} GB  ${u.online ? "在线" : "离线"}`);
      }
    }
  } catch (e) {
    console.log(`${n.name} (${n.host})  ✗ ${e.message}`);
  }
}
