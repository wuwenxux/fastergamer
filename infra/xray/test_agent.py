#!/usr/bin/env python3
"""agent.py 纯逻辑单元测试（标准库 unittest，无三方依赖）。"""
import json
import os
import tempfile
import unittest
from unittest import mock

import agent

UUID_A = "12345678-1234-1234-1234-123456789abc"
UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


class LedgerEntryTest(unittest.TestCase):
    def test_missing_keys_filled(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ledger.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"users": {UUID_A: {"accum": 5}}}, f)
            ledger = agent.Ledger(path)
            e = ledger.entry(UUID_A)
            self.assertEqual(e["accum"], 5)           # 已有值保留
            self.assertIsNone(e["last_counter"])      # 缺键补齐
            self.assertIsNone(e["last_counter_hy2"])
            self.assertEqual(e["idle_cycles"], 0)
            self.assertEqual(e["ip_conns"], {})
            self.assertIsNone(e["last_report"])

    def test_new_entry_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = agent.Ledger(os.path.join(d, "ledger.json"))
            e = ledger.entry(UUID_A)
            self.assertEqual(
                e, {"accum": 0, "last_counter": None, "last_counter_hy2": None,
                    "idle_cycles": 0, "ip_conns": {}, "last_report": None})


class SanitizeUuidsTest(unittest.TestCase):
    def test_valid_passthrough(self):
        self.assertEqual(agent.sanitize_uuids([UUID_A, UUID_B]), [UUID_A, UUID_B])
        self.assertEqual(agent.sanitize_uuids([]), [])
        self.assertEqual(agent.sanitize_uuids(None), [])

    def test_invalid_filtered(self):
        bad = [
            "not-a-uuid",                                    # 太短
            UUID_A + "x",                                    # 太长
            '12345678-1234-1234-1234-123456789ab"',          # 含引号（YAML 注入）
            "12345678-1234-1234-1234-123456789ab>",          # 含 >（打乱 stats 名解析）
            "12345678-1234-1234-1234-123456789abg",          # 非法字符
            12345,                                           # 非字符串
        ]
        self.assertEqual(agent.sanitize_uuids([UUID_A] + bad), [UUID_A])

    def test_structurally_invalid_filtered(self):
        # 长度对但结构错误：旧正则 [0-9a-fA-F-]{36} 会放行这些，导致 Xray 启动校验失败
        bad = [
            "-" * 36,                                        # 纯横线
            "------------------------------------",          # 同上
            "12345678-1234-1234-1234-123456789ab-",          # 末段多横线少 hex
            "123456781234-1234-1234-1234-123456789abc",      # 首段 12 位
            "12345678_1234-1234-1234-123456789abc",          # 分隔符错
        ]
        self.assertEqual(agent.sanitize_uuids([UUID_A] + bad), [UUID_A])

    def test_uppercase_accepted(self):
        upper = "12345678-1234-1234-1234-123456789ABC"
        self.assertEqual(agent.sanitize_uuids([upper]), [upper])

    def test_dedup_keeps_order(self):
        self.assertEqual(
            agent.sanitize_uuids([UUID_A, UUID_B, UUID_A, UUID_B]),
            [UUID_A, UUID_B])


class CounterDeltaTest(unittest.TestCase):
    def test_first_cycle_baseline_only(self):
        # 未基线化 + 账本无记录：只建基线不计增量（防历史流量重计）
        self.assertEqual(agent.counter_delta(None, 100, primed=False), 0)

    def test_new_counter_counts_full(self):
        # 已基线化 + 新出现计数器：从 0 懒创建，全量计入
        self.assertEqual(agent.counter_delta(None, 100, primed=True), 100)

    def test_normal_delta(self):
        self.assertEqual(agent.counter_delta(50, 80, primed=True), 30)
        self.assertEqual(agent.counter_delta(80, 80, primed=True), 0)

    def test_counter_reset_counts_full(self):
        # counter < prev：计数器被销毁重建（重启/rmu），当前值全是新增量
        self.assertEqual(agent.counter_delta(80, 50, primed=True), 50)


class FlushCountersOnceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger = agent.Ledger(os.path.join(self.tmp.name, "ledger.json"))

    def tearDown(self):
        self.tmp.cleanup()

    def _fake_stats(self, traffic):
        return mock.patch.object(
            agent, "collect_user_stats", return_value=(traffic, {}))

    def test_merges_delta_into_accum(self):
        with self._fake_stats({UUID_A: 100}):
            agent.flush_counters_once("xray", "api", self.ledger, {UUID_A}, primed=True)
        e = self.ledger.users[UUID_A]
        self.assertEqual(e["accum"], 100)
        self.assertEqual(e["last_counter"], 100)
        with self._fake_stats({UUID_A: 150}):
            agent.flush_counters_once("xray", "api", self.ledger, {UUID_A}, primed=True)
        self.assertEqual(self.ledger.users[UUID_A]["accum"], 150)  # 只加差值 50

    def test_counter_reset_counts_full(self):
        with self._fake_stats({UUID_A: 200}):
            agent.flush_counters_once("xray", "api", self.ledger, {UUID_A}, primed=True)
        with self._fake_stats({UUID_A: 50}):  # counter < prev：重建后全量计入
            agent.flush_counters_once("xray", "api", self.ledger, {UUID_A}, primed=True)
        self.assertEqual(self.ledger.users[UUID_A]["accum"], 250)

    def test_unprimed_first_flush_baseline_only(self):
        with self._fake_stats({UUID_A: 100}):
            agent.flush_counters_once("xray", "api", self.ledger, {UUID_A}, primed=False)
        e = self.ledger.users[UUID_A]
        self.assertEqual(e["accum"], 0)
        self.assertEqual(e["last_counter"], 100)

    def test_query_failure_is_noop(self):
        with mock.patch.object(agent, "collect_user_stats", return_value=(None, {})):
            agent.flush_counters_once("xray", "api", self.ledger, None)
        self.assertEqual(self.ledger.users, {})

    def test_allowed_filter(self):
        with self._fake_stats({UUID_A: 10, UUID_B: 999}):
            agent.flush_counters_once("xray", "api", self.ledger, {UUID_A}, primed=True)
        self.assertIn(UUID_A, self.ledger.users)
        self.assertNotIn(UUID_B, self.ledger.users)

    def test_no_filter_when_allowed_none(self):
        with self._fake_stats({UUID_A: 10, UUID_B: 20}):
            agent.flush_counters_once("xray", "api", self.ledger, None, primed=True)
        self.assertEqual(self.ledger.users[UUID_A]["accum"], 10)
        self.assertEqual(self.ledger.users[UUID_B]["accum"], 20)


class RealityConfigTest(unittest.TestCase):
    REALITY = {
        "port": 8444, "dest": "www.microsoft.com:443",
        "private_key": "PRIV", "short_id": "abcd1234",
    }

    def test_no_reality_by_default(self):
        cfg = agent.build_xray_config([UUID_A])
        self.assertEqual(len(cfg["inbounds"]), 1)
        self.assertEqual(cfg["inbounds"][0]["tag"], agent.INBOUND_TAG)

    def test_reality_inbound_appended(self):
        cfg = agent.build_xray_config([UUID_A], reality=self.REALITY)
        self.assertEqual(len(cfg["inbounds"]), 2)
        ws, rt = cfg["inbounds"]
        self.assertEqual(rt["tag"], agent.REALITY_INBOUND_TAG)
        self.assertEqual(rt["listen"], "0.0.0.0")       # 直连公网，不走 Caddy
        self.assertEqual(rt["port"], 8444)
        self.assertEqual(rt["streamSettings"]["network"], "tcp")
        self.assertEqual(rt["streamSettings"]["security"], "reality")
        rs = rt["streamSettings"]["realitySettings"]
        self.assertEqual(rs["dest"], "www.microsoft.com:443")
        self.assertEqual(rs["serverNames"], ["www.microsoft.com"])
        self.assertEqual(rs["privateKey"], "PRIV")
        self.assertEqual(rs["shortIds"], ["abcd1234"])
        # 同一批 uuid 进两个入站，flow 按协议区分
        self.assertEqual(ws["settings"]["clients"][0]["flow"], "")
        self.assertEqual(rt["settings"]["clients"][0]["flow"], "xtls-rprx-vision")
        self.assertEqual(rt["settings"]["clients"][0]["id"], UUID_A)

    def test_strip_clients_clears_all_inbounds(self):
        cfg = agent.build_xray_config([UUID_A], reality=self.REALITY)
        stripped = agent.strip_clients(cfg)
        for ib in stripped["inbounds"]:
            self.assertEqual(ib["settings"]["clients"], [])

    def test_adu_covers_all_inbounds(self):
        cfg = agent.build_xray_config([UUID_A], reality=self.REALITY)
        captured = {}

        class R:
            returncode = 0
            stdout = "Added 2 user(s)"
            stderr = ""

        def fake_run(cmd, **kw):
            with open(cmd[-1], encoding="utf-8") as f:
                captured["payload"] = json.load(f)
            return R()

        with mock.patch.object(agent.subprocess, "run", fake_run):
            ok = agent.api_add_users("xray", "api", cfg, {UUID_A})
        self.assertTrue(ok)
        tags = [ib["tag"] for ib in captured["payload"]["inbounds"]]
        self.assertEqual(tags, [agent.INBOUND_TAG, agent.REALITY_INBOUND_TAG])
        flows = [ib["settings"]["clients"][0]["flow"]
                 for ib in captured["payload"]["inbounds"]]
        self.assertEqual(flows, ["", "xtls-rprx-vision"])


