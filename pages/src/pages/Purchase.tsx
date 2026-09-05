import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import type { Order, Plan } from "../../../shared/types";
import PaymentModal from "../components/PaymentModal";
import { api } from "../services/api";
import { copyText } from "../utils/clipboard";

type Step = "summary" | "paying" | "result";

export default function Purchase() {
  const [params] = useSearchParams();
  const planId = params.get("plan") ?? "";

  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>("summary");
  const [processing, setProcessing] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [contact, setContact] = useState(() => localStorage.getItem("fg_contact") ?? "");

  // 根据 plan 参数加载套餐信息
  useEffect(() => {
    api
      .plans()
      .then((plans) => {
        const found = plans.find((p) => p.id === planId);
        if (!found) setError("未找到该套餐，请返回选择");
        setPlan(found ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [planId]);

  const submitOrder = async () => {
    if (!plan) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim())) {
      setError("请填写真实可用的邮箱，token 和售后都通过邮件联系你");
      return;
    }
    setProcessing(true);
    try {
      // 带上 localStorage 里的推广码（首页 ?ref= 捕获），未领试用直接下单也能归因
      const ref = localStorage.getItem("fg_ref") ?? undefined;
      const res = await api.createOrder(plan.id, contact.trim(), ref);
      localStorage.setItem("fg_contact", contact.trim()); // 记住邮箱，下次下单免填
      setOrder(res.order);
      setStep("result");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProcessing(false);
    }
  };

  if (step === "result" && order && plan) {
    return <PaymentResult order={order} plan={plan} />;
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">确认订单</h2>

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      {plan && (
        <>
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
            <div className="flex justify-between">
              <span className="text-slate-400">套餐</span>
              <span className="font-medium">{plan.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">有效期</span>
              <span>{plan.duration_days} 天</span>
            </div>
            {typeof plan.traffic_limit_gb === "number" && (
              <div className="flex justify-between">
                <span className="text-slate-400">总流量</span>
                <span>{plan.traffic_limit_gb > 0 ? `${plan.traffic_limit_gb} GB` : "不限量（公平使用）"}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline border-t border-slate-700 pt-4">
              <span className="text-slate-400">应付</span>
              <span className="text-3xl font-bold text-sky-400">¥{plan.price_cny}</span>
            </div>
          </div>

          <button
            onClick={() => setStep("paying")}
            className="w-full rounded-lg bg-sky-500 py-3 font-medium hover:bg-sky-400 transition-colors"
          >
            去支付
          </button>
        </>
      )}

      {step === "paying" && plan && (
        <PaymentModal
          plan={plan}
          contact={contact}
          onContactChange={setContact}
          processing={processing}
          onConfirm={submitOrder}
          onClose={() => setStep("summary")}
        />
      )}
    </div>
  );
}

/** 下单后的支付页：有二维码则扫码支付；支付通道维护期（无二维码）展示保留提示，轮询 10 分钟后停止 */
function PaymentResult({ order, plan }: { order: Order; plan: Plan }) {
  const [copied, setCopied] = useState(false);
  // 推广减免后实付 0 元的订单在创建时已直接发货
  const [paid, setPaid] = useState(order.status === "paid");
  // 通道维护期订单不会变 paid，轮询 10 分钟后停止，避免无限空转
  const [pollStopped, setPollStopped] = useState(false);
  const dynamicQr = order.epay_qr_code;
  const payable = order.payable_cny ?? plan.price_cny;
  const discount = order.discount_cny ?? 0;

  // 轮询订单状态，支付成功（支付平台回调发货）后自动跳转提示
  useEffect(() => {
    if (paid || pollStopped) return;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60_000) {
        setPollStopped(true);
        clearInterval(timer);
        return;
      }
      try {
        const s = await api.orderStatus(order.id);
        if (s.status === "paid") {
          setPaid(true);
          clearInterval(timer);
        }
      } catch {
        /* 网络抖动忽略，下一轮再试 */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [paid, pollStopped, order.id]);

  const copyOrderId = async () => {
    if (await copyText(order.id)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      window.prompt("自动复制失败，请长按全选手动复制订单号：", order.id);
    }
  };

  if (paid) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-8 text-center space-y-3">
          <div className="text-4xl">✅</div>
          <h2 className="text-xl font-semibold text-emerald-300">支付成功</h2>
          <p className="text-sm text-slate-300">
            Token 已发放并发送到你的邮箱，也可在
            <Link to="/tokens" className="text-sky-400 hover:underline"> 我的 Token </Link>
            页输入邮箱一键登录查看。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="rounded-2xl border border-sky-500/50 bg-sky-500/10 p-6 text-center space-y-2">
        <h2 className="text-xl font-semibold">订单已创建{dynamicQr ? "，请扫码支付" : ""}</h2>
        {dynamicQr && (
          <p className="text-sm text-slate-300">
            打开<strong className="text-sky-300">支付宝</strong>扫码支付，支付成功自动到账。
          </p>
        )}
      </div>

      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-slate-400 text-sm">订单号</span>
          <button
            onClick={copyOrderId}
            className="font-mono text-sky-400 hover:text-sky-300"
          >
            {order.id} {copied ? "✓ 已复制" : "📋"}
          </button>
        </div>
        <div className="flex justify-between items-baseline border-t border-slate-700 pt-4">
          <span className="text-slate-400">{plan.name}</span>
          <span className="text-3xl font-bold text-sky-400">¥{payable}</span>
        </div>
        {discount > 0 && (
          <p className="text-xs text-emerald-400 text-right">
            推广减免 -¥{discount}（原价 ¥{plan.price_cny}）
          </p>
        )}

        <div className="pt-2 max-w-xs mx-auto">
          {dynamicQr ? (
            <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-center space-y-2">
              <div className="rounded-lg bg-white p-3">
                <QRCodeCanvas value={dynamicQr} size={256} className="w-full h-auto" />
              </div>
              <div className="text-sm text-slate-300">支付宝扫码 · 等待支付…</div>
            </div>
          ) : (
            <p className="text-center text-sm text-slate-400">
              {pollStopped
                ? "支付通道维护中，订单已为你保留；请稍后再来或到「我的 Token」查看。"
                : "支付通道维护中，暂无法支付；订单已为你保留，恢复后本页自动确认。"}
            </p>
          )}
        </div>
      </div>

      <p className="text-xs text-slate-500 text-center">
        支付成功后本页自动确认，token 同时发送到你的邮箱；也可在
        <Link to="/tokens" className="text-sky-400 hover:underline"> 我的 Token </Link>
        页输入邮箱收取一键登录链接。
      </p>
    </div>
  );
}
