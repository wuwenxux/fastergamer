import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Order, Plan } from "../../../shared/types";
import ManualPay from "../components/ManualPay";
import { api } from "../services/api";

type OrderView = {
  status: Order["status"];
  token_id?: string;
  payable_cny?: number;
  plan_id?: string;
};

/**
 * 订单查询页：凭订单号查询支付进度。
 * 待支付订单直接内嵌收款码（刷新/换设备也能继续支付），并轮询等待客服确认收款；
 * 已支付展示 token 短 ID 与查看入口。订单号本身不可猜，作为查询凭证。
 */
export default function OrderStatus() {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const [order, setOrder] = useState<OrderView | null>(null);
  const [plan, setPlan] = useState<Plan | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const query = useCallback(async (orderId: string) => {
    setLoading(true);
    setError("");
    try {
      const o = await api.orderStatus(orderId.trim());
      setOrder(o);
      if (o.plan_id) {
        const plans = await api.plans().catch(() => [] as Plan[]);
        setPlan(plans.find((p) => p.id === o.plan_id));
      }
    } catch (e) {
      setOrder(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // URL 带订单号（支付页给的回查链接）时自动查询
  useEffect(() => {
    if (id) void query(id);
  }, [id, query]);

  // 待支付订单轮询：客服确认收款后自动跳到已支付态，10 分钟后停止
  useEffect(() => {
    if (!id || order?.status !== "pending") return;
    const startedAt = Date.now();
    pollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60_000) {
        if (pollRef.current) clearInterval(pollRef.current);
        return;
      }
      try {
        const s = await api.orderStatus(id);
        if (s.status !== "pending") setOrder((prev) => (prev ? { ...prev, ...s } : prev));
      } catch {
        /* 网络抖动忽略，下一轮再试 */
      }
    }, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [id, order?.status]);

  const submit = () => {
    const v = input.trim();
    if (v) navigate(`/orders/${encodeURIComponent(v)}`);
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">订单查询</h2>

      {/* 查询输入 */}
      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-3">
        <p className="text-[15px] sm:text-sm text-slate-400">
          输入下单时生成的订单号，查询支付与开通进度。
        </p>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="订单号，如 ord_…"
            className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-base sm:text-sm font-mono outline-none focus:border-sky-500"
          />
          <button
            onClick={submit}
            disabled={loading || !input.trim()}
            className="rounded-lg bg-sky-500 px-5 py-2 font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
          >
            {loading ? "查询中…" : "查询"}
          </button>
        </div>
        {error && <p className="text-rose-400 text-[15px] sm:text-sm">{error}</p>}
      </div>

      {/* 待支付：继续付款 + 等待确认 */}
      {id && order?.status === "pending" && (
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
          <div className="flex justify-between">
            <span className="text-slate-400">套餐</span>
            <span>{plan?.name ?? order.plan_id ?? "—"}</span>
          </div>
          <ManualPay
            orderId={id}
            payableCny={order.payable_cny ?? plan?.price_cny ?? 0}
            plan={plan}
          />
          <p className="text-sm leading-relaxed sm:text-xs text-slate-500 text-center">
            客服确认收款后本页自动更新，token 同时发送到你的邮箱。
          </p>
        </div>
      )}

      {/* 已支付 */}
      {order?.status === "paid" && (
        <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-8 text-center space-y-3">
          <div className="text-4xl">✅</div>
          <h3 className="text-xl font-semibold text-emerald-300">订单已确认开通</h3>
          {order.token_id && (
            <p className="text-[15px] sm:text-sm text-slate-300">
              Token ID：<span className="font-mono text-sky-300">{order.token_id}</span>
            </p>
          )}
          <p className="text-[15px] leading-relaxed sm:text-sm text-slate-300">
            Token 凭证已发送到你的邮箱，也可在
            <Link to="/tokens" className="text-sky-400 hover:underline"> 我的 Token </Link>
            页输入邮箱一键登录查看。
          </p>
        </div>
      )}

      {/* 已取消 */}
      {order?.status === "failed" && (
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-8 text-center space-y-3">
          <h3 className="text-xl font-semibold text-slate-300">订单已取消</h3>
          <p className="text-[15px] leading-relaxed sm:text-sm text-slate-400">
            该订单未支付已被取消；如需购买请重新下单。有疑问可到
            <Link to="/support" className="text-sky-400 hover:underline"> 帮助反馈 </Link>
            提交工单。
          </p>
        </div>
      )}
    </div>
  );
}
