#!/bin/bash
set -uo pipefail

# 从国内视角（本机在阿里云）探测所有节点的用户链路可达性。
# agent 心跳只能证明「节点 → API」通；本脚本探测「国内 → 节点」方向，
# 覆盖 IP 被墙、证书过期、Caddy 挂掉等心跳发现不了的故障。
# 连续 2 次失败 → 邮件告警（/api/admin/alert）；恢复后 → 恢复通知。
# cron: */5 * * * * bash /home/wafer/cloudflare/scripts/probe-nodes.sh

NODES_KV="/home/wafer/fastergamer/kv/NODES/nodes"
DEV_VARS="/home/wafer/cloudflare/workers/api/.dev.vars"
ALERT_URL="http://127.0.0.1:8787/api/admin/alert"
STATE_DIR="/home/wafer/fastergamer/probe-state"
mkdir -p "$STATE_DIR"

ADMIN_KEY=$(grep '^ADMIN_KEY=' "$DEV_VARS" | cut -d= -f2)

alert() { # 标题 内容
  curl -s -o /dev/null -X POST "$ALERT_URL" \
    -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
    -d "$(node -e "console.log(JSON.stringify({title: process.argv[1], text: process.argv[2]}))" "$1" "$2")"
}

# name|host 逐行
node -e "
  const fs = require('fs');
  const nodes = JSON.parse(fs.readFileSync('$NODES_KV', 'utf8'));
  for (const n of nodes) if (n.active) console.log(n.name + '|' + n.host);
" | while IFS='|' read -r NAME HOST; do
  STATE="$STATE_DIR/$HOST"
  FAILS=$(cat "$STATE" 2>/dev/null || echo 0)

  # 每次最多试 2 回，单回 8 秒超时
  OK=0
  for i in 1 2; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$HOST/ping")" = "200" ] && OK=1 && break
    sleep 2
  done

  if [ "$OK" = 1 ]; then
    if [ "$FAILS" -ge 2 ]; then
      alert "节点恢复：$NAME" "节点 $NAME（$HOST）从国内探测已恢复 reachable。"
    fi
    echo 0 > "$STATE"
  else
    FAILS=$((FAILS + 1))
    echo "$FAILS" > "$STATE"
    if [ "$FAILS" -eq 2 ]; then
      alert "节点不可达：$NAME" \
        "节点 $NAME（$HOST）连续 2 次从国内探测失败（https://$HOST/ping 超时或非 200）。可能原因：IP 被墙、证书失效、Caddy/Xray 故障。agent 心跳正常不代表用户链路通，请排查。"
    fi
  fi
done
