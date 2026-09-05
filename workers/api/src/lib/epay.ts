/**
 * 易支付（pay.neil.asia）—— 仅退款保留
 *
 * 该平台已彻底断开（疑似诈骗）：下单、异步回调均已移除，订单交易状态机保留
 * （照常落 pending，但无支付凭证，待新通道接入）。本文件只为存量已支付订单
 * 的退款保留（管理端 POST /api/admin/orders/:id/refund → refundEpayOrder）；
 * EPAY_* 密钥已从生产删除，退款接口当前不可用，需要时重新配置即可恢复。
 *
 * - 签名算法 SHA256WithRSA，见 rsa-sign.ts；签名时须剔除 sign 和 sign_type 字段
 *
 * 配置（.dev.vars / wrangler secret put，仅退款接口使用）：
 *   EPAY_PID           商户ID（商户后台 → 个人资料 → API信息）
 *   EPAY_PRIVATE_KEY   商户私钥（PKCS8 PEM，换行可用 \n 或直接去掉）
 *   EPAY_PLATFORM_KEY  平台公钥（SPKI PEM，同上；验签退款接口返回用）
 */
import { rsaSign, rsaVerify } from "./rsa-sign";
import type { Env } from "../types";

const REFUND_GATEWAY = "https://pay.neil.asia/api/pay/refund";

export interface EpayConfig {
  pid: string;
  privateKey: string;
  platformKey: string;
}

/** 三项配置齐全才启用退款接口 */
export const getEpayConfig = (env: Env): EpayConfig | null => {
  const pid = env.EPAY_PID?.trim();
  const privateKey = env.EPAY_PRIVATE_KEY?.trim();
  const platformKey = env.EPAY_PLATFORM_KEY?.trim();
  if (!pid || !privateKey || !platformKey) return null;
  return { pid, privateKey, platformKey };
};

/** 易支付签名/验签都要剔除 sign 与 sign_type */
const SIGN_EXCLUDE = ["sign", "sign_type"];

/**
 * 订单退款（需在商户后台开启「订单退款API接口开关」）。
 * trade_no 与 out_trade_no 二选一；money 为退款金额字符串（如 "12.00"）。
 * out_refund_no 传订单号防重复退款。返回平台退款单号 refund_no。
 */
export const refundEpayOrder = async (
  cfg: EpayConfig,
  opts: { tradeNo?: string; outTradeNo?: string; money: string; outRefundNo?: string }
): Promise<{ refundNo?: string }> => {
  const params: Record<string, string> = {
    pid: cfg.pid,
    money: opts.money,
    timestamp: String(Math.floor(Date.now() / 1000)),
    sign_type: "RSA",
  };
  if (opts.tradeNo) params.trade_no = opts.tradeNo;
  if (opts.outTradeNo) params.out_trade_no = opts.outTradeNo;
  if (opts.outRefundNo) params.out_refund_no = opts.outRefundNo;
  params.sign = await rsaSign(params, cfg.privateKey, SIGN_EXCLUDE);

  const body = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(REFUND_GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  const raw = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const fields: Record<string, string> = {};
  if (raw) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") fields[k] = v;
      else if (typeof v === "number") fields[k] = String(v);
    }
  }
  const ok = raw?.code === 0 || raw?.code === "0";
  if (!raw || !ok) {
    throw new Error(
      `epay refund failed: ${raw ? `code=${raw.code} ${raw.msg ?? ""}` : `http ${res.status}`}`
    );
  }
  if (fields.sign && !(await rsaVerify(fields, fields.sign, cfg.platformKey, SIGN_EXCLUDE))) {
    throw new Error("epay refund: bad response signature");
  }
  return { refundNo: fields.refund_no };
};
