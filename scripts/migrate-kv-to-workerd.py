#!/usr/bin/env python3
"""把 wrangler dev (miniflare) 的 KV 持久化数据迁移为 workerd 磁盘 KV（每 key 一个文件）。

用法: python3 scripts/migrate-kv-to-workerd.py <state_dir> <out_dir>
  <state_dir>: workers/api/.wrangler/state/v3/kv
  <out_dir>:   输出目录，按 namespace 名建子目录（TOKENS/PLANS/ORDERS/NODES）
"""
import os
import shutil
import sqlite3
import sys

NS_IDS = {
    "918fba7374f24612bbc47c4ec62fb1c1": "TOKENS",
    "e6e88c0444fe4981b80e579debc73a8e": "PLANS",
    "e1d1d6a60bb24b38a366955e3c32587b": "ORDERS",
    "b5d4e8c33a9f421d8e7b0f1234567890": "NODES",
}

# 通过 key 前缀识别 namespace（兜底校验）
KEY_HINTS = {"token": "TOKENS", "order": "ORDERS", "plans": "PLANS", "nodes": "NODES"}


def migrate(state_dir: str, out_dir: str) -> None:
    obj_dir = os.path.join(state_dir, "miniflare-KVNamespaceObject")
    total = 0
    for fname in os.listdir(obj_dir):
        if not fname.endswith(".sqlite") or fname == "metadata.sqlite":
            continue
        path = os.path.join(obj_dir, fname)
        # 用临时副本读取，避开 WAL 锁
        tmp = path + ".migrate-copy"
        shutil.copyfile(path, tmp)
        wal = path + "-wal"
        if os.path.exists(wal):
            shutil.copyfile(wal, tmp + "-wal")
        try:
            conn = sqlite3.connect(tmp)
            entries = conn.execute(
                "select key, blob_id from _mf_entries"
            ).fetchall()
            conn.close()
        finally:
            os.unlink(tmp)
            if os.path.exists(tmp + "-wal"):
                os.unlink(tmp + "-wal")

        if not entries:
            continue

        # 找 namespace：blob 必须能在对应 ns 目录的 blobs/ 里找到
        sample_key, sample_blob = entries[0]
        ns_name = None
        for ns_id, name in NS_IDS.items():
            blob_path = os.path.join(state_dir, ns_id, "blobs", sample_blob)
            if os.path.exists(blob_path):
                ns_name = name
                ns_dir = os.path.join(state_dir, ns_id, "blobs")
                break
        if ns_name is None:
            hint = KEY_HINTS.get(sample_key.split(":")[0])
            print(f"!! 无法通过 blob 定位 namespace（{fname}，首 key {sample_key}），"
                  f"按 key 前缀猜测: {hint}，跳过")
            continue

        target = os.path.join(out_dir, ns_name)
        os.makedirs(target, exist_ok=True)
        for key, blob_id in entries:
            src = os.path.join(ns_dir, blob_id)
            if not os.path.exists(src):
                print(f"!! blob 缺失: {ns_name}/{key} ({blob_id})")
                continue
            # workerd 磁盘 KV：key 即文件名
            with open(src, "rb") as fsrc, open(os.path.join(target, key), "wb") as fdst:
                fdst.write(fsrc.read())
            total += 1
        print(f"✓ {ns_name}: {len(entries)} keys <- {fname}")

    print(f"\n共迁移 {total} 个 key")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    migrate(sys.argv[1], sys.argv[2])
