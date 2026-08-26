import { useEffect, useState } from "react";
import type { Node } from "../../../shared/types";
import { api } from "../services/api";

type NodeStatus = Pick<Node, "id" | "name" | "region" | "host" | "port" | "tls" | "ws_path"> & {
  last_seen_at?: number;
  online: boolean;
  total_bytes: number;
  online_count: number;
  stats_updated_at?: number;
};

type LatencyMap = Record<string, number | null>; // null = 超时/失败

/** 地区代码 → 展示名（与订阅里的地区列表一致） */
const REGION_LABELS: Record<string, string> = {
  HK: "🇭🇰 香港",
  JP: "🇯🇵 日本",
  MY: "🇲🇾 马来西亚",
  SG: "🇸🇬 新加坡",
  US: "🇺🇸 美国",
  DE: "🇩🇪 德国",
};

interface RegionStatus {
  region: string;
  label: string;
  online: boolean;
  nodeCount: number;
  onlineCount: number;
  totalBytes: number;
  onlineUsers: number;
  /** 该地区最优延迟（ms），null = 全部测速失败 */
  latencyMs: number | null;
  measured: boolean;
}

/** 单次探测：返回耗时 ms，失败/超时返回 null */
async function probeOnce(
  url: string,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<number | null> {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener("abort", onAbort);
    const res = await fetch(url, {
      method: "GET",
      mode: "cors",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onAbort);
    if (!res.ok) return null;
    return Math.round(performance.now() - start);
  } catch {
    return null;
  }
}

/**
 * 测客户端到节点的延迟。
 * 首个请求包含 DNS + TCP + TLS 握手（2-3 个 RTT），会严重高估延迟，
 * 所以先预热一次把连接建好（不计时），再测 2 次取最小值（排除偶发抖动），
 * 与 Clash url-test 的测量口径一致。
 */
async function measureLatency(
  host: string,
  port: number,
  tls: boolean,
  timeoutMs = 4000,
  externalSignal?: AbortSignal
): Promise<number | null> {
  const protocol = tls ? "https" : "http";
  const url = `${protocol}://${host}:${port}/ping`;
  // 预热：失败也没关系，后面两次实测仍会尝试
  await probeOnce(url, timeoutMs, externalSignal);
  const results = [
    await probeOnce(url, timeoutMs, externalSignal),
    await probeOnce(url, timeoutMs, externalSignal),
  ].filter((ms): ms is number => ms !== null);
  if (results.length === 0) return null;
  return Math.min(...results);
}

export default function Status() {
  const [nodes, setNodes] = useState<NodeStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [latency, setLatency] = useState<LatencyMap>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .nodesStatus()
        .then((data) => {
          if (cancelled) return;
          setNodes(data);
          setUpdatedAt(Date.now());
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        });

    setLoading(true);
    load().finally(() => {
      if (!cancelled) setLoading(false);
    });

    // 30 秒定时刷新；浏览器在后台标签页会节流定时器，
    // 所以回到前台（标签页可见 / 窗口聚焦）时立即补一次刷新
    const fetchTimer = setInterval(load, 30_000);
    const onForeground = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onForeground);
    window.addEventListener("focus", onForeground);
    return () => {
      cancelled = true;
      clearInterval(fetchTimer);
      document.removeEventListener("visibilitychange", onForeground);
      window.removeEventListener("focus", onForeground);
    };
  }, []);

  // 节点列表变化时，并行测一次客户端到各节点的延迟（展示时按地区取最优）。
  // 每轮测速先清空旧值：界面要么显示刚测出的延迟，要么显示"测速中"，
  // 绝不把几分钟前的旧值当成当前值展示
  const [measuring, setMeasuring] = useState(false);
  useEffect(() => {
    if (nodes.length === 0) return;
    const abortController = new AbortController();
    setLatency({});
    setMeasuring(true);
    Promise.all(
      nodes.map(async (node) => {
        if (abortController.signal.aborted) return [node.id, null] as const;
        const ms = await measureLatency(node.host, node.port, node.tls, 5000, abortController.signal);
        return [node.id, ms] as const;
      })
    ).then((results) => {
      if (abortController.signal.aborted) return;
      const map: LatencyMap = {};
      results.forEach(([id, ms]) => {
        map[id] = ms;
      });
      setLatency(map);
      setMeasuring(false);
    });
    return () => abortController.abort();
  }, [nodes]);

  // 按地区聚合：只展示地域维度，不暴露具体节点
  const regions: RegionStatus[] = Object.values(
    nodes.reduce<Record<string, RegionStatus>>((acc, n) => {
      const r = acc[n.region] ?? {
        region: n.region,
        label: REGION_LABELS[n.region] ?? n.region,
        online: false,
        nodeCount: 0,
        onlineCount: 0,
        totalBytes: 0,
        onlineUsers: 0,
        latencyMs: null,
        measured: false,
      };
      r.nodeCount += 1;
      r.totalBytes += n.total_bytes;
      if (n.online) {
        r.online = true;
        r.onlineCount += 1;
        r.onlineUsers += n.online_count;
        const ms = latency[n.id];
        if (ms !== undefined) {
          r.measured = true;
          if (ms !== null) r.latencyMs = r.latencyMs === null ? ms : Math.min(r.latencyMs, ms);
        }
      }
      acc[n.region] = r;
      return acc;
    }, {})
  ).sort((a, b) => {
    // 在线优先，其次按延迟从低到高
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.latencyMs ?? 9999) - (b.latencyMs ?? 9999);
  });

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">节点状态</h2>
      <p className="text-sm text-slate-400">
        按接入地域展示，延迟为你的设备到该地域的实测最优值，页面每 30 秒自动刷新。
        {updatedAt !== null && (
          <span className="text-slate-500">
            最后更新 {new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}
          </span>
        )}
      </p>

      {error && <p className="text-rose-400 text-sm">{error}</p>}
      {loading && <p className="text-sm text-slate-500">加载中…</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {regions.map((r) => (
          <div
            key={r.region}
            className={`rounded-xl border p-4 flex items-center justify-between ${
              r.online
                ? "border-emerald-500/40 bg-emerald-500/10"
                : "border-rose-500/40 bg-rose-500/10"
            }`}
          >
            <div>
              <div className="font-medium">{r.label}</div>
              <div className="text-xs text-slate-500 mt-1">
                {r.onlineCount}/{r.nodeCount} 节点在线
                {r.onlineUsers > 0 && ` · 当前 ${r.onlineUsers} 人在用`}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <div
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  r.online
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-rose-500/20 text-rose-300"
                }`}
              >
                {r.online ? "可用" : "离线"}
              </div>
              {r.online &&
                (r.measured ? (
                  <LatencyBadge ms={r.latencyMs} />
                ) : (
                  measuring && <span className="text-xs text-slate-500">测速中…</span>
                ))}
            </div>
          </div>
        ))}
      </div>

      {!loading && regions.length === 0 && (
        <p className="text-sm text-slate-500">暂无节点数据。</p>
      )}
    </div>
  );
}

function LatencyBadge({ ms }: { ms: number | null }) {
  if (ms === null) {
    return <span className="text-xs text-slate-500">测速失败</span>;
  }
  const color =
    ms < 100
      ? "text-emerald-400"
      : ms < 250
      ? "text-amber-400"
      : "text-rose-400";
  return (
    <span className={`text-sm font-semibold ${color}`}>
      {ms} ms
    </span>
  );
}
