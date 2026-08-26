import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../services/api";

/**
 * Magic link 落地页：核销邮件里的一次性 ticket，换取 30 天会话，
 * 写入 localStorage 后跳转到对应 Token 管理页。
 */
export default function AuthMagic() {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    const ticket = new URLSearchParams(location.search).get("ticket");
    if (!ticket) {
      setError("链接不完整，请回到「我的 Token」页重新获取登录链接");
      return;
    }
    api
      .consumeMagic(ticket)
      .then((res) => {
        try {
          localStorage.setItem("fg_session", res.session_token);
        } catch {
          /* ignore */
        }
        navigate(`/tokens?id=${res.token_id}`, { replace: true });
      })
      .catch((e) => setError((e as Error).message));
  }, [location.search, navigate]);

  return (
    <div className="max-w-md mx-auto text-center space-y-4 py-16">
      {error ? (
        <>
          <p className="text-rose-400 text-sm">{error}</p>
          <Link
            to="/tokens"
            className="inline-block rounded-lg bg-sky-500 px-6 py-2.5 text-sm font-medium hover:bg-sky-400 transition-colors"
          >
            前往「我的 Token」重新获取 →
          </Link>
        </>
      ) : (
        <p className="text-slate-400 text-sm">正在登录，请稍候…</p>
      )}
    </div>
  );
}
