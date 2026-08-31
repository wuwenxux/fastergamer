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
            self.assertEqual(e["idle_cycles"], 0)
            self.assertEqual(e["ip_conns"], {})
            self.assertIsNone(e["last_report"])

    def test_new_entry_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            ledger = agent.Ledger(os.path.join(d, "ledger.json"))
            e = ledger.entry(UUID_A)
            self.assertEqual(
                e, {"accum": 0, "last_counter": None, "idle_cycles": 0,
                    "ip_conns": {}, "last_report": None})


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


if __name__ == "__main__":
    unittest.main()
