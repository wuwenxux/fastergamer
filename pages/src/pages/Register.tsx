import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Registration } from "../../../shared/types";
import { api } from "../services/api";

function hasSession(): boolean {
  try {
    return !!localStorage.getItem("fg_session");
  } catch {
    return false;
  }
}

/**
 * 防失联登记 —— 隐藏页面（不在导航出现，仅登录用户从「我的 Token」页进入）。
 * 用途：入口域名迁移/被封时，通过登记的备用邮箱/Telegram 批量通知新入口。
 */
export default function Register() {
  const [loggedIn] = useState(hasSession);
  const [notifyEmail, setNotifyEmail] = useState("");
  const [telegram, setTelegram] = useState("");
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loggedIn) return;
    api
      .getRegistration()
      .then((reg) => {
        if (reg) {
          setNotifyEmail(reg.notify_email ?? "");
          setTelegram(reg.telegram ?? "");
          setSaved(true);
        }
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoaded(true));
  }, [loggedIn]);

  const submit = async () => {
    setLoading(true);
    setError("");
    setSaved(false);
    try {
      await api.saveRegistration({
        notify_email: notifyEmail.trim() || undefined,
        telegram: telegram.trim() || undefined,
      });
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!loggedIn) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4 text-center">
          <p className="text-lg font-semibold">此页面需要先登录</p>
          <p className="text-sm text-slate-400">
            请先在「我的 Token」页输入购买邮箱，通过邮件登录链接进入后再登记。
          </p>
          <Link
            to="/tokens"
            className="inline-block rounded-lg bg-sky-500 px-6 py-2.5 font-medium hover:bg-sky-400 transition-colors"
          >
            前往登录 →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold">防失联登记</h2>
        <p className="text-sm text-slate-400 mt-2">
          如果现有入口域名无法访问，我们会通过这里登记的联系方式通知你新入口。
          建议留一个与购买邮箱不同的备用联系方式。
        </p>
      </div>

      {!loaded ? (
        <p className="text-sm text-slate-500">加载中…</p>
      ) : (
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-sm text-slate-300">通知邮箱（可选，建议备用邮箱）</label>
            <input
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
              placeholder="backup@example.com"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-2.5 outline-none focus:border-sky-500"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-slate-300">Telegram（可选，@用户名 或 t.me 链接）</label>
            <input
              value={telegram}
              onChange={(e) => setTelegram(e.target.value)}
              placeholder="@username"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-2.5 outline-none focus:border-sky-500"
            />
          </div>

          {error && <p className="text-rose-400 text-sm">{error}</p>}
          {saved && !error && (
            <p className="text-emerald-400 text-sm">✅ 已登记。入口有变动时会按此联系方式通知你。</p>
          )}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full rounded-lg bg-sky-500 py-2.5 font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
          >
            {loading ? "保存中…" : "保存登记"}
          </button>

          <p className="text-xs text-slate-500">
            登记信息仅用于服务通知，不会用于其他用途。两项至少填一项；保存新值会覆盖旧值。
          </p>
        </div>
      )}
    </div>
  );
}
