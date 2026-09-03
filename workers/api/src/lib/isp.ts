/**
 * 按客户端 ASN 识别国内运营商，并据此重排节点顺序。
 *
 * 数据来源：Cloudflare 边缘 request.cf.asn（Workers 免费自带，无需 IP 库）。
 * 国内三大运营商的家宽/蜂窝出口基本落在各自骨干与省级 ASN 上：
 *   移动：AS9808（CMNET 骨干）+ AS56040~AS56048 等省级移动 + AS24400（上海移动）
 *   电信：AS4134（CHINANET 骨干）+ AS4811/4812/4816 等
 *   联通：AS4837（UNICOM 骨干）+ AS9929（联通 A 网）+ AS4808（北京联通）等
 * 识别不出（境外、IDC、教育网、小运营商）返回 null，订阅保持默认顺序。
 */

const ASN_ISP: Record<number, string> = {
  // 移动
  9808: "移动",
  24400: "移动",
  56040: "移动", 56041: "移动", 56042: "移动", 56043: "移动", 56044: "移动",
  56045: "移动", 56046: "移动", 56047: "移动", 56048: "移动", 58466: "移动",
  // 电信
  4134: "电信", 4811: "电信", 4812: "电信", 4816: "电信", 17623: "电信",
  // 联通
  4837: "联通", 9929: "联通", 4808: "联通", 4839: "联通", 4847: "联通",
};

/** cf.asn → "移动" | "电信" | "联通" | null */
export const ispFromAsn = (asn: unknown): string | null =>
  typeof asn === "number" ? ASN_ISP[asn] ?? null : null;

/**
 * 稳定排序：prefer_isp 命中用户运营商的节点排到前面，其余保持注册表顺序。
 * 命中不改变节点分组归属，只影响 url-test/select 组内的成员顺序
 * （url-test 首个成员有粘滞优势，首屏连接即落在最优线路上）。
 */
export const orderNodesForIsp = <T extends { prefer_isp?: string[] }>(
  nodes: T[],
  isp: string | null
): T[] => {
  if (!isp) return nodes;
  const hit = nodes.filter((n) => n.prefer_isp?.includes(isp));
  if (hit.length === 0 || hit.length === nodes.length) return nodes;
  const rest = nodes.filter((n) => !n.prefer_isp?.includes(isp));
  return [...hit, ...rest];
};
