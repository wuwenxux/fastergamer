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
每 30 秒向中心 API 拉取本节点配置；用户(uuid)增删通过 Xray HandlerService
在线生效（xray api adu/rmu），只有配置结构变化时才整体重启 Xray，
避免用户变动打断全节点连接。同时抓取每个 token 的上下行流量并上报中心。
"""
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

ENV_FILE = Path("/etc/vpn-agent/env")
DEFAULT_API_URL = "https://fastergamer.cn/api/agent/config"
DEFAULT_XRAY_CONFIG = "/usr/local/etc/xray/config.json"
DEFAULT_XRAY_BIN = "/usr/local/bin/xray"
DEFAULT_XRAY_API = "127.0.0.1:10085"
DEFAULT_ACCESS_LOG = "/var/log/xray/access.log"
INBOUND_TAG = "vless-in"
INTERVAL = 30


def load_env():
    env = {
        "API_URL": DEFAULT_API_URL,
        "XRAY_CONFIG": DEFAULT_XRAY_CONFIG,
        "XRAY_BIN": DEFAULT_XRAY_BIN,
        "XRAY_API": DEFAULT_XRAY_API,
        "ACCESS_LOG": DEFAULT_ACCESS_LOG,
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


def build_xray_config(uuids, listen_addr="127.0.0.1", api_addr="127.0.0.1", api_port=10085,
                      access_log=DEFAULT_ACCESS_LOG):
    # email 用于 StatsService 按用户统计流量，这里用 uuid 本身作为 email
    clients = [{"id": u, "email": u, "flow": ""} for u in uuids]
    return {
        # access log 记录每条连接的 来源IP + email(uuid)，agent 增量解析做接入 IP 统计
        "log": {"loglevel": "warning", "access": access_log},
        "stats": {},
        # Xray >= v1.8.11 支持 api.listen 直接绑定 gRPC，无需 dokodemo-door inbound
        "api": {
            "tag": "api",
            "listen": f"{api_addr}:{api_port}",
            # HandlerService 支持 xray api adu/rmu 在线增删用户，避免整重启
            "services": ["StatsService", "HandlerService"],
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
                "streamSettings": {
                    "network": "ws",
                    "wsSettings": {"path": "/vless-ws"},
                    # 前置 Caddy 以 PROXY protocol v1 转发，Xray 日志可见真实客户端 IP
                    "sockopt": {"acceptProxyProtocol": True},
                },
            }
        ],
        "outbounds": [{"protocol": "freedom"}],
    }


def restart_xray():
    # xray 的 systemd 单元没有配置 reload，直接 restart 即可
    code = os.system("systemctl restart xray")
    if code != 0:
        print("[warn] xray restart failed", file=sys.stderr)


def parse_config_uuids(text: str):
    """从配置文件文本解析当前 uuid 集合；解析失败返回 None（视为结构未知）。"""
    try:
        cfg = json.loads(text)
        clients = cfg["inbounds"][0]["settings"]["clients"]
        return {c["id"] for c in clients}
    except Exception:
        return None


def strip_clients(cfg: dict):
    """去掉 inbound 用户列表后的配置副本，用于判断是否有结构性变化。"""
    c = copy.deepcopy(cfg)
    try:
        c["inbounds"][0]["settings"]["clients"] = []
    except Exception:
        pass
    return c


def api_add_users(xray_bin: str, xray_api: str, new_config: dict, uuids: set) -> bool:
    """
    通过 xray api adu 在线添加用户，无需重启。
    adu 接受完整配置 JSON（取其中 inbounds 的用户列表），
    这里基于新配置生成仅含待加用户的临时文件。
    """
    inbound = copy.deepcopy(new_config["inbounds"][0])
    inbound["settings"]["clients"] = [
        {"id": u, "email": u, "flow": ""} for u in sorted(uuids)
    ]
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump({"inbounds": [inbound]}, f)
            tmp_path = f.name
        result = subprocess.run(
            [xray_bin, "api", "adu", f"--server={xray_api}", tmp_path],
            capture_output=True,
            text=True,
            timeout=15,
        )
        m = re.search(r"Added (\d+) user", result.stdout)
        ok = result.returncode == 0 and m and int(m.group(1)) == len(uuids)
        if ok:
            print(f"[info] added {len(uuids)} user(s) online")
        else:
            print(
                f"[warn] adu incomplete: rc={result.returncode} out={result.stdout.strip()}",
                file=sys.stderr,
            )
        return bool(ok)
    except Exception as e:
        print(f"[warn] adu failed: {e}", file=sys.stderr)
        return False
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def api_remove_users(xray_bin: str, xray_api: str, uuids: set) -> bool:
    """
    通过 xray api rmu 在线移除用户，无需重启。
    注意：rmu 会丢弃该用户的流量计数器，效果等同重启清零，
    中心侧按「上报值变小则按新基准累加」处理，不会丢量。
    """
    try:
        result = subprocess.run(
            [xray_bin, "api", "rmu", f"--server={xray_api}", "-tag", INBOUND_TAG]
            + sorted(uuids),
            capture_output=True,
            text=True,
            timeout=15,
        )
        m = re.search(r"Removed (\d+) user", result.stdout)
        ok = result.returncode == 0 and m and int(m.group(1)) == len(uuids)
        if ok:
            print(f"[info] removed {len(uuids)} user(s) online")
        else:
            print(
                f"[warn] rmu incomplete: rc={result.returncode} out={result.stdout.strip()}",
                file=sys.stderr,
            )
        return bool(ok)
    except Exception as e:
        print(f"[warn] rmu failed: {e}", file=sys.stderr)
        return False


def collect_user_stats(xray_bin: str, xray_api: str) -> tuple[dict[str, int], dict[str, bool]]:
    """
    通过 xray api statsquery 抓取每个 email(uuid) 的下行流量（bytes）及在线状态。
    只计下行（VPS 商家按出站计费，上行不计入配额）。
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
        traffic_pattern = re.compile(r"^user>>>([^>]+)>>>traffic>>>downlink$")
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
    总流量只计 inbound>>>vless-in 的 downlink（= VPS 出站，与商家计费口径一致）；
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
        inbound_pattern = re.compile(r"^inbound>>>vless-in>>>traffic>>>downlink$")
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


