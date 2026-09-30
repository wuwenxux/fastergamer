import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../index";
import { KV, type Plan, type Token } from "../../../../shared/types";
import type { Env } from "../types";

/**
 * 月额度硬顶全链路（替代旧「静默预支」）：
 * - 授权快照：当月触顶的 token 被摘除；账期翻转（未回写）自动恢复；重置后恢复
 * - POST /api/tokens/:id/reset-month：触顶才可重置（用量清零、months_borrowed+1、有效期 -30 天）；
 *   未触顶幂等返回 changed=false 不扣期；非月度套餐 400；非本人 401
 * - 触顶邮件 sendMonthCapEmail：幂等键 month_cap:<月>，同月只发一次
 * - subscription-userinfo：月度套餐 total/used 走月口径
 * KV 用内存假实现；邮件 mock 掉。
 */

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});
import { sendMail } from "../lib/email-aliyun";
import { computeAuthSnapshot } from "../lib/authsnapshot";
import { sendMonthCapEmail } from "../lib/risk-notify";
import { currentMonthKey } from "../lib/nodes";
import { collectCtx, makeEnv } from "./helpers";

const GB = 1024 ** 3;
const NOW = Date.now();
const MK = currentMonthKey();
const EMAIL = "user@example.com";

const MONTHLY_PLAN: Plan = {
  id: "plan_yearly_std",
  name: "年付",
  duration_days: 365,
  price_cny: 120,
  description: "",
  monthly_quota_gb: 20,
  traffic_limit_gb: 260,
  max_devices: 3,
} as Plan;

const makeToken = (over: Partial<Token> = {}): Token =>
  ({
    id: "tk_cap01",
    uuid: "uuid-cap-01",
    plan_id: "plan_yearly_std",
    status: "active",
    contact: EMAIL,
    traffic_limit_gb: 260,
    traffic_used_gb: 30,
    purchased_at: NOW - 100 * 86_400_000,
    expires_at: NOW + 265 * 86_400_000,
    month_key: MK,
    month_used_bytes: 21 * GB, // 默认已触顶（20 GB 配额）
    ...over,
  }) as Token;

const seedToken = (env: Env, token: Token) => {
  void env.TOKENS.put(KV.TOKEN + token.uuid, JSON.stringify(token));
  void env.TOKENS.put(KV.TOKEN_BY_ID + token.id, JSON.stringify({ uuid: token.uuid }));
};

const seedSession = (env: Env, sess = "sess-1") =>
  env.TOKENS.put(KV.SESSION + sess, JSON.stringify({ email: EMAIL, created_at: NOW }));

const readToken = async (env: Env, uuid: string): Promise<Token> =>
  JSON.parse((await env.TOKENS.get(KV.TOKEN + uuid))!) as Token;

beforeEach(() => vi.clearAllMocks());

describe("授权快照：月额度硬顶摘除", () => {
  const envWith = (token: Token) => {
    const { env } = makeEnv({ plans: [MONTHLY_PLAN] });
    seedToken(env, token);
    return env;
  };

  it("当月触顶 → 从快照摘除", async () => {
    const snap = await computeAuthSnapshot(envWith(makeToken()));
    expect(snap.uuids).not.toContain("uuid-cap-01");
  });

  it("未触顶 → 正常在名单内", async () => {
    const snap = await computeAuthSnapshot(envWith(makeToken({ month_used_bytes: 5 * GB })));
    expect(snap.uuids).toContain("uuid-cap-01");
  });

  it("账期翻转（上月触顶未回写）→ 自动恢复，无需回写", async () => {
    const snap = await computeAuthSnapshot(envWith(makeToken({ month_key: "2020-01" })));
    expect(snap.uuids).toContain("uuid-cap-01");
  });

  it("非月度套餐（无配额）→ 不受月口径影响", async () => {
    const { env } = makeEnv({
      plans: [{ ...MONTHLY_PLAN, id: "plan_pack_5g", monthly_quota_gb: undefined }],
    });
    seedToken(env, makeToken({ plan_id: "plan_pack_5g" }));
    const snap = await computeAuthSnapshot(env);
    expect(snap.uuids).toContain("uuid-cap-01");
  });
});

