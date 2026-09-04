import { afterEach, describe, expect, it, vi } from "vitest";
import { rsaSign, rsaVerify } from "../lib/rsa-sign";
import { getEpayConfig, refundEpayOrder, type EpayConfig } from "../lib/epay";
import type { Env } from "../types";

/** 测试用的 RSA 密钥对生成（PEM 格式，模拟商户后台生成的密钥） */
const b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const pem = (buf: ArrayBuffer, label: string): string =>
  `-----BEGIN ${label}-----\n${b64(buf)}\n-----END ${label}-----`;

const genKeys = async (): Promise<{ privateKey: string; publicKey: string }> => {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  return {
    privateKey: pem(await crypto.subtle.exportKey("pkcs8", kp.privateKey), "PRIVATE KEY"),
    publicKey: pem(await crypto.subtle.exportKey("spki", kp.publicKey), "PUBLIC KEY"),
  };
};

/** 商户与平台是两对独立密钥：商户私钥签请求，平台私钥签响应 */
const setup = async () => {
  const merchant = await genKeys();
  const platform = await genKeys();
  const cfg: EpayConfig = {
    pid: "1001",
    privateKey: merchant.privateKey,
    platformKey: platform.publicKey,
  };
  return { merchant, platform, cfg };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getEpayConfig", () => {
  it("三项配置齐全才启用", () => {
    const base = { EPAY_PID: "1001", EPAY_PRIVATE_KEY: "k", EPAY_PLATFORM_KEY: "p" };
    expect(getEpayConfig(base as unknown as Env)).not.toBeNull();
    expect(getEpayConfig({ ...base, EPAY_PID: "" } as unknown as Env)).toBeNull();
    expect(getEpayConfig({} as unknown as Env)).toBeNull();
  });
});

describe("refundEpayOrder", () => {
  const refundOpts = { outTradeNo: "order_test_1", money: "9.90", outRefundNo: "order_test_1" };

  /** 返回带平台签名的退款成功响应，并捕获请求体 */
  const stubRefundOk = (platform: { privateKey: string }) => {
    let captured: Record<string, string> | null = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const params: Record<string, string> = {};
      new URLSearchParams(init.body as string).forEach((v, k) => (params[k] = v));
      captured = params;
      const resp: Record<string, string> = {
        code: "0",
        trade_no: "2024010100001",
        out_trade_no: "order_test_1",
        refund_no: "R2024010100001",
        money: "9.90",
        timestamp: "1721206072",
        sign_type: "RSA",
      };
      resp.sign = await rsaSign(resp, platform.privateKey, ["sign", "sign_type"]);
      return new Response(JSON.stringify({ ...resp, code: 0 }), { status: 200 });
    });
    return () => captured;
  };

  it("退款请求参数齐全且签名可验，返回 refund_no", async () => {
    const { merchant, platform, cfg } = await setup();
    const getCaptured = stubRefundOk(platform);

    const r = await refundEpayOrder(cfg, refundOpts);
    expect(r.refundNo).toBe("R2024010100001");

    const req = getCaptured()!;
    expect(req.pid).toBe("1001");
    expect(req.out_trade_no).toBe("order_test_1");
    expect(req.out_refund_no).toBe("order_test_1");
    expect(req.money).toBe("9.90");
    expect(req.timestamp).toMatch(/^\d{10}$/);
    expect(req.sign_type).toBe("RSA");
    expect(await rsaVerify(req, req.sign, merchant.publicKey, ["sign", "sign_type"])).toBe(true);
  });

  it("平台返回业务错误时抛错", async () => {
    const { cfg } = await setup();
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ code: 1, msg: "退款功能未开启" }), { status: 200 })
    );
    await expect(refundEpayOrder(cfg, refundOpts)).rejects.toThrow("退款功能未开启");
  });

  it("响应验签失败时抛错（防伪造退款成功响应）", async () => {
    const { cfg } = await setup();
    const attacker = await genKeys();
    vi.stubGlobal("fetch", async () => {
      const resp: Record<string, string> = {
        code: "0",
        refund_no: "R2024010100001",
        money: "9.90",
        timestamp: "1721206072",
        sign_type: "RSA",
      };
      resp.sign = await rsaSign(resp, attacker.privateKey, ["sign", "sign_type"]);
      return new Response(JSON.stringify(resp), { status: 200 });
    });
    await expect(refundEpayOrder(cfg, refundOpts)).rejects.toThrow("bad response signature");
  });
});
