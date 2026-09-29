/**
 * vitest 运行时的 "cloudflare:workers" 桩：真实运行时由 workerd 提供该模块，
 * node 侧测试只需要 DurableObject 基类把 ctx/env 挂到实例上（与真实基类同形）。
 * 经 vitest.config.ts 的 resolve.alias 生效，不进生产 bundle。
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
