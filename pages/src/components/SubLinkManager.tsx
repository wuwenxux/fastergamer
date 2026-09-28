import { useState } from "react";
import { Link } from "react-router-dom";
import { subFpLabel } from "../lib/sub-fp";
import { api, type TokenView } from "../services/api";
import { usePlatform } from "./platform";

// 订阅客户端识别：UA 原文解析成熟客户端名（只覆盖我们客户端教程推荐的常见款）
const clientLabel = (ua: string): string => {
  if (/Shadowrocket/i.test(ua)) return "Shadowrocket · iOS";
  if (/Stash/i.test(ua)) return "Stash · iOS";
  if (/SFA|SFI|sing-box/.test(ua)) return "sing-box";
  if (/v2rayNG/i.test(ua)) return "v2rayNG · Android";
  if (/NekoBox/i.test(ua)) return "NekoBox · Android";
  if (/Clash/i.test(ua)) return "Clash 系";
  return ua.slice(0, 32) || "未知客户端";
};

/**
 * 一键导入（从 TokenStatus 拆出）：按平台给出对应客户端的 deep link。订阅链接本身带
 * UA 自适应（Clash UA 出 YAML、sing-box UA 出 JSON），deep link 直接传同一 URL 即可
 */
export function SubImportButtons({ subUrl }: { subUrl: string }) {
  const platform = usePlatform();
  const platformOs = platform.split("-")[0];
  const encSubUrl = encodeURIComponent(subUrl);
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
      : platformOs
      ? [{ label: "一键导入到 Clash", href: `clash://install-config?url=${encSubUrl}&name=fastergamer` }]
      : [];

  if (importLinks.length === 0) return null;

  return (
    <div className="space-y-2">
      {/* 一键导入：deep link 必须放在 onClick（用户手势）里跳转，否则浏览器会拦截自定义协议 */}
      <p className="text-sm sm:text-xs text-slate-400">
        手机点一下直接唤起客户端完成导入，不用复制粘贴：
      </p>
      <div className={`grid gap-3 ${importLinks.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
        {importLinks.map((l) => (
          <button
            key={l.label}
            onClick={() => {
              window.location.href = l.href;
            }}
            className="rounded-lg border border-sky-500/50 bg-sky-500/10 py-3 sm:py-2.5 font-medium text-sky-300 hover:bg-sky-500/20 transition-colors"
          >
            {l.label}
          </button>
        ))}
      </div>
      {/* 深链依赖已装客户端，未安装时点了没反应，给出路 */}
      <p className="text-center text-sm sm:text-xs text-slate-500">
        点了没反应？说明还没安装客户端，先去
        <Link to="/guide" className="text-sky-400 hover:underline"> 使用教程 </Link>
        下载安装。
      </p>
    </div>
  );
}

/**
 * 订阅拉取记录 + 设备锁解绑（从 TokenStatus 拆出）：聚合主设备与各设备槽位最近一次
 * 拉取记录与设备锁绑定（按键取并集、按时间倒序），并提供 7 天冷却的自助解绑入口。
 */
export default function SubLinkManager({
  token,
  now,
  onChange,
}: {
  token: TokenView;
  now: number;
  onChange: (t: TokenView) => void;
}) {
  // 解除订阅绑定（7 天冷却）：冷却中按钮禁用并显示剩余天数
  const [unbinding, setUnbinding] = useState(false);
  const SUB_UNBIND_COOLDOWN_MS = 7 * 86_400_000;
  const unbindRemainMs = Math.max(
    0,
    (token.sub_unbind_at ?? 0) + SUB_UNBIND_COOLDOWN_MS - now
  );

  // 并集是为了兜住「有绑定但拉取记录缺失」的极端情况（正常两者同生同灭）
  const deviceNameByUuid = new Map<string, string>([
    [token.uuid, "主设备"],
    ...(token.devices ?? []).map((d) => [d.uuid, d.name] as [string, string]),
  ]);
  const subFps = token.sub_fps ?? {};
  const subFetchRows = [
    ...new Set([...Object.keys(token.sub_fetches ?? {}), ...Object.keys(subFps)]),
  ]
    .map((subUuid) => {
      const f = token.sub_fetches?.[subUuid];
      const bindings = Object.entries(subFps[subUuid] ?? {})
        .map(([fp, b]) => ({ fp, label: subFpLabel(fp), at: b.at }))
        .sort((a, b) => b.at - a.at);
      return {
        subUuid,
        deviceName: deviceNameByUuid.get(subUuid) ?? "旧凭证/未知设备",
        client: f ? clientLabel(f.ua) : undefined,
        ip: f?.ip,
        bindings,
        at: f?.at ?? bindings[0]?.at ?? 0,
      };
    })
    .sort((a, b) => b.at - a.at);

  const onSubUnbind = async () => {
    if (
      !window.confirm(
        "确认解除全部订阅绑定？\n解绑后原设备将无法更新订阅，需要在客户端重新导入；下一个导入的客户端会成为新绑定。7 天内只能解绑一次。"
      )
    )
      return;
    setUnbinding(true);
    try {
      const res = await api.subUnbind(token.id);
      onChange({ ...token, sub_unbind_at: res.sub_unbind_at, sub_fps: {} });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUnbinding(false);
    }
  };

  if (subFetchRows.length === 0) return null;

  return (
    <div className="rounded-lg bg-slate-800/60 p-3 space-y-2">
      <div className="flex justify-between text-sm sm:text-xs">
        <span className="text-slate-400">订阅客户端</span>
        <span className="text-slate-500">各设备最近一次更新订阅</span>
      </div>
      <div className="space-y-1 text-sm sm:text-xs">
        {subFetchRows.map((row) => (
          <div key={row.subUuid} className="space-y-0.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-300">
                {row.deviceName}
                {row.client && <span className="text-sky-300/90 ml-2">{row.client}</span>}
              </span>
              <span className="text-slate-500 shrink-0">
                {row.ip ? `${row.ip} · ` : ""}
                {row.at > 0 &&
                  new Date(row.at).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
              </span>
            </div>
            {row.bindings.map((b) => (
              <div key={b.fp} className="text-slate-500">
                已绑定 {b.label} ·{" "}
                {new Date(b.at).toLocaleString("zh-CN", {
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="text-sm leading-relaxed sm:text-xs text-slate-500">
        客户端类型变了（比如从 Clash 变成 Shadowrocket）通常说明在新设备上导入了订阅；
        建议给每台设备绑定独立槽位，用量与在线状态才能分开审计。
      </p>
      {/* 解绑属于低频救济操作，降级为卡片底部小按钮；冷却中禁用并显示剩余天数 */}
      <div className="flex items-center justify-between gap-3 border-t border-slate-700 pt-2">
        <p className="text-sm leading-relaxed sm:text-xs text-slate-500">
          每条订阅链接绑定首个导入的客户端；换手机请先解绑再重新导入，30 天未使用的绑定自动过期。
        </p>
        <button
          onClick={onSubUnbind}
          disabled={unbinding || unbindRemainMs > 0}
          className="shrink-0 rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs text-amber-400/90 hover:bg-amber-500/10 transition-colors disabled:opacity-60"
        >
          {unbinding
            ? "解绑中…"
            : unbindRemainMs > 0
            ? `${Math.ceil(unbindRemainMs / 86_400_000)} 天后可解绑`
            : "解除订阅绑定"}
        </button>
      </div>
    </div>
  );
}
