import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Plan } from "../../../shared/types";
import PlanCard from "../components/PlanCard";
import { CLASH_DOWNLOADS, detectPlatform } from "../components/ClashGuide";
import { api } from "../services/api";

const REF_KEY = "fg_ref";

/** 从 URL 捕获推广码（?ref=xxx）存入 localStorage，领取试用/下单时使用 */
function captureRefCode() {
  try {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref && /^[0-9a-f]{8}$/i.test(ref)) {
      localStorage.setItem(REF_KEY, ref.toLowerCase());
    }
  } catch {
    /* ignore */
  }
}

function savedRefCode(): string | undefined {
  try {
    return localStorage.getItem(REF_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export default function Home() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const currentPlatform = useMemo(detectPlatform, []);

  useEffect(() => {
    captureRefCode();
    api
      .plans()
      .then(setPlans)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="space-y-12">
      <section className="text-center py-8 space-y-4">
        <h1 className="text-4xl font-bold">Token 即游戏加速</h1>
        <p className="text-slate-400 max-w-xl mx-auto">
          购买激活即用，全球多节点智能路由，降低游戏延迟。
        </p>
      </section>

      <TrialCard />

      <section>
        <h2 className="text-xl font-semibold mb-5 text-center">选择套餐</h2>
        {error && <p className="text-center text-rose-400 mb-4">{error}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          {plans
            .filter((p) => p.id !== "plan_3days") // 试用套餐只在上方免费领，不出售
            .map((p) => (
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

/** 免费体验领取卡片：输入邮箱领 30 天 20GB，凭证发到邮箱，每邮箱限一次 */
function TrialCard() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState("");

  const claim = async () => {
    setError("");
    setState("sending");
    try {
      await api.claimTrial(email.trim(), savedRefCode());
      setState("done");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };

  if (state === "done") {
    return (
      <section className="max-w-xl mx-auto rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-6 text-center space-y-2">
        <h2 className="text-lg font-semibold text-emerald-300">体验凭证已发送 ✅</h2>
        <p className="text-sm text-slate-300">
          30 天 · 20GB 体验 token 已发到你的邮箱，按邮件里的指引导入 Clash 即可使用；
          也可在
          <Link to="/tokens" className="text-sky-400 hover:underline"> 我的 Token </Link>
          输入邮箱一键登录查看。
        </p>
      </section>
    );
  }

  return (
    <section className="max-w-xl mx-auto rounded-2xl border border-sky-500/40 bg-sky-500/5 p-6 space-y-4">
      <div className="text-center space-y-1">
        <h2 className="text-lg font-semibold">新用户免费体验 30 天</h2>
        <p className="text-sm text-slate-400">20GB 流量，输入邮箱立即领取，每个邮箱限领一次</p>
      </div>
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm outline-none focus:border-sky-500"
          onKeyDown={(e) => e.key === "Enter" && claim()}
        />
        <button
          onClick={claim}
          disabled={state === "sending"}
          className="rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-medium hover:bg-sky-400 transition-colors disabled:opacity-50"
        >
          {state === "sending" ? "领取中…" : "免费领取"}
        </button>
      </div>
      {error && <p className="text-rose-400 text-sm text-center">{error}</p>}
    </section>
  );
}
