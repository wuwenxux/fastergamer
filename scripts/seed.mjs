#!/usr/bin/env node
/**
 * 初始化套餐数据（调用 API Worker 的 /api/admin/seed）
 *
 * 用法：
 *   node scripts/seed.mjs [API_BASE] [ADMIN_KEY]
 * 默认 API_BASE=http://localhost:8787，ADMIN_KEY=change-me-in-production
 *
 * 注意：此文件与线上 PLANS KV 保持一致（2026-08-29 同步）。
 * 个人付费套餐统一 3 台设备；免费体验 1 台；企业套餐单独档位。
 */
const [base = "http://localhost:8787", adminKey = "change-me-in-production"] =
  process.argv.slice(2);

const plans = [
  {
    "id": "plan_3days",
    "name": "30 天免费体验",
    "duration_days": 30,
    "price_cny": 0,
    "traffic_limit_gb": 20,
    "max_devices": 1,
    "tag": "新用户体验",
    "description": "30 天免费体验，20 GB 总流量，1 台设备（首页免费领取，不出售）",
    "features": [
      "20 GB 流量",
      "1 台设备",
      "全部节点可用"
    ],
    "pitch": "先试用，好用再买"
  },
  {
    "id": "plan_monthly",
    "name": "月付套餐",
    "duration_days": 30,
    "price_cny": 12,
    "traffic_limit_gb": 20,
    "max_devices": 3,
    "tag": "个人轻量",
    "description": "30 天有效，20 GB 总流量，3 台设备",
    "features": [
      "20 GB / 30 天",
      "3 台设备",
      "多地域自动切换"
    ],
    "pitch": "一个人的日常加速"
  },
  {
    "id": "plan_quarterly",
    "name": "季付套餐",
    "duration_days": 90,
    "price_cny": 30,
    "traffic_limit_gb": 60,
    "max_devices": 3,
    "tag": "个人常用",
    "description": "90 天有效，60 GB 总流量，3 台设备",
    "features": [
      "60 GB / 90 天",
      "3 台设备",
      "多地域自动切换"
    ],
    "pitch": "手机电脑同时在线"
  },
  {
    "id": "plan_yearly",
    "name": "年付套餐",
    "duration_days": 365,
    "price_cny": 120,
    "traffic_limit_gb": 240,
    "max_devices": 5,
    "monthly_quota_gb": 20,
    "tag": "家庭多设备",
    "description": "一年有效，每月 20GB（用超预支下月，有效期提前），5 台设备",
    "features": [
      "每月 20 GB",
      "5 台设备",
      "多地域自动切换"
    ],
    "pitch": "全家用一年，最划算"
  },
  {
    "id": "plan_yearly_renew",
    "name": "年付续费",
    "duration_days": 365,
    "price_cny": 100,
    "traffic_limit_gb": 240,
    "max_devices": 5,
    "monthly_quota_gb": 20,
    "tag": "老用户优惠",
    "description": "连续包年，每月 20GB（用超预支下月，有效期提前），5 台设备",
    "features": [
      "每月 20 GB",
      "5 台设备",
      "年付到期续费专用"
    ],
    "pitch": "老用户续一年，省 20 元"
  },
  {
    "id": "plan_biz_yearly",
    "name": "企业年付",
    "duration_days": 365,
    "price_cny": 588,
    "traffic_limit_gb": 0,
    "max_devices": 20,
    "tag": "企业团队",
    "description": "不限量流量（公平使用），20 台设备，共享节点池",
    "features": [
      "流量不限量",
      "20 台设备",
      "500 Mbps 共享节点",
      "故障自动切换"
    ],
    "pitch": "10~20 人团队，流量不限量"
  },
  {
    "id": "plan_biz_dedicated",
    "name": "企业专用节点",
    "duration_days": 365,
    "price_cny": 988,
    "traffic_limit_gb": 0,
    "max_devices": 30,
    "tag": "确定性首选",
    "description": "不限量流量（公平使用），30 台设备，独享一台专用节点",
    "features": [
      "流量不限量",
      "30 台设备",
      "500 Mbps 独享节点",
      "故障自动回落共享池"
    ],
    "pitch": "独享节点，晚高峰也稳"
  }
];

const res = await fetch(`${base}/api/admin/seed`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-key": adminKey },
  body: JSON.stringify({ plans }),
});
const body2 = await res.json();
if (!res.ok) {
  console.error("seed 失败：", body2?.error ?? res.status);
  process.exit(1);
}
console.log(`✓ 已写入 ${body2.data.count} 个套餐`);
