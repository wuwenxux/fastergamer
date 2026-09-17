import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import TokenStatus from "../components/TokenStatus";
import ReferralCard from "../components/ReferralCard";
import Turnstile, { type TurnstileHandle, type TurnstileState } from "../components/Turnstile";
import { STATUS_COLOR, STATUS_LABEL } from "../lib/status";
import { api, type TokenView } from "../services/api";

const STORAGE_KEY = "my_tokens";

function readSavedIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as string[];
  } catch {
    return [];
  }
}

function saveIds(ids: string[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

export default function Tokens() {
  const location = useLocation();
  const [input, setInput] = useState("");
  const [token, setToken] = useState<TokenView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [savedTokens, setSavedTokens] = useState<TokenView[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  // 是否已登录（有本地会话）：决定是否展示防失联登记入口（不对非注册用户展示）
  const [loggedIn] = useState(() => {
    try {
      return !!localStorage.getItem("fg_session");
    } catch {
      return false;
    }
  });

  // 从其他页面跳转（state）或邮件登录链接（?id=）过来时自动查询 token
  useEffect(() => {
    const state = location.state as { tokenId?: string } | null;
    const queryId = new URLSearchParams(location.search).get("id");
    const tokenId = state?.tokenId ?? queryId ?? undefined;
    if (tokenId) {
      setInput(tokenId);
      // 使用 setTimeout 让 input 更新后再触发查询，避免 state 不同步
      setTimeout(() => {
        queryById(tokenId);
      }, 0);
      // 清理 state / query，防止刷新后重复查询
      window.history.replaceState({}, document.title, location.pathname);
    }
  }, [location.state, location.search]);

  // 加载本地保存的 token id 列表
  useEffect(() => {
    setSavedIds(readSavedIds());
  }, []);

  // 自动查询本地保存的 token
  useEffect(() => {
    if (savedIds.length === 0) return;
    setLoadingSaved(true);
    Promise.all(
      savedIds.map((id) =>
        api
          .getToken(id)
          .then((t) => t)
          .catch(() => null)
      )
    )
      .then((results) => {
        const valid = results.filter((t): t is TokenView => t !== null);
        setSavedTokens(valid);
        // 清理已失效（如被删除）的本地记录
        const foundIds = new Set(valid.map((t) => t.id));
        const cleaned = savedIds.filter((id) => foundIds.has(id));
        if (cleaned.length !== savedIds.length) {
          setSavedIds(cleaned);
          saveIds(cleaned);
        }
      })
      .finally(() => setLoadingSaved(false));
  }, [savedIds]);

  const queryById = async (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const t = await api.getToken(trimmed);
      setToken(t);
      // 查询成功后自动保存
      const current = readSavedIds();
      if (!current.includes(t.id)) {
        const next = [t.id, ...current];
        setSavedIds(next);
        saveIds(next);
      }
    } catch (e) {
      setError((e as Error).message);
      setToken(null);
    } finally {
      setLoading(false);
    }
  };

  const [linkSent, setLinkSent] = useState(false);
  const [linkThrottled, setLinkThrottled] = useState(false);
  const isEmailInput = input.includes("@");
  // 人机验证：只对发登录链接（邮箱输入）生效，按 token ID 查询不拦截
  const [ts, setTs] = useState<TurnstileState>({ enabled: false });
  const tsRef = useRef<TurnstileHandle>(null);

  const sendLoginLink = async () => {
    if (ts.enabled && !ts.token) return; // 已启用但验证未通过，按钮已禁用，这里兜底拦 Enter 提交
    setLoading(true);
    setError("");
    try {
      const res = await api.loginLink(input.trim(), ts.token);
      setLinkThrottled(res?.throttled === true);
      setLinkSent(true);
    } catch (e) {
      setError((e as Error).message);
      tsRef.current?.reset(); // token 一次性且 300s 过期，失败后重置重新获取
    } finally {
      setLoading(false);
    }
  };

  const query = () => {
    setLinkSent(false);
    setLinkThrottled(false);
    if (isEmailInput) {
      void sendLoginLink();
    } else {
      queryById(input);
    }
  };

  const removeSaved = (id: string) => {
    const next = savedIds.filter((x) => x !== id);
    setSavedIds(next);
    saveIds(next);
    setSavedTokens(savedTokens.filter((t) => t.id !== id));
    if (token?.id === id) setToken(null);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">我的 Token</h2>

      <Turnstile ref={tsRef} onStateChange={setTs} />

      <div className="flex gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && query()}
          placeholder="输入 token ID 或购买邮箱"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 outline-none focus:border-sky-500"
        />
        <button
          onClick={query}
          disabled={loading || (isEmailInput && ts.enabled && !ts.token)}
          className="rounded-lg bg-sky-500 px-6 font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
        >
          {loading ? "处理中…" : isEmailInput ? "发送登录链接" : "查询"}
        </button>
      </div>

      {isEmailInput && !linkSent && (
        <p className="text-xs text-slate-500">
          输入的是邮箱：将把一键登录链接发送到该邮箱，点击邮件里的链接即可进入管理页（验证邮箱所有权后才发凭证，更安全）。
        </p>
      )}
      {linkSent && (
        <p className={`text-sm ${linkThrottled ? "text-amber-400" : "text-emerald-400"}`}>
          {linkThrottled
            ? "⚠️ 该邮箱发送过于频繁，本次未重复发信。请查收之前收到的登录邮件（链接 72 小时内有效，含垃圾邮件文件夹），或一小时后再试。"
            : "✅ 如果该邮箱购买过服务，登录链接已发送，请查收邮件（含垃圾邮件文件夹）并点击链接进入。"}
        </p>
      )}

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      <p className="text-xs text-slate-500">
        忘记 Token ID？直接输入购买时留的邮箱，登录链接邮件里会列出名下所有 Token。
      </p>

      {token &&
        (token.restricted ? (
          <RestrictedTokenCard token={token} />
        ) : (
          <TokenStatus token={token} />
        ))}

      <ReferralCard />

      <p className="text-sm text-slate-400">
        还不知道怎么导入订阅？
        <Link to="/guide" className="text-sky-400 hover:underline ml-1">
          查看完整使用教程 →
        </Link>
      </p>

      {savedTokens.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-slate-300">历史 Token（本设备）</h3>
          <div className="space-y-2">
            {savedTokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-900 px-4 py-3"
              >
                <button
                  onClick={() => {
                    setToken(t);
                    setError("");
                  }}
                  className="text-left text-sm hover:text-sky-400"
                >
                  <div className="font-mono">{t.id}</div>
                  <div className="text-xs text-slate-500">
                    {t.status === "active" && t.expires_at
                      ? `使用中 · 到期 ${new Date(t.expires_at).toLocaleDateString()}`
                      : t.status === "paid"
                      ? "待激活"
                      : t.status === "expired"
                      ? "已过期"
                      : "已撤销"}
                  </div>
                </button>
                <button
                  onClick={() => removeSaved(t.id)}
                  className="text-xs text-slate-500 hover:text-rose-400"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            历史记录只保存在当前浏览器，换设备或清空缓存后会丢失。建议截图保存 token ID。
          </p>
        </div>
      )}

      {loadingSaved && savedTokens.length === 0 && (
        <p className="text-sm text-slate-500">正在加载历史 Token…</p>
      )}

      {loggedIn && (
        <div className="rounded-xl border border-slate-800 px-4 py-3 flex items-center justify-between">
          <div className="text-sm">
            <span className="text-slate-400">备用联系方式（选填）</span>
            <span className="text-xs text-slate-500 ml-2">网站换入口或邮箱收不到信时通知你</span>
          </div>
          <Link to="/register" className="text-sm text-slate-400 hover:text-sky-400 shrink-0">
            登记 →
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * 受限概要卡片 —— 未登录或非本人查询时后端不返回 uuid / 订阅链接 / 设备列表，
 * 只展示状态、套餐、有效期和流量用量，引导登录后查看完整信息
 */
function RestrictedTokenCard({ token }: { token: TokenView }) {
  const limitGb = token.traffic_limit_gb ?? 0;
  const usedGb = token.traffic_used_gb ?? 0;
  const percent = limitGb > 0 ? Math.min(100, (usedGb / limitGb) * 100) : 0;
  const exhausted = limitGb > 0 && usedGb >= limitGb;

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-xs text-slate-400">Token</div>
          <div className="font-mono text-sm">{token.id}</div>
        </div>
        <div className="flex items-center gap-2">
          {token.online && (
            <span className="rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/40 px-3 py-1 text-xs font-medium">
              当前在线
            </span>
          )}
          <span
            className={`rounded-full border px-3 py-1 text-xs font-medium ${STATUS_COLOR[token.status]}`}
          >
            {STATUS_LABEL[token.status]}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-slate-800/60 p-3">
          <div className="text-slate-400 text-xs mb-1">套餐</div>
          <div>{token.plan_id}</div>
        </div>
        <div className="rounded-lg bg-slate-800/60 p-3">
          <div className="text-slate-400 text-xs mb-1">有效期</div>
          <div>
            {token.expires_at
              ? new Date(token.expires_at).toLocaleString()
              : token.status === "paid"
              ? "尚未激活，激活后开始计时"
              : "无有效期信息"}
          </div>
        </div>
      </div>

      {limitGb > 0 && (
        <div className="rounded-lg bg-slate-800/60 p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">流量用量</span>
            <span className={exhausted ? "text-rose-400 font-medium" : "text-slate-200"}>
              {usedGb.toFixed(2)} / {limitGb} GB
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-700 overflow-hidden">
            <div
              className={`h-full rounded-full ${
                exhausted ? "bg-rose-500" : percent > 80 ? "bg-amber-500" : "bg-emerald-500"
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3">
        <p className="text-sm text-amber-300">
          🔒 为保护账号安全，UUID / 订阅链接 / 设备管理需验证邮箱后查看
        </p>
        <LoginLinkInline />
      </div>
    </div>
  );
}

/** 受限卡片内嵌的登录链接发送表单：就地输入邮箱发链接，不用回到页面顶部改输入框 */
function LoginLinkInline() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "throttled">("idle");
  const [err, setErr] = useState("");
  // 人机验证：未启用时不拦截；启用后需先过验证拿到一次性 token
  const [ts, setTs] = useState<TurnstileState>({ enabled: false });
  const tsRef = useRef<TurnstileHandle>(null);

  const send = async () => {
    if (ts.enabled && !ts.token) return; // 已启用但验证未通过，按钮已禁用，这里兜底拦 Enter 提交
    setErr("");
    setState("sending");
    try {
      const res = await api.loginLink(email.trim(), ts.token);
      setState(res?.throttled ? "throttled" : "sent");
    } catch (e) {
      setErr((e as Error).message);
      setState("idle");
      tsRef.current?.reset(); // token 一次性且 300s 过期，失败后重置重新获取
    }
  };

  if (state === "sent" || state === "throttled") {
    return (
      <p className={`text-xs ${state === "throttled" ? "text-amber-200" : "text-emerald-300"}`}>
        {state === "throttled"
          ? "⚠️ 该邮箱发送过于频繁，本次未重复发信。请翻查之前收到的登录邮件（链接 72 小时内有效，含垃圾邮件文件夹），或一小时后再试。"
          : "✅ 登录链接已发送（如果该邮箱购买过服务）。点击邮件里的链接后，会在打开的页面直接显示订阅链接与一键导入按钮，请在那个页面复制使用。"}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-amber-200/70">
        输入购买时填写的邮箱，把一键登录链接发到邮箱，点邮件里的链接即可查看完整信息（链接 72 小时内有效）。
      </p>
      <Turnstile ref={tsRef} onStateChange={setTs} />
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="购买时填写的邮箱"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
        />
        <button
          onClick={send}
          disabled={state === "sending" || !email.includes("@") || (ts.enabled && !ts.token)}
          className="rounded-lg bg-sky-500 px-4 text-sm font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
        >
          {state === "sending" ? "发送中…" : "发送登录链接"}
        </button>
      </div>
      {err && <p className="text-xs text-rose-400">{err}</p>}
    </div>
  );
}
