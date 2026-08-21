#!/usr/bin/env node
/**
 * 初始化套餐数据（调用 API Worker 的 /api/admin/seed）
 *
 * 用法：
 *   node scripts/seed.mjs [API_BASE] [ADMIN_KEY]
 * 默认 API_BASE=http://localhost:8787，ADMIN_KEY=change-me-in-production
 */
const [base = "http://localhost:8787", adminKey = "change-me-in-production"] =
  process.argv.slice(2);

const plans = [
  {
    id: "plan_3days",
    name: "3 天体验",
    duration_days: 3,
    price_cny: 3,
    traffic_limit_gb: 3,
    description: "3 天体验，3 GB 总流量",
  },
  {
    id: "plan_monthly",
    name: "月付套餐",
    duration_days: 30,
    price_cny: 12,
    traffic_limit_gb: 20,
    description: "30 天有效，20 GB 总流量",
  },
  {
    id: "plan_quarterly",
    name: "季付套餐",
    duration_days: 90,
    price_cny: 30,
    traffic_limit_gb: 60,
    description: "90 天有效，60 GB 总流量",
  },
  {
    id: "plan_yearly",
    name: "年付套餐",
    duration_days: 365,
    price_cny: 120,
    traffic_limit_gb: 240,
    description: "一年有效，240 GB 总流量",
  },
  {
    id: "plan_yearly_renew",
    name: "年付续费",
    duration_days: 365,
    price_cny: 100,
    traffic_limit_gb: 240,
    description: "连续包年，240 GB 总流量",
  },
];

const res = await fetch(`${base}/api/admin/seed`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-key": adminKey },
  body: JSON.stringify({ plans }),
});
const body = await res.json();
if (!res.ok) {
  console.error("seed 失败：", body?.error ?? res.status);
  process.exit(1);
}
console.log(`✓ 已写入 ${body.data.count} 个套餐`);
