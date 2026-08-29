#!/bin/bash
# 触发 CF 中心（fastergamer.click）的定时巡检：到期提醒、节点失联检测、90 天数据清理
# cron: 7,22,37,52 * * * * bash /home/wafer/cloudflare/scripts/notify-scan-cf.sh
set -uo pipefail

ADMIN_KEY=$(grep '^ADMIN_KEY=' /home/wafer/cloudflare/workers/api/.dev.vars | cut -d= -f2)
curl -s --max-time 60 -X POST "https://fastergamer.click/api/admin/notify-scan" \
  -H "x-admin-key: $ADMIN_KEY"
echo
