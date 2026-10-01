/**
 * 通知邮件幂等认领助手：全站一次性/节流通知的唯一权威是 ShareGuardDO 的
 * 持久化认领存储（/notify-claim，DO 单线程串行 + storage 持久化，天然原子）。
 *
 * 为什么不用 token.notify_log：并发请求拿同一请求开始时的旧快照都通过幂等检查，
 * 且 KV 边缘缓存旧快照 + 整写回会抹掉刚写入的标记（生产事故：trial_convert 一天发 9 次）。
 *
 * 使用方式：绝大多数发送方不用直接调这里——sendMail 时传 opts.dedup={key, ttlMs?}，
 * 队列消费者（handleMailBatch）在真正发送前认领，未认领成功直接丢弃（ack）。
 * 需要「发不发」精确反馈的少数场景（如灾备群发的 sent/skipped 计数）可在发送前
 * 同步调 claimNotification 自行裁决。
 *
 * fail-open 约定：无 SHARE_GUARD 绑定（本地 dev/测试）或 DO 调用异常时返回 true
 * （宁可重复发也不丢邮件——通知重复只是打扰，丢失可能影响续费/安全处置）。
 */
import type { Env } from "../types";

const claimStub = (env: Env) => env.SHARE_GUARD?.get(env.SHARE_GUARD.idFromName("global"));

/** 认领一个通知键；ttlMs 供节流类键到期重领（一次性键不传）。返回 true = 本次可以发 */
export const claimNotification = async (env: Env, key: string, ttlMs?: number): Promise<boolean> => {
  const stub = claimStub(env);
  if (!stub) return true; // 无绑定（本地 dev/测试）：fail-open 放行
  try {
    const res = await stub.fetch("https://share-guard.do/notify-claim", {
      method: "POST",
      body: JSON.stringify({ key, ...(ttlMs !== undefined ? { ttlMs } : {}) }),
    });
    const json = (await res.json()) as { claimed?: boolean };
    return json.claimed === true;
  } catch (e) {
    console.error(`[notify-dedup] claim failed key=${key}: ${(e as Error).message}`);
    return true; // DO 异常：fail-open 放行
  }
};

/** 释放认领键（重置类操作让同类通知可再发）；无绑定 no-op，异常吞掉只记日志 */
export const releaseNotification = async (env: Env, key: string): Promise<void> => {
  const stub = claimStub(env);
  if (!stub) return;
  try {
    await stub.fetch("https://share-guard.do/notify-release", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  } catch (e) {
    console.error(`[notify-dedup] release failed key=${key}: ${(e as Error).message}`);
  }
};
