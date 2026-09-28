#!/usr/bin/env node
/**
 * 初始化套餐数据（调用 API Worker 的 /api/admin/seed，空 body 触发内置默认列表）
 *
 * 用法：
 *   node scripts/seed.mjs [API_BASE] [ADMIN_KEY]
 * 默认 API_BASE=http://localhost:8787，ADMIN_KEY=change-me-in-production
 *
 * 套餐的唯一数据源是 workers/api/src/routes/admin/plans.ts 的 DEFAULT_PLANS，
 * 线上 PLANS KV 以它为准；本脚本不再内嵌套餐列表，只负责触发写入。
 * 注意：DEFAULT_PLANS 改动须先 deploy 再 seed，否则写入的是旧版 worker 的内置列表。
 *
 * 档位结构：免费体验 1 台设备；个人付费最低档为 ¥3 流量包（plan_pack_* 系列为纯总量包，
 * 售出不退）；¥10 连续包月（plan_monthly_sub）与 ¥12 月付同规格，¥110 连续包年（plan_yearly）
 * 与 ¥120 年付同规格，续费连续性资格/奖励由 API 侧判定（lib/continuity.ts，37 天 / 395 天窗口）；
 * 企业套餐单独档位（20 台共享池 ¥998/年起，30 台独享 VPS 大带宽 ¥1988/年）。
 */
const [base = "http://localhost:8787", adminKey = "change-me-in-production"] =
  process.argv.slice(2);

const res = await fetch(`${base}/api/admin/seed`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-key": adminKey },
  body: "{}",
});
const body2 = await res.json();
if (!res.ok) {
  console.error("seed 失败：", body2?.error ?? res.status);
  process.exit(1);
}
console.log(`✓ 已写入 ${body2.data.count} 个套餐`);
