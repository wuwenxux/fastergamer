import { describe, expect, it } from "vitest";
import { isValidIp } from "../routes/tokens";

describe("isValidIp", () => {
  it("合法 IPv4 通过", () => {
    expect(isValidIp("1.2.3.4")).toBe(true);
    expect(isValidIp("255.255.255.255")).toBe(true);
    expect(isValidIp("0.0.0.0")).toBe(true);
  });

  it("IPv4 段超 255 拒绝", () => {
    expect(isValidIp("256.1.1.1")).toBe(false);
    expect(isValidIp("1.2.3.256")).toBe(false);
  });

  it("合法 IPv6 通过", () => {
    expect(isValidIp("::1")).toBe(true);
    expect(isValidIp("2001:db8::1")).toBe(true);
    expect(isValidIp("fe80::a:b:c:d")).toBe(true);
  });

  it("非法 IPv6 / 空串拒绝", () => {
    expect(isValidIp(":::")).toBe(false);
    expect(isValidIp("")).toBe(false);
    expect(isValidIp("1.2.3.4.5")).toBe(false);
    expect(isValidIp("hello")).toBe(false);
  });
});
