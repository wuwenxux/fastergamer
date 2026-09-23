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
| `site-cn` | 企业门面静态页（fastergamer.cn，纯 B2B 企业合作内容，无个人付款入口） | 纯 HTML |
| `docs` | 架构图与定价文档 | HTML / Markdown |

### Worker 代码组织（`workers/api/src`）

- `index.ts`：Hono 入口。CORS 中间件、敏感接口限流、路由挂载；`fetch` 导出里检测 `env.ASSETS` 绑定，非 `/api` 请求转给 Static Assets（404 回退 `index.html` 实现 SPA）。
- `routes/`：按资源分文件（`plans / orders / tokens / sub / register / referral / tickets / admin / nodes / agent`）。
- `lib/`：业务逻辑库（激活、签发、订阅生成——`clash.ts` Clash YAML / `sub-links.ts` vless 链接 / `singbox.ts` sing-box JSON 三格式，`sub.ts` 按 `?format=` 或 UA 路由；授权快照/推送、邮件 `email-aliyun.ts`、风控通知、推荐返利等）。
- `middleware/`：`admin.ts`（x-admin-key 鉴权）、`rateLimit.ts`、`turnstile.ts`（人机验证）。
- `__tests__/`：vitest 测试，与被测模块的 lib 一一对应。

## 技术栈与配置要点

- 要求 Node.js ≥ 22 + npm。根 `package.json` 是 npm workspaces（`workers/api` 与 `pages`），依赖统一在根目录 `npm install`。
- 安装依赖必须用 `npm install --legacy-peer-deps`（wrangler 4.128 声明要 `@cloudflare/workers-types ^5`，与包内 `^4` 冲突；本地 lockfile 就是这样装上的）。
- Worker 双配置并存，**用途严格区分，勿混用**：
  - `wrangler.toml`：本地 `wrangler dev`（miniflare 模拟 KV，占位 id，`ENVIRONMENT=dev` 放行 localhost CORS）。
  - `wrangler.cf.toml`：生产部署（真实 KV 命名空间 + Static Assets 托管 `../../pages/dist` + 自定义域名 fastergamer.click，`ENVIRONMENT=production`）。
- KV 命名空间共 5 个绑定：`TOKENS / PLANS / ORDERS / NODES / TICKETS`。
- 密钥（`ADMIN_KEY`、`ALIYUN_*`、`ADMIN_NOTIFY_EMAIL`、`CLOUDFLARE_API_TOKEN`、`TURNSTILE_SECRET_KEY` 等）放 `workers/api/.dev.vars`（本地，git 已忽略）或用 `wrangler secret put --config wrangler.cf.toml`（生产），**绝不入库**。模板见 `.dev.vars.example`。
- 人机验证用 Cloudflare Turnstile：匿名表单接口（试用/下单/notify-paid/反馈/登录链接）在 rateLimit 后挂 `middleware/turnstile.ts`（token 走 `x-turnstile-token` 头，只校验 POST，GET 轮询不受影响）；前端 sitekey 经 `GET /api/config` 下发，组件在 `pages/src/components/Turnstile.tsx`。**未配置 `TURNSTILE_SECRET_KEY` 时全链路自动放行**（本地开发/灰度期），sitekey 配在 wrangler.cf.toml 的 vars（`TURNSTILE_SITE_KEY`），secret 用 secret put。
- 支付通道（易支付 pay.neil.asia）**已彻底断开**（疑似诈骗）：下单与回调代码已删除，交易状态机保留。当前过渡方案为**人工收款码**：`POST /api/orders` 与升级补差价落 pending 订单，支付页展示站长收款码（`pages/public/pay/` 静态图），用户点「我已支付」（`POST /api/orders/:id/notify-paid`，6h 幂等节流 + IP 限流）邮件通知站长，站长确认收款（`POST /api/admin/orders/:id/paid` → `fulfillOrder`，或管理端 `/admin` 页「订单」标签一键确认/取消）自动发货发邮件。用户侧凭订单号在 `/orders/:id` 查询进度/继续支付（页脚有「查询订单」入口）。`lib/epay.ts` 仅保留退款代码（`refundEpayOrder`，SHA256WithRSA 签名，RSA 工具函数在 `lib/rsa-sign.ts`），但 `EPAY_*` 密钥已从生产删除，退款接口当前不可用，确需退款时重新 `secret put` 三项配置即可恢复。
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
cd workers/api && npm test                  # vitest run，39 个文件 296 例
cd infra/xray && python3 -m unittest test_agent   # agent 单元测试（标准库 unittest）
cd pages && npm run typecheck               # 前端类型检查（tsc --noEmit）

