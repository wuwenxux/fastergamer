/**
 * 流量重置（惩罚性续用）：用量清零、服务恢复，代价为有效期 -N 天。
 * 管理端售后（/api/admin/tokens/:id/reset-penalty）与用户自助
 * （/api/tokens/:id/reset-penalty）共用；调用方负责 pushAuthRefresh，
 * 客户通知邮件统一走本模块的 sendPenaltyNoticeEmail。
 */
import type { Token } from "../../../../shared/types";
import { saveToken } from "./kv";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { releaseNotification } from "./notify-dedup";
import type { Env } from "../types";

export const resetPenalty = async (
  env: Env,
  token: Token,
  daysPenalty = 30
): Promise<Token> => {
  const now = Date.now();
  // 以当前 Xray 累计值为新基准，用量从零重计（上限不变，剩余恢复满额）
  token.traffic_offset_bytes = Object.values(token.traffic_by_node ?? {}).reduce((s, v) => s + v, 0);
  token.traffic_used_gb = 0;
  delete token.rate_window_start;
  delete token.rate_window_bytes;
  delete token.traffic_exhausted_at;

  if (token.expires_at) {
    token.expires_at -= daysPenalty * 86_400_000;
    // 月度配额套餐每次结算按 base_expires_at 重算 expires_at，扣减需同步作用于基准，否则处罚被抹掉
    if (token.base_expires_at) {
      token.base_expires_at -= daysPenalty * 86_400_000;
    }
  }

  // 重置后重新评估状态：未撤销且仍在有效期则恢复 active
  if (token.status !== "revoked") {
    token.status = (token.expires_at ?? Infinity) > now ? "active" : "expired";
    if (!token.activated_at) token.activated_at = now;
  }
  // 流量类提醒重置后可重新触发：释放邮件认领键（幂等权威在 ShareGuardDO，见 lib/notify-dedup.ts）。
  // traffic_80 提醒已下线，存量 notify_log 旧键不再清理（随 token 90 天清理自然消失）；
  // traffic_spike 保留——它是暴增处置的业务状态（24h 处置窗口），不是纯邮件幂等
  if (token.notify_log) {
    delete token.notify_log.traffic_spike;
  }
  await releaseNotification(env, `exhausted:${token.id}`);

  await saveToken(env, token);
  return token;
};

/** 重置结果通知客户（两个入口文案一致，仅提前天数不同）；发送失败只记日志，不影响主流程 */
export const sendPenaltyNoticeEmail = async (
  env: Env,
  token: Token,
  daysPenalty: number
): Promise<void> => {
  if (!shouldSendEmail(token.contact)) return;
  const res = await sendMail(
    env,
    token.contact,
    "【FrogLeap】你的流量额度已重置",
    `<p>你好，你的 Token（<strong>${token.id}</strong>）流量已重置为满额 <strong>${token.traffic_limit_gb} GB</strong>，服务已恢复。</p>
     <p>本次重置后有效期至 <strong>${token.expires_at ? new Date(token.expires_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未知"}</strong>（提前 ${daysPenalty} 天）。</p>
     <p>如流量消耗异常，请登录管理页检查设备列表。</p>`,
    `你的 Token（${token.id}）流量已重置为满额 ${token.traffic_limit_gb} GB，服务已恢复。\n有效期至 ${token.expires_at ? new Date(token.expires_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未知"}（提前 ${daysPenalty} 天）。\n如流量消耗异常请检查设备列表。`,
    { kind: "account" }
  );
  if (!res.ok) console.error(`[reset-penalty] mail failed ${token.id}: ${res.error}`);
};
