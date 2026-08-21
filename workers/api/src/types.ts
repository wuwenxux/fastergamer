/** API Worker 的绑定与环境变量类型 */
export interface Env {
  TOKENS: KVNamespace;
  PLANS: KVNamespace;
  ORDERS: KVNamespace;
  /** 节点注册表 */
  NODES: KVNamespace;
  /** 用户反馈工单 */
  TICKETS: KVNamespace;
  /** 管理接口密钥（x-admin-key header） */
  ADMIN_KEY: string;
  /** 兜底节点：nodes 注册表为空时，Clash 订阅回退到这个直连入口 */
  FALLBACK_NODE_HOST: string;
  /** 兜底节点端口（默认 443；本地模式可为 80） */
  FALLBACK_NODE_PORT?: string;
  /** 兜底节点是否启用 TLS（默认 true；本地明文 WS 时为 false） */
  FALLBACK_NODE_TLS?: string;
  /** 兜底节点 WS 路径（默认 /vless-ws） */
  FALLBACK_NODE_WS_PATH?: string;
  /** Clash 订阅展示的地区列表 JSON：[{code,flag,name}] */
  CLASH_REGIONS: string;
  /** 套餐兜底（未 seed 时生效），JSON 数组字符串 */
  DEFAULT_PLANS: string;
  /** 阿里云邮件推送 AccessKey ID */
  ALIYUN_ACCESS_KEY_ID?: string;
  /** 阿里云邮件推送 AccessKey Secret */
  ALIYUN_ACCESS_KEY_SECRET?: string;
  /** 发件人邮箱，如 GameBoost <service@fastergamer.cn> */
  EMAIL_FROM?: string;
  /** 官网域名，用于邮件内链接，如 https://fastergamer.cn */
  SITE_URL?: string;
  /** 新反馈工单的管理员通知邮箱（可选，不配置则不通知） */
  ADMIN_NOTIFY_EMAIL?: string;
}
