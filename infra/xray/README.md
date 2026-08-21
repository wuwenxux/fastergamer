# Xray 落地节点部署指南

每个地区的 VPS 重复以下步骤一次。

## 架构回顾

用户 → Clash → **直连本机**（VLESS + WS + TLS，域名:443）→ 本机 Xray → 目标网站

- 本机的 `vpn-agent` 每 30 秒向中心 API 拉取所有 active 用户的 UUID，重写 Xray 配置并 reload；同时上报每用户流量、在线数与心跳
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

### 2. TLS 反代（二选一）

```bash
# 方式 A：Caddy（自动 HTTPS，最省事）
sudo bash install-caddy.sh my1.example.com

# 方式 B：已有 Nginx 的机器
sudo bash install-nginx-node.sh my1.example.com
```

两者都会把 `https://域名/vless-ws` 反代到 `127.0.0.1:8443`，并提供一个 `/ping` 测速端点。

### 3. 注册节点并安装 Agent

先在中心 API 注册节点，拿到 `key`（`nk_...`）：

```bash
curl -s -X POST https://api.你的域名.com/api/admin/nodes \
  -H "x-admin-key: 你的ADMIN_KEY" -H "content-type: application/json" \
  -d '{"id":"node-my-01","name":"马来西亚 1","region":"MY","host":"my1.example.com","port":443,"tls":true,"ws_path":"/vless-ws"}'
```

然后用返回的 key 安装 Agent：

```bash
sudo bash install-agent.sh nk_xxxxxxxx
# 或一键部署（脚本内嵌 agent 代码）：
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

## 中国大陆访问优化（可选项）

1. **优选线路 VPS**：直连模式下延迟取决于用户到 VPS 的线路，选 CN2/iplc 等优化线路
2. **CDN 中转**：把节点域名挂到 CDN 后面可以隐藏 VPS 真实 IP，但会牺牲部分速度
3. **多节点冗余**：同地区部署多台，用户在 Clash 里切换

这些属于运维层优化，不影响本项目的代码结构。
