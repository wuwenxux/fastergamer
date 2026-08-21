import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Order, Plan } from "../../../shared/types";
import PaymentModal from "../components/PaymentModal";
import { api } from "../services/api";

type Step = "summary" | "paying" | "result";

export default function Purchase() {
  const [params] = useSearchParams();
  const planId = params.get("plan") ?? "";

  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>("summary");
  const [processing, setProcessing] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [contact, setContact] = useState("");

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
      const res = await api.createOrder(plan.id, contact.trim());
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
                <span>{plan.traffic_limit_gb} GB</span>
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

/** 下单后的扫码支付页：展示收款码和订单号，等待人工确认到账 */
function PaymentResult({ order, plan }: { order: Order; plan: Plan }) {
  const [copied, setCopied] = useState(false);

  const copyOrderId = async () => {
    try {
      await navigator.clipboard.writeText(order.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="rounded-2xl border border-amber-500/50 bg-amber-500/10 p-6 text-center space-y-2">
        <h2 className="text-xl font-semibold">订单已创建，请扫码支付</h2>
        <p className="text-sm text-slate-300">
          支付时请<strong className="text-amber-300">备注订单号</strong>，
          确认到账后 token 会发送到你的邮箱。
        </p>
      </div>

      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-slate-400 text-sm">订单号（转账备注用）</span>
          <button
            onClick={copyOrderId}
            className="font-mono text-sky-400 hover:text-sky-300"
          >
            {order.id} {copied ? "✓ 已复制" : "📋"}
          </button>
        </div>
        <div className="flex justify-between items-baseline border-t border-slate-700 pt-4">
          <span className="text-slate-400">{plan.name}</span>
          <span className="text-3xl font-bold text-sky-400">¥{plan.price_cny}</span>
        </div>

        <div className="grid grid-cols-2 gap-4 pt-2">
          <QrCard label="支付宝" src="/api/qr/alipay" />
          <QrCard label="微信" src="/api/qr/wechat" />
        </div>
      </div>

      <p className="text-xs text-slate-500 text-center">
        一般 10 分钟内确认到账，token 将发送到你的邮箱；也可在
        <Link to="/recover" className="text-sky-400 hover:underline"> 找回 Token </Link>
        页面凭邮箱随时查询。
      </p>
    </div>
  );
}

function QrCard({ label, src }: { label: string; src: string }) {
  const [missing, setMissing] = useState(false);
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-center space-y-2">
      {missing ? (
        <div className="aspect-square flex items-center justify-center text-xs text-slate-500">
          收款码暂未上传
          <br />
          请联系客服
        </div>
      ) : (
        <img
          src={src}
          alt={`${label}收款码`}
          onError={() => setMissing(true)}
          className="w-full aspect-square object-contain rounded-lg bg-white"
        />
      )}
      <div className="text-sm text-slate-300">{label}</div>
    </div>
  );
}
