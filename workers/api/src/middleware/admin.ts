import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/** 管理接口鉴权：请求携带 x-admin-key header；浏览器一键链接（邮件里）可用 ?key= 查询参数 */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const key = c.req.header("x-admin-key") ?? c.req.query("key");
  if (!key || key !== c.env.ADMIN_KEY) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
};
