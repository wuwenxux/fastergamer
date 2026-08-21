#!/usr/bin/env bash
# KV 数据每日备份：打包 workerd 磁盘 KV 目录，保留最近 7 天
# 数据包括全部 token / 订单 / 工单 / 节点注册表，丢失即全站数据丢失
set -euo pipefail

SRC="/home/wafer/fastergamer/kv"
DST="/home/wafer/fastergamer/backups"
KEEP_DAYS=7

mkdir -p "$DST"
out="$DST/kv-$(date +%Y%m%d-%H%M).tar.gz"
tar -czf "$out" -C "$(dirname "$SRC")" "$(basename "$SRC")"
find "$DST" -name 'kv-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
echo "[backup] $out ($(du -h "$out" | cut -f1))"