# 端到端验证（真实链路）
node scripts/test-plan.mjs [N] [API_BASE] [ADMIN_KEY]   # 多用户购买→订阅→真实 VLESS 连接全节点
bash scripts/test-client.sh <订阅uuid>                  # 客户端视角全链路测速
bash scripts/test-node.sh [过滤词]                      # 运维视角（本机自动取 active token）

# 日常运维统一入口（查用户/延期/改设备/节点列表/SSH/拨测/onboard/部署，密钥自动读 .dev.vars）
node scripts/fg                                         # 无参数打印全部子命令用法；详见 .kimi-code/skills/fg-ops
node scripts/fg city-probe [--city 深圳 --isp 移动]      # 指定城市×运营商节点拨测（转发 ali-city-probe.mjs）

# 部署（推荐一键脚本，经 hk02 跳板避开本机到 CF 的不稳定链路）
bash scripts/deploy-cf.sh           # 仅 API/配置改动
bash scripts/deploy-cf.sh --build   # 前端有改动，先构建 pages/dist
```

## 部署架构

- 生产唯一中心是 `fastergamer.click`：CF Worker + KV + Static Assets（前端 `pages/dist` 由 Worker 托管，前后端同源）。`fastergamer.cn` 是本机 nginx 托管的企业门面静态站（源文件 `site-cn/`，`scripts/deploy-site-local.sh` 发布到 /var/www/fastergamer.cn），整站静态、仅 `/api/*` 301 到 fastergamer.click 兼容老订阅链接；企业内容只放 .cn，click 站不放企业页。
- 部署链路：本机在大陆，到 CF 上传不稳定，故 `deploy-cf.sh` rsync 代码到香港跳板机 hk02 再 `wrangler deploy`；脚本保持仓库相对结构（worker 引用 `../../shared`、资产引用 `../../pages/dist`），token 自动从 `.dev.vars` 读取。
- `*.workers.dev` 在大陆被封，用户入口是自定义域名；CF 管理 API 大陆可直连。
- **本机 `wrangler kv` CLI 读写生产 KV 不可靠**（2026-09 实测：put 报告成功但没落库，list/get 返回错误结果——token 未绑账号 ID 时 wrangler 账号解析有异常）。需要直查/直写生产 KV（如手工沉淀 FAQ 工单到 TICKETS）时走 REST API：账号 `53c1260d62876909566dc69e758d5c36`，`GET/PUT https://api.cloudflare.com/client/v4/accounts/<acc>/storage/kv/namespaces/<ns-id>/values/<key>`，token 从 `.dev.vars` 读；写后逐键 GET 验证。
- 落地节点接入：`bash infra/xray/onboard-node.sh <IP> <ROOT密码> <地区代码> <节点名>` 一键完成（DNS → Xray → Caddy TLS → 注册 → agent → ufw）；详见 `infra/xray/README.md`。
- 中心侧定时任务（本机 cron）：`probe-nodes.sh`（每 5 分钟探测节点）、`notify-scan-cf.sh`（每 15 分钟触发到期提醒/数据清理）、`update-clients.py`（每天跟进 GitHub release 刷新客户端镜像站 `dl.fastergamer.click`（R2 桶 fg-clients）：Clash Verge / CMFA / sing-box SFA，前端下载链接固定对象名、版本号写 version.json；另每日同步 sing-box CN 分流规则集 geosite-cn / geosite-gfw / geoip-cn 的 .srs 到 `rules/` 前缀——sing-box 订阅的 CN 分流引用这些固定地址，与 clash 同口径）、`ali-province-quality.mjs`（每晚 21:14 晚高峰阿里云 NAM 省份×运营商拨测，仅 HK/JP 节点：PING×3 轮测 RTT/P95/jitter/丢包 + TCP:443 建连；日常只跑移动（`--isp 移动`，约 ¥1.5/晚）并排除已知差的节点（`--exclude 日本06`），电信/联通复用最近一次全量数据，全量校准时去掉这两个参数跑（约 ¥5.3/次）；明细存 `scripts/.probe/province-quality-*.json`，点级趋势存 `province-quality-history.csv`；隧道内下载测速用 `node-quality.mjs` 手动跑）。

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
- 鉴权约定：管理接口 `x-admin-key`，节点 agent 接口 `x-node-key`；敏感接口在 `index.ts` 集中挂 `rateLimit`。管理接口另可选 `ADMIN_IPS` 来源 IP 白名单（CIDR，wrangler.cf.toml 的 vars；fail-closed，取不到 `cf-connecting-ip` 即拒绝），改网段需重新 deploy。
- KV 读写要省：中心是 CF 免费版 KV，设计上大量做事件驱动 + 缓存 + 幂等（如授权快照 5 分钟 TTL、状态翻转才写、邮件节流幂等键）。新增逻辑遵循同一思路，避免引入周期性 KV 写。
- agent 是无三方依赖的单文件 Python 3（只用标准库），保持这一约束，不要引入 pip 依赖。部署上由 `deploy-agent.sh` 安装为 systemd 服务、**以 root 运行**（需写 Xray 配置、执行 systemctl/iptables，单元无 `User=`）；节点上的 `wafer` 用户仅用于 SSH 运维登录（Xray 本体以 wafer 运行，agent 以 root 运行）。
- **git commit 规范**（`.kimi-code/skills/commit-style`，提交前必读）：中文标题一行概括根因/效果，不用 conventional commits 前缀与 emoji；正文 bullet 格式 `- 模块/文件：做了什么 + 为什么`；只写相对上次提交的新增/变更；提交前跑测试；推送目标 origin main 且须用户明确要求。

## 安全注意事项

- 防白嫖：试用/下单拒绝一次性临时邮箱（`lib/disposable-email.ts` 域名黑名单）；试用叠加每 IP 每天限领一次（`trialip:{ip}` TTL 24h）；`notify-scan` 顺带清理超 5 天未激活的体验 token。
- 机房 IP 滥用识别与限速（`lib/abuse.ts`，仅体验 token `plan_trial`（历史 id `plan_3days` 经 `isTrialPlan()` 兼容），付费 token 误伤成本高不参与）：结算后按 `presence.traffic_by_ip` 判定——机房/代理 IP 估算流量 >0.5GB 且占接入总流量 >50%（ip-api.com 批量分类 + `HOSTING_RE` 关键词兜底，与 `scripts/user-audit.mjs` 同口径；分类缓存 `ipinfo:{ip}` TTL 30 天，只对新 IP 查询）。处置是**限速不撤销**：打 `abuse_machine` 标记 + 邮件通知站长一次（幂等键 `notify_log.abuse_machine`），被标记 token 每日定额 500MB（`ABUSE_DAILY_BYTES`，24h 滚动窗口复用 rate_window 模式），窗口内超限写 `abuse_suspended_until` 暂停到窗口终点并推送授权刷新（`getAuthSnapshot` 生成侧排除暂停中的 uuid，快照 TTL 内自然恢复，反复暂停只记日志不发邮件）。IP 分类查询失败 fail-open：本次跳过判定，绝不因分类失败误标；误伤解除=管理端清除 token 的 `abuse_machine` 字段。另：付费 token 经流量暴增路径（1h >3GB）也会被打 `abuse_machine` 进入同一限速（机房 IP 判定仍只管体验 token；体验 token 暴增则直接吊销）。节点侧配套 ufw 出站封 25/465（SMTP），防垃圾邮件滥用把出口 IP 送进黑名单。
- `.dev.vars`、SSH 私钥等绝不提交、不读取外传；`.gitignore` 已覆盖。
- CORS 只允许同源与 fastergamer.cn；localhost 仅 `ENVIRONMENT=dev` 放行——改 CORS 逻辑时必须保持这条不变（有 `cors.test.ts` 回归测试）。
- token 校验在节点 Xray 层完成（uuid 不在 clients 列表直接拒绝），Worker 侧不接触用户流量。
- 节点加固：只对外开放 443，Xray 8443 绑回环，SSH 禁密码/root 登录 + fail2ban（见 `infra/xray/configs/firewall.md`）。
- WebSocket 隧道仅支持 TCP（不支持 UDP/QUIC）；可选 Reality 直连（8444 端口）与 Hysteria2 并存。
