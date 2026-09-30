/**
 * 节点变更通知订阅/退订（邮件链接落地页，匿名）
 *
 * GET  /api/notify-pref?tid&action=sub|unsub&sig —— 只渲染确认页（一个按钮的表单），
 *   不改任何状态：邮件客户端/安全网关会预取链接，GET 生效会被预取器全员误订阅。
 * POST 同参数 —— 确认页表单提交，真正写入 token.notify_nodes_subscribed。
 *
 * 只影响节点变更通知（lib/node-change-notify.ts 的订阅制）；
 * 交易/风控类邮件（发货、到期提醒、abuse 等）不受此机制影响，照常强制发送。
 */
import { Hono } from "hono";
import { getTokenById, mergeTokenSettlement } from "../lib/kv";
import { verifyNotifyPrefSig, type NotifyPrefAction } from "../lib/notify-pref";
import { escapeHtml } from "../lib/escape-html";
import type { Env } from "../types";

export const notifyPrefRoutes = new Hono<{ Bindings: Env }>();

/** 极简落地页（无外部资源：邮件客户端里点开也要秒开） */
const page = (title: string, bodyHtml: string): string =>
  `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;display:flex;justify-content:center;padding:40px 16px;">
  <div style="background:#fff;border-radius:12px;padding:32px;max-width:420px;width:100%;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.1);">
    <h1 style="font-size:20px;margin:0 0 16px;">🐸 FrogLeap</h1>
    ${bodyHtml}
  </div>
</body>
</html>`;

/** 解析并校验三参数；不合法返回 null */
const parseParams = async (env: Env, url: URL) => {
  const tid = url.searchParams.get("tid") ?? "";
  const action = url.searchParams.get("action") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!tid || (action !== "sub" && action !== "unsub") || !sig) return null;
  if (!(await verifyNotifyPrefSig(env, tid, action as NotifyPrefAction, sig))) return null;
  return { tid, action: action as NotifyPrefAction, sig };
};

notifyPrefRoutes.get("/", async (c) => {
  const p = await parseParams(c.env, new URL(c.req.url));
  if (!p) {
    return c.html(page("链接无效", `<p style="color:#64748b;">链接无效或已失效，请从最新的邮件里重新打开。</p>`), 403);
  }
  const label = p.action === "sub" ? "确认订阅节点更新通知" : "确认退订节点更新通知";
  const desc =
    p.action === "sub"
      ? "订阅后，节点新增/下线/地址变更时你会收到邮件提醒（可随时退订）。"
      : "退订后不再收到节点更新邮件；到期提醒、发货等交易邮件不受影响。";
  // 确认页：按钮 POST 同 URL 才真正生效（GET 预取无副作用）
  return c.html(
    page(
      label,
      `<p style="color:#334155;">${desc}</p>
       <form method="POST" action="/api/notify-pref?tid=${encodeURIComponent(p.tid)}&action=${p.action}&sig=${p.sig}">
         <button type="submit" style="background:#0ea5e9;color:#fff;border:0;border-radius:8px;padding:12px 28px;font-size:15px;cursor:pointer;">${label}</button>
       </form>`
    )
  );
});

notifyPrefRoutes.post("/", async (c) => {
  const p = await parseParams(c.env, new URL(c.req.url));
  if (!p) {
    return c.html(page("链接无效", `<p style="color:#64748b;">链接无效或已失效，请从最新的邮件里重新打开。</p>`), 403);
  }
  const token = await getTokenById(c.env, p.tid);
  if (!token) {
    return c.html(page("链接无效", `<p style="color:#64748b;">账号不存在或已清理，无需操作。</p>`), 404);
  }
  // 重读-合并写：只覆盖订阅标志，不碰结算路径并发字段
  await mergeTokenSettlement(c.env, token.uuid, { notify_nodes_subscribed: p.action === "sub" });
  const done = p.action === "sub" ? "已订阅节点更新通知" : "已退订节点更新通知";
  return c.html(
    page(done, `<p style="color:#334155;">${escapeHtml(token.id)}：${done}。本页可关闭。</p>`)
  );
});
