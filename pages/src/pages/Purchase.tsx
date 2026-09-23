import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isTrialPlan, type Order, type Plan } from "../../../shared/types";
import ManualPay from "../components/ManualPay";
import PaymentModal from "../components/PaymentModal";
import PlanCard from "../components/PlanCard";
import type { TurnstileHandle, TurnstileState } from "../components/Turnstile";
import { api } from "../services/api";
import { usePolling } from "../utils/polling";

type Step = "summary" | "paying" | "result";

/** 年付「买 12 送 1」为常驻首购权益（赠送月每邮箱限一次，续费为 12 个月），横幅不再限时 */
function YearlyPromoBanner() {
  return (
    <section className="max-w-3xl mx-auto rounded-2xl border border-amber-500/40 bg-gradient-to-r from-amber-500/10 to-slate-900 p-5 text-center space-y-1">
      <p className="font-semibold text-amber-300">🔥 年付 ¥110，首购买 12 个月送 1 个月</p>
      <p className="text-[15px] leading-relaxed sm:text-sm text-slate-300">
        首次开通年付有效期 <strong className="text-amber-300">13 个月</strong>（395 天），续费为 12 个月。
      </p>
    </section>
  );
}

export default function Purchase() {
  const [params] = useSearchParams();
  const planId = params.get("plan") ?? "";

  const [plan, setPlan] = useState<Plan | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>("summary");
  const [processing, setProcessing] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  // Safari 隐私模式等场景 localStorage 读写会抛错，全部包 try/catch（与 Tokens/Register 对齐）
  const [contact, setContact] = useState(() => {
    try {
      return localStorage.getItem("fg_contact") ?? "";
    } catch {
      return "";
    }
  });
  // 人机验证：未启用时不拦截；启用后需先过验证拿到一次性 token
  const [ts, setTs] = useState<TurnstileState>({ enabled: false });
  const tsRef = useRef<TurnstileHandle>(null);

  // 无 plan 参数时本页就是套餐列表页（首页已弱化付费，价格表挪到这里）；
  // 带 plan 参数时加载该套餐进入确认订单流程
  useEffect(() => {
    api
      .plans()
      .then((plans) => {
        setPlans(plans);
        if (!planId) {
          setPlan(null);
          setError("");
          return;
        }
        const found = plans.find((p) => p.id === planId);
        setError(found ? "" : "未找到该套餐，请从下方重新选择");
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
      let ref: string | undefined;
      try {
        ref = localStorage.getItem("fg_ref") ?? undefined;
      } catch {
        /* ignore */
      }
      const res = await api.createOrder(plan.id, contact.trim(), ref, ts.token);
      try {
        localStorage.setItem("fg_contact", contact.trim()); // 记住邮箱，下次下单免填
      } catch {
        /* ignore */
      }
      setOrder(res.order);
      setStep("result");
    } catch (e) {
      setError((e as Error).message);
      tsRef.current?.reset(); // token 一次性且 300s 过期，失败后重置重新获取
    } finally {
      setProcessing(false);
    }
  };

  if (step === "result" && order && plan) {
    return <PaymentResult order={order} plan={plan} />;
  }

  // 套餐列表视图：无 plan 参数（或参数无效）时展示，点卡片带参回本页进入下单流程
  if (!plan) {
    return (
      <div className="space-y-8">
        <h2 className="text-2xl sm:text-xl font-semibold text-center">选择套餐</h2>
        {error && <p className="text-center text-rose-400">{error}</p>}
        <YearlyPromoBanner />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-w-3xl mx-auto">
          {plans
            .filter((p) => !isTrialPlan(p.id) && !p.id.startsWith("plan_biz")) // 试用在首页免费领；企业套餐只在 fastergamer.cn 展示
            .map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">确认订单</h2>

      {error && <p className="text-rose-400 text-[15px] sm:text-sm">{error}</p>}

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
            提交订单
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
          turnstileRef={tsRef}
          turnstileState={ts}
          onTurnstileState={setTs}
        />
      )}
    </div>
  );
}

/** 下单后的订单页：展示人工收款码（微信/支付宝），用户转账备注订单号后点「我已支付」；
 * 轮询订单状态，客服确认收款（置 paid）后自动跳转，10 分钟后停止 */
function PaymentResult({ order, plan }: { order: Order; plan: Plan }) {
  // 推广减免后实付 0 元的订单在创建时已直接发货
  const [paid, setPaid] = useState(order.status === "paid");
  // 客服人工确认后订单会变 paid；轮询 10 分钟后停止，避免无限空转
  const [pollStopped, setPollStopped] = useState(false);
  const payable = order.payable_cny ?? plan.price_cny;
  const discount = order.discount_cny ?? 0;

  // 轮询订单状态，管理员确认（置 paid）后自动跳转提示；10 分钟后停止（人工收款确认可能更久）
  usePolling(
    !paid && !pollStopped,
    async () => {
      const s = await api.orderStatus(order.id);
      if (s.status === "paid") {
        setPaid(true);
        return false;
      }
    },
    { intervalMs: 3000, timeoutMs: 10 * 60_000, onTimeout: () => setPollStopped(true) }
  );

  if (paid) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-8 text-center space-y-3">
          <div className="text-4xl">✅</div>
          <h2 className="text-2xl sm:text-xl font-semibold text-emerald-300">订单已确认开通</h2>
          <p className="text-[15px] leading-relaxed sm:text-sm text-slate-300">
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
        <h2 className="text-2xl sm:text-xl font-semibold">订单已创建</h2>
      </div>

      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
        <div className="flex justify-between">
          <span className="text-slate-400">套餐</span>
          <span>{plan.name}</span>
        </div>

        <ManualPay orderId={order.id} payableCny={payable} plan={plan} />

        {discount > 0 && (
          <p className="text-sm sm:text-xs text-emerald-400 text-right">
            推广减免 -¥{discount}（原价 ¥{plan.price_cny}）
          </p>
        )}

        {pollStopped && (
          <p className="text-center text-[15px] sm:text-sm text-slate-400">
            订单已为你保留；客服确认收款后自动开通，也可到「我的 Token」页输入邮箱查看。
          </p>
        )}
      </div>

      <p className="text-sm leading-relaxed sm:text-xs text-slate-500 text-center">
        确认收款后本页自动跳转，token 同时发送到你的邮箱；页面关闭后可随时到
        <Link to={`/orders/${order.id}`} className="text-sky-400 hover:underline"> 订单查询 </Link>
        页继续支付或查看进度（建议收藏该链接）。
      </p>
    </div>
  );
}
