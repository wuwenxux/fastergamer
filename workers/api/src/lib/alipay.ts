/**
 * 支付宝当面付（alipay.trade.precreate）对接
 *
 * - 下单时调用 precreate 生成动态扫码二维码，买家支付后支付宝异步回调
 *   POST /api/orders/alipay-notify，验签通过后自动发放 token
 * - 未配置密钥时 getAlipayConfig() 返回 null，订单走静态收款码 + 人工确认的老流程
 * - 签名算法 RSA2（RSASSA-PKCS1-v1_5 + SHA-256），用 WebCrypto 实现，无额外依赖
 *
 * 配置（.dev.vars / wrangler.toml [vars]）：
 *   ALIPAY_APPID        开放平台应用 appid
 *   ALIPAY_PRIVATE_KEY  应用私钥（PKCS8 PEM，换行可用 \n 或直接去掉）
 *   ALIPAY_PUBLIC_KEY   支付宝公钥（SPKI PEM，同上；注意是「支付宝公钥」不是应用公钥）
 */
import type { Env } from "../types";

const GATEWAY = "https://openapi.alipay.com/gateway.do";

export interface AlipayConfig {
  appid: string;
  privateKey: string;
  publicKey: string;
}

/** 三项配置齐全才启用当面付，否则回退人工确认流程 */
export const getAlipayConfig = (env: Env): AlipayConfig | null => {
  const appid = env.ALIPAY_APPID?.trim();
  const privateKey = env.ALIPAY_PRIVATE_KEY?.trim();
  const publicKey = env.ALIPAY_PUBLIC_KEY?.trim();
  if (!appid || !privateKey || !publicKey) return null;
  return { appid, privateKey, publicKey };
};

/** PEM → DER：去掉 header/footer 与所有空白（含配置里的 \n 字面量） */
const pemToDer = (pem: string): ArrayBuffer => {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der.buffer;
};

const importPrivateKey = (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

const importPublicKey = (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "spki",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

/** 待签名串：按 key 字典序排、跳过空值、k=v 用 & 连接 */
const canonicalize = (params: Record<string, string>): string =>
  Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");

const b64encode = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

const b64decode = (s: string): ArrayBuffer => {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
};

export const alipaySign = async (
  params: Record<string, string>,
  privateKeyPem: string
): Promise<string> => {
  const key = await importPrivateKey(privateKeyPem);
  const data = new TextEncoder().encode(canonicalize(params));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  return b64encode(sig);
};

export const alipayVerify = async (
  params: Record<string, string>,
  signatureB64: string,
  publicKeyPem: string
): Promise<boolean> => {
  try {
    const key = await importPublicKey(publicKeyPem);
    const data = new TextEncoder().encode(canonicalize(params));
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64decode(signatureB64),
      data
    );
  } catch {
    return false;
  }
};

/** 支付宝要求的北京时间格式 yyyy-MM-dd HH:mm:ss（手写，不用 toLocaleString） */
const formatTimestamp = (d: Date): string => {
  const t = new Date(d.getTime() + 8 * 3600_000); // 假定 UTC 基准换算到 GMT+8
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
  );
};

export interface PrecreateResult {
  qrCode: string;
  outTradeNo: string;
}

/**
 * 调用 alipay.trade.precreate 生成扫码二维码内容。
 * 失败（含支付宝返回业务错误）直接 throw，调用方应回退到静态收款码流程。
 */
export const precreate = async (
  cfg: AlipayConfig,
  opts: { outTradeNo: string; totalAmount: string; subject: string; notifyUrl: string }
): Promise<PrecreateResult> => {
  const params: Record<string, string> = {
    app_id: cfg.appid,
    method: "alipay.trade.precreate",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: formatTimestamp(new Date()),
    version: "1.0",
    notify_url: opts.notifyUrl,
    biz_content: JSON.stringify({
      out_trade_no: opts.outTradeNo,
      total_amount: opts.totalAmount,
      subject: opts.subject,
    }),
  };
  params.sign = await alipaySign(params, cfg.privateKey);

  const body = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });
  const json = (await res.json().catch(() => null)) as {
    alipay_trade_precreate_response?: { code?: string; msg?: string; qr_code?: string };
  } | null;
  const r = json?.alipay_trade_precreate_response;
  if (!r || r.code !== "10000" || !r.qr_code) {
    throw new Error(`alipay precreate failed: ${r?.code ?? "http"} ${r?.msg ?? res.status}`);
  }
  return { qrCode: r.qr_code, outTradeNo: opts.outTradeNo };
};

/**
 * 校验异步回调签名。form 为回调 POST 的表单字段；
 * 验签时剔除 sign / sign_type，其余字段全部参与。
 */
export const verifyNotify = async (
  cfg: AlipayConfig,
  form: Record<string, string>
): Promise<boolean> => {
  const sign = form.sign;
  if (!sign) return false;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    if (k === "sign" || k === "sign_type") continue;
    params[k] = v;
  }
  return alipayVerify(params, sign, cfg.publicKey);
};