class AccessLogTracker:
    """
    增量解析 Xray access log，统计每个上报周期内 (uuid → 来源IP → 连接次数)。
    Xray 按连接记一行：`... from 1.2.3.4:5678 accepted tcp:dest:443 [vless-in >> direct] email: uuid`
    （开启 PROXY protocol 后 from 为真实客户端 IP）。字节数无法按连接获得，
    中心侧按连接数比例把 uuid 的流量增量分摊到各 IP，属估算口径。
    """

    LINE_RE = re.compile(r"from ([0-9a-fA-F.:]+):\d+ accepted .* email: (\S+)")

    def __init__(self, path: str):
        self.path = path
        self.offset = None  # int | None；None 表示尚未定位（首次跳到文件尾，跳过历史）

    def collect(self) -> dict[str, dict[str, int]]:
        """读取新增日志并返回本周期计数；文件不存在/未变化时返回空。"""
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return {}
        if self.offset is None:
            self.offset = size
            return {}
        if size < self.offset:
            # 日志被轮转/截断（copytruncate），从头重读
            self.offset = 0
        try:
            with open(self.path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(self.offset)
                chunk = f.read()
                # 只处理到最后一行完整换行，残余部分留到下周期
                last_nl = chunk.rfind("\n")
                if last_nl == -1:
                    return {}
                self.offset += last_nl + 1
                chunk = chunk[: last_nl + 1]
        except OSError:
            return {}
        counts: dict[str, dict[str, int]] = {}
        for line in chunk.splitlines():
            m = self.LINE_RE.search(line)
            if not m:
                continue
            ip, uuid = m.group(1), m.group(2)
            if ip.startswith("127.") or ip == "::1":
                continue  # 本地探测不计
            per_ip = counts.setdefault(uuid, {})
            per_ip[ip] = per_ip.get(ip, 0) + 1
        return counts


def report_traffic(
    api_url: str,
    node_key: str,
    stats: dict[str, int],
    online: dict[str, bool],
    node_total_bytes: int,
    online_count: int,
    ip_conns=None,
):
    """把流量统计、用户在线状态、节点统计 POST 到 /api/agent/traffic。"""
    # api_url 形如 .../agent/config，改成 .../agent/traffic
    traffic_url = api_url.rsplit("/", 1)[0] + "/traffic"
    payload = json.dumps({
        "stats": stats,
        "online": online,
        "node_total_bytes": node_total_bytes,
        "online_count": online_count,
        # 接入 IP 连接计数（本周期增量），中心按比例估算各 IP 流量
        "ip_conns": ip_conns or {},
        # 计费口径：只计下行。中心检测到口径变化时会重置基线，避免重复计费
        "billing": "downlink",
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


BLOCK_CHAIN = "FG-BLOCK"


def sync_blocked_ips(blocked_ips) -> None:
    """
    把中心下发的封禁 IP 列表同步到 iptables（FG-BLOCK 链，INPUT 跳转）。
    幂等：每个周期 diff 增删；节点重启后规则丢失，agent 会在下个周期重建。
    只处理 IPv4；防火墙按 IP 整节点阻断（无法按 uuid 区分），共享出口 IP 有误伤风险，
    由用户在管理页自行权衡。任何失败只告警不影响主循环。
    """
    try:
        desired = {ip for ip in blocked_ips if re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip)}
        rules = subprocess.run(
            ["iptables", "-S", BLOCK_CHAIN], capture_output=True, text=True, timeout=10
        )
        if rules.returncode != 0:
            subprocess.run(["iptables", "-N", BLOCK_CHAIN], capture_output=True, timeout=10)
        check = subprocess.run(
            ["iptables", "-C", "INPUT", "-j", BLOCK_CHAIN], capture_output=True, timeout=10
        )
        if check.returncode != 0:
            subprocess.run(
                ["iptables", "-I", "INPUT", "-j", BLOCK_CHAIN],
                capture_output=True, timeout=10,
            )
        current = set()
        if rules.returncode == 0:
            for line in rules.stdout.splitlines():
                m = re.match(rf"-A {BLOCK_CHAIN} -s (\d+\.\d+\.\d+\.\d+)/32 -j DROP", line)
                if m:
                    current.add(m.group(1))
        for ip in desired - current:
            subprocess.run(
                ["iptables", "-A", BLOCK_CHAIN, "-s", f"{ip}/32", "-j", "DROP"],
                capture_output=True, timeout=10,
            )
            print(f"[info] blocked ip {ip}")
        for ip in current - desired:
            subprocess.run(
                ["iptables", "-D", BLOCK_CHAIN, "-s", f"{ip}/32", "-j", "DROP"],
                capture_output=True, timeout=10,
            )
            print(f"[info] unblocked ip {ip}")
    except Exception as e:
        print(f"[warn] sync blocked ips failed: {e}", file=sys.stderr)


def main():
    env = load_env()
    api_url = env.get("API_URL", DEFAULT_API_URL)
    node_key = env.get("NODE_KEY", "")
    config_path = env.get("XRAY_CONFIG", DEFAULT_XRAY_CONFIG)
    listen_addr = env.get("XRAY_LISTEN", "127.0.0.1")
    xray_bin = env.get("XRAY_BIN", DEFAULT_XRAY_BIN)
    xray_api = env.get("XRAY_API", DEFAULT_XRAY_API)
    access_log = env.get("ACCESS_LOG", DEFAULT_ACCESS_LOG)
    tracker = AccessLogTracker(access_log)

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
            new_config = build_xray_config(uuids, listen_addr, access_log=access_log)
            # 同步用户自助封禁的 IP 到防火墙（与 Xray 配置变更无关，每周期执行）
            sync_blocked_ips(resp["data"].get("blocked_ips", []))
            new_text = json.dumps(new_config, indent=2, ensure_ascii=False)

            old_text = ""
            if os.path.exists(config_path):
                old_text = Path(config_path).read_text(encoding="utf-8")

            if new_text != old_text:
                old_uuids = parse_config_uuids(old_text)
                # 结构变化（除用户列表外的内容不同，如 agent 升级）必须整体重启；
                # 仅用户增删走 Xray API 在线生效，不打断现有连接。
                structural = (
                    old_uuids is None
                    or strip_clients(json.loads(old_text)) != strip_clients(new_config)
                )
                if structural:
                    Path(config_path).write_text(new_text, encoding="utf-8")
                    print(
                        f"[info] config structure changed, {len(uuids)} active uuids, "
                        "restarting xray..."
                    )
                    restart_xray()
                else:
                    new_uuids = set(uuids)
                    to_add = new_uuids - old_uuids
                    to_remove = old_uuids - new_uuids
                    ok = True
                    if to_add:
                        ok = api_add_users(xray_bin, xray_api, new_config, to_add) and ok
                    if to_remove:
                        ok = api_remove_users(xray_bin, xray_api, to_remove) and ok
                    Path(config_path).write_text(new_text, encoding="utf-8")
                    if not ok:
                        # 在线增删失败时回退整重启，保证配置与运行态一致
                        print("[warn] falling back to xray restart", file=sys.stderr)
                        restart_xray()
                    else:
                        print(
                            f"[info] users updated online: +{len(to_add)} -{len(to_remove)}, "
                            f"total {len(uuids)}"
                        )
            else:
                print(f"[info] no config change, {len(uuids)} active uuids")

            # 上报流量、用户在线状态与节点统计（无论配置是否变化）
            traffic, user_online = collect_user_stats(xray_bin, xray_api)
            node_total_bytes, online_count = collect_node_stats(xray_bin, xray_api)
            ip_conns = tracker.collect()
            report_resp = report_traffic(
                api_url, node_key, traffic, user_online, node_total_bytes, online_count, ip_conns
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
# 注意：https://fastergamer.cn 从境外节点访问会被重置，Agent 直连阿里云 API
API_URL=http://42.121.1.56:8787/api/agent/config
NODE_KEY=$NODE_KEY
XRAY_CONFIG=/usr/local/etc/xray/config.json
XRAY_LISTEN=127.0.0.1
XRAY_BIN=/usr/local/bin/xray
XRAY_API=127.0.0.1:10085
EOF
chmod 600 /etc/vpn-agent/env

# access log 轮转：Xray 持有 fd，用 copytruncate 方式，避免撑爆磁盘
mkdir -p /var/log/xray
chown wafer:wafer /var/log/xray 2>/dev/null || true
cat > /etc/logrotate.d/xray-access <<'EOF'
/var/log/xray/access.log {
    daily
    rotate 3
    size 50M
    copytruncate
    compress
    missingok
    notifempty
}
EOF

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
