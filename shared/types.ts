/**
 * 共享类型定义 —— 供 API Worker 与前端共同使用
 */

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
  /** 当月已用流量（bytes，自然月重置）；仅套餐设了 monthly_quota_gb 时参与限额 */
  month_used_bytes?: number;
  /** 当前月度账期标识，如 "2026-08" */
  month_key?: string;
  /** 已锁定的预支月数（跨月不归还；当月新预支 = floor(month_used/quota)） */
  months_borrowed?: number;
  /** 原始到期时间（激活时设定）；实际 expires_at = base - 预支月数*30天 */
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
  /** 已发送过的风险提醒（类型 → 发送时间戳），防止重复打扰 */
  notify_log?: Record<string, number>;
  /** 流量速率窗口起点（unix 毫秒），用于暴增检测 */
  rate_window_start?: number;
  /** 当前速率窗口内新增流量（bytes） */
  rate_window_bytes?: number;
  /** 绑定的设备槽位（不含主设备 uuid），每个设备独立 uuid 做流量审计 */
  devices?: Device[];
  /** 最后一次产生流量的时间（unix 毫秒）。已迁移至 presence:{uuid}，仅为存量兼容保留 */
  last_active_at?: number;
  /** unix 毫秒时间戳 */
  purchased_at: number;
  activated_at?: number;
  expires_at?: number;
  /** 上次重新生成订阅链接的时间（unix 毫秒），仅作记录，不限次数 */
  rotated_at?: number;
}

/**
 * Presence —— token 的高频动态状态，独立存 presence:{uuid}（TOKENS namespace）。
 * 只有结算路径（/api/agent/traffic）与 notify-scan 的在线清扫写它；
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
}

/** 订单 —— 一次购买行为 */
export interface Order {
  id: string;
  plan_id: string;
  /** 支付流水号；个人收款码过渡期间仅为内部参考号 */
  payment_ref: string;
  status: "pending" | "paid" | "failed";
  /** 买家联系方式 */
  contact?: string;
  /** 确认收款后发放的 token 短 ID */
  token_id?: string;
  /** 确认收款时间（unix 毫秒） */
  paid_at?: number;
  /** 当面付动态二维码内容（配置了支付宝时由 precreate 生成；无则前端回退静态收款码） */
  alipay_qr_code?: string;
  /** 支付宝交易号（回调成功后记录，用于对账） */
  trade_no?: string;
  /** 推广减免金额（元）：邀请新用户注册获得，每个额度减 10 元 */
  discount_cny?: number;
  /** 实付金额（元）= 套餐价 - 减免；无减免时等于套餐价 */
  payable_cny?: number;
  /** 买家声明「我已转账」（静态收款模式）：管理员收到邮件提醒后核对到账再确认 */
  paid_claim?: {
    at: number;
    /** 买家自述转账金额（元），可选 */
    amount_cny?: number;
    /** 买家自述付款账号昵称/尾号，可选，辅助对账 */
    note?: string;
  };
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
  /** 是否沉淀到公开 FAQ（需已回复） */
  publish_faq?: boolean;
  created_at: number;
  replied_at?: number;
}

/** 公开 FAQ 条目（由 publish_faq 的工单生成） */
export interface FaqItem {
  question: string;
  answer: string;
  category?: string;
}

/** 一次性 magic link 票据（登录用） */
export interface MagicTicket {
  email: string;
  token_id: string;
  created_at: number;
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

/** KV 键前缀常量 */
export const KV = {
  TOKEN: "token:", // token:{uuid} → Token JSON
  PRESENCE: "presence:", // presence:{uuid} → Presence JSON（高频动态状态，存 TOKENS namespace）
  TOKEN_BY_ID: "tokenid:", // tokenid:{id} → { uuid }
  PLAN: "plan:", // plan:{id} → Plan JSON
  ORDER: "order:", // order:{id} → Order JSON
  ORDER_LOCK: "orderlock:", // orderlock:{orderId} → { at }（订单发货锁，免费层 best-effort 幂等，存 TOKENS namespace）
  TICKET: "ticket:", // ticket:{id} → Ticket JSON（存 TICKETS namespace）
  DEVICE: "device:", // device:{uuid} → { token_id }（设备 uuid 反查索引，存 TOKENS namespace）
  ROUTING: "routing", // routing → 区域名列表 JSON
  NODES: "nodes", // nodes → Node[] JSON
  QR: "qr:", // qr:{alipay|wechat} → 收款码图片二进制（存 PLANS namespace）
  SESSION: "session:", // session:{token} → { email, created_at }（存 TOKENS namespace）
  MAGIC: "magic:", // magic:{ticket} → MagicTicket JSON（一次性，用后即焚，存 TOKENS namespace）
  TRIAL: "trial:", // trial:{email} → { token_id, created_at }（免费体验每邮箱限领一次，存 TOKENS namespace）
  REFCODE: "refcode:", // refcode:{code} → { email }（推广码反查邀请人，存 TOKENS namespace）
  REFCREDIT: "refcredit:", // refcredit:{email} → { earned, used }（推广减免额度，单位：个 ×10元，存 TOKENS namespace）
  REFERRAL: "referral:", // referral:{被邀请人email} → { referrer_email, created_at }（存 TOKENS namespace）
  REG: "reg:", // reg:{账号email} → Registration JSON（防失联登记，存 TOKENS namespace）
} as const;

/** API 统一响应格式 */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