class Hy2ConfigTest(unittest.TestCase):
    def test_build_and_parse_roundtrip(self):
        text = agent.build_hy2_config([UUID_A, UUID_B])
        self.assertIn("listen: :8445", text)
        self.assertIn(f"    {UUID_A}: x", text)
        self.assertIn("trafficStats:", text)
        self.assertEqual(agent.parse_hy2_uuids(text), {UUID_A, UUID_B})

    def test_parse_empty_userpass(self):
        self.assertEqual(agent.parse_hy2_uuids(agent.build_hy2_config([])), set())


class Hy2StatsTest(unittest.TestCase):
    def _fake_urlopen(self, payload):
        class R:
            def read(self):
                return json.dumps(payload).encode()
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False
        return mock.patch.object(agent, "urlopen", lambda *a, **kw: R())

    def test_collect_rx_only(self):
        with self._fake_urlopen({UUID_A: {"tx": 10, "rx": 999}}):
            self.assertEqual(agent.collect_hy2_stats("http://x/traffic"), {UUID_A: 999})

    def test_collect_failure_returns_none(self):
        with mock.patch.object(agent, "urlopen", side_effect=OSError("down")):
            self.assertIsNone(agent.collect_hy2_stats("http://x/traffic"))

    def test_flush_merges_delta_and_resets_baseline(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = agent.Ledger(os.path.join(d, "ledger.json"))
            e = ledger.entry(UUID_A)
            e["last_counter_hy2"] = 500
            with self._fake_urlopen({UUID_A: {"tx": 0, "rx": 800}}):
                agent.flush_hy2_counters_once("http://x/traffic", ledger, primed=True)
            self.assertEqual(e["accum"], 300)               # 正常差值
            self.assertIsNone(e["last_counter_hy2"])          # 重启后按新基线全量计入


class Hy2UserSyncTest(unittest.TestCase):
    def test_no_config_file_is_noop(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = agent.Ledger(os.path.join(d, "ledger.json"))
            with mock.patch.object(agent.os, "system") as m:
                agent.sync_hy2_users(os.path.join(d, "nope.yaml"), "http://x", "hysteria",
                                     [UUID_A], ledger, primed=True)
            m.assert_not_called()

    def test_same_set_no_restart(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = os.path.join(d, "config.yaml")
            with open(cfg, "w", encoding="utf-8") as f:
                f.write(agent.build_hy2_config([UUID_A]))
            ledger = agent.Ledger(os.path.join(d, "ledger.json"))
            with mock.patch.object(agent.os, "system") as m:
                agent.sync_hy2_users(cfg, "http://x", "hysteria", [UUID_A], ledger, primed=True)
            m.assert_not_called()

    def test_change_rewrites_and_restarts(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = os.path.join(d, "config.yaml")
            with open(cfg, "w", encoding="utf-8") as f:
                f.write(agent.build_hy2_config([UUID_A]))
            ledger = agent.Ledger(os.path.join(d, "ledger.json"))
            with mock.patch.object(agent.os, "system", return_value=0) as m, \
                 mock.patch.object(agent, "collect_hy2_stats", return_value=None):
                agent.sync_hy2_users(cfg, "http://x", "hysteria", [UUID_A, UUID_B], ledger, primed=True)
            m.assert_called_once_with("systemctl restart hysteria")
            with open(cfg, encoding="utf-8") as f:
                self.assertEqual(agent.parse_hy2_uuids(f.read()), {UUID_A, UUID_B})


class HasLiveCountersTest(unittest.TestCase):
    """结算后清理守卫：纯 hy2 用户的账本条目不能因 xray 无计数器被删
    （删了 last_counter_hy2 基线 → 下周期全量重计 = 双重计费）。"""

    def test_xray_counter_alive(self):
        e = {"last_counter_hy2": None}
        self.assertTrue(agent.has_live_counters(UUID_A, e, {UUID_A: 1}, None))

    def test_pure_hy2_user_alive_via_counter(self):
        e = {"last_counter_hy2": 500}
        self.assertTrue(agent.has_live_counters(UUID_A, e, {}, {UUID_A: 500}))

    def test_hy2_fetch_failed_but_baseline_kept(self):
        e = {"last_counter_hy2": 500}
        self.assertTrue(agent.has_live_counters(UUID_A, e, {}, None))

    def test_no_counters_anywhere(self):
        e = {"last_counter_hy2": None}
        self.assertFalse(agent.has_live_counters(UUID_A, e, {}, {}))

    def test_hy2_baseline_cleared_and_counter_gone(self):
        e = {"last_counter_hy2": None}
        self.assertFalse(agent.has_live_counters(UUID_A, e, {}, None))


class ValidIpv4Test(unittest.TestCase):
    def test_valid(self):
        for ip in ["1.2.3.4", "0.0.0.0", "255.255.255.255", "8.8.8.8"]:
            self.assertTrue(agent.valid_ipv4(ip), ip)

    def test_invalid(self):
        # 旧校验 \d{1,3}(\.\d{1,3}){3} 会放行超段值
        for ip in ["999.999.999.999", "256.1.1.1", "1.2.3.4.5", "1.2.3", "1.2.3.4/32", "abc.def.ghi.jkl", ""]:
            self.assertFalse(agent.valid_ipv4(ip), ip)


class MergePendingReportTest(unittest.TestCase):
    """上报失败重试的合并逻辑：中心对 settled 直接累加、无幂等键，
    重报值必须是「未确认 accum 全量」，绝不与暂存量叠加（防重复计数）。"""

    @staticmethod
    def _users(**accs):
        return {u: {"accum": b, "ip_conns": {"1.2.3.4": 1}} for u, b in accs.items()}

    def test_pending_retries_with_current_accum(self):
        # 暂存 100，账本 accum 已涨到 150：重报 150（含暂存量+新增量），不是 250
        users = self._users(**{UUID_A: 150})
        merged, _ = agent.merge_pending_report({UUID_A: 100}, {}, {}, {}, users)
        self.assertEqual(merged, {UUID_A: 150})

    def test_pending_and_new_settle_same_uuid_no_double_count(self):
        # 同一 uuid 既在暂存又在settled本期触发：取账本当前 accum，不叠加
        users = self._users(**{UUID_A: 200})
        merged, _ = agent.merge_pending_report(
            {UUID_A: 100}, {}, {UUID_A: 200}, {}, users)
        self.assertEqual(merged, {UUID_A: 200})

    def test_pending_entry_missing_falls_back_to_snapshot(self):
        # 账本条目已不在（极端情况）：退回暂存量，不丢账
        merged, conns = agent.merge_pending_report(
            {UUID_A: 100}, {UUID_A: {"5.6.7.8": 3}}, {}, {}, {})
        self.assertEqual(merged, {UUID_A: 100})
        self.assertEqual(conns, {UUID_A: {"5.6.7.8": 3}})

    def test_new_settle_merged_in(self):
        users = self._users(**{UUID_A: 100, UUID_B: 50})
        merged, conns = agent.merge_pending_report({}, {}, {UUID_A: 100, UUID_B: 50}, {}, users)
        self.assertEqual(merged, {UUID_A: 100, UUID_B: 50})
        self.assertEqual(conns[UUID_B], {"1.2.3.4": 1})

    def test_ip_conns_prefer_ledger_current(self):
        # 账本未清（上报失败不清 ip_conns），重报用账本当前值（快照的超集）
        users = {UUID_A: {"accum": 100, "ip_conns": {"1.2.3.4": 5, "5.6.7.8": 2}}}
        _, conns = agent.merge_pending_report(
            {UUID_A: 100}, {UUID_A: {"1.2.3.4": 1}}, {}, {}, users)
        self.assertEqual(conns, {UUID_A: {"1.2.3.4": 5, "5.6.7.8": 2}})


class ApplyConfigRestartTest(unittest.TestCase):
    """整体重启路径：重启失败必须删掉刚写入的配置，迫使下周期重新同步，
    否则运行态与配置永久分叉且不再有任何告警/重试。"""

    def test_restart_ok_keeps_config(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = os.path.join(d, "config.json")
            with mock.patch.object(agent, "restart_xray", return_value=True):
                self.assertTrue(agent.apply_config_restart(cfg, "{}"))
            with open(cfg, encoding="utf-8") as f:
                self.assertEqual(f.read(), "{}")

    def test_restart_failure_removes_config(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = os.path.join(d, "config.json")
            with mock.patch.object(agent, "restart_xray", return_value=False):
                self.assertFalse(agent.apply_config_restart(cfg, "{}"))
            self.assertFalse(os.path.exists(cfg))

    def test_restart_xray_returns_bool(self):
        with mock.patch.object(agent.os, "system", return_value=0):
            self.assertTrue(agent.restart_xray())
        with mock.patch.object(agent.os, "system", return_value=256):
            self.assertFalse(agent.restart_xray())


class ParseStatsTest(unittest.TestCase):
    """一次 statsquery 的结果同时供用户级/节点级解析（原来各调一次 gRPC）。"""

    STAT = [
        {"name": f"user>>>{UUID_A}>>>traffic>>>downlink", "value": "100"},
        {"name": f"user>>>{UUID_A}>>>traffic>>>uplink", "value": "999"},
        {"name": f"user>>>{UUID_A}>>>online", "value": "1"},
        {"name": f"user>>>{UUID_B}>>>traffic>>>downlink", "value": "50"},
        {"name": f"user>>>{UUID_B}>>>online", "value": "0"},
        {"name": "inbound>>>vless-in>>>traffic>>>downlink", "value": "1234"},
        {"name": "inbound>>>vless-in>>>traffic>>>uplink", "value": "4321"},
    ]

    def test_parse_user_stats(self):
        traffic, online = agent.parse_user_stats(self.STAT)
        self.assertEqual(traffic, {UUID_A: 100, UUID_B: 50})   # 只计下行
        self.assertEqual(online, {UUID_A: True, UUID_B: False})

    def test_parse_node_stats(self):
        total, count = agent.parse_node_stats(self.STAT)
        self.assertEqual(total, 1234)                          # 只计 vless-in 下行
        self.assertEqual(count, 1)

    def test_query_failure_distinguishes_empty(self):
        # None = 查询失败（不能删基线），[] = 真的没有计数器
        with mock.patch.object(agent.subprocess, "run",
                               side_effect=agent.subprocess.TimeoutExpired(cmd="x", timeout=10)):
            self.assertIsNone(agent.query_stats_raw("xray", "api"))

        class R:
            returncode = 0
            stdout = json.dumps({"stat": []})
            stderr = ""
        with mock.patch.object(agent.subprocess, "run", return_value=R()):
            self.assertEqual(agent.query_stats_raw("xray", "api"), [])


if __name__ == "__main__":
    unittest.main()
