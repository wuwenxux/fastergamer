#!/bin/bash
set -euo pipefail

# 在已有 nginx 的 VPS 上配置一个子域名的 TLS + WS 反代
# 用法：sudo bash install-nginx-node.sh <DOMAIN>
# 示例：sudo bash install-nginx-node.sh my1.fastergamer.cn
#
# ⚠️ 限制：开源 nginx 的 http proxy 模块不能向上游发送 PROXY protocol，
# 此方式下 Xray 拿不到真实客户端 IP，接入 IP 统计（traffic_by_ip）不可用。
# 需要 IP 统计时改用 install-caddy.sh（或参照 README 的 nx1 方案：Caddy 监听替代端口）。

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash install-nginx-node.sh <DOMAIN>"
  exit 1
fi

CONFIG_FILE="/etc/nginx/sites-available/${DOMAIN}"

sudo tee "$CONFIG_FILE" <<EOF
server {
    server_name ${DOMAIN};

    location /vless-ws {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # 客户端测速用端点，返回纯文本 pong 并允许跨域
    location /ping {
        add_header Access-Control-Allow-Origin * always;
        add_header Access-Control-Allow-Methods "GET, OPTIONS" always;
        add_header Access-Control-Allow-Headers "*" always;
        add_header Cache-Control "no-store" always;
        if (\$request_method = OPTIONS) {
            return 204;
        }
        default_type text/plain;
        return 200 "pong";
    }

    location / {
        return 404;
    }

    listen 80;
}
EOF

sudo ln -sf "$CONFIG_FILE" "/etc/nginx/sites-enabled/${DOMAIN}"
sudo nginx -t && sudo systemctl reload nginx

# 申请/更新证书并改成 443
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@${DOMAIN#*.}" --redirect 2>&1 | tail -15

sudo systemctl reload nginx
sudo systemctl status nginx --no-pager | head -5

echo "nginx node config installed for ${DOMAIN}"
