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

另在本机 127.0.0.1:8788 提供控制服务：/api/agent/refresh 接收中心的配置刷新
推送，/api/metrics 暴露本节点监控指标（均需 x-node-key 鉴权）。
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
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError

ENV_FILE = Path("/etc/vpn-agent/env")
DEFAULT_API_URL = "https://fastergamer.click/api/agent/config"
DEFAULT_XRAY_CONFIG = "/usr/local/etc/xray/config.json"
DEFAULT_XRAY_BIN = "/usr/local/bin/xray"
DEFAULT_XRAY_API = "127.0.0.1:10085"
DEFAULT_ACCESS_LOG = "/var/log/xray/access.log"
DEFAULT_AGENT_LISTEN = "127.0.0.1:8788"
DEFAULT_LEDGER_FILE = "/var/lib/vpn-agent/ledger.json"
# Hysteria2 UDP 入站（可选）：/etc/hysteria/config.yaml 存在才启用。
# 用户同步 = 按白名单整文件重写 + systemctl restart hysteria（配置无热加载）；
# 流量统计 = 周期读 trafficStats HTTP 端点，rx（下行）并入该 uuid 账本
DEFAULT_HY2_CONFIG = "/etc/hysteria/config.yaml"
DEFAULT_HY2_STATS_URL = "http://127.0.0.1:9999/traffic"
DEFAULT_HY2_SERVICE = "hysteria"
HY2_CERT = "/etc/hysteria/cert.crt"
HY2_KEY = "/etc/hysteria/cert.key"
INBOUND_TAG = "vless-in"
# Reality 直连入站（可选）：节点 env 配了 REALITY_PRIVATE_KEY 才生成，
# 与 WS 入站共用同一批 uuid，走 XTLS Vision（TCP+Reality，无域名/证书依赖）
REALITY_INBOUND_TAG = "vless-reality-in"
INTERVAL = 30               # 本地轮询周期（秒）：只读本机 Xray，不联网
CONFIG_EVERY = 60           # 兜底配置拉取：每 60 个周期（=30min）。授权变更由中心
                            # POST /api/agent/refresh 主动推送触发立即刷新，兜底只防丢
IDLE_SETTLE_CYCLES = 3      # 连续 3 个周期无增量且离线 = 判定断联，结算
TRAFFIC_GRACE_S = 48 * 3600 # 与中心 TRAFFIC_GRACE_MS 一致：耗尽后的宽限期
FORCE_SETTLE_AGE_S = 24 * 3600  # 长期在线用户兜底：距上次上报超 24h 强制结算一次
FORCE_SETTLE_IP_CONNS = 50      # 或 ip_conns 条目数超过该值时强制结算（防账本无限增长）

# 中心推送的配置刷新请求标志（AgentHandler 写、主循环读）
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
        e = self.users.setdefault(
            uuid,
            {"accum": 0, "last_counter": None, "last_counter_hy2": None, "idle_cycles": 0,
             "ip_conns": {}, "last_report": None},
        )
        # 旧版账本条目可能缺键（如 ip_conns/last_report/last_counter_hy2）：按默认模板补齐，
        # 避免每周期 KeyError 导致记账停摆
        for k, v in (("accum", 0), ("last_counter", None), ("last_counter_hy2", None),
                     ("idle_cycles", 0), ("ip_conns", {}), ("last_report", None)):
            e.setdefault(k, v)
        return e

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


# ---------- 本地控制服务（/api/agent/refresh 推送接收 + /api/metrics 指标） ----------

# 本节点监控指标（/api/metrics 应答内容）；整体替换赋值，读写线程安全（CPython 引用赋值原子）
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


