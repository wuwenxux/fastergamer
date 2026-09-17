import { useCallback, useEffect, useMemo, useState } from "react";
import { STATUS_COLOR, STATUS_LABEL } from "../lib/status";
import { api, ApiError, type AdminNode, type AdminToken } from "../services/api";

// 管理密钥只存 sessionStorage：关标签页即失效，避免长期留在本机
const KEY_STORAGE = "fg_admin_key";

/** 套餐 id → 短名（新增细分、用量表用）；未收录的 id 去掉 plan_ 前缀兜底 */
const PLAN_SHORT: Record<string, string> = {
  plan_3days: "7天",
  plan_monthly: "月付",
  plan_quarterly: "季付",
  plan_yearly: "包年",
  plan_2years: "两年",
};

function planShort(planId: string): string {
  return PLAN_SHORT[planId] ?? planId.replace(/^plan_/, "");
}

/** 套餐 id → 完整中文名（用量表「套餐」列用） */
function planName(planId: string): string {
  if (planId === "plan_3days") return "7 天体验";
  if (planId === "plan_monthly") return "月付";
  return planShort(planId);
}

function readKey(): string {
  try {
    return sessionStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

/** 本地日期键（YYYY-MM-DD），用于按天聚合 */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function fmtTime(ts?: number): string {
  return ts ? new Date(ts).toLocaleString() : "—";
}

function fmtGb(gb: number): string {
  return gb.toFixed(2);
}

interface DayRow {
  date: string;
  /** 当天新增总数 */
  added: number;
  /** 当天新增按套餐细分：套餐短名 → 数量 */
  byPlan: Record<string, number>;
  /** 当天激活数 */
  activated: number;
}

export default function Admin() {
  const [key, setKey] = useState(readKey);
  const [keyInput, setKeyInput] = useState("");
  const [keyError, setKeyError] = useState("");
  const [tokens, setTokens] = useState<AdminToken[]>([]);
  const [nodes, setNodes] = useState<AdminNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [days, setDays] = useState<14 | 30>(14);

  const load = useCallback(async (k: string) => {
    setLoading(true);
    setError("");
    try {
      const [t, n] = await Promise.all([api.adminTokens(k), api.adminNodes(k)]);
      setTokens(t);
      setNodes(n);
    } catch (e) {
      // 401 说明密钥不对：清掉已存密钥退回登录表单
      if (e instanceof ApiError && e.status === 401) {
        try {
          sessionStorage.removeItem(KEY_STORAGE);
        } catch {
          /* ignore */
        }
        setKey("");
        setKeyError("管理密钥错误");
        return;
      }
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 已有密钥（sessionStorage 恢复）时自动拉取
  useEffect(() => {
    if (key) void load(key);
  }, [key, load]);

  const submitKey = () => {
    const k = keyInput.trim();
    if (!k) return;
    try {
      sessionStorage.setItem(KEY_STORAGE, k);
    } catch {
      /* ignore */
    }
    setKeyError("");
    setKey(k);
  };

  const now = Date.now();

  // 概览统计
  const overview = useMemo(() => {
    const today = dayKey(now);
    return {
      total: tokens.length,
      addedToday: tokens.filter((t) => t.purchased_at && dayKey(t.purchased_at) === today).length,
      effective: tokens.filter(
        (t) => t.status === "active" && (!t.expires_at || t.expires_at > now)
      ).length,
      online: tokens.filter((t) => t.presence?.online ?? t.online).length,
      traffic: tokens.reduce((sum, t) => sum + (t.traffic_used_gb ?? 0), 0),
    };
  }, [tokens, now]);

  // 每日新增/激活聚合（最近 days 天，含今天）
  const dayRows = useMemo<DayRow[]>(() => {
    const rows: DayRow[] = [];
    const byDate = new Map<string, DayRow>();
    for (let i = days - 1; i >= 0; i--) {
      const date = dayKey(now - i * 86_400_000);
      const row: DayRow = { date, added: 0, byPlan: {}, activated: 0 };
      rows.push(row);
      byDate.set(date, row);
    }
    for (const t of tokens) {
      if (t.purchased_at) {
        const row = byDate.get(dayKey(t.purchased_at));
        if (row) {
          row.added += 1;
          const p = planShort(t.plan_id);
          row.byPlan[p] = (row.byPlan[p] ?? 0) + 1;
        }
      }
      if (t.activated_at) {
        const row = byDate.get(dayKey(t.activated_at));
        if (row) row.activated += 1;
      }
    }
    return rows;
  }, [tokens, days, now]);

  const maxAdded = Math.max(1, ...dayRows.map((r) => r.added));

  // 用户使用表：按用量降序
  const usageRows = useMemo(
    () => [...tokens].sort((a, b) => (b.traffic_used_gb ?? 0) - (a.traffic_used_gb ?? 0)),
    [tokens]
  );

  // 鉴权门：未持有密钥时只渲染输入表单
  if (!key) {
    return (
      <div className="max-w-sm mx-auto space-y-4">
        <h2 className="text-2xl font-bold">管理看板</h2>
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
          <p className="text-sm text-slate-400">请输入管理密钥（仅本次会话有效）。</p>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitKey()}
            placeholder="管理密钥"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-2.5 outline-none focus:border-sky-500"
          />
          {keyError && <p className="text-rose-400 text-sm">{keyError}</p>}
          <button
            onClick={submitKey}
            className="w-full rounded-lg bg-sky-500 py-2.5 font-medium hover:bg-sky-400 transition-colors"
          >
            进入看板
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold">管理看板</h2>
        <div className="flex items-center gap-4 text-sm">
          {nodes.length > 0 && (
            <span className="text-slate-400">
              节点在线 {nodes.filter((n) => n.online).length}/{nodes.length}
            </span>
          )}
          <button
            onClick={() => void load(key)}
            disabled={loading}
            className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 hover:border-sky-500 transition-colors disabled:opacity-60"
          >
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {error && <p className="text-rose-400 text-sm">{error}</p>}
      {loading && tokens.length === 0 && <p className="text-sm text-slate-500">正在加载数据…</p>}

      {tokens.length > 0 && (
        <>
          {/* 概览卡片 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <OverviewCard label="总 Token 数" value={`${overview.total}`} />
            <OverviewCard label="今日新增" value={`${overview.addedToday}`} />
            <OverviewCard label="当前生效中" value={`${overview.effective}`} />
            <OverviewCard label="当前在线" value={`${overview.online}`} accent="text-sky-300" />
            <OverviewCard label="累计流量" value={`${fmtGb(overview.traffic)} GB`} />
          </div>

          {/* 每日新增/激活 */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-slate-300">每日新增 / 激活</h3>
              <div className="flex gap-1 text-xs">
                {([14, 30] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    className={`rounded-md px-3 py-1 border transition-colors ${
                      days === d
                        ? "border-sky-500 bg-sky-500/20 text-sky-300"
                        : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500"
                    }`}
                  >
                    近 {d} 天
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                    <th className="px-4 py-2.5 font-medium">日期</th>
                    <th className="px-4 py-2.5 font-medium">新增</th>
                    <th className="px-4 py-2.5 font-medium w-2/5">分布</th>
                    <th className="px-4 py-2.5 font-medium">激活</th>
                  </tr>
                </thead>
                <tbody>
                  {[...dayRows].reverse().map((r) => (
                    <tr key={r.date} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-300 whitespace-nowrap">
                        {new Date(`${r.date}T00:00:00`).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span className="font-medium">{r.added}</span>
                        {r.added > 0 && (
                          <span className="ml-2 text-xs text-slate-500">
                            {Object.entries(r.byPlan)
                              .map(([p, c]) => `${p}×${c}`)
                              .join(" ")}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-sky-500"
                            style={{ width: `${(r.added / maxAdded) * 100}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-2.5">{r.activated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* 用户使用表 */}
          <section className="space-y-3">
            <h3 className="font-semibold text-slate-300">用户使用（按用量降序）</h3>
            <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                    <th className="px-4 py-2.5 font-medium">Token ID</th>
                    <th className="px-4 py-2.5 font-medium">邮箱</th>
                    <th className="px-4 py-2.5 font-medium">套餐</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium min-w-36">用量 / 额度</th>
                    <th className="px-4 py-2.5 font-medium">设备</th>
                    <th className="px-4 py-2.5 font-medium">接入 IP</th>
                    <th className="px-4 py-2.5 font-medium">最后活跃</th>
                    <th className="px-4 py-2.5 font-medium">到期时间</th>
                  </tr>
                </thead>
                <tbody>
                  {usageRows.map((t) => {
                    const ipCount = Object.keys(t.presence?.traffic_by_ip ?? t.traffic_by_ip ?? {}).length;
                    const limit = t.traffic_limit_gb ?? 0;
                    const used = t.traffic_used_gb ?? 0;
                    const percent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
                    const exhausted = limit > 0 && used >= limit;
                    const deviceCount = 1 + (t.devices?.length ?? 0); // 主设备 + 子设备槽位
                    return (
                      <tr key={t.id} className="border-b border-slate-800/60 last:border-0 align-middle">
                        <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap">
                          {t.id}
                          {ipCount >= 5 && (
                            <span className="ml-1.5" title="接入 IP 过多，疑似分享">
                              ⚠️
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-400 max-w-44 truncate">
                          {t.contact ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">{planName(t.plan_id)}</td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${STATUS_COLOR[t.status]}`}
                          >
                            {STATUS_LABEL[t.status]}
                          </span>
                          {(t.presence?.online ?? t.online) && (
                            <span className="ml-1.5 inline-block rounded-full border border-sky-500/40 bg-sky-500/20 px-2.5 py-0.5 text-xs text-sky-300">
                              在线
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {limit > 0 ? (
                            <div className="space-y-1">
                              <div className="text-xs whitespace-nowrap">
                                <span className={exhausted ? "text-rose-400 font-medium" : "text-slate-200"}>
                                  {fmtGb(used)}
                                </span>
                                <span className="text-slate-500"> / {limit} GB</span>
                              </div>
                              <div className="h-1.5 w-28 rounded-full bg-slate-800 overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${
                                    exhausted ? "bg-rose-500" : percent > 80 ? "bg-amber-500" : "bg-emerald-500"
                                  }`}
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-slate-400">
                              {fmtGb(used)} GB <span className="text-slate-500">/ 不限</span>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">{deviceCount}</td>
                        <td className="px-4 py-2.5">{ipCount}</td>
                        <td className="px-4 py-2.5 text-xs text-slate-400 whitespace-nowrap">
                          {fmtTime(t.presence?.last_active_at ?? t.last_active_at)}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-400 whitespace-nowrap">
                          {fmtTime(t.expires_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** 概览数字卡片 */
function OverviewCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold ${accent ?? "text-slate-100"}`}>{value}</div>
    </div>
  );
}
