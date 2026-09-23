import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { api, type MagicSession } from "../services/api";
import { copyText } from "../utils/clipboard";
import { usePlatform } from "../components/platform";

/**
 * Magic link 落地页：核销邮件里的 ticket 换取长期会话，写入 localStorage。
 * 落地分流：新 token 凭证邮件（purpose=import 且待激活）展示「一键导入」卡片；
 * 登录/转化邮件直接进管理页。
 * ticket 72 小时内可重复打开；KV 边缘传播有延迟，刚收到的邮件立刻点击可能
 * 读到 miss，故核销失败时自动重试几次再报错。
 */
export default function AuthMagic() {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [session, setSession] = useState<MagicSession | null>(null);
  const [copied, setCopied] = useState(false);
  const platform = usePlatform();

  useEffect(() => {
    const ticket = new URLSearchParams(location.search).get("ticket");
    if (!ticket) {
      setError("链接不完整，请回到「我的 Token」页重新获取登录链接");
      return;
    }
    let cancelled = false;
    const tryConsume = async (attempt: number): Promise<void> => {
      try {
        const res = await api.consumeMagic(ticket);
        if (cancelled) return;
        try {
          localStorage.setItem("fg_session", res.session_token);
        } catch {
          /* ignore */
        }
        // 只有「新 token 凭证邮件 + 待激活」落导入卡片；其余（登录链接/转化邮件、
        // 已激活后重开凭证邮件）直接进管理页
        if (res.purpose === "import" && res.status === "paid" && res.sub_url) {
          setSession(res);
        } else {
          navigate(`/tokens?id=${res.token_id}`, { replace: true });
        }
      } catch (e) {
        if (cancelled) return;
        // KV 最终一致：邮件刚发出就点时边缘可能还没读到 ticket，重试等待传播
        if (attempt < 4) {
          setTimeout(() => void tryConsume(attempt + 1), 3000);
        } else {
          setError((e as Error).message);
        }
      }
    };
    void tryConsume(1);
    return () => {
      cancelled = true;
    };
  }, [location.search, navigate]);

  if (error) {
    return (
      <div className="max-w-md mx-auto text-center space-y-4 py-16">
        <p className="text-rose-400 text-[15px] sm:text-sm">{error}</p>
        <Link
          to="/tokens"
          className="inline-block rounded-lg bg-sky-500 px-6 py-3 sm:py-2.5 text-base sm:text-sm font-medium hover:bg-sky-400 transition-colors"
        >
          前往「我的 Token」重新获取 →
        </Link>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="max-w-md mx-auto text-center py-16">
        <p className="text-slate-400 text-[15px] sm:text-sm">正在登录，请稍候…</p>
      </div>
    );
  }

  // 一键导入 deep link 与 TokenStatus 保持一致：订阅链接 UA 自适应，同一 URL 全客户端通用
  const subUrl = session.sub_url ?? "";
  const encSubUrl = encodeURIComponent(subUrl);
  const platformOs = platform.split("-")[0];
  const importLinks: { label: string; href: string }[] =
    platformOs === "iOS"
      ? [
          { label: "导入到 Stash", href: `stash://install-config?url=${encSubUrl}` },
          { label: "导入到 sing-box", href: `sing-box://import-remote-profile?url=${encSubUrl}#fastergamer` },
        ]
      : platformOs === "Android"
      ? [
          { label: "导入到 Clash", href: `clash://install-config?url=${encSubUrl}&name=fastergamer` },
          { label: "导入到 sing-box", href: `sing-box://import-remote-profile?url=${encSubUrl}#fastergamer` },
        ]
      : [{ label: "一键导入到 Clash", href: `clash://install-config?url=${encSubUrl}&name=fastergamer` }];

  const copySub = async () => {
    // 裸链接不带名称片段：配置名由订阅响应头 profile-title 下发
    if (await copyText(subUrl)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      // 微信内置浏览器等场景剪贴板不可用，给用户手动复制的兜底
      window.prompt("自动复制失败，请长按全选手动复制订阅链接：", subUrl);
    }
  };

  return (
    <div className="max-w-md mx-auto py-12 space-y-6">
      <div className="text-center space-y-1">
        <h1 className="text-2xl sm:text-xl font-semibold text-emerald-300">✅ 登录成功</h1>
        <p className="text-[15px] sm:text-sm text-slate-400">
          导入订阅后自动激活并开始计时，选择你喜欢的客户端：
        </p>
      </div>

      {subUrl && (
        <section className="rounded-2xl border border-sky-500/40 bg-sky-500/5 p-6 space-y-4">
          <div className="space-y-2">
            {importLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="block text-center rounded-lg bg-sky-500 px-4 py-3 text-base sm:text-sm font-medium hover:bg-sky-400 transition-colors"
              >
                {l.label} →
              </a>
            ))}
            {/* 深链依赖已装客户端，未安装时浏览器静默无反应，必须给出路 */}
            <p className="text-center text-sm sm:text-xs text-slate-500">
              点了没反应？说明还没安装客户端，先去
              <Link to="/guide" className="text-sky-400 hover:underline"> 使用教程 </Link>
              下载安装。
            </p>
          </div>

          <div className="rounded-lg bg-slate-900/60 p-3 space-y-2">
            <p className="text-sm sm:text-xs text-slate-400">或手动复制订阅链接，粘贴到客户端：</p>
            <code className="block text-sm sm:text-xs text-slate-300 break-all">{subUrl}</code>
            <button
              onClick={copySub}
              className="w-full rounded-lg border border-slate-600 px-4 py-3 sm:py-2 text-base sm:text-sm hover:bg-slate-800 transition-colors"
            >
              {copied ? "已复制 ✓" : "复制订阅链接"}
            </button>
          </div>

          <div className="space-y-2">
            <p className="text-sm sm:text-xs text-slate-400">也可以下载配置文件，在客户端里选「导入 → 本地文件」：</p>
            <div className="grid grid-cols-2 gap-2">
              <a
                href={`${subUrl}&format=clash`}
                download
                className="text-center rounded-lg border border-slate-600 px-3 py-2 text-[15px] sm:text-sm text-slate-300 hover:border-sky-500 hover:text-sky-300 transition-colors"
              >
                Clash 配置 (.yaml)
              </a>
              <a
                href={`${subUrl}&format=singbox`}
                download
                className="text-center rounded-lg border border-slate-600 px-3 py-2 text-[15px] sm:text-sm text-slate-300 hover:border-sky-500 hover:text-sky-300 transition-colors"
              >
                sing-box 配置 (.json)
              </a>
            </div>
          </div>

          <div className="flex flex-col items-center gap-2 pt-2">
            <div className="bg-white p-3 rounded-xl">
              <QRCodeSVG value={subUrl} size={140} />
            </div>
            <p className="text-xs text-slate-500">手机扫码导入</p>
          </div>
        </section>
      )}

      <div className="text-center">
        <Link
          to={`/tokens?id=${session.token_id}`}
          className="text-[15px] sm:text-sm text-sky-400 hover:underline"
        >
          进入管理页，查看用量与设备 →
        </Link>
      </div>
    </div>
  );
}
