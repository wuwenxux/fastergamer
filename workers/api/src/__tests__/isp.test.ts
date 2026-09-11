import { describe, expect, it } from "vitest";
import { ispFromAsn, orderNodesForIsp } from "../lib/isp";

describe("ispFromAsn：ASN → 运营商", () => {
  it.each([
    [9808, "移动"], [56040, "移动"], [24400, "移动"],
    [4134, "电信"], [4812, "电信"],
    [4837, "联通"], [9929, "联通"],
  ])("AS%i → %s", (asn, isp) => {
    expect(ispFromAsn(asn)).toBe(isp);
  });

  it.each([45102, 13335, 0])("境外/IDC/未知 AS%i → null", (asn) => {
    expect(ispFromAsn(asn)).toBeNull();
  });

  it("非数字输入 → null", () => {
    expect(ispFromAsn(undefined)).toBeNull();
    expect(ispFromAsn("9808")).toBeNull();
  });
});

describe("orderNodesForIsp：按运营商静默重排", () => {
  const nodes = [
    { id: "a", name: "香港 01" },
    { id: "b", name: "香港-移动", prefer_isp: ["移动"] },
    { id: "c", name: "日本 02" },
  ];

  it("移动用户：prefer_isp=移动 的节点排到最前", () => {
    const out = orderNodesForIsp(nodes, "移动");
    expect(out.map((n) => n.id)).toEqual(["b", "a", "c"]);
  });

  it("电信用户：无匹配节点，顺序不变", () => {
    expect(orderNodesForIsp(nodes, "电信").map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("识别不出运营商（null）：顺序不变", () => {
    expect(orderNodesForIsp(nodes, null).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("全部命中或全部不命中：不重排", () => {
    const all = nodes.map((n) => ({ ...n, prefer_isp: ["移动"] }));
    expect(orderNodesForIsp(all, "移动").map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("不修改原数组", () => {
    const before = nodes.map((n) => n.id);
    orderNodesForIsp(nodes, "移动");
    expect(nodes.map((n) => n.id)).toEqual(before);
  });
});

describe("orderNodesForIsp：拨测分数反哺排序", () => {
  const now = Date.now();
  const fresh = (median: number, per_isp?: Record<string, number>) => ({ median, p95: median * 2, per_isp, at: now });
  const probed = [
    { id: "a", name: "香港 01", probe: fresh(60) },
    { id: "b", name: "香港 02", probe: fresh(35) },
    { id: "c", name: "日本 01" }, // 无 probe 数据
  ];

  it("按全国中位数升序，无数据节点沉底", () => {
    expect(orderNodesForIsp(probed, null, now).map((n) => n.id)).toEqual(["b", "a", "c"]);
  });

  it("用户运营商有分运营商数据时优先用它", () => {
    const ns = [
      { id: "a", probe: fresh(50, { 移动: 120 }) },
      { id: "b", probe: fresh(70, { 移动: 45 }) },
    ];
    expect(orderNodesForIsp(ns, "移动", now).map((n) => n.id)).toEqual(["b", "a"]);
    // 电信无 per_isp 数据 → 回退全国中位数
    expect(orderNodesForIsp(ns, "电信", now).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("prefer_isp 层级优先于拨测分数", () => {
    const ns = [
      { id: "a", probe: fresh(30) },
      { id: "b", prefer_isp: ["移动"], probe: fresh(90) },
    ];
    expect(orderNodesForIsp(ns, "移动", now).map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("probe 超 36h 视为失效，退化为 prefer_isp 行为", () => {
    const stale = probed.map((n) => n.probe ? { ...n, probe: { ...n.probe, at: now - 37 * 3600_000 } } : n);
    expect(orderNodesForIsp(stale, null, now).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("失联节点（无有效样本）沉底", () => {
    const ns = [
      { id: "down", probe: fresh(45) },
      { id: "up", probe: fresh(80) },
    ];
    // 模拟失联：回写脚本跳过失联节点，其 probe 会变陈旧——这里直接造陈旧数据
    const withStale = [
      { id: "down", probe: { median: 45, p95: 60, at: now - 40 * 3600_000 } },
      { id: "up", probe: fresh(80) },
    ];
    expect(orderNodesForIsp(withStale, null, now).map((n) => n.id)).toEqual(["up", "down"]);
  });
});
