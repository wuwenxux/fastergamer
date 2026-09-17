import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import type { Order, Plan, Token } from "../../../shared/types";
import { api, type TokenView } from "../services/api";
import { copyText } from "../utils/clipboard";
import { usePlatform } from "./ClashGuide";
import DeviceManager from "./DeviceManager";
import ManualPay from "./ManualPay";

type VerifyResult =
  | { valid: true; nodeCount: number }
  | { valid: false; error: string };

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

export default function TokenStatus({ token }: { token: TokenView }) {
  const [current, setCurrent] = useState<TokenView>(token);
  const [copied, setCopied] = useState(false);
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
  const [plans, setPlans] = useState<Plan[]>([]);
  // 非本人激活时后端只返回概要（无 uuid），置此标记展示登录引导
  const [activatedRestricted, setActivatedRestricted] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [resetting, setResetting] = useState(false);
  // 升级套餐：已下单待支付的升级订单（扫码轮询中）；showUpgrade 控制套餐列表展开
  const [upgradeOrder, setUpgradeOrder] = useState<Order | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);

  // 套餐带月度配额时拉取配额值用于展示
  useEffect(() => {
    api
      .plans()
      .then((plans) => {
        setPlans(plans);
        const plan = plans.find((p) => p.id === current.plan_id);
        setMonthlyQuotaGb(plan?.monthly_quota_gb ?? null);
      })
      .catch(() => {});
  }, [current.plan_id]);

  // 升级订单扫码后轮询支付状态，平台回调升级完成后刷新 token；
  // 支付通道维护期订单不会变 paid，10 分钟后停止轮询并收起，避免无限空转
  useEffect(() => {
    if (!upgradeOrder) return;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60_000) {
        clearInterval(timer);
        setUpgradeOrder(null);
        return;
      }
      try {
        const s = await api.orderStatus(upgradeOrder.id);
        if (s.status === "paid") {
          clearInterval(timer);
          const updated = await api.getToken(current.id);
          setCurrent(updated);
          setUpgradeOrder(null);
        }
      } catch {
        /* 网络抖动忽略，下一轮再试 */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [upgradeOrder, current.id]);

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

  // 一键导入：按平台给出对应客户端的 deep link。订阅链接本身带 UA 自适应
  // （Clash UA 出 YAML、sing-box UA 出 JSON），deep link 直接传同一 URL 即可
  const platform = usePlatform();
  const platformOs = platform.split("-")[0];
  const subUrl = api.subUrl(current.uuid);
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

  const limitGb = current.traffic_limit_gb ?? 0;
  const usedGb = current.traffic_used_gb ?? 0;
  const remainingGb = Math.max(0, limitGb - usedGb);
  const trafficPercent = limitGb > 0 ? Math.min(100, (usedGb / limitGb) * 100) : 0;
  const trafficExhausted = limitGb > 0 && usedGb >= limitGb;

  const isOnline =
    current.online === true &&
    (current.online_updated_at ?? 0) > now - 90_000;

  // 接入 IP 统计（按估算流量降序，最多展示 10 条）
  const ipStats = Object.entries(current.traffic_by_ip ?? {})
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 10);

  const formatBytes = (bytes: number) =>
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
      : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

  const blockedIpSet = new Set(current.blocked_ips ?? []);
  const [ipActionLoading, setIpActionLoading] = useState<string | null>(null);

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

  // 各订阅（主设备 + 设备槽位）最近一次拉取记录，按时间倒序
  const deviceNameByUuid = new Map<string, string>([
    [current.uuid, "主设备"],
    ...(current.devices ?? []).map((d) => [d.uuid, d.name] as [string, string]),
  ]);
  const subFetchRows = Object.entries(current.sub_fetches ?? {})
    .map(([subUuid, f]) => ({
      subUuid,
      deviceName: deviceNameByUuid.get(subUuid) ?? "旧凭证/未知设备",
      client: clientLabel(f.ua),
      ip: f.ip,
      at: f.at,
    }))
    .sort((a, b) => b.at - a.at);

  const toggleBlockIp = async (ip: string, blocked: boolean) => {
    if (!blocked && !window.confirm(`确认封禁 ${ip}？\n该 IP 将在 30 秒内被所有节点拒绝连接（若它是多人共享的出口网络，同网络的其他设备也会无法使用）。`)) {
      return;
    }
    setIpActionLoading(ip);
    try {
      const res = blocked
        ? await api.unblockIp(current.id, ip)
        : await api.blockIp(current.id, ip);
      setCurrent({ ...current, blocked_ips: res.blocked_ips });
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setIpActionLoading(null);
    }
  };

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
    // 带 #fastergamer 名称片段：粘贴导入时配置名与扫码/一键导入一致（片段不进请求）
    const url = `${api.subUrl(current.uuid)}#fastergamer`;
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

  // 可升级的目标套餐：价格高于当前套餐（排除免费体验）
  const currentPlan = plans.find((p) => p.id === current.plan_id);
  const upgradeTargets =
    current.status === "revoked" || !currentPlan
      ? []
      : plans.filter((p) => p.id !== "plan_3days" && p.price_cny > currentPlan.price_cny);

  // 试用 token（含已过期）随时可充值转正：入口常驻，不受「不够用」门槛限制
  const isTrial = current.plan_id === "plan_3days";
  // 升级入口只在「不够用」时出现：流量剩余 ≤10%，或设备槽（主设备+子设备）已满
  const trafficLow =
    current.traffic_limit_gb > 0 &&
    (current.traffic_limit_gb - current.traffic_used_gb) / current.traffic_limit_gb <= 0.1;
  const maxDevices = current.max_devices ?? currentPlan?.max_devices ?? 2;
  const deviceFull = 1 + (current.devices?.length ?? 0) >= maxDevices;
  const needUpgrade = upgradeTargets.length > 0 && (trafficLow || deviceFull || isTrial);

  // 预估补差价（与后端同公式：旧套餐价 × 剩余有效期比例折抵；未激活按全额剩余）
  const estimatePayable = (target: Plan): number => {
    if (!currentPlan) return target.price_cny;
    const durationMs = currentPlan.duration_days * 86_400_000;
    const remaining = current.expires_at
      ? Math.max(current.expires_at - now, 0)
      : durationMs;
    const credit = currentPlan.price_cny * Math.min(remaining / durationMs, 1);
    return Math.max(0, Math.round((target.price_cny - credit) * 100) / 100);
  };

  const startUpgrade = async (targetId: string) => {
    setUpgrading(targetId);
    try {
      const res = await api.upgradeToken(current.id, targetId);
      if (res.paid && res.token) {
        // 差价 ≤ 0 免费升级：立即生效
        setCurrent(res.token);
      } else {
        setUpgradeOrder(res.order);
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUpgrading(null);
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
          </div><div className="h-2 w-full rounded-full bg-slate-700 overflow-hidden">
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
            <div className="space-y-2">
              <p className="text-xs text-amber-400">
                流量已用完。不会立即断线：48 小时宽限期内服务照常，请尽快
                <Link to="/" className="text-sky-400 hover:underline"> 续费 </Link>
                ；宽限期结束后服务才会暂停。
              </p>
              <button
                onClick={onResetPenalty}
                disabled={resetting}
                className="w-full rounded-lg border border-amber-500/50 bg-amber-500/10 py-2 text-xs font-medium text-amber-400 hover:bg-amber-500/20 transition-colors disabled:opacity-60"
              >
                {resetting ? "重置中…" : "立即重置流量（有效期 -30 天）"}
              </button>
            </div>
          )}
        </div>
      )}

      {limitGb <= 0 && (
        <div className="rounded-lg bg-slate-800/60 p-3 space-y-1">
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">流量</span>
            <span className="text-emerald-300 font-medium">不限量（公平使用）</span>
          </div>
          <div className="text-xs text-slate-400">累计已用 {usedGb.toFixed(2)} GB</div>
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

      {activatedRestricted && (
        <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 space-y-2">
          <p className="text-sm text-emerald-300">✅ 激活成功</p>
          <p className="text-xs text-slate-400">
            在上方输入购买时填写的邮箱并发送登录链接，点邮件里的链接即可查看订阅信息。
          </p>
        </div>
      )}

      {active && (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-950 p-4">
          <div>
            <div className="text-sky-300 text-xs mb-1 font-medium">订阅链接（一键导入见下方按钮，或复制后粘贴到 Clash / sing-box / Stash）</div>
            <div className="font-mono text-sm break-all text-sky-200 rounded-lg border border-sky-500/50 bg-sky-500/15 p-2.5 select-all">{subUrl}#fastergamer</div>
          </div>

          <p className="text-xs text-slate-300">
            这个链接<span className="text-sky-300">不是用浏览器直接打开的</span>，而是 Clash 用来下载配置的地址。复制链接 → 打开 Clash → 粘贴到「订阅/Profiles」里即可自动导入节点。
          </p>

          <p className="text-xs text-emerald-300/90 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5">
            ⚡ 使用新版客户端（Clash Verge Rev / FlClash / Stash 等）导入后，节点列表会出现带 ⚡ 后缀的直连节点：
            延迟更低、不依赖域名解析、抗封锁更强。老客户端（Clash for Windows / ClashX）不受影响，可继续用原节点，但建议升级。
          </p>

          <p className="text-xs text-rose-400">
            ⚠️ 请勿把订阅链接分享给他人：UUID 就是全部连接凭证，泄露后会被他人盗用并消耗你的流量额度。
          </p>

          {current.multi_device_detected_at &&
            current.multi_device_detected_at > now - 24 * 3_600_000 && (
            <p className="text-xs text-amber-400">
              ⚠️ 检测到该凭证在多个节点同时在线（{new Date(current.multi_device_detected_at).toLocaleString()}）。
              如果是你自己多台设备同时使用可忽略；否则说明订阅链接可能已泄露，可点下方「重新生成订阅链接」更换，旧链接立即失效。
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

          {/* 一键导入：deep link 必须放在 onClick（用户手势）里跳转，否则浏览器会拦截自定义协议 */}
          {importLinks.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">
                手机点一下直接唤起客户端完成导入，不用复制粘贴：
              </p>
              <div className={`grid gap-3 ${importLinks.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
                {importLinks.map((l) => (
                  <button
                    key={l.label}
                    onClick={() => {
                      window.location.href = l.href;
                    }}
                    className="rounded-lg border border-sky-500/50 bg-sky-500/10 py-2.5 font-medium text-sky-300 hover:bg-sky-500/20 transition-colors"
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 下载配置文件：sub 接口已带 content-disposition，直接下载 .yaml/.json，
              客户端里选「导入本地文件」即可——适合 deep link 被拦截或想手动管理的场景 */}
          <div className="space-y-2">
            <p className="text-xs text-slate-400">
              也可以下载配置文件，在客户端里选「导入 / Import → 本地文件」：
            </p>
            <div className="grid grid-cols-2 gap-3">
              <a
                href={`${subUrl}&format=clash`}
                download
                className="text-center rounded-lg border border-slate-600 py-2.5 text-sm font-medium text-slate-300 hover:border-sky-500 hover:text-sky-300 transition-colors"
              >
                下载 Clash 配置 (.yaml)
              </a>
              <a
                href={`${subUrl}&format=singbox`}
                download
                className="text-center rounded-lg border border-slate-600 py-2.5 text-sm font-medium text-slate-300 hover:border-sky-500 hover:text-sky-300 transition-colors"
              >
                下载 sing-box 配置 (.json)
              </a>
            </div>
          </div>

          {/* 跨设备导入：二维码内容是订阅链接 + #fastergamer 名称片段（扫码导入后
              配置文件名与一键导入/deep link 一致；片段不进请求，不识别则忽略）。
              深色主题下二维码必须垫白底，否则扫码对比度不够 */}
          <details className="rounded-lg border border-slate-700 bg-slate-900 p-3">
            <summary className="cursor-pointer text-sm text-slate-300 select-none">
              在其他设备上导入 ▸
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-xs text-slate-400">
                电脑上买的套餐，用手机客户端扫这个码直接导入。
              </p>
              <div className="flex justify-center">
                <div className="rounded-lg bg-white p-3">
                  <QRCodeSVG value={`${subUrl}#fastergamer`} size={168} />
                </div>
              </div>
            </div>
          </details>

          <button
            onClick={onVerify}
            disabled={verifying}
            className="w-full rounded-lg border border-emerald-500/50 bg-emerald-500/10 py-2 font-medium text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-60"
          >
            {verifying ? "诊断中…" : "Clash 导入失败？一键诊断"}
          </button>

          {verify?.valid ? (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 space-y-2">
              <p className="text-xs text-emerald-400">
                ✅ 订阅链接可以正常访问（含 {verify.nodeCount} 个节点），服务端没有问题。
              </p>
              <p className="text-xs text-slate-300 font-medium">Clash 仍导入失败的话，按顺序排查：</p>
              <ol className="text-xs text-slate-400 list-decimal pl-4 space-y-1">
                <li>彻底退出其他 VPN / 加速器（右键状态栏图标选「退出」，只关窗口不够）</li>
                <li>Clash Verge：设置 → 订阅 → 关闭「使用系统代理」后重新导入</li>
                <li>确认复制的是完整链接（https:// 开头，没有多余空格或换行）</li>
                <li>换手机热点网络重试一次（排除宽带 DNS 污染）</li>
                <li>仍然失败 → 到「问题反馈」页提交，注明 Token ID，客服会邮件回复</li>
              </ol>
            </div>
          ) : verify ? (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 space-y-2">
              <p className="text-xs text-rose-400">❌ 订阅链接无法访问：{verify.error}</p>
              <p className="text-xs text-slate-400">
                说明问题在链接或服务端：确认 token 未过期；等 1 分钟后再试一次；仍失败请到「问题反馈」页提交（注明 Token ID：{current.id}）。
              </p>
            </div>
          ) : null}

          {showPreview && (
            <div className="rounded-lg bg-slate-900 border border-slate-700 p-3">
              <div className="text-xs text-slate-400 mb-2">配置预览（YAML）</div>
              <pre className="text-[10px] font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                {preview}
              </pre>
            </div>
          )}

          {/* 作废旧订阅属于危险操作，降级为卡片底部小按钮，避免与主操作混排误点 */}
          <div className="flex items-center justify-between gap-3 border-t border-slate-800 pt-3">
            <p className="text-[11px] text-slate-500">
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

      {ipStats.length > 0 && (
        <div className="rounded-lg bg-slate-800/60 p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">接入 IP 统计</span>
            <span className="text-slate-500">按连接数比例估算，仅供参考</span>
          </div>
          <div className="space-y-1 text-xs">
            {ipStats.map(([ip, stat]) => {
              const blocked = blockedIpSet.has(ip);
              return (
                <div key={ip} className="flex items-center justify-between gap-2">
                  <span className={`font-mono ${blocked ? "text-rose-400 line-through" : "text-slate-300"}`}>
                    {ip}
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
                    className={`shrink-0 rounded px-2 py-0.5 border text-[11px] transition-colors disabled:opacity-50 ${
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
          <p className="text-[11px] text-slate-500">
            出现陌生 IP 说明订阅可能泄露：点「封禁」后该 IP 30 秒内无法连接任何节点，误封可随时解封。
            如需彻底重置凭证请联系售后。
          </p>
        </div>
      )}

      <DeviceManager token={current} onChange={setCurrent} />

      {subFetchRows.length > 0 && (
        <div className="rounded-lg bg-slate-800/60 p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">订阅客户端</span>
            <span className="text-slate-500">各设备最近一次更新订阅</span>
          </div>
          <div className="space-y-1 text-xs">
            {subFetchRows.map((row) => (
              <div key={row.subUuid} className="flex items-center justify-between gap-2">
                <span className="text-slate-300">
                  {row.deviceName}
                  <span className="text-sky-300/90 ml-2">{row.client}</span>
                </span>
                <span className="text-slate-500 shrink-0">
                  {row.ip ? `${row.ip} · ` : ""}
                  {new Date(row.at).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            客户端类型变了（比如从 Clash 变成 Shadowrocket）通常说明在新设备上导入了订阅；
            建议给每台设备绑定独立槽位，用量与在线状态才能分开审计。
          </p>
        </div>
      )}

      {upgradeOrder && (
        <div className="rounded-xl border border-sky-500/50 bg-sky-500/10 p-4 space-y-3">
          <p className="text-sm font-medium text-sky-300 text-center">
            升级订单已创建，扫码补差价后点「我已支付」
          </p>
          <ManualPay orderId={upgradeOrder.id} payableCny={upgradeOrder.payable_cny ?? 0} />
          <button
            onClick={() => setUpgradeOrder(null)}
            className="block mx-auto text-xs text-slate-500 hover:text-slate-300"
          >
            收起
          </button>
        </div>
      )}

      {needUpgrade && !upgradeOrder && !showUpgrade && (
        <button
          onClick={() => setShowUpgrade(true)}
          className="w-full rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-300 hover:bg-amber-500/20 transition-colors"
        >
          {isTrial
            ? "试用转正专享：充值送 30 天，剩余天数并入首月，订阅链接不变 →"
            : `${trafficLow ? "流量快用完了" : "设备槽已满"}，点这里升级套餐 →`}
        </button>
      )}

      {needUpgrade && !upgradeOrder && showUpgrade && (
        <div className="rounded-xl border border-slate-700 bg-slate-950 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-slate-300">
              {isTrial ? "充值转正" : "升级套餐"}
            </div>
            <button
              onClick={() => setShowUpgrade(false)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              收起
            </button>
          </div>
          {isTrial && (
            <p className="text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              试用转正专享：额外赠送 30 天，试用期内剩余天数自动并入开通后第一个月；uuid、订阅链接与设备配置保持不变。
            </p>
          )}
          <div className="space-y-2">
            {upgradeTargets.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {p.name}
                  <span className="text-xs text-slate-500 ml-2">¥{p.price_cny} / {p.duration_days} 天</span>
                </span>
                <button
                  onClick={() => startUpgrade(p.id)}
                  disabled={upgrading !== null}
                  className="shrink-0 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
                >
                  {upgrading === p.id ? "下单中…" : isTrial ? `¥${estimatePayable(p)} 充值` : `≈¥${estimatePayable(p)} 升级`}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
