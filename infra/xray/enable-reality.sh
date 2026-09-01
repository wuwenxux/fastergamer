#!/bin/bash
set -euo pipefail

# 为节点开启 Reality 直连入站（在中心服务器本机执行，对每台节点跑一次）
#
# 做的事（幂等，可重复执行）：
#   1. 节点上生成/复用 Reality 密钥（x25519 + shortId），写入 /etc/vpn-agent/env
#   2. 上传仓库最新 agent.py 并重启 vpn-agent（触发 xray 配置重建：WS + Reality 双入站）
#   3. ufw 放行 Reality 端口（默认 8444）
#   4. 把 Reality 公钥参数注册到中心（PUT /api/admin/nodes/:id，按 host 匹配节点），
#      订阅随后对 mihomo 系客户端自动下发 ⚡ 条目
#   5. 验证：伪装证书检查（应返回 Apple 证书）+ 节点配置双入站检查
#
# 用法：
#   NODE_SUDO_PASS=xxx bash infra/xray/enable-reality.sh <节点IP> <节点host> [端口]
#   例：NODE_SUDO_PASS=xxx bash infra/xray/enable-reality.sh 154.64.250.144 hk03.fastergamer.click
#
# 依赖：本机 ssh/scp 免密到节点（~/.ssh/id_ed25519_cloudvpn）、jq 或 python3、curl、openssl；
#       ADMIN_KEY 从 workers/api/.dev.vars 读取；NODE_SUDO_PASS 为节点 wafer 用户 sudo 密码。

IP="${1:-}"
HOST="${2:-}"
PORT="${3:-8444}"
if [ -z "$IP" ] || [ -z "$HOST" ]; then
  echo "用法: NODE_SUDO_PASS=xxx bash infra/xray/enable-reality.sh <节点IP> <节点host> [端口=8444]"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH="ssh -i $HOME/.ssh/id_ed25519_cloudvpn -o ConnectTimeout=10 wafer@$IP"
SCP="scp -i $HOME/.ssh/id_ed25519_cloudvpn -q"
SUDO_PASS="${NODE_SUDO_PASS:-}"
DEST="gateway.icloud.com:443"
DEST_SN="gateway.icloud.com"
ADMIN_KEY=$(grep "^ADMIN_KEY=" "$ROOT/workers/api/.dev.vars" | cut -d= -f2)
API="https://fastergamer.click"

if [ -z "$SUDO_PASS" ]; then
  echo "✗ 需要 NODE_SUDO_PASS 环境变量（节点 wafer 用户 sudo 密码）"
  exit 1
fi

echo "== [$HOST] 1/5 检查 xray 版本（Reality 需要 >= 1.8）"
$SSH '/usr/local/bin/xray version | head -1'

echo "== [$HOST] 2/5 配置 Reality 密钥到 /etc/vpn-agent/env"
# 已有 REALITY_PRIVATE_KEY 则复用（保持公钥不变，避免订阅里的旧配置失效）
# 注意：env 文件 600 root，必须 sudo 读，否则读不到会误判成"未配置"而重复生成密钥
EXISTING=$($SSH "echo '$SUDO_PASS' | sudo -S -p '' grep '^REALITY_PRIVATE_KEY=' /etc/vpn-agent/env 2>/dev/null | head -1 | cut -d= -f2" || true)
if [ -n "$EXISTING" ]; then
  echo "   已有密钥，复用"
  PUB=$($SSH "/usr/local/bin/xray x25519 -i '$EXISTING' | grep -E 'Password|PublicKey' | awk '{print \$NF}'")
  SHORT_ID=$($SSH "echo '$SUDO_PASS' | sudo -S -p '' grep '^REALITY_SHORT_ID=' /etc/vpn-agent/env | head -1 | cut -d= -f2")
  PRIV="$EXISTING"
else
  KEYS=$($SSH '/usr/local/bin/xray x25519')
  PRIV=$(echo "$KEYS" | grep "PrivateKey" | awk '{print $2}')
  PUB=$(echo "$KEYS" | grep -E "Password|PublicKey" | awk '{print $NF}')
  SHORT_ID=$($SSH 'openssl rand -hex 8')
  $SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c \"
    cat >> /etc/vpn-agent/env <<EOF

# Reality 直连（enable-reality.sh 写入）：公钥 $PUB
REALITY_PRIVATE_KEY=$PRIV
REALITY_SHORT_ID=$SHORT_ID
REALITY_PORT=$PORT
REALITY_DEST=$DEST
EOF
  \""
fi
echo "   公钥(password): $PUB  shortId: $SHORT_ID"

echo "== [$HOST] 3/5 部署最新 agent 并放行 $PORT"
$SCP "$ROOT/infra/xray/agent.py" "wafer@$IP:/tmp/vpn-agent.py"
$SSH "echo '$SUDO_PASS' | sudo -S -p '' bash -c \"
  install -m 755 /tmp/vpn-agent.py /usr/local/bin/vpn-agent.py && rm /tmp/vpn-agent.py
  ufw allow $PORT/tcp >/dev/null
  systemctl restart vpn-agent
\""
sleep 8

echo "== [$HOST] 4/5 注册 Reality 参数到中心"
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
  -d "{\"reality\":{\"port\":$PORT,\"password\":\"$PUB\",\"short_id\":\"$SHORT_ID\",\"server_name\":\"$DEST_SN\"}}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('   中心注册:', 'ok' if d.get('ok') else d)"

echo "== [$HOST] 5/5 验证"
# 节点配置应有双入站
$SSH "python3 -c \"
import json
c = json.load(open('/usr/local/etc/xray/config.json'))
tags = [(i['tag'], i['port']) for i in c['inbounds']]
print('   入站:', tags)
assert any(t[0] == 'vless-reality-in' for t in tags), 'reality 入站未生成'
\""
# 伪装检查：探测者应看到 Apple 证书
SUBJ=$(echo | openssl s_client -connect "$IP:$PORT" -servername "$DEST_SN" 2>/dev/null | openssl x509 -noout -subject 2>/dev/null || true)
echo "   伪装证书: $SUBJ"
echo "$SUBJ" | grep -q "Apple" || { echo "✗ 伪装证书不符合预期"; exit 1; }

echo "✓ [$HOST] Reality 开启完成（$IP:$PORT，订阅 ⚡ 条目已生效）"
