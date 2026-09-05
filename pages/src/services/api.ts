import type { CreateOrderResponse, Device, FaqItem, Order, Plan, Registration, Token } from "../../../shared/types";

// 生产环境通过 VITE_API_BASE 指定 API Worker 域名，如 https://api.example.com
// 开发环境留空，由 Vite 代理到本地 wrangler dev
const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

/** 返回可用于复制/外部引用的绝对 URL 前缀 */
function absoluteBase(): string {
  return BASE || (typeof window !== "undefined" ? window.location.origin : "");
}

interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** Magic link 核销结果：会话凭证 + 邮箱 + 目标 token */
export interface MagicSession {
  session_token: string;
  email: string;
  token_id: string;
}

/**
 * 非本人（未登录或账号邮箱 ≠ 购买邮箱）查询 token 时，后端只返回概要并带 restricted 标记，
 * 不含 uuid / devices 等敏感字段
 */
export type TokenView = Token & { restricted?: true };

/** 读取本地登录会话；有 fg_session 时返回 Authorization 头，否则空对象（不影响未登录场景） */
function sessionHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem("fg_session");
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    cache: "no-store", // API 数据一律不缓存，避免拿到过期响应
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `请求失败 (${res.status})`);
  }
  return body.data as T;
}

export const api = {
  /** 套餐列表 */
  plans: () => request<Plan[]>("/api/plans"),

  /** 创建订单（返回 pending 订单；支付通道已摘除，暂无支付二维码；带登录会话时自动使用推广余额抵扣；ref 为推广码） */
  createOrder: (plan_id: string, contact?: string, ref?: string) =>
    request<CreateOrderResponse>("/api/orders", {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ plan_id, contact, ref }),
    }),

  /** 我的推广信息（推广链接/已结算与待结算人数/推广余额）；未登录 401 */
  referralMe: () =>
    request<{
      code: string;
      link: string;
      invited_count: number;
      pending_count: number;
      available_credits: number;
      discount_per_credit: number;
    }>("/api/referral/me", { headers: sessionHeaders() }),

  /** 查询订单支付状态（扫码页轮询用，只返回状态与 token 短 ID） */
  orderStatus: (id: string) =>
    request<{ status: Order["status"]; token_id?: string }>(`/api/orders/${id}`),

  /** 查询 token 详情（带会话时本人返回完整数据，否则只返回概要并带 restricted 标记） */
  getToken: (id: string) => request<TokenView>(`/api/tokens/${id}`, { headers: sessionHeaders() }),

  /** 激活 token，开始计时（非本人响应同样只含概要） */
  activateToken: (id: string) =>
    request<TokenView>(`/api/tokens/${id}/activate`, {
      method: "POST",
      headers: sessionHeaders(),
    }),

  /** 绑定新设备（生成设备专属 uuid 与订阅链接）；需本人登录，否则 401 */
  addDevice: (tokenId: string, name: string) =>
    request<Device>(`/api/tokens/${tokenId}/devices`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ name }),
    }),

  /** 解绑设备（该设备 uuid 立即失效）；需本人登录，否则 401 */
  removeDevice: (tokenId: string, deviceId: string) =>
    request<{ id: string }>(`/api/tokens/${tokenId}/devices/${deviceId}`, {
      method: "DELETE",
      headers: sessionHeaders(),
    }),

  /** 封禁接入 IP（30 秒内全节点生效）；需本人登录，否则 401 */
  blockIp: (tokenId: string, ip: string) =>
    request<{ blocked_ips: string[] }>(`/api/tokens/${tokenId}/blocked-ips`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ ip }),
    }),

  /** 解除封禁接入 IP；需本人登录，否则 401 */
  unblockIp: (tokenId: string, ip: string) =>
    request<{ blocked_ips: string[] }>(`/api/tokens/${tokenId}/blocked-ips/${encodeURIComponent(ip)}`, {
      method: "DELETE",
      headers: sessionHeaders(),
    }),

  /** 自助重置流量（有效期 -30 天）；需本人登录，否则 401 */
  resetPenalty: (tokenId: string) =>
    request<TokenView>(`/api/tokens/${tokenId}/reset-penalty`, {
      method: "POST",
      headers: sessionHeaders(),
    }),

  /** 升级套餐（补差价）：返回升级订单；差价 ≤0 时 paid=true 且 token 为升级后的完整数据 */
  upgradeToken: (tokenId: string, target_plan_id: string) =>
    request<{ order: Order; token?: TokenView; paid: boolean }>(`/api/tokens/${tokenId}/upgrade`, {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ target_plan_id }),
    }),

  /** Clash 订阅链接（需 token 处于 active）；走主域 fastergamer.click，由 CF Worker 渲染 */
  subUrl: (uuid: string) => `https://fastergamer.click/api/sub?uuid=${encodeURIComponent(uuid)}`,

  /** 自助重新生成订阅链接（不限次数；旧链接立即失效）；需本人登录，否则 401 */
  rotateUuid: (tokenId: string) =>
    request<{ id: string; uuid: string }>(`/api/tokens/${tokenId}/rotate-uuid`, {
      method: "POST",
      headers: sessionHeaders(),
    }),

  /** 凭联系方式找回 token（返回概要列表，不含 uuid） */
  recoverTokens: (contact: string) =>
    request<
      Array<
        Pick<
          Token,
          | "id"
          | "status"
          | "plan_id"
          | "purchased_at"
          | "activated_at"
          | "expires_at"
          | "traffic_limit_gb"
          | "traffic_used_gb"
          | "contact"
        >
      >
    >("/api/tokens/recover", {
      method: "POST",
      body: JSON.stringify({ contact }),
    }),

  /** 公开 FAQ 列表 */
  faq: () => request<FaqItem[]>("/api/faq"),

  /** 账号体系已简化为邮箱免密登录：核销 magic ticket 换取 30 天会话 */
  consumeMagic: (ticket: string) =>
    request<MagicSession>(`/api/tokens/magic/consume?ticket=${encodeURIComponent(ticket)}`),

  /** 提交问题反馈（邮箱必填，回复发到邮箱） */
  feedback: (input: { contact: string; message: string; category?: string; token_id?: string }) =>
    request<{ id: string }>("/api/feedback", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** 发送免密登录链接到邮箱（链接带一次性 ticket，点开即登录进入管理页） */
  loginLink: (contact: string) =>
    request<null>("/api/tokens/login-link", {
      method: "POST",
      body: JSON.stringify({ contact }),
    }),

  /** 查询防失联登记（需登录会话；未登记返回 null） */
  getRegistration: () =>
    request<Registration | null>("/api/register", { headers: sessionHeaders() }),

  /** 登记/更新通知联系方式（需登录会话；至少填一项） */
  saveRegistration: (input: { notify_email?: string; telegram?: string }) =>
    request<Registration>("/api/register", {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify(input),
    }),

  /** 领取免费体验（每邮箱一次，3 天 20GB，凭证发到邮箱）；ref 为推广码 */
  claimTrial: (email: string, ref?: string) =>
    request<{ token_id: string }>("/api/tokens/trial", {
      method: "POST",
      body: JSON.stringify({ email, ref: ref || undefined }),
    }),

  /** 验证订阅是否可用：依次尝试主站与本站，返回节点数或错误信息 */
  verifySub: async (uuid: string) => {
    const path = `/api/sub?uuid=${encodeURIComponent(uuid)}`;
    const tryFetch = async (base: string) => {
      const res = await fetch(`${base}${path}`, { method: "GET", cache: "no-store" });
      const text = await res.text();
      if (!res.ok) throw new Error(`请求失败 (${res.status})`);
      return (text.match(/^  - name:/gm) ?? []).length;
    };
    // 用户实际使用的订阅链接在主域 fastergamer.click（CF Worker），先验证它；再试本站
    const mainBase = "https://fastergamer.click";
    const bases = [mainBase];
    const origin = absoluteBase();
    if (origin && origin !== mainBase) bases.push(origin);

    let lastErr = "网络不可达";
    for (const base of bases) {
      try {
        const nodeCount = await tryFetch(base);
        if (nodeCount === 0) {
          return { valid: false, nodeCount: 0, error: "订阅内容未包含任何节点" } as const;
        }
        return { valid: true, nodeCount, error: undefined } as const;
      } catch (e) {
        lastErr = (e as Error).message;
      }
    }
    return {
      valid: false,
      nodeCount: 0,
      error:
        `当前网络无法访问订阅服务（已尝试 ${bases.length} 个入口）：${lastErr}。` +
        "请关闭代理/更换网络后重试",
    } as const;
  },
};
