#!/bin/bash
set -euo pipefail

# 部署前端站点到本机 nginx 目录（/var/www/fastergamer.cn）
# 用法: bash scripts/deploy-site-local.sh
#
# 架构说明：.cn 现为纯静态门面站，无本地后端。API 指向 CF 上的 fastergamer.click
# （CORS 已白名单 fastergamer.cn 来源），数据只有 CF KV 一份，不与 workerd 双写。

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT/pages"
VITE_API_BASE=https://fastergamer.click npm run build   # API 全部走 CF

sudo rsync -a --delete "$ROOT/pages/dist/" /var/www/fastergamer.cn/
echo "✓ 站点已发布到 /var/www/fastergamer.cn（API → fastergamer.click）"
curl -s -o /dev/null -w "✓ 首页: %{http_code}\n" --max-time 10 https://fastergamer.cn/
