import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Ticket } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * Workers AI 工单助手（lib/ticket-ai.ts + tickets.ts 挂载点）：
 * - generateTicketDraft：正常 JSON / ```json 围栏 / 超时 / 异常 / 无 binding / 非法分类兜底 全部分支
 * - POST /api/feedback：waitUntil 异步生成写回 ai_draft；AI 失败工单仍正常创建且不阻塞响应
 * AI 绑定用 vi.fn mock；邮件 mock 掉；KV 用内存假实现。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});

import { generateTicketDraft } from "../lib/ticket-ai";
import { collectCtx, makeEnv } from "./helpers";

const TICKET: Ticket = {
  id: "fb_test01",
  contact: "user@example.com",
  category: "connect",
  message: "Clash 导入订阅后连不上，提示超时",
  status: "open",
  created_at: Date.now(),
};

/** 带 mock AI 绑定的 env（extra 覆盖进 makeEnv） */
const envWithAi = (run: ReturnType<typeof vi.fn>) =>
  makeEnv({ extra: { AI: { run } } }).env;

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("generateTicketDraft", () => {
  it("无 AI 绑定 → null（静默降级）", async () => {
    const { env } = makeEnv();
    expect(await generateTicketDraft(env, TICKET)).toBeNull();
  });

  it("正常 JSON 输出 → 解析出 category 与 draft", async () => {
    const run = vi.fn(async (_model: string, _opts: unknown) => ({
      response: '{"category":"connect","draft":"你好，先在 Clash 里更新一下订阅再换节点试试。"}',
    }));
    const draft = await generateTicketDraft(envWithAi(run), TICKET);
    expect(draft).not.toBeNull();
    expect(draft!.category).toBe("connect");
    expect(draft!.draft).toContain("更新一下订阅");
    expect(typeof draft!.at).toBe("number");
    // prompt 注入站点事实与工单内容
    const prompt = JSON.stringify(run.mock.calls[0][1]);
    expect(prompt).toContain("VLESS");
    expect(prompt).toContain(TICKET.message);
  });

  it("带 ```json 围栏与思考段 → 仍能解析", async () => {
    const run = vi.fn(async () => ({
      response: '<think>用户在问连接问题</think>好的\n```json\n{"category":"speed","draft":"晚高峰可以试试切换日本节点，延迟更低。"}\n```',
    }));
    const draft = await generateTicketDraft(envWithAi(run), TICKET);
    expect(draft!.category).toBe("speed");
    expect(draft!.draft).toContain("切换日本节点");
  });

  it("返回非法 JSON → null", async () => {
    const run = vi.fn(async () => ({ response: "抱歉，我无法回答这个问题" }));
    expect(await generateTicketDraft(envWithAi(run), TICKET)).toBeNull();
  });

  it("JSON 缺 draft 字段 → null", async () => {
    const run = vi.fn(async () => ({ response: '{"category":"connect"}' }));
    expect(await generateTicketDraft(envWithAi(run), TICKET)).toBeNull();
  });

  it("分类不在 install/connect/speed/other → 回退工单原分类", async () => {
    const run = vi.fn(async () => ({ response: '{"category":"pay","draft":"请留下订单号，人工核实后处理。"}' }));
    const draft = await generateTicketDraft(envWithAi(run), TICKET);
    expect(draft!.category).toBe("connect"); // pay 不给 AI 建议权，回退原分类
  });

  it("AI.run 抛异常 → null", async () => {
    const run = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    expect(await generateTicketDraft(envWithAi(run), TICKET)).toBeNull();
  });

  it("AI.run 超时（10s）→ null", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => new Promise(() => {})); // 永不 resolve
    const p = generateTicketDraft(envWithAi(run), TICKET);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeNull();
  });
});

describe("POST /api/feedback 挂载点", () => {
  const postFeedback = (env: Env) => {
    const { pending, ctx } = collectCtx();
    const req = new Request("https://api.test/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contact: TICKET.contact, message: TICKET.message, category: "connect" }),
    });
    return { res: worker.fetch(req, env, ctx), pending };
  };

  const readFirstTicket = async (env: Env): Promise<Ticket> => {
    const { keys } = await env.TICKETS.list({ prefix: KV.TICKET });
    return JSON.parse((await env.TICKETS.get(keys[0].name))!) as Ticket;
  };

  it("AI 正常 → 响应不等待 AI，waitUntil 跑完后 ai_draft 写回工单", async () => {
    // AI 故意慢一拍：证明响应不被草稿生成阻塞
    let release!: (v: { response: string }) => void;
    const run = vi.fn(() => new Promise<{ response: string }>((r) => (release = r)));
    const env = envWithAi(run);
    const { res, pending } = postFeedback(env);
    const resp = await res;
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; data: { id: string } };
    expect(body.ok).toBe(true);
    // 此刻 AI 尚未返回：工单已创建但还没有草稿
    const before = await readFirstTicket(env);
    expect(before.id).toBe(body.data.id);
    expect(before.ai_draft).toBeUndefined();
    // AI 返回后 waitUntil 写回草稿
    release({ response: '{"category":"connect","draft":"先更新订阅再试。"}' });
    await Promise.all(pending);
    const after = await readFirstTicket(env);
    expect(after.ai_draft?.category).toBe("connect");
    expect(after.ai_draft?.draft).toContain("更新订阅");
  });

  it("AI 失败 → 工单仍正常创建，无 ai_draft", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const env = envWithAi(run);
    const { res, pending } = postFeedback(env);
    const resp = await res;
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { ok: boolean }).ok).toBe(true);
    await Promise.all(pending);
    const t = await readFirstTicket(env);
    expect(t.status).toBe("open");
    expect(t.ai_draft).toBeUndefined();
  });

  it("无 AI 绑定 → 工单正常创建，无 ai_draft", async () => {
    const { env } = makeEnv();
    const { res, pending } = postFeedback(env);
    const resp = await res;
    expect(resp.status).toBe(200);
    await Promise.all(pending);
    const t = await readFirstTicket(env);
    expect(t.ai_draft).toBeUndefined();
  });
});