describe("POST /api/tokens/:id/reset-month", () => {
  let ipSeq = 0;
  const post = (env: Env, id: string, sess?: string) =>
    worker.fetch(
      new Request(`https://api.test/api/tokens/${id}/reset-month`, {
        method: "POST",
        headers: {
          "cf-connecting-ip": `10.10.0.${++ipSeq}`,
          ...(sess ? { authorization: `Bearer ${sess}` } : {}),
        },
      }),
      env,
      collectCtx().ctx
    );

  it("触顶重置成功：用量清零、months_borrowed+1、有效期 -30 天、month_cap 幂等键清零", async () => {
    const { env } = makeEnv({ plans: [MONTHLY_PLAN] });
    const token = makeToken({ notify_log: { [`month_cap:${MK}`]: NOW } });
    seedToken(env, token);
    await seedSession(env);
    const res = await post(env, token.id, "sess-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { changed: boolean; months_borrowed: number; expires_at: number; month_used_bytes: number };
    };
    expect(body.data.changed).toBe(true);
    expect(body.data.months_borrowed).toBe(1);
    expect(body.data.month_used_bytes).toBe(0);
    expect(body.data.expires_at).toBe(token.expires_at! - 30 * 86_400_000);
    const saved = await readToken(env, token.uuid);
    expect(saved.month_used_bytes).toBe(0);
    expect(saved.month_key).toBe(MK); // 保持当前自然月
    expect(saved.months_borrowed).toBe(1);
    expect(saved.notify_log?.[`month_cap:${MK}`]).toBeFalsy(); // 清零后同月再触顶可再发邮件
    // 重置后快照恢复授权
    const snap = await computeAuthSnapshot(env);
    expect(snap.uuids).toContain(token.uuid);
  });

  it("幂等：重置后未再触顶，重复调用 changed=false 不重复扣期", async () => {
    const { env } = makeEnv({ plans: [MONTHLY_PLAN] });
    const token = makeToken();
    seedToken(env, token);
    await seedSession(env);
    await post(env, token.id, "sess-1");
    const res = await post(env, token.id, "sess-1");
    const body = (await res.json()) as { ok: boolean; data: { changed: boolean; months_borrowed: number } };
    expect(body.data.changed).toBe(false);
    expect(body.data.months_borrowed).toBe(1); // 只扣了一次
    const saved = await readToken(env, token.uuid);
    expect(saved.expires_at).toBe(token.expires_at! - 30 * 86_400_000);
  });

  it("未触顶调用 → changed=false，不动任何字段", async () => {
    const { env } = makeEnv({ plans: [MONTHLY_PLAN] });
    const token = makeToken({ month_used_bytes: 5 * GB });
    seedToken(env, token);
    await seedSession(env);
    const res = await post(env, token.id, "sess-1");
    const body = (await res.json()) as { data: { changed: boolean } };
    expect(body.data.changed).toBe(false);
    const saved = await readToken(env, token.uuid);
    expect(saved.month_used_bytes).toBe(5 * GB);
    expect(saved.months_borrowed).toBeUndefined();
    expect(saved.expires_at).toBe(token.expires_at);
  });

  it("非月度套餐 → 400", async () => {
    const { env } = makeEnv({
      plans: [{ ...MONTHLY_PLAN, id: "plan_monthly", monthly_quota_gb: undefined }],
    });
    const token = makeToken({ plan_id: "plan_monthly" });
    seedToken(env, token);
    await seedSession(env);
    const res = await post(env, token.id, "sess-1");
    expect(res.status).toBe(400);
  });

  it("未登录 → 401", async () => {
    const { env } = makeEnv({ plans: [MONTHLY_PLAN] });
    seedToken(env, makeToken());
    const res = await post(env, "tk_cap01");
    expect(res.status).toBe(401);
  });
});

describe("sendMonthCapEmail 触顶通知", () => {
  const sendMailMock = vi.mocked(sendMail);

  it("触顶发信（含两个恢复选项），同月幂等只发一次", async () => {
    const { env } = makeEnv();
    const token = makeToken();
    expect(await sendMonthCapEmail(env, token, 20)).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(String(sendMailMock.mock.calls[0][2])).toContain("本月额度已用完");
    expect(String(sendMailMock.mock.calls[0][3])).toContain("提前重置");
    expect(String(sendMailMock.mock.calls[0][3])).toContain("次月 1 日");
    // 同月第二次（幂等键已记账）不发
    expect(await sendMonthCapEmail(env, token, 20)).toBe(false);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    // 幂等键清零后（reset-month）可再发
    token.notify_log![`month_cap:${MK}`] = 0;
    expect(await sendMonthCapEmail(env, token, 20)).toBe(true);
  });

  it("无邮箱不发", async () => {
    const { env } = makeEnv();
    expect(await sendMonthCapEmail(env, makeToken({ contact: undefined }), 20)).toBe(false);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
