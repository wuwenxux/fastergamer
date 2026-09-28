import { useState } from "react";
import { api, type TokenView } from "../services/api";
import { copyText } from "../utils/clipboard";

/**
 * 接入 IP 管理（从 TokenStatus 拆出）：按估算流量展示最近接入 IP，支持封禁/解封，
 * 封禁 30 秒内全节点生效，误封可随时解封。
 * 「待授权接入」区块：设备级防护（单凭证多地并发）自动拦截的新 IP，待机主决策——
 * 「允许」= 迁移流程：自动为新设备创建独立槽位，该 IP 进入 7 天过渡名单（期内可继续
 * 用旧链接，请尽快让新设备导入专属链接）；「保持拒绝」维持拦截并停止提醒。
 */
export default function IpManager({
  token,
  onChange,
}: {
  token: TokenView;
  onChange: (t: TokenView) => void;
}) {
  const [ipActionLoading, setIpActionLoading] = useState<string | null>(null);
  // 「允许」迁移成功的提示：新槽位名 + 专属订阅链接（可复制）
  const [migrated, setMigrated] = useState<{ name: string; url: string } | null>(null);
  const [copiedMigrated, setCopiedMigrated] = useState(false);

  // 接入 IP 统计（按估算流量降序，最多展示 10 条）
  const ipStats = Object.entries(token.traffic_by_ip ?? {})
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 10);

  const formatBytes = (bytes: number) =>
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

  const blockedIpSet = new Set(token.blocked_ips ?? []);

  // 设备级防护台账：pending = 待机主决策；key = 被拦截 IP。涉事设备名按台账 uuid 解析
  const guardEntries = Object.entries(token.device_guard ?? {}).sort((a, b) => b[1].at - a[1].at);
  const pendingGuards = guardEntries.filter(([, e]) => e.status === "pending");
  const deviceNameOf = (uuid: string) =>
    uuid === token.uuid ? "主设备" : (token.devices ?? []).find((d) => d.uuid === uuid)?.name ?? "已删除的设备";

  const toggleBlockIp = async (ip: string, blocked: boolean) => {
    if (!blocked && !window.confirm(`确认封禁 ${ip}？\n该 IP 将在 30 秒内被所有节点拒绝连接（若它是多人共享的出口网络，同网络的其他设备也会无法使用）。`)) {
      return;
    }
    setIpActionLoading(ip);
    try {
      const res = blocked
        ? await api.unblockIp(token.id, ip)
        : await api.blockIp(token.id, ip);
      onChange({ ...token, blocked_ips: res.blocked_ips });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setIpActionLoading(null);
    }
  };

  const decideGuard = async (ip: string, allow: boolean) => {
    setIpActionLoading(`dg-${ip}`);
    try {
      if (allow) {
        const res = await api.allowDeviceIp(token.id, ip);
        onChange({
          ...token,
          blocked_ips: res.blocked_ips,
          device_guard: res.device_guard,
          devices: res.devices,
        });
        // 迁移流程：展示新槽位专属链接，引导 7 天内让新设备导入
        if (res.device) {
          setCopiedMigrated(false);
          setMigrated({ name: res.device.name, url: api.subUrl(res.device.uuid) });
        }
      } else {
        const res = await api.denyDeviceIp(token.id, ip);
        onChange({ ...token, device_guard: res.device_guard });
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setIpActionLoading(null);
    }
  };

  // 迁移过渡名单（主设备 + 各槽位）：被「允许」的 IP 在 7 天过渡期内视同白名单
  const transitions: { ip: string; credName: string; until: number }[] = [
    ...Object.entries(token.transition_ips ?? {}).map(([ip, until]) => ({
      ip,
      credName: "主设备",
      until,
    })),
    ...(token.devices ?? []).flatMap((d) =>
      Object.entries(d.transition_ips ?? {}).map(([ip, until]) => ({
        ip,
        credName: d.name,
        until,
      }))
    ),
  ];

  const copyMigratedUrl = async () => {
    if (!migrated) return;
    if (await copyText(migrated.url)) {
      setCopiedMigrated(true);
      setTimeout(() => setCopiedMigrated(false), 1500);
    } else {
      // 微信内置浏览器等场景剪贴板不可用，给用户手动复制的兜底
      window.prompt("自动复制失败，请长按全选手动复制订阅链接：", migrated.url);
    }
  };

  if (ipStats.length === 0 && guardEntries.length === 0 && transitions.length === 0 && !migrated) return null;

  return (
    <div className="rounded-lg bg-slate-800/60 p-3 space-y-2">
      {pendingGuards.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
          <div className="text-sm sm:text-xs text-amber-300">待授权接入（系统自动拦截）</div>
          {pendingGuards.map(([ip, entry]) => (
            <div key={ip} className="space-y-1 text-sm sm:text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-amber-200">{ip}</span>
                <span className="text-slate-400 shrink-0">
                  {entry.geo ?? "归属地未知"} · {deviceNameOf(entry.uuid)} ·{" "}
                  {new Date(entry.at).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => decideGuard(ip, true)}
                  disabled={ipActionLoading === `dg-${ip}`}
                  className="rounded px-2 py-0.5 border border-emerald-500/50 text-emerald-400 text-xs hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                >
                  允许（加入白名单）
                </button>
                <button
                  onClick={() => decideGuard(ip, false)}
                  disabled={ipActionLoading === `dg-${ip}`}
                  className="rounded px-2 py-0.5 border border-rose-500/50 text-rose-400 text-xs hover:bg-rose-500/10 transition-colors disabled:opacity-50"
                >
                  保持拒绝
                </button>
              </div>
            </div>
          ))}
          <p className="text-sm leading-relaxed sm:text-xs text-slate-400">
            该凭证检测到多个来源 IP 同时在线，新出现的 IP 已被自动拦截。是你本人的新设备就点「允许」——
            系统会为它创建独立槽位（7 天过渡期内该 IP 可继续用旧链接）；否则点「保持拒绝」，并建议重新生成订阅链接。
          </p>
        </div>
      )}
      {migrated && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 space-y-1">
          <div className="text-sm sm:text-xs text-emerald-300">
            已为新设备创建独立槽位「{migrated.name}」，请在 7 天内让新设备导入专属链接
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-slate-900/60 px-2 py-1 text-xs text-slate-300">
              {migrated.url}
            </code>
            <button
              onClick={copyMigratedUrl}
              className="shrink-0 rounded px-2 py-0.5 border border-emerald-500/50 text-emerald-400 text-xs hover:bg-emerald-500/10 transition-colors"
            >
              {copiedMigrated ? "✓ 已复制" : "复制链接"}
            </button>
          </div>
          <p className="text-sm leading-relaxed sm:text-xs text-slate-400">
            过渡期结束后若新设备仍用旧链接接入，会被重新拦截；届时再到这里点「允许」即可（需槽位有余量）。
          </p>
        </div>
      )}
      {transitions.length > 0 && (
        <div className="space-y-1 text-sm sm:text-xs">
          <div className="text-slate-400">迁移过渡中</div>
          {transitions.map((t) => (
            <div key={`${t.credName}-${t.ip}`} className="flex items-center justify-between gap-2">
              <span className="font-mono text-slate-300">{t.ip}</span>
              <span className="text-slate-500 shrink-0">
                {t.credName} · 过渡中，剩 {Math.max(1, Math.ceil((t.until - Date.now()) / 86_400_000))} 天
              </span>
            </div>
          ))}
        </div>
      )}
      {ipStats.length > 0 && (
        <>
          <div className="flex justify-between text-sm sm:text-xs">
            <span className="text-slate-400">接入 IP 统计</span>
            <span className="text-slate-500">按连接数比例估算，仅供参考</span>
          </div>
          <div className="space-y-1 text-sm sm:text-xs">
            {ipStats.map(([ip, stat]) => {
              const blocked = blockedIpSet.has(ip);
              const guarded = token.device_guard?.[ip];
              return (
                <div key={ip} className="flex items-center justify-between gap-2">
                  <span className={`font-mono ${blocked ? "text-rose-400 line-through" : "text-slate-300"}`}>
                    {ip}
                    {guarded && (
                      <span className="ml-1 rounded bg-amber-500/20 px-1 text-amber-300 no-underline">
                        系统拦截
                      </span>
                    )}
                  </span>
                  <span className="text-slate-500 shrink-0">
                    {formatBytes(stat.bytes)} · {stat.conns} 次连接 ·{" "}
                    {new Date(stat.last_seen_at).toLocaleString("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <button
                    onClick={() => toggleBlockIp(ip, blocked)}
                    disabled={ipActionLoading === ip}
                    className={`shrink-0 rounded px-2 py-0.5 border text-xs transition-colors disabled:opacity-50 ${
                      blocked
                        ? "border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
                        : "border-rose-500/50 text-rose-400 hover:bg-rose-500/10"
                    }`}
                  >
                    {ipActionLoading === ip ? "…" : blocked ? "解封" : "封禁"}
                  </button>
                </div>
              );
            })}
          </div>
          <p className="text-sm leading-relaxed sm:text-xs text-slate-500">
            出现陌生 IP 说明订阅可能泄露：点「封禁」后该 IP 30 秒内无法连接任何节点，误封可随时解封。
            如需彻底重置凭证请联系售后。
          </p>
        </>
      )}
    </div>
  );
}
