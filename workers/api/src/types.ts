/** API Worker 的绑定与环境变量类型 */
export interface Env {
  /** 前端静态站（Cloudflare 部署时绑定；workerd 本机模式无此绑定，静态站由 nginx 托管） */
  ASSETS?: Fetcher;
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
  /** 运行环境：仅 "dev"（本地 wrangler dev）时 CORS 放行 localhost 来源，生产不设置 */
  ENVIRONMENT?: string;
  /** 新反馈工单的管理员通知邮箱（可选，不配置则不通知） */
  ADMIN_NOTIFY_EMAIL?: string;
  /** 易支付商户ID（收款已停用，仅退款接口使用） */
  EPAY_PID?: string;
  /** 易支付商户私钥（PKCS8 PEM，可单行存放） */
  EPAY_PRIVATE_KEY?: string;
  /** 易支付平台公钥（SPKI PEM，用于退款响应验签） */
  EPAY_PLATFORM_KEY?: string;
}
