import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import type { Order, Plan } from "../../../shared/types";
import PaymentModal from "../components/PaymentModal";
import { api } from "../services/api";

type Step = "summary" | "paying" | "result";

export default function Purchase() {
  const [params] = useSearchParams();
  const planId = params.get("plan") ?? "";

  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState<Step>("summary");
  const [processing, setProcessing] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [contact, setContact] = useState(() => localStorage.getItem("fg_contact") ?? "");

  // 根据 plan 参数加载套餐信息
  useEffect(() => {
    api
      .plans()
      .then((plans) => {
        const found = plans.find((p) => p.id === planId);
        if (!found) setError("未找到该套餐，请返回选择");
        setPlan(found ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [planId]);

  const submitOrder = async () => {
    if (!plan) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim())) {
      setError("请填写真实可用的邮箱，token 和售后都通过邮件联系你");
      return;
    }
    setProcessing(true);
    try {
      // 带上 localStorage 里的推广码（首页 ?ref= 捕获），未领试用直接下单也能归因
      const ref = localStorage.getItem("fg_ref") ?? undefined;
      const res = await api.createOrder(plan.id, contact.trim(), ref);
      localStorage.setItem("fg_contact", contact.trim()); // 记住邮箱，下次下单免填
      setOrder(res.order);
      setStep("result");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProcessing(false);
    }
  };

  if (step === "result" && order && plan) {
    return <PaymentResult order={order} plan={plan} />;
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">确认订单</h2>

      {error && <p className="text-rose-400 text-sm">{error}</p>}

      {plan && (
        <>
          <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
            <div className="flex justify-between">
              <span className="text-slate-400">套餐</span>
              <span className="font-medium">{plan.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">有效期</span>
              <span>{plan.duration_days} 天</span>
            </div>
            {typeof plan.traffic_limit_gb === "number" && (
              <div className="flex justify-between">
                <span className="text-slate-400">总流量</span>
                <span>{plan.traffic_limit_gb > 0 ? `${plan.traffic_limit_gb} GB` : "不限量（公平使用）"}</span>
              </div>
            )}
            <div className="flex justify-between items-baseline border-t border-slate-700 pt-4">
              <span className="text-slate-400">应付</span>
              <span className="text-3xl font-bold text-sky-400">¥{plan.price_cny}</span>
            </div>
          </div>

          <button
            onClick={() => setStep("paying")}
            className="w-full rounded-lg bg-sky-500 py-3 font-medium hover:bg-sky-400 transition-colors"
          >
            去支付
          </button>
        </>
      )}

      {step === "paying" && plan && (
        <PaymentModal
          plan={plan}
          contact={contact}
          onContactChange={setContact}
          processing={processing}
          onConfirm={submitOrder}
          onClose={() => setStep("summary")}
        />
      )}
    </div>
  );
}

/** 下单后的扫码支付页：有当面付二维码则走自动到账，否则支付宝账号转账 + 人工确认 */
function PaymentResult({ order, plan }: { order: Order; plan: Plan }) {
  const [copied, setCopied] = useState(false);
  const [copiedAccount, setCopiedAccount] = useState(false);
  const [copiedEmail, setCopiedEmail] = useState(false);
  // 推广减免后实付 0 元的订单在创建时已直接发货
  const [paid, setPaid] = useState(order.status === "paid");
  const dynamicQr = order.alipay_qr_code;
  const payable = order.payable_cny ?? plan.price_cny;
  const discount = order.discount_cny ?? 0;

  // 静态转账模式：加载支付宝收款账号（未配置时回退收款码图片）
  const [alipayAccount, setAlipayAccount] = useState<string | null>(null);
  useEffect(() => {
    if (dynamicQr) return;
    api
      .paymentInfo()
      .then((info) => setAlipayAccount(info.alipay_account))
      .catch(() => {});
  }, [dynamicQr]);

  // 当面付模式：轮询订单状态，支付成功（支付宝回调发货）后自动跳转提示
  useEffect(() => {
    if (!dynamicQr || paid) return;
    const timer = setInterval(async () => {
      try {
        const s = await api.orderStatus(order.id);
        if (s.status === "paid") {
          setPaid(true);
          clearInterval(timer);
        }
      } catch {
        /* 网络抖动忽略，下一轮再试 */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [dynamicQr, paid, order.id]);

  const copyOrderId = async () => {
    try {
      await navigator.clipboard.writeText(order.id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  if (paid) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-8 text-center space-y-3">
          <div className="text-4xl">✅</div>
          <h2 className="text-xl font-semibold text-emerald-300">支付成功</h2>
          <p className="text-sm text-slate-300">
            Token 已发放并发送到你的邮箱，也可在
            <Link to="/tokens" className="text-sky-400 hover:underline"> 我的 Token </Link>
            页输入邮箱一键登录查看。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div
        className={`rounded-2xl border p-6 text-center space-y-2 ${
          dynamicQr
            ? "border-sky-500/50 bg-sky-500/10"
            : "border-amber-500/50 bg-amber-500/10"
        }`}
      >
        <h2 className="text-xl font-semibold">订单已创建，请扫码支付</h2>
        <p className="text-sm text-slate-300">
          {dynamicQr ? (
            <>打开<strong className="text-sky-300">支付宝</strong>扫码支付，支付成功自动到账。</>
          ) : (
            <>
              支付时请<strong className="text-amber-300">备注你的邮箱</strong>，
              卖家凭邮箱核对到账，确认后 token 会发送到你的邮箱。
            </>
          )}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
        <div className="flex justify-between items-center">
          <span className="text-slate-400 text-sm">订单号{dynamicQr ? "" : "（转账备注用）"}</span>
          <button
            onClick={copyOrderId}
            className="font-mono text-sky-400 hover:text-sky-300"
          >
            {order.id} {copied ? "✓ 已复制" : "📋"}
          </button>
        </div>
        {!dynamicQr && order.contact && (
          <div className="flex justify-between items-center border-t border-slate-700 pt-4">
            <span className="text-slate-400 text-sm">转账备注（填你的邮箱）</span>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(order.contact!);
                  setCopiedEmail(true);
                  setTimeout(() => setCopiedEmail(false), 1500);
                } catch {
                  /* ignore */
                }
              }}
              className="font-mono text-amber-300 hover:text-amber-200 text-sm break-all text-right"
            >
              {order.contact} {copiedEmail ? "✓ 已复制" : "📋"}
            </button>
          </div>
        )}
        <div className="flex justify-between items-baseline border-t border-slate-700 pt-4">
          <span className="text-slate-400">{plan.name}</span>
          <span className="text-3xl font-bold text-sky-400">¥{payable}</span>
        </div>
        {discount > 0 && (
          <p className="text-xs text-emerald-400 text-right">
            推广减免 -¥{discount}（原价 ¥{plan.price_cny}）
          </p>
        )}

        <div className="pt-2 max-w-xs mx-auto">
          {dynamicQr ? (
            <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-center space-y-2">
              <div className="rounded-lg bg-white p-3">
                <QRCodeCanvas value={dynamicQr} size={256} className="w-full h-auto" />
              </div>
              <div className="text-sm text-slate-300">支付宝扫码 · 等待支付…</div>
            </div>
          ) : alipayAccount ? (
            <div className="rounded-xl border border-slate-700 bg-slate-950 p-4 text-center space-y-3">
              <div className="text-sm text-slate-400">支付宝转账到以下账号</div>
              <div className="font-mono text-lg text-slate-100 break-all">{alipayAccount}</div>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(alipayAccount);
                    setCopiedAccount(true);
                    setTimeout(() => setCopiedAccount(false), 1500);
                  } catch {
                    /* 剪贴板不可用时忽略 */
                  }
                }}
                className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium hover:bg-sky-400 transition-colors"
              >
                {copiedAccount ? "✓ 已复制" : "复制账号"}
              </button>
              <p className="text-xs text-amber-300">
                转账时请在备注里填写上方你的邮箱，卖家凭邮箱核对到账
              </p>
            </div>
          ) : (
            <QrCard label="支付宝" src="/api/qr/alipay" />
          )}
        </div>
      </div>

      {!dynamicQr && <ClaimPaidCard orderId={order.id} payable={payable} />}

      <p className="text-xs text-slate-500 text-center">
        {dynamicQr
          ? "支付成功后本页自动确认，token 同时发送到你的邮箱；"
          : "一般 10 分钟内确认到账，token 将发送到你的邮箱；"}
        也可在
        <Link to="/tokens" className="text-sky-400 hover:underline"> 我的 Token </Link>
        页输入邮箱收取一键登录链接。
      </p>
    </div>
  );
}

/** 静态转账模式：买家转账后主动声明，系统即时邮件通知管理员核对（邮件内附一键确认链接） */
function ClaimPaidCard({ orderId, payable }: { orderId: string; payable: number }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(payable));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      const n = parseFloat(amount);
      await api.claimPaid(
        orderId,
        Number.isFinite(n) && n > 0 ? n : undefined,
        note.trim() || undefined
      );
      setDone(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-5 text-center space-y-1">
        <p className="text-emerald-300 font-medium">已通知卖家核对到账</p>
        <p className="text-xs text-slate-400">确认后 token 会发送到你的邮箱，一般 10 分钟内。</p>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-sky-500/50 py-3 text-sky-300 font-medium hover:bg-sky-500/10 transition-colors"
      >
        我已完成转账
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 space-y-3">
      <p className="text-sm text-slate-300">转账已完成？填写信息帮助卖家快速核对：</p>
      <div className="flex gap-3">
        <label className="flex-1 space-y-1">
          <span className="text-xs text-slate-400">转账金额（元）</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
        </label>
        <label className="flex-1 space-y-1">
          <span className="text-xs text-slate-400">付款昵称/账号尾号（选填）</span>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="方便对账"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
        </label>
      </div>
      {err && <p className="text-rose-400 text-xs">{err}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="w-full rounded-lg bg-sky-500 py-2.5 text-sm font-medium hover:bg-sky-400 transition-colors disabled:opacity-60"
      >
        {busy ? "提交中…" : "提交，通知卖家核对"}
      </button>
    </div>
  );
}

function QrCard({ label, src }: { label: string; src: string }) {  const [missing, setMissing] = useState(false);
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-center space-y-2">
      {missing ? (
        <div className="aspect-square flex items-center justify-center text-xs text-slate-500">
          收款码暂未上传
          <br />
          请联系客服
        </div>
      ) : (
        <img
          src={src}
          alt={`${label}收款码`}
          onError={() => setMissing(true)}
          className="w-full aspect-square object-contain rounded-lg bg-white"
        />
      )}
      <div className="text-sm text-slate-300">{label}</div>
    </div>
  );
}
