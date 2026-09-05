/**
 * 复制文本到剪贴板，返回是否成功。
 *
 * navigator.clipboard 只在安全上下文且页面聚焦时可用，微信内置浏览器、
 * 老 iOS Safari 等场景会直接抛错；失败时回退到 textarea + execCommand。
 */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 继续走回退方案
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // 防止 iOS 弹出键盘 / 页面滚动
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};
