import { describe, expect, it } from "vitest";
import type { Token } from "../../../../shared/types";
import { TRAFFIC_GRACE_MS, withinTrafficAllowance } from "../lib/authsnapshot";

const NOW = 1_800_000_000_000;

const baseToken = (over: Partial<Token>): Token => ({
  id: "tk_test",
  uuid: "u",
  plan_id: "plan_monthly",
  status: "active",
  traffic_limit_gb: 20,
  traffic_used_gb: 0,
  purchased_at: NOW - 86_400_000,
  ...over,
});

describe("withinTrafficAllowance", () => {
  it("不限量（limit <= 0）直接放行", () => {
    expect(withinTrafficAllowance(baseToken({ traffic_limit_gb: 0, traffic_used_gb: 9999 }), NOW)).toBe(true);
    expect(withinTrafficAllowance(baseToken({ traffic_limit_gb: -1, traffic_used_gb: 9999 }), NOW)).toBe(true);
  });

  it("未超限放行", () => {
    expect(withinTrafficAllowance(baseToken({ traffic_used_gb: 19.9 }), NOW)).toBe(true);
  });

  it("超限但在 48h 宽限期内放行", () => {
    const token = baseToken({
      traffic_used_gb: 25,
      traffic_exhausted_at: NOW - TRAFFIC_GRACE_MS + 60_000,
    });
    expect(withinTrafficAllowance(token, NOW)).toBe(true);
  });

  it("超过宽限期拒绝", () => {
    const token = baseToken({
      traffic_used_gb: 25,
      traffic_exhausted_at: NOW - TRAFFIC_GRACE_MS - 60_000,
    });
    expect(withinTrafficAllowance(token, NOW)).toBe(false);
  });

  it("超限且 exhausted_at 缺失时拒绝", () => {
    expect(withinTrafficAllowance(baseToken({ traffic_used_gb: 20 }), NOW)).toBe(false);
  });
});
