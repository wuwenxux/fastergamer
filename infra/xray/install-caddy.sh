#!/bin/bash
set -euo pipefail

# 在 VPS 上一键安装 Caddy + 自动 HTTPS
# 用法：sudo bash install-caddy.sh <DOMAIN>
# 示例：sudo bash install-caddy.sh my1.fastergamer.cn

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash install-caddy.sh <DOMAIN>"
  echo "Example: sudo bash install-caddy.sh my1.fastergamer.cn"
  exit 1
fi

sudo apt-get update
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update
  sudo apt-get install -y caddy
fi

sudo tee /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy /vless-ws 127.0.0.1:8443

    # 客户端测速用端点
    respond /ping "pong" 200
    header /ping {
        Access-Control-Allow-Origin "*"
        Access-Control-Allow-Methods "GET, OPTIONS"
        Access-Control-Allow-Headers "*"
        Cache-Control "no-store"
    }
}
EOF

sudo systemctl enable caddy
sudo systemctl restart caddy
sudo systemctl status caddy --no-pager | head -10

sudo ufw allow 443/tcp

echo "Caddy deployed for ${DOMAIN}. Ensure DNS A record points to this server's IP."
