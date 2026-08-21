#!/usr/bin/env node
/**
 * 多用户端到端测试计划
 *
 * 目标：
 * 1. 创建 N 个测试用户并激活 token。
 * 2. 对每个用户拉取 Clash 订阅，并逐个节点发起真实 VLESS 连接。
 * 3. 验证所有节点可达，且每个用户的流量/最后活跃时间有所增加。
 * 4. 可选清理测试 token（默认启用）。
 *
 * 用法：
 *   node scripts/test-plan.mjs [N] [API_BASE] [ADMIN_KEY]
 * 示例：
 *   node scripts/test-plan.mjs 3 https://fastergamer.cn <ADMIN_KEY>
 */

const [countRaw = "2", apiBase = "https://fastergamer.cn", adminKey = ""] =
  process.argv.slice(2);
const USER_COUNT = Math.max(1, parseInt(countRaw, 10) || 2);
const CONTACT = "test-plan@auto";
const PLAN_ID = "plan_3days";
const CLEANUP = true; // 测试结束后删除测试 token

function log(...args) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...args);
}

async function request(path, init = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body.data;
}

async function createUser(index) {
  const data = await request("/api/orders", {
    method: "POST",
    body: JSON.stringify({ plan_id: PLAN_ID, contact: `${CONTACT}-${index}` }),
  });
  return data.token;
}

async function activateToken(id) {
  return request(`/api/tokens/${id}/activate`, { method: "POST" });
}

async function getToken(id) {
  return request(`/api/tokens/${id}`);
}

async function deleteToken(id) {
  const res = await fetch(`${apiBase}/api/admin/tokens/${id}`, {
    method: "DELETE",
    headers: { "x-admin-key": adminKey },
  });
  if (!res.ok) {
    console.warn(`  清理 token ${id} 失败: ${res.status}`);
  }
}

async function fetchNodeStatus() {
  return request("/api/nodes/status");
}

