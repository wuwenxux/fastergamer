import { useEffect, useState } from "react";
import { api } from "../services/api";

interface ReferralInfo {
  code: string;
  link: string;
  invited_count: number;
  /** 已归因但尚未付费的人数 */
  pending_count: number;
  available_credits: number;
  discount_per_credit: number;
}

/**
 * 推广有礼卡片：登录后展示我的推广链接、已邀请人数与推广余额。
 * 未登录（无 session）时接口返回 401，卡片自动隐藏，不影响页面其他功能。
 */
export default function ReferralCard() {
  const [info, setInfo] = useState<ReferralInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .referralMe()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) return null;

  const balance = Math.max(0, info.available_credits) * info.discount_per_credit;
  const progress = Math.min(100, balance % 100 || (balance > 0 ? 100 : 0));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  return (
    <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-emerald-300">🎁 推广有礼</h3>
        <span className="text-xs text-slate-400">
          已付费 {info.invited_count} 人{info.pending_count > 0 ? ` · ${info.pending_count} 人待付费` : ""} · 推广余额 {balance} 元
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
      </div>
      <p className="text-xs text-slate-400">
        把链接发给朋友，对方通过链接注册并<strong className="text-emerald-300">成功付费</strong>即算成功邀请：每 1 人付费余额 +{info.discount_per_credit} 元，余额满 100 元（累计 10 人付费）——已开通套餐的自动<strong className="text-emerald-300">续期一年</strong>，还没开通的直接<strong className="text-emerald-300">送一年年付套餐</strong>（也可下单时抵扣，可叠加）。
      </p>
      <div className="flex gap-2">
        <input
          readOnly
          value={info.link}
          onFocus={(e) => e.target.select()}
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-mono text-slate-300 outline-none"
        />
        <button
          onClick={copy}
          className="shrink-0 rounded-lg bg-emerald-500 px-4 text-sm font-medium hover:bg-emerald-400 transition-colors"
        >
          {copied ? "✓ 已复制" : "复制链接"}
        </button>
      </div>
    </div>
  );
}
