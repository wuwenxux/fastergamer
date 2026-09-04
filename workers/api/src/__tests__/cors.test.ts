import { describe, expect, it } from "vitest";
import worker from "../index";
import type { Env } from "../types";

/** /health 不触 KV，env 只需提供测试关注的字段 */
const makeEnv = (over: Partial<Env> = {}) => over as Env;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const corsOrigin = async (env: Env, origin: string) => {
  const res = await worker.fetch(
    new Request("https://fastergamer.cn/health", { headers: { Origin: origin } }),
    env,
    ctx
  );
  return res.headers.get("access-control-allow-origin");
};

describe("CORS localhost 来源仅 dev 放行", () => {
  it("生产（无 ENVIRONMENT）不放行 localhost", async () => {
    expect(await corsOrigin(makeEnv(), "http://localhost:5173")).not.toBe("http://localhost:5173");
    expect(await corsOrigin(makeEnv(), "http://127.0.0.1:5173")).not.toBe("http://127.0.0.1:5173");
  });

  it("ENVIRONMENT=production 同样不放行 localhost", async () => {
    const env = makeEnv({ ENVIRONMENT: "production" });
    expect(await corsOrigin(env, "http://localhost:5173")).not.toBe("http://localhost:5173");
  });

  it("ENVIRONMENT=dev 放行 localhost / 127.0.0.1", async () => {
    const env = makeEnv({ ENVIRONMENT: "dev" });
    expect(await corsOrigin(env, "http://localhost:5173")).toBe("http://localhost:5173");
    expect(await corsOrigin(env, "http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });

  it("生产仍放行本站域名", async () => {
    expect(await corsOrigin(makeEnv(), "https://fastergamer.cn")).toBe("https://fastergamer.cn");
  });
});
