import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { rateLimit, rateLimitInternals } from "../middleware/rateLimit";
import type { Env } from "../types";

const app = new Hono<{ Bindings: Env }>();
app.use("/x", rateLimit(1000, 60_000));
app.get("/x", (c) => c.json({ ok: true }));

const hit = (ip: string) =>
  app.request("/x", { headers: { "cf-connecting-ip": ip } }, {} as Env);

describe("rateLimit 过期 bucket 惰性清扫", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rateLimitInternals.buckets.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    rateLimitInternals.buckets.clear();
  });

  it("sweepExpired 只清过期条目，未过期的保留", async () => {
    await hit("1.1.1.1");
    expect(rateLimitInternals.buckets.size).toBe(1);
    vi.setSystemTime(Date.now() + 30_000);
    await hit("2.2.2.2"); // 窗口内的新条目
    rateLimitInternals.sweepExpired(Date.now() + 31_000); // 1.1.1.1 已过期，2.2.2.2 未过期
    expect([...rateLimitInternals.buckets.keys()]).toEqual(["2.2.2.2"]);
  });

  it("每 64 个请求自动触发一次清扫，内存不随一次性 IP 单调增长", async () => {
    await hit("9.9.9.9"); // 即将过期的条目
    vi.setSystemTime(Date.now() + 61_000); // 越过 60s 窗口
    for (let i = 0; i < 64; i++) await hit(`10.0.0.${i}`);
    // 触发了一次清扫：64 个新 IP 里最后一个窗口内保留，过期的 9.9.9.9 被清掉
    expect(rateLimitInternals.buckets.has("9.9.9.9")).toBe(false);
    expect(rateLimitInternals.buckets.size).toBeLessThanOrEqual(64);
  });
});
