#!/bin/bash
set -uo pipefail

# 客户端 → 各节点的链路延迟测试：只凭订阅 uuid，在任何 Linux/macOS 机器上运行。
# 流程：拉订阅 → 解析节点 → 起临时 Xray socks 客户端 → 经 VLESS/WS/TLS 隧道
# 访问节点自身的 /ping（节点 Xray 出站回环到本机 Caddy，不依赖任何外部网站）。
# 每个节点预热 1 次后测 3 次，报告 min/avg/max。
# 用法: bash test-client.sh <订阅uuid>
# 依赖: curl、unzip 或 python3（首次运行会自动下载 Xray 到 ~/.cache/xray-client-test）

UUID="${1:-}"
if [ -z "$UUID" ]; then
  echo "用法: bash test-client.sh <订阅uuid>"
  echo "uuid 在 fastergamer.cn 激活 token 后可看到"
  exit 1
fi

SUB_URL="https://fastergamer.click/api/sub?uuid=$UUID"
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

# 解析 proxies 段：name/server/port/servername/ws-Host。订阅开启 IP 直发后
# server 是 IP，TLS SNI 与 WS Host 需取 servername / Host 头（缺省回退 server）
mapfile -t NODES < <(echo "$YAML" | awk '
  /^proxy-groups:/ { exit }
  /^  - name:/      { if (name) print name "|" server "|" port "|" sn "|" whost; name=substr($0, index($0, "\"")); sn=""; whost="" }
  /^    server:/    { server=$2 }
  /^    port:/      { port=$2 }
  /^    servername:/ { sn=$2 }
  /^        Host:/  { whost=$2 }
  END { if (name) print name "|" server "|" port "|" sn "|" whost }
')
[ ${#NODES[@]} -gt 0 ] || { echo "✗ 订阅里没有节点"; exit 1; }
echo "订阅包含 ${#NODES[@]} 个节点"

# ---------- 逐节点测延迟 ----------
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -f "$WORK_DIR"/test-*.json; }
trap cleanup EXIT

IDX=0
for entry in "${NODES[@]}"; do
  IFS='|' read -r NAME HOST PORT_N SNI WHOST <<< "$entry"
  NAME="${NAME%\"}"; NAME="${NAME#\"}"
  SNI="${SNI:-$HOST}"
  # 隧道内访问目标：节点自身域名（IP 直发时用 Host 头里的域名，都没有才用 server）
  TARGET="${WHOST:-$SNI}"
  # IP 直发时 WS 必须显式带 Host 头，否则 Caddy 按 IP 匹配不到站点
  WS_HEADERS=""
  [ -n "$WHOST" ] && WS_HEADERS=', "headers": {"Host": "'"$WHOST"'"}'
  PORT=$((12808 + IDX)); IDX=$((IDX + 1))
  CFG="$WORK_DIR/test-$PORT.json"
  cat > "$CFG" <<EOF
{
  "log": {"loglevel": "none"},
  "inbounds": [{"listen": "127.0.0.1", "port": $PORT, "protocol": "socks", "settings": {"udp": false}}],
  "outbounds": [{
    "protocol": "vless",
    "settings": {"vnext": [{"address": "$HOST", "port": $PORT_N, "users": [{"id": "$UUID", "encryption": "none"}]}]},
    "streamSettings": {"network": "ws", "security": "tls", "tlsSettings": {"serverName": "$SNI"}, "wsSettings": {"path": "/vless-ws"$WS_HEADERS}}
  }]
}
EOF
  "$XRAY_BIN" run -config "$CFG" >/dev/null 2>&1 &
  PIDS+=($!)
  sleep 1.5

  printf "── %-16s " "$NAME"
  # 预热 1 次（触发 TLS 会话复用/路由收敛），失败也继续正式测
  curl -s -o /dev/null --max-time 10 --socks5-hostname "127.0.0.1:$PORT" "https://$TARGET/ping" 2>/dev/null

  TIMES=()
  for i in 1 2 3; do
    T=$(curl -s -o /dev/null -w "%{time_total}" --max-time 10 \
          --socks5-hostname "127.0.0.1:$PORT" "https://$TARGET/ping" 2>/dev/null)
    [ -n "$T" ] && [ "$T" != "0.000000" ] && TIMES+=("$T")
  done

  if [ ${#TIMES[@]} -eq 0 ]; then
    echo "✗ 不可达（3 次均超时/失败）"
  else
    echo "${TIMES[@]}" | tr ' ' '\n' | awk '
      { ms[NR]=$1*1000; sum+=$1*1000; if(NR==1||$1*1000<min)min=$1*1000; if($1*1000>max)max=$1*1000 }
      END { printf "%.0f / %.0f / %.0f ms (min/avg/max, %d 次)\n", min, sum/NR, max, NR }'
  fi

  kill "${PIDS[-1]}" 2>/dev/null; unset 'PIDS[-1]'
done
