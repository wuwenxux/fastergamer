import { describe, expect, it } from "vitest";
import { currentMonthKey, isMonthCapped, monthAccounting } from "../lib/nodes";

const GB = 1024 ** 3;

/**
 * 月度配额新语义（硬顶，替代旧「静默预支」）：
 * 触顶只标记 capped=true（授权快照侧摘除断网），不累加 months_borrowed、不动 expires_at；
 * 次月账期翻转自动恢复（isMonthCapped 按 month_key 比对，无需回写）。
 */
describe("monthAccounting 月度配额记账（硬顶语义）", () => {
  it("当月累计：触顶 capped=true，未触顶 capped=false", () => {
    const mk = currentMonthKey();
    const under = monthAccounting({ month_key: mk, month_used_bytes: 19 * GB }, 0.5 * GB, 20);
    expect(under.month_used_bytes).toBe(19.5 * GB);
    expect(under.capped).toBe(false);

    const over = monthAccounting({ month_key: mk, month_used_bytes: 20.5 * GB }, 1 * GB, 20);
    expect(over.month_used_bytes).toBe(21.5 * GB); // 触顶后照常累计（审计用）
    expect(over.capped).toBe(true);
  });

  it("跨月：账期翻转计数归零重计，不触碰 months_borrowed（函数不再管它）", () => {
    const acc = monthAccounting({ month_key: "2020-01", month_used_bytes: 45 * GB }, 1 * GB, 20);
    expect(acc.month_used_bytes).toBe(1 * GB);
    expect(acc.month_key).toBe(currentMonthKey());
    expect(acc.capped).toBe(false);
    expect("months_borrowed" in acc).toBe(false); // 新语义：记账不产出预支字段
  });

  it("触顶后当月继续超：capped 保持 true，用量继续累计", () => {
    const mk = currentMonthKey();
    const acc = monthAccounting({ month_key: mk, month_used_bytes: 25 * GB }, 5 * GB, 20);
    expect(acc.month_used_bytes).toBe(30 * GB);
    expect(acc.capped).toBe(true);
  });
});

describe("isMonthCapped 触顶判定（快照摘除/展示共用口径）", () => {
  it("当月用量 ≥ 配额 → true；账期非本月 → false（次月自动恢复）", () => {
    const mk = currentMonthKey();
    expect(isMonthCapped({ month_key: mk, month_used_bytes: 20 * GB }, 20)).toBe(true);
    expect(isMonthCapped({ month_key: mk, month_used_bytes: 19.9 * GB }, 20)).toBe(false);
    // 上月触顶但未回写：账期比对直接视为未触顶，次月无需任何写操作即恢复
    expect(isMonthCapped({ month_key: "2020-01", month_used_bytes: 45 * GB }, 20)).toBe(false);
  });

  it("无配额（quotaGb=0）/ 无账期数据 → false", () => {
    const mk = currentMonthKey();
    expect(isMonthCapped({ month_key: mk, month_used_bytes: 999 * GB }, 0)).toBe(false);
    expect(isMonthCapped({}, 20)).toBe(false);
  });
});
