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
  /** 支付宝当面付应用 appid（三项齐全才启用动态扫码，否则回退静态收款码人工确认） */
  ALIPAY_APPID?: string;
  /** 支付宝当面付应用私钥（PKCS8 PEM，可单行存放） */
  ALIPAY_PRIVATE_KEY?: string;
  /** 支付宝公钥（SPKI PEM，用于回调验签） */
  ALIPAY_PUBLIC_KEY?: string;
  /** 支付宝收款账号（静态转账模式展示给用户，手机号或邮箱） */
  ALIPAY_ACCOUNT?: string;
}
