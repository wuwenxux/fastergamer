import { useEffect, useRef } from "react";

/**
 * 轮询 hook：setTimeout 链 —— 上一轮请求完成才排下一轮，请求超过间隔不会并发叠加。
 * 页面切后台（visibilitychange 为 hidden）时暂停，回前台立即补一轮；
 * 超过 timeoutMs 自动停止并回调 onTimeout（用于「轮询超时」UI 提示）。
 *
 * tick 返回 false 表示条件已满足、主动停止轮询；抛错按网络抖动处理，下一轮再试。
 * tick / onTimeout 存在 ref 里，内联函数不会导致轮询重启。
 */
export function usePolling(
  active: boolean,
  tick: () => Promise<boolean | void> | boolean | void,
  { intervalMs, timeoutMs, onTimeout }: { intervalMs: number; timeoutMs?: number; onTimeout?: () => void }
) {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const schedule = () => {
      timer = setTimeout(() => void run(), intervalMs);
    };
    const run = async () => {
      timer = null;
      if (stopped) return;
      if (timeoutMs && Date.now() - startedAt > timeoutMs) {
        stopped = true;
        onTimeoutRef.current?.();
        return;
      }
      let keepGoing = true;
      try {
        keepGoing = (await tickRef.current()) !== false;
      } catch {
        /* 网络抖动忽略，下一轮再试 */
      }
      if (stopped) return;
      if (keepGoing) schedule();
    };
    const onVisibility = () => {
      if (document.hidden) {
        // 后台暂停：清掉待触发的计时器（在途请求自然结束，不再排新轮）
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      } else if (!stopped && timer === null) {
        void run(); // 回前台立即补一轮
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, intervalMs, timeoutMs]);
}
