#!/bin/bash
set -euo pipefail

# 在 VPS 上一键部署 vpn-agent
# 用法：sudo bash deploy-agent.sh <NODE_KEY>

NODE_KEY="${1:-}"
if [ -z "$NODE_KEY" ]; then
  echo "Usage: sudo bash deploy-agent.sh <NODE_KEY>"
  exit 1
fi

install -m 755 /dev/stdin /usr/local/bin/vpn-agent.py <<'PYEOF'
#!/usr/bin/env python3
"""
vpn-agent: 多节点 Xray 配置同步 + 流量上报 Agent
每 30 秒向中心 API 拉取本节点配置，重写 Xray config，变化时 reload；
同时通过 Xray API 抓取每个 token 的上下行流量并上报中心。
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

ENV_FILE = Path("/etc/vpn-agent/env")
DEFAULT_API_URL = "https://fastergamer.cn/api/agent/config"
DEFAULT_XRAY_CONFIG = "/usr/local/etc/xray/config.json"
DEFAULT_XRAY_BIN = "/usr/local/bin/xray"
DEFAULT_XRAY_API = "127.0.0.1:10085"
INTERVAL = 30


def load_env():
    env = {
        "API_URL": DEFAULT_API_URL,
        "XRAY_CONFIG": DEFAULT_XRAY_CONFIG,
        "XRAY_BIN": DEFAULT_XRAY_BIN,
        "XRAY_API": DEFAULT_XRAY_API,
    }
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    env.update(os.environ)
    return env


def fetch_config(api_url: str, node_key: str):
    req = Request(api_url, headers={"x-node-key": node_key})
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_xray_config(uuids, listen_addr="127.0.0.1", api_addr="127.0.0.1", api_port=10085):
    # email 用于 StatsService 按用户统计流量，这里用 uuid 本身作为 email
    clients = [{"id": u, "email": u, "flow": ""} for u in uuids]
    return {
        "log": {"loglevel": "warning"},
        "stats": {},
        # Xray >= v1.8.11 支持 api.listen 直接绑定 gRPC，无需 dokodemo-door inbound
        "api": {
            "tag": "api",
            "listen": f"{api_addr}:{api_port}",
            "services": ["StatsService"],
        },
        "policy": {
            "levels": {
                "0": {
                    "statsUserUplink": True,
                    "statsUserDownlink": True,
                    "statsUserOnline": True,
                }
            },
            "system": {
                "statsInboundUplink": True,
                "statsInboundDownlink": True,
            },
        },
        "inbounds": [
            {
                "tag": "vless-in",
                "listen": listen_addr,
                "port": 8443,
                "protocol": "vless",
                "settings": {"clients": clients, "decryption": "none"},
                "streamSettings": {"network": "ws", "wsSettings": {"path": "/vless-ws"}},
            }
        ],
        "outbounds": [{"protocol": "freedom"}],
    }


def restart_xray():
    # xray 的 systemd 单元没有配置 reload，直接 restart 即可
    code = os.system("systemctl restart xray")
    if code != 0:
        print("[warn] xray restart failed", file=sys.stderr)


def collect_user_stats(xray_bin: str, xray_api: str) -> tuple[dict[str, int], dict[str, bool]]:
    """
    通过 xray api statsquery 抓取每个 email(uuid) 的上下行流量（bytes）及在线状态。
    返回 (traffic_stats, online_map)。
    """
    stats: dict[str, int] = {}
    online: dict[str, bool] = {}
    try:
        result = subprocess.run(
            [xray_bin, "api", "statsquery", f"--server={xray_api}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            print(f"[warn] xray api statsquery failed: {result.stderr.strip()}", file=sys.stderr)
            return stats, online
        if not result.stdout.strip():
            return stats, online
        data = json.loads(result.stdout)
        traffic_pattern = re.compile(r"^user>>>([^>]+)>>>traffic>>>(uplink|downlink)$")
        online_pattern = re.compile(r"^user>>>([^>]+)>>>online$")
        for item in data.get("stat", []):
            name = item.get("name", "")
            traffic_match = traffic_pattern.match(name)
            if traffic_match:
                email = traffic_match.group(1)
                value = int(item.get("value", "0"))
                stats[email] = stats.get(email, 0) + value
                continue
            online_match = online_pattern.match(name)
            if online_match:
                email = online_match.group(1)
                online[email] = int(item.get("value", "0")) > 0
    except FileNotFoundError:
        print(f"[warn] xray binary not found: {xray_bin}", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print("[warn] xray api statsquery timeout", file=sys.stderr)
    except json.JSONDecodeError as e:
        print(f"[warn] failed to parse xray api output: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[warn] collect user stats failed: {e}", file=sys.stderr)
    return stats, online


def collect_node_stats(xray_bin: str, xray_api: str) -> tuple[int, int]:
    """
    抓取节点级统计：返回 (总流量 bytes, 在线用户数)。
    总流量来自 inbound>>>vless-in>>>traffic 的上下行之和；
    在线用户数来自 user>>>email>>>online 计数。
    """
    total_bytes = 0
    online_count = 0
    try:
        result = subprocess.run(
            [xray_bin, "api", "statsquery", f"--server={xray_api}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return total_bytes, online_count
        data = json.loads(result.stdout)
        inbound_pattern = re.compile(r"^inbound>>>vless-in>>>traffic>>>(uplink|downlink)$")
        online_pattern = re.compile(r"^user>>>([^>]+)>>>online$")
        for item in data.get("stat", []):
            name = item.get("name", "")
            if inbound_pattern.match(name):
                total_bytes += int(item.get("value", "0"))
                continue
            if online_pattern.match(name):
                if int(item.get("value", "0")) > 0:
                    online_count += 1
    except Exception:
        # 节点级统计失败不应影响流量上报，静默忽略
        pass
    return total_bytes, online_count


def report_traffic(
    api_url: str,
    node_key: str,
    stats: dict[str, int],
    online: dict[str, bool],
    node_total_bytes: int,
    online_count: int,
):
    """把流量统计、用户在线状态、节点统计 POST 到 /api/agent/traffic。"""
    # api_url 形如 .../agent/config，改成 .../agent/traffic
    traffic_url = api_url.rsplit("/", 1)[0] + "/traffic"
    payload = json.dumps({
        "stats": stats,
        "online": online,
        "node_total_bytes": node_total_bytes,
        "online_count": online_count,
    }).encode("utf-8")
    req = Request(
        traffic_url,
        data=payload,
        headers={"x-node-key": node_key, "content-type": "application/json"},
        method="POST",
    )
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_heartbeat(api_url: str, node_key: str):
    """向中心发送心跳，证明本节点可达。"""
    heartbeat_url = api_url.rsplit("/", 1)[0] + "/heartbeat"
    req = Request(
        heartbeat_url,
        data=b"{}",
        headers={"x-node-key": node_key, "content-type": "application/json"},
        method="POST",
    )
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    env = load_env()
    api_url = env.get("API_URL", DEFAULT_API_URL)
    node_key = env.get("NODE_KEY", "")
    config_path = env.get("XRAY_CONFIG", DEFAULT_XRAY_CONFIG)
    listen_addr = env.get("XRAY_LISTEN", "127.0.0.1")
    xray_bin = env.get("XRAY_BIN", DEFAULT_XRAY_BIN)
    xray_api = env.get("XRAY_API", DEFAULT_XRAY_API)

    if not node_key:
        print("[error] NODE_KEY not set in /etc/vpn-agent/env", file=sys.stderr)
        sys.exit(1)

    print(
        f"[info] agent started, api={api_url}, config={config_path}, "
        f"listen={listen_addr}, xray_api={xray_api}"
    )

    while True:
        try:
            resp = fetch_config(api_url, node_key)
            if not resp.get("ok"):
                print(f"[error] api error: {resp.get('error')}", file=sys.stderr)
                time.sleep(INTERVAL)
                continue

            uuids = resp["data"]["uuids"]
            new_config = build_xray_config(uuids, listen_addr)
            new_text = json.dumps(new_config, indent=2, ensure_ascii=False)

            old_text = ""
            if os.path.exists(config_path):
                old_text = Path(config_path).read_text(encoding="utf-8")

            if new_text != old_text:
                Path(config_path).write_text(new_text, encoding="utf-8")
                print(f"[info] config updated, {len(uuids)} active uuids, reloading xray...")
                restart_xray()
            else:
                print(f"[info] no config change, {len(uuids)} active uuids")

            # 上报流量、用户在线状态与节点统计（无论配置是否变化）
            traffic, user_online = collect_user_stats(xray_bin, xray_api)
            node_total_bytes, online_count = collect_node_stats(xray_bin, xray_api)
            report_resp = report_traffic(
                api_url, node_key, traffic, user_online, node_total_bytes, online_count
            )
            if report_resp.get("ok"):
                online_users = sum(1 for v in user_online.values() if v)
                print(
                    f"[info] stats reported, users={len(traffic)}, online_users={online_users}, "
                    f"node_total_bytes={node_total_bytes}, online_count={online_count}"
                )
            else:
                print(f"[warn] traffic report failed: {report_resp.get('error')}", file=sys.stderr)

            # 发送心跳
            hb_resp = post_heartbeat(api_url, node_key)
            if hb_resp.get("ok"):
                print("[info] heartbeat sent")
            else:
                print(f"[warn] heartbeat failed: {hb_resp.get('error')}", file=sys.stderr)
        except URLError as e:
            print(f"[error] fetch failed: {e}", file=sys.stderr)
        except Exception as e:
            print(f"[error] {e}", file=sys.stderr)

        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
PYEOF

mkdir -p /etc/vpn-agent
cat > /etc/vpn-agent/env <<EOF
API_URL=https://fastergamer.cn/api/agent/config
NODE_KEY=$NODE_KEY
XRAY_CONFIG=/usr/local/etc/xray/config.json
XRAY_LISTEN=127.0.0.1
XRAY_BIN=/usr/local/bin/xray
XRAY_API=127.0.0.1:10085
EOF
chmod 600 /etc/vpn-agent/env

cat > /etc/systemd/system/vpn-agent.service <<'EOF'
[Unit]
Description=VPN Node Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env python3 /usr/local/bin/vpn-agent.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vpn-agent
systemctl restart vpn-agent
systemctl status vpn-agent --no-pager | head -10

echo "[info] vpn-agent deployed."
