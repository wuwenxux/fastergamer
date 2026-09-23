/**
 * 授权变更推送（事件机制）：授权相关数据变更后调用，
 * 重建快照（节点紧跟着的拉取即拿到新名单），然后主动 POST 各节点 agent 的
 * /api/agent/refresh 触发立即刷新，替代节点的高频轮询。
 * 约定 fire-and-forget（调用方 c.executionCtx.waitUntil）；
 * 节点不可达/推送失败不影响正确性——agent 保留 30 分钟兜底轮询。
 */
import { getNodes } from "./nodes";
import { AUTH_SNAPSHOT_KEY, computeAuthSnapshot } from "./authsnapshot";
import type { Env } from "../types";

/**
 * 推送防抖标记键：结算高峰期授权事件密集触发，每次都全量重建快照 + 推送全部节点
 * 会白白放大 KV list/reads 与出站请求。60s 窗口内只推第一次，后续事件直接跳过——
 * 代价是最多 60s 的推送延迟，而快照本身有 TTL 缓存、节点每周期拉配置兜底，可接受。
 */
const AUTH_REFRESH_PENDING_KEY = "authrefresh:pending";
const AUTH_REFRESH_DEBOUNCE_TTL_SEC = 60;

export async function pushAuthRefresh(env: Env): Promise<void> {
  // 防抖标记读写失败时 fail-open 照常推送：宁可多推一次也不能丢刷新
  try {
    if (await env.TOKENS.get(AUTH_REFRESH_PENDING_KEY)) return;
    await env.TOKENS.put(AUTH_REFRESH_PENDING_KEY, "1", {
      expirationTtl: AUTH_REFRESH_DEBOUNCE_TTL_SEC,
    });
  } catch (e) {
    console.error(`[authpush] debounce marker failed, push anyway: ${(e as Error).message}`);
  }
  try {
    const snap = await computeAuthSnapshot(env);
    await env.TOKENS.put(AUTH_SNAPSHOT_KEY, JSON.stringify(snap));
  } catch (e) {
    // 快照重建失败不阻断推送：节点拉到旧快照也无妨，变更由兜底轮询补齐；
    // 但撤销最长滞后 15min，失败必须告警（只记操作类型与错误 message，不含敏感数据）
    console.error(`[authpush] snapshot rebuild failed: ${(e as Error).message}`);
  }
  const nodes = await getNodes(env);
  await Promise.allSettled(
    nodes
      .filter((n) => n.active)
      .map((n) =>
        fetch(`https://${n.host}:${n.port}/api/agent/refresh`, {
          method: "POST",
          headers: { "x-node-key": n.key },
          signal: AbortSignal.timeout(8000),
        }).catch(() => {})
      )
  );
}
