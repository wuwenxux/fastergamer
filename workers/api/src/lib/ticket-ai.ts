/**
 * Workers AI 工单助手：为新工单生成回复草稿与分类校正建议。
 *
 * 定位是「给站长的参考稿」——结果写回 ticket.ai_draft，仅管理端展示，
 * 采纳与否由人决定，绝不自动发给用户。
 *
 * 降级原则：AI 绑定缺失 / 调用超时 / 返回解析失败，一律静默降级（每个失败分支
 * 打日志便于排障），绝不影响工单创建主链路。两个入口：
 * - generateTicketDraft：null 语义，工单创建 waitUntil 用
 * - generateTicketDraftVerbose：判别联合带失败原因，管理端手动补草稿端点用
 */
import type { Ticket, TicketAiDraft } from "../../../../shared/types";
import { listTickets } from "./kv";
import type { Env } from "../types";

/**
 * 模型选型：Qwen3 30B MoE（激活参数仅 3B），中文能力是同价位里最强的，
 * 适合中文口语化草稿；Workers AI 目录在售（@cf/qwen/qwen3-30b-a3b-fp8）。
 * 免费额度 10k neurons/天对工单量级绰绰有余。
 */
const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

/** AI 调用超时（毫秒）：Workers AI 冷启动偶发慢，超时就放弃，不阻塞 waitUntil 太久 */
const AI_TIMEOUT_MS = 10_000;

/** 草稿分类只认这四类（pay 类涉及收款，必须人工处理，不给 AI 建议权） */
const DRAFT_CATEGORIES = new Set(["install", "connect", "speed", "other"]);

/** 站点事实清单（写死在 prompt：防模型编造不存在的能力/入口） */
const SITE_FACTS = `
- 服务形态：token 制 VPN（品牌 GameBoost），免注册，购买 token（VLESS UUID）后激活即用
- 协议：VLESS + WebSocket + TLS，端口 443，节点域名 *.fastergamer.click
- 客户端：Clash 系（Clash Verge / mihomo / Stash）与 sing-box，订阅链接一键导入
- 设备规则：每个 token 含主设备 + 若干设备槽位，每槽位独立订阅链接；流量按设备审计、计入 token 总量；超限设备数会被拒绝
- 套餐：按流量限额与有效期区分，到期或流量用尽需续费/升级
- 下载慢/连不上常见排查：换节点、换网络（Wi-Fi/蜂窝）、确认订阅已更新、确认客户端系统代理已开
- WebSocket 隧道仅支持 TCP，不支持 UDP/QUIC（部分游戏语音/加速场景受影响）
- 支付相关（退款/未到账/改单）不在 AI 处理范围，引导用户留订单号由人工处理
`.trim();

/** 取公开 FAQ 条目注入 prompt（与 /api/faq 同口径；截断防 prompt 膨胀） */
const loadFaqContext = async (env: Env): Promise<string> => {
  const tickets = await listTickets(env);
  const faqs = tickets.filter((t) => t.publish_faq && t.reply).slice(0, 20);
  if (faqs.length === 0) return "（暂无）";
  return faqs
    .map((t) => `问：${t.message.slice(0, 120)}\n答：${(t.reply as string).slice(0, 200)}`)
    .join("\n---\n");
};

const buildMessages = (ticket: Ticket, faqContext: string) => [
  {
    role: "system" as const,
    content: `你是 GameBoost 客服的草稿助手。根据用户工单写一份回复草稿，供人工客服参考修改后发出。

【站点事实（只能依据这些回答，不许编造）】
${SITE_FACTS}

【历史 FAQ（可参考其中已验证的解答）】
${faqContext}

【输出要求】
- 严格输出 JSON：{"category": "...", "draft": "..."}，不要输出任何其他内容
- category 是对用户所选分类的校正建议，只能是 install（安装/客户端配置）/ connect（连不上/掉线）/ speed（速度慢/延迟高）/ other 之一
- draft 是中文回复草稿：口语化、像真人客服，≤300 字，不要出现"作为AI""根据我的知识"等口吻
- 信息不足以确诊时，草稿以引导用户补充信息为主（如客户端类型、报错截图、所用节点、网络环境）
- 涉及支付/退款/账号纠纷时，draft 只引导用户留下订单号等待人工处理`,
  },
  {
    role: "user" as const,
    content: `用户工单：
分类：${ticket.category ?? "other"}
描述：${ticket.message.slice(0, 1000)}${ticket.token_id ? `\n关联 Token：${ticket.token_id}` : ""}`,
  },
];

/** 从模型输出提取 JSON：容忍 ```json 围栏、<think> 推理段与前后杂文本 */
const parseDraft = (raw: string, fallbackCategory: string): TicketAiDraft | null => {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // 模型可能前后带解释文字：截取第一个 { 到最后一个 } 之间的内容兜底
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: { category?: unknown; draft?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed.draft !== "string" || parsed.draft.trim().length < 2) return null;
  const category =
    typeof parsed.category === "string" && DRAFT_CATEGORIES.has(parsed.category)
      ? parsed.category
      : DRAFT_CATEGORIES.has(fallbackCategory)
        ? fallbackCategory
        : "other";
  return { category, draft: parsed.draft.trim().slice(0, 300), at: Date.now() };
};

/** 草稿生成结果判别联合：失败带机器可读原因，管理端手动补草稿端点据此返回 502 */
export type TicketDraftResult =
  | { ok: true; draft: TicketAiDraft }
  | { ok: false; error: string };

const fail = (ticketId: string, reason: string, detail = ""): TicketDraftResult => {
  console.log(`[ticket-ai] draft skipped for ${ticketId}: ${reason}${detail ? ` — ${detail}` : ""}`);
  return { ok: false, error: reason };
};

/**
 * 生成工单回复草稿（带失败原因）。任何失败都不抛异常：
 * 绑定缺失/超时/异常/解析失败分别打日志并返回 {ok:false, error}。
 * AI 只是辅助，绝不能成为工单链路的故障点。
 */
export const generateTicketDraftVerbose = async (env: Env, ticket: Ticket): Promise<TicketDraftResult> => {
  if (!env.AI) return fail(ticket.id, "no-binding");
  try {
    const faqContext = await loadFaqContext(env);
    const messages = buildMessages(ticket, faqContext);
    // Promise.race 超时：AI.run 不支持 AbortSignal，超时后底层请求随请求结束被回收
    const result = await Promise.race([
      env.AI.run(MODEL, { messages, max_tokens: 1024 }) as Promise<{ response?: string }>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI timeout")), AI_TIMEOUT_MS)
      ),
    ]);
    const raw = typeof result?.response === "string" ? result.response : "";
    if (!raw) {
      return fail(ticket.id, "empty-response", JSON.stringify(result ?? null).slice(0, 200));
    }
    const draft = parseDraft(raw, ticket.category ?? "other");
    if (!draft) return fail(ticket.id, "parse-failed", raw.slice(0, 200));
    return { ok: true, draft };
  } catch (e) {
    const msg = (e as Error).message;
    return fail(ticket.id, msg === "AI timeout" ? "timeout" : "exception", msg);
  }
};

/**
 * 生成工单回复草稿（null 语义版，工单创建路径用）：失败一律返回 null 静默跳过。
 * 失败原因日志已在 verbose 版里打全，这里无需重复记录。
 */
export const generateTicketDraft = async (env: Env, ticket: Ticket): Promise<TicketAiDraft | null> => {
  const r = await generateTicketDraftVerbose(env, ticket);
  return r.ok ? r.draft : null;
};
