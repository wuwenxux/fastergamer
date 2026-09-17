#!/bin/bash
# 按邮箱清理 KV 残留数据（fg purge 的第二步；token 本体由 fg 走管理 API 删除）。
#
# 覆盖 TOKENS 命名空间的：trial:（试用标记）、reg:（防失联登记）、refcredit:/referral:
# （推广）、mailthrottle:（邮件节流计数），以及按值匹配扫描 session:/magic:/refcode:；
# 另扫 ORDERS（order: + TOKENS 里的 orderlock:）和 TICKETS（工单）。
#
# 为什么经 hk02 跳板跑 wrangler：本机（大陆）直连 CF API 不稳定，同 deploy-cf.sh。
# 用法: bash scripts/purge-email-kv.sh <邮箱>
set -uo pipefail

EMAIL="${1:-}"
[ -n "$EMAIL" ] || { echo "用法: bash scripts/purge-email-kv.sh <邮箱>"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' "$ROOT/workers/api/.dev.vars" | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "workers/api/.dev.vars 缺少 CLOUDFLARE_API_TOKEN"; exit 1; }
# 与 deploy-cf.sh 相同的账号与跳板
ACCOUNT_ID="53c1260d62876909566dc69e758d5c36"
JUMP_HOST="${JUMP_HOST:-wafer@64.90.26.88}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_cloudvpn}"
SHA1=$(python3 -c "import hashlib,sys;print(hashlib.sha1(sys.argv[1].encode()).hexdigest())" "$EMAIL")

ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$JUMP_HOST" \
  "EMAIL='$EMAIL' SHA1='$SHA1' CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID CLOUDFLARE_API_TOKEN='$TOKEN' bash -s" <<'EOF'
W=~/cloudflare/node_modules/.bin/wrangler
# 命名空间 id 与 workers/api/wrangler.cf.toml 保持一致
NS_TOKENS=f7d871af19cb4de6ba496979541d7c1e
NS_ORDERS=664bc26dca8049a7903a4b059ca98455
NS_TICKETS=f52063f8c3bf4c538ce26030fa2411db

del() { $W kv key delete --remote --namespace-id "$1" "$2" >/dev/null 2>&1 && echo "已删: $2"; }

echo "== 直接键（TOKENS）=="
for k in "trial:$EMAIL" "reg:$EMAIL" "refcredit:$EMAIL" "referral:$EMAIL" "mailthrottle:$SHA1"; do
  # CF KV 删除不存在的 key 也返回成功，先 get 确认存在再删，输出才真实
  val=$($W kv key get --remote --namespace-id $NS_TOKENS "$k" 2>/dev/null)
  [ -n "$val" ] && del $NS_TOKENS "$k"
done

echo "== 扫描 session:/magic:/refcode:（TOKENS，按值匹配邮箱）=="
for prefix in session: magic: refcode:; do
  $W kv key list --remote --namespace-id $NS_TOKENS --prefix "$prefix" 2>/dev/null \
    | python3 -c "import json,sys;[print(k['name']) for k in json.load(sys.stdin)]" \
    | while read -r key; do
        val=$($W kv key get --remote --namespace-id $NS_TOKENS "$key" 2>/dev/null)
        case "$val" in *"$EMAIL"*) del $NS_TOKENS "$key";; esac
      done
done

echo "== 扫描订单（ORDERS）=="
$W kv key list --remote --namespace-id $NS_ORDERS --prefix "order:" 2>/dev/null \
  | python3 -c "import json,sys;[print(k['name']) for k in json.load(sys.stdin)]" \
  | while read -r key; do
      val=$($W kv key get --remote --namespace-id $NS_ORDERS "$key" 2>/dev/null)
      case "$val" in *"$EMAIL"*)
        del $NS_ORDERS "$key"
        del $NS_TOKENS "orderlock:${key#order:}"
      ;; esac
    done

echo "== 扫描工单（TICKETS，按值匹配邮箱）=="
$W kv key list --remote --namespace-id $NS_TICKETS --prefix "ticket:" 2>/dev/null \
  | python3 -c "import json,sys;[print(k['name']) for k in json.load(sys.stdin)]" \
  | while read -r key; do
      val=$($W kv key get --remote --namespace-id $NS_TICKETS "$key" 2>/dev/null)
      case "$val" in *"$EMAIL"*) del $NS_TICKETS "$key";; esac
    done
echo "== KV 清理完成 =="
EOF
