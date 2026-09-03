#!/usr/bin/env bash
# FasterGamer 命令行助手
#   1. 识别你的系统/架构，告诉你该下载哪个 Clash 客户端（精确到版本号和直链）
#   2. 已有订阅链接 → 帮你校验有效性并显示用量
#      没有订阅链接 → 输入购买邮箱，把一键登录链接发到你邮箱（点开即可看到订阅）
#
# 用法：bash <(curl -fsSL https://fastergamer.click/fg.sh)
set -euo pipefail

API="https://fastergamer.click"
SITE="https://fastergamer.click"

say()  { printf '%s\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }
hr()   { say "────────────────────────────────────────"; }

command -v curl >/dev/null || { say "缺少 curl，请先安装（如 sudo apt install curl）"; exit 1; }

# ---------- 1. 识别系统 ----------
OS="$(uname -s)"; ARCH="$(uname -m)"
PLATFORM=""
case "$OS" in
  Darwin)
    [ "$ARCH" = "arm64" ] && PLATFORM=macos-arm64 || PLATFORM=macos-x64 ;;
  Linux)
    if [ -n "${PREFIX:-}" ] && echo "${PREFIX:-}" | grep -q termux; then
      PLATFORM=android
    elif [ "$ARCH" = "x86_64" ]; then
      PLATFORM=linux-x64
    elif [ "$ARCH" = "aarch64" ]; then
      PLATFORM=linux-arm64
    fi ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM=windows ;;
esac

bold "== FasterGamer 命令行助手 =="
say "官网：$SITE （没买套餐？先到官网领 30 天免费体验）"
hr
say "检测到你的系统：$OS / $ARCH"

# ---------- 2. 该下载哪个客户端（版本实时取自 GitHub 最新 release）----------
# 从 GitHub releases/latest 里按资产名后缀取精确版本与直链
gh_pick() { # $1=repo  $2=资产名正则（已含结尾引号锚定） → 输出 "版本 下载链接"
  local json
  json="$(curl -fsSL "https://api.github.com/repos/$1/releases/latest")" || return 1
  local ver url
  ver="$(printf '%s' "$json" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)"
  url="$(printf '%s' "$json" | grep -o '"browser_download_url": *"[^"]*"' | grep -E "$2" | head -1 | cut -d'"' -f4)"
  [ -n "${url:-}" ] && say "$ver $url"
}

hr
bold "【第 1 步】下载适合你系统的客户端"
case "$PLATFORM" in
  macos-arm64|macos-x64)
    [ "$PLATFORM" = macos-arm64 ] && pick="$(gh_pick clash-verge-rev/clash-verge-rev 'aarch64\.dmg"' || true)"
    [ "$PLATFORM" = macos-x64 ]  && pick="$(gh_pick clash-verge-rev/clash-verge-rev 'x64\.dmg"' || true)"
    say "👉 macOS 推荐 **Clash Verge Rev**（免费开源，支持 Hysteria2 / Reality）"
    [ -n "${pick:-}" ] && say "   当前最新版本：$(echo "$pick" | cut -d' ' -f1)  下载：$(echo "$pick" | cut -d' ' -f2)"
    say "   备选：App Store 搜 Stash（付费，体验更好）" ;;
  linux-x64|linux-arm64)
    pick="$(gh_pick clash-verge-rev/clash-verge-rev 'amd64\.deb"' || true)"
    say "👉 Linux 桌面推荐 **Clash Verge Rev**（.deb 包）"
    [ -n "${pick:-}" ] && say "   当前最新版本：$(echo "$pick" | cut -d' ' -f1)  下载：$(echo "$pick" | cut -d' ' -f2)"
    say "   无桌面环境（服务器）：用 mihomo 命令行内核"
    say "   $(gh_pick MetaCubeX/mihomo 'linux-amd64-v[0-9][^"]*\.gz"' || echo '见 https://github.com/MetaCubeX/mihomo/releases')" ;;
  android)
    pick="$(gh_pick MetaCubeX/ClashMetaForAndroid 'universal-release\.apk"' || true)"
    say "👉 Android 推荐 **ClashMetaForAndroid**（支持 Hysteria2 / Reality）"
    [ -n "${pick:-}" ] && say "   当前最新版本：$(echo "$pick" | cut -d' ' -f1)  下载：$(echo "$pick" | cut -d' ' -f2)"
    say "   提示：APK 请用手机浏览器下载安装，不是在 Termux 里装" ;;
  windows)
    say "👉 你是 Windows，请改用 PowerShell 版："
    say "   右键开始菜单 → 终端/PowerShell，粘贴执行："
    bold '   iwr -useb https://fastergamer.click/fg.ps1 | iex' ;;
  *)
    say "未识别的系统（$OS/$ARCH），请打开客户端下载页手动选择："
    say "   https://github.com/dodvietchairi/fastergamer-click/blob/main/客户端下载.md" ;;
