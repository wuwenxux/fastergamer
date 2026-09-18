import type { Env } from "../types";
import { siteUrl } from "./site-url";

const ALIYUN_DM_API = "https://dm.aliyuncs.com";

export function isEmail(contact: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.trim());
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
  /** 一键免登录管理链接（magic ticket，72 小时有效、期内可重复打开） */
  magicUrl?: string;
  /** 试用转正并入的时长说明（如 "另赠 30 天；试用剩余 2 天已并入"），有值时在邮件里展示 */
  mergeNote?: string;
}

/**
 * 通用邮件发送（阿里云邮件推送 SingleSendMail）
 */
export async function sendMail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  text: string
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const accessKeyId = env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = env.ALIYUN_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    console.log("[email] ALIYUN_ACCESS_KEY_ID/SECRET not configured, skipping email");
    return { ok: false, error: "Aliyun credentials not configured" };
  }

  const params: Record<string, string> = {
    Action: "SingleSendMail",
    Version: "2015-11-23",
    Format: "JSON",
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString(),
    AccountName: "service@mail.fastergamer.cn",
    AddressType: "1",
    ToAddress: to,
    Subject: subject,
    HtmlBody: html,
    TextBody: text,
    // true = 回信发到控制台为 service@mail.fastergamer.cn 配置的回信地址（support@fastergamer.cn）
    ReplyToAddress: "true",
  };

  params.Signature = await signRequest(accessKeySecret, params);

  try {
    const body = new URLSearchParams(params).toString();
    const res = await fetch(ALIYUN_DM_API, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    const json = (() => {
      try { return JSON.parse(text) as { Code?: string; Message?: string; RequestId?: string; EnvId?: string }; }
      catch { return null; }
    })();
    // 阿里云成功时返回 { RequestId, EnvId }，失败时返回 { Code, Message, RequestId }
    const isError = !res.ok || (json?.Code !== undefined && json.Code !== "OK");
    if (isError) {
      const error = json?.Message ?? text ?? `Aliyun DM API error (${res.status})`;
      console.error("[email] aliyun failed:", error, "status:", res.status);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message;
    console.error("[email] aliyun exception:", error);
    return { ok: false, error };
  }
}

function encodeRFC3986(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

/**
 * 阿里云邮件推送签名
 * 文档：https://help.aliyun.com/zh/direct-mail/developer-reference/api-signature
 */
async function signRequest(
  secret: string,
  params: Record<string, string>
): Promise<string> {
  const sortedKeys = Object.keys(params).sort();
  const canonicalized = sortedKeys
    .map((k) => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`)
    .join("&");

  const stringToSign = `POST&%2F&${encodeRFC3986(canonicalized)}`;
  const key = `${secret}&`;

  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(stringToSign));
  const bytes = new Uint8Array(signature);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * 发送 token 凭证邮件（阿里云邮件推送）
 */
export async function sendTokenEmail(
  env: Env,
  ctx: TokenEmailContext
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const site = siteUrl(env);
  const tokenUrl = ctx.magicUrl ?? `${site}/tokens`;
  const tokensPage = `${site}/tokens`;
  const recoverUrl = `${site}/recover`;
  // 链接不带 #名称片段：配置名由响应头 profile-title / content-disposition 下发，
  // 一键导入 deep link 自带 name 参数；裸链接保持干净，避免片段随复制/转发扩散
  const subUrl = `${site}/api/sub?uuid=${encodeURIComponent(ctx.uuid)}`;
  // 订阅二维码（Worker /api/sub/qr 实时生成 PNG）：移动端用户很多不知道链接该粘贴到哪，
  // 扫码是最低门槛的导入方式
  const qrUrl = `${site}/api/sub/qr?uuid=${encodeURIComponent(ctx.uuid)}`;
  const mainBtnLabel = ctx.magicUrl ? "一键进入管理页（免登录）" : "查看 Token 与订阅链接";

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
    ${ctx.mergeNote ? `<p style="padding: 10px 14px; background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; color: #065f46;">🎁 ${ctx.mergeNote}</p>` : ""}

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
        <td style="padding: 10px; border: 1px solid #e2e8f0; background: #fff;">${new Date(ctx.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}</td>
      </tr>
      ` : ""}
    </table>

    <div style="text-align: center; margin: 24px 0;">
      <a href="${tokenUrl}" style="display: inline-block; background: #0ea5e9; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 500;">${mainBtnLabel}</a>
    </div>

    <p style="font-size: 14px; color: #64748b;">
      ${ctx.magicUrl ? `上方按钮 72 小时内有效，可重复打开；过期后可在 <a href="${tokensPage}" style="color: #0ea5e9;">我的 Token</a> 页面输入邮箱重新获取管理链接。` : ""}
      如果忘记 Token ID，可凭此邮箱在 <a href="${recoverUrl}" style="color: #0ea5e9;">找回 Token</a> 页面查询。
    </p>
  </div>

  <div style="margin-top: 24px; padding: 20px; background: #fff7ed; border-radius: 12px; border: 1px solid #fed7aa;">
    <p style="margin: 0; font-weight: 500; color: #9a3412;">使用步骤</p>
    <ol style="margin: 10px 0 0; padding-left: 20px; color: #7c2d12; font-size: 14px;">
      <li>手机：用客户端「扫一扫」扫下方二维码直接导入；电脑：复制下方订阅链接粘贴到客户端（首次导入自动激活并开始计时）</li>
      <li>选择节点并开启系统代理</li>
      <li>点上方按钮可随时进入管理页查看用量与有效期</li>
    </ol>
  </div>

  <div style="margin-top: 24px; padding: 16px; background: #f1f5f9; border-radius: 12px; font-size: 13px; color: #64748b;">
    <p style="margin: 0;"><strong>手机导入（推荐）：</strong>用 Clash / Shadowrocket 的「扫一扫」扫这个二维码</p>
    <div style="text-align: center; margin: 12px 0;">
      <img src="${qrUrl}" width="180" height="180" alt="订阅二维码" style="border-radius: 8px; background: #fff;" />
    </div>
    <p style="margin: 0 0 4px; font-size: 12px; color: #94a3b8;">
      在手机上直接看本邮件时：长按二维码保存图片，在客户端里选「从相册识别二维码」；图片不显示时先点「显示图片」。电脑使用则复制下方链接：
    </p>
    <p style="margin: 0;"><strong>订阅链接（复制到 Clash，${ctx.status === "paid" ? "首次导入会自动激活并开始计时" : "可直接使用"}）：</strong></p>
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
${ctx.expiresAt ? `有效期至：${new Date(ctx.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}\n` : ""}
管理入口（${ctx.magicUrl ? "一键免登录，72 小时内有效" : "网页"}）：${tokenUrl}
找回 Token：${recoverUrl}
订阅链接（粘贴到 Clash${ctx.status === "paid" ? "，首次导入自动激活并开始计时" : ""}）：${subUrl}
订阅二维码（手机客户端「扫一扫」导入，在浏览器打开这个地址即可看到）：${qrUrl}

使用步骤：
1. 手机扫二维码直接导入；电脑复制订阅链接粘贴到客户端（首次导入自动激活并开始计时）
2. 选择节点并开启系统代理
3. 点管理入口链接可随时查看用量与有效期
  `.trim();

  return sendMail(env, ctx.contact, subject, html, text);
}
