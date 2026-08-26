#!/bin/bash
# nx7.fastergamer.cn 证书签发看守（cron 每小时跑一次）
#
# 背景：Let's Encrypt 生产环境从境外验证节点查询阿里云免费 DNS（hichina）
# 权威服务器经常超时，导致 nx7 证书签发反复失败；Caddy 内置重试会不断产生
# 新的失败授权记录，把限流窗口无限续期，所以不能让它自己跑。
#
# 策略：每小时做一次"干净的单次尝试"——先停 Caddy（切断内部重试），
# 再启动（触发一次 obtain），3 分钟后检查 /ping；失败则停掉等下一小时。
# 成功后自动把 node-hk-07 上架并从 crontab 自毁。
set -u
HOST=nx7.fastergamer.cn
IP=154.64.250.144
SSH="ssh -i $HOME/.ssh/id_ed25519_cloudvpn -o BatchMode=yes -o ConnectTimeout=15 wafer@$IP"
SUDO="echo ***REMOVED*** | sudo -S -p ''"
NODES_KV=/home/wafer/fastergamer/kv/NODES/nodes

echo "== $(date -Is) 检查 =="
if [ "$(curl -s --max-time 8 https://$HOST/ping)" = "pong" ]; then
  echo "已签发，无需处理"
else
  $SSH "$SUDO systemctl start caddy" && echo "caddy 启动，等待签发..."
  sleep 180
fi

if [ "$(curl -s --max-time 8 https://$HOST/ping)" = "pong" ]; then
  echo "✓ 证书签发成功"
  # 上架节点
  python3 - <<'PYEOF'
import json
p = "/home/wafer/fastergamer/kv/NODES/nodes"
d = json.load(open(p))
for n in d:
    if n["id"] == "node-hk-07":
        n["active"] = True
json.dump(d, open(p, "w"), ensure_ascii=False, indent=2)
print("node-hk-07 已上架")
PYEOF
  # 自毁 cron
  crontab -l 2>/dev/null | grep -v "cert-watch-nx7" | crontab -
  echo "已从 crontab 移除本任务"
else
  echo "✗ 本轮未签发，停掉 Caddy 等下一轮"
  $SSH "$SUDO systemctl stop caddy"
fi
