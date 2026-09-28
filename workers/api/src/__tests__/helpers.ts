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
  if (opts.plans) plans.store.set("plans", JSON.stringify(opts.plans));
  if (opts.nodes) nodes.store.set(KV.NODES, JSON.stringify(opts.nodes));
  const env = {
    TOKENS: tokens.ns,
    ORDERS: orders.ns,
    PLANS: plans.ns,
    NODES: nodes.ns,
    TICKETS: tickets.ns,
    ...(opts.defaultPlans ? { DEFAULT_PLANS: JSON.stringify(opts.defaultPlans) } : {}),
    ...(opts.adminKey ? { ADMIN_KEY: opts.adminKey } : {}),
    ...opts.extra,
  } as unknown as Env;
  return { env, tokens, orders, plans, nodes, tickets };
};
