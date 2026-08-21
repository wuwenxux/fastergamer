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
  /** Clash 订阅展示的地区列表 JSON：[{code,flag,name}] */
  CLASH_REGIONS: string;
  /** 套餐兜底（未 seed 时生效），JSON 数组字符串 */
  DEFAULT_PLANS: string;
  /** 阿里云邮件推送 AccessKey ID */
  ALIYUN_ACCESS_KEY_ID?: string;
  /** 阿里云邮件推送 AccessKey Secret */
  ALIYUN_ACCESS_KEY_SECRET?: string;
  /** 官网域名，用于邮件内链接，如 https://fastergamer.cn */
  SITE_URL?: string;
  /** 新反馈工单的管理员通知邮箱（可选，不配置则不通知） */
  ADMIN_NOTIFY_EMAIL?: string;
}
