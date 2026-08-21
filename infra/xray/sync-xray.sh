#!/bin/bash
set -euo pipefail

# 从 fastergamer.cn 的 API 拉取当前 active token UUID 列表，
# 重写 /usr/local/etc/xray/config.json 的 clients 数组，变化时才重启 xray。

API_URL="https://fastergamer.cn/api/admin/xray-clients?raw=1"
ADMIN_KEY="${ADMIN_KEY:?请通过环境变量提供 ADMIN_KEY}"
CONFIG_FILE="/usr/local/etc/xray/config.json"

TMP_UUIDS=$(mktemp)
TMP_CONFIG=$(mktemp)
trap 'rm -f "$TMP_UUIDS" "$TMP_CONFIG"' EXIT

echo "[$(date -Iseconds)] fetching active uuids..."
curl -fsS -H "x-admin-key: ${ADMIN_KEY}" "${API_URL}" -o "$TMP_UUIDS"

# 把合法 UUID 转成 Xray clients JSON 数组
CLIENTS_JSON=$(jq -Rs '
  [
    split("\n")[]
    | select(length > 0)
    | select(test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"))
    | {id: ., flow: ""}
  ]
' "$TMP_UUIDS")

jq --argjson clients "$CLIENTS_JSON" '{
  log: {loglevel: "warning"},
  inbounds: [{
    listen: "0.0.0.0",
    port: 8443,
    protocol: "vless",
    settings: {
      clients: $clients,
      decryption: "none"
    },
    streamSettings: {
      network: "ws",
      wsSettings: {path: "/vless-ws"}
    }
  }],
  outbounds: [{protocol: "freedom"}]
}' <<<'{}' > "$TMP_CONFIG"

if ! diff -q "$CONFIG_FILE" "$TMP_CONFIG" >/dev/null 2>&1; then
  cp "$TMP_CONFIG" "$CONFIG_FILE"
  echo "[$(date -Iseconds)] config changed, restarting xray..."
  systemctl restart xray
  systemctl status xray --no-pager | head -5
else
  echo "[$(date -Iseconds)] no change, skip restart."
fi
