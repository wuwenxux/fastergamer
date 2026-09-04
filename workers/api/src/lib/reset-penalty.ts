/**
 * 流量重置（惩罚性续用）：用量清零、服务恢复，代价为有效期 -N 天。
 * 管理端售后（/api/admin/tokens/:id/reset-penalty）与用户自助
 * （/api/tokens/:id/reset-penalty）共用；调用方负责 pushAuthRefresh 与邮件通知。
 */
import type { Token } from "../../../../shared/types";
import { saveToken } from "./kv";
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
  // 流量类提醒重置后可重新触发
  if (token.notify_log) {
    delete token.notify_log.traffic_80;
    delete token.notify_log.exhausted;
    delete token.notify_log.traffic_spike;
  }

  await saveToken(env, token);
  return token;
};