async function fetchSub(uuid) {
  const res = await fetch(`${apiBase}/api/sub?uuid=${encodeURIComponent(uuid)}`);
  if (!res.ok) {
    throw new Error(`订阅拉取失败 HTTP ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

function parseProxies(yaml) {
  const proxies = [];
  const lines = yaml.split("\n");
  let current = null;
  let inProxies = false;
  for (const line of lines) {
    if (/^proxies:\s*$/.test(line)) {
      inProxies = true;
      continue;
    }
    if (/^proxy-groups:\s*$/.test(line)) {
      inProxies = false;
      continue;
    }
    if (!inProxies) continue;
    const nameMatch = line.match(/^\s+- name:\s*"?(.+?)"?\s*$/);
    if (nameMatch) {
      current = { name: nameMatch[1] };
      proxies.push(current);
      continue;
    }
    if (!current) continue;
    const server = line.match(/^\s+server:\s*(.+?)\s*$/);
    if (server) current.server = server[1];
    const port = line.match(/^\s+port:\s*(\d+)\s*$/);
    if (port) current.port = Number(port[1]);
    const uid = line.match(/^\s+uuid:\s*(.+?)\s*$/);
    if (uid) current.uuid = uid[1];
    const tls = line.match(/^\s+tls:\s*(true|false)\s*$/);
    if (tls) current.tls = tls[1] === "true";
    const path = line.match(/^\s+path:\s*"(.+?)"\s*$/);
    if (path) current.path = path[1];
  }
  return proxies;
}

function buildVlessHeader(uuid, targetHost = "example.com", targetPort = 80) {
  const hex = uuid.replace(/-/g, "");
  const uuidBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    uuidBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  const hostBytes = new TextEncoder().encode(targetHost);
  return new Uint8Array([
    0,
    ...uuidBytes,
    0,
    1,
    targetPort >> 8,
    targetPort & 0xff,
    2,
    hostBytes.length,
    ...hostBytes,
  ]);
}

function testProxy(proxy) {
  return new Promise((resolve) => {
    const scheme = proxy.tls ? "wss" : "ws";
    const url = `${scheme}://${proxy.server}:${proxy.port}${proxy.path || "/vless-ws"}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: false, error: "timeout" });
    }, 15000);

    ws.onopen = () => {
      ws.send(buildVlessHeader(proxy.uuid));
      ws.send(
        new TextEncoder().encode(
          "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"
        )
      );
    };

    ws.onmessage = (ev) => {
      clearTimeout(timer);
      const bytes = new Uint8Array(ev.data);
      const text = new TextDecoder().decode(bytes.slice(2));
      const ok = text.startsWith("HTTP/1.1 200");
      ws.close();
      resolve({ ok, preview: text.slice(0, 40).replace(/\r/g, "") });
    };

    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (ev.code !== 1000 && ev.code !== 1005) {
        resolve({ ok: false, error: `closed ${ev.code} ${ev.reason || ""}` });
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || "websocket error" });
    };
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  log(`启动测试计划：创建 ${USER_COUNT} 个用户，验证节点可达性与流量统计`);

  // 1. 创建并激活测试用户
  log("创建测试 token...");
  const tokens = [];
  for (let i = 0; i < USER_COUNT; i++) {
    const token = await createUser(i);
    const activated = await activateToken(token.id);
    tokens.push(activated);
    log(`  用户 ${i + 1}: ${activated.id} / ${activated.uuid}`);
  }

  // 2. 等待 Agent 把 UUID 同步到 Xray（最多等 40 秒）
  log("等待 Agent 同步配置到 Xray...");
  await sleep(35_000);

  // 3. 记录测试前状态
  const beforeNodes = await fetchNodeStatus();
  const beforeByNode = Object.fromEntries(
    beforeNodes.map((n) => [n.id, { total_bytes: n.total_bytes ?? 0 }])
  );
  const beforeByToken = Object.fromEntries(
    await Promise.all(
      tokens.map(async (t) => {
        const fresh = await getToken(t.id);
        return [t.id, { traffic: fresh.traffic_used_gb, last_active: fresh.last_active_at ?? 0 }];
      })
    )
  );

  // 4. 对每个用户、每个节点发起连接
  log("开始逐个用户/节点连接测试...");
  const nodeReachability = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    log(`  测试用户 ${i + 1} (${token.id})`);
    const yaml = await fetchSub(token.uuid);
    const proxies = parseProxies(yaml);
    if (proxies.length === 0) {
      console.warn(`    订阅中未解析到节点`);
      continue;
    }
    for (const proxy of proxies) {
      process.stdout.write(`    → ${proxy.name} ... `);
      const result = await testProxy(proxy);
      if (result.ok) {
        console.log(`✅ OK`);
        nodeReachability.set(proxy.name, true);
      } else {
        console.log(`❌ FAIL: ${result.error}`);
        nodeReachability.set(proxy.name, false);
      }
    }
  }

  // 5. 等待下一次 Agent 流量上报
  log("等待 Agent 上报流量统计...");
  await sleep(35_000);

  // 6. 验证测试后状态
  log("验证结果...");
  const afterNodes = await fetchNodeStatus();
  let nodeTrafficIncreased = true;
  for (const node of afterNodes) {
    const before = beforeByNode[node.id]?.total_bytes ?? 0;
    const after = node.total_bytes ?? 0;
    const increased = after > before;
    if (!increased) nodeTrafficIncreased = false;
    console.log(
      `  节点 ${node.name}: total_bytes ${before} → ${after} (${increased ? "增加" : "未增加"})`
    );
  }

  let userTrafficIncreased = true;
  for (const token of tokens) {
    const after = await getToken(token.id);
    const before = beforeByToken[token.id];
    const trafficUp = after.traffic_used_gb > before.traffic;
    const activeUp = (after.last_active_at ?? 0) > before.last_active;
    if (!trafficUp || !activeUp) userTrafficIncreased = false;
    console.log(
      `  用户 ${token.id}: traffic ${before.traffic.toExponential(3)} → ${after.traffic_used_gb.toExponential(3)}, ` +
        `last_active ${trafficUp && activeUp ? "更新" : "未更新"}`
    );
  }

  // 7. 汇总节点可达性
  console.log("\n节点可达性汇总：");
  for (const [name, ok] of nodeReachability.entries()) {
    console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  }

  const allNodesReachable = [...nodeReachability.values()].every(Boolean);
  const passed = allNodesReachable && nodeTrafficIncreased && userTrafficIncreased;
  console.log(`\n测试计划结果：${passed ? "✅ 通过" : "❌ 未通过"}`);

  // 8. 清理测试 token
  if (CLEANUP && adminKey) {
    log("清理测试 token...");
    for (const token of tokens) {
      await deleteToken(token.id);
    }
  } else if (CLEANUP && !adminKey) {
    log("未提供 ADMIN_KEY，跳过 token 清理");
  }

  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error("测试计划异常：", e.message);
  process.exit(1);
});
