#!/usr/bin/env python3
"""
vpn-agent: 多节点 Xray 配置同步 + 流量结算上报 Agent

结算制上报（v2，纯事件驱动，目标是把中心（Cloudflare KV）的读写压到最低）：
- 本地每 30s 轮询 Xray 计数器（纯本机操作，不联网），增量记入本地账本
  （LEDGER_FILE，默认 /var/lib/vpn-agent/ledger.json，落盘防节点重启丢账）
- 只在两种时机向中心上报增量结算：断联（连续无流量且离线）、配额触线
  （让中心及时记录 exhausted_at，走 48h 宽限流程）。连接活着 = 完全静默
- 无心跳、无周期兜底：节点存活由中心侧 probe-nodes.sh 主动探测（每 5 分钟
  从国内 ping 节点，只在状态翻转时写 KV），比「节点→中心」心跳更能反映用户视角
- 配置每 60s 拉一次（中心是 5 分钟 TTL 的共享快照，读配额充足）；
  快照带每 uuid 的用量基数+限额，agent 用「基数+未结算增量」判断触线

用户(uuid)增删通过 Xray HandlerService 在线生效（xray api adu/rmu），
只有配置结构变化时才整体重启 Xray，避免用户变动打断全节点连接。

另在本机 127.0.0.1:8788 提供订阅服务（GET /api/sub?uuid=）：uuid 在最近一次
同步的授权名单内就直接用缓存的节点列表渲染 Clash YAML 返回，不依赖中心可达；
中心宕机时已授权用户的订阅更新与使用不受影响（激活/计量仍需中心）。
"""
import copy
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen
from urllib.error import URLError

ENV_FILE = Path("/etc/vpn-agent/env")
DEFAULT_API_URL = "https://fastergamer.click/api/agent/config"
DEFAULT_XRAY_CONFIG = "/usr/local/etc/xray/config.json"
DEFAULT_XRAY_BIN = "/usr/local/bin/xray"
DEFAULT_XRAY_API = "127.0.0.1:10085"
DEFAULT_ACCESS_LOG = "/var/log/xray/access.log"
DEFAULT_SUB_LISTEN = "127.0.0.1:8788"
DEFAULT_LEDGER_FILE = "/var/lib/vpn-agent/ledger.json"
INBOUND_TAG = "vless-in"
INTERVAL = 30               # 本地轮询周期（秒）：只读本机 Xray，不联网
CONFIG_EVERY = 60           # 兜底配置拉取：每 60 个周期（=30min）。授权变更由中心
                            # POST /api/agent/refresh 主动推送触发立即刷新，兜底只防丢
IDLE_SETTLE_CYCLES = 3      # 连续 3 个周期无增量且离线 = 判定断联，结算
TRAFFIC_GRACE_S = 48 * 3600 # 与中心 TRAFFIC_GRACE_MS 一致：耗尽后的宽限期

# 中心推送的配置刷新请求标志（SubHandler 写、主循环读）
_refresh_requested = False
_refresh_lock = threading.Lock()


def request_config_refresh():
    global _refresh_requested
    with _refresh_lock:
        _refresh_requested = True


def consume_refresh_request() -> bool:
    global _refresh_requested
    with _refresh_lock:
        r, _refresh_requested = _refresh_requested, False
        return r


class Ledger:
    """
    节点本地流量账本：{uuid: {accum, last_counter, idle_cycles, ip_conns}}。
    每周期落盘（tmp+rename 原子写），agent/xray 重启后接着记，不丢未结算流量。
    accum 是「已确认产生但中心尚未确认收到」的字节数，上报成功才清零。
    """

    def __init__(self, path: str):
        self.path = path
        self.users: dict[str, dict] = {}
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            self.users = {u: dict(v) for u, v in data.get("users", {}).items()}
            print(f"[info] ledger loaded: {len(self.users)} user(s) with state")
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[warn] ledger load failed ({e}), starting empty", file=sys.stderr)

    def entry(self, uuid: str) -> dict:
        return self.users.setdefault(
            uuid, {"accum": 0, "last_counter": None, "idle_cycles": 0, "ip_conns": {}}
        )

    def save(self):
        try:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
            data = {"users": self.users}
            fd, tmp = tempfile.mkstemp(dir=str(Path(self.path).parent), suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, self.path)
        except Exception as e:
            print(f"[warn] ledger save failed: {e}", file=sys.stderr)


