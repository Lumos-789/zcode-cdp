#!/usr/bin/env node
// stub-backend — 假 @playwright/mcp(仅测试用)
// 行为契约(与 zcode-cdp-proxy 的 synthetic 握手兼容):
//   - initialize → capabilities + serverInfo(name=stub-backend)
//   - notifications/initialized → 忽略(通知无响应)
//   - tools/list → browser_navigate / browser_close 两个工具
//   - tools/call → 成功,text = "stub ok: <tool>"
//   - 其他带 id 请求 → -32601
// 不连接 --cdp-endpoint(真实 playwright-mcp 会连,stub 无需)。
"use strict";

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

function handle(msg) {
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
