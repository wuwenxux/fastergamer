import type { Plan } from "../../../shared/types";

/**
 * 下单弹窗：填写联系方式后创建待支付订单。
 * 个人收款码过渡期间，订单确认页展示收款码，人工确认到账后发放 token。
 * 将来接入真实网关时，这里替换为跳转支付网关 / 展示网关二维码。
 */
export default function PaymentModal({
  plan,
  contact,
  onContactChange,
  onConfirm,
  onClose,
  processing,
}: {
  plan: Plan;
  contact: string;
  onContactChange: (value: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  processing: boolean;
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

        <button
          onClick={onConfirm}
          disabled={processing || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim())}
          className="w-full rounded-lg bg-sky-500 py-3 font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
        >
          {processing ? "处理中…" : "提交订单"}
        </button>

        <p className="text-xs text-slate-500 text-center">
          提交后展示收款码，确认到账后 token 将发送到你的邮箱
        </p>
      </div>
    </div>
  );
}
