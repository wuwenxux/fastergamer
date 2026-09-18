import { Hono } from "hono";
import { cors } from "hono/cors";
import { adminRoutes } from "./routes/admin";
import { ordersRoutes } from "./routes/orders";
import { plansRoutes } from "./routes/plans";
import { subRoutes } from "./routes/sub";
import { tokensRoutes } from "./routes/tokens";
import type { Env } from "./types";

import { agentRoutes } from "./routes/agent";
import { nodesRoutes } from "./routes/nodes";
import { referralRoutes } from "./routes/referral";
import { registerRoutes } from "./routes/register";
import { ticketsRoutes } from "./routes/tickets";
import { rateLimit } from "./middleware/rateLimit";
import { turnstile } from "./middleware/turnstile";

const app = new Hono<{ Bindings: Env }>();

// CORS 只允许本站来源（同源请求自动放行，兼容 workers.dev / 自定义域名）；
// localhost 来源只在本地开发（ENVIRONMENT=dev，见 wrangler.toml）放行，生产不放行
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      if (!origin) return "*";
      try {
        if (new URL(origin).host === new URL(c.req.url).host) return origin;
      } catch {
        // origin 非法时按不匹配处理
      }
      if (origin === "https://fastergamer.cn" || origin === "https://www.fastergamer.cn") {
        return origin;
      }
      if (
        c.env.ENVIRONMENT === "dev" &&
        (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))
      ) {
        return origin;
      }
      return "";
    },
    allowHeaders: ["Content-Type", "Authorization", "x-admin-key", "x-node-key", "x-turnstile-token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.get("/health", (c) => c.json({ ok: true, service: "vpn-api" }));

// 公共只读配置：前端拉取 Turnstile sitekey 决定是否渲染验证组件，
// 避免把 sitekey 打进前端构建产物；未配置返回 null，前端据此跳过验证
app.use("/api/config", rateLimit(30, 60_000));
app.get("/api/config", (c) =>
  c.json({ ok: true, data: { turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null } })
);

// 敏感接口限流：找回、下单、反馈、登录链接、magic 核销
app.use("/api/tokens/recover", rateLimit(10, 60_000));
// 匿名表单接口在限流之后追加 Turnstile 人机校验（先限流后人机校验，
// 未配置 TURNSTILE_SECRET_KEY 时 turnstile 中间件自动放行）
app.use("/api/tokens/trial", rateLimit(3, 60_000), turnstile);
app.use("/api/tokens/login-link", rateLimit(5, 60_000), turnstile);
app.use("/api/tokens/magic/consume", rateLimit(10, 60_000));
app.use("/api/tokens/*/reset-penalty", rateLimit(5, 60_000));
app.use("/api/tokens/*/upgrade", rateLimit(10, 60_000));
app.use("/api/orders", rateLimit(20, 60_000), turnstile);
// 「我已支付」是公开接口且会触发站长邮件，限流防刷（订单级 6h 节流之外的第二道防线）
app.use("/api/orders/*/notify-paid", rateLimit(10, 60_000), turnstile);
app.use("/api/feedback", rateLimit(5, 60_000), turnstile);
app.use("/api/register", rateLimit(10, 60_000));
// 二维码生成有少量 CPU 开销且面向公网，限流防刷（正常用户只在打开邮件/页面时加载）
app.use("/api/sub/qr", rateLimit(20, 60_000));

app.route("/api/plans", plansRoutes);
app.route("/api/orders", ordersRoutes);
app.route("/api/tokens", tokensRoutes);
app.route("/api/register", registerRoutes);
// 生产中心已切换到 CF：/api/sub 与 /api/agent/* 直接由本 worker + CF KV 处理，不再反代回 cn
app.route("/api/sub", subRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/admin/nodes", nodesRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/referral", referralRoutes);
app.route("/api", ticketsRoutes);

app.all("*", (c) => c.json({ ok: false, error: "not found" }, 404));

/** 非 /api 请求转给 Static Assets（pages 前端），404 时回退 index.html（SPA 路由） */
async function serveStatic(request: Request, assets: Fetcher): Promise<Response> {
  const res = await assets.fetch(request);
  if (res.status !== 404) return res;
  return assets.fetch(new URL("/index.html", request.url));
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);
    const isApi = pathname.startsWith("/api/") || pathname === "/health";
    if (!isApi && env.ASSETS) return serveStatic(request, env.ASSETS);
    return app.fetch(request, env, ctx);
  },
};
