#!/bin/bash
set -euo pipefail

# 在节点 Caddyfile 追加 app.fastergamer.click 站点块（幂等，可重复执行）。
# 用途：境外完整版前端（CF Worker 静态资产 + /api）经节点回源加速——
# CF 橙云对国内访客常分到远端 PoP（实测 AMS），走本节点直连 HK/JP 落地再回源 CF 边缘，
# 国内访问延迟从 ~1s 降到 ~120ms。与 sub.fastergamer.click 订阅入口同思路。
#
# 用法（在节点上）：sudo bash add-app-entry.sh [APP_DOMAIN]
# 默认 APP_DOMAIN=app.fastergamer.click

APP_DOMAIN="${1:-app.fastergamer.click}"
ORIGIN="https://fastergamer.click"
CADDYFILE=/etc/caddy/Caddyfile

if grep -q "^${APP_DOMAIN} " "$CADDYFILE"; then
  echo "站点块 ${APP_DOMAIN} 已存在，跳过追加"
else
  tee -a "$CADDYFILE" <<EOF

${APP_DOMAIN} {
    # 整站回源 CF Worker（静态资产 + /api 同源），Host 改写让 Worker 按原域名处理
    reverse_proxy ${ORIGIN} {
        header_up Host fastergamer.click
    }
}
EOF
  echo "已追加站点块 ${APP_DOMAIN}"
fi

caddy validate --config "$CADDYFILE" --adapter caddyfile
systemctl reload caddy
echo "完成。证书由 Caddy 自动签发（TLS-ALPN-01 走 443），"
echo "可用 curl -s --resolve ${APP_DOMAIN}:443:<本机IP> https://${APP_DOMAIN}/ 验证（DNS 生效后）。"