esac
say ""
say "⚠️  版本要求：必须是 **mihomo(Clash Meta)内核** 的新版客户端才支持"
say "    Hysteria2 和 VLESS Reality。上面给的都是满足要求的最新版；"
say "    老版 Clash Premium（已停更）不支持 Reality，不要再用。"

# ---------- 3. 拿到订阅链接 ----------
hr
bold "【第 2 步】获取 / 校验你的订阅链接"
say "a) 没有订阅链接：输入购买时填的邮箱，一键登录链接会发到你邮箱"
say "b) 已有订阅链接：直接粘贴，我帮你校验有效性"
printf "邮箱或订阅链接（https://...uuid=...）："
read -r INPUT || exit 0

case "$INPUT" in
  *uuid=*)
    UUID="${INPUT##*uuid=}"; UUID="${UUID%%&*}"
    say "校验订阅（uuid=${UUID:0:8}…）..."
    HEADERS="$(curl -fsSI "$API/api/sub?uuid=$UUID" || true)"
    CODE="$(printf '%s' "$HEADERS" | head -1 | awk '{print $2}')"
    case "$CODE" in
      200)
        say "✅ 订阅有效。导入客户端即可使用："
        INFO="$(printf '%s' "$HEADERS" | grep -i '^subscription-userinfo' || true)"
        [ -n "$INFO" ] && say "   $INFO"
        say "   Clash Verge：订阅 → 新建 → 粘贴链接 → 导入"
        say "   Stash/Shadowrocket：右上角 + → 从 URL 下载/Subscribe" ;;
      403) say "❌ 该订阅已过期或被撤销，请登录 $SITE 查看/续费" ;;
      404) say "❌ 未找到该订阅，检查链接是否复制完整" ;;
      *)   say "⚠️  校验请求未成功（HTTP ${CODE:-网络失败}），稍后重试" ;;
    esac ;;
  *@*)
    say "正在把一键登录链接发送到 $INPUT ..."
    RESP="$(curl -fsS -X POST "$API/api/tokens/login-link" \
      -H 'content-type: application/json' \
      -d "{\"contact\":\"$INPUT\"}" || true)"
    if printf '%s' "$RESP" | grep -q '"ok":true'; then
      say "✅ 已发送（若该邮箱购买过套餐）。去邮箱点「一键登录」链接，"
      say "   登录后在管理页复制你的订阅链接，再回来粘贴给我校验。"
      say "   链接 15 分钟内有效、用一次即失效。"
    else
      say "⚠️  发送失败：${RESP:-网络异常}。也可直接在官网 $SITE 登录。"
    fi ;;
  "")  say "已跳过。买套餐请去 $SITE" ;;
  *)   say "输入看起来既不是邮箱也不是订阅链接，重新运行本脚本再试。" ;;
esac

hr
bold "【第 3 步】导入客户端 → 选节点 → 开系统代理"
say "图文教程：https://github.com/dodvietchairi/fastergamer-click"
say "遇到问题：官网「帮助反馈」页提交工单，邮件回复。"
