import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/** IPv4 转 32 位整数（仅 IPv4；IPv6 或非法串返回 null 直接不匹配） */
const ipToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!/^\d{1,3}$/.test(p) || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
};

/** 白名单条目支持精确 IP 或 IPv4 CIDR（家宽拨号换 IP 频繁，按 /16 网段放行） */
const matchRule = (ip: string, rule: string): boolean => {
  if (!rule.includes("/")) return ip === rule;
  const [base, bits] = rule.split("/");
  const ipN = ipToInt(ip);
  const baseN = ipToInt(base);
  const b = Number(bits);
  if (ipN === null || baseN === null || !(b >= 0 && b <= 32)) return false;
  const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
  return (ipN & mask) === (baseN & mask);
};

/**
 * 管理接口鉴权：请求必须携带 x-admin-key header（主 key 不进邮件/URL，暴露面最小）。
 * 配了 ADMIN_IPS（逗号分隔，精确 IP 或 CIDR）时叠加来源 IP 白名单：
 * 网段放行 + 密钥双重门槛，防 key 泄露后被异地调用。CF 边缘必写 cf-connecting-ip，
 * 取不到（本地 dev 未配 ADMIN_IPS 之外的场景）按拒绝处理（白名单语义是 fail-closed）。
 */
export const adminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const headerKey = c.req.header("x-admin-key");
  if (!headerKey || headerKey !== c.env.ADMIN_KEY) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const allow = c.env.ADMIN_IPS?.split(",").map((s) => s.trim()).filter(Boolean);
  if (allow?.length) {
    const ip = c.req.header("cf-connecting-ip") ?? "";
    if (!ip || !allow.some((rule) => matchRule(ip, rule))) {
      return c.json({ ok: false, error: "forbidden: ip not allowed" }, 403);
    }
  }
  await next();
};
