/**
 * 订阅链接二维码 PNG 生成：uqr 出模块矩阵，手卷一个最小 PNG 编码器
 * （灰度图 + zlib deflate 走 CompressionStream + CRC32），Worker 与 Node 测试同口径，
 * 不引入带原生依赖的图片库。只用于 /api/sub/qr（凭证邮件内嵌 + 移动端扫码导入）。
 */
import { encode } from "uqr";

// PNG chunk 的 CRC32（多项式 0xEDB88320），表启动时算一次
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/**
 * 文本 → 二维码 PNG。modulePx 为每模块像素数，四边各留 4 模块空白（扫码规范）。
 * 输出 8-bit 灰度图：白底 255、模块 0，每扫描线前置 filter 字节 0。
 */
export const qrPng = async (text: string, modulePx = 6): Promise<Uint8Array> => {
  const { data, size } = encode(text, { ecc: "M" });
  const quiet = 4;
  const px = (size + quiet * 2) * modulePx;
  const stride = px + 1;
  const raw = new Uint8Array(stride * px).fill(255);
  for (let y = 0; y < px; y++) raw[y * stride] = 0; // filter: none
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!data[my]?.[mx]) continue;
      const x0 = (mx + quiet) * modulePx;
      const y0 = (my + quiet) * modulePx;
      for (let dy = 0; dy < modulePx; dy++) {
        const row = (y0 + dy) * stride + 1 + x0;
        raw.fill(0, row, row + modulePx);
      }
    }
  }
  const compressed = new Uint8Array(
    await new Response(
      new Blob([raw.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream("deflate"))
    ).arrayBuffer()
  );
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, px);
  dv.setUint32(4, px);
  dv.setUint8(8, 8); // bit depth
  // 9=color type 0（灰度），10/11/12=0（压缩/滤波/隔行）
  const total = PNG_SIG.length + (12 + 13) + (12 + compressed.length) + 12;
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of [PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", new Uint8Array(0))]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
};
