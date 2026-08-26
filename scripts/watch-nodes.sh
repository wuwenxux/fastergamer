#!/bin/bash
set -uo pipefail

# 节点可用性巡检：跑全链路代理测试（test-node.sh，经节点真实代理访问
# Google/YouTube/ChatGPT/Claude），故障/恢复时经 API 邮件通知管理员。
# 状态文件防止重复告警：只在 正常→故障 / 故障→恢复 跳变时通知。
# 由 systemd timer（fastergamer-node-watch.timer）每 30 分钟触发。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="/home/wafer/fastergamer/node-watch.state"
API="http://127.0.0.1:8787"
ADMIN_KEY=$(grep '^ADMIN_KEY=' "$ROOT/workers/api/.dev.vars" | cut -d= -f2)

# SKIP_CLAUDE=1：Claude 对机房 IP 普遍封锁（区域政策），不代表节点不可用，巡检口径只含 Google/YouTube/ChatGPT
OUT=$(SKIP_CLAUDE=1 bash "$ROOT/scripts/test-node.sh" 2>&1)
CODE=$?
PREV=$(cat "$STATE" 2>/dev/null || echo ok)

notify() { # 标题 内容
  python3 -c "
import json,sys,urllib.request
req = urllib.request.Request('$API/api/admin/alert',
  data=json.dumps({'title': sys.argv[1], 'message': sys.argv[2]}).encode(),
  headers={'content-type': 'application/json', 'x-admin-key': '$ADMIN_KEY'})
try:
  print(urllib.request.urlopen(req, timeout=15).read().decode())
except Exception as e:
  print('alert failed:', e)
" "$1" "$2"
}

if [ $CODE -ne 0 ]; then
  echo "$OUT"
  if [ "$PREV" != "fail" ]; then
    notify "节点可用性巡检失败" "$OUT"
    echo fail > "$STATE"
  fi
  exit 1
fi

echo "$OUT"
if [ "$PREV" = "fail" ]; then
  notify "节点可用性已恢复" "$OUT"
fi
echo ok > "$STATE"
