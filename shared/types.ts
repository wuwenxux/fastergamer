/**
 * 共享类型定义 —— 供 API Worker 与前端共同使用
 */

/** 试用套餐 id。原名 plan_3days（3 天试用时代的遗留），现名 plan_trial */
export const TRIAL_PLAN_ID = "plan_trial";

/**
 * 判定试用套餐：新旧 id 都算。
 * 存量 token/订单的 plan_id 仍是历史 plan_3days，随 90 天清理周期自然消亡后才能去掉旧分支。
 */
export const isTrialPlan = (planId: string): boolean =>
  planId === TRIAL_PLAN_ID || planId === "plan_3days";

/** 流量包套餐 id 前缀：plan_pack_*（如 plan_pack_5g、plan_pack_1g） */
export const DATA_PACK_PLAN_PREFIX = "plan_pack_";

/** 首个流量包套餐 id（5 GB / 90 天，¥8 的轻量总量包） */
export const DATA_PACK_PLAN_ID = "plan_pack_5g";

/**
 * 连续包月套餐 id（与 ¥12 月付同规格，¥10 连续续费专享价）。
 * 资格规则：按订单 contact 判定——首购（无记录）放行；有记录要求上次连续包月订单
 * 支付成功时间在 37 天内（30 天周期 + 7 天断缴宽限），否则拒绝并引导回 ¥12 月付。
 * 记录键 KV.SUBMON（lib/continuity.ts）。
 */
export const MONTHLY_SUB_PLAN_ID = "plan_monthly_sub";

/** 连续包年套餐 id（¥110，连续性资格规则同连续包月，窗口 365 天 + 30 天宽限；lib/continuity.ts） */
export const YEARLY_PLAN_ID = "plan_yearly";

/** 正常年付套餐 id（¥120，随时可买无门槛；连续续费从第二年起每年送 1 个月；lib/continuity.ts） */
export const YEARLY_STD_PLAN_ID = "plan_yearly_std";

/**
 * 判定流量包套餐：纯总量包（无月度配额），单价太低，不参与推广返利结算
 * （¥8 购买不该给邀请人记 ¥5 额度）且售出不退（退款折算入口直接拒绝）。
 * 按 plan_pack_ 前缀判定，该系列新档（如 plan_pack_1g）自动适用同一规则。
 */
export const isDataPackPlan = (planId: string): boolean =>
  planId.startsWith(DATA_PACK_PLAN_PREFIX);

/** 套餐定义（购买项） */
export interface Plan {
  id: string;
  name: string;
  /** 购买后持续时长（天） */
  duration_days: number;
  /** 售价（人民币元） */
  price_cny: number;
  /** 套餐描述，展示在卡片上 */
  description: string;
  /** 场景标签，如“个人日常”“企业团队”，展示为卡片角标 */
  tag?: string;
  /** 一句话卖点（海报卡片大字展示），缺省用 description */
  pitch?: string;
  /** 卖点列表（场景优势/确定性说明），展示为卡片 bullet；缺省时前端用默认文案 */
  features?: string[];
  /** 可选：流量上限 GB；0 或缺省表示不限量（公平使用） */
  traffic_limit_gb?: number;
  /** 可绑定的设备数上限（含主设备），缺省按 2 处理 */
  max_devices?: number;
  /** 每月流量限额（GB）。当月用超自动预支下月额度，有效期永久提前一个月 */
  monthly_quota_gb?: number;
  /** 促销赠送天数（如买 12 送 1 的 30 天）：包含在 duration_days 内，但退款折算时不计入（赠送月不可退） */
  bonus_days?: number;
}

