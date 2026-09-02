#!/bin/bash
set -euo pipefail

# 为节点开启 Hysteria2 UDP 入站（在中心服务器本机执行，对每台节点跑一次）
#
# 做的事（幂等，可重复执行）：
#   1. 安装 hysteria 官方服务端二进制（版本固定，已装则跳过）
#   2. 从 Caddy 证书库复制节点域名证书到 /etc/hysteria/，并装每日证书续期同步 cron
#      （Caddy 续期后 hy2 跟着换证书，避免证书过期）
#   3. 写入初始配置（空 userpass；白名单由 agent 同步白名单后自动填充）+
#      systemd 单元并启动，ufw 放行 UDP 端口（默认 8445）
#   4. 上传仓库最新 agent.py 并重启 vpn-agent（agent 会把当前白名单写进 hy2 配置）
#   5. 把 hy2 端口注册到中心（PUT /api/admin/nodes/:id，按 host 匹配节点），
#      订阅随后对 mihomo 系客户端自动下发 🚀 条目（密码 "uuid:x"，sni 为节点域名）
#   6. 验证：UDP 端口监听 + trafficStats 端点应答
#
# 用法：
#   NODE_SUDO_PASS=xxx bash infra/xray/enable-hy2.sh <节点IP> <节点host> [端口]
#   例：NODE_SUDO_PASS=xxx bash infra/xray/enable-hy2.sh 64.83.33.244 jp01.fastergamer.click
#
# 依赖：本机 ssh/scp 免密到节点（~/.ssh/id_ed25519_cloudvpn）、python3、curl；
#       ADMIN_KEY 从 workers/api/.dev.vars 读取；NODE_SUDO_PASS 为节点 wafer 用户 sudo 密码。
# 注意：hy2 用户同步/流量记账由 agent.py 承担（restart 前自动落账，计数器清零不丢量）。

IP="${1:-}"
HOST="${2:-}"
PORT="${3:-8445}"
HY2_VERSION="app/v2.12.2"
if [ -z "$IP" ] || [ -z "$HOST" ]; then
  echo "用法: NODE_SUDO_PASS=xxx bash infra/xray/enable-hy2.sh <节点IP> <节点host> [端口=8445]"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH="ssh -i $HOME/.ssh/id_ed25519_cloudvpn -o ConnectTimeout=10 wafer@$IP"
SCP="scp -i $HOME/.ssh/id_ed25519_cloudvpn -q"
SUDO_PASS="${NODE_SUDO_PASS:-}"
ADMIN_KEY=$(grep "^ADMIN_KEY=" "$ROOT/workers/api/.dev.vars" | cut -d= -f2)
API="https://fastergamer.click"

if [ -z "$SUDO_PASS" ]; then
  echo "✗ 需要 NODE_SUDO_PASS 环境变量（节点 wafer 用户 sudo 密码）"
  exit 1
fi

echo "== [$HOST] 1/6 安装 hysteria 二进制（$HY2_VERSION）"
INSTALLED=$($SSH "/usr/local/bin/hysteria version 2>/dev/null | grep -oE 'v[0-9.]+' | head -1" || true)
if [ "$INSTALLED" = "${HY2_VERSION#app/}" ]; then
  echo "   已是 $INSTALLED，跳过"
else
  $SSH "curl -sL --max-time 120 -o /tmp/hysteria https://github.com/apernet/hysteria/releases/download/$HY2_VERSION/hysteria-linux-amd64"
  $SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c 'install -m 755 /tmp/hysteria /usr/local/bin/hysteria && rm /tmp/hysteria'"
  $SSH "/usr/local/bin/hysteria version | grep Version"
fi

