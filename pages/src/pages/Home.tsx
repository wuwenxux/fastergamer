import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Plan } from "../../../shared/types";
import PlanCard from "../components/PlanCard";
import { CLASH_DOWNLOADS, platformMatches, usePlatform } from "../components/ClashGuide";
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
  const currentPlatform = usePlatform();

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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-w-3xl mx-auto">
          {plans
            .filter((p) => p.id !== "plan_3days" && !p.id.startsWith("plan_biz")) // 试用只在上方免费领；企业方案单独成区
            .map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold mb-2 text-center">企业方案</h2>
        <p className="text-sm text-slate-400 text-center mb-5">
          按团队人数和稳定性要求选：日常办公选共享版，不能接受晚高峰抖动选专用节点，要国内中转专线
          <a href="mailto:support@fastergamer.cn" className="text-sky-400 hover:underline"> 邮件面议 </a>。
          <Link to="/enterprise" className="text-sky-400 hover:underline">查看企业服务全貌 →</Link>
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-w-3xl mx-auto">
          {plans
            .filter((p) => p.id.startsWith("plan_biz"))
            .map((p) => (
              <PlanCard key={p.id} plan={p} />
            ))}
        </div>

        <div className="max-w-3xl mx-auto mt-5 rounded-2xl border border-rose-500/40 bg-gradient-to-br from-rose-500/10 to-slate-900 p-6 space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">中转专线 · 链式接入</h3>
            <span className="rounded-full px-2 py-0.5 text-xs bg-rose-500/15 text-rose-300">定制报价</span>
          </div>
          <p className="text-sm text-slate-300">
            客户端 → 国内入口 → 海外落地，多一跳，换来的是<strong className="text-rose-300">确定性</strong>。
            以下场景直连解决不了，专线可以：
          </p>
          <ul className="text-sm text-slate-300 space-y-2">
            <li>
              <strong className="text-slate-100">晚高峰视频会议卡成 PPT</strong> —— Zoom / Google Meet / Teams
              一到晚上就抖，因为直连走的是拥堵的国际出口；专线国内段走运营商正规线路，晚高峰延迟一样平
            </li>
            <li>
              <strong className="text-slate-100">节点 IP 被封，全团队瞬间断线</strong> ——
              直连架构里落地 IP 暴露给每个客户端，被封就得全员换配置；专线入口在国内不暴露，落地被封分钟级切换，客户端无感
            </li>
            <li>
              <strong className="text-slate-100">出海直播 / 客户演示 / 远程交付，不能赌运气</strong> ——
              关键场合断一次线的损失远超专线一年的费用
            </li>
            <li>
              <strong className="text-slate-100">运营商对直连海外限速</strong> ——
              部分宽带/移动网络对跨境直连有 QoS 限制，怎么换节点都快不起来；中转后国内段不再受这个限制
            </li>
          </ul>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
            <a
              href="mailto:support@fastergamer.cn?subject=%E4%B8%AD%E8%BD%AC%E4%B8%93%E7%BA%BF%E5%92%A8%E8%AF%A2&body=%E5%9B%A2%E9%98%9F%E4%BA%BA%E6%95%B0%EF%BC%9A%0A%E4%B8%BB%E8%A6%81%E7%94%A8%E9%80%94%EF%BC%9A%0A%E6%9C%9F%E6%9C%9B%E5%BB%B6%E8%BF%9F%EF%BC%9A"
              className="rounded-lg bg-rose-500 px-5 py-2.5 text-center text-sm font-medium text-slate-950 hover:bg-rose-400 transition-colors"
            >
              发邮件评估专线方案 →
            </a>
            <p className="text-xs text-slate-500">
              说明团队人数、主要用途、期望延迟，24 小时内给出方案和报价
            </p>
          </div>
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
                platformMatches(d.platform, currentPlatform)
                  ? "border-sky-500 bg-sky-500/10 text-sky-300"
                  : "border-slate-700 bg-slate-900 text-slate-300 hover:border-sky-500/60"
              }`}
            >
              {d.platform.split("-")[0]} · {d.name}
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
