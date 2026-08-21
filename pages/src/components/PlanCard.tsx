import { Link } from "react-router-dom";
import type { Plan } from "../../../shared/types";

export default function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 flex flex-col gap-4 hover:border-sky-500/60 transition-colors">
      <div>
        <h3 className="text-lg font-semibold">{plan.name}</h3>
        <p className="text-sm text-slate-400 mt-1">{plan.description}</p>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-3xl font-bold">¥{plan.price_cny}</span>
        <span className="text-sm text-slate-400">
          / {plan.duration_days} 天
        </span>
      </div>

      <ul className="text-sm text-slate-300 space-y-1.5 text-left">
        {typeof plan.traffic_limit_gb === "number" && (
          <li>✓ 总流量 {plan.traffic_limit_gb} GB（不限月）</li>
        )}
        <li>✓ 多节点智能加速，Clash 订阅即用</li>
      </ul>

      <Link
        to={`/buy?plan=${plan.id}`}
        className="mt-auto rounded-lg bg-sky-500 py-2.5 text-center font-medium hover:bg-sky-400 transition-colors"
      >
        立即购买
      </Link>
    </div>
  );
}