/** 设备槽位 —— token 下每台设备一个独立 UUID，用于 per-device 流量审计 */
export interface Device {
  /** 短 ID，如 dv_a1b2c3 */
  id: string;
  /** 该设备专用的 VLESS UUID */
  uuid: string;
  /** 用户命名，如“我的 iPhone” */
  name: string;
  /** 该设备累计流量（GB，计入 token 总量） */
  traffic_used_gb: number;
  created_at: number;
  last_active_at?: number;
  /** 该槽位凭证的设备防护白名单（lib/device-guard.ts：机主确认「允许」的接入 IP，
   *  不再参与并发阻断判定；上限 10，超出淘汰最旧） */
  allowed_ips?: string[];
  /** 迁移过渡名单（ip → 过渡截止时间 unix ms）：device-guard「允许」为新设备建独立槽位后，
   *  被拦 IP 在 7 天过渡期内视同白名单（新设备还没导入专属链接，仍共用旧凭证）；
   *  到期仍活跃则移出名单、按新 IP 重新走 pending→确认→阻断 */
  transition_ips?: Record<string, number>;
}

/** 设备级防护自动阻断台账条目（lib/device-guard.ts）；手动封禁（blocked-ips 端点）不进台账 */
export interface DeviceGuardEntry {
  /** 涉事凭证 uuid（主 uuid 或设备槽位 uuid）：「允许」时决定白名单落到 token 还是对应槽位 */
  uuid: string;
  /** 阻断时间（unix 毫秒） */
  at: number;
  /** pending = 待机主决策 / denied = 机主确认拒绝（保持阻断、不再提醒） */
  status: "pending" | "denied";
  /** 阻断时的 IP 归属地展示串（邮件与管理页展示用；查询失败时缺省） */
  geo?: string;
}

/** Token 状态机 */
export type TokenStatus = "paid" | "active" | "expired" | "revoked";

/** 单个接入 IP 的统计（流量按连接数比例估算，非精确计量） */
export interface IpStat {
  /** 估算流量（bytes） */
  bytes: number;
  /** 连接次数 */
  conns: number;
  /** 最近一次接入时间（unix 毫秒） */
  last_seen_at: number;
}

