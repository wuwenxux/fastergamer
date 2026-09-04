/**
 * 通用 RSA 签名/验签（RSASSA-PKCS1-v1_5 + SHA-256），用 WebCrypto 实现，无额外依赖。
 *
 * 待签名串规则与易支付等平台一致：参数按 key 字典序排、跳过空值与 exclude
 * 字段（通常剔除 sign / sign_type）、k=v 用 & 连接。密钥支持 PEM 整段或裸
 * base64，换行可用 \n 字面量或直接去掉。
 */

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

/** 待签名串：按 key 字典序排、跳过空值与 exclude 字段、k=v 用 & 连接 */
export const canonicalize = (params: Record<string, string>, exclude: string[] = []): string =>
  Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "" && !exclude.includes(k))
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

/** SHA256WithRSA 签名，返回 base64 */
export const rsaSign = async (
  params: Record<string, string>,
  privateKeyPem: string,
  exclude: string[] = []
): Promise<string> => {
  const key = await importPrivateKey(privateKeyPem);
  const data = new TextEncoder().encode(canonicalize(params, exclude));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  return b64encode(sig);
};

/** SHA256WithRSA 验签，规则同 rsaSign；任何异常（含密钥格式错误）都返回 false */
export const rsaVerify = async (
  params: Record<string, string>,
  signatureB64: string,
  publicKeyPem: string,
  exclude: string[] = []
): Promise<boolean> => {
  try {
    const key = await importPublicKey(publicKeyPem);
    const data = new TextEncoder().encode(canonicalize(params, exclude));
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
