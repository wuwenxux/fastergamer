#!/bin/bash
set -euo pipefail

# 生产部署 API（本机 workerd 模式）
# 流程：打包 → 生成 config.capnp → 重启 systemd 服务
# 用法: bash scripts/deploy-api-local.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROD_DIR=/home/wafer/fastergamer

cd "$ROOT/workers/api"
npx wrangler deploy --dry-run --outdir "$PROD_DIR" >/dev/null
# dry-run 会在输出目录写 README.md，不需要
rm -f "$PROD_DIR/README.md" "$PROD_DIR/index.js.map"

node "$ROOT/scripts/gen-workerd-config.mjs" "$PROD_DIR"

sudo systemctl restart fastergamer-api
sleep 2
systemctl is-active fastergamer-api && echo "✓ fastergamer-api 已重启"
curl -s -o /dev/null -w "✓ /api/plans: %{http_code}\n" --max-time 10 http://127.0.0.1:8787/api/plans
