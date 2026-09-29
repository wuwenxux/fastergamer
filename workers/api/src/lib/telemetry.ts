/**
 * Workers Analytics Engine 遥测：关键业务事件的统一出口。
 *
 * 动机：业务分析目前靠 KV 全表扫（scripts/user-audit.mjs 等）和本地 CSV，读配额贵且滞后；
 * AE 写免费、writeDataPoint 同步入内存队列（无需 await、不阻塞请求），天然适合高频事件。
 *
 * 纪律：
 * - TELEMETRY 是可选绑定（wrangler.cf.toml / wrangler.toml 的 analytics_engine_datasets；
 *   测试的 mock Env 没有它）。所有写入点必须经本文件的 track()：绑定缺失静默跳过，
 *   写异常 try/catch 吞掉——观测设施绝不能影响业务路径。
 * - 每个写入点一行调用，不节流（AE 就是为高频写的），不改业务逻辑。
 *
 * 数据点清单（AE 每点限 20 blobs + 20 doubles + 1 index；blob1 固定为事件名，
 * 单数据集多事件，查询时 WHERE blob1 = '...'）：
 * - order_created    blobs=[事件, plan_id, 渠道("manual")]      doubles=[实付金额 cny]  index=订单 id
 *                    （下单即记，含 0 元直发单；实付 = 抵扣后 payable，比标价更接近收入）
 * - order_fulfilled  blobs=[事件, plan_id]                      doubles=[实付金额 cny]  index=订单 id
 *                    （fulfillOrder 真实发货才记；already/busy 幂等重放与竞态 loser 不计）
 * - token_activated  blobs=[事件, plan_id, 来源(trial_converted/direct)]               index=token id
 * - traffic_settled  blobs=[事件, plan_id, node_id]             doubles=[bytes]         index=token id
 *                    （结算路径每个增量记一笔，delta=0 的口径切换周期不记）
 * - sub_fetched      blobs=[事件, format(clash/singbox/vless), 客户端家族]              index=凭证 uuid
 *                    （403 被拒的拉取不计——这里统计的是成功下发）
 */
import type { Env } from "../types";

export function track(
  env: Env,
  event: string,
  blobs: (string | undefined)[] = [],
  doubles: number[] = [],
  index?: string
): void {
  try {
    env.TELEMETRY?.writeDataPoint({
      blobs: [event, ...blobs.map((b) => b ?? "")],
      doubles,
      indexes: index ? [index] : [],
    });
  } catch {
    // 观测设施写失败静默：绝不能影响业务
  }
}
