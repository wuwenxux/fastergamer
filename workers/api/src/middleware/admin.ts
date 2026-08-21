import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/** 管理接口鉴权：请求需携带 x-admin-key header，值与环境变量 ADMIN_KEY 一致 */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const key = c.req.header("x-admin-key");
  if (!key || key !== c.env.ADMIN_KEY) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  await next();
};