/** Token —— 即用户的 VLESS UUID + 有效时间 + 流量 */
export interface Token {
  /** 短 ID，用于网页查询/激活，例如 tk_a1b2c3 */
  id: string;
  /** VLESS UUID，即 Clash 配置里的 uuid，也是节点 Xray 校验的凭证 */
  uuid: string;
  plan_id: string;
  status: TokenStatus;
  /** 购买时留下的联系方式（邮箱/Telegram/微信等），方便售后 */
  contact?: string;
  /** 总流量上限（GB）；0 表示不限量（公平使用，不参与耗尽/宽限期判断） */
  traffic_limit_gb: number;
  /** 已用流量（GB） */
  traffic_used_gb: number;
  /** 各节点上报的累计流量（bytes），用于多节点求和与 Xray 重启清零检测 */
  traffic_by_node?: Record<string, number>;
  /** 各节点累计真实消耗（bytes，按 delta 累加，重启/rmu 不清零）；traffic_used_gb 由此求和 */
  traffic_total_by_node?: Record<string, number>;
  /** 各节点基线的计费口径（"sum"=双向，"downlink"=只计下行）；口径切换时重置该节点基线 */
  billing_by_node?: Record<string, string>;
  /** 流量记账基准偏移（bytes）：惩罚性重置后从该值起算，总量 = sum(traffic_by_node) - offset */
  traffic_offset_bytes?: number;
  /** 当月已用流量（bytes，自然月重置）；仅套餐设了 monthly_quota_gb 时参与限额。
   *  达月额度即硬顶断网（授权快照摘除），自然月翻转自动恢复；用户也可手动「提前重置」 */
  month_used_bytes?: number;
  /** 当前月度账期标识，如 "2026-08" */
  month_key?: string;
  /** 历史遗留 + 手动提前重置的累计月数：旧「静默预支」语义已废（结算不再累加），
   *  现在只有用户手动 reset-month（每次有效期 -30 天）会 +1；存量值原样保留 */
  months_borrowed?: number;
  /** 原始到期时间（激活时设定）；旧预支语义的计算基准，新语义下不再被结算重算，仅存量数据保留 */
  base_expires_at?: number;
  /** 流量耗尽时间 */
  traffic_exhausted_at?: number;
  /** 当前是否在线（由 Agent 根据 Xray online 统计更新）。已迁移至 presence:{uuid}，此处仅为存量数据兼容保留 */
  online?: boolean;
  /** 在线状态最后一次更新时间（unix 毫秒）。已迁移至 presence:{uuid}，仅为存量兼容保留 */
  online_updated_at?: number;
  /** 各节点最近一次报告该 token 在线的时间（node.id → unix 毫秒），用于多节点同时在线检测。已迁移至 presence:{uuid}，仅为存量兼容保留 */
  online_by_node?: Record<string, number>;
  /** 最近一次检测到多节点同时在线（疑似多设备/分享使用）的时间（unix 毫秒） */
  multi_device_detected_at?: number;
  /** 接入 IP 统计（IP → 估算流量/连接数/最近接入），由节点 access log 解析得出，仅供用户自查。已迁移至 presence:{uuid}，仅为存量兼容保留 */
  traffic_by_ip?: Record<string, IpStat>;
  /** 上一上报周期的活跃接入 IP（key：node.id 或 node.id:设备uuid），用于接入地址变更检测。已迁移至 presence:{uuid}，仅为存量兼容保留 */
  active_ips?: Record<string, string[]>;
  /** 用户自助封禁的接入 IP 列表；agent 同步到各节点防火墙，被封 IP 无法连接任何节点 */
  blocked_ips?: string[];
  /** 主 uuid 的设备防护白名单（lib/device-guard.ts：机主确认「允许」的接入 IP，
   *  不再参与并发阻断判定；上限 10，超出淘汰最旧） */
  allowed_ips?: string[];
  /** 迁移过渡名单（ip → 过渡截止时间 unix ms），语义同 Device.transition_ips */
  transition_ips?: Record<string, number>;
  /** 设备级防护自动阻断台账（lib/device-guard.ts）：key = 被阻断 IP。
   *  自动阻断与手动封禁共用 blocked_ips 链路（全局生效，同 NAT 出口有误伤面），
   *  台账存在的意义就是区分二者并提供一键救济 */
  device_guard?: Record<string, DeviceGuardEntry>;
  /** 已发送过的风险提醒（类型 → 发送时间戳），防止重复打扰 */
  notify_log?: Record<string, number>;
  /** 节点变更通知订阅制（lib/node-change-notify.ts）：true = 用户点了「订阅此类通知」，持续收；
   *  缺省/false = 未订阅，最多只收第一封样例 */
  notify_nodes_subscribed?: boolean;
  /** 第一封节点变更样例邮件发出时间（写过即不再发样例，除非用户订阅） */
  notify_nodes_sampled_at?: number;
  /** 机房滥用标记：体验 token 被判定为机器（机房/代理 IP 流量为主）后置 true，转每日定额限速，不撤销 */
  abuse_machine?: boolean;
  /** 机器限速的 24h 滚动窗口起点（unix 毫秒） */
  abuse_window_start?: number;
  /** 当前限速窗口内已用流量（bytes），超 ABUSE_DAILY_BYTES 即暂停到窗口终点 */
  abuse_window_bytes?: number;
  /** 暂停截止时间（unix 毫秒，= 窗口起点 + 24h）；0/缺省表示未暂停。授权快照生成时排除暂停未到期的 token */
  abuse_suspended_until?: number;
  /** 共享检测暂停时间（unix 毫秒）：并发连接数持续超标（疑似订阅链接被多人共享）后置位，
   *  授权快照生成侧剔除（无自动到期，只能续费或管理端清除后恢复）。0/缺省 = 正常 */
  share_suspended_at?: number;
  /** 最近一次共享警告邮件时间（unix 毫秒）：7 天冷却期内再犯直接暂停，超过则重新警告 */
  share_warned_at?: number;
  /** 连续超标记录：最近一次超标时间 + 连续次数。超过 30 分钟未再超标则重新计数 */
  share_conn_strikes?: { at: number; count: number };
  /** 上次自助解除订阅绑定的时间（unix 毫秒）：解绑冷却 7 天判定用（lib/sub-lock.ts） */
  sub_unbind_at?: number;
  /** 并发观测记录（个人多设备套餐阶梯制：>3 且 ≤5 并发只记录不处置）：
   *  最近一次观测时间 + 当时并发数。写节流 1h（省 KV 写），不参与警告/暂停状态机 */
  conn_observe?: { at: number; conns: number };
  /** 不可能旅行事件累积：最近一次命中时间 + 连续次数。超过 30 分钟未再犯重新计数
   *  （仿 share_conn_strikes）；只累积 + 节流提醒，不接自动处置（lib/travel-guard.ts） */
  travel_strikes?: { at: number; count: number };
  /** 流量速率窗口起点（unix 毫秒），用于暴增检测 */
  rate_window_start?: number;
  /** 当前速率窗口内新增流量（bytes） */
  rate_window_bytes?: number;
  /** 绑定的设备槽位（不含主设备 uuid），每个设备独立 uuid 做流量审计 */
  devices?: Device[];
  /** 设备数上限（含主设备）：设置后覆盖套餐的 max_devices，管理员售后调整用 */
  max_devices?: number;
  /** 最后一次产生流量的时间（unix 毫秒）。已迁移至 presence:{uuid}，仅为存量兼容保留 */
  last_active_at?: number;
  /** unix 毫秒时间戳 */
  purchased_at: number;
  activated_at?: number;
  expires_at?: number;
  /** 体验转正并入的剩余时长（毫秒）：下单时从同邮箱激活中的体验 token 折算，激活计时一次性加进 expires_at */
  bonus_ms?: number;
  /** 该 token 来自试用转正（发货时标记）；bonus_ms 混有年付续费奖励不能反推转正，遥测/分析用独立标记 */
  trial_converted?: boolean;
  /** 上次重新生成订阅链接的时间（unix 毫秒），仅作记录，不限次数 */
  rotated_at?: number;
}

