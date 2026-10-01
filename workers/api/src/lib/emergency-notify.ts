/**
 * 灾备群发：主站域名被 DNS 污染时，向全部活跃用户邮件下发备用订阅地址。
 *
 * 背景：备用订阅域 uluw.kdns.fr 默认不展示（站长决策：不宣传、减小暴露面），
 * 只在灾备事件发生时由站长手动触发本广播（scripts/fg emergency-sub →
 * POST /api/admin/emergency/backup-sub）。
 *
 * 与 node-change-notify 的差异：
 * - 收件人更宽：active 未过期、有邮箱即可，**试用用户也发**（灾备时试用用户是潜在付费用户）；
 * - 邮件含该用户自己的备用订阅链接（uuid 即连接凭证，但只发去本人邮箱，与发货邮件同口径）；
 * - 幂等键按天：`emergency_sub:{yyyymmdd}:{tokenId}`（UTC），由 ShareGuardDO 认领存储
 *   在发送前同步裁决（claimNotification），同一天重复触发不重发，
 *   跨天可再发（灾备可能持续多日，防止误触轰炸的同时保留次日补发能力）。
 */
import { KV, type Token } from "../../../../shared/types";
import { listKeys, mapBatched } from "./kv";
import { sendMail, shouldSendEmail } from "./email-aliyun";
import { claimNotification } from "./notify-dedup";
import { shell } from "./risk-notify";
import type { Env } from "../types";

/** 备用订阅域：同 CF 账号独立 zone，整站 + /api/* 可用；灾备时唯一对外入口 */
export const BACKUP_SUB_BASE = "https://uluw.kdns.fr";

/** 幂等键的日期段：UTC yyyyMMdd（与月度账期同用 UTC，避免时区歧义） */
const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10).replace(/-/g, "");

const buildCopy = (backupUrl: string) => ({
  title: "紧急通知：订阅地址已更换",
  html: `<p>你好，主站域名当前在你所在网络<strong>暂时无法访问</strong>（DNS 污染），我们正在处理。</p>
     <p><strong>你的服务本身不受影响</strong>，已连接的节点照常可用；但订阅可能无法自动更新，请把客户端里的订阅地址换成下面这条备用地址：</p>
     <p style="margin:12px 0;">备用订阅地址（复制它）：</p>
     <code style="display:block;padding:10px;background:#0f172a;color:#e2e8f0;border-radius:6px;word-break:break-all;">${backupUrl}</code>
     <p style="margin:12px 0 0;"><strong>操作步骤：</strong></p>
     <ol style="margin:8px 0 0;padding-left:20px;color:#334155;">
       <li>打开 Clash / sing-box 客户端，进入「订阅 / 配置」页面；</li>
       <li>把现有订阅的地址改成上面的备用地址（或新增一个订阅，粘贴它），保存后点「更新订阅」；</li>
       <li>节点列表刷新后即可正常使用；列表中带「·直连」后缀的条目不依赖域名解析，优先选它。</li>
     </ol>
     <p style="margin:12px 0 0;color:#64748b;font-size:13px;">原订阅链接在主站恢复后仍可继续使用，两条地址的内容完全一致，可随时切换。</p>`,
  text: `主站域名当前在你所在网络暂时无法访问（DNS 污染），我们正在处理。

你的服务本身不受影响，已连接的节点照常可用；但订阅可能无法自动更新，请把客户端里的订阅地址换成这条备用地址：

备用订阅地址：${backupUrl}

操作步骤：
1. 打开 Clash / sing-box 客户端，进入「订阅 / 配置」页面；
2. 把现有订阅的地址改成上面的备用地址（或新增一个订阅，粘贴它），保存后点「更新订阅」；
3. 节点列表刷新后即可正常使用；列表中带「·直连」后缀的条目不依赖域名解析，优先选它。

原订阅链接在主站恢复后仍可继续使用，两条地址的内容完全一致，可随时切换。`,
});

/**
 * 同步跑完整场广播并返回计数（管理端点要回 {sent, skipped}，故不走 waitUntil）。
 * 发送逐用户串行（与 node-change 同口径，避免打满邮件通道并发）；失败只记日志计入 skipped。
 */
export const broadcastBackupSub = async (env: Env): Promise<{ sent: number; skipped: number }> => {
  const now = Date.now();
  const dedupPrefix = `emergency_sub:${dayKey(now)}`;
  const keys = await listKeys(env.TOKENS, KV.TOKEN);
  // 全表枚举一次批量并发读回（与 node-change-notify / notify-scan 同模式）；灾备低频，代价可接受
  const raws = await mapBatched(keys, (k) => env.TOKENS.get(k.name));
  let sent = 0;
  let skipped = 0;
  for (const raw of raws) {
    if (!raw) continue;
    const token = JSON.parse(raw) as Token;
    // 只发 active 未过期且有有效邮箱的；未激活/过期/吊销/无邮箱跳过（试用也发，见文件头注释）
    if (token.status !== "active") { skipped++; continue; }
    if (token.expires_at && token.expires_at <= now) { skipped++; continue; }
    if (!shouldSendEmail(token.contact)) { skipped++; continue; }
    // 发送前同步认领（本函数要精确回 sent/skipped，不能等消费者异步裁决）；
    // 已认领即当天已发过/正在发，计入 skipped
    if (!(await claimNotification(env, `${dedupPrefix}:${token.id}`))) { skipped++; continue; }
    const copy = buildCopy(`${BACKUP_SUB_BASE}/api/sub?uuid=${encodeURIComponent(token.uuid)}`);
    const { subject, html, text } = shell(env, copy.title, copy.html, copy.text);
    const res = await sendMail(env, token.contact!, subject, html, text, { kind: "service" });
    if (res.ok) {
      sent++;
    } else {
      console.error(`[emergency] backup-sub mail failed ${token.id}: ${res.error}`);
      skipped++;
    }
  }
  console.log(`[emergency] backup-sub sent=${sent} skipped=${skipped}`);
  return { sent, skipped };
};
