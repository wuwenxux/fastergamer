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
import { statusRoutes } from "./routes/status";
import { ticketsRoutes } from "./routes/tickets";
import { rateLimit } from "./middleware/rateLimit";

const app = new Hono<{ Bindings: Env }>();

// CORS 只允许本站来源，本地开发允许 localhost
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (origin === "https://fastergamer.cn" || origin === "https://www.fastergamer.cn") {
        return origin;
      }
      if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
        return origin;
      }
      return "";
    },
    allowHeaders: ["Content-Type", "Authorization", "x-admin-key", "x-node-key"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.get("/health", (c) => c.json({ ok: true, service: "vpn-api" }));

/** GET /api/payment-info —— 公开的收款信息（静态转账模式下展示的支付宝账号） */
app.get("/api/payment-info", (c) =>
  c.json({ ok: true, data: { alipay_account: c.env.ALIPAY_ACCOUNT ?? null } })
);

/** GET /api/qr/:name —— 公开的收款码图片输出（仅 alipay） */
app.get("/api/qr/:name", async (c) => {
  const name = c.req.param("name");
  if (name !== "alipay") {
    return c.json({ ok: false, error: "not found" }, 404);
  }
  const { value, metadata } = await c.env.PLANS.getWithMetadata<ArrayBuffer>(
    `qr:${name}`,
    "arrayBuffer"
  );
  if (!value) return c.json({ ok: false, error: "not found" }, 404);
  const contentType =
    (metadata as { contentType?: string } | null)?.contentType ?? "image/png";
  return new Response(value, {
    headers: { "content-type": contentType, "cache-control": "public, max-age=60" },
  });
});

// 敏感接口限流：找回、下单、反馈、登录链接、magic 核销
app.use("/api/tokens/recover", rateLimit(10, 60_000));
app.use("/api/tokens/trial", rateLimit(3, 60_000));
app.use("/api/tokens/login-link", rateLimit(5, 60_000));
app.use("/api/tokens/magic/consume", rateLimit(10, 60_000));
app.use("/api/orders", rateLimit(20, 60_000));
app.use("/api/feedback", rateLimit(5, 60_000));

app.route("/api/plans", plansRoutes);
app.route("/api/orders", ordersRoutes);
app.route("/api/tokens", tokensRoutes);
app.route("/api/sub", subRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/admin/nodes", nodesRoutes);
app.route("/api/agent", agentRoutes);
app.route("/api/nodes/status", statusRoutes);
app.route("/api/referral", referralRoutes);
app.route("/api", ticketsRoutes);

app.all("*", (c) => c.json({ ok: false, error: "not found" }, 404));

export default app;
