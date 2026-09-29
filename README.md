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

套餐唯一数据源是 `workers/api/src/routes/admin/plans.ts` 的 `DEFAULT_PLANS`（空 body 触发写入内置默认列表）；改动须先 deploy 再 seed。

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
- 订阅设备锁：**仅单设备套餐**（流量包/试用，有效 max_devices=1）生效——每条订阅链接（主 uuid / 设备槽位 uuid 各自独立）绑定首个拉取它的客户端家族指纹（忽略版本号，升级不掉绑定）；其他家族或（已有绑定时）浏览器/未知 UA 再拉取一律 403 拒绝并邮件通知机主（节流 24h）。多设备套餐（个人付费/企业）一律放行任何家族（同一人多台设备属正常用法），指纹仍照常记录供管理页「订阅客户端」展示，无 403 无邮件。换手机：管理页「订阅客户端」卡片自助解绑（7 天冷却），解绑后重新导入即重新认领；绑定条目 30 天未拉取自动过期（自愈）；误伤/急用由管理端 PUT /api/admin/tokens/:id 传 clear_sub_bindings 清除
- 并发共享检测（哲学：不介意同一用户多设备，只介意多人分享）：节点上报各 uuid 实时并发数，按 token 聚合后分轨判定——单设备套餐（试用/流量包）上限 max_devices+2=3 并发；企业套餐上限 max_devices+2；个人多设备套餐（3/5 台）走阶梯：并发 >3 且 ≤5 只记观测（token.conn_observe，1h 节流，不通知不处置），>5 才按分享处置——连续 2 个周期超标先发警告邮件引导重置订阅，7 天内再犯置 share_suspended_at 暂停（授权快照剔除、连接随节点刷新切断），续费任意套餐自动解锁；误伤由管理端 PUT /api/admin/tokens/:id 传 clear_share_suspension 解除
- 不可能旅行检测：结算路径比对相邻两周期接入来源的地理跳变——跨城市且速度 >1000 km/h（有经纬度走 haversine；缺经纬度按时间差 <2h 兜底）判定为多人持有确证，累积 token.travel_strikes（30 分钟未再犯重计）并节流邮件提醒（7 天）引导重置订阅；只提醒不处置。存量裸字符串 active_geo 基线无时间戳，遇旧值只更新基线不判定
- 设备级防护（lib/device-guard.ts，覆盖全部个人 token——试用/流量包/付费个人；仅企业套餐 plan_biz_* 不参与，团队共享是设计用途）：同一凭证（主 uuid 或某设备槽位 uuid）在单节点内出现 ≥2 个来源 IP 并发，且持续 2 个结算周期确认后（吸收 WiFi↔5G 切换的瞬时双 IP），自动阻断「新出现的 IP」（老 IP 不动、老设备不断线）并邮件通知机主（12h 节流，行动后 12h 内多地并发 ip_change 提醒被抑制，同一事件不重复发两封；单设备套餐邮件为「仅支持 1 台设备」口径，不承诺建槽）。阻断复用 blocked_ips 链路（全局生效，同 NAT 出口有误伤面，邮件里已告知），台账 token.device_guard 区分自动/手动阻断并提供救济：管理页「待授权接入」区块点「允许」按有效设备数分两条路径——多设备套餐有余量 = **迁移流程**（共用链接只能是过渡，长期必须一台设备一条凭证）：自动为新设备创建独立槽位（名字默认「新设备 · {城市}」），响应带新槽位引导导入专属订阅链接；单设备套餐（max_devices=1）或槽位已满 = **临时解封**：不建槽（409 是死路，合法换机用户将无自助救济），只解封该 IP 并记入涉事凭证 transition_ips（7 天），到期仍并发活跃会被重新拦截。两条路径的 transition_ips 规则一致（未到期视同白名单；到期核查：仍活跃则移出名单重新走 pending→确认→阻断，已不活跃则静默移除）；点「保持拒绝」= 阻断保持 + 台账置 denied 停止提醒；顺序换 IP（旧下线新上线）不触发任何判定
- 月度配额制（季付/连续包年/年付套餐/两年付/年付大流量）：每月 20GB（年付大流量 40GB），当月用超自动预支下月额度继续服务，每预支一个月有效期永久提前 30 天（已预支月数跨月锁定不归还），每档预支邮件通知客户；月付套餐为 30 天单月，不参与月配额；流量包系列（plan_pack_*：1 GB/¥3、5 GB/¥8，均 90 天用完即止）为纯总量包，无 monthly_quota_gb，不参与月配额
- 升级补差价：管理页可升级到更高价套餐，差价 = 目标价 - 当前套餐剩余价值（按剩余天数折算）；差价 >0 时落 pending 订单走人工收款码确认收款，差价 ≤0 时免费升级（uuid/订阅链接/设备不变），流量清零重计、有效期按新套餐重新开始；流量包系列价格最低（¥3 起），只能新购/试用转正，不会出现在任何付费 token 的升级目标里
- 连续包月（plan_monthly_sub，¥10，与 ¥12 月付同规格）：连续续费专享价。资格按订单 contact 判定——首购直接放行；续购要求上次连续包月订单支付成功时间在 37 天内（30 天周期 + 7 天断缴宽限），断缴超宽限即失去资格，下单被拒绝并引导回 ¥12 月付（资格记录 submon:{contact} 只由本套餐支付成功发货时刷新，以支付时间计、不依赖激活时间；新购发货与升级/试用转正发货两条路径都写）；试用转正可直接选它（首购放行）；¥10 < ¥12 天然不会成为升级目标，退款按 30 天套餐自然落入按天折算
- 连续包年（plan_yearly，¥110，与 ¥120 年付同规格）：连续性规则同连续包月但窗口为 395 天（365 天周期 + 30 天断缴宽限，年付宽限更长），资格记录 subyear:{contact}，断缴拒绝文案引导回 ¥120 年付；升级/试用转正选它为目标时同样校验。规则上线前的存量 plan_yearly 用户无记录，首次续费按首购放行（有意的平滑迁移）。首购送 1 个月（bonus_days 机制，每邮箱限一次）与连续性资格相互独立
- 年付套餐（plan_yearly_std，¥120）：随时可买无资格门槛；连续续费奖励——上次 ¥120 支付成功在 395 天内则本次发货 +30 天（记录 yrstd:{contact}，判定先于刷新），新购记 token.bonus_ms 激活时并入、升级直接加 expires_at/base_expires_at。三个 marker（submon/subyear/yrstd）互不串写。退款按 plan.duration_days=365 折算，续费奖励的 30 天不参与（多退不补，口径差异可接受）
- 试用转正激励：锚定**邮箱**而非 token——只要邮箱领过试用（trial:{email} 标记永存），首次付费一律送 30 天（标记 converted_at 消费，不重复赠送）。token 存活期内可在管理页「充值转正」（同一 token，uuid/订阅/设备不变，试用期内剩余天数并入开通后第一个月；**剩余流量不结转**）；token 已被清理（未激活 3 天 / 过期 90 天）时用同邮箱直接新购也照样送 30 天；试用到期/流量耗尽时发一次转化邮件（幂等键 trial_convert，存量过期试用不补发），邮件只讲「送一个月 + 邮箱保留随时付费」，带免登录链接与找回页兜底
- 退款：管理员调 `/api/admin/orders/:id/refund`，默认折算（body.money 可人工覆盖金额，不超过实付，覆盖时不扣手续费）：月付按剩余天数退；季付/年付扣除当月、按剩余整月退，促销赠送月（plan.bonus_days）不参与折算，消耗进入赠送期则无可退余额；默认折算均扣 1% 退款手续费（客户承担，按订单实付总额计）；流量包（plan_pack_*）售出不退，退款接口直接拒绝；成功后撤销对应 token；依赖商户后台开启「订单退款API接口开关」
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
