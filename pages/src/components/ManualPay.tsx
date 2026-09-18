import { useRef, useState } from "react";
import type { Plan } from "../../../shared/types";
import Turnstile, { type TurnstileHandle, type TurnstileState } from "./Turnstile";
import { api } from "../services/api";
import { copyText } from "../utils/clipboard";

/**
 * 人工收款码支付区（在线支付通道断开期间的过渡方案）：
 * 商品图（套餐名/流量/有效期）+ 站长支付宝收款码，用户转账备注订单号后点「我已支付」
 * 通知客服，客服确认收款后订单置 paid，token 自动发到买家邮箱。
 * 收款码图片由站长投放到 pages/public/pay/；加载失败时给出邮件联系兜底。
 */
export default function ManualPay({
  orderId,
  payableCny,
  plan,
}: {
  orderId: string;
  payableCny: number;
  /** 新购订单传套餐；升级补差价订单不传，商品图显示通用升级样式 */
  plan?: Plan;
}) {
  const [copied, setCopied] = useState(false);
  // notified = 本次点击成功通知客服；duplicate = 6h 内重复点击被幂等去重
  const [notifyState, setNotifyState] = useState<"idle" | "sending" | "notified" | "duplicate">("idle");
  const [notifyError, setNotifyError] = useState("");
  // 人机验证：未启用时不拦截；启用后需先过验证拿到一次性 token
  const [ts, setTs] = useState<TurnstileState>({ enabled: false });
  const tsRef = useRef<TurnstileHandle>(null);

  const copyOrderId = async () => {
    if (await copyText(orderId)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      window.prompt("自动复制失败，请长按全选手动复制订单号：", orderId);
    }
  };

  const notifyPaid = async () => {
    if (ts.enabled && !ts.token) return; // 已启用但验证未通过，按钮已禁用，这里兜底
    setNotifyState("sending");
    setNotifyError("");
    try {
      const res = await api.notifyPaid(orderId, ts.token);
      setNotifyState(res.notified ? "notified" : "duplicate");
    } catch (e) {
      setNotifyState("idle");
      setNotifyError((e as Error).message);
      tsRef.current?.reset(); // token 一次性且 300s 过期，失败后重置重新获取
    }
  };

  return (
    <div className="space-y-4">
      <PayProductVisual plan={plan} />

      <div className="flex justify-between items-baseline border-t border-slate-700 pt-4">
        <span className="text-slate-400">应付金额</span>
        <span className="text-3xl font-bold text-sky-400">¥{payableCny}</span>
      </div>

      <div className="mx-auto max-w-52">
        <PayQr src="/pay/alipay-qr.jpg" label="支付宝" />
      </div>

      <div className="flex justify-between items-center">
        <span className="text-slate-400 text-[15px] sm:text-sm">订单号</span>
        <button onClick={copyOrderId} className="font-mono text-sky-400 hover:text-sky-300">
          {orderId} {copied ? "✓ 已复制" : "📋"}
        </button>
      </div>

      <p className="text-sm sm:text-xs text-slate-400 text-center">
        扫码转账时请务必备注订单号；确认收款后 token 自动发到你的邮箱。
      </p>

      {notifyState === "notified" ? (
        <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/40 py-3 text-center text-[15px] sm:text-sm text-emerald-300">
          已通知客服，将在确认收款后开通
        </div>
      ) : (
        <>
          <Turnstile ref={tsRef} onStateChange={setTs} />
          <button
            onClick={notifyPaid}
            disabled={notifyState === "sending" || (ts.enabled && !ts.token)}
            className="w-full rounded-lg bg-sky-500 py-3 font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
          >
            {notifyState === "sending" ? "通知中…" : "我已支付"}
          </button>
        </>
      )}
      {notifyState === "duplicate" && (
        <p className="text-sm sm:text-xs text-amber-400 text-center">已通知过客服，无需重复点击</p>
      )}
      {notifyError && <p className="text-sm sm:text-xs text-rose-400 text-center">{notifyError}</p>}
    </div>
  );
}

/**
 * 支付页商品图（内联 SVG，深色科技风）：套餐名/流量/有效期是动态的，
 * 静态图片做不到按套餐变化；升级订单无套餐信息时显示通用升级样式。
 */