/** 一次订阅拉取记录（客户端类型识别用） */
export interface SubFetch {
  /** 客户端 User-Agent 原文（截断存储，展示时解析成客户端名） */
  ua: string;
  /** 拉取来源 IP */
  ip?: string;
  /** 拉取时间（unix 毫秒） */
  at: number;
}

/**
 * Presence —— token 的高频动态状态，独立存 presence:{uuid}（TOKENS namespace）。
 * 写它的是结算路径（/api/agent/traffic）、notify-scan 的在线清扫与 sub 路由的订阅拉取记录；
 * 与 token:{uuid} 主键解耦，避免结算与用户操作（加设备/封 IP/rotate）对同一 JSON 的
 * read-modify-write 互相覆盖丢更新。
 * 读规则：presence 键存在则以它为准；不存在时回退 token JSON 里的旧字段（存量兼容）。
 */
export interface Presence {
  /** 当前是否在线（由 Agent 根据 Xray online 统计更新） */
  online?: boolean;
  /** 在线状态最后一次更新时间（unix 毫秒） */
  online_updated_at?: number;
  /** 各节点最近一次报告该 token 在线的时间（node.id → unix 毫秒），用于多节点同时在线检测 */
  online_by_node?: Record<string, number>;
  /** 最后一次产生流量/上线的时间（unix 毫秒） */
  last_active_at?: number;
  /** 接入 IP 统计（IP → 估算流量/连接数/最近接入），由节点 access log 解析得出，仅供用户自查 */
  traffic_by_ip?: Record<string, IpStat>;
  /** 上一上报周期的活跃接入 IP（key：node.id 或 node.id:设备uuid），用于接入地址变更检测 */
  active_ips?: Record<string, string[]>;
  /** 各 key 最近一次确认的接入地理位置：{ g: 位置键（country / region / city 拼接，不含运营商），at: 确认时间（unix 毫秒） }，
   *  与 active_ips 同步更新；同城换 IP 只更新基线不提醒。at 是不可能旅行检测的时间基线（lib/travel-guard.ts）。
   *  存量数据为裸字符串（无 at，无法判定时间差）——读侧必须兼容，遇旧值只更新基线不判定 */
  active_geo?: Record<string, string | { g: string; at: number }>;
  /** 各订阅 uuid（主 uuid 或设备槽位 uuid）最近一次拉取订阅的客户端 UA / 来源 IP / 时间 */
  sub_fetches?: Record<string, SubFetch>;
  /** 订阅设备锁绑定表（lib/sub-lock.ts）：订阅 uuid → 客户端家族指纹 → 绑定信息。
   *  每链接容量 1 个指纹，首个拉取者懒惰认领；条目 30 天未拉取自动过期。与 sub_fetches 并存不动旧结构 */
  sub_fps?: Record<string, Record<string, SubFetch & { first_at: number }>>;
  /** 设备级防护首周期可疑新 IP 暂存（lib/device-guard.ts，key = 凭证 uuid）：
   *  下一周期并发仍 ≥2 且其中仍有在线者才执行阻断（吸收 WiFi↔5G 切换的瞬时双 IP） */
  dg_pending?: Record<string, { at: number; ips: string[] }>;
}

