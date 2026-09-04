# AGENTS.md —— fastergamer / CloudVPN（Token 制 VPN 服务）

本文件面向 AI 编码代理，描述本仓库的架构、开发流程与约定。项目文档与代码注释均为中文，提交信息也用中文。

## 项目概览

Token 制 VPN 服务（对外品牌 GameBoost / FasterGamer）：用户无需注册，购买 token（VLESS UUID）后激活即用。整套系统由三部分组成：

```
用户浏览器 → fastergamer.click（CF Worker + Static Assets，前后端同源，唯一生产中心）
用户 Clash 客户端 → 直连所选 VPS 节点（VLESS + WS + TLS，节点域名 *.fastergamer.click，不经过 Worker）
                 └→ 每台 VPS 跑 vpn-agent（Python）：拉授权快照、在线增删用户、事件驱动上报流量结算
节点在线探测 → 中心服务器 cron 每 5 分钟从国内探测各节点 /ping（scripts/probe-nodes.sh）
```

核心数据模型：token（主 uuid 即主设备）、设备槽位（每设备独立 uuid/订阅链接，流量按设备审计计入 token 总量）、套餐（含流量限额与设备上限）、节点注册表、工单/FAQ。详细业务规则（月度配额预支、风险提醒、90 天数据清理等）见 `README.md` 的「限制与注意」一节——改动相关业务前先读它。

## 目录结构

| 目录 | 说明 | 技术栈 |
|------|------|--------|
| `workers/api` | 中心 API（售卖、token 状态机、节点注册表、流量结算、工单） | Hono 4 + Cloudflare KV + TypeScript |
| `pages` | 前端售卖站点（GameBoost 界面） | React 18 + Vite 5 + Tailwind 3 + react-router 6 |
| `infra/xray` | VPS 落地节点：vpn-agent（`agent.py`）+ 部署脚本 | Python 3 标准库（无三方依赖） |
| `shared/types.ts` | API 与前端共享的 TypeScript 类型（Worker 经 `@shared/*` 路径别名引用） | TypeScript |
| `scripts` | 运维脚本：部署、探测、拨测、初始化套餐、DNS、端到端测试 | bash / Node.mjs / Python |
| `site-cn` | 企业门面静态页（fastergamer.cn，已退役为跳转的留档） | 纯 HTML |
| `docs` | 架构图与定价文档 | HTML / Markdown |

### Worker 代码组织（`workers/api/src`）

- `index.ts`：Hono 入口。CORS 中间件、敏感接口限流、路由挂载；`fetch` 导出里检测 `env.ASSETS` 绑定，非 `/api` 请求转给 Static Assets（404 回退 `index.html` 实现 SPA）。
- `routes/`：按资源分文件（`plans / orders / tokens / sub / register / referral / tickets / admin / nodes / agent`）。
- `lib/`：业务逻辑库（激活、签发、订阅生成 `clash.ts`、授权快照/推送、邮件 `email-aliyun.ts`、风控通知、推荐返利等）。
- `middleware/`：`admin.ts`（x-admin-key 鉴权）、`rateLimit.ts`。
- `__tests__/`：vitest 测试，与被测模块的 lib 一一对应。

## 技术栈与配置要点

- 要求 Node.js ≥ 22 + npm。根 `package.json` 是 npm workspaces（`workers/api` 与 `pages`），依赖统一在根目录 `npm install`。
- 安装依赖必须用 `npm install --legacy-peer-deps`（wrangler 4.128 声明要 `@cloudflare/workers-types ^5`，与包内 `^4` 冲突；本地 lockfile 就是这样装上的）。
- Worker 双配置并存，**用途严格区分，勿混用**：
  - `wrangler.toml`：本地 `wrangler dev`（miniflare 模拟 KV，占位 id，`ENVIRONMENT=dev` 放行 localhost CORS）。
  - `wrangler.cf.toml`：生产部署（真实 KV 命名空间 + Static Assets 托管 `../../pages/dist` + 自定义域名 fastergamer.click，`ENVIRONMENT=production`）。
- KV 命名空间共 5 个绑定：`TOKENS / PLANS / ORDERS / NODES / TICKETS`。
- 密钥（`ADMIN_KEY`、`ALIYUN_*`、`ADMIN_NOTIFY_EMAIL`、`EPAY_PRIVATE_KEY`、`CLOUDFLARE_API_TOKEN` 等）放 `workers/api/.dev.vars`（本地，git 已忽略）或用 `wrangler secret put --config wrangler.cf.toml`（生产），**绝不入库**。模板见 `.dev.vars.example`。
- 支付通道（易支付 pay.neil.asia）**已摘除收款**：下单与回调代码已删除，但交易状态机保留——`POST /api/orders` 与升级补差价照常落 pending 订单（无支付凭证，暂无法付款，待新通道接入），状态查询/管理端取消/退款均可用。`lib/epay.ts` 仅保留退款（`refundEpayOrder`，SHA256WithRSA 签名，RSA 工具函数在 `lib/rsa-sign.ts`），供管理端 `/api/admin/orders/:id/refund` 处理存量订单；`EPAY_PID/PRIVATE_KEY/PLATFORM_KEY` 密钥因此仍需保留。
- 邮件走阿里云 DirectMail（`lib/email-aliyun.ts`）。

## 常用命令