function PayProductVisual({ plan }: { plan?: Plan }) {
  const name = plan?.name ?? "套餐升级 · 补差价";
  // 右侧文案区只有 170px 宽：套餐名超过 6 个字（如升级兜底文案）自动缩字号防溢出
  const nameSize = name.length > 6 ? 14 : 20;
  const chips = plan
    ? [
        (plan.traffic_limit_gb ?? 0) > 0 ? `${plan.traffic_limit_gb} GB` : "不限量",
        `${plan.duration_days} 天`,
      ]
    : ["原设备不变", "立即生效"];
  return (
    <svg
      viewBox="0 0 320 180"
      className="w-full rounded-xl"
      role="img"
      aria-label={name}
      font-family="system-ui, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    >
      <defs>
        <linearGradient id="ppv-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0b1220" />
          <stop offset="1" stopColor="#0f172a" />
        </linearGradient>
        <radialGradient id="ppv-glow" cx="0.28" cy="0.45" r="0.55">
          <stop offset="0" stopColor="#0ea5e9" stopOpacity="0.35" />
          <stop offset="1" stopColor="#0ea5e9" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ppv-bolt" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#818cf8" />
        </linearGradient>
      </defs>

      <rect width="320" height="180" rx="14" fill="url(#ppv-bg)" />
      <rect width="320" height="180" rx="14" fill="url(#ppv-glow)" />

      {/* 网格线装饰 */}
      <g stroke="#1e293b" strokeWidth="1">
        <line x1="0" y1="45" x2="320" y2="45" />
        <line x1="0" y1="90" x2="320" y2="90" />
        <line x1="0" y1="135" x2="320" y2="135" />
        <line x1="80" y1="0" x2="80" y2="180" />
        <line x1="160" y1="0" x2="160" y2="180" />
        <line x1="240" y1="0" x2="240" y2="180" />
      </g>

      {/* 速度线 */}
      <g stroke="#38bdf8" strokeWidth="3" strokeLinecap="round" opacity="0.7">
        <line x1="30" y1="118" x2="58" y2="118" />
        <line x1="22" y1="130" x2="58" y2="130" />
        <line x1="30" y1="142" x2="50" y2="142" />
      </g>

      {/* 发光圆环 + 闪电 */}
      <circle cx="90" cy="86" r="34" fill="none" stroke="#0ea5e9" strokeWidth="2" opacity="0.9" />
      <circle cx="90" cy="86" r="34" fill="#0ea5e9" opacity="0.08" />
      <path d="M 98 62 L 76 92 L 88 92 L 82 110 L 104 80 L 92 80 Z" fill="url(#ppv-bolt)" />

      {/* 文案 */}
      <text x="150" y="72" fill="#e2e8f0" fontSize={nameSize} fontWeight="700">
        {name}
      </text>
      <text x="150" y="94" fill="#64748b" fontSize="10">
        GameBoost · 游戏加速
      </text>

      {/* 规格 chips */}
      <g>
        {chips.map((chip, i) => (
          <g key={chip}>
            <rect
              x={150 + i * 80}
              y="108"
              width="72"
              height="24"
              rx="12"
              fill="#082f49"
              stroke="#0ea5e9"
              strokeOpacity="0.5"
            />
            <text x={150 + i * 80 + 36} y="124" fill="#7dd3fc" fontSize="12" textAnchor="middle">
              {chip}
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}

/** 单个渠道的收款码；图片缺失时隐藏并提示邮件联系，避免裂图 */
function PayQr({ src, label }: { src: string; label: string }) {  const [broken, setBroken] = useState(false);
  return (
    <div className="flex-1 space-y-2 text-center">
      {broken ? (
        <div className="flex aspect-square items-center justify-center rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm sm:text-xs text-slate-500">
          收款码维护中，请邮件联系 support@fastergamer.cn
        </div>
      ) : (
        <img
          src={src}
          alt={`${label}收款码`}
          onError={() => setBroken(true)}
          className="w-full rounded-lg bg-white p-2"
        />
      )}
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
}