/** IP 归属解析结果（geo:{ip} 缓存值，TTL 30 天；管理端地理分布与安全提醒邮件共用） */
export interface IpGeo {
  /** 国家名（ip-api 免费版只返回英文，国家识别用 countryCode） */
  country: string;
  /** 国家代码，如 CN/US */
  countryCode: string;
  /** 省/州 */
  region: string;
  city: string;
  lat: number;
  lon: number;
  /** 运营商（安全提醒邮件展示用；早期缓存可能缺此字段） */
  isp?: string;
}

/** 管理端地理分布：单城市聚合（tokens/ips 均为去重计数） */
export interface GeoCityStat {
  /** 城市名（缺失时回退省份/国家名） */
  name: string;
  region: string;
  country: string;
  /** 国家代码（CN=境内，前端据此过滤中国地图散点） */
  countryCode: string;
  lat: number;
  lon: number;
  /** 在该城市有接入记录的去重 token 数 */
  tokens: number;
  /** 该城市去重 IP 数 */
  ips: number;
  bytes: number;
}

/** 管理端地理分布：单国家聚合 */
export interface GeoCountryStat {
  name: string;
  /** 国家代码（CN=境内，前端据此区分境内/海外） */
  countryCode: string;
  tokens: number;
  ips: number;
  bytes: number;
}

/** GET /api/admin/geo-stats 响应：按接入 IP 归属聚合的用户分布 */
export interface GeoStats {
  /** 按流量降序 */
  cities: GeoCityStat[];
  /** 按流量降序 */
  countries: GeoCountryStat[];
  /** 全部接入 IP 数（去重） */
  total_ips: number;
  /** 本次未能解析归属的 IP 数（超出单批补查上限或查询失败，下次刷新重试） */
  unresolved_ips: number;
}

/** 订单 —— 一次购买行为 */
export interface Order {
  id: string;
  plan_id: string;
  status: "pending" | "paid" | "failed";
  /** 买家联系方式 */
  contact?: string;
  /** 确认收款后发放的 token 短 ID */
  token_id?: string;
  /** 确认收款时间（unix 毫秒） */
  paid_at?: number;
  /** 易支付动态二维码/收银台链接（收款已停用，不再生成；仅历史订单可能带此字段） */
  epay_qr_code?: string;
  /** 支付平台交易号（历史订单回调时记录，用于对账/退款） */
  trade_no?: string;
  /** 推广减免金额（元）：邀请新用户注册获得，每个额度减 5 元 */
  discount_cny?: number;
  /** 实付金额（元）= 套餐价 - 减免；无减免时等于套餐价 */
  payable_cny?: number;
  /** 升级订单：支付成功后升级该既有 token（保留 uuid/设备），而非新发货 */
  upgrade_token_id?: string;
  /**
   * 用户上次点「我已支付」的时间（unix 毫秒）。
   * 人工收款码过渡方案的幂等节流字段：6 小时内重复点击不再给站长发通知邮件。
   */
  paid_notify_at?: number;
  /** 退款时间（unix 毫秒）；退款后对应 token 被撤销 */
  refunded_at?: number;
  /** 易支付退款单号 */
  refund_no?: string;
  created_at: number;
}

