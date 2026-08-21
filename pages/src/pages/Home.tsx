import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Plan } from "../../../shared/types";
import PlanCard from "../components/PlanCard";
import { CLASH_DOWNLOADS, detectPlatform } from "../components/ClashGuide";
import { api } from "../services/api";

export default function Home() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const currentPlatform = useMemo(detectPlatform, []);

  useEffect(() => {
    api
      .plans()
      .then(setPlans)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="space-y-12">
      <section className="text-center py-8 space-y-4">
        <h1 className="text-4xl font-bold">免注册，Token 即游戏加速</h1>
        <p className="text-slate-400 max-w-xl mx-auto">
          购买激活即用，全球多节点智能路由，降低游戏延迟。
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-5 text-center">选择套餐</h2>
        {error && <p className="text-center text-rose-400 mb-4">{error}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} />
          ))}
        </div>
      </section>

      <section className="text-center space-y-4">
        <h2 className="text-xl font-semibold">客户端下载</h2>
        <div className="flex flex-wrap justify-center gap-3 max-w-2xl mx-auto">
          {CLASH_DOWNLOADS.map((d) => (
            <a
              key={d.platform}
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                d.platform === currentPlatform
                  ? "border-sky-500 bg-sky-500/10 text-sky-300"
                  : "border-slate-700 bg-slate-900 text-slate-300 hover:border-sky-500/60"
              }`}
            >
              {d.platform} · {d.name}
            </a>
          ))}
        </div>
        <p className="text-sm space-x-6">
          <Link to="/guide" className="text-sky-400 hover:underline">
            使用教程 →
          </Link>
          <Link to="/support" className="text-sky-400 hover:underline">
            遇到问题？帮助与反馈 →
          </Link>
        </p>
      </section>
    </div>
  );
}
