#!/bin/bash
set -euo pipefail

# 一键部署 vpn-api Worker + 前端静态资产到 Cloudflare（经 hk02 跳板）
#
# 为什么走跳板：本机（大陆）到 CF 上传链路不稳定，hk02（香港）到 api.cloudflare.com
# 又快又稳。流程：rsync 仓库必要目录（保持相对结构）→ 跳板机装依赖 → wrangler deploy
# → 清理临时目录（trap 兜底，失败也会删）。
#
# 用法：
#   bash scripts/deploy-cf.sh [--build]
#     --build  先 cd pages && npm run build 再部署（前端有改动时用）
#
# 依赖：
#   - 本机 ssh 免密到跳板机（~/.ssh/id_ed25519_cloudvpn，wafer 用户）
#   - CLOUDFLARE_API_TOKEN 从 workers/api/.dev.vars 读取（不入库）
#
# 注意：
#   - 必须用 wrangler.cf.toml（真实 KV 命名空间）；默认 wrangler.toml 是本地占位 id
#   - 跳板机上必须 npm install --legacy-peer-deps（wrangler 4.128 声明要
#     @cloudflare/workers-types ^5，与包内 ^4 冲突，本地 lockfile 也是这样装上的）

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JUMP_HOST="${JUMP_HOST:-wafer@64.90.26.88}"   # hk02
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_cloudvpn}"
SSH="ssh -i $SSH_KEY -o ConnectTimeout=10 $JUMP_HOST"
REMOTE_DIR="/tmp/deploy"
ACCOUNT_ID="53c1260d62876909566dc69e758d5c36"

if [ "${1:-}" = "--build" ]; then
  echo "== 构建前端 =="
  (cd "$ROOT/pages" && npm run build)
fi

TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' "$ROOT/workers/api/.dev.vars" | cut -d= -f2)
if [ -z "$TOKEN" ]; then
  echo "workers/api/.dev.vars 缺少 CLOUDFLARE_API_TOKEN"; exit 1
fi

cleanup() { $SSH "rm -rf $REMOTE_DIR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== 同步代码到 $JUMP_HOST:$REMOTE_DIR =="
$SSH "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR/workers $REMOTE_DIR/pages/dist"
# 保持仓库相对结构：worker 代码引用 ../../../../shared/types，静态资产引用 ../../pages/dist
rsync -az --delete --exclude node_modules --exclude .dev.vars -e "ssh -i $SSH_KEY" \
  "$ROOT/workers/api/" "$JUMP_HOST:$REMOTE_DIR/workers/api/"
rsync -az -e "ssh -i $SSH_KEY" "$ROOT/shared/" "$JUMP_HOST:$REMOTE_DIR/shared/"
rsync -az --delete -e "ssh -i $SSH_KEY" "$ROOT/pages/dist/" "$JUMP_HOST:$REMOTE_DIR/pages/dist/"

echo "== 跳板机安装依赖并部署 =="
$SSH "cd $REMOTE_DIR/workers/api \
  && npm install --legacy-peer-deps --silent \
  && CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID CLOUDFLARE_API_TOKEN='$TOKEN' \
     npx wrangler deploy --config wrangler.cf.toml"

echo "== 完成，临时目录已清理 =="
