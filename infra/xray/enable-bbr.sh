#!/bin/bash
set -euo pipefail

# 开启 BBR 拥塞控制 + fq 队列（幂等，可重复执行）。
# 背景：跨境链路晚高峰有丢包，cubic 遇丢包剧烈降速、延迟飙升；
# BBR 按带宽×RTT  pacing 发送，丢包链路下延迟/吞吐显著优于 cubic。
#
# 用法（在节点上）：sudo bash enable-bbr.sh

CONF=/etc/sysctl.d/99-bbr.conf

if [ -f "$CONF" ] && grep -q "tcp_congestion_control=bbr" "$CONF"; then
  echo "BBR 配置已存在，跳过写入"
else
  tee "$CONF" <<EOF
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
EOF
  echo "已写入 $CONF"
fi

sysctl --system >/dev/null
echo "当前拥塞控制: $(sysctl -n net.ipv4.tcp_congestion_control)"
echo "当前队列规则: $(sysctl -n net.core.default_qdisc)"
