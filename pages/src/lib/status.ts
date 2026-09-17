import type { TokenStatus } from "../../../shared/types";

/** token 状态的中文展示名 */
export const STATUS_LABEL: Record<TokenStatus, string> = {
  paid: "待激活",
  active: "使用中",
  expired: "已过期",
  revoked: "已撤销",
};

/** token 状态徽标的 Tailwind 配色 */
export const STATUS_COLOR: Record<TokenStatus, string> = {
  paid: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  active: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  expired: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  revoked: "bg-slate-600/30 text-slate-400 border-slate-500/40",
};
