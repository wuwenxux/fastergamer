#!/bin/bash
set -euo pipefail

# 在 VPS 上一键安装 Caddy + 自动 HTTPS
# 用法：sudo bash install-caddy.sh <DOMAIN>
# 示例：sudo bash install-caddy.sh my01.fastergamer.click

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash install-caddy.sh <DOMAIN>"
  echo "Example: sudo bash install-caddy.sh my01.fastergamer.click"
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
    # PROXY protocol v1：把真实客户端 IP 带给 Xray（access log 按接入 IP 统计依赖它）
    # 注意：Xray 侧必须同步开启 acceptProxyProtocol，否则连接无法建立
    reverse_proxy /vless-ws 127.0.0.1:8443 {
        transport http {
            proxy_protocol v1
        }
    }

    # 本地应答（去中心化）：订阅由 agent 按本地缓存的授权快照渲染，中心不可达也照常；
    # /api/metrics 暴露本节点监控指标（需 x-node-key 鉴权）
    @localapi path /api/sub* /api/metrics* /api/agent/refresh*
    handle @localapi {
        reverse_proxy 127.0.0.1:8788
    }

    # 其余 /api 反代到 CF 中心（fastergamer.click 即生产端，节点侧不触碰 fastergamer.cn）
    handle /api/* {
        reverse_proxy https://fastergamer.click {
            header_up Host fastergamer.click
        }
    }

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