echo "== [$HOST] 2/6 部署证书（Caddy → /etc/hysteria）+ 续期同步 cron"
CERT_DIR=$($SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c 'ls -d /var/lib/caddy/.local/share/caddy/certificates/*/$HOST 2>/dev/null | head -1'")
if [ -z "$CERT_DIR" ]; then
  echo "✗ Caddy 证书库找不到 $HOST 的证书"
  exit 1
fi
$SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c '
  mkdir -p /etc/hysteria
  install -m 644 $CERT_DIR/$HOST.crt /etc/hysteria/cert.crt
  install -m 600 $CERT_DIR/$HOST.key /etc/hysteria/cert.key
'"
# 每日检查 Caddy 证书是否续期（mtime 变化），有变化则同步并重启 hy2
$SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c 'cat > /etc/cron.daily/hy2-cert-sync <<EOF
#!/bin/bash
if [ $CERT_DIR/$HOST.crt -nt /etc/hysteria/cert.crt ]; then
  install -m 644 $CERT_DIR/$HOST.crt /etc/hysteria/cert.crt
  install -m 600 $CERT_DIR/$HOST.key /etc/hysteria/cert.key
  systemctl restart hysteria
fi
EOF
chmod +x /etc/cron.daily/hy2-cert-sync'"

echo "== [$HOST] 3/6 写入初始配置 + systemd 单元并启动"
$SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c 'cat > /etc/systemd/system/hysteria.service <<EOF
[Unit]
Description=Hysteria2 Server
After=network.target

[Service]
ExecStart=/usr/local/bin/hysteria server -c /etc/hysteria/config.yaml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF'"
# 已有配置（重跑）则保留——agent 同步的白名单在里面；没有才写空模板
$SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c '[ -f /etc/hysteria/config.yaml ] || printf \"listen: :$PORT\ntls:\n  cert: /etc/hysteria/cert.crt\n  key: /etc/hysteria/cert.key\nauth:\n  type: userpass\n  userpass: {}\ntrafficStats:\n  listen: 127.0.0.1:9999\n\" > /etc/hysteria/config.yaml'"
$SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c 'systemctl daemon-reload && systemctl enable --now hysteria && ufw allow $PORT/udp >/dev/null'"

echo "== [$HOST] 4/6 部署最新 agent 并重启（同步白名单进 hy2 配置）"
$SCP "$ROOT/infra/xray/agent.py" "wafer@$IP:/tmp/vpn-agent.py"
$SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c 'install -m 755 /tmp/vpn-agent.py /usr/local/bin/vpn-agent.py && rm /tmp/vpn-agent.py && systemctl restart vpn-agent'"
sleep 8

echo "== [$HOST] 5/6 注册 hy2 端口到中心"
NODE_JSON=$(curl -s -H "x-admin-key: $ADMIN_KEY" "$API/api/admin/nodes")
NODE_ID=$(echo "$NODE_JSON" | python3 -c "
import json, sys
for n in json.load(sys.stdin)['data']:
    if n['host'] == '$HOST':
        print(n['id']); break
")
if [ -z "$NODE_ID" ]; then
  echo "✗ 中心找不到 host=$HOST 的节点，请先注册"
  exit 1
fi
curl -s -X PUT -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  "$API/api/admin/nodes/$NODE_ID" \
  -d "{\"hy2\":{\"port\":$PORT}}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('   中心注册:', 'ok' if d.get('ok') else d)"

echo "== [$HOST] 6/6 验证"
$SSH "echo '$SUDO_PASS' | sudo -S -p '' ss -ulnp | grep -q ':$PORT ' && echo '   UDP $PORT: 监听中' || { echo '✗ UDP $PORT 未监听'; exit 1; }"
$SSH "curl -s --max-time 5 http://127.0.0.1:9999/traffic >/dev/null && echo '   trafficStats: 正常' || { echo '✗ trafficStats 无应答'; exit 1; }"
$SSH "python3 -c \"
import re
uuids = [l for l in open('/etc/hysteria/config.yaml') if re.match(r'    [0-9a-f-]{36}: x', l)]
print(f'   userpass 用户: {len(uuids)} 个（agent 已同步）')
assert uuids, 'agent 尚未同步白名单进 hy2 配置'
\"" || echo "   ⚠ userpass 为空，agent 下个周期会自动同步"

echo "✓ [$HOST] Hysteria2 开启完成（$IP:$PORT/udp，订阅 🚀 条目已生效）"
