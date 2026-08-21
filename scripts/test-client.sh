#!/bin/bash
set -uo pipefail

# 客户端视角的节点端到端测试：只凭订阅 uuid，在任何 Linux/macOS 机器上运行。
# 流程：拉订阅 → 解析节点 → 起临时 Xray socks 客户端 → 经节点真实代理
# 访问 Google/YouTube/ChatGPT/Claude，逐项打勾。
# 用法: bash test-client.sh <订阅uuid>
# 依赖: curl、unzip 或 python3（首次运行会自动下载 Xray 到 ~/.cache/xray-client-test）

UUID="${1:-}"
if [ -z "$UUID" ]; then
  echo "用法: bash test-client.sh <订阅uuid>"
  echo "uuid 在 fastergamer.cn 激活 token 后可看到"
  exit 1
fi

SUB_URL="https://fastergamer.cn/api/sub?uuid=$UUID"
WORK_DIR="$HOME/.cache/xray-client-test"
mkdir -p "$WORK_DIR"

# ---------- 准备本地 xray ----------
find_xray() {
  # 依次：缓存目录 → PATH → 本机运维副本（中心服务器上免下载）
  [ -x "$WORK_DIR/xray" ] && echo "$WORK_DIR/xray" && return 0
  command -v xray >/dev/null && command -v xray && return 0
  [ -x /home/wafer/tools/xray ] && echo /home/wafer/tools/xray && return 0
  return 1
}

if ! XRAY_BIN=$(find_xray); then
  OS=$(uname -s | tr 'A-Z' 'a-z'); ARCH=$(uname -m)
  case "$OS/$ARCH" in
    linux/x86_64)  PKG="Xray-linux-64" ;;
    linux/aarch64) PKG="Xray-linux-arm64-v8a" ;;
    darwin/arm64)  PKG="Xray-macos-arm64-v8a" ;;
    darwin/x86_64) PKG="Xray-macos-64" ;;
    *) echo "✗ 不支持的平台 $OS/$ARCH，请手动安装 xray"; exit 1 ;;
  esac
  echo "首次运行，下载 Xray 客户端..."
  curl -sL --max-time 180 -o "$WORK_DIR/xray.zip" \
    "https://github.com/XTLS/Xray-core/releases/latest/download/$PKG.zip" \
    || { echo "✗ Xray 下载失败"; exit 1; }
  if command -v unzip >/dev/null; then
    unzip -o -q "$WORK_DIR/xray.zip" xray -d "$WORK_DIR"
  else
    python3 -c "import zipfile; zipfile.ZipFile('$WORK_DIR/xray.zip').extract('xray', '$WORK_DIR')" \
      || { echo "✗ 解压失败（需要 unzip 或 python3）"; exit 1; }
  fi
  chmod +x "$WORK_DIR/xray"; rm -f "$WORK_DIR/xray.zip"
  XRAY_BIN="$WORK_DIR/xray"
fi

# ---------- 拉订阅并解析节点 ----------
YAML=$(curl -s --max-time 20 "$SUB_URL")
echo "$YAML" | grep -q "^proxies:" || { echo "✗ 订阅拉取失败：$(echo "$YAML" | head -1)"; exit 1; }

# 解析 proxies 段：name/server/port 三元组
mapfile -t NODES < <(echo "$YAML" | awk '
  /^proxy-groups:/ { exit }
  /^  - name:/     { if (name) print name "|" server "|" port; name=substr($0, index($0, "\"")) }
  /^    server:/   { server=$2 }
  /^    port:/     { port=$2 }
  END { if (name) print name "|" server "|" port }
')
[ ${#NODES[@]} -gt 0 ] || { echo "✗ 订阅里没有节点"; exit 1; }
echo "订阅包含 ${#NODES[@]} 个节点"

# ---------- 逐项测试 ----------
PASS_TOTAL=0; FAIL_TOTAL=0
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -f "$WORK_DIR"/test-*.json; }
trap cleanup EXIT

check_code() { # 名称 期望码 "实得码 耗时"
  local name="$1" expect="$2" out="$3"
  local code="${out%% *}" secs="${out##* }"
  if [ "$code" = "$expect" ]; then
    echo "   ✓ $name  ($code, ${secs}s)"; PASS_TOTAL=$((PASS_TOTAL + 1))
  else
    echo "   ✗ $name  (期望 $expect，实得 ${code:-超时/重置})"; FAIL_TOTAL=$((FAIL_TOTAL + 1))
  fi
}

IDX=0
for entry in "${NODES[@]}"; do
  NAME="${entry%%|*}"; REST="${entry#*|}"; HOST="${REST%%|*}"; PORT_N="${REST##*|}"
  NAME="${NAME%\"}"; NAME="${NAME#\"}"
  PORT=$((12808 + IDX)); IDX=$((IDX + 1))
  CFG="$WORK_DIR/test-$PORT.json"
  cat > "$CFG" <<EOF
{
  "log": {"loglevel": "none"},
  "inbounds": [{"listen": "127.0.0.1", "port": $PORT, "protocol": "socks", "settings": {"udp": false}}],
  "outbounds": [{
    "protocol": "vless",
    "settings": {"vnext": [{"address": "$HOST", "port": $PORT_N, "users": [{"id": "$UUID", "encryption": "none"}]}]},
    "streamSettings": {"network": "ws", "security": "tls", "tlsSettings": {"serverName": "$HOST"}, "wsSettings": {"path": "/vless-ws"}}
  }]
}
EOF
  "$XRAY_BIN" run -config "$CFG" >/dev/null 2>&1 &
  PIDS+=($!)
  sleep 1.5

  echo "── $NAME ($HOST)"
  # Google/YouTube: 验状态码；ChatGPT: 用 cdn-cgi/trace（curl 裸 UA 打首页会被 WAF 误拦）；
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
  HDR=$(curl -s -I --max-time 15 --socks5-hostname "127.0.0.1:$PORT" https://claude.ai/ 2>/dev/null)
  CODE=$(echo "$HDR" | grep -oE "^HTTP/[0-9.]+ [0-9]{3}" | tail -1 | grep -oE "[0-9]{3}")
  LOC=$(echo "$HDR" | grep -i "^location:" || true)
  if [[ "$CODE" =~ ^(200|301|302|303)$ ]] && ! echo "$LOC" | grep -qi "unavailable"; then
    echo "   ✓ Claude  ($CODE)"; PASS_TOTAL=$((PASS_TOTAL + 1))
  else
    echo "   ✗ Claude  (${CODE:-超时/重置} ${LOC:+→ 区域受限})"; FAIL_TOTAL=$((FAIL_TOTAL + 1))
  fi
  kill "${PIDS[-1]}" 2>/dev/null; unset 'PIDS[-1]'
done

echo
echo "结果：✓ $PASS_TOTAL  ✗ $FAIL_TOTAL"
[ $FAIL_TOTAL -eq 0 ] && echo "全部通过" || exit 1
