#!/usr/bin/env node
/**
 * 测试 Clash 订阅文件是否可访问，并逐个验证节点连通性。
 * 用法：node test-sub.mjs <uuid>
 */

const uuid = process.argv[2];
if (!uuid) {
  console.error("Usage: node test-sub.mjs <uuid>");
  process.exit(1);
}

const SUB_URL = `https://fastergamer.cn/api/sub?uuid=${encodeURIComponent(uuid)}`;

async function fetchSub() {
  console.log(`Fetching subscription: ${SUB_URL}`);
  const res = await fetch(SUB_URL);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const text = await res.text();
  console.log(`OK, ${text.length} bytes\n`);
  return text;
}

function parseProxies(yaml) {
  const proxies = [];
  const lines = yaml.split("\n");
  let current = null;
  let inProxies = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
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
    }, 10000);

    ws.onopen = () => {
      const header = buildVlessHeader(proxy.uuid);
      ws.send(header);
      ws.send(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n"));
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

    ws.onerror = (err) => { console.log("[dbg] error", err.message);
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || "websocket error" });
    };
  });
}

async function main() {
  try {
    const yaml = await fetchSub();
    const proxies = parseProxies(yaml);
    console.log(`Found ${proxies.length} proxy node(s):`);
    for (const p of proxies) {
      console.log(`  - ${p.name} (${p.server}:${p.port}, tls=${p.tls})`);
    }
    console.log();

    for (const p of proxies) {
      process.stdout.write(`Testing ${p.name} ... `);
      const result = await testProxy(p);
      if (result.ok) {
        console.log(`✅ OK (${result.preview}...)`);
      } else {
        console.log(`❌ FAIL: ${result.error}`);
      }
    }
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

main();
