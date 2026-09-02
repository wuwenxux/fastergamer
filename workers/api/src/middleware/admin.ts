import type { MiddlewareHandler } from "hono";
import { validateOrderConfirmTicket } from "../lib/kv";
import type { Env } from "../types";

/** 管理接口鉴权：请求携带 x-admin-key header。
 *  例外：订单一键确认链接（/orders/:id/confirm）接受 ?ticket= 一次性票据
 *  （GET 落地页只验不焚——邮箱网关会预取；POST 发货验后焚毁），
 *  不再接受 ?key= 主 key——主 key 进邮件/URL 的暴露面过大 */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const headerKey = c.req.header("x-admin-key");
  if (headerKey && headerKey === c.env.ADMIN_KEY) {
    await next();
    return;
  }
  const m = c.req.path.match(/^\/api\/admin\/orders\/([^/]+)\/confirm$/);
  if (m) {
    const ticket = c.req.query("ticket");
    if (ticket && (await validateOrderConfirmTicket(c.env, m[1], ticket, c.req.method === "POST"))) {
      await next();
      return;
    }
  }
  return c.json({ ok: false, error: "unauthorized" }, 401);
};