/** 创建订单请求体 */
export interface CreateOrderRequest {
  plan_id: string;
  /** 买家联系方式，用于售后和续费提醒 */
  contact?: string;
  /** 推广码（可选）：未领试用直接下单时也记录归因，首次付费成功后给邀请人结算 */
  ref?: string;
}

/** 创建订单响应（人工收款模式：订单为 pending，确认收款后才发放 token） */
export interface CreateOrderResponse {
  order: Order;
  /** 已确认收款并发放 token 时才有值 */
  token?: Token;
  /** 当前固定为 false，由管理员确认收款后置 true */
  paid: boolean;
}

/** 节点 —— 一台 VPS 加速落地 */
export interface Node {
  /** 节点唯一标识，如 node-hk-01 */
  id: string;
  /** Agent 预共享密钥，用于拉取配置 */
  key: string;
  /** 显示名，如 香港 CN2 */
  name: string;
  /** 地区代码，如 HK / JP / SG */
  region: string;
  /** 客户端连接目标（域名或 IP） */
  host: string;
  /** 端口，如 443 / 8443 */
  port: number;
  /** 是否启用 TLS（wss） */
  tls: boolean;
  /** WebSocket 路径，如 /vless-ws */
  ws_path: string;
  /** 是否上线 */
  active: boolean;
  /** Reality 直连入站（可选）：配置后订阅对支持的客户端（mihomo 系）额外下发
   *  Reality 条目（名称加 ⚡ 后缀）；WS 条目始终保留作兜底 */
  reality?: {
    /** 公网监听端口，如 8444 */
    port: number;
    /** x25519 公钥（Xray 26 客户端字段名 password，旧称 publicKey；mihomo 用 public-key） */
    password: string;
    short_id: string;
    /** 伪装目标 SNI，如 gateway.icloud.com（勿用 www.microsoft.com，证书链过大握手会失败） */
    server_name: string;
  };
  /** Hysteria2 UDP 入站（可选）：配置后订阅对 mihomo 系客户端额外下发 hy2 条目
   *  （名称加 🚀 后缀），密码固定为 "uuid:x"，sni 为节点域名（证书用节点域名的真实证书） */
  hy2?: {
    /** 公网监听端口（UDP），如 8445 */
    port: number;
  };
  /** 该节点对哪些运营商线路做了优化（可选，"移动"/"电信"/"联通"）。
   *  订阅生成时按用户 ASN 识别运营商，匹配节点静默排在前面；用户无感知、无可选项 */
  prefer_isp?: string[];
  /** 全国拨测回写的延迟画像（scripts/push-node-scores.mjs 每晚写入）。
   *  订阅排序用：同 prefer_isp 层级内按分数升序，失联/超 36h 未更新自动沉底或失效 */
  probe?: {
    /** 全国三网中位数（ms） */
    median: number;
    /** 全国 P95（ms），抖动观察用 */
    p95: number;
    /** 分运营商中位数：移动/电信/联通 → ms（无样本的运营商缺省） */
    per_isp?: Record<string, number>;
    /** 数据产生时间（unix 毫秒） */
    at: number;
  };
  /** 最后一次心跳时间（unix 毫秒） */
  last_seen_at?: number;
  /** 节点累计总流量（bytes，部署以来） */
  total_bytes?: number;
  /** 上一次 Agent 上报的节点原始总流量（用于检测 Xray 重启/清零） */
  last_node_total_bytes?: number;
  /** 节点基线的计费口径（"sum"=双向，"downlink"=只计下行）；口径切换时重置基线 */
  billing_mode?: string;
  /** 当月已用流量（bytes，按月自然月重置） */
  month_bytes?: number;
  /** 当前月度账期标识，如 "2026-08"；与当前月份不符时 month_bytes 归零重计 */
  month_key?: string;
  /** 月流量配额（GB，对应 VPS 带宽上限）；达到 100% 自动从订阅/同步摘除 */
  monthly_budget_gb?: number;
  /** 配额告警水位（0=未告警 80/100），账期重置时归零 */
  budget_alert_level?: number;
  /** 最近一次失联告警时间（节点恢复后清零） */
  offline_alerted_at?: number;
  /** 当前在线连接数（由 Agent 上报） */
  online_count?: number;
  /** 节点统计最近一次上报时间（unix 毫秒） */
  stats_updated_at?: number;
  /** 中心主动探测（probe-nodes.sh）最近一次判定结果；只在状态翻转时写入 */
  probe_online?: boolean;
  /** 最近一次探测判定时间（unix 毫秒） */
  probe_at?: number;
}

