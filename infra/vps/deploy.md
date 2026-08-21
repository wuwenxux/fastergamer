# 把 VPN 网站部署到 VPS（186.244.238.139）

目标：`http://186.244.238.139` 打开 VPN 官网（定价/购买/激活）。

有两种模式：
- **本地模式**（无需 Cloudflare 认证，本机 `wrangler dev` 跑 API）——见「本地模式部署」
- **Cloudflare 模式**（正式）——API 部署到 Workers，本机只托管网站 + Xray 落地

## 本地模式部署（无需 Cloudflare 认证）

在本机跑通整条链路：网站 → API(8787)；Clash → Nginx(80) → Xray(8443) → 公网。

```bash
# 1. 构建前端（API base 留空 = 同源 /api，由 Nginx 反代到本地 API）
cd /home/wafer/Projects/cloudflare/pages
VITE_API_BASE= npm run build
sudo mkdir -p /var/www/cloudvpn
sudo tar -xzf <(tar -C dist -czf - .) -C /var/www/cloudvpn   # 或用临时 tar 文件避免 sudo 下进程替换失效

# 2. Nginx（已含 /api/ 和 /vless-ws 反代）
sudo cp infra/vps/nginx-cloudvpn.conf /etc/nginx/sites-available/cloudvpn.conf
sudo ln -sf /etc/nginx/sites-available/cloudvpn.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl restart nginx

# 3. 启动 API（systemd 托管，线上实际服务名为 fastergamer-api）
sudo cp infra/vps/cloudvpn-api.service /etc/systemd/system/fastergamer-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now fastergamer-api

# 4. 写入套餐
node scripts/seed.mjs http://127.0.0.1:8787
```

验证：
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://186.244.238.139/          # 200
curl -s -o /dev/null -w "%{http_code}\n" http://186.244.238.139/api/plans # 200
# Clash 指向 ws://186.244.238.139/vless-ws，能通即链路 OK
```

说明：
- 前端构建用 `VITE_API_BASE=`（同源），请求走 `/api/*` → Nginx 反代到本地 API Worker。
- 本地模式的 Clash 节点指 `ws://186.244.238.139/vless-ws`（80 端口明文 WS，无 TLS），
  由 Nginx 反代到本机 Xray（用户 UUID 需在本机 Xray clients 里）。
- API 的本地配置在 wrangler.toml 的 `[env.local.vars]`（`wrangler dev --env local`）。
- 之后切 Cloudflare 模式时，只需把 Nginx 的 `proxy_pass 127.0.0.1:8787` 换成真实 API Worker 域名，前端无需重新构建。

## 0. 前置：API Worker 必须已部署到 Cloudflare（Cloudflare 模式）

网站页面调用的是 Cloudflare 上的 API Worker，它还没部署时页面能打开、但购买等接口会失败。
先完成 Cloudflare 侧部署（`npx wrangler login` → `npm run deploy:api`），拿到真实 API 域名后：
把 `https://api.yourdomain.com` 替换成真实地址并**重新构建**前端（见第 1 步）。

## 1. 本地构建（已做好，含占位 API 域名）

```bash
cd pages
VITE_API_BASE=https://api.yourdomain.com   # ← 换成你真实的 API Worker 域名
npm run build        # 产物在 pages/dist/
tar -czf cloudvpn-dist.tar.gz -C dist .
```

## 2. 上传到 VPS

```bash
scp cloudvpn-dist.tar.gz root@186.244.238.139:/tmp/
```

## 3. VPS 上解压并安装 Nginx

```bash
# 解压到站点目录
sudo mkdir -p /var/www/cloudvpn
sudo tar -xzf /tmp/cloudvpn-dist.tar.gz -C /var/www/cloudvpn

# 安装 Nginx
sudo apt update && sudo apt install -y nginx

# 使用仓库里的配置（SPA 路由回退 + 静态缓存）
sudo cp /tmp/cloudvpn-dist.tar.gz /dev/null # 占位，实际把 infra/vps/nginx-cloudvpn.conf 上传后复制
```

把本仓库的 `infra/vps/nginx-cloudvpn.conf` 上传到 `/etc/nginx/sites-available/cloudvpn.conf`：

```bash
sudo cp cloudvpn.conf /etc/nginx/sites-available/
sudo ln -s /etc/nginx/sites-available/cloudvpn.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx
```

## 4. 验证

```bash
curl -s -o /dev/null -w "%{http_code}" http://186.244.238.139/   # 200
curl -s -o /dev/null -w "%{http_code}" http://186.244.238.139/buy # 200（SPA 回退）
```

浏览器打开 `http://186.244.238.139`。

## 注意事项

- **HTTPS**：裸 IP 拿不到 Let's Encrypt 证书。要 HTTPS 需把域名 A 记录指向 `186.244.238.139`，再用 certbot 签发，并把 Nginx 的 `server_name` 换成域名。
- **API 地址**：前端打包时把 API 域名写死了，改域名要重新构建。若想不改构建，可以之后用 Nginx 反向代理 `/api → API Worker`（需要时再加）。
- **安全**：建议至少给 SSH 开 key 登录、关闭密码登录，网站目录只读。
- **国内访问**：马来西亚节点对大陆用户延迟偏高，官网可接受；加速的话仍需优选 IP 方案。
