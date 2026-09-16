import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { verifyTurnstile } from "../lib/turnstile";

/**
 * Turnstile 人机校验中间件，挂在匿名表单接口的 rateLimit 之后（先限流挡无脑洪峰，
 * 再人机校验挡脚本慢刷，避免限流桶被人机验证的站外请求白白消耗）。
 *
 * token 走 x-turnstile-token 请求头而非 JSON body：中间件若读 body 会把请求流消费掉，
 * 下游路由再 c.req.json() 就拿不到内容。
 *
 * 未配置 TURNSTILE_SECRET_KEY 时 verifyTurnstile 直接放行，此中间件零成本。
 */
export const turnstile: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  // 只校验 POST：挂载路径（如 /api/orders）同时覆盖 GET 轮询（订单状态查询），
  // 人机验证只针对匿名写操作，读接口不能要求 token
  if (c.req.method !== "POST") {
    await next();
    return;
  }
  const passed = await verifyTurnstile(
    c.env,
    c.req.header("x-turnstile-token"),
    c.req.header("cf-connecting-ip")
  );
  if (!passed) {
    return c.json({ ok: false, error: "人机验证未通过，请刷新页面重试" }, 400);
  }
  await next();
};
