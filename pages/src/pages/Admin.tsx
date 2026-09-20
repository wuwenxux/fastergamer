import { useCallback, useEffect, useMemo, useState } from "react";
import { isTrialPlan, type Order } from "../../../shared/types";
import { STATUS_COLOR, STATUS_LABEL } from "../lib/status";
import { api, ApiError, type AdminNode, type AdminToken } from "../services/api";

// 管理密钥只存 sessionStorage：关标签页即失效，避免长期留在本机
const KEY_STORAGE = "fg_admin_key";

/** 套餐 id → 短名（新增细分、用量表用）；未收录的 id 去掉 plan_ 前缀兜底 */
const PLAN_SHORT: Record<string, string> = {
  plan_trial: "试用",
  plan_3days: "试用", // 历史 id，存量 token/订单仍是它
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
  if (isTrialPlan(planId)) return "免费体验";
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

/** 订单状态的中文展示名与徽标配色（pending 高亮提醒站长处理） */
const ORDER_STATUS_LABEL: Record<Order["status"], string> = {
  pending: "待支付",
  paid: "已支付",
  failed: "已取消",
};
const ORDER_STATUS_COLOR: Record<Order["status"], string> = {
  pending: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  paid: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  failed: "bg-slate-600/30 text-slate-400 border-slate-500/40",
};

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
  const [orders, setOrders] = useState<Order[]>([]);
  const [tab, setTab] = useState<"overview" | "orders">("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [days, setDays] = useState<14 | 30>(14);

  const load = useCallback(async (k: string) => {
    setLoading(true);
    setError("");
    try {
      const [t, n, o] = await Promise.all([api.adminTokens(k), api.adminNodes(k), api.adminOrders(k)]);
      setTokens(t);
      setNodes(n);
      setOrders(o);
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
          <p className="text-[15px] sm:text-sm text-slate-400">请输入管理密钥（仅本次会话有效）。</p>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitKey()}
            placeholder="管理密钥"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-2.5 text-base sm:text-sm outline-none focus:border-sky-500"
          />
          {keyError && <p className="text-rose-400 text-[15px] sm:text-sm">{keyError}</p>}
          <button
            onClick={submitKey}
            className="w-full rounded-lg bg-sky-500 py-3 sm:py-2.5 font-medium hover:bg-sky-400 transition-colors"
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
        <div className="flex items-center gap-4 text-[15px] sm:text-sm">
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

      {/* 标签页：概览 / 订单（待支付角标提醒站长核账；测试订单不算真实交易，不计入） */}
      <div className="flex gap-1 text-[15px] sm:text-sm">
        {(
          [
            ["overview", "概览"],
            ["orders", `订单${orders.some((o) => o.status === "pending" && !isTestOrder(o)) ? `（${orders.filter((o) => o.status === "pending" && !isTestOrder(o)).length} 待支付）` : ""}`],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 border transition-colors ${
              tab === t
                ? "border-sky-500 bg-sky-500/20 text-sky-300"
                : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-rose-400 text-[15px] sm:text-sm">{error}</p>}
      {loading && tokens.length === 0 && <p className="text-[15px] sm:text-sm text-slate-500">正在加载数据…</p>}

      {tab === "orders" && (
        <OrdersSection adminKey={key} orders={orders} onChanged={() => void load(key)} />
      )}

      {tab === "overview" && tokens.length > 0 && (
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
              <table className="w-full text-[15px] sm:text-sm">
                <thead>
                  <tr className="text-left text-sm sm:text-xs text-slate-500 border-b border-slate-800">
                    <th className="px-4 py-2.5 font-medium">日期</th>
                    <th className="px-4 py-2.5 font-medium">新增</th>
                    <th className="px-4 py-2.5 font-medium w-2/5">分布</th>
                    <th className="px-4 py-2.5 font-medium">激活</th>
                  </tr>
                </thead>
                <tbody>
                  {[...dayRows].reverse().map((r) => (
                    <tr key={r.date} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-4 py-2.5 font-mono text-sm sm:text-xs text-slate-300 whitespace-nowrap">
                        {new Date(`${r.date}T00:00:00`).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span className="font-medium">{r.added}</span>
                        {r.added > 0 && (
                          <span className="ml-2 text-sm sm:text-xs text-slate-500">
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
              <table className="w-full text-[15px] sm:text-sm">
                <thead>
                  <tr className="text-left text-sm sm:text-xs text-slate-500 border-b border-slate-800">
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
                        <td className="px-4 py-2.5 font-mono text-sm sm:text-xs whitespace-nowrap">
                          {t.id}
                          {ipCount >= 5 && (
                            <span className="ml-1.5" title="接入 IP 过多，疑似分享">
                              ⚠️
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-sm sm:text-xs text-slate-400 max-w-44 truncate">
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
                              <div className="text-sm sm:text-xs whitespace-nowrap">
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
                            <span className="text-sm sm:text-xs text-slate-400">
                              {fmtGb(used)} GB <span className="text-slate-500">/ 不限</span>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">{deviceCount}</td>
                        <td className="px-4 py-2.5">{ipCount}</td>
                        <td className="px-4 py-2.5 text-sm sm:text-xs text-slate-400 whitespace-nowrap">
                          {fmtTime(t.presence?.last_active_at ?? t.last_active_at)}
                        </td>
                        <td className="px-4 py-2.5 text-sm sm:text-xs text-slate-400 whitespace-nowrap">
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
      <div className="text-sm sm:text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl sm:text-xl font-bold ${accent ?? "text-slate-100"}`}>{value}</div>
    </div>
  );
}

/**
 * 测试订单识别：联调/E2E 留下的订单邮箱集中在 example.com/.invalid、temp.local、
 * test-* 前缀和站内域名，真实用户邮箱不会命中。管理端直接隐藏，不展示。
 */
const TEST_CONTACT_RE = /test|@example\.|@temp\.|\.invalid$|@fastergamer\.cn$|@auto/i;
const isTestOrder = (o: Order) => TEST_CONTACT_RE.test(o.contact ?? "");

/**
 * 订单管理：人工收款码过渡方案的核账入口。
 * pending 订单可「确认收款」（fulfillOrder 自动发货发邮件）或「取消」（归还推广额度）；
 * 用户点过「我已支付」的订单带提醒徽标，优先核账。操作后由父组件整体刷新。
 * 测试订单不是真实交易，直接过滤不展示。
 */
function OrdersSection({
  adminKey,
  orders,
  onChanged,
}: {
  adminKey: string;
  orders: Order[];
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<"all" | Order["status"]>("all");
  const [busyId, setBusyId] = useState("");
  const [actionError, setActionError] = useState("");
  // 应收金额兜底：老订单无 payable_cny 字段时用套餐原价（套餐表是公开接口）
  const [planPrice, setPlanPrice] = useState<Record<string, number>>({});

  useEffect(() => {
    api
      .plans()
      .then((ps) => setPlanPrice(Object.fromEntries(ps.map((p) => [p.id, p.price_cny]))))
      .catch(() => {/* 套餐价拿不到时金额列显示 —，不影响操作 */});
  }, []);

  const visible = orders.filter((o) => !isTestOrder(o));
  const filtered = filter === "all" ? visible : visible.filter((o) => o.status === filter);

  const act = async (o: Order, kind: "paid" | "cancel") => {
    const amount = o.payable_cny ?? planPrice[o.plan_id];
    const hint =
      kind === "paid"
        ? `确认已收到 ${o.contact ?? "未知邮箱"} 的转账${amount != null ? `（应收 ¥${amount}）` : ""}？确认后立即发货并邮件通知买家。`
        : `取消订单 ${o.id}？${o.discount_cny ? "已用的推广额度会归还买家。" : ""}未到账的刷单订单可取消。`;
    if (!window.confirm(hint)) return;
    setBusyId(o.id);
    setActionError("");
    try {
      if (kind === "paid") await api.adminOrderPaid(adminKey, o.id);
      else await api.adminOrderCancel(adminKey, o.id);
      onChanged();
    } catch (e) {
      setActionError(`${o.id}：${(e as Error).message}`);
    } finally {
      setBusyId("");
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold text-slate-300">订单（{filtered.length}）</h3>
        <div className="flex gap-1 text-xs">
          {(
            [
              ["all", "全部"],
              ["pending", "待支付"],
              ["paid", "已支付"],
              ["failed", "已取消"],
            ] as const
          ).map(([f, label]) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1 border transition-colors ${
                filter === f
                  ? "border-sky-500 bg-sky-500/20 text-sky-300"
                  : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-500"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {actionError && <p className="text-rose-400 text-[15px] sm:text-sm">{actionError}</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-700 bg-slate-900">
        <table className="w-full text-[15px] sm:text-sm">
          <thead>
            <tr className="text-left text-sm sm:text-xs text-slate-500 border-b border-slate-800">
              <th className="px-4 py-2.5 font-medium">订单号</th>
              <th className="px-4 py-2.5 font-medium">邮箱</th>
              <th className="px-4 py-2.5 font-medium">套餐</th>
              <th className="px-4 py-2.5 font-medium">应收</th>
              <th className="px-4 py-2.5 font-medium">状态</th>
              <th className="px-4 py-2.5 font-medium">创建时间</th>
              <th className="px-4 py-2.5 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((o) => {
              const amount = o.payable_cny ?? planPrice[o.plan_id];
              return (
                <tr key={o.id} className="border-b border-slate-800/60 last:border-0 align-middle">
                  <td className="px-4 py-2.5 font-mono text-sm sm:text-xs whitespace-nowrap">{o.id}</td>
                  <td className="px-4 py-2.5 text-sm sm:text-xs text-slate-400 max-w-44 truncate">
                    {o.contact ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {planName(o.plan_id)}
                    {o.upgrade_token_id && (
                      <span className="ml-1.5 text-sm sm:text-xs text-slate-500">升级</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {amount != null ? `¥${amount}` : "—"}
                    {o.discount_cny ? (
                      <span className="ml-1 text-sm sm:text-xs text-emerald-400">-{o.discount_cny}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${ORDER_STATUS_COLOR[o.status]}`}
                    >
                      {ORDER_STATUS_LABEL[o.status]}
                    </span>
                    {o.status === "pending" && o.paid_notify_at && (
                      <span className="ml-1.5 inline-block rounded-full border border-amber-500/40 bg-amber-500/20 px-2.5 py-0.5 text-xs text-amber-300">
                        已点「我已支付」
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm sm:text-xs text-slate-400 whitespace-nowrap">
                    {fmtTime(o.created_at)}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {o.status === "pending" && (
                      <span className="space-x-2 text-sm sm:text-xs">
                        <button
                          onClick={() => void act(o, "paid")}
                          disabled={busyId === o.id}
                          className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-1 text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-60"
                        >
                          确认收款
                        </button>
                        <button
                          onClick={() => void act(o, "cancel")}
                          disabled={busyId === o.id}
                          className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1 text-slate-300 hover:border-rose-500/50 hover:text-rose-300 transition-colors disabled:opacity-60"
                        >
                          取消
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500 text-[15px] sm:text-sm">
                  暂无订单
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
