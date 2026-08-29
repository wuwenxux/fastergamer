#!/usr/bin/env python3
# 客户端安装包自动更新：跟进 GitHub 官方最新 release，同步到 R2 桶 fg-clients。
#
# 协议约束（重要）：只从 clash-verge-rev 与 ClashMetaForAndroid 两个仓库取包——
# 两者均为 mihomo / Clash Meta 内核，原生支持本站节点的 VLESS + WebSocket 协议。
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
REPOS = [
    (
        "clash-verge-rev/clash-verge-rev",
        "clash_verge",
        [
            (lambda n: n.endswith("_x64-setup.exe"), "clash-verge-windows-x64.exe"),
            (lambda n: n.endswith("_x64.dmg"), "clash-verge-macos-x64.dmg"),
            (lambda n: n.endswith("_aarch64.dmg"), "clash-verge-macos-arm64.dmg"),
            (lambda n: n.endswith("_amd64.deb"), "clash-verge-linux-amd64.deb"),
        ],
    ),
    (
        "MetaCubeX/ClashMetaForAndroid",
        "cmfa",
        [
            (lambda n: "meta-arm64-v8a" in n and n.endswith(".apk"), "cmfa-android-arm64-v8a.apk"),
        ],
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
    cmd = ["npx", "wrangler", "r2", "object", "put", f"{BUCKET}/{obj}", "--file", path, "--remote"]
    if content_type:
        cmd += ["--content-type", content_type]
    run(cmd, cwd=WRANGLER_CWD, env=ENV, capture_output=True, text=True)


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
