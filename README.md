# CloudVPN —— Token 制 VPN（自建，无 Cloudflare 依赖）

无需注册，购买 token（VLESS UUID）后激活即用；有效期由购买时选择的套餐决定。
Clash 订阅包含多个 VPS 落地节点，客户端直连所选节点；每台 VPS 上的 Agent 定时从中心 API 同步有效 token 并上报流量。

## 架构

```
用户浏览器 → 中心 VPS 静态站（nginx，定价/购买/激活/订阅管理）
用户 Clash → 直连所选 VPS 节点（VLESS + WS + TLS，Xray 校验用户 UUID）
                 └→ 每台 VPS 跑 vpn-agent：拉取 active token 列表、上报流量/心跳
中心 API（Hono，以 workerd 跑在中心 VPS）：售卖、token 状态机、节点注册表、流量聚合
```

| 模块 | 目录 | 技术栈 |
|------|------|--------|
| API | `workers/api` | Hono + KV（生产用 workerd 磁盘 KV） |
| 前端站点 | `pages` | React + Vite + Tailwind |
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

### 端到端快速体验（演示支付）

1. 打开 `http://localhost:5173`，选一个套餐 → 去支付 → 确认支付
2. 购买成功页拿到 token，点击「立即激活」
3. 复制 Clash 订阅链接 → 用 Clash 客户端添加订阅
4. 连接「🚀 选择节点」→ 验证可用

## 生产部署（自建 VPS，workerd 模式）

生产不依赖 Cloudflare：API 以 workerd 直接跑在中心 VPS（阿里云）上，
nginx 把 `/api/` 反代到 `127.0.0.1:8787`，静态站同机托管。

### 1. 配置环境变量

编辑 `workers/api/wrangler.toml` 的 `[vars]`：

- `ADMIN_KEY`（强随机）
- `FALLBACK_NODE_HOST` 等：nodes 注册表为空时订阅回退用的兜底节点

敏感值（如阿里云邮件密钥）放 `workers/api/.dev.vars`，生成配置时会合并进来。

### 2. 部署/更新 API

```bash
bash scripts/deploy-api-local.sh   # 打包 → 生成 config.capnp → 重启 fastergamer-api
```

生产目录 `/home/wafer/fastergamer/`：`index.js`（打包产物）+ `config.capnp` + `kv/`（磁盘 KV 数据）。
systemd 单元模板见 `infra/vps/cloudvpn-api.service`（线上名 `fastergamer-api.service`）。

### 3. 初始化套餐

```bash
curl -s -X POST https://fastergamer.cn/api/admin/seed \
  -H "x-admin-key: 你的ADMIN_KEY"
```

### 4. 部署落地节点

按 `infra/xray/README.md` 在每个地区部署 Xray + Agent，并通过
`POST /api/admin/nodes` 把节点注册进中心（订阅会自动包含 active 节点）。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/plans` | 套餐列表 |
| POST | `/api/orders` | 购买（演示支付）→ 返回 token |
| GET | `/api/tokens/:id` | 查询 token |
| POST | `/api/tokens/:id/activate` | 激活，开始计时 |
| POST/DELETE | `/api/tokens/:id/devices(/:deviceId)` | 设备槽位管理：每台设备独立 uuid 与订阅链接，流量按设备审计 |
| GET | `/api/sub?uuid=` | Clash 订阅 yaml |
| POST | `/api/admin/seed` | 初始化套餐（需 x-admin-key） |
| GET/POST/PUT/DELETE | `/api/admin/nodes` | 节点注册表管理（需 x-admin-key） |
| GET | `/api/agent/config` | 节点 Agent 拉取配置（需 x-node-key） |
| POST | `/api/agent/heartbeat` | 节点心跳（需 x-node-key） |
| POST | `/api/agent/traffic` | 节点流量上报（需 x-node-key） |
| GET/DELETE | `/api/admin/tokens(/:id)` | token 列表 / 删除（需 x-admin-key） |
| POST | `/api/admin/tokens/:id/rotate-uuid` | 重置 UUID，断开该 token 全部设备（需 x-admin-key） |
| POST | `/api/admin/tokens/:id/reset-penalty` | 重置续用：用量清零恢复满额，有效期 -30 天（需 x-admin-key） |
| POST | `/api/admin/notify-scan` | 扫描 24h 内到期 token 并邮件提醒（需 x-admin-key） |
| POST | `/api/feedback` | 用户提交问题反馈（限流 5 次/分钟），自动回执邮件 |
| GET | `/api/faq` | 公开常见问题（由沉淀的工单生成） |
| GET | `/api/admin/tickets` | 反馈工单列表，可按 ?status= 过滤（需 x-admin-key） |
| POST | `/api/admin/tickets/:id/reply` | 回复工单并邮件通知用户，publish_faq=true 沉淀到 FAQ |
| POST | `/api/admin/tickets/:id/close` | 不回复直接关闭工单 |

## 限制与注意

- 节点 Agent 每 30s 同步一次，token 变更（激活/过期/流量耗尽/rotate-uuid/设备解绑）最长 ~30s 落到 Xray
- 设备槽位制：token 主 uuid 即主设备，用户可按套餐上限加绑设备（各持独立 uuid/订阅链接），流量按设备审计、计入 token 总量；解绑后该设备凭证立即失效
- 月度配额制（年付）：每月 20GB，当月用超自动预支下月额度继续服务，每预支一个月有效期永久提前 30 天（已预支月数跨月锁定不归还），每档预支邮件通知客户
- 风险提醒：流量用到 80%/耗尽、同一 token 多设备在线时自动邮件提醒客户（每类幂等只发一次）；24h 内到期提醒由 cron 定期调 `/api/admin/notify-scan` 触发
- 流量暴增告警：单 token 1 小时内新增 >10GB 时邮件告警客户与管理员（24h 幂等），止血用 rotate-uuid 或撤销；给客户续命用 reset-penalty（用量清零恢复满额，有效期 -30 天，offset 记账不受 Xray 累计值影响）
- 节点月配额：节点可配 `monthly_budget_gb`（PUT /api/admin/nodes/:id），按自然月记账；80% 告警，100% 自动从订阅与同步摘除，跨月自动恢复
- 节点失联告警：notify-scan 每 15 分钟检查（cron），agent 心跳或统计超 5 分钟未更新时告警管理员，恢复后自动清零标记
- 数据备份：`scripts/backup-kv.sh` 每日打包 KV 目录到 `/home/wafer/fastergamer/backups/`，保留 7 天（cron 每天 3:41）
- 数据生命周期：expired/revoked 满 90 天的 token 由 notify-scan 自动清除（含 id 索引与全部设备索引）；closed 满 90 天的工单同样清理（已沉淀 FAQ 的保留）；token 过期后不可重新激活，需购买新套餐
- 反馈渠道：用户在「帮助反馈」页提交问题（邮箱必填）→ 管理员通过 `/api/admin/tickets` 查看、`reply` 接口回复（自动发邮件）→ 有价值的问答标 `publish_faq` 沉淀到 FAQ 给新用户自助查阅
- WebSocket 隧道仅支持 TCP，不支持 UDP/QUIC（游戏 UDP 类应用不可用）
- 演示支付不产生真实扣款；接入真实网关时参考 `workers/api/src/routes/orders.ts` 中的注释
- 请确保服务的运营符合你所在地区的法律法规
