import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { isTrialPlan, type Order, type Plan } from "../../../shared/types";
import { api, type TokenView } from "../services/api";
import { usePolling } from "../utils/polling";
import ManualPay from "./ManualPay";

/**
 * 升级/续费流程（从 TokenStatus 拆出）：套餐加载、补差价下单、订单轮询。
 * 人工收款确认（置 paid）后轮询到即刷新 token；10 分钟未确认停止轮询，
 * 卡片保留并给订单查询指引。展示与交互口径与拆分前一致。
 */
export default function UpgradeFlow({
  token,
  now,
  onChange,
}: {
  token: TokenView;
  now: number;
  onChange: (t: TokenView) => void;
}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  // 升级套餐：已下单待确认的升级订单（轮询订单状态中）；showUpgrade 控制套餐列表展开
  const [upgradeOrder, setUpgradeOrder] = useState<Order | null>(null);
  const [upgrading, setUpgrading] = useState<string | null>(null);
  const [showUpgrade, setShowUpgrade] = useState(false);
  // 升级轮询超过 10 分钟停止（人工收款确认没那么快），卡片保留并给订单查询指引
  const [upgradePollStopped, setUpgradePollStopped] = useState(false);

  // api.plans 自带 5 分钟缓存（与 TokenStatus / DeviceManager 共享同一 Promise），重复调用不产生新请求
  useEffect(() => {
    api
      .plans()
      .then(setPlans)
      .catch(() => {});
  }, []);

  // 升级订单轮询支付状态，管理员确认（置 paid）升级完成后刷新 token；
  // 10 分钟后停止轮询（人工收款确认可能更久），卡片保留并展示订单查询入口
  usePolling(
    !!upgradeOrder,
    async () => {
      if (!upgradeOrder) return false;
      const s = await api.orderStatus(upgradeOrder.id);
      if (s.status === "paid") {
        const updated = await api.getToken(token.id);
        onChange(updated);
        setUpgradeOrder(null);
        return false;
      }
    },
    { intervalMs: 3000, timeoutMs: 10 * 60_000, onTimeout: () => setUpgradePollStopped(true) }
  );

  // 可升级的目标套餐：价格高于当前套餐（排除免费体验）
  const currentPlan = plans.find((p) => p.id === token.plan_id);
  const upgradeTargets =
    token.status === "revoked" || !currentPlan
      ? []
      : plans.filter((p) => !isTrialPlan(p.id) && p.price_cny > currentPlan.price_cny);

  // 试用 token（含已过期）随时可充值转正：入口常驻，不受「不够用」门槛限制
  const isTrial = isTrialPlan(token.plan_id);
  // 升级入口只在「不够用」时出现：流量剩余 ≤10%，或设备槽（主设备+子设备）已满
  const trafficLow =
    token.traffic_limit_gb > 0 &&
    (token.traffic_limit_gb - token.traffic_used_gb) / token.traffic_limit_gb <= 0.1;
  const maxDevices = token.max_devices ?? currentPlan?.max_devices ?? 2;
  const deviceFull = 1 + (token.devices?.length ?? 0) >= maxDevices;
  const needUpgrade = upgradeTargets.length > 0 && (trafficLow || deviceFull || isTrial);

  // 预估补差价（与后端同公式：旧套餐价 × 剩余有效期比例折抵；未激活按全额剩余）
  const estimatePayable = (target: Plan): number => {
    if (!currentPlan) return target.price_cny;
    const durationMs = currentPlan.duration_days * 86_400_000;
    const remaining = token.expires_at
      ? Math.max(token.expires_at - now, 0)
      : durationMs;
    const credit = currentPlan.price_cny * Math.min(remaining / durationMs, 1);
    return Math.max(0, Math.round((target.price_cny - credit) * 100) / 100);
  };

  const startUpgrade = async (targetId: string) => {
    setUpgrading(targetId);
    try {
      const res = await api.upgradeToken(token.id, targetId);
      if (res.paid && res.token) {
        // 差价 ≤ 0 免费升级：立即生效
        onChange(res.token);
      } else {
        setUpgradePollStopped(false);
        setUpgradeOrder(res.order);
      }
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUpgrading(null);
    }
  };

  return (
    <>
      {upgradeOrder && (
        <div className="rounded-xl border border-sky-500/50 bg-sky-500/10 p-4 space-y-3">
          <p className="text-[15px] sm:text-sm font-medium text-sky-300 text-center">
            升级订单已创建，扫码补差价后点「我已支付」
          </p>
          <ManualPay orderId={upgradeOrder.id} payableCny={upgradeOrder.payable_cny ?? 0} />
          {upgradePollStopped && (
            <p className="text-center text-[15px] leading-relaxed sm:text-sm text-slate-400">
              客服确认收款后自动生效。页面关闭了也没关系，随时可到
              <Link to={`/orders/${upgradeOrder.id}`} className="text-sky-400 hover:underline"> 订单查询 </Link>
              页看进度。
            </p>
          )}
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
          className="w-full rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-base sm:text-sm text-amber-300 hover:bg-amber-500/20 transition-colors"
        >
          {isTrial
            ? "续费开通专享：送 30 天，剩余天数并入首月，订阅链接不变 →"
            : `${trafficLow ? "流量快用完了" : "设备槽已满"}，点这里升级套餐 →`}
        </button>
      )}

      {needUpgrade && !upgradeOrder && showUpgrade && (
        <div className="rounded-xl border border-slate-700 bg-slate-950 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[15px] sm:text-sm font-medium text-slate-300">
              {isTrial ? "续费开通" : "升级套餐"}
            </div>
            <button
              onClick={() => setShowUpgrade(false)}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              收起
            </button>
          </div>
          {isTrial && (
            <p className="text-sm leading-relaxed sm:text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              续费开通专享：额外赠送 30 天，试用期内剩余天数自动并入开通后第一个月；uuid、订阅链接与设备配置保持不变。
            </p>
          )}
          <div className="space-y-2">
            {upgradeTargets.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 text-[15px] sm:text-sm">
                <span>
                  {p.name}
                  <span className="text-sm sm:text-xs text-slate-500 ml-2">¥{p.price_cny} / {p.duration_days} 天</span>
                </span>
                <button
                  onClick={() => startUpgrade(p.id)}
                  disabled={upgrading !== null}
                  className="shrink-0 rounded-lg bg-sky-500 px-3 py-2 sm:py-1.5 text-sm sm:text-xs font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
                >
                  {upgrading === p.id ? "下单中…" : isTrial ? `¥${estimatePayable(p)} 续费` : `≈¥${estimatePayable(p)} 升级`}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
