#!/bin/bash
set -euo pipefail

# 部署 fastergamer.cn 企业合作门面站（纯静态）到本机 nginx 目录
# 用法: bash scripts/deploy-site-local.sh
#
# 架构说明：.cn 是企业合规门面（B2B，无个人付款入口），源文件在 site-cn/。
# nginx 配置 /etc/nginx/sites-enabled/fastergamer.cn：整站静态，
# 仅 /api/* 301 到 fastergamer.click（兼容老订阅链接）。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

sudo rsync -a --delete "$ROOT/site-cn/" /var/www/fastergamer.cn/
echo "✓ 门面站已发布到 /var/www/fastergamer.cn"
curl -s -o /dev/null -w "✓ 首页: %{http_code}\n" --max-time 10 https://fastergamer.cn/
curl -s -o /dev/null -w "✓ 老订阅 301: %{http_code}\n" --max-time 10 "https://fastergamer.cn/api/sub?uuid=probe"
