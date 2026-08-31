#!/bin/bash
set -euo pipefail

# 在节点 Caddyfile 追加 sub.fastergamer.click 订阅专用站点块（幂等，可重复执行）。
# 背景：fastergamer.click 主域挂 CF 橙云，国内访客被分到远端 PoP（实测 AMS），
# 订阅/测速改走 sub.fastergamer.click 灰云直连本机，绕开 CF 边缘。
# 只暴露本地渲染的 /api/sub（agent 授权快照，不依赖中心）与 /ping，其余一律 404。
#
# 用法（在节点上）：sudo bash add-sub-entry.sh [SUB_DOMAIN]
# 默认 SUB_DOMAIN=sub.fastergamer.click

SUB_DOMAIN="${1:-sub.fastergamer.click}"
CADDYFILE=/etc/caddy/Caddyfile

if grep -q "^${SUB_DOMAIN} " "$CADDYFILE"; then
  echo "站点块 ${SUB_DOMAIN} 已存在，跳过追加"
else
  tee -a "$CADDYFILE" <<EOF

${SUB_DOMAIN} {
    # 订阅由本地 agent 按授权快照渲染（127.0.0.1:8788），中心不可达也照常
    @localapi path /api/sub*
    handle @localapi {
        reverse_proxy 127.0.0.1:8788
    }

    # 客户端测速用端点（用 handle 包裹：handle 指令序优先于裸 respond，否则会被兜底 404 截胡）
    handle /ping {
        respond "pong" 200
    }

    # 订阅入口不镜像其余 /api，一律 404
    handle {
        respond "not found" 404
    }
}
EOF
  echo "已追加站点块 ${SUB_DOMAIN}"
fi

caddy validate --config "$CADDYFILE" --adapter caddyfile
systemctl reload caddy
echo "完成。证书由 Caddy 自动签发（TLS-ALPN-01 走 443，无需开放 80 端口），"
echo "可用 curl -s https://${SUB_DOMAIN}/ping 验证（DNS 生效后）。"