/** 工单对话条目：用户邮件补充（from:"user"，Email Routing 收件解析）与管理员回复（from:"admin"）按时间排列 */
export interface TicketThreadItem {
  from: "user" | "admin";
  text: string;
  at: number;
}

/** AI 工单助手产出：回复草稿 + 分类校正建议（仅供管理端参考采纳，绝不自动发给用户） */
export interface TicketAiDraft {
  /** 建议分类：install / connect / speed / other */
  category: string;
  /** 中文回复草稿（口语化，≤300 字） */
  draft: string;
  /** 生成时间戳 */
  at: number;
}

/** 用户反馈工单 —— 安装/使用问题反馈与邮件解答 */
export interface Ticket {
  /** 短 ID，如 fb_a1b2c3 */
  id: string;
  /** 用户邮箱（回复邮件发送到这里） */
  contact: string;
  /** 问题分类：install / connect / speed / other */
  category?: string;
  /** 问题描述 */
  message: string;
  /** 相关 token 短 ID（可选，便于管理员排查） */
  token_id?: string;
  status: "open" | "replied" | "closed";
  /** 管理员回复内容 */
  reply?: string;
  /** 往返对话记录（邮件闭环：用户直接回复工单邮件追加 from:"user" 条目；管理员回复同步追加 from:"admin"）。
   *  老工单无此字段；reply/replied_at 语义不变（thread 只是追加式会话流水） */
  thread?: TicketThreadItem[];
  /** 是否沉淀到公开 FAQ（需已回复） */
  publish_faq?: boolean;
  /** AI 回复草稿（Workers AI 异步写回；仅管理端展示，不自动发用户） */
  ai_draft?: TicketAiDraft;
  created_at: number;
  replied_at?: number;
}

/** 公开 FAQ 条目（由 publish_faq 的工单生成） */
export interface FaqItem {
  question: string;
  answer: string;
  category?: string;
}

/** magic link 票据（登录用）：purpose 区分来源邮件——import=新 token 凭证邮件
 * （落地展示一键导入卡片），login/缺省=登录链接/转化邮件（落地直接进管理页） */
export interface MagicTicket {
  email: string;
  token_id: string;
  created_at: number;
  purpose?: "import" | "login";
}

/**
 * 防失联登记 —— 登录用户主动留下的通知联系方式（存 TOKENS namespace）。
 * 用途：域名被封/入口迁移时批量通知；与购买邮箱解耦（可留备用邮箱/TG）。
 */
