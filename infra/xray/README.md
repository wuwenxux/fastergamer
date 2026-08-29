# Xray 落地节点部署指南

## 一键接入（推荐）

在中心服务器（本机）执行：

```bash
bash infra/xray/onboard-node.sh <IP> <ROOT密码> <地区代码> <节点名>
# 例：bash infra/xray/onboard-node.sh 64.90.26.88 'pass' HK "香港 05"
```

自动完成：wafer 用户 + SSH 互信 → DNS（`hk01/jp01/… .fastergamer.click`，地理命名 + 编号）→
Xray（wafer 用户运行）→ Caddy TLS → 注册节点 → 部署 agent → ufw → 验证。
DNS 操作用 `scripts/cf-dns.mjs`（Cloudflare API，复用 `.dev.vars` 的 CLOUDFLARE_API_TOKEN），
也可单独 `node scripts/cf-dns.mjs list` 查看现有记录。

## 端到端验证

```bash
# 客户端视角（推荐，任何 Linux/macOS 机器，只需订阅 uuid）：
bash scripts/test-client.sh <订阅uuid>

# 运维视角（在中心服务器本机，自动取 active token，可按名称/host 过滤）：
bash scripts/test-node.sh [过滤词]
```

`test-client.sh` 走完整用户链路：拉订阅 → 解析节点 → 起临时 Xray socks
客户端（首次自动下载到 `~/.cache/xray-client-test`）→ 经节点真实代理访问
Google / YouTube / ChatGPT / Claude，逐项打勾。
说明：ChatGPT 用 `/cdn-cgi/trace` 判定（curl 裸 UA 打首页会被 WAF 误拦）；
Claude 区域封锁会 302 到 `app-unavailable-in-region`，按 Location 判定。

以下为手动分步流程（排障或定制时参考）。

## 架构回顾

用户 → Clash → **直连本机**（VLESS + WS + TLS，域名:443）→ 本机 Xray → 目标网站

- 本机的 `vpn-agent` 平时不轮询中心：授权变更由中心 POST `/api/agent/refresh` 主动推送（立即拉配置生效），仅保留 30 分钟兜底拉取防丢；用户(uuid)增删通过 Xray HandlerService 在线生效（`xray api adu/rmu`，不重启），仅配置结构变化时整体重启 Xray。**流量结算事件驱动**：本地账本按周期比对 Xray 计数器，只在断联（连续 3 周期无增量且离线）、配额触线或计数器消失时才上报中心，连接活着且未触线 = 完全静默；账本落盘 `/var/lib/vpn-agent/ledger.json`，上报失败不丢账
- **接入 IP 统计**：Caddy 以 PROXY protocol v1 把真实客户端 IP 透传给 Xray（Xray inbound 开 `acceptProxyProtocol`），access log 记录 `来源IP + email(uuid)`；agent 增量解析日志，把每个上报周期内「uuid → 来源IP → 连接次数」上报中心，中心按连接数比例把流量增量分摊到各 IP（估算口径，Xray 不提供逐连接字节数）。用户在 Token 页可见自己的接入 IP 统计
- token 校验在 Xray 层完成：UUID 不在 clients 列表里的连接会被直接拒绝
- 客户端通过订阅里的节点域名直连本机，**不经过 Cloudflare Worker**

## 步骤

### 0. 准备域名

给本机分配一个（子）域名并解析到 VPS IP，例如 `my1.example.com`。
TLS 证书由 Caddy/Nginx + Certbot 自动签发，客户端必须走 wss://域名:443。

### 1. 安装 Xray

```bash
sudo bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh) @ install"
```

无需手写 Xray 配置——Agent 首次同步时会自动生成（监听 127.0.0.1:8443，WS 路径 `/vless-ws`）。

> 安全加固：官方脚本装的 `xray.service` 默认 `User=nobody`，生产节点已统一改为
> `User=wafer` + `Group=wafer`（并 `chown -R wafer:wafer /var/log/xray`）。新节点照此调整。

### 2. TLS 反代（二选一）

```bash
# 方式 A：Caddy（自动 HTTPS，最省事；以 PROXY protocol 透传真实客户端 IP）
sudo bash install-caddy.sh my1.example.com

# 方式 B：已有 Nginx 的机器
sudo bash install-nginx-node.sh my1.example.com
```

两者都会把 `https://域名/vless-ws` 反代到 `127.0.0.1:8443`，并提供一个 `/ping` 测速端点。

> ⚠️ 开源 Nginx 的 http proxy 模块**不支持向上游发送 PROXY protocol**
> （`proxy_protocol on;` 仅存在于 stream 模块），方式 B 下 Xray 拿不到真实客户端
> IP，接入 IP 统计不可用，且 Xray 开了 `acceptProxyProtocol` 会导致全部连接失败。
> 已有 Nginx 的机器参照 nx1 的做法：Caddy 监听替代端口（如 2087）复用
> Certbot 证书（`/etc/letsencrypt/renewal-hooks/deploy/` 钩子同步证书 + reload caddy），
> 节点端口在中心改为该端口。

### 3. 注册节点并安装 Agent

先在中心 API 注册节点，拿到 `key`（`nk_...`）：

```bash
curl -s -X POST https://api.你的域名.com/api/admin/nodes \
  -H "x-admin-key: 你的ADMIN_KEY" -H "content-type: application/json" \
  -d '{"id":"node-my-01","name":"马来西亚 1","region":"MY","host":"my1.example.com","port":443,"tls":true,"ws_path":"/vless-ws"}'
```

然后用返回的 key 部署 Agent（agent 代码在仓库 `infra/xray/agent.py`，先 scp 到节点）：

```bash
scp agent.py root@节点:/tmp/vpn-agent.py
sudo bash deploy-agent.sh nk_xxxxxxxx
```

Agent 启动后 30 秒内会拉取配置、生成 Xray config 并启动转发。可用 `journalctl -u vpn-agent -f` 观察同步日志。

### 4. 验证

```bash
systemctl status xray vpn-agent
curl -s https://my1.example.com/ping   # pong
```

把 Clash 指向订阅中的该节点，能通即完成。

## 多地区重复

对每个地区（香港、日本、新加坡、美国……）各做一遍，分别注册成不同 `id`/`region` 的节点。
订阅生成时会自动带上所有 `active: true` 的节点，无需改 Worker 配置。

## 防火墙加固

见 `configs/firewall.md`：本机只对外开放 443（TLS 入口），8443 绑定在回环口不暴露。
SSH 层面：`PasswordAuthentication no` + `PermitRootLogin no`（drop-in
`/etc/ssh/sshd_config.d/60-fastergamer.conf`）+ fail2ban，一键脚本已内置。

## 被墙/故障探测

agent 已是事件驱动（无心跳），节点在线状态完全由中心服务器上的
`scripts/probe-nodes.sh` 负责（cron 每 5 分钟）：从国内 curl 各节点
`https://<host>/ping`，连续 2 次失败邮件告警（IP 被墙、证书失效、Caddy 故障
都会触发），恢复后自动通知。告警走 `POST /api/admin/alert`。

## 中国大陆访问优化（可选项）

1. **优选线路 VPS**：直连模式下延迟取决于用户到 VPS 的线路，选 CN2/iplc 等优化线路
2. **CDN 中转**：把节点域名挂到 CDN 后面可以隐藏 VPS 真实 IP，但会牺牲部分速度
3. **多节点冗余**：同地区部署多台，用户在 Clash 里切换

这些属于运维层优化，不影响本项目的代码结构。
