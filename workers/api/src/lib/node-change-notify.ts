/**
 * 节点变更用户通知
 *
 * 背景：订阅响应头 profile-update-interval 已拉长到 720h（30 天），客户端基本不再
 * 自动轮询——这是站长决策：订阅基本不自动更新，节点注册表发生用户可感知的变化时
 * 由这里发邮件通知活跃用户，用户在客户端手动点「更新订阅」获取新配置。
 *
 * 三类事件（均在 nodes.ts 的管理端点里触发，ctx.waitUntil 异步发，不阻塞响应）：
 * - added：新节点上线（价值：更多地区/更低延迟的选择）
 * - removed：节点下线或 active 翻转 true→false（在用用户需更新订阅切换节点）
 * - host_changed：节点地址变更（不更新该节点必连不上）
 *
 * 收件人：active 且未过期的付费 token（试用/未激活/过期/吊销/无邮箱一律不发）。
 * 订阅制（opt-in）：未订阅用户最多收第一封样例（带订阅链接，写过 notify_nodes_sampled_at
 * 即不再发样例）；订阅用户持续收且每封带退订链接（routes/notify-pref.ts，HMAC 签名链接，
 * GET 确认页 + POST 生效防预取器误订阅）。交易/风控类邮件不受此机制影响。
 * 幂等：token.notify_log 键 `node_change.<eventId>`，同事件同用户只发一次；
 * 写回走 mergeTokenSettlement 键级合并，不覆盖结算路径的并发字段。
 * 安全：邮件不含订阅链接与其他用户任何信息，只写客户端操作步骤。
 */

import { isTrialPlan, KV, type Node, type Token } from "../../../../shared/types";
import { listKeys, mapBatched, mergeTokenSettlement } from "./kv";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { notifyPrefUrl } from "./notify-pref";
import { shell } from "./risk-notify";
import { escapeHtml } from "./escape-html";
import type { Env } from "../types";

type NodeChangeKind = "added" | "removed" | "host_changed";

/** region 代码 → 中文名（CLASH_REGIONS 是 vars 里的 JSON；解析失败回退原代码） */
const regionName = (env: Env, code: string): string => {
  try {
    const regions = JSON.parse(env.CLASH_REGIONS ?? "[]") as { code: string; name: string }[];
    return regions.find((r) => r.code === code)?.name ?? code;
  } catch {
    return code;
  }
};

/** 手动更新订阅的操作指引（三类事件文案共用；只写步骤，不贴订阅链接——邮件信道不安全） */
const UPDATE_GUIDE_HTML = `<p style="margin:12px 0 0;"><strong>如何更新：</strong>打开你的 Clash / sing-box 客户端 → 进入订阅（配置）页面 → 点「更新订阅」，节点列表即为最新。</p>`;
const UPDATE_GUIDE_TEXT = `如何更新：打开你的 Clash / sing-box 客户端 → 进入订阅（配置）页面 → 点「更新订阅」，节点列表即为最新。`;

/** 三类事件的邮件文案（标题 + 价值点 + 指引） */
const buildCopy = (env: Env, kind: NodeChangeKind, node: Node) => {
  const name = escapeHtml(node.name);
  const region = escapeHtml(regionName(env, node.region));
  switch (kind) {
    case "added":
      return {
        title: `新节点上线：${node.name}`,
        html: `<p>你好，我们新增了 <strong>${region}</strong> 地区的节点「<strong>${name}</strong>」。</p>
     <p>更新订阅后即可在客户端节点列表中选择它——多一个地区选择，也可能带来更低的延迟。</p>
     <p style="color:#64748b;font-size:13px;">不更新也不影响你现有节点的使用。</p>
     ${UPDATE_GUIDE_HTML}`,
        text: `我们新增了 ${regionName(env, node.region)} 地区的节点「${node.name}」。更新订阅后即可在客户端节点列表中选择它——多一个地区选择，也可能带来更低的延迟。不更新也不影响你现有节点的使用。\n\n${UPDATE_GUIDE_TEXT}`,
      };
    case "removed":
      return {
        title: `节点下线通知：${node.name}`,
        html: `<p>你好，节点「<strong>${name}</strong>」（${region}）已下线。</p>
     <p><strong>如果你正在使用该节点</strong>，请尽快更新订阅：更新后客户端会切换到其他可用节点，避免连接失败。</p>
     <p style="color:#64748b;font-size:13px;">不在用该节点的话也建议顺手更新，保持节点列表为最新。</p>
     ${UPDATE_GUIDE_HTML}`,
        text: `节点「${node.name}」（${regionName(env, node.region)}）已下线。如果你正在使用该节点，请尽快更新订阅：更新后客户端会切换到其他可用节点，避免连接失败。不在用该节点的话也建议顺手更新，保持节点列表为最新。\n\n${UPDATE_GUIDE_TEXT}`,
      };
    case "host_changed":
      return {
        title: `节点地址变更：${node.name}`,
        html: `<p>你好，节点「<strong>${name}</strong>」（${region}）的接入地址已变更。</p>
     <p><strong>不更新订阅的话，该节点将无法连接</strong>；更新订阅即可恢复。其他节点不受影响。</p>
     ${UPDATE_GUIDE_HTML}`,
        text: `节点「${node.name}」（${regionName(env, node.region)}）的接入地址已变更。不更新订阅的话，该节点将无法连接；更新订阅即可恢复。其他节点不受影响。\n\n${UPDATE_GUIDE_TEXT}`,
      };
  }
};

