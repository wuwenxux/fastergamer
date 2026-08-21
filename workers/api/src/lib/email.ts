import type { Env } from "../types";

const RESEND_API = "https://api.resend.com/emails";

function isEmail(contact: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim());
}

function siteUrl(env: Env): string {
  return (env.SITE_URL ?? "https://fastergamer.cn").replace(/\/$/, "");
}

export function shouldSendEmail(contact?: string): contact is string {
  return !!contact && isEmail(contact);
}

interface TokenEmailContext {
  tokenId: string;
  uuid: string;
  planName: string;
  status: "paid" | "active";
  contact: string;
  expiresAt?: number;
}

/**
 * 发送 token 凭证邮件
 * 如果未配置 RESEND_API_KEY，则只记录日志，不报错。
 */
export async function sendTokenEmail(
  env: Env,
  ctx: TokenEmailContext
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.log("[email] RESEND_API_KEY not configured, skipping email");
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }

  const from = env.EMAIL_FROM ?? "GameBoost <noreply@fastergamer.cn>";
  const site = siteUrl(env);
  const tokenUrl = `${site}/tokens`;
  const recoverUrl = `${site}/recover`;
  const subUrl = `${site}/api/sub?uuid=${encodeURIComponent(ctx.uuid)}`;
  const activateUrl = `${site}/tokens`;

  const subject = "【GameBoost】你的加速 Token 已生成";
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px; text-align: center;">
    <h1 style="margin: 0; font-size: 22px;">🎮 GameBoost</h1>
    <p style="margin: 8px 0 0; color: #94a3b8;">Token 制游戏加速器</p>
  </div>

  <div style="margin-top: 24px; padding: 20px; background: #f8fafc; border-radius: 12px;">
    <p>你好，</p>
    <p>你购买的 <strong>${ctx.planName}</strong> 已生成 Token，请妥善保存以下信息：</p>

    <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
      <tr>
        <td style="padding: 10px; border: 1px solid #e2e8f0; background: #fff; font-weight: bold; width: 100px;">Token ID</td>
        <td style="padding: 10px; border: 1px solid #e2e8f0; background: #fff; font-family: monospace;">${ctx.tokenId}</td>
      </tr>
      <tr>
        <td style="padding: 10px; border: 1px solid #e2e8f0; background: #fff; font-weight: bold;">状态</td>
        <td style="padding: 10px; border: 1px solid #e2e8f0; background: #fff;">${ctx.status === "paid" ? "待激活（点击立即激活后开始计时）" : "已激活"}</td>
      </tr>
      ${ctx.expiresAt ? `
      <tr>
        <td style="padding: 10px; border: 1px solid #e2e8f0; background: #fff; font-weight: bold;">有效期至</td>
        <td style="padding: 10px; border: 1px solid #e2e8f0; background: #fff;">${new Date(ctx.expiresAt).toLocaleString("zh-CN")}</td>
      </tr>
      ` : ""}
    </table>

    <div style="text-align: center; margin: 24px 0;">
      <a href="${tokenUrl}" style="display: inline-block; background: #0ea5e9; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 500;">查看 Token 与订阅链接</a>
    </div>

    <p style="font-size: 14px; color: #64748b;">
      如果忘记 Token ID，可凭此邮箱在 <a href="${recoverUrl}" style="color: #0ea5e9;">找回 Token</a> 页面查询。
    </p>
  </div>

  <div style="margin-top: 24px; padding: 20px; background: #fff7ed; border-radius: 12px; border: 1px solid #fed7aa;">
    <p style="margin: 0; font-weight: 500; color: #9a3412;">使用步骤</p>
    <ol style="margin: 10px 0 0; padding-left: 20px; color: #7c2d12; font-size: 14px;">
      <li>打开 <a href="${tokenUrl}" style="color: #0ea5e9;">${tokenUrl}</a></li>
      <li>输入 Token ID 查询，如未激活请先点击「立即激活」</li>
      <li>复制 Clash 订阅链接，粘贴到 Clash / Stash 客户端</li>
      <li>选择节点并开启系统代理</li>
    </ol>
  </div>

  <div style="margin-top: 24px; padding: 16px; background: #f1f5f9; border-radius: 12px; font-size: 13px; color: #64748b;">
    <p style="margin: 0;"><strong>订阅链接（可直接复制到 Clash）：</strong></p>
    <code style="display: block; margin-top: 8px; padding: 10px; background: #0f172a; color: #e2e8f0; border-radius: 6px; word-break: break-all;">${subUrl}</code>
  </div>

  <p style="margin-top: 24px; font-size: 13px; color: #94a3b8; text-align: center;">
    本邮件由 GameBoost 自动发送，请勿直接回复。
  </p>
</body>
</html>
  `.trim();

  const text = `
GameBoost Token 凭证

你购买的 ${ctx.planName} 已生成 Token。

Token ID：${ctx.tokenId}
状态：${ctx.status === "paid" ? "待激活" : "已激活"}
${ctx.expiresAt ? `有效期至：${new Date(ctx.expiresAt).toLocaleString("zh-CN")}\n` : ""}
查看 Token：${tokenUrl}
找回 Token：${recoverUrl}
订阅链接（粘贴到 Clash）：${subUrl}

使用步骤：
1. 打开 ${tokenUrl}
2. 输入 Token ID 查询，未激活请先点击「立即激活」
3. 复制 Clash 订阅链接，粘贴到 Clash / Stash 客户端
4. 选择节点并开启系统代理
  `.trim();

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [ctx.contact],
        subject,
        html,
        text,
      }),
    });

    const body = (await res.json().catch(() => null)) as { id?: string; message?: string } | null;
    if (!res.ok) {
      const error = body?.message ?? `Resend API error (${res.status})`;
      console.error("[email] failed:", error);
      return { ok: false, error };
    }
    return { ok: true, id: body?.id };
  } catch (e) {
    const error = (e as Error).message;
    console.error("[email] exception:", error);
    return { ok: false, error };
  }
}