```bash
# 安装依赖（根目录）
npm install --legacy-peer-deps

# 本地开发（两个终端）
npm run dev:api        # Worker，localhost:8787（占位 KV 本地模拟）
npm run dev:pages      # 前端，localhost:5173，/api 代理到 8787（vite.config.ts）

# 初始化套餐数据（本地起服后；线上数据以 scripts/seed.mjs 为准）
node scripts/seed.mjs  # 默认打 http://localhost:8787

# 测试
cd workers/api && npm test                  # vitest run，15 个文件 109 例
cd infra/xray && python3 -m unittest test_agent   # agent 单元测试（标准库 unittest）
cd pages && npm run typecheck               # 前端类型检查（tsc --noEmit）

# 端到端验证（真实链路）
node scripts/test-plan.mjs [N] [API_BASE] [ADMIN_KEY]   # 多用户购买→订阅→真实 VLESS 连接全节点
bash scripts/test-client.sh <订阅uuid>                  # 客户端视角全链路测速
bash scripts/test-node.sh [过滤词]                      # 运维视角（本机自动取 active token）

# 部署（推荐一键脚本，经 hk02 跳板避开本机到 CF 的不稳定链路）
bash scripts/deploy-cf.sh           # 仅 API/配置改动
bash scripts/deploy-cf.sh --build   # 前端有改动，先构建 pages/dist
```

## 部署架构

- 生产唯一中心是 `fastergamer.click`：CF Worker + KV + Static Assets（前端 `pages/dist` 由 Worker 托管，前后端同源）。`fastergamer.cn` 已退役为整站 301 跳转（`scripts/deploy-site-local.sh` 仅留档）。
- 部署链路：本机在大陆，到 CF 上传不稳定，故 `deploy-cf.sh` rsync 代码到香港跳板机 hk02 再 `wrangler deploy`；脚本保持仓库相对结构（worker 引用 `../../shared`、资产引用 `../../pages/dist`），token 自动从 `.dev.vars` 读取。
- `*.workers.dev` 在大陆被封，用户入口是自定义域名；CF 管理 API 大陆可直连。
- 落地节点接入：`bash infra/xray/onboard-node.sh <IP> <ROOT密码> <地区代码> <节点名>` 一键完成（DNS → Xray → Caddy TLS → 注册 → agent → ufw）；详见 `infra/xray/README.md`。
- 中心侧定时任务（本机 cron）：`probe-nodes.sh`（每 5 分钟探测节点）、`notify-scan-cf.sh`（每 15 分钟触发到期提醒/数据清理）。

## 测试策略

- **Worker**：vitest，`src/__tests__/*.test.ts`。测试直接 `import worker from "../index"` 调 `worker.fetch`，用 mock 的 `Env`（KV 用内存假实现），不起 wrangler。改业务逻辑必须同步补/改测试。
- **agent.py**：标准库 unittest（`infra/xray/test_agent.py`），只测纯逻辑（账本、uuid 清洗、快照解析等），mock 掉网络与 subprocess。
- **前端**：无单元测试，只有 `npm run typecheck`。
- **端到端**：`scripts/test-plan.mjs` 打真实 API + 真实节点（默认打完清理测试 token）。
- 提交前必须跑相关测试（commit 规范强制要求）。

## 代码风格与约定

- 注释、文档、提交信息一律中文。注释解释「为什么」而非「是什么」。
- TypeScript strict 模式；Worker 侧共享类型走 `@shared/*` 别名（`shared/types.ts`）。
- API 响应统一包 `{ ok: boolean, data | error }`。
- 鉴权约定：管理接口 `x-admin-key`，节点 agent 接口 `x-node-key`；敏感接口在 `index.ts` 集中挂 `rateLimit`。
- KV 读写要省：中心是 CF 免费版 KV，设计上大量做事件驱动 + 缓存 + 幂等（如授权快照 5 分钟 TTL、状态翻转才写、邮件节流幂等键）。新增逻辑遵循同一思路，避免引入周期性 KV 写。
- agent 是无三方依赖的单文件 Python 3（只用标准库），部署到节点以 `wafer` 用户运行；保持这一约束，不要引入 pip 依赖。
- **git commit 规范**（`.kimi-code/skills/commit-style`，提交前必读）：中文标题一行概括根因/效果，不用 conventional commits 前缀与 emoji；正文 bullet 格式 `- 模块/文件：做了什么 + 为什么`；只写相对上次提交的新增/变更；提交前跑测试；推送目标 origin main 且须用户明确要求。

## 安全注意事项

- 防白嫖：试用/下单拒绝一次性临时邮箱（`lib/disposable-email.ts` 域名黑名单）；试用叠加每 IP 每天限领一次（`trialip:{ip}` TTL 24h）；`notify-scan` 顺带清理超 3 天未激活的体验 token。
- `.dev.vars`、SSH 私钥等绝不提交、不读取外传；`.gitignore` 已覆盖。
- CORS 只允许同源与 fastergamer.cn；localhost 仅 `ENVIRONMENT=dev` 放行——改 CORS 逻辑时必须保持这条不变（有 `cors.test.ts` 回归测试）。
- token 校验在节点 Xray 层完成（uuid 不在 clients 列表直接拒绝），Worker 侧不接触用户流量。
- 节点加固：只对外开放 443，Xray 8443 绑回环，SSH 禁密码/root 登录 + fail2ban（见 `infra/xray/configs/firewall.md`）。
- WebSocket 隧道仅支持 TCP（不支持 UDP/QUIC）；可选 Reality 直连（8444 端口）与 Hysteria2 并存。