class AgentHandler(BaseHTTPRequestHandler):
    """/api/metrics 与 /api/agent/refresh，均需 x-node-key 鉴权。
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
        return self._reply(404, "not found", head_only=head_only)


def start_agent_server(listen: str):
    host, port = listen.rsplit(":", 1)
    server = ThreadingHTTPServer((host, int(port)), AgentHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"[info] agent server listening on {listen}")


def build_xray_config(uuids, listen_addr="127.0.0.1", api_addr="127.0.0.1", api_port=10085,
                      access_log=DEFAULT_ACCESS_LOG, reality=None):
    # email 用于 StatsService 按用户统计流量，这里用 uuid 本身作为 email
    clients = [{"id": u, "email": u, "flow": ""} for u in uuids]
    inbounds = [
        {
            "tag": INBOUND_TAG,
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
    ]
    if reality:
        # Reality 入站直连公网（不走 Caddy）：客户端以借用域名的 SNI 建 TLS，
        # 非认证流量被转发给 dest 真实站点，主动探测看到的是伪装站的证书与内容。
        # 无 PROXY protocol 前置，access log 里的来源 IP 天然就是真实客户端 IP
        dest = reality["dest"]
        server_name = dest.rsplit(":", 1)[0]
        inbounds.append({
            "tag": REALITY_INBOUND_TAG,
            "listen": "0.0.0.0",
            "port": reality["port"],
            "protocol": "vless",
            "settings": {
                "clients": [
                    {"id": u, "email": u, "flow": "xtls-rprx-vision"} for u in uuids
                ],
                "decryption": "none",
            },
            "streamSettings": {
                "network": "tcp",
                "security": "reality",
                "realitySettings": {
                    "show": False,
                    "dest": dest,
                    "xver": 0,
                    "serverNames": [server_name],
                    "privateKey": reality["private_key"],
                    "shortIds": [reality["short_id"]],
                },
            },
        })
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
        "inbounds": inbounds,
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


UUID_RE = re.compile(r"[0-9a-fA-F-]{36}")


def sanitize_uuids(uuids) -> list:
    """
    校验中心下发的 uuid 并去重（保持顺序），非法字符串直接丢弃：
    含 > 会打乱 stats 名（user>>>email>>>traffic）解析，含引号会造成订阅 YAML 注入。
    """
    out, seen = [], set()
    for u in uuids or []:
        if not isinstance(u, str) or not UUID_RE.fullmatch(u) or u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def strip_clients(cfg: dict):
    """去掉所有 inbound 用户列表后的配置副本，用于判断是否有结构性变化。"""
    c = copy.deepcopy(cfg)
    try:
        for ib in c["inbounds"]:
            ib["settings"]["clients"] = []
    except Exception:
        pass
    return c


def api_add_users(xray_bin: str, xray_api: str, new_config: dict, uuids: set) -> bool:
    """
    通过 xray api adu 在线添加用户，无需重启。
    adu 接受完整配置 JSON（取其中每个 inbound 的 tag + 用户列表），
    这里基于新配置生成仅含待加用户的临时文件：WS 与 Reality 入站共用同一批
    uuid，但 flow 不同（WS 为空，Reality 必须 xtls-rprx-vision），按 tag 区分。
    """
    inbounds = []
    for ib in new_config["inbounds"]:
        ib2 = copy.deepcopy(ib)
        flow = "xtls-rprx-vision" if ib2["tag"] == REALITY_INBOUND_TAG else ""
        ib2["settings"]["clients"] = [
            {"id": u, "email": u, "flow": flow} for u in sorted(uuids)
        ]
        inbounds.append(ib2)
    expect = len(uuids) * len(inbounds)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as f:
            json.dump({"inbounds": inbounds}, f)
            tmp_path = f.name
        result = subprocess.run(
            [xray_bin, "api", "adu", f"--server={xray_api}", tmp_path],
            capture_output=True,
            text=True,
            timeout=15,
        )
        m = re.search(r"Added (\d+) user", result.stdout)
        ok = result.returncode == 0 and m and int(m.group(1)) == expect
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


def api_remove_users(xray_bin: str, xray_api: str, uuids: set, tags=None) -> bool:
    """
    通过 xray api rmu 在线移除用户，无需重启。
    注意：rmu 会销毁该用户的流量计数器。调用方须先用 flush_counters_once
    把差值落进本地账本，并在成功后把该条目 last_counter 置 None
    （计数器若再出现即按新基线全量计入），否则会漏算/误判。
    """
    try:
        # rmu 只接受单个 -tag：每个 inbound 各执行一次，全部成功才算成功
        tags = tags or [INBOUND_TAG]
        for tag in tags:
            result = subprocess.run(
                [xray_bin, "api", "rmu", f"--server={xray_api}", "-tag", tag]
                + sorted(uuids),
                capture_output=True,
                text=True,
                timeout=15,
            )
            m = re.search(r"Removed (\d+) user", result.stdout)
            ok = result.returncode == 0 and m and int(m.group(1)) == len(uuids)
            if not ok:
                print(
                    f"[warn] rmu incomplete (tag={tag}): rc={result.returncode} "
                    f"out={result.stdout.strip()}",
                    file=sys.stderr,
                )
                return False
        print(f"[info] removed {len(uuids)} user(s) online ({len(tags)} inbound(s))")
        return True
    except Exception as e:
        print(f"[warn] rmu failed: {e}", file=sys.stderr)
        return False


def collect_user_stats(xray_bin: str, xray_api: str) -> tuple[dict[str, int] | None, dict[str, bool]]:
    """
    通过 xray api statsquery 抓取每个 email(uuid) 的下行流量（bytes）及在线状态。
    只计下行（VPS 商家按出站计费，上行不计入配额）。
    返回 (traffic_stats, online_map)；查询失败（超时/解析失败/子进程非零）时
    traffic 为 None —— 与「真的没有计数器」的空 dict 必须可区分，
    否则调用方会把失败当成用户消失而删基线，恢复后全量重计（双重计费）。
    """
    try:
        result = subprocess.run(
            [xray_bin, "api", "statsquery", f"--server={xray_api}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            print(f"[warn] xray api statsquery failed: {result.stderr.strip()}", file=sys.stderr)
            return None, {}
        if not result.stdout.strip():
            return {}, {}
        data = json.loads(result.stdout)
        stats: dict[str, int] = {}
        online: dict[str, bool] = {}
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
        return stats, online
    except FileNotFoundError:
        print(f"[warn] xray binary not found: {xray_bin}", file=sys.stderr)
    except subprocess.TimeoutExpired:
        print("[warn] xray api statsquery timeout", file=sys.stderr)
    except json.JSONDecodeError as e:
        print(f"[warn] failed to parse xray api output: {e}", file=sys.stderr)
    except Exception as e:
        print(f"[warn] collect user stats failed: {e}", file=sys.stderr)
    return None, {}


# ---------- Hysteria2（可选 UDP 入站）：用户同步 + 流量统计 ----------

def build_hy2_config(uuids, port=8445) -> str:
    """
    生成 hysteria2 服务端配置全文。listen/tls/trafficStats 为固定约定
    （证书由 enable-hy2.sh 从 Caddy 证书库复制到 /etc/hysteria/），
    userpass 映射 {uuid: "x"}——客户端 password 字段填 "uuid:x"，
    安全等级与 VLESS 相同（凭证即 uuid 本身）。
    """
    lines = [
        f"listen: :{port}",
        "tls:",
        f"  cert: {HY2_CERT}",
        f"  key: {HY2_KEY}",
        "auth:",
        "  type: userpass",
        "  userpass:",
    ]
    lines += [f"    {u}: x" for u in uuids]
    lines += ["trafficStats:", "  listen: 127.0.0.1:9999", ""]
    return "\n".join(lines)


def parse_hy2_uuids(text: str) -> set:
    """从 hy2 配置文本提取 userpass 映射里的 uuid 集合（用于变更检测）。"""
    uuids = set()
    in_map = False
    for line in text.splitlines():
        if line.strip() == "userpass:":
            in_map = True
            continue
        if in_map:
            if line.startswith("    ") and ":" in line.strip():
                uuids.add(line.strip().split(":", 1)[0])
            elif line.strip():
                in_map = False
    return uuids


def collect_hy2_stats(stats_url: str) -> dict[str, int] | None:
    """
    抓 hysteria2 trafficStats：返回 {uuid: rx 下行 bytes}（累计值，进程重启清零）。
    只计 rx（= 下行，与 xray downlink 同口径）。端点不可达/解析失败返回 None——
    与「真的没有计数器」的空 dict 可区分，调用方不得据此删基线（防双重计费）。
    """
    try:
        with urlopen(stats_url, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return {u: int(v.get("rx", 0)) for u, v in data.items()}
    except Exception:
        return None


def flush_hy2_counters_once(stats_url: str, ledger: Ledger, primed: bool) -> None:
    """restart hysteria 前把各用户计数器差值落进账本（计数器随进程重启清零）。"""
    traffic = collect_hy2_stats(stats_url)
    if not traffic:
        return
    for u, counter in traffic.items():
        e = ledger.entry(u)
        e["accum"] += counter_delta(e["last_counter_hy2"], counter, primed)
        # 进程重启后计数器从 0 重建：按新基线全量计入
        e["last_counter_hy2"] = None


def sync_hy2_users(config_path: str, stats_url: str, service: str,
                   uuids, ledger: Ledger, primed: bool) -> None:
    """
    把 hy2 userpass 同步成白名单 uuid 集合：集合有变化才重写配置并重启服务
    （hy2 无配置热加载）。节点未部署 hy2（无配置文件）时静默跳过。
    重启前先把计数器差值落账，避免丢量。
    """
    try:
        old_text = Path(config_path).read_text(encoding="utf-8")
    except OSError:
        return
    if parse_hy2_uuids(old_text) == set(uuids):
        return
    # 沿用现有配置的监听端口（enable-hy2.sh 支持自定义端口，重写配置不能改它）
    m = re.search(r"^listen:\s*:(\d+)", old_text, re.M)
    port = int(m.group(1)) if m else 8445
    flush_hy2_counters_once(stats_url, ledger, primed)
    Path(config_path).write_text(build_hy2_config(uuids, port=port), encoding="utf-8")
    if os.system(f"systemctl restart {service}") != 0:
        print("[warn] hysteria restart failed", file=sys.stderr)
    else:
        print(f"[info] hy2 users synced: {len(uuids)} uuid(s), hysteria restarted")


def counter_delta(prev, counter: int, primed: bool) -> int:
    """
    计数器差值的纯逻辑（xray 计数器只增不减，重启/rmu 后销毁并随流量懒重建）：
    - prev 为 None 且尚未完成首轮基线（agent 启动/账本丢失）：只建基线不计增量，
      避免把中心旧格式已结算的历史流量重复计入
    - prev 为 None 且已基线化：运行中新出现的计数器从 0 懒创建，当前值全是新增量
    - counter >= prev：正常差值
    - counter < prev：计数器被销毁重建（xray 重启/rmu），当前值全是新增量
    """
    if prev is None:
        return counter if primed else 0
    return counter - prev if counter >= prev else counter


def flush_counters_once(xray_bin: str, xray_api: str, ledger: Ledger,
                        allowed=None, primed: bool = True) -> None:
    """
    抓一次用户计数器并把差值并进账本 accum（不落盘、不判定断联/触线）。
    用于 rmu / restart 销毁计数器之前落账，避免漏算自上次轮询以来的流量。
    statsquery 失败时静默跳过（最多漏一个周期的量，但不阻塞配置同步）。
    """
    traffic, _ = collect_user_stats(xray_bin, xray_api)
    if traffic is None:
        return
    if allowed is not None:
        traffic = {u: b for u, b in traffic.items() if u in allowed}
    for u, counter in traffic.items():
        e = ledger.entry(u)
        e["accum"] += counter_delta(e["last_counter"], counter, primed)
        e["last_counter"] = counter


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
    # Hysteria2 UDP 入站（可选）：配置文件存在才参与同步/记账
    hy2_config = env.get("HY2_CONFIG", DEFAULT_HY2_CONFIG)
    hy2_stats_url = env.get("HY2_STATS_URL", DEFAULT_HY2_STATS_URL)
    hy2_service = env.get("HY2_SERVICE", DEFAULT_HY2_SERVICE)

    # Reality 直连入站（可选）：配了 REALITY_PRIVATE_KEY 才启用。
    # dest 默认借 gateway.icloud.com：TLS1.3+H2 大站、证书链适中；
    # 注意别用 www.microsoft.com——其 8KB+ 证书链会导致 Reality 握手失败（26.3 实测）
    reality = None
    if env.get("REALITY_PRIVATE_KEY"):
        reality = {
            "port": int(env.get("REALITY_PORT", "8444")),
            "dest": env.get("REALITY_DEST", "gateway.icloud.com:443"),
            "private_key": env["REALITY_PRIVATE_KEY"],
            "short_id": env.get("REALITY_SHORT_ID", ""),
        }

    if not node_key:
        print("[error] NODE_KEY not set in /etc/vpn-agent/env", file=sys.stderr)
        sys.exit(1)

    global NODE_KEY, metrics_state
    NODE_KEY = node_key

    print(
        f"[info] agent started, api={api_url}, config={config_path}, "
        f"listen={listen_addr}, xray_api={xray_api}"
    )

    start_agent_server(env.get("AGENT_LISTEN", env.get("SUB_LISTEN", DEFAULT_AGENT_LISTEN)))

    ledger = Ledger(env.get("LEDGER_FILE", DEFAULT_LEDGER_FILE))
    usage_map: dict[str, dict] = {}  # 快照下发的用量基数：uuid -> {used, limit, exhausted_at}
    quota_settled: set[str] = set()  # 已因触线结算过的 uuid（用量回落前不重复触发）
    allowed_list: list = []
    nodes_cached = 0  # 最近一次同步快照里的节点数（仅用于 /api/metrics 展示）
    ever_synced = False  # 是否已完成过一次成功的配置拉取（未完成前 allowed 兜底读磁盘配置）

    cycle = 0
    primed = False  # 第一轮本地轮询只做基线（防旧计数器重计），之后新计数器从 0 起全量计入
    while True:
        cycle += 1
        try:
            # ---- 中心配置：兜底周期拉取，或收到中心推送的刷新通知时立即拉取 ----
            # 中心不可达时跳过本轮同步，本地记账照常（账本落盘，恢复后补报）
            refresh = consume_refresh_request()
            if cycle % CONFIG_EVERY == 1 or refresh:
                try:
                    resp = fetch_config(api_url, node_key)
                    if not resp.get("ok"):
                        print(f"[error] api error: {resp.get('error')}", file=sys.stderr)
                        if refresh:
                            # 推送触发的拉取失败：重新置标志，下个周期重试，别吞掉事件
                            request_config_refresh()
                    else:
                        ever_synced = True
                        allowed_list = sanitize_uuids(resp["data"]["uuids"])
                        usage_map = resp["data"].get("usage", {})
                        nodes_cached = len(resp["data"].get("nodes", []))
                        new_config = build_xray_config(allowed_list, listen_addr, access_log=access_log, reality=reality)
                        # 同步用户自助封禁的 IP 到防火墙（与 Xray 配置变更无关）
                        sync_blocked_ips(resp["data"].get("blocked_ips", []))
                        # Hy2 用户名单同步（未部署 hy2 的节点内部静默跳过）
                        sync_hy2_users(hy2_config, hy2_stats_url, hy2_service,
                                       allowed_list, ledger, primed)
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
                                # restart 会销毁全部流量计数器：先把差值落进账本再重启，
                                # 避免漏算自上次轮询以来的流量
                                flush_counters_once(xray_bin, xray_api, ledger, old_uuids, primed)
                                Path(config_path).write_text(new_text, encoding="utf-8")
                                print(
                                    f"[info] config structure changed, {len(allowed_list)} active uuids, "
                                    "restarting xray..."
                                )
                                restart_xray()
                                # 计数器已销毁：last_counter 置 None，重建后按新基线全量计入
                                for le in ledger.users.values():
                                    le["last_counter"] = None
                            else:
                                new_uuids = set(allowed_list)
                                to_add = new_uuids - old_uuids
                                to_remove = old_uuids - new_uuids
                                ok = True
                                if to_add:
                                    ok = api_add_users(xray_bin, xray_api, new_config, to_add) and ok
                                if to_remove:
                                    # rmu 会销毁这些用户的计数器：先把差值落进账本再移除
                                    flush_counters_once(xray_bin, xray_api, ledger, old_uuids, primed)
                                    ok = api_remove_users(
                                        xray_bin, xray_api, to_remove,
                                        tags=[ib["tag"] for ib in new_config["inbounds"]],
                                    ) and ok
                                    if ok:
                                        # 计数器已销毁：last_counter 置 None，
                                        # 下次见到即按「懒创建全量计入」的新基线处理
                                        for u in to_remove:
                                            le = ledger.users.get(u)
                                            if le:
                                                le["last_counter"] = None
                                Path(config_path).write_text(new_text, encoding="utf-8")
                                if not ok:
                                    # 在线增删失败时回退整重启，保证配置与运行态一致
                                    print("[warn] falling back to xray restart", file=sys.stderr)
                                    flush_counters_once(xray_bin, xray_api, ledger, old_uuids, primed)
                                    restart_xray()
                                    for le in ledger.users.values():
                                        le["last_counter"] = None
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
                    if refresh:
                        # 推送触发的拉取失败：重新置标志，下个周期重试，别吞掉事件
                        request_config_refresh()

            # ---- 本地记账（每周期，纯本机操作） ----
            now = time.time()
            traffic, user_online = collect_user_stats(xray_bin, xray_api)
            # Hy2 每周期计数器（未部署/端点异常时为 None，本轮跳过合并，不丢量）
            hy2_traffic = collect_hy2_stats(hy2_stats_url)
            node_total_bytes, online_count = collect_node_stats(xray_bin, xray_api)
            new_conns = tracker.collect()
            # 只统计白名单内的 uuid：rmu 后 Xray 会残留旧计数器，不过滤的话
            # 中心会对过期 token 做无效更新（last_active_at 被反复刷新）
            allowed = set(allowed_list)
            if not ever_synced:
                # agent 重启后尚未完成过一次成功拉取：allowed 兜底用磁盘上 xray 配置
                # 的 uuid 集合，避免首次 fetch 失败时 allowed 为空过滤掉所有计数器
                try:
                    disk_uuids = parse_config_uuids(Path(config_path).read_text(encoding="utf-8"))
                except OSError:
                    disk_uuids = None
                if disk_uuids:
                    allowed = disk_uuids

            settled: dict[str, int] = {}
            settled_ip_conns: dict[str, dict] = {}

            def settle(uuid: str):
                e = ledger.users.get(uuid)
                if e and e["accum"] > 0 and uuid not in settled:
                    settled[uuid] = e["accum"]
                    settled_ip_conns[uuid] = dict(e["ip_conns"])

            if traffic is None:
                # statsquery 失败（超时/解析失败/子进程非零）：计数器是累计值，
                # 跳过本轮差值计算与账本清理不丢量，下轮按上次基线继续。
                # 绝不能按「没有计数器」处理：那会删掉基线，恢复后被当成
                # 新计数器全量重计（双重计费）
                traffic = {}
                user_online = {}
            else:
                traffic = {u: b for u, b in traffic.items() if u in allowed}
                user_online = {u: o for u, o in user_online.items() if u in allowed}

                for u, counter in traffic.items():
                    e = ledger.entry(u)
                    delta = counter_delta(e["last_counter"], counter, primed)
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
                    # 长期在线兜底：连接活着不会触发断联结算，这里按距上次上报超 24h
                    # 或 ip_conns 条目过多强制结算一次，避免永不上报与账本无限增长
                    if e["last_report"] is None:
                        e["last_report"] = now  # 旧账本缺此字段：从本次见到起算
                    elif (now - e["last_report"] >= FORCE_SETTLE_AGE_S
                          or len(e["ip_conns"]) > FORCE_SETTLE_IP_CONNS):
                        settle(u)

                # Hy2 计数器合并（与 xray 计数器相互独立，各自维护基线/复位检测）
                if hy2_traffic is not None:
                    hy2_traffic = {u: b for u, b in hy2_traffic.items() if u in allowed}
                    for u, counter in hy2_traffic.items():
                        e = ledger.entry(u)
                        delta = counter_delta(e["last_counter_hy2"], counter, primed)
                        e["last_counter_hy2"] = counter
                        e["accum"] += delta
                        if delta > 0:
                            e["idle_cycles"] = 0
                        # 纯 hy2 用户（xray 无计数器，上面循环没覆盖）：
                        # 补齐断联/触线/强制结算判定（无 online 信息，按无增量即闲置处理；
                        # settle 只是上报，不断连，误判代价为零）
                        if u not in traffic:
                            if delta == 0:
                                e["idle_cycles"] += 1
                            if e["idle_cycles"] >= IDLE_SETTLE_CYCLES:
                                settle(u)
                            q = usage_map.get(u)
                            if q and q.get("limit", 0) > 0 and u not in quota_settled:
                                if q.get("used", 0) + e["accum"] >= q["limit"]:
                                    settle(u)
                                    quota_settled.add(u)
                            if e["last_report"] is None:
                                e["last_report"] = now
                            elif (now - e["last_report"] >= FORCE_SETTLE_AGE_S
                                  or len(e["ip_conns"]) > FORCE_SETTLE_IP_CONNS):
                                settle(u)

                # 计数器消失的 uuid（rmu 移除 / xray 重启清零）：结算余量；
                # 无账的直接清条目，有账的上报成功后再清（上报失败条目保留，不丢账）。
                # 仅在 statsquery 成功（traffic 非 None）时允许走到这里删账本条目
                for u in list(ledger.users):
                    if u not in traffic:
                        # 纯 hy2 用户：hy2 计数器还在就不算消失；
                        # hy2 抓取失败且该用户有 hy2 基线时按「还在」处理，
                        # 删基线会在恢复后全量重计（双重计费）
                        if hy2_traffic is None:
                            if ledger.users[u].get("last_counter_hy2") is not None:
                                continue
                        elif u in hy2_traffic:
                            continue
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
                                le["last_report"] = now  # 长期在线兜底以此计时
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
                "nodes_cached": nodes_cached,
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
