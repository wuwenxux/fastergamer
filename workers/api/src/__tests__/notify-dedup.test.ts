import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimNotification, releaseNotification } from "../lib/notify-dedup";
import { handleMailBatch, type MailMessage } from "../lib/email-aliyun";
import type { Env } from "../types";
import { fakeShareGuard } from "./helpers";

/**
 * 通知认领存储的 Worker 侧入口（lib/notify-dedup.ts）与邮件消费者的去重收口：
 * - claim/release 经 SHARE_GUARD DO 的 /notify-claim /notify-release；无绑定或异常 fail-open
 *   （宁可重复发，不可因认领存储故障静默丢通知）
 * - handleMailBatch：带 dedup 键的消息先认领，已认领 → ack 丢弃；发送失败 → 释放认领 + retry
 * fetch 桩成阿里云 DM 应答，不触网。
 */

const guardEnv = (guard = fakeShareGuard()) =>
  ({
    SHARE_GUARD: guard.ns,
    ALIYUN_ACCESS_KEY_ID: "test-id",
    ALIYUN_ACCESS_KEY_SECRET: "test-secret",
    SITE_URL: "https://fastergamer.click",
  }) as unknown as Env;

const stubMail = (ok: boolean) => {
  const fetchMock = vi.fn(async () =>
    ok
      ? new Response(JSON.stringify({ RequestId: "r1" }), { status: 200 })
      : new Response(JSON.stringify({ Code: "InvalidToAddress", Message: "bad address" }), { status: 400 })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

/** MessageBatch 最小形状：body + ack/retry/attempts */
const batchOf = (bodies: MailMessage[], attempts = 1) => ({
  messages: bodies.map((body) => ({ body, ack: vi.fn(), retry: vi.fn(), attempts })),
});

const msg = (dedup?: MailMessage["dedup"]): MailMessage => ({
  to: "user@example.com",
  subject: "测试",
  html: "<p>hi</p>",
  text: "hi",
  kind: "notify",
  ...(dedup ? { dedup } : {}),
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("claimNotification / releaseNotification", () => {
  it("认领经 DO 裁决：首次 true，同键 false；release 后可再认领", async () => {
    const guard = fakeShareGuard();
    const env = guardEnv(guard);
    expect(await claimNotification(env, "k1")).toBe(true);
    expect(await claimNotification(env, "k1")).toBe(false);
    await releaseNotification(env, "k1");
    expect(await claimNotification(env, "k1")).toBe(true);
  });

  it("ttlMs 节流键：窗口内 false，到期后可再认领", async () => {
    const env = guardEnv();
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(await claimNotification(env, "k2", 1000)).toBe(true);
    expect(await claimNotification(env, "k2", 1000)).toBe(false);
    vi.setSystemTime(now + 1001);
    expect(await claimNotification(env, "k2", 1000)).toBe(true);
    vi.useRealTimers();
  });

  it("无 SHARE_GUARD 绑定：fail-open 返回 true，release 不抛", async () => {
    const env = { SITE_URL: "https://fastergamer.click" } as unknown as Env;
    expect(await claimNotification(env, "k3")).toBe(true);
    await expect(releaseNotification(env, "k3")).resolves.toBeUndefined();
  });

  it("DO 请求异常：fail-open 返回 true（宁可重复发）；release 吞异常", async () => {
    const broken = {
      idFromName: () => "id",
      get: () => ({ fetch: async () => Promise.reject(new Error("do down")) }),
    } as unknown as DurableObjectNamespace;
    const env = guardEnv();
    env.SHARE_GUARD = broken;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await claimNotification(env, "k4")).toBe(true);
    await expect(releaseNotification(env, "k4")).resolves.toBeUndefined();
  });
});

describe("handleMailBatch 消费者去重收口", () => {
  it("带 dedup 键：首次认领发送并 ack；同键重投递 ack 丢弃不发送", async () => {
    const env = guardEnv();
    const fetchMock = stubMail(true);
    const dedup = { key: "trial_convert:tk_1" };
    const batch = batchOf([msg(dedup), msg(dedup)]); // 同键两条（at-least-once 重投递）
    await handleMailBatch(batch as never, env);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 只真发一封
    expect(batch.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(batch.messages[1].ack).toHaveBeenCalledTimes(1); // 重复消息也 ack（不重试）
    expect(batch.messages[1].retry).not.toHaveBeenCalled();
  });

  it("发送失败：释放认领 + retry（重试能重新认领发出）", async () => {
    const guard = fakeShareGuard();
    const env = guardEnv(guard);
    const fetchMock = stubMail(false);
    const dedup = { key: "expire_24h:tk_1" };
    const batch = batchOf([msg(dedup)]);
    await handleMailBatch(batch as never, env);
    expect(batch.messages[0].retry).toHaveBeenCalledTimes(1);
    expect(batch.messages[0].ack).not.toHaveBeenCalled();
    expect(guard.claims.has("expire_24h:tk_1")).toBe(false); // 认领已释放

    // 重试（通道恢复）：同键可重新认领并发送
    stubMail(true);
    const batch2 = batchOf([msg(dedup)], 2);
    await handleMailBatch(batch2 as never, env);
    expect(batch2.messages[0].ack).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(guard.claims.has("expire_24h:tk_1")).toBe(true);
  });

  it("无 dedup 键的消息不去重：照常发送", async () => {
    const env = guardEnv();
    const fetchMock = stubMail(true);
    const batch = batchOf([msg(), msg()]);
    await handleMailBatch(batch as never, env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batch.messages.every((m) => m.ack.mock.calls.length === 1)).toBe(true);
  });
});
