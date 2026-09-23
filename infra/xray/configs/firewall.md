# 落地节点防火墙加固

直连架构下，**用户的 Clash 直接连本机**，所以 443（TLS 入口）必须对公网开放；
Xray 本体监听在 127.0.0.1:8443，不应对外暴露。

启用 Reality 直连入站（`/etc/vpn-agent/env` 配了 `REALITY_PRIVATE_KEY`）的节点，
额外开放 `REALITY_PORT`（默认 8444）——该端口由 Xray 直接监听公网，
未通过认证的流量被转发给伪装站点（fallback），探测者看到的是伪装站证书。

## 用 ufw 配置

```bash
sudo apt update && sudo apt install -y ufw

# 先放行 SSH，避免把自己锁在外面
sudo ufw allow 22/tcp

# TLS 入口（Caddy/Nginx）：80 用于证书签发续期，443 承载流量
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 出站封 SMTP：防滥用者用节点发垃圾邮件把出口 IP 送进黑名单（代理落地不需要直连 SMTP）
sudo ufw deny out 25/tcp
sudo ufw deny out 465/tcp

# 默认拒绝入站
sudo ufw default deny incoming
sudo ufw default allow outgoing

sudo ufw enable
sudo ufw status
```

## 验证

```bash
# Xray 只应绑定在回环口
ss -tlnp | grep 8443        # 预期看到 127.0.0.1:8443

# 从外部应无法直连 8443
nc -zv <VPS_IP> 8443        # 预期失败
```

## 进一步加固（可选）

- **隐藏 VPS 真实 IP**：把节点域名挂到 Cloudflare 橙云（CDN 代理）后面，
  此时可用 CF 回源 IP 段（https://www.cloudflare.com/ips-v4）给 443 做白名单，
  用户真实 IP 对 VPS 也不可见（代价是多一层跳转的延迟）
- **服务商安全组**：若服务商提供安全组（阿里云、AWS SG 等），在那一层做同样规则，双保险
- **Xray 日志**：保持 `loglevel: warning`；access log **必须开启**——agent 依赖它
  做接入 IP 统计（按 uuid 归因 presence 画像），关闭会导致 IP 画像停摆。
  日志量由 deploy-agent.sh 配置的 logrotate 兜底（按天轮转、单文件 50M、
  copytruncate、保留 3 份压缩），不会撑爆磁盘

> 提示：Xray 只认 Agent 同步进来的有效用户 UUID，即使 443 路径被扫到，
> 没有合法 UUID 的连接也会被拒绝。Agent 的 `NODE_KEY` 是本机最重要的凭据，
> 存放在 `/etc/vpn-agent/env`（权限 600）。
