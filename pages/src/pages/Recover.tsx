import { useRef, useState } from "react";
import Turnstile, { type TurnstileHandle, type TurnstileState } from "../components/Turnstile";
import { api } from "../services/api";

/**
 * 找回 Token（/recover）：发货邮件里的找回入口。
 * 输入购买/领取试用时留的邮箱，一键登录链接发到邮箱（邮件里列出名下所有 Token）。
 * 与「我的 Token」页输邮箱等价，独立成页是因为邮件里固定链接到 /recover。
 */
export default function Recover() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  // 人机验证：未启用时不拦截；启用后需先过验证拿到一次性 token
  const [ts, setTs] = useState<TurnstileState>({ enabled: false });
  const tsRef = useRef<TurnstileHandle>(null);

  const submit = async () => {
    if (ts.enabled && !ts.token) return; // 已启用但验证未通过，按钮已禁用，这里兜底拦 Enter 提交
    setLoading(true);
    setError("");
    try {
      await api.loginLink(email.trim(), ts.token);
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
      tsRef.current?.reset(); // token 一次性且 300s 过期，失败后重置重新获取
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold">找回 Token</h2>
        <p className="text-sm text-slate-400">
          输入购买或领取试用时留的邮箱，我们会把一键登录链接发到该邮箱，点击邮件里的链接即可进入管理页。
        </p>
      </div>

      <Turnstile ref={tsRef} onStateChange={setTs} />

      <div className="flex gap-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !loading && email.trim() && submit()}
          placeholder="你的邮箱"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 outline-none focus:border-sky-500"
        />
        <button
          onClick={submit}
          disabled={loading || !email.trim() || (ts.enabled && !ts.token)}
          className="rounded-lg bg-sky-500 px-6 font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
        >
          {loading ? "发送中…" : "发送"}
        </button>
      </div>

      {sent && (
        <p className="text-sm text-emerald-400">
          ✅ 如果该邮箱购买过或领取过服务，登录链接已发送，请查收邮件（含垃圾邮件文件夹）。链接 15 分钟内有效。
        </p>
      )}
      {error && <p className="text-rose-400 text-sm">{error}</p>}

      <p className="text-xs text-slate-500">
        为防邮箱枚举，无论该邮箱是否注册过都会显示发送成功；只有邮箱真正的主人能收到邮件。
        邮件里会列出该邮箱名下的所有 Token（含已过期的试用 Token，充值即可继续用）。
      </p>
    </div>
  );
}
