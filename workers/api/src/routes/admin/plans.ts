import { Hono } from "hono";
import { TRIAL_PLAN_ID } from "../../../../../shared/types";
import type { Plan } from "../../../../../shared/types";
import { getPlans, savePlans } from "../../lib/kv";
import type { Env } from "../../types";

export const adminPlansRoutes = new Hono<{ Bindings: Env }>();

/** 默认套餐（可通过请求体覆盖，见 /api/admin/seed） */
const DEFAULT_PLANS: Plan[] = [
  {
    id: TRIAL_PLAN_ID,
    pitch: "先试用，好用再买",
    name: "7 天免费体验",
    duration_days: 7,
    price_cny: 0,
    traffic_limit_gb: 8,
    max_devices: 1,
    tag: "新用户体验",
    description: "7 天免费体验，8 GB 总流量，1 台设备（首页免费领取，不出售）",
    features: [
        "8 GB 流量",
        "1 台设备",
        "全部节点可用",
      ],
  },
  {
    id: "plan_pack_1g",
    pitch: "3 元救急，即买即用",
    name: "1G 流量包",
    duration_days: 90,
    price_cny: 3,
    traffic_limit_gb: 1,
    max_devices: 1,
    tag: "轻量流量包",
    description: "90 天有效，1 GB 总流量，1 台设备，用完即止；虚拟商品售出不退",
    features: [
        "1 GB / 90 天",
        "1 台设备",
        "全部节点可用",
      ],
  },
  {
    id: "plan_pack_5g",
    pitch: "8 元用三个月，轻量备用",
    name: "5G 流量包",
    duration_days: 90,
    price_cny: 8,
    traffic_limit_gb: 5,
    max_devices: 1,
    tag: "轻量流量包",
    description: "90 天有效，5 GB 总流量，1 台设备，用完即止；虚拟商品售出不退",
    features: [
        "5 GB / 90 天",
        "1 台设备",
        "全部节点可用",
      ],
  },
  {
    id: "plan_monthly_sub",
    pitch: "每月续费不断，每月省 2 元",
    name: "连续包月",
    duration_days: 30,
    price_cny: 10,
    traffic_limit_gb: 20,
    max_devices: 3,
    tag: "连续包月优惠",
    description: "30 天有效，20 GB 总流量，3 台设备；连续续费专享价，断缴超 7 天失去资格，需回 ¥12 月付",
    features: [
        "20 GB / 30 天",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_monthly",
    pitch: "一个人的日常加速",
    name: "月付套餐",
    duration_days: 30,
    price_cny: 12,
    traffic_limit_gb: 20,
    max_devices: 3,
    tag: "个人轻量",
    description: "30 天有效，20 GB 总流量，3 台设备",
    features: [
        "20 GB / 30 天",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_quarterly",
    pitch: "手机电脑同时在线",
    name: "季付套餐",
    duration_days: 90,
    price_cny: 30,
    traffic_limit_gb: 60,
    monthly_quota_gb: 20,
    max_devices: 3,
    tag: "个人常用",
    description: "90 天有效，每月 20GB（当月用完暂停，次月自动恢复；可提前重置，有效期 -30 天），3 台设备",
    features: [
        "每月 20 GB",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_yearly",
    pitch: "首购买 12 个月送 1 个月",
    name: "连续包年",
    duration_days: 395,
    bonus_days: 30,
    price_cny: 110,
    traffic_limit_gb: 260,
    monthly_quota_gb: 20,
    max_devices: 3,
    tag: "家庭多设备",
    description: "首购 13 个月（买一年送一月，每邮箱限一次），续费 12 个月；每月 20GB（当月用完暂停，次月自动恢复；可提前重置，有效期 -30 天），3 台设备；连续续费专享价，断缴超 30 天失去资格，需回 ¥120 年付",
    features: [
        "每月 20 GB",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_yearly_std",
    pitch: "不想被连续绑住，随时可买",
    name: "年付套餐",
    duration_days: 365,
    price_cny: 120,
    traffic_limit_gb: 260,
    monthly_quota_gb: 20,
    max_devices: 3,
    tag: "灵活年付",
    description: "一年有效，每月 20GB（当月用完暂停，次月自动恢复；可提前重置，有效期 -30 天），3 台设备；随时可买无门槛，连续续费从第二年起每年送 1 个月",
    features: [
        "每月 20 GB",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_2years",
    pitch: "首购买 24 个月送 2 个月，最划算",
    name: "两年付套餐",
    duration_days: 790,
    bonus_days: 60,
    price_cny: 220,
    traffic_limit_gb: 520,
    monthly_quota_gb: 20,
    max_devices: 3,
    tag: "长期超值",
    description: "首购 26 个月（买两年送 2 个月，每邮箱限一次），续费 24 个月；每月 20GB（当月用完暂停，次月自动恢复；可提前重置，有效期 -30 天），3 台设备",
    features: [
        "每月 20 GB",
        "3 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_yearly_plus",
    pitch: "大流量随便用，5 台设备",
    name: "年付大流量",
    duration_days: 365,
    price_cny: 199,
    traffic_limit_gb: 480,
    monthly_quota_gb: 40,
    max_devices: 5,
    tag: "大流量多设备",
    description: "一年有效，每月 40GB（当月用完暂停，次月自动恢复；可提前重置，有效期 -30 天），5 台设备",
    features: [
        "每月 40 GB",
        "5 台设备",
        "多地域自动切换",
      ],
  },
  {
    id: "plan_biz_yearly",
    pitch: "10~20 人团队，流量不限量",
    name: "企业年付",
    duration_days: 365,
    price_cny: 998,
    traffic_limit_gb: 0,
    max_devices: 20,
    tag: "企业团队",
    description: "不限量流量（公平使用），20 台设备，共享节点池",
    features: [
        "流量不限量",
        "20 台设备",
        "500 Mbps 共享节点",
        "故障自动切换",
      ],
  },
  {
    id: "plan_biz_dedicated",
    pitch: "独享 VPS 大带宽，性能到顶",
    name: "企业专用节点",
    duration_days: 365,
    price_cny: 1988,
    traffic_limit_gb: 0,
    max_devices: 30,
    tag: "顶尖旗舰",
    description: "不限量流量（公平使用），30 台设备，独享 VPS 大带宽专用节点",
    features: [
        "流量不限量",
        "30 台设备",
        "大带宽独享 VPS（≥500 Mbps）",
        "故障自动回落共享池",
      ],
  },
];

/**
 * GET /api/admin/plans —— 查看当前套餐列表
 */
adminPlansRoutes.get("/plans", async (c) => {
  const plans = await getPlans(c.env);
  return c.json({ ok: true, data: plans });
});

/**
 * POST /api/admin/seed —— 初始化套餐数据
 * 请求体可选：{ "plans": [...] }，省略则写入默认套餐
 */
adminPlansRoutes.post("/seed", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { plans?: Plan[] } | null;
  const plans = body?.plans?.length ? body.plans : DEFAULT_PLANS;
  await savePlans(c.env, plans);
  return c.json({ ok: true, data: { count: plans.length, plans } });
});
