import type { CreateOrderResponse, Device, FaqItem, Node, Plan, Token } from "../../../shared/types";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
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

  /** 创建订单（人工收款模式：返回 pending 订单，确认到账后才发 token） */
  createOrder: (plan_id: string, contact?: string) =>
    request<CreateOrderResponse>("/api/orders", {
      method: "POST",
      body: JSON.stringify({ plan_id, contact }),
    }),

  /** 查询 token 详情 */
  getToken: (id: string) => request<Token>(`/api/tokens/${id}`),

  /** 激活 token，开始计时 */
  activateToken: (id: string) =>
    request<Token>(`/api/tokens/${id}/activate`, { method: "POST" }),

  /** 绑定新设备（生成设备专属 uuid 与订阅链接） */
  addDevice: (tokenId: string, name: string) =>
    request<Device>(`/api/tokens/${tokenId}/devices`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  /** 解绑设备（该设备 uuid 立即失效） */
  removeDevice: (tokenId: string, deviceId: string) =>
    request<{ id: string }>(`/api/tokens/${tokenId}/devices/${deviceId}`, {
      method: "DELETE",
    }),

  /** 节点在线状态（公开接口） */
  nodesStatus: () =>
    request<
      Array<
        Pick<Node, "id" | "name" | "region" | "host" | "port" | "tls" | "ws_path"> & {
          last_seen_at?: number;
          online: boolean;
          total_bytes: number;
          online_count: number;
          stats_updated_at?: number;
        }
      >
    >("/api/nodes/status"),

  /** Clash 订阅链接（需 token 处于 active） */
  subUrl: (uuid: string) => `${absoluteBase()}/api/sub?uuid=${encodeURIComponent(uuid)}`,

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

  /** 提交问题反馈（邮箱必填，回复发到邮箱） */
  feedback: (input: { contact: string; message: string; category?: string; token_id?: string }) =>
    request<{ id: string }>("/api/feedback", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** 发送免密登录链接到邮箱（链接带 token ID，点击进入管理页） */
  loginLink: (contact: string) =>
    request<null>("/api/tokens/login-link", {
      method: "POST",
      body: JSON.stringify({ contact }),
    }),

  /** 验证订阅是否可用，返回节点数或错误信息 */
  verifySub: async (uuid: string) => {
    const url = `${absoluteBase()}/api/sub?uuid=${encodeURIComponent(uuid)}`;
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    const text = await res.text();
    if (!res.ok) {
      return { valid: false, nodeCount: 0, error: `请求失败 (${res.status})` } as const;
    }
    const nodeCount = (text.match(/^  - name:/gm) ?? []).length;
    if (nodeCount === 0) {
      return { valid: false, nodeCount: 0, error: "订阅内容未包含任何节点" } as const;
    }
    return { valid: true, nodeCount, error: undefined } as const;
  },
};
