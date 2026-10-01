/**
 * 测试共享 helper：内存版 KV namespace、假 ExecutionContext、基础 Env 工厂。
 * 各测试文件的 PLANS / seedToken / 专用夹具仍各自定义，这里只收敛逐字重复的基建。
 */
import { vi } from "vitest";
import { KV } from "../../../../shared/types";
import type { Env } from "../types";

/** 内存版 KV namespace（Map 实现 get/put/delete/list；put 忽略 TTL——测试只关心存在性） */
export const fakeNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: cursor ?? "",
    }),
  } as unknown as KVNamespace;
  return { ns, store };
};

/** vi.fn 包装版（语义同 fakeNs）：需要断言调用次数/参数（如 put 的 TTL、list 的调用次数）时用 */
export const mockNs = () => {
  const store = new Map<string, string>();
  const ns = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
    list: vi.fn(async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => ({
      keys: [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: cursor ?? "",
    })),
  } as unknown as KVNamespace;
  return { ns, store };
};

/** waitUntil 直接丢弃的假 ctx：测试不关心后台副作用 */
export const noopCtx = () =>
  ({ waitUntil: () => {}, passThroughOnException: () => {} }) as unknown as ExecutionContext;

/** waitUntil 吞异常真实执行：后台副作用（推送/邮件）跑起来但测试不等它 */
export const stubCtx = () =>
  ({
    waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch(() => {}),
    passThroughOnException: () => {},
  }) as unknown as ExecutionContext;

/** 收集 waitUntil 承诺的 ctx：测试 await pending 等副作用落库后再断言 */
export const collectCtx = () => {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(Promise.resolve(p).catch(() => {}));
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  };
};

/**
 * 内存版 ShareGuardDO 绑定：只实现 /notify-claim 与 /notify-release（lib/notify-dedup.ts 的
 * 唯一依赖），语义与 do/share-guard.ts 一致——键不存在/ttlMs 到期/硬过期（200 天）才可认领。
 * 挂在默认 env 上，让节流/幂等测试走真实裁决而非 fail-open 放行。
 */
export const fakeShareGuard = () => {
  const claims = new Map<string, number>();
  const HARD_EXPIRE_MS = 200 * 86_400_000;
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; ttlMs?: number };
    const now = Date.now();
    if (path === "/notify-claim") {
      const ts = claims.get(body.key);
      const reusable =
        ts === undefined || now - ts >= (body.ttlMs ?? HARD_EXPIRE_MS);
      if (reusable) {
        claims.set(body.key, now);
        return new Response(JSON.stringify({ claimed: true }));
      }
      return new Response(JSON.stringify({ claimed: false }));
    }
    if (path === "/notify-release") {
      claims.delete(body.key);
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response("not found", { status: 404 });
  };
  const ns = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: fetchFn }),
  } as unknown as DurableObjectNamespace;
  return { ns, claims };
};

/**
 * dedup 感知的 sendMail mock 工厂：带 opts.dedup 时先经 env.SHARE_GUARD（fakeShareGuard）
 * 认领，复现 handleMailBatch 消费者的裁决语义——未认领即不"发出"，且不计入调用记录，
 * 让 toHaveBeenCalledTimes / mock.calls 反映真实发送数。
 * 用法：vi.mock("../lib/email-aliyun", async (importOriginal) => {
 *   const orig = await importOriginal();
 *   const { dedupAwareSendMailMock } = await import("./helpers");
 *   return { ...orig, sendMail: dedupAwareSendMailMock() };
 * });
 */
export const dedupAwareSendMailMock = () => {
  type SendMailFn = typeof import("../lib/email-aliyun").sendMail;
  const fn = vi.fn(async (...args: Parameters<SendMailFn>): Promise<{ ok: boolean; error?: string }> => {
    const [env, , , , , opts] = args;
    if (opts?.dedup) {
      const { claimNotification } = await import("../lib/notify-dedup");
      if (!(await claimNotification(env, opts.dedup.key, opts.dedup.ttlMs))) {
        // 消费者压掉的发送不该出现在调用记录里（否则节流断言全失真）
        fn.mock.calls.pop();
        return { ok: true };
      }
    }
    return { ok: true };
  });
  return fn;
};

export interface MakeEnvOptions {
  /** 写入 PLANS 单键 "plans"（getPlans 优先读 KV） */
  plans?: unknown[];
  /** env.DEFAULT_PLANS（getPlans 的兜底常量） */
  defaultPlans?: unknown[];
  /** 写入 NODES 单键 KV.NODES */
  nodes?: unknown[];
  adminKey?: string;
  /** true = 全部 namespace 用 vi.fn 包装版（mockNs） */
  mock?: boolean;
  /** 额外绑定（SITE_URL、ADMIN_NOTIFY_EMAIL、ALIYUN_* 等），后写覆盖 */
  extra?: Record<string, unknown>;
}

/** 基础 Env 工厂：5 个 namespace + 可选种子数据/额外绑定；返回全部 namespace 供按需解构 */
export const makeEnv = (opts: MakeEnvOptions = {}) => {
  const ns = opts.mock ? mockNs : fakeNs;
  const tokens = ns();
  const orders = ns();
  const plans = ns();
  const nodes = ns();
  const tickets = ns();
  const shareGuard = fakeShareGuard();
  if (opts.plans) plans.store.set("plans", JSON.stringify(opts.plans));
  if (opts.nodes) nodes.store.set(KV.NODES, JSON.stringify(opts.nodes));
  const env = {
    TOKENS: tokens.ns,
    ORDERS: orders.ns,
    PLANS: plans.ns,
    NODES: nodes.ns,
    TICKETS: tickets.ns,
    SHARE_GUARD: shareGuard.ns,
    ...(opts.defaultPlans ? { DEFAULT_PLANS: JSON.stringify(opts.defaultPlans) } : {}),
    ...(opts.adminKey ? { ADMIN_KEY: opts.adminKey } : {}),
    ...opts.extra,
  } as unknown as Env;
  return { env, tokens, orders, plans, nodes, tickets, shareGuard };
};
