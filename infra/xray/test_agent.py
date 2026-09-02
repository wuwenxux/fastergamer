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


if __name__ == "__main__":
    unittest.main()
