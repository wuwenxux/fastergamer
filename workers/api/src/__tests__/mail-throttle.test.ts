import { describe, expect, it } from "vitest";
import { KV } from "../../../../shared/types";
import { MAIL_THROTTLE_LIMIT, mailThrottleAllows } from "../lib/mail-throttle";
import { maskEmail } from "../lib/mask-email";
import type { Env } from "../types";

/** 假 KV：map 实现 */
const fakeNs = () => {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace & { store: Map<string, string> };
};

const makeEnv = (ns: KVNamespace) => ({ TOKENS: ns }) as unknown as Env;

describe("mailThrottleAllows（收件人邮件节流）", () => {
  it("每邮箱每小时限 3 封，第 4 封起拒绝", async () => {
    const env = makeEnv(fakeNs());
    for (let i = 0; i < MAIL_THROTTLE_LIMIT; i++) {
      expect(await mailThrottleAllows(env, "a@b.com")).toBe(true);
    }
    expect(await mailThrottleAllows(env, "a@b.com")).toBe(false);
    expect(await mailThrottleAllows(env, "a@b.com")).toBe(false);
  });

  it("不同邮箱独立计数", async () => {
    const env = makeEnv(fakeNs());
    for (let i = 0; i < MAIL_THROTTLE_LIMIT; i++) {
      await mailThrottleAllows(env, "a@b.com");
    }
    expect(await mailThrottleAllows(env, "c@d.com")).toBe(true);
  });

  it("大小写/首尾空白归一后共享计数", async () => {
    const env = makeEnv(fakeNs());
    for (let i = 0; i < MAIL_THROTTLE_LIMIT; i++) {
      await mailThrottleAllows(env, "A@b.com");
    }
    expect(await mailThrottleAllows(env, "  a@B.com ")).toBe(false);
  });

  it("计数键是 sha1 散列，不落明文邮箱", async () => {
    const ns = fakeNs();
    const env = makeEnv(ns);
    await mailThrottleAllows(env, "plain@example.com");
    const keys = [...ns.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^${KV.MAILTHROTTLE}[0-9a-f]{40}$`));
    expect(keys[0]).not.toContain("plain@example.com");
  });
});

describe("maskEmail（日志脱敏）", () => {
  it("保留首字符与域名", () => {
    expect(maskEmail("alice@b.com")).toBe("a***@b.com");
    expect(maskEmail("x@y.cn")).toBe("x***@y.cn");
  });

  it("非邮箱输入返回 ***", () => {
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("")).toBe("***");
  });
});
