#!/usr/bin/env python3
# 客户端安装包自动更新：跟进 GitHub 官方最新 release，同步到 R2 桶 fg-clients。
# 另每日同步 sing-box CN 分流规则集（geosite-cn / geosite-gfw / geoip-cn 的 .srs，
# 官方挂在 rule-set 分支而非 release）到 rules/ 前缀，供 sing-box 订阅引用。
#
# 协议约束（重要）：只从 clash-verge-rev、ClashMetaForAndroid 与 SagerNet/sing-box
# 三个官方仓库取包——前两者为 mihomo / Clash Meta 内核，原生支持本站节点的
# VLESS + WebSocket 协议；sing-box 官方 Android 客户端 SFA 免费且支持
# VLESS + WS / Reality / Hysteria2，供 Android 用户直装。
# 不引入其他客户端；若某次 release 缺了预期资产（可能是上游改名/删包），
# 该仓库本次直接跳过并保留旧版，绝不把不完整的版本推给用户。
#
# R2 上的对象名固定（clash-verge-windows-x64.exe 等），前端下载链接不随版本变化；
# 当前版本号写入 fg-clients/version.json 供前端展示。
#
# 网络路径：api.github.com 本机直连可用，但 release 资产下载在国内基本不可达，
# 所以下载经 hk02 中转（ssh 到 hk02 用 curl 拉，再 rsync 回本机），上传 R2 从本机走 wrangler。
#
# cron（每天一次，凌晨低峰）:
#   23 4 * * * python3 /home/wafer/cloudflare/scripts/update-clients.py >> /home/wafer/cloudflare/scripts/update-clients.log 2>&1

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = "/home/wafer/cloudflare"
STATE_FILE = os.path.join(ROOT, "scripts", ".client-versions.json")
BUCKET = "fg-clients"
HK02 = "wafer@64.90.26.88"
SSH = ["ssh", "-i", os.path.expanduser("~/.ssh/id_ed25519_cloudvpn"), "-o", "BatchMode=yes"]
REMOTE_DIR = "/tmp/fg-update"

def _load_dev_vars() -> dict:
    """从 workers/api/.dev.vars 读敏感配置（CLOUDFLARE_API_TOKEN 等，不入库）"""
    env = {}
    try:
        with open(os.path.join(ROOT, "workers", "api", ".dev.vars")) as f:
            for line in f:
                if "=" in line and not line.startswith("#"):
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env


ENV = {
    **os.environ,
    **_load_dev_vars(),
    "CLOUDFLARE_ACCOUNT_ID": "53c1260d62876909566dc69e758d5c36",
}
assert ENV.get("CLOUDFLARE_API_TOKEN"), "缺少 CLOUDFLARE_API_TOKEN（放 workers/api/.dev.vars）"
WRANGLER_CWD = os.path.join(ROOT, "workers", "api")

# (仓库, state 键, [(资产匹配谓词, R2 固定对象名)])
REPOS = [    (
        "clash-verge-rev/clash-verge-rev",
        "clash_verge",
        [
            (lambda n: n.endswith("_x64-setup.exe"), "clash-verge-windows-x64.exe"),
            (lambda n: n.endswith("_arm64-setup.exe"), "clash-verge-windows-arm64.exe"),
            (lambda n: n.endswith("_x64.dmg"), "clash-verge-macos-x64.dmg"),
            (lambda n: n.endswith("_aarch64.dmg"), "clash-verge-macos-arm64.dmg"),
            (lambda n: n.endswith("_amd64.deb"), "clash-verge-linux-amd64.deb"),
            (lambda n: n.endswith("_arm64.deb"), "clash-verge-linux-arm64.deb"),
        ],
    ),
    (
        "MetaCubeX/ClashMetaForAndroid",
        "cmfa",
        [
            (lambda n: "meta-arm64-v8a" in n and n.endswith(".apk"), "cmfa-android-arm64-v8a.apk"),
        ],
    ),
    (
        "SagerNet/sing-box",
        "sfa",
        [
            # universal 包全架构；注意排除 legacy-android-5 变体
            (
                lambda n: n.startswith("SFA-") and n.endswith("-universal.apk") and "legacy" not in n,
                "sfa-android-universal.apk",
            ),
        ],
    ),
]

