import { useEffect, useState } from "react";

/**
 * 客户端下载清单与平台识别 —— 从 ClashGuide 拆出的轻量模块。
 * 首页 / TokenStatus / AuthMagic 只需要这几个辅助，单独成文件避免
 * 为拿它们而把 600 行的教程组件打进首屏 bundle（/guide 路由懒加载后才拉教程本体）。
 */

export const CLASH_DOWNLOADS = [
  {
    platform: "Windows-x64",
    name: "Clash Verge Rev",
    versionKey: "clash_verge",
    url: "https://dl.fastergamer.click/clash-verge-windows-x64.exe",
    note: "推荐，支持 VLESS + WS",
  },
  {
    platform: "Windows-arm64",
    name: "Clash Verge Rev (ARM64)",
    versionKey: "clash_verge",
    url: "https://dl.fastergamer.click/clash-verge-windows-arm64.exe",
    note: "ARM 芯片 Windows（Surface Pro X 等）",
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
    platform: "Linux-x64",
    name: "Clash Verge Rev",
    versionKey: "clash_verge",
    url: "https://dl.fastergamer.click/clash-verge-linux-amd64.deb",
    note: "deb 包（Debian / Ubuntu）",
  },
  {
    platform: "Linux-arm64",
    name: "Clash Verge Rev (ARM64)",
    versionKey: "clash_verge",
    url: "https://dl.fastergamer.click/clash-verge-linux-arm64.deb",
    note: "ARM 架构 Linux（树莓派 / ARM 笔记本）",
  },
  {
    platform: "Android",
    name: "Clash Meta for Android",
    versionKey: "cmfa",
    url: "https://dl.fastergamer.click/cmfa-android-arm64-v8a.apk",
    note: "支持 VLESS + WS",
  },
  {
    // 后缀 singbox 只用于区分同 OS 的第二个客户端，platformMatches 按 OS 段匹配
    platform: "Android-singbox",
    name: "sing-box (SFA)",
    versionKey: "sfa",
    url: "https://dl.fastergamer.click/sfa-android-universal.apk",
    note: "官方免费客户端，支持一键导入",
  },
  {
    platform: "iOS",
    name: "sing-box / Stash / Shadowrocket",
    url: "https://apps.apple.com/us/app/sing-box/id6451272673",
    note: "需外区 Apple ID；sing-box 免费，详见下方 iOS 说明",
  },
];

/**
 * 平台识别：三段式，宁可返回空串（UI 不推荐）也不瞎猜。
 *
 * 1) UA 粗判 OS。注意两个坑：
 *    - ARM Mac 的 UA 也写 "Intel Mac OS X"（苹果冻结 UA），架构必须靠 2)/3)
 *    - iPadOS 13+ 的 UA 伪装成 Macintosh，用 maxTouchPoints 区分
 * 2) navigator.userAgentData.getHighEntropyValues（Chromium 系：Chrome/Edge/Brave/
 *    国产 Chromium 壳）能拿到真实 CPU 架构，ARM Windows / ARM Linux 都准；异步
 * 3) WebGL UNMASKED_RENDERER 兜底（Safari/Firefox）：M 系列 Mac 显示 "Apple M 系列/Apple GPU"，
 *    Intel Mac = Intel/AMD/NVIDIA 显卡名；ARM Windows = Qualcomm Adreno
 */

type Arch = "arm64" | "x64" | "";

/** WebGL 显卡串 → 架构（同步，Safari/Firefox 也能用） */
function archFromWebGL(): Arch {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (!ext) return "";
    const renderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
    if (/Apple\s?(M\d|GPU)/i.test(renderer)) return "arm64"; // M 系列 Mac
    if (/Adreno|Snapdragon|Mali/i.test(renderer)) return "arm64"; // ARM Windows / ARM 设备
    if (/Intel|AMD|NVIDIA|Radeon|GeForce/i.test(renderer)) return "x64";
  } catch {
    /* ignore */
  }
  return "";
}

/** UA 粗判 OS（含 iPadOS 伪装 Mac 的识别） */
export function detectOS(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/i.test(ua)) {
    // iPadOS 桌面模式 UA = Macintosh，靠触屏点数区分
    if (navigator.maxTouchPoints > 1) return "iOS";
    return "macOS";
  }
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "";
}

/** 同步首判：OS + WebGL 架构（能立刻给出大概率的推荐） */
function detectPlatform(): string {
  const os = detectOS();
  if (os !== "macOS" && os !== "Windows" && os !== "Linux") return os;
  const arch = archFromWebGL();
  return arch ? `${os}-${arch}` : os;
}

/** UA-CH 高精度值：Chromium 系浏览器的权威架构信息（比 WebGL 更准） */
async function archFromUserAgentData(): Promise<Arch> {
  try {
    const uad = (
      navigator as Navigator & {
        userAgentData?: {
          getHighEntropyValues(hints: string[]): Promise<{ architecture?: string; bitness?: string }>;
        };
      }
    ).userAgentData;
    if (!uad?.getHighEntropyValues) return "";
    const v = await uad.getHighEntropyValues(["architecture", "bitness"]);
    if (v.architecture === "arm") return "arm64";
    if (v.architecture === "x86" && v.bitness === "64") return "x64";
  } catch {
    /* ignore */
  }
  return "";
}

/** React hook：先给同步首判，Chromium 上再用 UA-CH 修正（能纠正 WebGL 的误判） */
export function usePlatform(): string {
  const [platform, setPlatform] = useState(detectPlatform);
  useEffect(() => {
    const os = detectOS();
    if (os !== "macOS" && os !== "Windows" && os !== "Linux") return;
    archFromUserAgentData().then((arch) => {
      if (arch) setPlatform(`${os}-${arch}`);
    });
  }, []);
  return platform;
}

/** 下载项与检测结果的匹配：精确匹配优先；无架构后缀的下载项（Windows/Linux/Android
 *  只有单构建）匹配该 OS 的任意架构；macOS 分构建，未识别出架构时不推荐。
 *  Android 同 OS 可有多个客户端（Android-singbox），后缀仅区分客户端，按 OS 段匹配 */
export function platformMatches(downloadPlatform: string, detected: string): boolean {
  if (!detected) return false;
  if (downloadPlatform === detected) return true;
  const [dlOs] = downloadPlatform.split("-");
  const [os] = detected.split("-");
  if (dlOs.toLowerCase() === "android") return os.toLowerCase() === "android";
  if (downloadPlatform.includes("-")) return false;
  return downloadPlatform.toLowerCase() === os.toLowerCase();
}
