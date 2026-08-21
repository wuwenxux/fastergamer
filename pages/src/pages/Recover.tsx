import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { TokenStatus } from "../../../shared/types";
import { api } from "../services/api";

type RecoveredToken = {
  id: string;
  status: TokenStatus;
  plan_id: string;
  purchased_at: number;
  activated_at?: number;
  expires_at?: number;
  traffic_limit_gb: number;
  traffic_used_gb: number;
  contact?: string;
};

const STATUS_LABEL: Record<TokenStatus, string> = {
  paid: "待激活",
  active: "使用中",
  expired: "已过期",
  revoked: "已撤销",
};

const STATUS_COLOR: Record<TokenStatus, string> = {
  paid: "text-amber-400",
  active: "text-emerald-400",
  expired: "text-rose-400",
  revoked: "text-slate-400",
};

export default function Recover() {
  const [contact, setContact] = useState("");
  const [tokens, setTokens] = useState<RecoveredToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const navigate = useNavigate();

  const search = async () => {
    const value = contact.trim();
    if (!value) return;
    setLoading(true);
    setError("");
    setTokens([]);
    setSearched(false);
    try {
      const data = await api.recoverTokens(value);
      setTokens(data);
      setSearched(true);
    } catch (e) {
      setError((e as Error).message);
      setSearched(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">找回 Token</h2>
      <p className="text-sm text-slate-400">
        购买时填写的邮箱是你找回 token 的唯一凭证。输入相同的邮箱即可查询。
      </p>

      <div className="flex gap-3">
        <input
          type="email"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="购买时填写的邮箱"
          className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2.5 outline-none focus:border-sky-500"
        />
        <button
          onClick={search}
          disabled={loading || !contact.trim()}
          className="rounded-lg bg-sky-500 px-6 font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
        >
          {loading ? "查询中…" : "找回"}
        </button>
      </div>

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      {searched && tokens.length === 0 && !error && (
        <p className="text-sm text-slate-500">
          未找到与该邮箱关联的 token。请检查输入是否与购买时一致，或联系客服处理。
        </p>
      )}

      {tokens.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-slate-300">找到以下 Token</h3>
          {tokens.map((t) => (
            <div
              key={t.id}
              className="rounded-xl border border-slate-700 bg-slate-900 p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="font-mono text-sm">{t.id}</div>
                <span className={`text-xs font-medium ${STATUS_COLOR[t.status]}`}>
                  {STATUS_LABEL[t.status]}
                </span>
              </div>
              <div className="text-xs text-slate-500">
                {t.expires_at
                  ? `有效期至：${new Date(t.expires_at).toLocaleString()}`
                  : t.status === "paid"
                  ? "尚未激活，激活后开始计时"
                  : "无有效期信息"}
              </div>
              <div className="text-xs text-slate-500">
                流量：{t.traffic_used_gb.toFixed(2)} / {t.traffic_limit_gb} GB
              </div>
              <button
                onClick={() => navigate("/tokens", { state: { tokenId: t.id } })}
                className="w-full rounded-lg border border-sky-500/50 bg-sky-500/10 py-2 text-sm font-medium text-sky-400 hover:bg-sky-500/20 transition-colors"
              >
                查看详情与订阅链接 →
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-slate-500">
        如果邮箱也忘记了，目前无法自助找回，请联系管理员人工处理。
      </p>

      <Link to="/" className="block text-center text-sm text-sky-400 hover:underline">
        ← 返回购买套餐
      </Link>
    </div>
  );
}
