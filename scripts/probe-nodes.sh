#!/bin/bash
set -uo pipefail

# 从国内视角（本机在阿里云）探测所有节点的用户链路可达性。
# agent 已是事件驱动（断联/超量才上报），本脚本是节点在线状态的唯一周期数据源：
# 探测结果通过 /api/admin/nodes/probe-state 写回（状态翻转或 30 分钟刷新才写，KV 写极少），
# 状态页以此为准。探测覆盖 IP 被墙、证书过期、Caddy 挂掉等故障。
# 连续 2 次失败 → 邮件告警（/api/admin/alert）；恢复后 → 恢复通知。
# cron: */5 * * * * bash /home/wafer/cloudflare/scripts/probe-nodes.sh

DEV_VARS="/home/wafer/cloudflare/workers/api/.dev.vars"
# 生产中心已切换到 CF（fastergamer.click），探测结果写回 CF worker
NODES_API="https://fastergamer.click/api/admin/nodes"
ALERT_URL="https://fastergamer.click/api/admin/alert"
STATE_DIR="/home/wafer/fastergamer/probe-state"
mkdir -p "$STATE_DIR"

ADMIN_KEY=$(grep '^ADMIN_KEY=' "$DEV_VARS" | cut -d= -f2)

alert() { # 标题 内容
  curl -s -o /dev/null -X POST "$ALERT_URL" \
    -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
    -d "$(python3 -c "import json,sys; print(json.dumps({'title': sys.argv[1], 'text': sys.argv[2]}))" "$1" "$2")"
}

# name|host|port 逐行（从中心 API 取实时节点清单）
curl -s --max-time 10 -H "x-admin-key: $ADMIN_KEY" "$NODES_API" | python3 -c "
import json, sys
for n in json.load(sys.stdin).get('data') or []:
    if n.get('active'):
        print(f\"{n['name']}|{n['host']}|{n.get('port') or 443}\")
" | while IFS='|' read -r NAME HOST PORT; do
  STATE="$STATE_DIR/$HOST-$PORT"
  FAILS=$(cat "$STATE" 2>/dev/null || echo 0)

  # 每次最多试 2 回，单回 8 秒超时
  OK=0
  for i in 1 2; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$HOST:$PORT/ping")" = "200" ] && OK=1 && break
    sleep 2
  done

  if [ "$OK" = 1 ]; then
    if [ "$FAILS" -ge 2 ]; then
      alert "节点恢复：$NAME" "节点 $NAME（$HOST:$PORT）从国内探测已恢复 reachable。"
    fi
    echo 0 > "$STATE"
  else
    FAILS=$((FAILS + 1))
    echo "$FAILS" > "$STATE"
    if [ "$FAILS" -eq 2 ]; then
      alert "节点不可达：$NAME" \
        "节点 $NAME（$HOST:$PORT）连续 2 次从国内探测失败（https://$HOST:$PORT/ping 超时或非 200）。可能原因：IP 被墙、证书失效、Caddy/Xray 故障。agent 心跳正常不代表用户链路通，请排查。"
    fi
  fi

  # 可达性写回中心（状态页数据源；agent 已事件驱动，不再提供周期心跳）。
  # 写入时机：状态翻转，或状态没变但距上次写已超过 30 分钟（刷新时间戳，证明探测在跑）。
  REPORTED=$(cat "$STATE.reported" 2>/dev/null || echo "|0")
  R_STATE="${REPORTED%%|*}"; R_AT="${REPORTED##*|}"; R_AT="${R_AT:-0}"
  NOW=$(date +%s)
  # 有效状态：成功=up；失败需连续 2 次（FAILS>=2）才算 down，单次抖动不改状态
  if [ "$OK" = 1 ]; then EFF=1; elif [ "$FAILS" -ge 2 ]; then EFF=0; else EFF="$R_STATE"; fi
  if [ "$EFF" != "$R_STATE" ] || [ $((NOW - R_AT)) -gt 1800 ]; then
    [ "$EFF" = 1 ] && ONLINE=true || ONLINE=false
    curl -s -o /dev/null --max-time 10 -X POST "$NODES_API/probe-state" \
      -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
      -d "{\"host\":\"$HOST\",\"port\":$PORT,\"online\":$ONLINE}" \
      && echo "$EFF|$NOW" > "$STATE.reported"
  fi
done
