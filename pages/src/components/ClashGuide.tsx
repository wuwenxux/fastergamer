import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

export const CLASH_DOWNLOADS = [
  {
    platform: "Windows",
    name: "Clash Verge Rev",
    versionKey: "clash_verge",
    url: "https://dl.fastergamer.click/clash-verge-windows-x64.exe",
    note: "推荐，支持 VLESS + WS",
  },
  {
    platform: "macOS-arm64",
    name: "Clash Verge Rev (Apple Silicon)",
    versionKey: "clash_verge",
    url: "https://dl.fastergamer.click/clash-verge-macos-arm64.dmg",
    note: "M 系列芯片",
  },
  {
    platform: "macOS-x64",
    name: "Clash Verge Rev (Intel)",
    versionKey: "clash_verge",
    url: "https://dl.fastergamer.click/clash-verge-macos-x64.dmg",
    note: "老款 Intel 芯片",
  },
  {
    platform: "Linux",
    name: "Clash Verge Rev",
    versionKey: "clash_verge",
    url: "https://dl.fastergamer.click/clash-verge-linux-amd64.deb",
    note: "deb 包（Debian / Ubuntu）",
  },
  {
    platform: "Android",
    name: "Clash Meta for Android",
    versionKey: "cmfa",
    url: "https://dl.fastergamer.click/cmfa-android-arm64-v8a.apk",
    note: "支持 VLESS + WS",
  },
  {
    platform: "iOS",
    name: "Stash / Shadowrocket",
    url: "https://apps.apple.com/us/app/stash-rule-based-proxy/id1596063349",
    note: "Stash 支持 Clash 订阅；Shadowrocket 需手动或转换",
  },
];

/**
 * Mac 芯片检测：UA 里 ARM Mac 也写 "Intel Mac OS X"（苹果冻结了 UA），
 * 只能用 WebGL 的 renderer 字符串区分——M 系列显示 "Apple M*"/"Apple GPU"，
 * Intel Mac 显示 Intel/AMD/NVIDIA 显卡名。识别不了返回空串，UI 不给推荐而不是瞎猜。
 */
function detectMacArch(): "arm64" | "x64" | "" {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return "";
    const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    if (/Apple\s?(M\d|GPU)/i.test(renderer)) return "arm64";
    if (/Intel|AMD|NVIDIA|Radeon/i.test(renderer)) return "x64";
  } catch {
    /* ignore */
  }
  return "";
}

export function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Macintosh|Mac OS X/i.test(ua)) {
    const arch = detectMacArch();
    return arch ? `macOS-${arch}` : "macOS";
  }
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "";
}

interface Step {
  id: string;
  title: string;
  detail: React.ReactNode;
  verify: string;
}

