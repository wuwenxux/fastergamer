import type { RefObject } from "react";
import type { Plan } from "../../../shared/types";
import Turnstile, { type TurnstileHandle, type TurnstileState } from "./Turnstile";

/**
 * 下单弹窗：填写联系方式后创建订单。
 * 过渡期人工收款：下单落 pending 订单并展示收款码，用户转账备注订单号后点「我已支付」，
 * 由客服确认收款后置 paid 开通；在线支付通道接入后恢复收银台。
 */
export default function PaymentModal({
  plan,
  contact,
  onContactChange,
  onConfirm,
  onClose,
  processing,
  turnstileRef,
  turnstileState,
  onTurnstileState,
}: {
  plan: Plan;
  contact: string;
  onContactChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  processing: boolean;
  /** 人机验证：状态与 ref 由父组件持有（提交时要取 token、失败要 reset） */
  turnstileRef: RefObject<TurnstileHandle>;
  turnstileState: TurnstileState;
  onTurnstileState: (state: TurnstileState) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">填写联系方式</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-200 text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="rounded-xl bg-slate-800/60 p-4 space-y-1">
          <div className="flex justify-between text-sm">
            <span className="text-slate-400">{plan.name}</span>
            <span>{plan.duration_days} 天</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-slate-400 text-sm">应付金额</span>
            <span className="text-2xl font-bold text-sky-400">¥{plan.price_cny}</span>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-sm text-slate-400">你的常用邮箱（接收 token 与售后联系的唯一方式）</label>
          <input
            type="email"
            value={contact}
            onChange={(e) => onContactChange(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <p className="text-xs text-amber-400">
            确认到账后 token 会发送到该邮箱，丢失后也凭此邮箱找回，务必真实可用。
          </p>
        </div>

        <Turnstile ref={turnstileRef} onStateChange={onTurnstileState} />

        <button
          onClick={onConfirm}
          disabled={
            processing ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim()) ||
            (turnstileState.enabled && !turnstileState.token)
          }
          className="w-full rounded-lg bg-sky-500 py-3 font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
        >
          {processing ? "处理中…" : "提交订单"}
        </button>

        <p className="text-xs text-slate-500 text-center">
          提交订单后扫码付款，付款后点「我已支付」，客服确认收款后自动开通，token 自动发送到你的邮箱
        </p>
      </div>
    </div>
  );
}