/** 只需 waitUntil 的最小 ctx 形状：Hono 的 ExecutionContext<unknown> 与测试桩都结构兼容 */
type Ctx = { waitUntil: (p: Promise<unknown>) => void };

/**
 * 向全部活跃付费用户广播一次节点变更（waitUntil 异步，绝不阻塞管理端点响应）。
 * eventId 决定幂等键：added/removed 按节点生命周期一次性（同 id 重发不重复打扰），
 * host_changed 带时间戳（每次地址变更都是新事件）。
 *
 * 订阅制（opt-in，站长决策：默认不持续打扰）：
 * - notify_nodes_subscribed===true → 每封都发，邮件带退订链接；
 * - 未订阅且 notify_nodes_sampled_at 不存在 → 发第一封样例（带订阅链接）并写回 sampled_at；
 * - 未订阅且已发过样例 → 永远跳过。
 * 幂等双保险：notify_log 事件键防同事件重试重复发；sampled_at 防跨事件重复发样例。
 */
const broadcast = (env: Env, ctx: Ctx, kind: NodeChangeKind, node: Node, eventId: string): void => {
  ctx.waitUntil(
    (async () => {
      const now = Date.now();
      const keys = await listKeys(env.TOKENS, KV.TOKEN);
      // 全表枚举一次批量并发读回（与 notify-scan 同模式）；节点变更低频，代价可接受
      const raws = await mapBatched(keys, (k) => env.TOKENS.get(k.name));
      let sent = 0;
      for (const raw of raws) {
        if (!raw) continue;
        const token = JSON.parse(raw) as Token;
        // 只通知活跃付费用户：未激活/过期/吊销/试用/无邮箱都不发
        if (token.status !== "active") continue;
        if (token.expires_at && token.expires_at <= now) continue;
        if (isTrialPlan(token.plan_id)) continue;
        if (!shouldSendEmail(token.contact)) continue;
        const subscribed = token.notify_nodes_subscribed === true;
        if (!subscribed && token.notify_nodes_sampled_at) continue; // 样例已发过且未订阅
        const logKey = `node_change.${eventId}`;
        if (token.notify_log?.[logKey]) continue;
        const copy = buildCopy(env, kind, node);
        // 页脚按订阅状态分：样例带「订阅」入口，订阅用户带「退订」入口（链接 HMAC 签名防伪造）
        const prefAction = subscribed ? "unsub" : "sub";
        const prefUrl = await notifyPrefUrl(env, token.id, prefAction);
        const footerHtml = subscribed
          ? `<p style="margin-top:16px;font-size:13px;color:#94a3b8;">你已订阅节点更新通知。不想再收到？<a href="${prefUrl}" style="color:#0ea5e9;">点击退订</a></p>`
          : `<p style="margin-top:16px;font-size:13px;color:#64748b;">想持续收到节点更新通知？<a href="${prefUrl}" style="color:#0ea5e9;">点击订阅</a>（不订阅不会再打扰）。</p>`;
        const footerText = subscribed
          ? `你已订阅节点更新通知。退订：${prefUrl}`
          : `想持续收到节点更新通知？订阅：${prefUrl}（不订阅不会再打扰）`;
        const { subject, html, text } = shell(
          env,
          copy.title,
          copy.html + footerHtml,
          `${copy.text}\n\n${footerText}`
        );
        const res = await sendMail(env, token.contact, subject, html, text, { kind: "service" });
        if (res.ok) {
          // 键级合并写回幂等键 + 样例标记，不碰结算路径并发更新的其他字段
          await mergeTokenSettlement(env, token.uuid, {
            notify_log: { [logKey]: Date.now() },
            ...(subscribed ? {} : { notify_nodes_sampled_at: now }),
          });
          sent++;
        } else {
          console.error(`[node-change] notify failed ${token.id} event=${eventId}: ${res.error}`);
        }
      }
      console.log(`[node-change] event=${eventId} notified=${sent}`);
    })().catch((e) => console.error(`[node-change] event=${eventId} failed: ${(e as Error).message}`))
  );
};

/** 新节点上线（POST /api/admin/nodes） */
export const notifyNodeAdded = (env: Env, node: Node, ctx: Ctx): void =>
  broadcast(env, ctx, "added", node, `added:${node.id}`);

/** 节点下线（DELETE /api/admin/nodes/:id，或 active true→false） */
export const notifyNodeRemoved = (env: Env, node: Node, ctx: Ctx): void =>
  broadcast(env, ctx, "removed", node, `removed:${node.id}`);

/**
 * 节点修改（PUT /api/admin/nodes/:id）：只有用户可感知的变更才通知——
 * host 变化（不更新必连不上）与 active 翻转（上线按新增、下线按退役）；
 * name/reality/hy2 等其他字段变更不发信（更新了也没感知价值，纯打扰）。
 */
export const notifyNodeChanged = (env: Env, before: Node, after: Node, ctx: Ctx): void => {
  if (before.active !== after.active) {
    if (after.active) notifyNodeAdded(env, after, ctx);
    else notifyNodeRemoved(env, after, ctx);
  }
  if (before.host !== after.host) {
    broadcast(env, ctx, "host_changed", after, `host:${after.id}:${Date.now()}`);
  }
};
