import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * 简单的内存滑动窗口限流（单机开发环境足够，多实例部署需换 KV/DO）
 */
export const rateLimit = (max: number, windowMs: number): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const key = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);

    if (bucket && now < bucket.resetAt) {
      if (bucket.count >= max) {
        return c.json({ ok: false, error: "too many requests" }, 429);
      }
      bucket.count += 1;
    } else {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
    }

    await next();
  };
};
