import type { Env } from "../types";

/** Cloudflare siteverify 固定地址（官方文档约定的唯一校验端点） */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Turnstile 服务端校验：把前端 widget 产出的 token  POST 给 siteverify 验真。
 *
 * 放行/拒绝约定：
 * - 未配置 TURNSTILE_SECRET_KEY → 直接放行（本地开发与灰度期无感）；
 * - 配置后 fail-closed：token 缺失、success !== true、请求异常一律视为不通过，
 *   宁可误拒真人也不放机器人（拒绝文案会引导用户刷新重试）。
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip?: string
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  try {
    // form-encoded 是 siteverify 的约定格式；remoteip 让 CF 做二次风控，取真实客户端 IP
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    // 网络异常/响应非 JSON：fail-closed，不放行
    return false;
  }
}
