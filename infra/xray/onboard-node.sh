#!/bin/bash
set -euo pipefail

# 新节点一键接入（在中心服务器本机执行）
# 用法: NODE_SUDO_PASS=xxx bash infra/xray/onboard-node.sh <IP> <ROOT密码> <地区代码> <节点名>
# 示例: NODE_SUDO_PASS=xxx bash infra/xray/onboard-node.sh 203.0.113.10 'root初始密码' HK "香港 05"
#
# 自动完成：wafer 用户 + SSH 互信 → DNS 记录（CF，地理命名 hk01/jp01…）→
#           Xray(wafer 运行) → Caddy TLS → 注册节点 → 部署 agent → ufw 防火墙 → 验证
# 前提：本机有 ~/.ssh/id_ed25519_cloudvpn(.pub)、workers/api/.dev.vars
#      （ADMIN_KEY + CLOUDFLARE_API_TOKEN + NODE_SUDO_PASS）、sshpass、node。
# 安全约定：wafer 的 sudo 密码统一由 NODE_SUDO_PASS 提供（存 .dev.vars，不入库）；
#      节点初始化后应 passwd -l root + sshd 关闭密码登录（仅密钥）。

IP="${1:-}"
ROOT_PASS="${2:-}"
REGION="${3:-}"
NAME="${4:-}"

if [ -z "$IP" ] || [ -z "$ROOT_PASS" ] || [ -z "$REGION" ] || [ -z "$NAME" ]; then
  echo "Usage: NODE_SUDO_PASS=xxx bash infra/xray/onboard-node.sh <IP> <ROOT密码> <地区代码> <节点名>"
  echo "Example: NODE_SUDO_PASS=xxx bash infra/xray/onboard-node.sh 203.0.113.10 'pass' HK \"香港 05\""
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SSH_KEY="$HOME/.ssh/id_ed25519_cloudvpn"
# wafer 初始 sudo 密码：统一由环境变量传入（存 .dev.vars 的 NODE_SUDO_PASS，不入库）
WAFER_PASS="${NODE_SUDO_PASS:?请设置 NODE_SUDO_PASS（见 workers/api/.dev.vars）}"
API_BASE="https://fastergamer.click"
DOMAIN_SUFFIX="fastergamer.click"
DEV_VARS="$ROOT_DIR/workers/api/.dev.vars"
export CLOUDFLARE_API_TOKEN=$(grep '^CLOUDFLARE_API_TOKEN=' "$DEV_VARS" | cut -d= -f2)
ADMIN_KEY=$(grep '^ADMIN_KEY=' "$DEV_VARS" | cut -d= -f2)

SSH_ROOT="sshpass -p $ROOT_PASS ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 root@$IP"
SSH_WAFER="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15 wafer@$IP"
SUDO="echo $WAFER_PASS | sudo -S -p ''"

step() { echo; echo "===== [$1] $2 ====="; }

# ---------- 0. 派生参数：下一个地理子域名、节点 id ----------
step 0 "计算子域名与节点 id"
PREFIX=$(echo "$REGION" | tr 'A-Z' 'a-z')
SEQ=$(node "$ROOT_DIR/scripts/cf-dns.mjs" list "$PREFIX" | grep -oE "^${PREFIX}[0-9]+" | sed "s/${PREFIX}//" | sort -n | tail -1)
SEQ=$(( ${SEQ:-0} + 1 ))
RR=$(printf "%s%02d" "$PREFIX" "$SEQ")
NODE_ID="node-${PREFIX}-$(printf '%02d' "$SEQ")"
DOMAIN="$RR.$DOMAIN_SUFFIX"
# 节点 id 与 DNS 编号历史上已脱节（如 node-hk-05 → hk02），注册前须查注册表防撞 id
ID_SEQ=$SEQ
while curl -sf -H "x-admin-key: $ADMIN_KEY" "$API_BASE/api/admin/nodes" \
    | grep -q "\"id\":\"$NODE_ID\""; do
  ID_SEQ=$(( ID_SEQ + 1 ))
  NODE_ID="node-${PREFIX}-$(printf '%02d' "$ID_SEQ")"
done
echo "RR=$RR  DOMAIN=$DOMAIN  NODE_ID=$NODE_ID"

# ---------- 1. wafer 用户 + SSH 互信 ----------
step 1 "创建 wafer 用户并配置密钥登录"
PUB_KEY=$(cat "$SSH_KEY.pub")
$SSH_ROOT "
useradd -m -s /bin/bash wafer 2>/dev/null || true
echo 'wafer:$WAFER_PASS' | chpasswd
echo 'wafer ALL=(ALL) ALL' > /etc/sudoers.d/wafer && chmod 440 /etc/sudoers.d/wafer
mkdir -p /home/wafer/.ssh && echo '$PUB_KEY' > /home/wafer/.ssh/authorized_keys
chmod 700 /home/wafer/.ssh && chmod 600 /home/wafer/.ssh/authorized_keys
chown -R wafer:wafer /home/wafer/.ssh
# 部分商家镜像默认禁用密钥登录
sed -i 's/^PubkeyAuthentication no/PubkeyAuthentication yes/' /etc/ssh/sshd_config
# 密钥就绪后关密码登录与 root 直连（drop-in 优先于主配置）
printf 'PasswordAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/60-fastergamer.conf
sshd -t && systemctl restart ssh
# fail2ban + 自动安全更新
DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban unattended-upgrades >/dev/null 2>&1
systemctl enable --now fail2ban unattended-upgrades >/dev/null 2>&1
# BBR + fq：跨境丢包链路下延迟/吞吐显著优于默认 cubic（见 enable-bbr.sh）
printf 'net.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\n' > /etc/sysctl.d/99-bbr.conf
sysctl --system >/dev/null 2>&1
"
$SSH_WAFER "$SUDO whoami" | grep -q root
echo "✓ wafer 密钥登录 + sudo 就绪"

