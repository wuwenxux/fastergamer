import { Link } from "react-router-dom";
import type { Plan } from "../../../shared/types";

/** 海报风套餐卡：大字、少字、一句话命中需求 */
export default function PlanCard({ plan }: { plan: Plan }) {
  const isBiz = plan.id.startsWith("plan_biz");
  const pitch = plan.pitch ?? plan.description;

  return (
    <div
      className={`group relative overflow-hidden rounded-3xl border transition-all ${
        isBiz
          ? "border-amber-500/50 hover:border-amber-400"
          : "border-slate-700 hover:border-sky-500"
      }`}
    >
      {/* 海报头部：渐变底 + 大标题 */}
      <div
        className={`px-6 pt-8 pb-6 bg-gradient-to-br ${
          isBiz
            ? "from-amber-500/25 via-slate-900 to-slate-950"
            : "from-sky-500/25 via-slate-900 to-slate-950"
        }`}
      >
        {plan.tag && (
          <span
            className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${
              isBiz ? "bg-amber-500/20 text-amber-300" : "bg-sky-500/20 text-sky-300"
            }`}
          >
            {plan.tag}
          </span>
        )}
        <h3 className="mt-3 text-2xl font-bold tracking-wide">{plan.name}</h3>
      </div>

      {/* 价格：视觉重心 */}
      <div className="bg-slate-950/60 px-6 py-6 border-t border-slate-800">
        <div className="flex items-baseline gap-2">
          <span className={`text-5xl font-black ${isBiz ? "text-amber-300" : "text-sky-300"}`}>
            ¥{plan.price_cny}
          </span>
          <span className="text-sm text-slate-500">/ {plan.duration_days} 天</span>
        </div>
        <p className="mt-3 text-base text-slate-200 leading-relaxed">{pitch}</p>
        {plan.features && plan.features.length > 0 && (
          <ul className="mt-4 space-y-1.5 text-sm text-slate-400">
            {plan.features.map((f) => (
              <li key={f}>✓ {f}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-slate-950/60 px-6 pb-6">
        <Link
          to={`/buy?plan=${plan.id}`}
          className={`block rounded-xl py-3 text-center text-lg font-bold transition-colors ${
            isBiz
              ? "bg-amber-500 text-slate-950 hover:bg-amber-400"
              : "bg-sky-500 text-slate-950 hover:bg-sky-400"
          }`}
        >
          立即购买
        </Link>
      </div>
    </div>
  );
}
