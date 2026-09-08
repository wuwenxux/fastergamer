import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Presence, Token } from "../../../../shared/types";

vi.mock("../lib/email-aliyun", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/email-aliyun")>();
  return { ...orig, sendMail: vi.fn(async () => ({ ok: true })) };
});

import { sendMail } from "../lib/email-aliyun";
import {
  geoLocationKey,
  notifyIpChange,
  resolveIpLocationChange,
  type IpLocationChange,
} from "../lib/risk-notify";
import type { Env } from "../types";

const env = {} as Env;

const makeToken = (overrides: Partial<Token> = {}): Token => ({
  id: "tk_test",
  uuid: "uuid-1",
  plan_id: "plan_monthly",
  status: "active",
  traffic_limit_gb: 20,
  traffic_used_gb: 1,
  purchased_at: 1_000,
  contact: "user@example.com",
  ...overrides,
});

/** mock ipwho.is 应答 */
const stubGeo = (country: string, region: string, city: string, isp = "电信") => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({ success: true, country, region, city, connection: { isp } }),
    }))
  );
};

const stubGeoFail = () => {
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("timeout"))));
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("geoLocationKey 位置键", () => {
  it("只含国家/省份/城市，不含运营商", () => {
    expect(geoLocationKey({ country: "中国", region: "四川", city: "成都", isp: "电信" })).toBe(
      "中国 / 四川 / 成都"
    );
  });
});

describe("resolveIpLocationChange 接入地点变更判定", () => {
  it("首次建基线：不发，只记录 active_geo", async () => {
    stubGeo("中国", "四川", "成都");
    const presence: Presence = {};
    const r = await resolveIpLocationChange(presence, "node-hk", ["1.2.3.4"]);
    expect(r.changed).toBe(false);
    expect(presence.active_geo).toEqual({ "node-hk": "中国 / 四川 / 成都" });
  });

  it("同城换 IP（家宽漂移/切运营商）：不发，基线原值不变", async () => {
    stubGeo("中国", "四川", "成都", "移动"); // 运营商标签抖动
    const presence: Presence = { active_geo: { "node-hk": "中国 / 四川 / 成都" } };
    const r = await resolveIpLocationChange(presence, "node-hk", ["5.6.7.8"]);
    expect(r.changed).toBe(false);
    expect(presence.active_geo!["node-hk"]).toBe("中国 / 四川 / 成都");
  });

  it("跨城市变更：发，基线更新为新位置", async () => {
    stubGeo("中国", "广东", "广州");
    const presence: Presence = { active_geo: { "node-hk": "中国 / 四川 / 成都" } };
    const r = await resolveIpLocationChange(presence, "node-hk", ["9.9.9.9"]);
    expect(r.changed).toBe(true);
    expect(r.oldLocation).toBe("中国 / 四川 / 成都");
    expect(r.newLocation).toBe("中国 / 广东 / 广州");
    expect(presence.active_geo!["node-hk"]).toBe("中国 / 广东 / 广州");
  });

  it("geo 查询失败（有基线）：保守按变更处理，基线不动", async () => {
    stubGeoFail();
    const presence: Presence = { active_geo: { "node-hk": "中国 / 四川 / 成都" } };
    const r = await resolveIpLocationChange(presence, "node-hk", ["9.9.9.9"]);
    expect(r.changed).toBe(true);
    expect(r.oldLocation).toBe("中国 / 四川 / 成都");
    expect(r.newLocation).toBeUndefined();
    expect(presence.active_geo!["node-hk"]).toBe("中国 / 四川 / 成都");
  });

  it("geo 查询失败（无基线）：首次使用没有变更证据，不发", async () => {
    stubGeoFail();
    const presence: Presence = {};
    const r = await resolveIpLocationChange(presence, "node-hk", ["9.9.9.9"]);
    expect(r.changed).toBe(false);
    expect(presence.active_geo).toBeUndefined();
  });

  it("geo 应答 success 但无任何位置字段：按查询失败处理", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ json: async () => ({ success: true }) }))
    );
    const presence: Presence = { active_geo: { "node-hk": "中国 / 四川 / 成都" } };
    const r = await resolveIpLocationChange(presence, "node-hk", ["9.9.9.9"]);
    expect(r.changed).toBe(true);
    expect(presence.active_geo!["node-hk"]).toBe("中国 / 四川 / 成都");
  });
});

describe("notifyIpChange 接入地点变更邮件", () => {
  const loc: IpLocationChange = {
    changed: true,
    oldLocation: "中国 / 四川 / 成都",
    newLocation: "中国 / 广东 / 广州",
    display: "中国 / 广东 / 广州 / 电信",
  };

  it("发送邮件：标题为接入地点变更，正文含新旧位置与新 IP，记入 notify_log", async () => {
    const token = makeToken();
    await notifyIpChange(env, token, ["9.9.9.9"], loc);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [, to, subject, html, text] = vi.mocked(sendMail).mock.calls[0];
    expect(to).toBe("user@example.com");
    expect(subject).toContain("接入地点发生变更");
    expect(html).toContain("中国 / 四川 / 成都");
    expect(html).toContain("中国 / 广东 / 广州");
    expect(html).toContain("9.9.9.9");
    expect(text).toContain("中国 / 四川 / 成都 → 中国 / 广东 / 广州");
    expect(token.notify_log?.["ip_change"]).toBeGreaterThan(0);
  });

  it("geo 查询失败时新位置显示「归属地查询失败」", async () => {
    const token = makeToken();
    await notifyIpChange(env, token, ["9.9.9.9"], {
      changed: true,
      oldLocation: "中国 / 四川 / 成都",
    });
    const [, , , html] = vi.mocked(sendMail).mock.calls[0];
    expect(html).toContain("归属地查询失败");
  });

  it("12 小时内已发过：限流不再发", async () => {
    const token = makeToken({ notify_log: { ip_change: Date.now() - 60_000 } });
    await notifyIpChange(env, token, ["9.9.9.9"], loc);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("非邮箱联系方式不发", async () => {
    const token = makeToken({ contact: "qq:12345" });
    await notifyIpChange(env, token, ["9.9.9.9"], loc);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("空 IP 列表不发", async () => {
    const token = makeToken();
    await notifyIpChange(env, token, [], loc);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