export default function ClashGuide() {
  const currentPlatform = useMemo(detectPlatform, []);
  const recommended = CLASH_DOWNLOADS.find((d) => d.platform === currentPlatform);
  const [versions, setVersions] = useState<Record<string, string>>({});

  // 下载站（R2）上的 version.json 由 scripts/update-clients.py 每天自动刷新
  useEffect(() => {
    fetch("https://dl.fastergamer.click/version.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setVersions(j))
      .catch(() => {});
  }, []);

  const steps: Step[] = [
    {
      id: "client",
      title: "下载并安装 Clash 客户端",
      detail: (
        <>
          <p className="mb-2">
            必须选择支持 <strong>VLESS + WebSocket</strong> 的客户端（iOS 见下方专属说明）：
          </p>
          <ul className="space-y-1.5 text-slate-400">
            {CLASH_DOWNLOADS.filter((d) => d.platform !== "iOS").map((d) => (
              <li key={d.name}>
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sky-400 hover:underline"
                >
                  {d.platform}：{d.name} ↗
                </a>
                <span className="text-xs text-slate-500 ml-2">
                  {d.note}
                  {"versionKey" in d && versions[d.versionKey as string]
                    ? ` · 当前 v${versions[d.versionKey as string]}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
          {recommended && recommended.platform !== "iOS" && (
            <a
              href={recommended.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center mt-3 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium hover:bg-sky-400 transition-colors"
            >
              下载 {recommended.name}（检测到适配你的设备）
            </a>
          )}
        </>
      ),
      verify: "客户端安装完成，能正常打开主界面。",
    },
    {
      id: "sub",
      title: "获取订阅链接",
      detail: (
        <>
          <p className="mb-2">
            在「我的 Token」页面复制订阅链接。<strong>订阅链接不是用浏览器打开的</strong>，
            需要粘贴到 Clash / Stash 里导入。
          </p>
          <Link
            to="/tokens"
            className="inline-flex items-center rounded-lg border border-sky-500/50 bg-sky-500/10 px-4 py-2 text-sm font-medium text-sky-400 hover:bg-sky-500/20 transition-colors"
          >
            前往我的 Token 获取链接 →
          </Link>
        </>
      ),
      verify: "链接已验证可用，并已成功复制到剪贴板。",
    },
    {
      id: "import",
      title: "导入订阅到 Clash",
      detail: (
        <ol className="list-decimal list-inside space-y-1 text-slate-400">
          <li>打开 Clash 客户端，进入「订阅 / Profiles」</li>
          <li>粘贴刚才复制的订阅链接</li>
          <li>点击「下载 / Download」</li>
          <li>等待右上角提示更新成功</li>
        </ol>
      ),
      verify: "配置文件下载成功，节点列表出现 MY/HK/JP 等节点。",
    },
    {
      id: "select",
      title: "选择节点",
      detail: (
        <p className="text-slate-400">
          在「代理 / Proxies」页面，选择「🚀 选择节点」分组里的任意一个节点（例如「HK 香港 02」）。建议优先选择离你物理位置近的节点。
        </p>
      ),
      verify: "某个节点前方出现绿色延迟数字，表示连通。",
    },
    {
      id: "enable",
      title: "开启系统代理",
      detail: (
        <p className="text-slate-400">
          返回主界面，打开「系统代理 / System Proxy」开关。如果长时间不稳定，可尝试开启 TUN 模式（需要管理员权限）。
        </p>
      ),
      verify: "开关变为启用状态，浏览器可以访问外网。",
    },
    {
      id: "check",
      title: "确认连接成功",
      detail: (
        <ol className="list-decimal list-inside space-y-1 text-slate-400">
          <li>打开浏览器访问 https://ip.sb</li>
          <li>确认显示的 IP 是节点所在地区（如香港 / 日本 / 马来西亚）</li>
          <li>或访问 https://www.google.com 测试连通性</li>
        </ol>
      ),
      verify: "IP 地区与所选节点一致，网页能正常打开。",
    },
  ];

  const [checked, setChecked] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("clash_guide_checked");
      return new Set(saved ? JSON.parse(saved) : []);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("clash_guide_checked", JSON.stringify([...checked]));
    } catch {
      /* ignore */
    }
  }, [checked]);

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  const progress = Math.round((checked.size / steps.length) * 100);

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-6 space-y-5">
      <div>
        <h3 className="font-semibold text-lg">🤝 新手教程：从安装到连通</h3>
        <p className="text-sm text-slate-400 mt-1">
          本服务使用 VLESS + WebSocket 协议，请使用 Clash Verge / Clash Meta / mihomo 内核客户端。
        </p>
      </div>

      <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="text-xs text-slate-500">
        完成进度：{checked.size} / {steps.length} 步
      </p>

      <div className="space-y-3">
        {steps.map((step, idx) => {
          const isChecked = checked.has(step.id);
          return (
            <div
              key={step.id}
              className={`rounded-xl border p-4 transition-colors ${
                isChecked
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-slate-700 bg-slate-950"
              }`}
            >
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(step.id)}
                  className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-800 text-sky-500 focus:ring-sky-500"
                />
                <div className="flex-1">
                  <div className="font-medium">
                    步骤 {idx + 1}：{step.title}
                  </div>
                  <div className="text-sm mt-1.5">{step.detail}</div>
                  <div className="text-xs text-emerald-400 mt-2">
                    ✅ 确认标志：{step.verify}
                  </div>
                </div>
              </label>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-950 p-4">
        <h4 className="font-medium text-slate-200 mb-2">📱 iPhone / iPad 使用说明</h4>
        <p className="text-sm text-slate-400 mb-3">
          iOS 推荐用 <strong>Stash</strong>，可直接导入本站 Clash 订阅；Shadowrocket 需要手动配置或转换订阅。
        </p>
        <div className="space-y-3 text-sm">
          <div>
            <div className="font-medium text-sky-400">方案 A：Stash（推荐，支持 Clash YAML）</div>
            <ol className="list-decimal list-inside mt-1 space-y-1 text-slate-400">
              <li>美区 App Store 搜索并安装 <strong>Stash</strong></li>
              <li>打开 Stash →「配置」→ 右上角 + →「订阅」</li>
              <li>粘贴本站 Clash 订阅链接，保存并下载</li>
              <li>返回首页，打开「启动」开关即可</li>
            </ol>
            <p className="text-xs text-slate-500 mt-1">
              确认标志：配置里出现 VLESS 节点，且能正常访问外网。
            </p>
          </div>
          <div>
            <div className="font-medium text-sky-400">方案 B：Shadowrocket</div>
            <ol className="list-decimal list-inside mt-1 space-y-1 text-slate-400">
              <li>美区 App Store 购买并安装 <strong>Shadowrocket</strong></li>
              <li>点击右上角 + → 类型选择 <strong>VLESS</strong></li>
              <li>依次填写：地址（节点 host）、端口 443、UUID（你的 token）、传输方式 ws、路径 /vless-ws、TLS 开启</li>
              <li>保存后连接</li>
            </ol>
            <p className="text-xs text-slate-500 mt-1">
              或者使用在线订阅转换工具，把 Clash 链接转成 Shadowrocket 格式后导入。
            </p>
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        订阅链接仅在 token 激活期间有效；到期后请购买并激活新 token。
      </p>
    </div>
  );
}

