import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/** 管理接口鉴权：请求携带 x-admin-key header；仅订单确认（/orders/）允许 ?key= 查询参数（邮件一键链接），
 *  其他 admin 路由只认 header，降低管理 key 出现在 URL/访问日志里的暴露面 */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const headerKey = c.req.header("x-admin-key");
  const queryKey = c.req.path.startsWith("/api/admin/orders/") ? c.req.query("key") : undefined;
  const key = headerKey ?? queryKey;
  if (!key || key !== c.env.ADMIN_KEY) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
};
