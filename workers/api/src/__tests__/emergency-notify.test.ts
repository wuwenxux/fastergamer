import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * 灾备群发（lib/emergency-notify.ts + POST /api/admin/emergency/backup-sub）：
 * - 收件人：active 未过期且有有效邮箱（试用也发）；未激活/过期/吊销/无邮箱跳过
 * - 邮件含该用户自己的备用订阅链接（uluw.kdns.fr/api/sub?uuid=<主 uuid>），service 桶
 * - 幂等：notify_log.emergency_sub:<UTC日期>，同日重复触发不重发
 * 邮件 mock 掉；KV 用内存假实现。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});
import { sendMail } from "../lib/email-aliyun";
import { collectCtx, makeEnv } from "./helpers";

const ADMIN_KEY = "test-admin-key";
const sendMailMock = vi.mocked(sendMail);

const NOW = Date.now();

const makeToken = (over: Partial<Token> = {}): Token =>
  ({
    id: `tk_${Math.random().toString(36).slice(2, 8)}`,
    uuid: crypto.randomUUID(),
    plan_id: "plan_monthly",
    status: "active",
    contact: "user@example.com",
    purchased_at: NOW - 86_400_000,
    expires_at: NOW + 30 * 86_400_000,
    ...over,
  }) as Token;

const seedTokens = (env: Env, tokens: Token[]) => {
  for (const t of tokens) void env.TOKENS.put(KV.TOKEN + t.uuid, JSON.stringify(t));
};

const callApi = async (env: Env) => {
  const { pending, ctx } = collectCtx();
  const res = await worker.fetch(
    new Request("https://api.test/api/admin/emergency/backup-sub", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
    }),
    env,
    ctx
  );
  await Promise.all(pending);
  return res;
};

/** 发出去的邮件 [{to, subject, html, text, kind}] */
const mails = () =>
  sendMailMock.mock.calls.map((c) => ({ to: c[1], subject: c[2], html: c[3], text: c[4], kind: c[5]?.kind }));

beforeEach(() => vi.clearAllMocks());

describe("灾备群发备用订阅地址", () => {
  it("active 未过期有邮箱的用户收到邮件，含本人备用订阅链接，service 桶", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const t = makeToken();
    seedTokens(env, [t]);
    const res = await callApi(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { sent: number; skipped: number } };
    expect(body.data).toEqual({ sent: 1, skipped: 0 });

    expect(mails()).toHaveLength(1);
    const m = mails()[0];
    expect(m.to).toBe("user@example.com");
    expect(m.kind).toBe("service");
    expect(m.subject).toContain("订阅地址已更换");
    const backupUrl = `https://uluw.kdns.fr/api/sub?uuid=${t.uuid}`;
    expect(m.html).toContain(backupUrl);
    expect(m.text).toContain(backupUrl);
    // 操作步骤与「原链接恢复后仍可用」说明
    expect(m.text).toContain("更新订阅");
    expect(m.text).toContain("仍可继续使用");
  });

  it("收件人筛选：未激活(paid)/过期/吊销/无邮箱/非法邮箱跳过；试用 token 也发", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const trial = makeToken({ plan_id: "plan_trial", contact: "trial@example.com" });
    seedTokens(env, [
      trial,
      makeToken({ status: "paid", contact: "paid@example.com" }), // 未激活
      makeToken({ expires_at: NOW - 1000, contact: "expired@example.com" }),
      makeToken({ status: "revoked", contact: "revoked@example.com" }),
      makeToken({ contact: undefined }),
      makeToken({ contact: "not-an-email" }),
    ]);
    const res = await callApi(env);
    const body = (await res.json()) as { ok: boolean; data: { sent: number; skipped: number } };
    expect(body.data).toEqual({ sent: 1, skipped: 5 });
    expect(mails().map((m) => m.to)).toEqual(["trial@example.com"]);
  });

  it("幂等：同一天重复触发不重发（返回 skipped），写回 notify_log 键", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const t = makeToken();
    seedTokens(env, [t]);

    const first = (await (await callApi(env)).json()) as { data: { sent: number; skipped: number } };
    expect(first.data).toEqual({ sent: 1, skipped: 0 });
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const stored = JSON.parse((await env.TOKENS.get(KV.TOKEN + t.uuid))!) as Token;
    expect(stored.notify_log?.[`emergency_sub:${day}`]).toBeGreaterThan(0);

    const second = (await (await callApi(env)).json()) as { data: { sent: number; skipped: number } };
    expect(second.data).toEqual({ sent: 0, skipped: 1 });
    expect(sendMailMock).toHaveBeenCalledTimes(1); // 没有第二封
  });

  it("无 x-admin-key → 401", async () => {
    const { env } = makeEnv({ adminKey: ADMIN_KEY });
    const res = await worker.fetch(
      new Request("https://api.test/api/admin/emergency/backup-sub", { method: "POST" }),
      env,
      collectCtx().ctx
    );
    expect(res.status).toBe(401);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
