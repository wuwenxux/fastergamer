import { useEffect, useState } from "react";
import type { Token } from "../../../shared/types";
import { api } from "../services/api";
import DeviceManager from "./DeviceManager";

type VerifyResult = { valid: true; nodeCount: number } | { valid: false; error: string };

const STATUS_LABEL: Record<Token["status"], string> = {
  paid: "待激活",
  active: "使用中",
  expired: "已过期",
  revoked: "已撤销",
};

const STATUS_COLOR: Record<Token["status"], string> = {
  paid: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  active: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  expired: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  revoked: "bg-slate-600/30 text-slate-400 border-slate-500/40",
};

export default function TokenStatus({ token }: { token: Token }) {
  const [current, setCurrent] = useState<Token>(token);
  const [copied, setCopied] = useState(false);
  const [allCopied, setAllCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [remainingMs, setRemainingMs] = useState<number>(() =>
    current.expires_at ? current.expires_at - Date.now() : 0
  );
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [preview, setPreview] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [monthlyQuotaGb, setMonthlyQuotaGb] = useState<number | null>(null);

  // 套餐带月度配额时拉取配额值用于展示
  useEffect(() => {
    api
      .plans()
      .then((plans) => {
        const plan = plans.find((p) => p.id === current.plan_id);
        setMonthlyQuotaGb(plan?.monthly_quota_gb ?? null);
      })
      .catch(() => {});
  }, [current.plan_id]);

  // 每秒刷新剩余时间和在线状态
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (current.expires_at) {
        setRemainingMs(current.expires_at - Date.now());
      }
    }, 1000);
    return () => clearInterval(t);
  }, [current.expires_at]);

  const remainingDays = Math.max(0, Math.floor(remainingMs / 86_400_000));
  const remainingHours = Math.max(0, Math.floor((remainingMs % 86_400_000) / 3_600_000));
  const active = current.status === "active" && remainingMs > 0;

  const limitGb = current.traffic_limit_gb ?? 0;
  const usedGb = current.traffic_used_gb ?? 0;
  const remainingGb = Math.max(0, limitGb - usedGb);
  const trafficPercent = limitGb > 0 ? Math.min(100, (usedGb / limitGb) * 100) : 0;
  const trafficExhausted = limitGb > 0 && usedGb >= limitGb;

  const isOnline =
    current.online === true &&
    (current.online_updated_at ?? 0) > now - 90_000;

  const onActivate = async () => {
    try {
      const updated = await api.activateToken(current.id);
      setCurrent(updated);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const copySub = async () => {
    try {
      await navigator.clipboard.writeText(api.subUrl(current.uuid));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用时忽略 */
    }
  };

  const onVerify = async () => {
    setVerifying(true);
    setVerify(null);
    try {
      const res = await api.verifySub(current.uuid);
      if (res.valid) {
        setVerify({ valid: true, nodeCount: res.nodeCount });
      } else {
        setVerify({ valid: false, error: res.error ?? "验证失败" });
      }
    } catch (e) {
      setVerify({ valid: false, error: (e as Error).message });
    } finally {
      setVerifying(false);
    }
  };

  const loadPreview = async () => {
    if (showPreview) {
      setShowPreview(false);
      return;
    }
    setPreviewLoading(true);
    try {
      const res = await fetch(api.subUrl(current.uuid), { cache: "no-store" });
      const text = await res.text();
      setPreview(text);
      setShowPreview(true);
    } catch (e) {
      setPreview(`加载失败：${(e as Error).message}`);
      setShowPreview(true);
    } finally {
      setPreviewLoading(false);
    }
  };

  const copyAll = async () => {
    const lines = [
      "【GameBoost 加速凭证】",
      `Token ID：${current.id}`,
      `UUID：${current.uuid}`,
      current.contact ? `联系方式：${current.contact}` : "",
      current.expires_at ? `有效期至：${new Date(current.expires_at).toLocaleString()}` : "",
      `订阅链接：${api.subUrl(current.uuid)}`,
      "",
      "建议：复制本条消息 → 粘贴到微信收藏 / 备忘录 / 邮箱保存，遗失后可凭此找回。",
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm text-slate-400">Token</div>
          <div className="font-mono text-sm">{current.id}</div>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-medium ${STATUS_COLOR[current.status]}`}
        >
          {STATUS_LABEL[current.status]}
        </span>
        {isOnline && (
          <span className="rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/40 px-3 py-1 text-xs font-medium">
            当前在线
          </span>
        )}
      </div>

      {current.contact && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
          <div className="text-amber-400 text-xs mb-1">售后联系方式（请牢记）</div>
          <div className="text-sm break-all">{current.contact}</div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-slate-800/60 p-3">
          <div className="text-slate-400 text-xs mb-1">UUID（即连接凭证）</div>
          <div className="font-mono break-all">{current.uuid}</div>
        </div>
        {current.expires_at && (
          <div className="rounded-lg bg-slate-800/60 p-3">
            <div className="text-slate-400 text-xs mb-1">剩余有效期</div>
            <div className={active ? "text-emerald-300 font-semibold" : "text-rose-300"}>
              {active ? `${remainingDays} 天 ${remainingHours} 小时` : "已到期"}
            </div>
          </div>
        )}
      </div>

      {current.last_active_at && (
        <div className="text-xs text-slate-500">
          最近活跃：{new Date(current.last_active_at).toLocaleString()}
        </div>
      )}

      {limitGb > 0 && (
        <div className="rounded-lg bg-slate-800/60 p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">流量额度</span>
            <span className={trafficExhausted ? "text-rose-400 font-medium" : "text-slate-200"}>
              {usedGb.toFixed(2)} / {limitGb} GB
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-700 overflow-hidden">
            <div
              className={`h-full rounded-full ${
                trafficExhausted ? "bg-rose-500" : trafficPercent > 80 ? "bg-amber-500" : "bg-emerald-500"
              }`}
              style={{ width: `${trafficPercent}%` }}
            />
          </div>
          <div className="text-xs text-slate-400">
            剩余 {remainingGb.toFixed(2)} GB{monthlyQuotaGb ? "（总流量）" : "（总额度，不限月）"}
          </div>
          {monthlyQuotaGb && (
            <div className="text-xs text-slate-400">
              本月已用 {((current.month_used_bytes ?? 0) / 1024 ** 3).toFixed(2)} / {monthlyQuotaGb} GB
              <span className="text-slate-500">
                （当月用超将预支下月额度，有效期提前一个月；次月 1 日恢复新额度）
              </span>
            </div>
          )}
          {trafficExhausted && (
            <p className="text-xs text-rose-400">
              流量已用完，token 已自动失效。请购买新 token 继续使用。
            </p>
          )}
        </div>
      )}

      {current.status === "paid" && (
        <button
          onClick={onActivate}
          className="w-full rounded-lg bg-emerald-500 py-2.5 font-medium hover:bg-emerald-400 transition-colors"
        >
          ⚡ 立即激活（开始计时）
        </button>
      )}

      <button
        onClick={copyAll}
        className="w-full rounded-lg border border-amber-500/50 bg-amber-500/10 py-2.5 font-medium text-amber-400 hover:bg-amber-500/20 transition-colors"
      >
        {allCopied ? "✓ 已复制全部信息" : "📋 复制全部信息（粘贴到微信收藏保存）"}
      </button>

      {active && (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4">
          <div>
            <div className="text-slate-400 text-xs mb-1">Clash 订阅链接（复制后粘贴到 Clash/Stash）</div>
            <div className="font-mono text-sm break-all text-slate-300">{api.subUrl(current.uuid)}</div>
          </div>

          <p className="text-xs text-slate-400">
            这个链接不是用浏览器直接打开的，而是 Clash 用来下载配置的地址。复制链接 → 打开 Clash → 粘贴到「订阅/Profiles」里即可自动导入节点。
          </p>

          <p className="text-xs text-rose-400">
            ⚠️ 请勿把订阅链接分享给他人：UUID 就是全部连接凭证，泄露后会被他人盗用并消耗你的流量额度。
          </p>

          {current.multi_device_detected_at &&
            current.multi_device_detected_at > now - 24 * 3_600_000 && (
            <p className="text-xs text-amber-400">
              ⚠️ 检测到该凭证在多个节点同时在线（{new Date(current.multi_device_detected_at).toLocaleString()}）。
              如果是你自己多台设备同时使用可忽略；否则说明订阅链接可能已泄露，请联系售后更换。
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={copySub}
              className="rounded-lg bg-sky-500 py-2.5 font-medium hover:bg-sky-400 transition-colors"
            >
              {copied ? "✓ 已复制" : "复制订阅链接"}
            </button>
            <button
              onClick={loadPreview}
              disabled={previewLoading}
              className="rounded-lg border border-slate-600 py-2.5 font-medium hover:border-sky-500 transition-colors disabled:opacity-60"
            >
              {previewLoading ? "加载中…" : showPreview ? "隐藏配置内容" : "查看配置内容"}
            </button>
          </div>

          <button
            onClick={onVerify}
            disabled={verifying}
            className="w-full rounded-lg border border-emerald-500/50 bg-emerald-500/10 py-2 font-medium text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-60"
          >
            {verifying ? "验证中…" : "验证订阅是否可用"}
          </button>

          {verify?.valid ? (
            <p className="text-xs text-emerald-400">
              ✅ 验证通过，订阅包含 {verify.nodeCount} 个节点，可复制到 Clash 使用。
            </p>
          ) : verify ? (
            <p className="text-xs text-rose-400">
              ❌ 验证失败：{verify.error}
            </p>
          ) : null}

          {showPreview && (
            <div className="rounded-lg bg-slate-900 border border-slate-700 p-3">
              <div className="text-xs text-slate-400 mb-2">配置预览（YAML）</div>
              <pre className="text-[10px] font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                {preview}
              </pre>
            </div>
          )}

          <p className="text-xs text-amber-400">
            💡 建议：点击上方「复制全部信息」，粘贴到微信收藏、备忘录或邮箱保存。遗失后可凭 Token ID 或联系方式找回。
          </p>
        </div>
      )}

      <DeviceManager token={current} onChange={setCurrent} />
    </div>
  );
}
