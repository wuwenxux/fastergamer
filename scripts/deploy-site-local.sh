#!/bin/bash
set -euo pipefail

# 部署前端站点到本机 nginx 目录（/var/www/fastergamer.cn）
# 用法: bash scripts/deploy-site-local.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/pages"
VITE_API_BASE= npm run build   # 同源 /api，由 nginx 反代

sudo rsync -a --delete "$ROOT/pages/dist/" /var/www/fastergamer.cn/
echo "✓ 站点已发布到 /var/www/fastergamer.cn"
curl -s -o /dev/null -w "✓ 首页: %{http_code}\n" --max-time 10 https://fastergamer.cn/
