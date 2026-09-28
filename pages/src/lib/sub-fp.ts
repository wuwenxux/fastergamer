/**
 * 订阅设备锁指纹家族展示名（与后端 workers/api/src/lib/sub-lock.ts 的
 * SUB_FP_LABEL / clientFamily 同口径；后端是判定权威，这里只做展示映射）。
 */
export const SUB_FP_LABEL: Record<string, string> = {
  shadowrocket: "Shadowrocket",
  stash: "Stash",
  singbox: "sing-box",
  v2rayng: "v2rayNG",
  nekobox: "NekoBox",
  "clash-meta": "Clash（mihomo 系）",
  "clash-other": "Clash（老内核）",
  unknown: "未知客户端",
};

export const subFpLabel = (fp: string): string => SUB_FP_LABEL[fp] ?? fp;
