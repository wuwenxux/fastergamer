import { describe, expect, it } from "vitest";
import { currentMonthKey, monthAccounting } from "../lib/nodes";

const GB = 1024 ** 3;

describe("monthAccounting 月度配额记账", () => {
  it("常规：当月累计，用超配额产生预支", () => {
    const mk = currentMonthKey();
    // 已用 21 GB（20 GB 配额）：预支 1 个月
    const acc = monthAccounting({ month_key: mk, month_used_bytes: 20.5 * GB }, 1 * GB, 20);
    expect(acc.month_used_bytes).toBe(21.5 * GB);
    expect(acc.borrowed).toBe(1);
    expect(acc.months_borrowed).toBe(0); // 未跨月不锁定
  });

  it("跨月：锁定当月预支，月度计数归零", () => {
    const acc = monthAccounting(
      { month_key: "2020-01", month_used_bytes: 45 * GB, months_borrowed: 1 },
      1 * GB,
      20
    );
    expect(acc.months_borrowed).toBe(3); // 1 + floor(45/20)=2
    expect(acc.month_used_bytes).toBe(1 * GB);
    expect(acc.borrowed).toBe(3);
  });

  it("负值防御（脏数据/历史遗留）：不产生负预支，负额被后续用量冲抵", () => {
    const mk = currentMonthKey();
    // 假设出现 -15 GB 的脏数据：先用 5 GB
    const acc = monthAccounting({ month_key: mk, month_used_bytes: -15 * GB }, 5 * GB, 20);
    expect(acc.month_used_bytes).toBe(-10 * GB);
    expect(acc.borrowed).toBe(0); // floor(-10/20)=-1 被钳制为 0，不会意外延长有效期

    // 继续用 25 GB：冲抵负额后净 15 GB，仍未超配额
    const acc2 = monthAccounting({ month_key: mk, month_used_bytes: -10 * GB }, 25 * GB, 20);
    expect(acc2.month_used_bytes).toBe(15 * GB);
    expect(acc2.borrowed).toBe(0);

    // 再用 6 GB：净 21 GB，超配额预支 1 个月
    const acc3 = monthAccounting({ month_key: mk, month_used_bytes: 15 * GB }, 6 * GB, 20);
    expect(acc3.borrowed).toBe(1);
  });

  it("负值跨月不锁定、计数归零", () => {
    const acc = monthAccounting({ month_key: "2020-01", month_used_bytes: -8 * GB }, 2 * GB, 20);
    expect(acc.months_borrowed).toBe(0); // 负额不抵扣已锁定预支
    expect(acc.month_used_bytes).toBe(2 * GB); // 负额跨月作废
    expect(acc.borrowed).toBe(0);
  });
});
