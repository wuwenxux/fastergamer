import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import type { Token } from "../../../shared/types";
import { SHARE_SUSPENDED_COLOR, SHARE_SUSPENDED_LABEL, STATUS_COLOR, STATUS_LABEL } from "../lib/status";
import { api, type TokenView } from "../services/api";
import { copyText } from "../utils/clipboard";
import DeviceManager from "./DeviceManager";
import IpManager from "./IpManager";
import SubLinkManager, { SubImportButtons } from "./SubLinkManager";
import UpgradeFlow from "./UpgradeFlow";

type VerifyResult =
  | { valid: true; nodeCount: number }
  | { valid: false; error: string };

/**
 * 剩余有效期倒计时：自持 15s 低频 state，避免 1s 定时器带动整张卡片
 * （二维码 / IP 统计 / 订阅记录排序）每秒重渲染。展示格式与在线判定口径不变。
 */
function ExpireCountdown({ expiresAt, status }: { expiresAt: number; status: Token["status"] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const remainingMs = expiresAt - now;
  const active = status === "active" && remainingMs > 0;
  const days = Math.max(0, Math.floor(remainingMs / 86_400_000));
  const hours = Math.max(0, Math.floor((remainingMs % 86_400_000) / 3_600_000));
  return (
    <div className={active ? "text-emerald-300 font-semibold" : "text-rose-300"}>
      {active ? `${days} 天 ${hours} 小时` : "已到期"}
    </div>
  );
}

/**
 * Token 状态卡：状态总览、流量/到期展示、风险提醒、订阅链接与 uuid 轮换。
 * 升级续费（UpgradeFlow）、接入 IP 封禁（IpManager）、订阅导入与设备锁
 * （SubLinkManager / SubImportButtons）已拆为独立子组件。
 */
export default function TokenStatus({ token }: { token: TokenView }) {
  const [current, setCurrent] = useState<TokenView>(token);
  const [copied, setCopied] = useState(false);
  // 在线判定（90s 窗口）与多设备检测（24h 窗口）都无需秒级精度，30s 刷新即可
  const [now, setNow] = useState(Date.now());
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [preview, setPreview] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [monthlyQuotaGb, setMonthlyQuotaGb] = useState<number | null>(null);
  // 非本人激活时后端只返回概要（无 uuid），置此标记展示登录引导
  const [activatedRestricted, setActivatedRestricted] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [resetting, setResetting] = useState(false);

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

  // 低频刷新 now，供在线状态（90s 窗口）与多设备检测（24h 窗口）判定
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // 倒计时归零即视为到期，与徽标口径一致（状态翻转由后端扫描完成，这里只做展示修正）
  const active =
    current.status === "active" && !!current.expires_at && current.expires_at > now;
  const displayStatus: Token["status"] =
    current.status === "active" && current.expires_at !== undefined && current.expires_at <= now
      ? "expired"
      : current.status;
  // 共享嫌疑暂停：独立于 status/到期口径（暂停≠到期），徽标与提示条优先级最高，倒计时/在线判定不联动
  const shareSuspended = !!current.share_suspended_at;
  const navigate = useNavigate();

  const subUrl = api.subUrl(current.uuid);

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
      if (updated.restricted) {
        // 非本人激活：响应不含 uuid，只合并概要字段，保留本地已有数据
        setActivatedRestricted(true);
        setCurrent({
          ...current,
          status: updated.status,
          activated_at: updated.activated_at ?? current.activated_at,
          expires_at: updated.expires_at ?? current.expires_at,
        });
      } else {
        setCurrent(updated);
      }
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const copySub = async () => {
    // 裸链接不带名称片段：配置名由订阅响应头 profile-title 下发
    const url = api.subUrl(current.uuid);
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      // 微信内置浏览器等场景剪贴板不可用，给用户手动复制的兜底
      window.prompt("自动复制失败，请长按全选手动复制订阅链接：", url);
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

  // 自助重新生成订阅链接（不限次数）：旧 uuid 立即失效，页面切换到新链接
  const onRotate = async () => {
    if (!window.confirm(
      "确认重新生成订阅链接？\n旧链接将立即失效（全节点约 30 秒内生效），Clash 需要更新订阅或重新导入。"
    )) return;
    setRotating(true);
    try {
      const res = await api.rotateUuid(current.id);
      setCurrent({ ...current, uuid: res.uuid, rotated_at: Date.now(), online: false });
      setVerify(null);
      setPreview("");
      setShowPreview(false);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setRotating(false);
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

  // 自助重置流量：恢复满额，代价是有效期提前 30 天
  const onResetPenalty = async () => {
    if (!window.confirm("确认重置流量？\n流量将立即恢复满额，代价是有效期提前 30 天。")) return;
    setResetting(true);
    try {
      const updated = await api.resetPenalty(current.id);
      setCurrent(updated);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setResetting(false);
    }
  };

  // 去续费：购买页从 localStorage 的 fg_contact 预填邮箱，先把 token 的联系方式带过去（同口径参考 Tokens 页下单流程）
  const goRenew = () => {
    if (current.contact) {
      try {
        localStorage.setItem("fg_contact", current.contact);
      } catch {
        /* Safari 隐私模式等场景 localStorage 不可写，忽略即可 */
      }
    }
    navigate("/buy");
  };

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="text-sm text-slate-400">Token</div>
          <div className="font-mono text-[15px] sm:text-sm">{current.id}</div>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-medium ${
            shareSuspended ? SHARE_SUSPENDED_COLOR : STATUS_COLOR[displayStatus]
          }`}
        >
          {shareSuspended ? SHARE_SUSPENDED_LABEL : STATUS_LABEL[displayStatus]}
        </span>
        {isOnline && (
          <span className="rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/40 px-3 py-1 text-xs font-medium">
            当前在线
          </span>
        )}
      </div>

      {shareSuspended && (
        <div className="rounded-xl border border-orange-500/50 bg-orange-500/10 p-4 space-y-3">
          <p className="text-[15px] sm:text-sm font-medium text-orange-300">检测到账号共享，服务已暂停</p>
          <p className="text-sm leading-relaxed sm:text-xs text-slate-300">
            检测到该账号存在多人同时使用的行为，服务已暂停。续费任意套餐后将自动恢复。
          </p>
          <button
            onClick={goRenew}
            className="w-full rounded-lg bg-orange-500 py-3 sm:py-2.5 font-medium hover:bg-orange-400 transition-colors"
          >
            去续费
          </button>
        </div>
      )}

      {current.contact && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3">
          <div className="text-amber-400 text-sm sm:text-xs mb-1">售后联系方式（请牢记）</div>
          <div className="text-[15px] sm:text-sm break-all">{current.contact}</div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[15px] sm:text-sm">
        <div className="rounded-lg bg-slate-800/60 p-3">
          <div className="text-slate-400 text-sm sm:text-xs mb-1">UUID（即连接凭证）</div>
          <div className="font-mono break-all">{current.uuid}</div>
        </div>
        {current.expires_at && (
          <div className="rounded-lg bg-slate-800/60 p-3">
            <div className="text-slate-400 text-sm sm:text-xs mb-1">剩余有效期</div>
            <ExpireCountdown expiresAt={current.expires_at} status={current.status} />
          </div>
        )}
      </div>

      {current.last_active_at && (
        <div className="text-sm sm:text-xs text-slate-500">
          最近活跃：{new Date(current.last_active_at).toLocaleString()}
        </div>
      )}

      {limitGb > 0 && (
        <div className="rounded-lg bg-slate-800/60 p-3 space-y-2">
          <div className="flex justify-between text-sm sm:text-xs">
            <span className="text-slate-400">流量额度</span>
            <span className={trafficExhausted ? "text-rose-400 font-medium" : "text-slate-200"}>
              {usedGb.toFixed(2)} / {limitGb} GB
            </span>
          </div><div className="h-2 w-full rounded-full bg-slate-700 overflow-hidden">
            <div
              className={`h-full rounded-full ${
                trafficExhausted ? "bg-rose-500" : trafficPercent > 80 ? "bg-amber-500" : "bg-emerald-500"
              }`}
              style={{ width: `${trafficPercent}%` }}
            />
          </div>
          <div className="text-sm sm:text-xs text-slate-400">
            剩余 {remainingGb.toFixed(2)} GB{monthlyQuotaGb ? "（总流量）" : "（总额度，不限月）"}
          </div>
          {monthlyQuotaGb && (
            <div className="text-sm sm:text-xs text-slate-400">
              本月已用 {((current.month_used_bytes ?? 0) / 1024 ** 3).toFixed(2)} / {monthlyQuotaGb} GB
              <span className="text-slate-500">
                （当月用超将预支下月额度，有效期提前一个月；次月 1 日恢复新额度）
              </span>
            </div>
          )}
          {trafficExhausted && (
            <div className="space-y-2">
              <p className="text-sm leading-relaxed sm:text-xs text-amber-400">
                流量已用完。不会立即断线：48 小时宽限期内服务照常，请尽快
                <Link to="/buy" className="text-sky-400 hover:underline"> 续费 </Link>
                ；宽限期结束后服务才会暂停。
              </p>
              <button
                onClick={onResetPenalty}
                disabled={resetting}
                className="w-full rounded-lg border border-amber-500/50 bg-amber-500/10 py-3 sm:py-2 text-sm sm:text-xs font-medium text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-60"
              >
                {resetting ? "重置中…" : "立即重置流量（有效期 -30 天）"}
              </button>
            </div>
          )}
        </div>
      )}

      {limitGb <= 0 && (
        <div className="rounded-lg bg-slate-800/60 p-3 space-y-1">
          <div className="flex justify-between text-sm sm:text-xs">
            <span className="text-slate-400">流量</span>
            <span className="text-emerald-300 font-medium">不限量（公平使用）</span>
          </div>
          <div className="text-sm sm:text-xs text-slate-400">累计已用 {usedGb.toFixed(2)} GB</div>
        </div>
      )}

      {current.status === "paid" && (
        <button
          onClick={onActivate}
          className="w-full rounded-lg bg-emerald-500 py-3 sm:py-2.5 font-medium hover:bg-emerald-400 transition-colors"
        >
          ⚡ 立即激活（开始计时）
        </button>
      )}

      {activatedRestricted && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-2">
          <p className="text-[15px] sm:text-sm text-emerald-300">✅ 激活成功</p>
          <p className="text-sm sm:text-xs text-slate-400">
            在上方输入购买时填写的邮箱并发送登录链接，点邮件里的链接即可查看订阅信息。
          </p>
        </div>
      )}

      {active && (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4">
          <div>
            <div className="text-sky-300 text-sm sm:text-xs mb-1 font-medium">订阅链接（一键导入见下方按钮，或复制后粘贴到 Clash / sing-box / Stash）</div>
            <div className="font-mono text-[15px] sm:text-sm break-all text-sky-200 rounded-lg border border-sky-500/50 bg-sky-500/15 p-2.5 select-all">{subUrl}</div>
          </div>

          {shareSuspended && (
            <p className="text-sm leading-relaxed sm:text-xs text-orange-400">
              ⏸ 服务暂停期间，节点会拒绝该凭证的连接；续费后原订阅链接继续可用，无需重新导入或更换。
            </p>
          )}

          <p className="text-sm leading-relaxed sm:text-xs text-slate-300">
            这个链接<span className="text-sky-300">不是用浏览器直接打开的</span>，而是 Clash 用来下载配置的地址。复制链接 → 打开 Clash → 粘贴到「订阅/Profiles」里即可自动导入节点。
          </p>

          <p className="text-sm leading-relaxed sm:text-xs text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5">
            ⚡ 使用新版客户端（Clash Verge Rev / FlClash / Stash 等）导入后，节点列表会出现带 ⚡ 后缀的直连节点：
            延迟更低、不依赖域名解析、抗封锁更强。老客户端（Clash for Windows / ClashX）不受影响，可继续用原节点，但建议升级。
          </p>

          <p className="text-sm leading-relaxed sm:text-xs text-rose-400">
            ⚠️ 请勿把订阅链接分享给他人：UUID 就是全部连接凭证，泄露后会被他人盗用并消耗你的流量额度。
          </p>

          {current.multi_device_detected_at &&
            current.multi_device_detected_at > now - 24 * 3_600_000 && (
            <p className="text-sm leading-relaxed sm:text-xs text-amber-400">
              ⚠️ 检测到该凭证在多个节点同时在线（{new Date(current.multi_device_detected_at).toLocaleString()}）。
              如果是你自己多台设备同时使用可忽略；否则说明订阅链接可能已泄露，可点下方「重新生成订阅链接」更换，旧链接立即失效。
            </p>
          )}

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={copySub}
              className="rounded-lg bg-sky-500 py-3 sm:py-2.5 font-medium hover:bg-sky-400 transition-colors"
            >
              {copied ? "✓ 已复制" : "复制订阅链接"}
            </button>
            <button
              onClick={loadPreview}
              disabled={previewLoading}
              className="rounded-lg border border-slate-600 py-3 sm:py-2.5 font-medium hover:border-sky-500 transition-colors disabled:opacity-60"
            >
              {previewLoading ? "加载中…" : showPreview ? "隐藏配置内容" : "查看配置内容"}
            </button>
          </div>

          <SubImportButtons subUrl={subUrl} />

          {/* 下载配置文件：sub 接口已带 content-disposition，直接下载 .yaml/.json，
              客户端里选「导入本地文件」即可——适合 deep link 被拦截或想手动管理的场景 */}
          <div className="space-y-2">
            <p className="text-sm sm:text-xs text-slate-400">
              也可以下载配置文件，在客户端里选「导入 / Import → 本地文件」：
            </p>
            <div className="grid grid-cols-2 gap-3">
              <a
                href={`${subUrl}&format=clash`}
                download
                className="text-center rounded-lg border border-slate-600 py-3 sm:py-2.5 text-base sm:text-sm font-medium text-slate-300 hover:border-sky-500 hover:text-sky-300 transition-colors"
              >
                下载 Clash 配置 (.yaml)
              </a>
              <a
                href={`${subUrl}&format=singbox`}
                download
                className="text-center rounded-lg border border-slate-600 py-3 sm:py-2.5 text-base sm:text-sm font-medium text-slate-300 hover:border-sky-500 hover:text-sky-300 transition-colors"
              >
                下载 sing-box 配置 (.json)
              </a>
            </div>
          </div>

          {/* 跨设备导入：二维码内容是裸订阅链接（配置名由响应头 profile-title 下发）。
              深色主题下二维码必须垫白底，否则扫码对比度不够 */}
          <details className="rounded-lg border border-slate-700 bg-slate-900 p-3">
            <summary className="cursor-pointer text-[15px] sm:text-sm text-slate-300 select-none">
              在其他设备上导入 ▸
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-sm sm:text-xs text-slate-400">
                电脑上买的套餐，用手机客户端扫这个码直接导入。
              </p>
              <div className="flex justify-center">
                <div className="rounded-lg bg-white p-3">
                  <QRCodeSVG value={subUrl} size={168} />
                </div>
              </div>
            </div>
          </details>

          <button
            onClick={onVerify}
            disabled={verifying}
            className="w-full rounded-lg border border-emerald-500/50 bg-emerald-500/10 py-3 sm:py-2 font-medium text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-60"
          >
            {verifying ? "诊断中…" : "Clash 导入失败？一键诊断"}
          </button>

          {verify?.valid ? (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 space-y-2">
              <p className="text-sm sm:text-xs text-emerald-400">
                ✅ 订阅链接可以正常访问（含 {verify.nodeCount} 个节点），服务端没有问题。
              </p>
              <p className="text-sm sm:text-xs text-slate-300 font-medium">Clash 仍导入失败的话，按顺序排查：</p>
              <ol className="text-sm leading-relaxed sm:text-xs text-slate-400 list-decimal pl-4 space-y-1">
                <li>彻底退出其他 VPN / 加速器（右键状态栏图标选「退出」，只关窗口不够）</li>
                <li>Clash Verge：设置 → 订阅 → 关闭「使用系统代理」后重新导入</li>
                <li>确认复制的是完整链接（https:// 开头，没有多余空格或换行）</li>
                <li>换手机热点网络重试一次（排除宽带 DNS 污染）</li>
                <li>仍然失败 → 到「问题反馈」页提交，注明 Token ID，客服会邮件回复</li>
              </ol>
            </div>
          ) : verify ? (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 space-y-2">
              <p className="text-sm sm:text-xs text-rose-400">❌ 订阅链接无法访问：{verify.error}</p>
              <p className="text-sm sm:text-xs text-slate-400">
                说明问题在链接或服务端：确认 token 未过期；等 1 分钟后再试一次；仍失败请到「问题反馈」页提交（注明 Token ID：{current.id}）。
              </p>
            </div>
          ) : null}

          {showPreview && (
            <div className="rounded-lg bg-slate-900 border border-slate-700 p-3">
              <div className="text-xs text-slate-400 mb-2">配置预览（YAML）</div>
              <pre className="text-xs font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                {preview}
              </pre>
            </div>
          )}

          {/* 作废旧订阅属于危险操作，降级为卡片底部小按钮，避免与主操作混排误点 */}
          <div className="flex items-center justify-between gap-3 border-t border-slate-800 pt-3">
            <p className="text-sm leading-relaxed sm:text-xs text-slate-500">
              订阅泄露或凭证被盗用？重新生成后旧链接立即失效，Clash 需重新导入订阅。
            </p>
            <button
              onClick={onRotate}
              disabled={rotating}
              className="shrink-0 rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs text-amber-400/90 hover:bg-amber-500/10 transition-colors disabled:opacity-60"
            >
              {rotating ? "生成中…" : "重新生成订阅链接"}
            </button>
          </div>

        </div>
      )}

      <IpManager token={current} onChange={setCurrent} />

      <DeviceManager token={current} onChange={setCurrent} />

      <SubLinkManager token={current} now={now} onChange={setCurrent} />

      <UpgradeFlow token={current} now={now} onChange={setCurrent} />
    </div>
  );
}
