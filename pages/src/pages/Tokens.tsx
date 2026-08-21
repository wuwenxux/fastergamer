import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Token } from "../../../shared/types";
import TokenStatus from "../components/TokenStatus";
import { api } from "../services/api";

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
  const [token, setToken] = useState<Token | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [savedTokens, setSavedTokens] = useState<Token[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);

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
        const valid = results.filter((t): t is Token => t !== null);
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
  const isEmailInput = input.includes("@");

  const sendLoginLink = async () => {
    setLoading(true);
    setError("");
    try {
      await api.loginLink(input.trim());
      setLinkSent(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const query = () => {
    setLinkSent(false);
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
          disabled={loading}
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
        <p className="text-sm text-emerald-400">
          ✅ 如果该邮箱购买过服务，登录链接已发送，请查收邮件（含垃圾邮件文件夹）并点击链接进入。
        </p>
      )}

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      <p className="text-xs text-slate-500">
        忘记 Token？
        <Link to="/recover" className="text-sky-400 hover:underline">
          通过购买时留的邮箱找回 →
        </Link>
      </p>

      {token && (
        <>
          <TokenStatus token={token} />
        </>
      )}

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
    </div>
  );
}
