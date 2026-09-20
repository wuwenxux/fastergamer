import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Turnstile, { type TurnstileHandle, type TurnstileState } from "../components/Turnstile";
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

/**
 * 首页定位：帮新用户最快用上客户端 + 建立信任，付费转化交给
 * 邮件（试用转化/到期提醒）与 Token 管理页。首页只留一个低价干扰的
 * 「查看套餐价格」小入口，给不试直接买的用户留路。
 */
export default function Home() {
  const currentPlatform = usePlatform();

  useEffect(() => {
    captureRefCode();
  }, []);

  return (
    <div className="space-y-12">
      <section className="text-center py-8 space-y-4">
        <h1 className="text-4xl font-bold">游戏加速，先免费体验 7 天</h1>
        <p className="text-slate-400 max-w-xl mx-auto">
          无需注册，输入邮箱即可领取体验 Token，导入客户端立即加速；好用再付费。
        </p>
      </section>

      <TrialCard />

      {/* 优势 / 信任：新用户决策「要不要试」最需要的信息 */}
      <section className="max-w-3xl mx-auto space-y-5">
        <h2 className="text-2xl sm:text-xl font-semibold text-center">为什么选 GameBoost</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Feature
            title="免注册，邮箱即账号"
            desc="没有账号密码，Token 凭证发到邮箱；丢失随时凭邮箱一键找回，订阅链接不变。"
          />
          <Feature
            title="全球多节点智能路由"
            desc="港日美等多地落地节点，订阅按实测延迟排序，自动为你选最快的线路。"
          />
          <Feature
            title="多设备共享"
            desc="一个 Token 可绑多台设备，每台设备独立订阅链接，用量透明可查。"
          />
          <Feature
            title="先用后付，随时续费"
            desc="体验到期前邮件提醒，按需在管理页续费开通；首次开通付费额外赠送 30 天。"
          />
        </div>
      </section>

      <section className="text-center space-y-4">
        <h2 className="text-2xl sm:text-xl font-semibold">客户端下载</h2>
        <div className="flex flex-wrap justify-center gap-3 max-w-2xl mx-auto">
          {CLASH_DOWNLOADS.map((d) => (
            <a
              key={d.platform}
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`rounded-lg border px-4 py-2 text-[15px] sm:text-sm transition-colors ${
                platformMatches(d.platform, currentPlatform)
                  ? "border-sky-500 bg-sky-500/10 text-sky-300"
                  : "border-slate-700 bg-slate-900 text-slate-300 hover:border-sky-500/60"
              }`}
            >
              {d.platform.split("-")[0]} · {d.name}
            </a>
          ))}
        </div>
        <p className="text-[15px] sm:text-sm space-x-6">
          <Link to="/guide" className="text-sky-400 hover:underline">
            使用教程 →
          </Link>
          <Link to="/support" className="text-sky-400 hover:underline">
            遇到问题？帮助与反馈 →
          </Link>
        </p>
      </section>

      {/* 低价干扰的直接购买入口：留给不试直接买的用户 */}
      <p className="text-center text-[15px] sm:text-sm text-slate-500">
        已体验过，想直接购买？
        <Link to="/buy" className="text-sky-400 hover:underline ml-1">
          查看套餐价格 →
        </Link>
      </p>
    </div>
  );
}

/** 优势卡片：一句话标题 + 两行说明 */
function Feature({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-1.5">
      <h3 className="font-semibold text-slate-100">{title}</h3>
      <p className="text-[15px] leading-relaxed sm:text-sm text-slate-400">{desc}</p>
    </div>
  );
}

/** 免费体验领取卡片：输入邮箱领 7 天 8GB，凭证发到邮箱，每邮箱限一次 */
function TrialCard() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState("");
  // 人机验证：未启用时不拦截；启用后需先过验证拿到一次性 token
  const [ts, setTs] = useState<TurnstileState>({ enabled: false });
  const tsRef = useRef<TurnstileHandle>(null);

  const claim = async () => {
    if (ts.enabled && !ts.token) return; // 已启用但验证未通过，按钮已禁用，这里兜底拦 Enter 提交
    setError("");
    setState("sending");
    try {
      await api.claimTrial(email.trim(), savedRefCode(), ts.token);
      setState("done");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
      tsRef.current?.reset(); // token 一次性且 300s 过期，失败后重置重新获取
    }
  };

  if (state === "done") {
    return (
      <section className="max-w-xl mx-auto rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-6 text-center space-y-2">
        <h2 className="text-xl sm:text-lg font-semibold text-emerald-300">体验凭证已发送 ✅</h2>
        <p className="text-[15px] leading-relaxed sm:text-sm text-slate-300">
          7 天 · 8GB 体验 token 已发到你的邮箱，按邮件里的指引导入 Clash / sing-box 即可使用；
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
        <h2 className="text-xl sm:text-lg font-semibold">新用户免费体验 7 天</h2>
        <p className="text-[15px] sm:text-sm text-slate-400">8GB 流量，输入邮箱立即领取，每个邮箱限领一次</p>
      </div>
      <Turnstile ref={tsRef} onStateChange={setTs} />
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 text-base sm:text-sm outline-none focus:border-sky-500"
          onKeyDown={(e) => e.key === "Enter" && claim()}
        />
        <button
          onClick={claim}
          disabled={state === "sending" || (ts.enabled && !ts.token)}
          className="rounded-lg bg-sky-500 px-5 py-3 sm:py-2.5 text-base sm:text-sm font-medium hover:bg-sky-400 transition-colors disabled:opacity-50"
        >
          {state === "sending" ? "领取中…" : "免费领取"}
        </button>
      </div>
      {error && <p className="text-rose-400 text-[15px] sm:text-sm text-center">{error}</p>}
    </section>
  );
}
