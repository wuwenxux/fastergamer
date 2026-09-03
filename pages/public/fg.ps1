# FasterGamer 命令行助手（Windows PowerShell 版）
#   1. 识别系统架构，给出该下载的 Clash 客户端精确版本与直链
#   2. 已有订阅链接 → 校验有效性并显示用量
#      没有订阅链接 → 输入购买邮箱，把一键登录链接发到邮箱
#
# 用法：右键开始菜单 → 终端（或 PowerShell），粘贴执行：
#   iwr -useb https://fastergamer.click/fg.ps1 | iex

$ErrorActionPreference = "Stop"
$API  = "https://fastergamer.click"
$SITE = "https://fastergamer.click"

function Hr { Write-Host "────────────────────────────────────────" }

Write-Host "== FasterGamer 命令行助手（Windows）==" -ForegroundColor Cyan
Write-Host "官网：$SITE （没买套餐？先到官网领 30 天免费体验）"
Hr

# ---------- 1. 架构 ----------
$arch = $env:PROCESSOR_ARCHITECTURE   # AMD64 / ARM64 / x86
Write-Host "检测到你的系统：Windows / $arch"

# ---------- 2. 客户端精确版本（实时取 GitHub 最新 release）----------
function Get-LatestAsset($repo, $pattern) {
    try {
        $r = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest"
        $asset = $r.assets | Where-Object { $_.browser_download_url -match $pattern } | Select-Object -First 1
        if ($asset) { return @{ Ver = $r.tag_name; Url = $asset.browser_download_url } }
    } catch { }
    return $null
}

Hr
Write-Host "【第 1 步】下载客户端" -ForegroundColor Cyan
Write-Host "👉 Windows 推荐 Clash Verge Rev（免费开源，支持 Hysteria2 / Reality）"
$pattern = if ($arch -eq "ARM64") { "arm64-setup\.exe$" } else { "x64-setup\.exe$" }
$pick = Get-LatestAsset "clash-verge-rev/clash-verge-rev" $pattern
if ($pick) {
    Write-Host "   当前最新版本：$($pick.Ver)"
    Write-Host "   下载直链：$($pick.Url)"
    $ans = Read-Host "   现在就用浏览器打开下载页？[Y/n]"
    if ($ans -ne "n") { Start-Process $pick.Url }
} else {
    Write-Host "   （版本查询失败）请打开 https://github.com/clash-verge-rev/clash-verge-rev/releases 下载 x64-setup.exe"
}
Write-Host ""
Write-Host "⚠️  版本要求：必须是 mihomo(Clash Meta)内核 的新版客户端才支持 Hysteria2 和"
Write-Host "    VLESS Reality。上面的 Clash Verge Rev 最新版满足要求；老版 Clash Premium 不要再用。"

# ---------- 3. 订阅链接 ----------
Hr
Write-Host "【第 2 步】获取 / 校验你的订阅链接" -ForegroundColor Cyan
Write-Host "a) 没有订阅链接：输入购买时填的邮箱，一键登录链接会发到你邮箱"
Write-Host "b) 已有订阅链接：直接粘贴，我帮你校验有效性"
$input2 = Read-Host "邮箱或订阅链接（https://...uuid=...）"

if ($input2 -match "uuid=([0-9a-fA-F-]+)") {
    $uuid = $Matches[1]
    Write-Host "校验订阅（uuid=$($uuid.Substring(0,8))…）..."
    try {
        $resp = Invoke-WebRequest -Method Head "$API/api/sub?uuid=$uuid" -UseBasicParsing
        $code = $resp.StatusCode
        $info = $resp.Headers["subscription-userinfo"]
    } catch {
        $code = [int]$_.Exception.Response.StatusCode
    }
    switch ($code) {
        200 {
            Write-Host "✅ 订阅有效。导入客户端即可使用：" -ForegroundColor Green
            if ($info) { Write-Host "   $info" }
            Write-Host "   Clash Verge：订阅 → 新建 → 粘贴链接 → 导入"
        }
        403 { Write-Host "❌ 该订阅已过期或被撤销，请登录 $SITE 查看/续费" -ForegroundColor Red }
        404 { Write-Host "❌ 未找到该订阅，检查链接是否复制完整" -ForegroundColor Red }
        default { Write-Host "⚠️  校验请求未成功（HTTP $code），稍后重试" }
    }
} elseif ($input2 -match "@") {
    Write-Host "正在把一键登录链接发送到 $input2 ..."
    try {
        Invoke-RestMethod -Method Post "$API/api/tokens/login-link" `
            -ContentType "application/json" -Body (@{ contact = $input2 } | ConvertTo-Json) | Out-Null
        Write-Host "✅ 已发送（若该邮箱购买过套餐）。去邮箱点「一键登录」链接，" -ForegroundColor Green
        Write-Host "   登录后在管理页复制你的订阅链接，再回来粘贴给我校验。"
        Write-Host "   链接 15 分钟内有效、用一次即失效。"
    } catch {
        Write-Host "⚠️  发送失败：$($_.Exception.Message)。也可直接在官网 $SITE 登录。"
    }
} else {
    Write-Host "已跳过。买套餐请去 $SITE"
}

Hr
Write-Host "【第 3 步】导入 Clash Verge → 选节点 → 开系统代理" -ForegroundColor Cyan
Write-Host "图文教程：https://github.com/dodvietchairi/fastergamer-click"
Write-Host "遇到问题：官网「帮助反馈」页提交工单，邮件回复。"
