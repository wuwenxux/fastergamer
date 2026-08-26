#!/bin/bash
set -uo pipefail

# 节点端到端连通性测试：在本机起一个临时 Xray socks 客户端，经被测节点
# 真实代理（VLESS+WS+TLS）访问 Google/YouTube/ChatGPT/Claude，逐项打勾。
# 用法: bash scripts/test-node.sh [过滤词]   # 过滤词匹配节点名或 host，如 "香港" 或 nx4
# 注意: 会产生极少量测试流量（每个目标一次 HTTPS 请求）。

XRAY_BIN="/home/wafer/tools/xray"
NODES_KV="/home/wafer/fastergamer/kv/NODES/nodes"
TOKENS_DIR="/home/wafer/fastergamer/kv/TOKENS"
FILTER="${1:-}"

if [ ! -x "$XRAY_BIN" ]; then
  echo "✗ 缺少本地 xray 客户端：$XRAY_BIN"
  echo "  下载：https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip"
  exit 1
fi

# 任选一个 active token 的 uuid 作为测试凭证
UUID=$(node -e "
  const fs = require('fs');
  for (const f of fs.readdirSync('$TOKENS_DIR')) {
    const t = JSON.parse(fs.readFileSync('$TOKENS_DIR/' + f, 'utf8'));
    if (t.status === 'active' && (!t.expires_at || t.expires_at > Date.now())) {
      process.stdout.write(t.uuid); process.exit(0);
    }
  }
  process.exit(1);
") || { echo "✗ 没有可用的 active token"; exit 1; }

# 从 NODES 注册表取 active 节点（可选过滤），输出 name|host|port|ws_path 行
mapfile -t NODES < <(node -e "
  const fs = require('fs');
  const nodes = JSON.parse(fs.readFileSync('$NODES_KV', 'utf8'));
  for (const n of nodes) {
    if (!n.active) continue;
    if ('$FILTER' && !(n.name.includes('$FILTER') || n.host.includes('$FILTER'))) continue;
    console.log(n.name + '|' + n.host + '|' + (n.port || 443) + '|' + (n.ws_path || '/vless-ws'));
  }
")
[ ${#NODES[@]} -gt 0 ] || { echo "✗ 没有匹配的 active 节点"; exit 1; }

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -f /tmp/xray-test-*.json; }
trap cleanup EXIT

PASS_TOTAL=0; FAIL_TOTAL=0

check_code() { # 名称 期望码 "实得码 耗时"
  local name="$1" expect="$2" out="$3"
  local code="${out%% *}" secs="${out##* }"
  if [ "$code" = "$expect" ]; then
    echo "   ✓ $name  ($code, ${secs}s)"
    PASS_TOTAL=$((PASS_TOTAL + 1))
  else
    echo "   ✗ $name  (期望 $expect，实得 ${code:-超时/重置})"
    FAIL_TOTAL=$((FAIL_TOTAL + 1))
  fi
}

IDX=0
for entry in "${NODES[@]}"; do
  IFS='|' read -r NAME HOST RPORT WSPATH <<< "$entry"
  PORT=$((12808 + IDX)); IDX=$((IDX + 1))
  CFG="/tmp/xray-test-$PORT.json"
  cat > "$CFG" <<EOF
{
  "log": {"loglevel": "none"},
  "inbounds": [{"listen": "127.0.0.1", "port": $PORT, "protocol": "socks", "settings": {"udp": false}}],
  "outbounds": [{
    "protocol": "vless",
    "settings": {"vnext": [{"address": "$HOST", "port": $RPORT, "users": [{"id": "$UUID", "encryption": "none"}]}]},
    "streamSettings": {"network": "ws", "security": "tls", "tlsSettings": {"serverName": "$HOST"}, "wsSettings": {"path": "$WSPATH"}}
  }]
}
EOF
  "$XRAY_BIN" run -config "$CFG" >/dev/null 2>&1 &
  PIDS+=($!)
  sleep 1.5

  echo "── $NAME ($HOST)"
  # Google/YouTube: 验状态码；ChatGPT: 用 cdn-cgi/trace（curl UA 直接打首页会被 WAF 误拦）；
  # Claude: 区域封锁会 302 到 app-unavailable-in-region，需看 Location
  OUT=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 15 \
        --socks5-hostname "127.0.0.1:$PORT" https://www.google.com/generate_204 2>/dev/null)
  check_code "Google" "204" "$OUT"
  OUT=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 15 \
        --socks5-hostname "127.0.0.1:$PORT" https://www.youtube.com/ 2>/dev/null)
  check_code "YouTube" "200" "$OUT"
  OUT=$(curl -s -o /dev/null -w "%{http_code} %{time_total}" --max-time 15 \
        --socks5-hostname "127.0.0.1:$PORT" https://chatgpt.com/cdn-cgi/trace 2>/dev/null)
  check_code "ChatGPT" "200" "$OUT"
  # Claude 对机房 IP/地区普遍封锁（302 区域受限 / 403），不代表服务不可用；
  # 巡检（watch-nodes.sh）以 SKIP_CLAUDE=1 跳过，人工排查时才看它
  if [ "${SKIP_CLAUDE:-}" = "1" ]; then
    kill "${PIDS[-1]}" 2>/dev/null; unset 'PIDS[-1]'
    continue
  fi
  HDR=$(curl -s -I --max-time 15 --socks5-hostname "127.0.0.1:$PORT" https://claude.ai/ 2>/dev/null)
  # 可能有 103 Early Hints 等多行状态，取最后一行
  CODE=$(echo "$HDR" | grep -oE "^HTTP/[0-9.]+ [0-9]{3}" | tail -1 | grep -oE "[0-9]{3}")
  LOC=$(echo "$HDR" | grep -i "^location:" || true)
  if [[ "$CODE" =~ ^(200|301|302|303)$ ]] && ! echo "$LOC" | grep -qi "unavailable"; then
    echo "   ✓ Claude  ($CODE)"
    PASS_TOTAL=$((PASS_TOTAL + 1))
  else
    echo "   ✗ Claude  (${CODE:-超时/重置} ${LOC:+→ 区域受限})"
    FAIL_TOTAL=$((FAIL_TOTAL + 1))
  fi
  kill "${PIDS[-1]}" 2>/dev/null; unset 'PIDS[-1]'
done

echo
echo "结果：✓ $PASS_TOTAL  ✗ $FAIL_TOTAL"
[ $FAIL_TOTAL -eq 0 ] && echo "全部通过" || exit 1
