import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * 过期 bucket 惰性清扫：每处理 SWEEP_EVERY 个请求顺手清一次，
 * 防止一次性 IP（扫描器等）的条目在 Map 里永久堆积、内存单调增长。
 */
const SWEEP_EVERY = 64;
let sinceSweep = 0;

const sweepExpired = (now: number): void => {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
};

/**
 * 简单的内存滑动窗口限流（单机开发环境足够，多实例部署需换 KV/DO）
 */
export const rateLimit = (max: number, windowMs: number): MiddlewareHandler<{ Bindings: Env }> => {
  return async (c, next) => {
    const key = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "unknown";
    const now = Date.now();

    if (++sinceSweep >= SWEEP_EVERY) {
      sinceSweep = 0;
      sweepExpired(now);
    }

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

/** 暴露给测试观察内部状态 */
export const rateLimitInternals = { buckets, sweepExpired };