# sing-box CN 分流规则集：官方编译产物挂在 rule-set 分支（release 里只有旧版 .db）。
# 每天全量拉一次传 R2（文件总量 ~2MB），订阅里引用 dl.fastergamer.click 固定地址。
# 注意 geosite-geolocation-!cn.srs 文件名带 "!"，R2 对象改用 geosite-gfw.srs 规避 URL 转义问题。
RULE_SETS = [
    (
        "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-cn.srs",
        "rules/geosite-cn.srs",
    ),
    (
        "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-%21cn.srs",
        "rules/geosite-gfw.srs",
    ),
    (
        "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs",
        "rules/geoip-cn.srs",
    ),
]


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def latest_release(repo):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={"User-Agent": "fg-client-updater", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def r2_put(obj, path, content_type=None):
    # 本机到 CF API 链路不稳（部署同样因此走 hk02），上传经 hk02 执行 wrangler；
    # 文件先 scp 上去，用完即删
    remote_tmp = f"/tmp/fg-r2put-{os.path.basename(path)}"
    run(["scp", "-i", os.path.expanduser("~/.ssh/id_ed25519_cloudvpn"), "-o", "BatchMode=yes",
         "-q", path, f"{HK02}:{remote_tmp}"])
    try:
        cmd = [
            "cd ~/cloudflare/workers/api &&",
            "CLOUDFLARE_ACCOUNT_ID=53c1260d62876909566dc69e758d5c36",
            f"CLOUDFLARE_API_TOKEN='{ENV['CLOUDFLARE_API_TOKEN']}'",
            "~/cloudflare/node_modules/.bin/wrangler r2 object put",
            f"'{BUCKET}/{obj}' --file '{remote_tmp}' --remote",
        ]
        if content_type:
            cmd += ["--content-type", content_type]
        run(SSH + [HK02, " ".join(cmd)], capture_output=True, text=True)
    finally:
        subprocess.run(SSH + [HK02, f"rm -f {remote_tmp}"])


def update_repo(repo, key, matchers, state, versions):
    rel = latest_release(repo)
    tag = rel["tag_name"]
    if state.get(key) == tag:
        log(f"{key}: 已是最新 {tag}，跳过")
        return
    log(f"{key}: 发现新版本 {tag}（当前 {state.get(key, '无')}）")

    picked = []
    for pred, obj in matchers:
        hit = next((a for a in rel["assets"] if pred(a["name"])), None)
        if not hit:
            log(f"{key}: 警告——{tag} 缺少 {obj} 对应资产，本次跳过该仓库，保留旧版")
            return
        picked.append((hit, obj))

    tmp = tempfile.mkdtemp(prefix="fg-update-")
    try:
        run(SSH + [HK02, f"rm -rf {REMOTE_DIR} && mkdir -p {REMOTE_DIR}"])
        for asset, obj in picked:
            url = asset["browser_download_url"]
            log(f"{key}: hk02 下载 {asset['name']} ({asset['size']} B)")
            run(SSH + [HK02, f"curl -fSL --retry 3 -o {REMOTE_DIR}/{obj} '{url}'"], timeout=1800)
        run(["rsync", "-az", "-e", " ".join(SSH), f"{HK02}:{REMOTE_DIR}/", tmp + "/"], timeout=1800)

        for asset, obj in picked:
            path = os.path.join(tmp, obj)
            actual = os.path.getsize(path)
            if actual != asset["size"]:
                raise RuntimeError(f"{obj} 大小不符：{actual} != {asset['size']}，中止")
            log(f"{key}: 上传 R2 {obj}")
            r2_put(obj, path)

        state[key] = tag
        versions[key] = tag.lstrip("vV")
        log(f"{key}: 已更新到 {tag}")
    finally:
        subprocess.run(["rm", "-rf", tmp])
        subprocess.run(SSH + [HK02, f"rm -rf {REMOTE_DIR}"])


def sync_rule_sets():
    """规则集每日全量同步：raw.githubusercontent 国内不可达，经 hk02 中转下载后传 R2"""
    tmp = tempfile.mkdtemp(prefix="fg-rules-")
    try:
        run(SSH + [HK02, f"rm -rf {REMOTE_DIR} && mkdir -p {REMOTE_DIR}"])
        for url, obj in RULE_SETS:
            name = obj.split("/")[-1]
            log(f"rules: hk02 下载 {name}")
            run(SSH + [HK02, f"curl -fSL --retry 3 -o {REMOTE_DIR}/{name} '{url}'"], timeout=600)
        run(["rsync", "-az", "-e", " ".join(SSH), f"{HK02}:{REMOTE_DIR}/", tmp + "/"], timeout=600)
        for _, obj in RULE_SETS:
            path = os.path.join(tmp, obj.split("/")[-1])
            if os.path.getsize(path) < 10_000:  # .srs 至少几百 KB，过小视为拉取异常
                raise RuntimeError(f"{obj} 只有 {os.path.getsize(path)} B，疑似损坏，中止上传")
            log(f"rules: 上传 R2 {obj}（{os.path.getsize(path)} B）")
            r2_put(obj, path)
    finally:
        subprocess.run(["rm", "-rf", tmp])
        subprocess.run(SSH + [HK02, f"rm -rf {REMOTE_DIR}"])


def main():
    state = {}
    if os.path.exists(STATE_FILE):
        state = json.load(open(STATE_FILE))

    versions = {}
    for repo, key, matchers in REPOS:
        try:
            update_repo(repo, key, matchers, state, versions)
        except Exception as e:
            log(f"{key}: 失败（{e}），保留下次重试")

    try:
        sync_rule_sets()
    except Exception as e:
        log(f"rules: 失败（{e}），保留旧版规则集，下次重试")

    if versions:
        # 与已有 version.json 合并，避免只更新一个仓库时丢掉另一个的版本号
        try:
            with urllib.request.urlopen(f"https://dl.fastergamer.click/version.json", timeout=15) as r:
                old = json.load(r)
            old.update(versions)
            versions = old
        except Exception:
            pass
        versions["updated_at"] = int(time.time())
        vf = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(versions, vf)
        vf.close()
        r2_put("version.json", vf.name, "application/json")
        os.unlink(vf.name)
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=2)
        log(f"version.json 已更新: {versions}")

    log("本轮检查完成")


if __name__ == "__main__":
    main()
