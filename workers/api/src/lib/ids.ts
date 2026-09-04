/** 生成短随机 ID（不依赖第三方库，使用 WebCrypto 随机源） */
const randHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** Token 短 ID，例如 tk_a1b2c3d4e5f6 */
export const newTokenId = (): string => `tk_${randHex(6)}`;

/** 订单 ID */
export const newOrderId = (): string => `ord_${randHex(8)}`;