export interface Registration {
  /** 登录账号邮箱（即 KV 键 reg:{email} 的 email） */
  account_email: string;
  /** 通知邮箱（可与账号邮箱不同，缺省用账号邮箱） */
  notify_email?: string;
  /** Telegram 账号（可选，@xxx 或 t.me 链接） */
  telegram?: string;
  updated_at: number;
}

/**
 * 测试账号联系方式识别（管理端订单隐藏、地理分布排除用）：
 * 联调/E2E 留下的邮箱集中在 example.com/.invalid、temp.local、test-* 前缀和站内域名，
 * 真实用户邮箱不会命中。
 */
export const TEST_CONTACT_RE = /test|@example\.|@temp\.|\.invalid$|@fastergamer\.cn$|@auto/i;

/** KV 键前缀常量 */
export const KV = {
  TOKEN: "token:", // token:{uuid} → Token JSON
  PRESENCE: "presence:", // presence:{uuid} → Presence JSON（高频动态状态，存 TOKENS namespace）
  TOKEN_BY_ID: "tokenid:", // tokenid:{id} → { uuid }
  ORDER: "order:", // order:{id} → Order JSON
  ORDER_LOCK: "orderlock:", // orderlock:{orderId} → { at }（订单发货锁，免费层 best-effort 幂等，存 TOKENS namespace）
  TICKET: "ticket:", // ticket:{id} → Ticket JSON（存 TICKETS namespace）
  DEVICE: "device:", // device:{uuid} → { token_id }（设备 uuid 反查索引，存 TOKENS namespace）
  NODES: "nodes", // nodes → Node[] JSON
  SESSION: "session:", // session:{token} → { email, created_at }（存 TOKENS namespace）
  MAGIC: "magic:", // magic:{ticket} → MagicTicket JSON（一次性，用后即焚，存 TOKENS namespace）
  TRIAL: "trial:", // trial:{email} → { token_id, created_at }（免费体验每邮箱限领一次，存 TOKENS namespace）
  BONUS: "bonus:", // bonus:{email}:{planId} → { granted_at }（套餐赠送时长每邮箱每套餐限一次，存 TOKENS namespace）
  TRIAL_IP: "trialip:", // trialip:{ip} → 1（免费体验每 IP 每天限领一次，TTL 24h，存 TOKENS namespace）
  REFCODE: "refcode:", // refcode:{code} → { email }（推广码反查邀请人，存 TOKENS namespace）
  REFOWNER: "refowner:", // refowner:{email} → { code }（邮箱→推广码反查键，免全表扫，存 TOKENS namespace）
  REFCREDIT: "refcredit:", // refcredit:{email} → { earned, used }（推广减免额度，单位：个 ×10元，存 TOKENS namespace）
  REFERRAL: "referral:", // referral:{被邀请人email} → { referrer_email, created_at }（存 TOKENS namespace）
  REG: "reg:", // reg:{账号email} → Registration JSON（防失联登记，存 TOKENS namespace）
  MAILTHROTTLE: "mailthrottle:", // mailthrottle:{sha1(email)} → 计数（收件人邮件节流，1h TTL，存 TOKENS namespace）
  IPINFO: "ipinfo:", // ipinfo:{ip} → 机房/代理分类缓存（TTL 30 天，体验 token 滥用判定用，存 TOKENS namespace）
  GEO: "geo:", // geo:{ip} → IpGeo 归属缓存（TTL 30 天，管理端地理分布用，存 TOKENS namespace）
  SUBMON: "submon:", // submon:{contact} → { last_paid_at }（连续包月资格：上次支付成功时间，存 TOKENS namespace）
  SUBYEAR: "subyear:", // subyear:{contact} → { last_paid_at }（连续包年资格：上次支付成功时间，存 TOKENS namespace）
  YRSTD: "yrstd:", // yrstd:{contact} → { last_paid_at }（年付套餐 ¥120 连续续费奖励判定，存 TOKENS namespace）
  MAILIN: "mailin:", // mailin:{sha1(from邮箱)} → 计数（工单邮件追加节流，1h 窗口，存 TICKETS namespace）
} as const;
