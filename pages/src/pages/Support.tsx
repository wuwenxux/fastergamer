import { useEffect, useState } from "react";
import type { FaqItem } from "../../../shared/types";
import { api } from "../services/api";

const CATEGORIES = [
  { value: "install", label: "安装 / 导入失败" },
  { value: "connect", label: "无法连接 / 节点不通" },
  { value: "speed", label: "速度慢 / 延迟高" },
  { value: "other", label: "其他问题" },
];

const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c.label])
);

export default function Support() {
  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h2 className="text-2xl font-bold">帮助与反馈</h2>
        <p className="text-sm text-slate-400 mt-1">
          先看看常见问题能否解决你的疑问；如果没有，提交反馈，客服会通过邮件回复你。
        </p>
      </div>
      <FaqList />
      <FeedbackForm />
    </div>
  );
}

function FaqList() {
  const [faq, setFaq] = useState<FaqItem[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    api.faq().then(setFaq).catch(() => {});
  }, []);

  if (faq.length === 0) return null;

  return (
    <section className="space-y-3">
      <h3 className="font-semibold text-lg">常见问题</h3>
      {faq.map((item, i) => (
        <div key={i} className="rounded-xl border border-slate-700 bg-slate-900">
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-medium hover:text-sky-400 transition-colors"
          >
            <span>
              {item.category && (
                <span className="mr-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">
                  {CATEGORY_LABELS[item.category] ?? item.category}
                </span>
              )}
              {item.question}
            </span>
            <span className="text-slate-500 ml-2">{open === i ? "−" : "+"}</span>
          </button>
          {open === i && (
            <div className="px-4 pb-4 text-sm text-slate-300 whitespace-pre-wrap border-t border-slate-800 pt-3">
              {item.answer}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function FeedbackForm() {
  const [contact, setContact] = useState("");
  const [category, setCategory] = useState("install");
  const [tokenId, setTokenId] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setState("sending");
    try {
      await api.feedback({
        contact,
        message,
        category,
        token_id: tokenId.trim() || undefined,
      });
      setState("done");
    } catch (err) {
      setError((err as Error).message);
      setState("idle");
    }
  };

  if (state === "done") {
    return (
      <section className="rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-6 text-center space-y-2">
        <p className="text-lg font-medium text-emerald-400">✅ 已收到你的反馈</p>
        <p className="text-sm text-slate-400">
          客服会尽快回复到 <strong className="text-slate-200">{contact}</strong>，请留意查收邮件（包括垃圾邮件文件夹）。
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-4">
      <h3 className="font-semibold text-lg">提交问题反馈</h3>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block text-sm space-y-1.5">
            <span className="text-slate-400">你的邮箱 <span className="text-rose-400">*</span></span>
            <input
              type="email"
              required
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder="回复将发送到这个邮箱"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
            />
          </label>
          <label className="block text-sm space-y-1.5">
            <span className="text-slate-400">问题类型</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-sm space-y-1.5">
          <span className="text-slate-400">
            Token ID（选填，购买过的话填上便于排查）
          </span>
          <input
            type="text"
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value)}
            placeholder="tk_xxxxxxxx"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-mono focus:border-sky-500 focus:outline-none"
          />
        </label>
        <label className="block text-sm space-y-1.5">
          <span className="text-slate-400">问题描述 <span className="text-rose-400">*</span></span>
          <textarea
            required
            minLength={5}
            maxLength={2000}
            rows={5}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="尽量描述：用的什么客户端、卡在哪一步、有没有报错提示……"
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none resize-y"
          />
        </label>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={state === "sending"}
          className="rounded-lg bg-sky-500 px-6 py-2 text-sm font-medium hover:bg-sky-400 transition-colors disabled:opacity-50"
        >
          {state === "sending" ? "提交中…" : "提交反馈"}
        </button>
      </form>
    </section>
  );
}