# ---------- 2. DNS ----------
step 2 "添加 DNS 记录 $DOMAIN -> $IP"
node "$ROOT_DIR/scripts/cf-dns.mjs" add "$RR" "$IP" "$NAME"
for i in $(seq 1 12); do
  # AliDNS 对新记录常有负缓存滞后，223.5.5.5 与 1.1.1.1 任一生效即放行
  #（证书签发走 LE 多视角验证，不依赖 AliDNS；国内客户端解析稍后自动收敛）
  RESOLVED=$(dig +short "$DOMAIN" @223.5.5.5 | head -1)
  [ "$RESOLVED" = "$IP" ] && break
  RESOLVED=$(dig +short "$DOMAIN" @1.1.1.1 | head -1)
  [ "$RESOLVED" = "$IP" ] && break
  echo "等待 DNS 生效... ($i/12)"
  sleep 5
done
[ "${RESOLVED:-}" = "$IP" ] || { echo "✗ DNS 未生效"; exit 1; }
echo "✓ DNS 已生效"

# ---------- 3. 安装 Xray（wafer 运行） ----------
step 3 "安装 Xray 并改为 wafer 用户运行"
$SSH_WAFER "$SUDO bash -c '
  curl -sL https://github.com/XTLS/Xray-install/raw/main/install-release.sh -o /tmp/xray-install.sh
  bash /tmp/xray-install.sh install >/dev/null 2>&1
  rm /tmp/xray-install.sh
  sed -i \"s/^User=nobody/User=wafer/\" /etc/systemd/system/xray.service
  grep -q \"^Group=\" /etc/systemd/system/xray.service || sed -i \"s/^User=wafer/User=wafer\nGroup=wafer/\" /etc/systemd/system/xray.service
  chown -R wafer:wafer /var/log/xray
  systemctl daemon-reload
'"
echo "✓ Xray 已安装（User=wafer）"

# ---------- 4. Caddy TLS ----------
step 4 "安装 Caddy 并签发 $DOMAIN 证书"
scp -i "$SSH_KEY" -q "$ROOT_DIR/infra/xray/install-caddy.sh" "wafer@$IP:/tmp/"
$SSH_WAFER "$SUDO bash /tmp/install-caddy.sh $DOMAIN >/dev/null && rm /tmp/install-caddy.sh"
for i in $(seq 1 24); do
  PONG=$(curl -s --max-time 10 "https://$DOMAIN/ping" || true)
  [ "$PONG" = "pong" ] && break
  echo "等待证书签发... ($i/24)"
  sleep 5
done
[ "${PONG:-}" = "pong" ] || { echo "✗ /ping 未通，检查 Caddy 日志"; exit 1; }
echo "✓ https://$DOMAIN/ping -> pong"

# ---------- 5. 注册节点 ----------
step 5 "注册节点 $NODE_ID（$NAME）"
RESP=$(curl -s -X POST "$API_BASE/api/admin/nodes" \
  -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d "{\"id\":\"$NODE_ID\",\"name\":\"$NAME\",\"region\":\"$REGION\",\"host\":\"$DOMAIN\",\"port\":443,\"tls\":true,\"ws_path\":\"/vless-ws\"}")
echo "$RESP"
NODE_KEY=$(echo "$RESP" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.node.key")
echo "✓ 已注册，NODE_KEY=$NODE_KEY"

# ---------- 6. 部署 Agent ----------
step 6 "部署 vpn-agent"
scp -i "$SSH_KEY" -q "$ROOT_DIR/infra/xray/agent.py" "wafer@$IP:/tmp/vpn-agent.py"
scp -i "$SSH_KEY" -q "$ROOT_DIR/infra/xray/deploy-agent.sh" "wafer@$IP:/tmp/"
$SSH_WAFER "$SUDO bash /tmp/deploy-agent.sh $NODE_KEY >/dev/null && rm /tmp/deploy-agent.sh /tmp/vpn-agent.py"
echo "✓ agent 已部署"

# ---------- 7. 防火墙 ----------
step 7 "配置 ufw（仅 22/80/443）"
$SSH_WAFER "$SUDO bash -c 'ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw default deny incoming && ufw default allow outgoing && yes | ufw enable' >/dev/null 2>&1"
echo "✓ ufw 已启用"

# ---------- 8. 验证 ----------
step 8 "等待 agent 同步并验证"
sleep 40
$SSH_WAFER "$SUDO journalctl -u vpn-agent -n 30 --no-pager | grep -q 'active uuids'" \
  && echo "✓ agent 配置同步正常" || echo "✗ 未检测到配置同步，请 journalctl -u vpn-agent 排查"
$SSH_WAFER "systemctl is-active xray vpn-agent caddy" | tr '\n' ' '; echo
UUID=$(curl -s -H "x-admin-key: $ADMIN_KEY" "$API_BASE/api/admin/tokens" | node -pe "
  const ts = JSON.parse(require('fs').readFileSync(0, 'utf8')).data ?? [];
  const t = ts.find((t) => t.status === 'active' && (t.expires_at ?? 0) > Date.now());
  t ? t.uuid : '';
")
[ -n "$UUID" ] && curl -s --max-time 10 "$API_BASE/api/sub?uuid=$UUID" | grep -q "$NAME" \
  && echo "✓ 订阅已包含 $NAME" || echo "✗ 订阅未包含 $NAME（或无 active token）"

echo
echo "===== 完成：$NODE_ID ($NAME, $DOMAIN, $IP) 已接入 ====="
echo "建议再跑端到端验证：bash $ROOT_DIR/scripts/test-node.sh $RR"
