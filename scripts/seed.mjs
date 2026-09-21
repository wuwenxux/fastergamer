#!/usr/bin/env node
/**
 * 初始化套餐数据（调用 API Worker 的 /api/admin/seed）
 *
 * 用法：
 *   node scripts/seed.mjs [API_BASE] [ADMIN_KEY]
 * 默认 API_BASE=http://localhost:8787，ADMIN_KEY=change-me-in-production
 *
 * 注意：此文件与线上 PLANS KV 保持一致（2026-09-13 同步）。
 * 个人付费最低档为 ¥12 月付（月付/季付已于 2026-09-13 重新上线）；免费体验 1 台设备；
 * 企业套餐单独档位（20 台共享池 ¥998/年起，30 台独享 VPS 大带宽 ¥1988/年）。
 */
const [base = "http://localhost:8787", adminKey = "change-me-in-production"] =
  process.argv.slice(2);

const plans = [
  {
    "id": "plan_trial",
    "name": "7 天免费体验",
    "duration_days": 7,
    "price_cny": 0,
    "traffic_limit_gb": 8,
    "max_devices": 1,
    "tag": "新用户体验",
    "description": "7 天免费体验，8 GB 总流量，1 台设备（首页免费领取，不出售）",
    "features": [
      "8 GB 流量",
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
    "monthly_quota_gb": 20,
    "tag": "个人常用",
    "description": "90 天有效，每月 20GB（用超预支下月，有效期提前），3 台设备",
    "features": [
      "每月 20 GB",
      "3 台设备",
      "多地域自动切换"
    ],
    "pitch": "手机电脑同时在线"
  },
  {
    "id": "plan_yearly",
    "name": "连续包年",
    "duration_days": 395,
    "bonus_days": 30,
    "price_cny": 110,
    "traffic_limit_gb": 260,
    "max_devices": 3,
    "monthly_quota_gb": 20,
    "tag": "家庭多设备",
    "description": "首购 13 个月（买一年送一月，每邮箱限一次），续费 12 个月；每月 20GB（用超预支下月，有效期提前），3 台设备",
    "features": [
      "每月 20 GB",
      "3 台设备",
      "多地域自动切换"
    ],
    "pitch": "首购买 12 个月送 1 个月"
  },
  {
    "id": "plan_2years",
    "name": "两年付套餐",
    "duration_days": 790,
    "bonus_days": 60,
    "price_cny": 220,
    "traffic_limit_gb": 520,
    "max_devices": 3,
    "monthly_quota_gb": 20,
    "tag": "长期超值",
    "description": "首购 26 个月（买两年送 2 个月，每邮箱限一次），续费 24 个月；每月 20GB（用超预支下月，有效期提前），3 台设备",
    "features": [
      "每月 20 GB",
      "3 台设备",
      "多地域自动切换"
    ],
    "pitch": "首购买 24 个月送 2 个月，最划算"
  },
  {
    "id": "plan_yearly_plus",
    "name": "年付大流量",
    "duration_days": 365,
    "price_cny": 199,
    "traffic_limit_gb": 480,
    "monthly_quota_gb": 40,
    "max_devices": 5,
    "tag": "大流量多设备",
    "description": "一年有效，每月 40GB（用超预支下月，有效期提前），5 台设备",
    "features": [
      "每月 40 GB",
      "5 台设备",
      "多地域自动切换"
    ],
    "pitch": "大流量随便用，5 台设备"
  },
  {
    "id": "plan_biz_yearly",
    "name": "企业年付",
    "duration_days": 365,
    "price_cny": 998,
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
    "price_cny": 1988,
    "traffic_limit_gb": 0,
    "max_devices": 30,
    "tag": "顶尖旗舰",
    "description": "不限量流量（公平使用），30 台设备，独享 VPS 大带宽专用节点",
    "features": [
      "流量不限量",
      "30 台设备",
      "大带宽独享 VPS（≥500 Mbps）",
      "故障自动回落共享池"
    ],
    "pitch": "独享 VPS 大带宽，性能到顶"
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