def load_env():
    env = {
        "API_URL": DEFAULT_API_URL,
        "XRAY_CONFIG": DEFAULT_XRAY_CONFIG,
        "XRAY_BIN": DEFAULT_XRAY_BIN,
        "XRAY_API": DEFAULT_XRAY_API,
        "ACCESS_LOG": DEFAULT_ACCESS_LOG,
        "LEDGER_FILE": DEFAULT_LEDGER_FILE,
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


# ---------- 本地订阅服务（去中心化：中心不可达时节点仍可应答 /api/sub） ----------

# 最近一次成功同步的授权名单与节点列表；整体替换赋值，读写线程安全（CPython 引用赋值原子）
sub_state = {"uuids": set(), "nodes": []}

# 本节点监控指标（/api/metrics 应答内容），同样整体替换
metrics_state = {
    "ts": 0,
    "node_total_bytes": 0,
    "online_count": 0,
    "whitelist_size": 0,
    "nodes_cached": 0,
    "last_sync_ok": False,
    "last_sync_at": 0,
    "users": {},
}

# 节点密钥（main() 启动时填入），/api/metrics 用它做鉴权
NODE_KEY = ""


REGION_META = [
    ("HK", "🇭🇰", "香港"),
    ("JP", "🇯🇵", "日本"),
    ("MY", "🇲🇾", "马来西亚"),
    ("SG", "🇸🇬", "新加坡"),
    ("US", "🇺🇸", "美国"),
]
AUTO_GROUP = "♻️ 自动选择"
MAIN_GROUP = "🚀 节点选择"
TEST_URL = "http://www.gstatic.com/generate_204"


def supports_geosite(ua: str) -> bool:
    """mihomo 系（Verge/Meta/FlClash）与 Stash 支持 GEOSITE；Clash Premium 不支持。"""
    import re
    return bool(re.search(r"mihomo|verge|meta|stash|flclash", ua or "", re.I))


def build_clash_yaml(uuid: str, nodes: list, user_agent: str = "") -> str:
    """与中心 workers/api/src/lib/clash.ts 的输出格式保持一致（按区域分组）。"""
    geosite = supports_geosite(user_agent)
    lines = ["mixed-port: 7890", "allow-lan: false", "mode: rule", "log-level: info", ""]
    # DNS 分流：国内域名走阿里/腾讯 DNS，境外域名走代理解析（与 clash.ts 保持一致）
    # 老内核 nameserver-policy 的 key 用 +.cn 域名后缀（不认识 geosite: 前缀）
    lines += [
        "dns:",
        "  enable: true",
        "  ipv6: false",
        "  enhanced-mode: fake-ip",
        "  fake-ip-range: 198.18.0.1/16",
        "  nameserver:",
        "    - 223.5.5.5",
        "    - 119.29.29.29",
        "  proxy-server-nameserver:",
        "    - 223.5.5.5",
        "  nameserver-policy:",
        f'    {"\"geosite:cn\"" if geosite else "\"+.cn\""}: 223.5.5.5',
        *(['    "geosite:geolocation-!cn": https://1.1.1.1/dns-query'] if geosite else []),
        "",
    ]
    proxies = [
        {
            "name": f"{n['region']} {n['name']}",
            "region": n["region"],
            "server": n["host"],
            "port": n["port"],
            "tls": n["tls"],
            "ws_path": n["ws_path"],
        }
        for n in nodes
    ]
    lines.append("proxies:")
    for p in proxies:
        lines.append(f'  - name: "{p["name"]}"')
        lines.append("    type: vless")
        lines.append(f"    server: {p['server']}")
        lines.append(f"    port: {p['port']}")
        lines.append(f"    uuid: {uuid}")
        lines.append("    network: ws")
        lines.append(f"    tls: {'true' if p['tls'] else 'false'}")
        if p["tls"]:
            lines.append(f"    servername: {p['server']}")
        lines.append("    ws-opts:")
        lines.append(f'      path: "{p["ws_path"]}"')

    # 按区域归类：顺序跟随 REGION_META，未登记的区域排最后
    meta_by_code = {code: (flag, name) for code, flag, name in REGION_META}

    def region_group_name(code: str) -> str:
        meta = meta_by_code.get(code)
        return f"{meta[0]} {meta[1]}" if meta else code

    by_region: dict[str, list[str]] = {}
    for p in proxies:
        by_region.setdefault(p["region"], []).append(p["name"])
    ordered_codes = [c for c, _, _ in REGION_META if c in by_region] + [
        c for c in by_region if c not in meta_by_code
    ]

    lines.append("")
    lines.append("proxy-groups:")
    # 主分组：默认「自动选择」，可切区域（区域内自动测速）或手动指定单节点
    lines.append(f'  - name: "{MAIN_GROUP}"')
    lines.append("    type: select")
    lines.append("    proxies:")
    lines.append(f'      - "{AUTO_GROUP}"')
    for code in ordered_codes:
        lines.append(f'      - "{region_group_name(code)}"')
    for p in proxies:
        lines.append(f'      - "{p["name"]}"')
    # 全局自动选择：url-test 覆盖全部节点
    lines.append(f'  - name: "{AUTO_GROUP}"')
    lines.append("    type: url-test")
    lines.append("    proxies:")
    for p in proxies:
        lines.append(f'      - "{p["name"]}"')
    lines.append(f"    url: {TEST_URL}")
    lines.append("    interval: 300")
    lines.append("    tolerance: 50")
    # 每个区域一个 url-test 分组
    for code in ordered_codes:
        lines.append(f'  - name: "{region_group_name(code)}"')
        lines.append("    type: url-test")
        lines.append("    proxies:")
        for name in by_region[code]:
            lines.append(f'      - "{name}"')
        lines.append(f"    url: {TEST_URL}")
        lines.append("    interval: 300")
        lines.append("    tolerance: 50")

    lines.append("")
    lines.append("rules:")
    lines.append("  - DOMAIN-SUFFIX,fastergamer.cn,DIRECT")
    lines.append("  - DOMAIN-SUFFIX,fastergamer.click,DIRECT")
    lines.append("  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve")
    lines.append("  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve")
    lines.append("  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve")
    lines.append("  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve")
    if geosite:
        lines.append("  - GEOSITE,CN,DIRECT")
    lines.append("  - GEOIP,CN,DIRECT")
    lines.append(f"  - MATCH,{MAIN_GROUP}")
    return "\n".join(lines)


class SubHandler(BaseHTTPRequestHandler):
    """GET /api/sub?uuid= 订阅；/api/metrics 与 /api/agent/refresh 需 x-node-key 鉴权。
    无日志（Caddy 侧已有访问日志）。"""

    def log_message(self, *args):
        pass

    def _reply(self, code: int, body: str, content_type="text/plain; charset=utf-8", head_only=False):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def do_HEAD(self):
        self._handle(head_only=True)

    def do_GET(self):
        self._handle(head_only=False)

    def do_POST(self):
        # 中心推送的刷新通知走 POST
        self._handle(head_only=False)

    def _handle(self, head_only: bool):
        parsed = urlparse(self.path)
        if parsed.path == "/api/agent/refresh":
            # 中心推送的授权变更通知：鉴权后置标志位，主循环立即拉配置
            key = self.headers.get("x-node-key", "")
            if not NODE_KEY or not hmac.compare_digest(key, NODE_KEY):
                return self._reply(403, "forbidden", head_only=head_only)
            request_config_refresh()
            return self._reply(
                200, '{"ok":true}', content_type="application/json; charset=utf-8",
                head_only=head_only,
            )
        if parsed.path == "/api/metrics":
            # 监控指标：需 x-node-key 鉴权（含每用户流量明细，不公开）
            key = self.headers.get("x-node-key", "")
            if not NODE_KEY or not hmac.compare_digest(key, NODE_KEY):
                return self._reply(403, "forbidden", head_only=head_only)
            return self._reply(
                200, json.dumps({"ok": True, "data": metrics_state}, ensure_ascii=False),
                content_type="application/json; charset=utf-8", head_only=head_only,
            )
        if parsed.path != "/api/sub":
            return self._reply(404, "not found", head_only=head_only)
        uuid = (parse_qs(parsed.query).get("uuid") or [""])[0]
        state = sub_state
        if not uuid or uuid not in state["uuids"]:
            return self._reply(403, "token 不可用（未激活/已过期/未同步到本节点）", head_only=head_only)
        if not state["nodes"]:
            return self._reply(503, "节点列表尚未同步，请稍后重试", head_only=head_only)
        # 节点本地无法提供 per-token 用量，故不下发 subscription-userinfo 头
        self.send_response(200)
        data = build_clash_yaml(
            uuid, state["nodes"], self.headers.get("user-agent", "")
        ).encode("utf-8")
        self.send_header("content-type", "text/yaml; charset=utf-8")
        self.send_header("content-disposition", "attachment; filename=fastergamer.yaml")
        # 客户端启动时距上次更新超过该间隔（小时）才拉取：24 = 打开客户端时更新
        self.send_header("profile-update-interval", "24")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)


