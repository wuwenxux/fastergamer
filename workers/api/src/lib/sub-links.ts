/**
 * vless:// 通用订阅：Shadowrocket / v2rayNG / NekoBox 等客户端的分享链接格式，
 * 每个 active 节点生成链接行，整体标准 base64 编码下发。
 *
 * 节点条目命名/排序与 Clash 共用 clash.ts 的 buildProxyEntries 系列
 * （「区域代码 基名 全局序号」、nodeIps 命中写 IP），条目顺序固定
 * WS 兜底 → ⚡Reality → 🚀Hysteria2。
 * 与 Clash 输出不同：不按 UA 裁剪 ⚡/🚀 条目——这三类客户端内核都支持
 * Reality 与 Hysteria2，全部下发由用户自己选用，WS 行始终是兜底。
 */
import type { Node } from "../../../../shared/types";
import {
  buildHy2Entries,
  buildProxyEntries,
  buildRealityEntries,
  parseRegions,
  type ClashRegion,
} from "./clash";

export interface BuildSubLinksInput {
  uuid: string;
  /** 每个 active 节点生成链接行 */
  nodes?: Node[];
  /** 区域元数据（emoji/显示名/排序），来自 CLASH_REGIONS；缺省用内置列表 */
  regions?: ClashRegion[];
  /** 节点域名 → IP（订阅下发前由 Worker 通过 DoH 解析），命中时 server 写 IP */
  nodeIps?: Record<string, string>;
}

/** UTF-8 安全 base64：节点名含中文/emoji，btoa 只认 Latin-1，必须先 TextEncoder 转字节 */
export const toBase64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

export const buildVlessSubscription = ({ uuid, nodes, regions, nodeIps }: BuildSubLinksInput): string => {
  const wsEntries = buildProxyEntries(nodes, regions ?? parseRegions(undefined), nodeIps);
  const realityEntries = buildRealityEntries(wsEntries);
  const hy2Entries = buildHy2Entries(wsEntries, realityEntries);

  const lines: string[] = [];
  for (const p of wsEntries) {
    // query 值必须 URL 编码：path 以 / 开头，host/sni 虽为域名也统一走编码
    const q = new URLSearchParams({ encryption: "none" });
    // tls=false 的节点（回源直连场景）省略 security/sni，客户端按明文 WS 处理
    if (p.tls) {
      q.set("security", "tls");
      q.set("sni", p.host);
    }
    q.set("type", "ws");
    q.set("path", p.wsPath);
    q.set("host", p.host);
    lines.push(`vless://${uuid}@${p.server}:${p.port}?${q.toString()}#${encodeURIComponent(p.name)}`);
  }
  for (const p of realityEntries) {
    const r = p.reality!;
    const q = new URLSearchParams({
      encryption: "none",
      security: "reality",
      flow: "xtls-rprx-vision",
      pbk: r.password,
      sid: r.short_id,
      // Reality 的 SNI 是借用伪装站的域名，与节点自身域名无关
      sni: r.server_name,
      fp: "chrome",
      type: "tcp",
    });
    lines.push(`vless://${uuid}@${p.server}:${r.port}?${q.toString()}#${encodeURIComponent(p.name)}`);
  }
  for (const p of hy2Entries) {
    // hysteria2 密码固定 "<uuid>:x"（与服务端 auth userpass 对应），sni 必须是节点域名（真实证书）
    const q = new URLSearchParams({ sni: p.host });
    lines.push(`hysteria2://${uuid}:x@${p.server}:${p.hy2!.port}?${q.toString()}#${encodeURIComponent(p.name)}`);
  }
  return toBase64(lines.join("\n"));
};
