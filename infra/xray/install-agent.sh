#!/bin/bash
set -euo pipefail

# 在 VPS 上安装 vpn-agent systemd 服务
# 用法：sudo bash install-agent.sh <NODE_KEY>

NODE_KEY="${1:-}"
if [ -z "$NODE_KEY" ]; then
  echo "Usage: sudo bash install-agent.sh <NODE_KEY>"
  exit 1
fi

AGENT_SRC="${AGENT_SRC:-agent.py}"
if [ ! -f "$AGENT_SRC" ]; then
  echo "agent.py not found at $AGENT_SRC"
  exit 1
fi

mkdir -p /etc/vpn-agent
install -m 755 "$AGENT_SRC" /usr/local/bin/vpn-agent.py

cat > /etc/vpn-agent/env <<EOF
API_URL=https://fastergamer.cn/api/agent/config
NODE_KEY=$NODE_KEY
XRAY_CONFIG=/usr/local/etc/xray/config.json
XRAY_LISTEN=127.0.0.1
EOF
chmod 600 /etc/vpn-agent/env

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
systemctl status vpn-agent --no-pager | head -8

echo "vpn-agent installed and started."
