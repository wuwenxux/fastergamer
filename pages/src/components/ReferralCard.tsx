import { useEffect, useState } from "react";
import { api } from "../services/api";
import { copyText } from "../utils/clipboard";

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
 * 推广有礼横幅：海报式大数字 + 10 格点亮进度，少文字。
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
  // 10 格进度：每 10 元点亮一格，满格 = 免费一年
  const litSlots = Math.min(10, Math.floor(balance / info.discount_per_credit));

  const copy = async () => {
    if (await copyText(info.link)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      window.prompt("自动复制失败，请长按全选手动复制邀请链接：", info.link);
    }
  };

  return (
    <div className="overflow-hidden rounded-3xl border border-emerald-500/40">
      {/* 海报头：渐变底 + 大数字 */}
      <div className="bg-gradient-to-br from-emerald-500/25 via-slate-900 to-slate-950 px-6 pt-7 pb-6 text-center space-y-2">
        <div className="text-sm font-medium text-emerald-300 tracking-widest">🎁 推广余额</div>
        <div className="text-6xl font-black text-emerald-300">¥{balance}</div>
        <div className="text-sm text-slate-300">
          每邀请 1 人付费 <span className="text-emerald-300 font-semibold">+¥{info.discount_per_credit}</span>
          ，攒满 ¥100 <span className="text-emerald-300 font-semibold">免费用一年</span>
        </div>
        {(info.invited_count > 0 || info.pending_count > 0) && (
          <div className="text-xs text-slate-500">
            已付费 {info.invited_count} 人{info.pending_count > 0 ? ` · ${info.pending_count} 人待付费` : ""}
          </div>
        )}
      </div>

      {/* 10 格点亮进度（图示替代文字） */}
      <div className="bg-slate-950/60 border-t border-slate-800 px-6 py-5 space-y-4">
        <div className="flex justify-between gap-1.5">
          {Array.from({ length: 10 }, (_, i) => (
            <div
              key={i}
              className={`h-3 flex-1 rounded-full transition-colors ${
                i < litSlots ? "bg-emerald-400" : "bg-slate-800"
              }`}
            />
          ))}
        </div>

        {/* 复制链接：主行动按钮 */}
        <button
          onClick={copy}
          className="w-full rounded-xl bg-emerald-500 py-3 text-lg font-bold text-slate-950 hover:bg-emerald-400 transition-colors"
        >
          {copied ? "✓ 链接已复制，去发给朋友吧" : "📋 一键复制我的邀请链接"}
        </button>
        <p className="text-center text-xs text-slate-500">
          朋友通过你的链接注册并付费即算邀请成功，余额不满 ¥100 也能在下单时直接抵扣
        </p>
      </div>
    </div>
  );
}
