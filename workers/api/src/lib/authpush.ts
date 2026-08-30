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

export async function pushAuthRefresh(env: Env): Promise<void> {
  try {
    const snap = await computeAuthSnapshot(env);
    await env.TOKENS.put(AUTH_SNAPSHOT_KEY, JSON.stringify(snap));
  } catch {
    // 快照重建失败不阻断推送：节点拉到旧快照也无妨，变更由兜底轮询补齐
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