def start_sub_server(listen: str):
    host, port = listen.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port)), SubHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"[info] sub server listening on {listen}")


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


def report_settlement(
    api_url: str,
    node_key: str,
    settled: dict[str, int],
    online: dict[str, bool],
    node_total_bytes: int,
    online_count: int,
    ip_conns=None,
):
    """把结算增量、用户在线状态、节点统计 POST 到 /api/agent/traffic（v2 格式）。
    settled 里是「自上次中心确认以来的增量字节」，中心直接累加，不做计数器差值。"""
    # api_url 形如 .../agent/config，改成 .../agent/traffic
    traffic_url = api_url.rsplit("/", 1)[0] + "/traffic"
    payload = json.dumps({
        "v": 2,
        "settled": settled,
        "online": online,
        "node_total_bytes": node_total_bytes,
        "online_count": online_count,
        # 接入 IP 连接计数（本结算周期内累计），中心按比例估算各 IP 流量
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
    with urlopen(req, timeout=20) as resp:
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

    global NODE_KEY, sub_state, metrics_state
    NODE_KEY = node_key

    print(
        f"[info] agent started, api={api_url}, config={config_path}, "
        f"listen={listen_addr}, xray_api={xray_api}"
    )

    start_sub_server(env.get("SUB_LISTEN", DEFAULT_SUB_LISTEN))

    ledger = Ledger(env.get("LEDGER_FILE", DEFAULT_LEDGER_FILE))
    usage_map: dict[str, dict] = {}  # 快照下发的用量基数：uuid -> {used, limit, exhausted_at}
    quota_settled: set[str] = set()  # 已因触线结算过的 uuid（用量回落前不重复触发）
    allowed_list: list = []

    cycle = 0
    primed = False  # 第一轮本地轮询只做基线（防旧计数器重计），之后新计数器从 0 起全量计入
    while True:
        cycle += 1
        try:
            # ---- 中心配置：兜底周期拉取，或收到中心推送的刷新通知时立即拉取 ----
            # 中心不可达时跳过本轮同步，本地记账照常（账本落盘，恢复后补报）
            if cycle % CONFIG_EVERY == 1 or consume_refresh_request():
                try:
                    resp = fetch_config(api_url, node_key)
                    if not resp.get("ok"):
                        print(f"[error] api error: {resp.get('error')}", file=sys.stderr)
                    else:
                        allowed_list = resp["data"]["uuids"]
                        usage_map = resp["data"].get("usage", {})
                        # 更新本地订阅服务状态（整体替换保证原子性；拉取失败时保留上次名单，
                        # 中心宕机期间已授权用户的订阅照常可用）
                        sub_state = {"uuids": set(allowed_list), "nodes": resp["data"].get("nodes", [])}
                        new_config = build_xray_config(allowed_list, listen_addr, access_log=access_log)
                        # 同步用户自助封禁的 IP 到防火墙（与 Xray 配置变更无关）
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
                                    f"[info] config structure changed, {len(allowed_list)} active uuids, "
                                    "restarting xray..."
                                )
                                restart_xray()
                            else:
                                new_uuids = set(allowed_list)
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
                                        f"total {len(allowed_list)}"
                                    )
                        else:
                            print(f"[info] no config change, {len(allowed_list)} active uuids")
                except URLError as e:
                    metrics_state["last_sync_ok"] = False
                    print(f"[error] config fetch failed: {e}", file=sys.stderr)

            # ---- 本地记账（每周期，纯本机操作） ----
            now = time.time()
            traffic, user_online = collect_user_stats(xray_bin, xray_api)
            node_total_bytes, online_count = collect_node_stats(xray_bin, xray_api)
            new_conns = tracker.collect()
            # 只统计白名单内的 uuid：rmu 后 Xray 会残留旧计数器，不过滤的话
            # 中心会对过期 token 做无效更新（last_active_at 被反复刷新）
            allowed = sub_state["uuids"]
            traffic = {u: b for u, b in traffic.items() if u in allowed}
            user_online = {u: o for u, o in user_online.items() if u in allowed}

            settled: dict[str, int] = {}
            settled_ip_conns: dict[str, dict] = {}

            def settle(uuid: str):
                e = ledger.users.get(uuid)
                if e and e["accum"] > 0 and uuid not in settled:
                    settled[uuid] = e["accum"]
                    settled_ip_conns[uuid] = dict(e["ip_conns"])

            for u, counter in traffic.items():
                e = ledger.entry(u)
                prev = e["last_counter"]
                if prev is None and not primed:
                    # 启动后第一轮：账本无记录且计数器早已存在（agent 升级/账本丢失），
                    # 只建基线不计增量，避免把中心旧格式已结算的历史流量重复计入
                    delta = 0
                elif prev is None:
                    # 运行中新出现的计数器：xray 计数器随首次流量从 0 创建，
                    # 当前值全是新增量（懒创建，不存在「启动前的历史」）
                    delta = counter
                elif counter >= prev:
                    delta = counter - prev
                else:
                    # Xray 重启/rmu 后计数器清零：当前值全是新增量
                    delta = counter
                e["last_counter"] = counter
                e["accum"] += delta
                # 本周期新连接计数并入该 uuid 的结算周期累计
                for ip, n in new_conns.get(u, {}).items():
                    e["ip_conns"][ip] = e["ip_conns"].get(ip, 0) + n
                if delta > 0 or user_online.get(u):
                    e["idle_cycles"] = 0
                else:
                    e["idle_cycles"] += 1

                # 断联结算：连续无增量且离线
                if e["idle_cycles"] >= IDLE_SETTLE_CYCLES:
                    settle(u)
                # 配额触线结算：本地用量 = 快照基数 + 未结算增量；触线立即上报，
                # 让中心记录 exhausted_at 进入 48h 宽限流程（硬切断仍靠名单移除）
                q = usage_map.get(u)
                if q and q.get("limit", 0) > 0 and u not in quota_settled:
                    if q.get("used", 0) + e["accum"] >= q["limit"]:
                        settle(u)
                        quota_settled.add(u)
                        print(f"[info] quota reached locally for {u[:8]}…, settling now")

            # 计数器消失的 uuid（rmu 移除 / xray 重启清零）：结算余量；
            # 无账的直接清条目，有账的上报成功后再清（上报失败条目保留，不丢账）
            for u in list(ledger.users):
                if u not in traffic:
                    settle(u)
                    if not ledger.users[u]["accum"]:
                        del ledger.users[u]

            primed = True  # 首轮基线完成，之后新出现的计数器从 0 起全量计入

            # 用量回落（续费/重置）后解除触线标记
            for u in list(quota_settled):
                q = usage_map.get(u)
                e = ledger.users.get(u)
                base = (q.get("used", 0) if q else 0) + (e["accum"] if e else 0)
                if not q or q.get("limit", 0) <= 0 or base < q["limit"]:
                    quota_settled.discard(u)

            # ---- 上报（纯事件驱动：只在有结算事件时联网，无周期兜底） ----
            # 节点存活探测由中心侧 probe-nodes.sh 每 5 分钟主动探测承担（只在状态翻转时写 KV），
            # 不靠 agent 周期上报；连接活着且未触线 = 完全静默。
            if settled:
                try:
                    report_resp = report_settlement(
                        api_url, node_key, settled, user_online,
                        node_total_bytes, online_count, settled_ip_conns,
                    )
                    if report_resp.get("ok"):
                        for u, b in settled.items():
                            le = ledger.users.get(u)
                            if le:
                                le["accum"] = max(0, le["accum"] - b)
                                le["ip_conns"] = {}
                        # 已结算且计数器不再存在的条目可以清掉了
                        for u in list(ledger.users):
                            if u not in traffic and ledger.users[u]["accum"] <= 0:
                                del ledger.users[u]
                        print(
                            f"[info] settled {len(settled)} user(s), "
                            f"bytes={sum(settled.values())}, online_count={online_count}"
                        )
                    else:
                        print(f"[warn] settlement rejected: {report_resp.get('error')}", file=sys.stderr)
                except URLError as e:
                    # 上报失败不丢账：accum 保留，下个触发点重试
                    print(f"[warn] settlement failed: {e}", file=sys.stderr)

            ledger.save()

            # 更新本机监控指标（/api/metrics 应答内容）
            metrics_state = {
                "ts": int(now),
                "node_total_bytes": node_total_bytes,
                "online_count": online_count,
                "whitelist_size": len(allowed),
                "nodes_cached": len(sub_state["nodes"]),
                "last_sync_ok": True,
                "last_sync_at": int(now),
                "users": {
                    u: {"downlink_bytes": b, "online": bool(user_online.get(u))}
                    for u, b in traffic.items()
                },
            }
        except Exception as e:
            metrics_state["last_sync_ok"] = False
            print(f"[error] {e}", file=sys.stderr)

        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
