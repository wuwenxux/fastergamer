import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../services/api";

/**
 * Cloudflare Turnstile 人机验证组件（官方脚本在 index.html 里 async defer 加载）。
 *
 * 挂载时拉取 /api/config 判断是否启用：
 * - sitekey 为空或拉取失败 = 未启用：不渲染任何内容，回调 { enabled: false }，
 *   父表单照常可用，行为与接入前完全一致（本地开发无感）；
 *   官方脚本加载超时（域名被墙等）同样按未启用放行，避免表单永久禁用；
 * - 启用后显式渲染 widget，token 就绪回调 { enabled: true, token }；
 *   token 一次性且 300s 过期，过期后回调 { enabled: true }（清空 token），
 *   提交失败后父组件必须调 ref.reset() 重新获取。
 */

/** 人机验证状态：enabled=false 表示未启用（表单不拦截）；enabled=true 时拿到 token 才允许提交 */
export interface TurnstileState {
  enabled: boolean;
  token?: string;
}

export interface TurnstileHandle {
  /** 提交失败后调用：重置 widget 重新获取 token，并清空父组件里的旧 token */
  reset: () => void;
}

// window.turnstile 全局类型，只声明本组件用到的三个方法
declare global {
  interface Window {
    turnstile?: {
      render(
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "refresh-expired"?: "auto" | "manual" | "never";
          theme?: "light" | "dark" | "auto";
        }
      ): string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

// 配置接口模块级缓存：同页可能挂多个 Turnstile 实例（首页试用 + Tokens 登录链接等），只拉一次
let configPromise: Promise<{ turnstile_site_key: string | null }> | null = null;
function loadConfig() {
  if (!configPromise) {
    configPromise = api.config().catch((e) => {
      configPromise = null; // 失败不缓存，下次挂载重试
      throw e;
    });
  }
  return configPromise;
}

const Turnstile = forwardRef<
  TurnstileHandle,
  { onStateChange: (state: TurnstileState) => void }
>(function Turnstile({ onStateChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // 拿到 sitekey 才渲染容器；未启用（null）时组件对外不可见
  const [sitekey, setSitekey] = useState<string | null>(null);
  // widget 渲染完成前给加载提示：脚本慢/被墙时用户面对禁用按钮至少知道在等什么
  const [rendered, setRendered] = useState(false);
  // 回调存 ref：父组件多传内联函数，避免回调引用变化触发 widget 重渲染
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // 拉取运行时配置判断是否启用人机验证（模块级缓存，同页多实例只拉一次）
  useEffect(() => {
    let cancelled = false;
    loadConfig()
      .then((cfg) => {
        if (cancelled) return;
        if (cfg.turnstile_site_key) {
          setSitekey(cfg.turnstile_site_key);
        } else {
          onStateChangeRef.current({ enabled: false });
        }
      })
      .catch(() => {
        // 配置拉取失败按未启用处理，绝不阻断表单
        if (!cancelled) onStateChangeRef.current({ enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 启用后等官方脚本加载完成（async defer，时序不定，短轮询兜底）再显式渲染 widget。
  // 脚本域名被墙/加载失败时 8s 超时 fail-open 按未启用放行（与服务端未配 secret 自动放行
  // 同策略），避免 widget 永不渲染、表单按钮永久禁用
  useEffect(() => {
    if (!sitekey) return;
    const deadline = Date.now() + 8000;
    const timer = setInterval(() => {
      if (widgetIdRef.current !== null || !window.turnstile || !containerRef.current) return;
      if (Date.now() > deadline) {
        clearInterval(timer);
        console.warn("[Turnstile] 官方脚本加载超时（可能被网络屏蔽），本次按未启用放行");
        setSitekey(null);
        onStateChangeRef.current({ enabled: false });
        return;
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey,
        callback: (token) => onStateChangeRef.current({ enabled: true, token }),
        "expired-callback": () => onStateChangeRef.current({ enabled: true }),
        "refresh-expired": "auto",
        theme: "dark",
      });
      setRendered(true);
      clearInterval(timer);
    }, 100);
    return () => {
      clearInterval(timer);
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [sitekey]);

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.reset(widgetIdRef.current);
      }
      onStateChangeRef.current(sitekey ? { enabled: true } : { enabled: false });
    },
  }));

  if (!sitekey) return null;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div ref={containerRef} />
      {!rendered && <p className="text-xs text-slate-500">人机验证加载中…</p>}
    </div>
  );
});

export default Turnstile;
