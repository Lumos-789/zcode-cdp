#!/usr/bin/env node
// stub-backend — 假 @playwright/mcp(仅测试用)
// 行为契约:
//   - initialize → capabilities + serverInfo(name=stub-backend)
//   - notifications/initialized → 忽略(通知无响应)
//   - tools/list → browser_navigate / browser_close 两个工具
//   - tools/call → 成功,text = "stub ok: <tool>"
//   - 其他带 id 请求 → -32601
// 连接模拟(让 L2 覆盖 proxy 的中继路径):从 argv 解析 --cdp-endpoint 的端口,
// 收到 browser_* 调用时保持一条到该端口的 TCP 连接(真实 playwright 亦如此);
// 中继 detach 会断开它,下次调用重连 —— 连接建立(或挂起)后才回响应。
// 收到的 upstream 数据一律丢弃(stub 不说 CDP 协议)。
"use strict";

let relayPort = 0;
for (let i = 0; i < process.argv.length - 1; i++) {
  if (process.argv[i] === "--cdp-endpoint" && /:(\d+)$/.test(process.argv[i + 1] || "")) {
    relayPort = parseInt(process.argv[i + 1].split(":").pop(), 10);
  }
}

const net = require("net");
let conn = null;

function ensureConn() {
  return new Promise(resolve => {
    if (conn && !conn.destroyed) return resolve(true);
    if (!relayPort) return resolve(false);
    const t = setTimeout(() => resolve(false), 3000);
    try {
      conn = net.connect(relayPort, "127.0.0.1");
      conn.on("error", () => { conn = null; });
      conn.on("close", () => { conn = null; });
      conn.on("data", () => {}); // 丢弃 upstream 数据
      conn.once("connect", () => { clearTimeout(t); resolve(true); });
    } catch { clearTimeout(t); resolve(false); }
  });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", d => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

async function handle(msg) {
  if (msg.id === undefined || msg.id === null) return; // 通知,忽略
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "stub-backend", version: "0.0.1" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        tools: [
          { name: "browser_navigate", description: "stub", inputSchema: { type: "object" } },
          { name: "browser_close", description: "stub", inputSchema: { type: "object" } },
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    const name = msg.params && msg.params.name;
    if (name && name.startsWith("browser_")) await ensureConn(); // 模拟 playwright 的连接行为
    send({
      jsonrpc: "2.0", id: msg.id,
      result: { content: [{ type: "text", text: `stub ok: ${name}` }] },
    });
  } else if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no such method: ${msg.method}` } });
  }
}
