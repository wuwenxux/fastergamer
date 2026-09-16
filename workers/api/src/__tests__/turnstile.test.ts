import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import type { Env } from "../types";

/**
 * Turnstile 人机验证：
 * - 未配置 TURNSTILE_SECRET_KEY → 直接放行（本地/灰度无感）
 * - 配置后 fail-closed：无 token、siteverify 返回 success:false、fetch 异常一律 400
 * siteverify 之外的全局 fetch 不拦截，避免误伤 worker 内部其他出站请求。
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const realFetch = globalThis.fetch;

/** 只拦截 siteverify 的 fetch mock，其余请求透传到原始 fetch */
const stubSiteverify = (impl: () => Response | Promise<Response>) => {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === SITEVERIFY_URL) return impl();
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
};

afterEach(() => vi.unstubAllGlobals());

/** 假 KV：map 实现（put 忽略 TTL 等选项，测试只关心存在性） */
const fakeNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  } as unknown as KVNamespace;
  return { ns, store };
};

const ctx = {
  waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const TRIAL_PLAN = {
  id: "plan_3days",
  name: "3 天免费体验",
  duration_days: 3,
  price_cny: 0,
  traffic_limit_gb: 20,
  max_devices: 1,
};

const makeEnv = (over: Partial<Env> = {}) =>
  ({
    TOKENS: fakeNs().ns,
    PLANS: fakeNs().ns,
    DEFAULT_PLANS: JSON.stringify([TRIAL_PLAN]),
    SITE_URL: "https://fastergamer.click",
    ...over,
  }) as unknown as Env;

/** 每个用例用独立 IP：rateLimit 桶是模块级共享的，避免跨用例误触 429 */
let ipSeq = 0;
const postTrial = (env: Env, turnstileToken?: string) => {
  ipSeq += 1;
  return worker.fetch(
    new Request("https://api.test/api/tokens/trial", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `10.0.0.${ipSeq}`,
        ...(turnstileToken ? { "x-turnstile-token": turnstileToken } : {}),
      },
      body: JSON.stringify({ email: `user${ipSeq}@qq.com` }),
    }),
    env,
    ctx
  );
};

const rejectBody = { ok: false, error: "人机验证未通过，请刷新页面重试" };

describe("Turnstile 中间件（POST /api/tokens/trial 链路验证）", () => {
  it("未配置 TURNSTILE_SECRET_KEY：无 token 也走正常业务流程", async () => {
    const res = await postTrial(makeEnv());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("配置了 secret：无 token → 400，且不请求 siteverify", async () => {
    const spy = stubSiteverify(() => Response.json({ success: true }));
    const res = await postTrial(makeEnv({ TURNSTILE_SECRET_KEY: "secret" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(rejectBody);
    expect(spy).not.toHaveBeenCalled();
  });

  it("配置了 secret：siteverify 返回 success:true → 放行", async () => {
    const spy = stubSiteverify(() => Response.json({ success: true }));
    const res = await postTrial(makeEnv({ TURNSTILE_SECRET_KEY: "secret" }), "tk-ok");
    expect(res.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("配置了 secret：siteverify 返回 success:false → 400", async () => {
    stubSiteverify(() => Response.json({ success: false, "error-codes": ["bad"] }));
    const res = await postTrial(makeEnv({ TURNSTILE_SECRET_KEY: "secret" }), "tk-bad");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(rejectBody);
  });

  it("配置了 secret：siteverify 请求异常 → 400（fail-closed）", async () => {
    stubSiteverify(() => {
      throw new Error("network down");
    });
    const res = await postTrial(makeEnv({ TURNSTILE_SECRET_KEY: "secret" }), "tk-x");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(rejectBody);
  });
});

describe("GET 读接口不做人机校验", () => {
  it("配置了 secret：GET /api/orders/:id（支付页状态轮询）不要求 token", async () => {
    const spy = stubSiteverify(() => Response.json({ success: true }));
    const res = await worker.fetch(
      new Request("https://api.test/api/orders/ord_none", {
        headers: { "cf-connecting-ip": "10.2.0.1" },
      }),
      makeEnv({ TURNSTILE_SECRET_KEY: "secret", ORDERS: fakeNs().ns }),
      ctx
    );
    // 订单不存在走业务 404，而不是人机验证 400；GET 也不应请求 siteverify
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("GET /api/config", () => {
  it("返回 env 里配置的 Turnstile sitekey", async () => {
    const res = await worker.fetch(
      new Request("https://api.test/api/config", {
        headers: { "cf-connecting-ip": "10.1.0.1" },
      }),
      makeEnv({ TURNSTILE_SITE_KEY: "0x4AAAA_test" }),
      ctx
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { turnstile_site_key: "0x4AAAA_test" } });
  });

  it("未配置 TURNSTILE_SITE_KEY 时返回 null", async () => {
    const res = await worker.fetch(
      new Request("https://api.test/api/config", {
        headers: { "cf-connecting-ip": "10.1.0.2" },
      }),
      makeEnv(),
      ctx
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { turnstile_site_key: null } });
  });
});
