import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/** 管理接口鉴权：请求必须携带 x-admin-key header（主 key 不进邮件/URL，暴露面最小） */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const headerKey = c.req.header("x-admin-key");
  if (headerKey && headerKey === c.env.ADMIN_KEY) {
    await next();
    return;
  }
  return c.json({ ok: false, error: "unauthorized" }, 401);
};
