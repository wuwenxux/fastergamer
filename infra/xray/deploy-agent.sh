#!/bin/bash
set -euo pipefail

# 在 VPS 上一键部署 vpn-agent（agent 代码从 /tmp/vpn-agent.py 安装，需先上传）
# 用法：sudo bash deploy-agent.sh <NODE_KEY>

NODE_KEY="${1:-}"
if [ -z "$NODE_KEY" ]; then
  echo "Usage: sudo bash deploy-agent.sh <NODE_KEY>"
  exit 1
fi

# agent 代码不内嵌（避免与 infra/xray/agent.py 两份漂移）；
# 部署前把仓库里的 agent.py 上传到节点 /tmp/vpn-agent.py（onboard-node.sh 已内置该步骤）
AGENT_SRC="${AGENT_SRC:-/tmp/vpn-agent.py}"
[ -f "$AGENT_SRC" ] || { echo "缺少 $AGENT_SRC（先 scp infra/xray/agent.py 到节点）"; exit 1; }
install -m 755 "$AGENT_SRC" /usr/local/bin/vpn-agent.py

mkdir -p /etc/vpn-agent
cat > /etc/vpn-agent/env <<EOF
# 节点侧只走 fastergamer.click（CF 即生产中心），不触碰 fastergamer.cn
API_URL=https://fastergamer.click/api/agent/config
NODE_KEY=$NODE_KEY
XRAY_CONFIG=/usr/local/etc/xray/config.json
XRAY_LISTEN=127.0.0.1
XRAY_BIN=/usr/local/bin/xray
XRAY_API=127.0.0.1:10085
EOF
chmod 600 /etc/vpn-agent/env

# access log 轮转：Xray 持有 fd，用 copytruncate 方式，避免撑爆磁盘
mkdir -p /var/log/xray
chown wafer:wafer /var/log/xray 2>/dev/null || true
cat > /etc/logrotate.d/xray-access <<'EOF'
/var/log/xray/access.log {
    daily
    rotate 3
    size 50M
    copytruncate
    compress
    missingok
    notifempty
}
EOF

cat > /etc/systemd/system/vpn-agent.service <<'EOF'
[Unit]
Description=VPN Node Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env python3 /usr/local/bin/vpn-agent.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vpn-agent
systemctl restart vpn-agent
systemctl status vpn-agent --no-pager | head -10

echo "[info] vpn-agent deployed."
