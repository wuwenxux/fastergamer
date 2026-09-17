# CloudVPN —— Token 制 VPN（Cloudflare 托管）

无需注册，购买 token（VLESS UUID）后激活即用；有效期由购买时选择的套餐决定。
Clash 订阅包含多个 VPS 落地节点，客户端直连所选节点；每台 VPS 上的 Agent 从中心拉取有效 token，
按事件驱动结算流量（断联/超量才上报）。

## 架构

```
用户浏览器 → fastergamer.cn（纯静态门面站，API 跨域走 CF）
         └→ fastergamer.click（CF Worker + KV：售卖、token 状态机、节点注册表、流量结算）
用户 Clash → 直连所选 VPS 节点（VLESS + WS + TLS，Xray 校验用户 UUID，节点域名 *.fastergamer.click）
                 └→ 每台 VPS 跑 vpn-agent：拉取授权快照、事件驱动结算上报
节点在线探测 → 中心服务器 cron 每 5 分钟从国内探测各节点 /ping（scripts/probe-nodes.sh）
```

| 模块 | 目录 | 技术栈 |
|------|------|--------|
| API | `workers/api` | Hono + Cloudflare KV |
| 前端站点 | `pages` | React + Vite + Tailwind（CF Static Assets + cn 静态站双部署） |
| Xray 落地 | `infra/xray` | Xray + vpn-agent + Caddy/Nginx + 部署文档 |

## 本地开发

需要 Node.js ≥ 22 与 npm。

```bash
# 1. 安装依赖（根目录，含两个 workspace）
npm install

# 2. 启动 API Worker（占位 KV 即可，本地模拟）
npm run dev:api

# 3. 初始化套餐数据（另一个终端）
curl -s -X POST http://localhost:8787/api/admin/seed \
  -H "x-admin-key: change-me-in-production"

# 4. 启动前端
npm run dev:pages
# 打开 http://localhost:5173
```

### 端到端快速体验

支付通道已停用，付费套餐走人工收款码：下单后扫码转账（备注订单号）→ 点「我已支付」→ 客服确认后自动开通；可体验免费流程：

1. 打开 `http://localhost:5173`，在首页输入邮箱领取免费体验 token
2. 拿到 token，点击「立即激活」
3. 复制 Clash 订阅链接 → 用 Clash 客户端添加订阅
4. 连接「🚀 选择节点」→ 验证可用

## 生产部署（Cloudflare 托管）

整套系统（前端静态站 + API + KV 数据）跑在 Cloudflare 免费版：
`fastergamer.click`（CF Worker + Static Assets，前后端同源）是唯一的生产中心；
`fastergamer.cn` 已退役为纯跳转（本机 nginx 整站 301 到 `.click`，URI 保留，
`/api/sub` 老订阅链接由客户端跟随 301）。

- 配置：`workers/api/wrangler.cf.toml`（真实 CF KV 命名空间 + Static Assets 托管 `pages/dist`）
- 入口差异：`src/index.ts` 检测 `env.ASSETS` 绑定存在时把非 `/api` 请求转给静态资产（SPA 回退 `index.html`）
- 注意：`*.workers.dev` 在大陆被封锁，用户入口是自定义域名；管理 API（api.cloudflare.com）大陆可直连，部署/数据操作不受影响

```bash
# 推荐：一键脚本（经 hk02 跳板，避开本机到 CF 上传的不稳定；token 自动取 .dev.vars）
bash scripts/deploy-cf.sh           # 仅 API/配置改动
bash scripts/deploy-cf.sh --build   # 前端有改动，先构建 pages/dist

# 手动方式（直连 CF 可用时）：
# 1. 构建前端（CF 版：API 同源，无需 VITE_API_BASE）
cd pages && npm run build

# 2. 部署 worker + 静态资产（需 CLOUDFLARE_API_TOKEN 环境变量）
cd workers/api && npx wrangler deploy --config wrangler.cf.toml

# 密钥管理（ADMIN_KEY / ALIYUN_* / ADMIN_NOTIFY_EMAIL）
npx wrangler secret put <KEY> --config wrangler.cf.toml
```

注：`scripts/deploy-site-local.sh` 是 fastergamer.cn 企业门面站的现行发布脚本，把 `site-cn/` 发布到本机 /var/www/fastergamer.cn（根 package.json 的 `deploy:site`）。

### 初始化套餐

```bash
curl -s -X POST https://fastergamer.click/api/admin/seed \
  -H "x-admin-key: 你的ADMIN_KEY"
```

### 部署落地节点

