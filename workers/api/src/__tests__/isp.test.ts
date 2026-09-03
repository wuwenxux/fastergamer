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
