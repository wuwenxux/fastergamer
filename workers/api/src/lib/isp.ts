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
 *
 * 拨测反哺：节点带新鲜（≤36h）probe 数据时，同 prefer_isp 层级内再按
 * 拨测分数升序（用户运营商的分运营商中位数，缺省用全国中位数）；
 * 无数据/失联节点沉底。没有任何有效 probe 数据时行为与纯 prefer_isp 排序一致。
 */

/** probe 数据保鲜期：超过视为失效，不参与排序 */
export const PROBE_STALE_MS = 36 * 3600_000;

interface ProbeLike {
  median: number;
  per_isp?: Record<string, number>;
  at: number;
}

/** 节点对该用户的拨测分数（ms，越低越好）；无数据/过期返回 null */
const probeScore = (
  n: { probe?: ProbeLike },
  isp: string | null,
  now: number
): number | null => {
  const p = n.probe;
  if (!p || typeof p.median !== "number" || now - p.at > PROBE_STALE_MS) return null;
  return (isp && p.per_isp?.[isp]) || p.median;
};

export const orderNodesForIsp = <T extends { prefer_isp?: string[]; probe?: ProbeLike }>(
  nodes: T[],
  isp: string | null,
  now: number = Date.now()
): T[] => {
  // 无任何拨测数据：退化为纯 prefer_isp 排序（保持历史行为）
  if (!nodes.some((n) => probeScore(n, isp, now) !== null)) {
    if (!isp) return nodes;
    const hit = nodes.filter((n) => n.prefer_isp?.includes(isp));
    if (hit.length === 0 || hit.length === nodes.length) return nodes;
    const rest = nodes.filter((n) => !n.prefer_isp?.includes(isp));
    return [...hit, ...rest];
  }
  return nodes
    .map((n, i) => ({
      n,
      i,
      tier: isp && n.prefer_isp?.includes(isp) ? 0 : 1,
      s: probeScore(n, isp, now) ?? Infinity,
    }))
    .sort((a, b) => a.tier - b.tier || a.s - b.s || a.i - b.i)
    .map((x) => x.n);
};