按 `infra/xray/README.md` 在每个地区部署 Xray + Agent（一键：
`bash infra/xray/onboard-node.sh <IP> <ROOT密码> <地区代码> <节点名>`）。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/plans` | 套餐列表 |
| POST | `/api/orders` | 购买：落 pending 订单，支付页展示人工收款码（支付宝，备注订单号）；推广抵扣到 0 元的订单直接发 token |
| GET | `/api/orders/:id` | 查询订单支付状态（含应付金额/套餐） |
| POST | `/api/orders/:id/notify-paid` | 用户点「我已支付」：邮件通知站长确认收款（6h 幂等节流 + IP 限流） |
| POST | `/api/admin/orders/:id/paid` | 管理端确认收款 → fulfillOrder 自动发货（幂等，重复确认 409） |
| GET | `/api/tokens/:id` | 查询 token |
| POST | `/api/tokens/:id/activate` | 激活，开始计时 |
| POST | `/api/tokens/:id/reset-penalty` | 用户自助重置流量：用量清零恢复满额，有效期 -30 天（需本人登录） |
| POST | `/api/tokens/:id/upgrade` | 升级套餐补差价：按剩余天数折算差价；差价 >0 落 pending 订单走人工收款码确认，差价 ≤0 免费升级（uuid/设备不变，需本人登录） |
| POST/DELETE | `/api/tokens/:id/devices(/:deviceId)` | 设备槽位管理：每台设备独立 uuid 与订阅链接，流量按设备审计 |
| GET | `/api/sub?uuid=` | 订阅下发：默认 Clash YAML；`?format=vless`（base64 链接列表）/ `?format=singbox`（JSON），未指定时按 UA 自动识别（v2rayNG/Shadowrocket→vless，sing-box/SFA/SFI→singbox） |
| POST | `/api/admin/seed` | 初始化套餐（需 x-admin-key） |
| GET/POST/PUT/DELETE | `/api/admin/nodes` | 节点注册表管理（需 x-admin-key） |
| GET | `/api/agent/config` | 节点 Agent 拉取配置（需 x-node-key） |
| POST | `/api/agent/traffic` | 节点流量结算上报（需 x-node-key） |
| GET/DELETE | `/api/admin/tokens(/:id)` | token 列表 / 删除（需 x-admin-key） |
| POST | `/api/admin/tokens/:id/rotate-uuid` | 重置 UUID，断开该 token 全部设备（需 x-admin-key） |
| POST | `/api/admin/tokens/:id/reset-penalty` | 重置续用：用量清零恢复满额，有效期 -30 天（需 x-admin-key） |
| POST | `/api/admin/orders/:id/refund` | 订单退款：默认扣除当月已消耗费用、剩余整月折算原路退回（body.money 可覆盖金额），成功后撤销对应 token（需 x-admin-key；商户后台需开「订单退款API接口开关」） |
| POST | `/api/admin/notify-scan` | 扫描 24h 内到期 token 并邮件提醒（需 x-admin-key） |
| POST | `/api/feedback` | 用户提交问题反馈（限流 5 次/分钟），自动回执邮件 |
| GET | `/api/faq` | 公开常见问题（由沉淀的工单生成） |
| GET | `/api/admin/tickets` | 反馈工单列表，可按 ?status= 过滤（需 x-admin-key） |
| POST | `/api/admin/tickets/:id/reply` | 回复工单并邮件通知用户，publish_faq=true 沉淀到 FAQ |
| POST | `/api/admin/tickets/:id/close` | 不回复直接关闭工单 |

## 限制与注意

- 节点 Agent 事件驱动：授权变更（激活/撤销/设备/节点注册表/耗尽等）由中心主动 POST 节点 `/api/agent/refresh` 立即生效，节点只保留 30 分钟兜底轮询防丢；断联/超量才上报结算
- 设备槽位制：token 主 uuid 即主设备，用户可按套餐上限加绑设备（各持独立 uuid/订阅链接），流量按设备审计、计入 token 总量；解绑后该设备凭证立即失效
- 月度配额制（季付/连续包年/两年付/年付大流量）：每月 20GB（年付大流量 40GB），当月用超自动预支下月额度继续服务，每预支一个月有效期永久提前 30 天（已预支月数跨月锁定不归还），每档预支邮件通知客户；月付套餐为 30 天单月，不参与月配额
- 升级补差价：管理页可升级到更高价套餐，差价 = 目标价 - 当前套餐剩余价值（按剩余天数折算）；差价 >0 时落 pending 订单走人工收款码确认收款，差价 ≤0 时免费升级（uuid/订阅链接/设备不变），流量清零重计、有效期按新套餐重新开始
- 试用转正激励：锚定**邮箱**而非 token——只要邮箱领过试用（trial:{email} 标记永存），首次付费一律送 30 天（标记 converted_at 消费，不重复赠送）。token 存活期内可在管理页「充值转正」（同一 token，uuid/订阅/设备不变，试用期内剩余天数并入开通后第一个月；**剩余流量不结转**）；token 已被清理（未激活 3 天 / 过期 90 天）时用同邮箱直接新购也照样送 30 天；试用到期/流量耗尽时发一次转化邮件（幂等键 trial_convert，存量过期试用不补发），邮件只讲「送一个月 + 邮箱保留随时付费」，带免登录链接与找回页兜底
- 退款：管理员调 `/api/admin/orders/:id/refund`，默认折算（body.money 可人工覆盖金额，不超过实付，覆盖时不扣手续费）：月付按剩余天数退；季付/年付扣除当月、按剩余整月退，促销赠送月（plan.bonus_days）不参与折算，消耗进入赠送期则无可退余额；默认折算均扣 1% 退款手续费（客户承担，按订单实付总额计）；成功后撤销对应 token；依赖商户后台开启「订单退款API接口开关」
- 风险提醒：流量耗尽、同一 token 多设备在线时自动邮件提醒客户（每类幂等只发一次）；试用 token 耗尽时改发转化邮件；其余预警/催续费类邮件（traffic_80、到期提醒等）已全部下线
- 流量暴增分级处置：单 token 1 小时内新增 >3GB 触发处置（24h 幂等键 traffic_spike）——体验 token 自动吊销（status=revoked 并入结算写）并全节点踢除，误杀恢复=管理端把状态改回 active；付费 token 不吊销，改打 abuse_machine 标记转每日 500MB 限速（与机房滥用同一限速机制，误伤解除=清除 abuse_machine）。均只邮件通知站长一次（不通知客户——暴增多是滥用/泄露，惊动对方只会换号重来）；给客户续命用 reset-penalty（管理端售后与用户自助同一逻辑：用量清零恢复满额，有效期 -30 天，offset 记账不受 Xray 累计值影响）
- 机房滥用识别与限速：体验 token 的接入流量若主要来自机房/代理 IP（>0.5GB 且占比 >50%，与 scripts/user-audit.mjs 同口径）即判定为机器——不撤销，打 abuse_machine 标记并邮件通知站长一次（幂等键 abuse_machine），转每日 500MB 定额（24h 滚动窗口），超限暂停到窗口重置后自动恢复（授权快照生成侧摘除/放回）；IP 分类查询失败 fail-open 不误标，误伤由管理端清除 abuse_machine 解除；付费 token 不参与
- 节点月配额：节点可配 `monthly_budget_gb`（PUT /api/admin/nodes/:id），按自然月记账；80% 告警，100% 自动从订阅与同步摘除，跨月自动恢复
- 节点失联告警：`scripts/probe-nodes.sh`（cron 每 5 分钟）从国内探测各节点 /ping，连续 2 次失败邮件告警，恢复后自动通知
- 数据生命周期：expired/revoked 满 90 天的 token 由 notify-scan 自动清除（含 id 索引与全部设备索引，试用 token 同样适用）；closed 满 90 天的工单同样清理（已沉淀 FAQ 的保留）；付费 token 过期后不可重新激活，需购买新套餐；试用 token 可失效被清理，但试用标记 trial:{email} 永存——邮箱永是续用凭证，首次付费仍享转正赠送（见上条）
- 反馈渠道：用户在「帮助反馈」页提交问题（邮箱必填）→ 管理员通过 `/api/admin/tickets` 查看、`reply` 接口回复（自动发邮件）→ 有价值的问答标 `publish_faq` 沉淀到 FAQ 给新用户自助查阅
- WebSocket 隧道仅支持 TCP，不支持 UDP/QUIC（游戏 UDP 类应用不可用）
- 支付通道（易支付 pay.neil.asia）已彻底断开：下单/回调代码删除，交易状态机保留。当前过渡方案为人工收款码：POST /api/orders 与升级补差价落 pending 订单，支付页展示站长收款码（pages/public/pay/），用户点「我已支付」（/notify-paid，6h 节流）邮件通知站长，站长确认收款（/api/admin/orders/:id/paid → fulfillOrder）自动发货；EPAY_* 密钥已从生产删除，退款接口随之失效（lib/epay.ts 代码保留，重新配置密钥可恢复）
- 请确保服务的运营符合你所在地区的法律法规
