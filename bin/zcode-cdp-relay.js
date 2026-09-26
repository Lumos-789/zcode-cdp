#!/usr/bin/env node
// zcode-cdp-relay — 本地无状态 TCP 中继(relay 架构核心组件)
//
// backend(@playwright/mcp)的 endpoint 永远指向本中继;接管 Chrome 的起停与端口
// 轮换只发生在 upstream 侧,backend 无感知(对它只是断线重连)。
//
// 语义:
//   - 纯字节管道,零解析;每条 client 连接独立接 upstream(支持多条并发 WS)
//   - 无 upstream 时挂起新连接(不拒绝、不报错),attach(port) 后统一接通
//   - 挂起超 holdMs 的连接销毁(backend 将收到连接错误,对应 ensure 失败)
//   - detach() 销毁已接通管道与 connect 在途连接(backend 侧 WS 断开,下次调用自动重连);
//     挂起中的连接保留 —— teardown 期间到达的新请求靠它在新一轮 attach 后自然流动
//
// 用法:
//   const { createRelay } = require("./zcode-cdp-relay.js");
//   const relay = createRelay({ holdMs: 30000, log: console.error });
//   await relay.start();          // 127.0.0.1 随机端口
//   relay.attach(9223);           // upstream = Chrome 端口
//   relay.detach();               // 断开(挂起保留)
"use strict";

const net = require("net");

function createRelay({ holdMs = 30000, log = () => {} } = {}) {
  const relay = {
    server: null,
    port: null,
    upstreamPort: null,
    pending: new Map(),   // clientSocket -> { heldAt }(无 upstream,挂起中)
    pipes: new Set(),     // { client, upstream }(已接通)
    inFlight: new Set(),  // { client, upstream }(connect 已发起、connect 回调未派发)
    hkTimer: null,        // 挂起超时巡检

    start() {
      return new Promise((resolve, reject) => {
        relay.server = net.createServer(client => {
          client.setNoDelay(true);
          client.on("error", () => client.destroy());
          client.on("close", () => relay.pending.delete(client));
          if (relay.upstreamPort == null) {
            relay.pending.set(client, { heldAt: Date.now() });
          } else {
            relay.connect(client);
          }
        });
        relay.server.on("error", err => {
          // 监听失败必须直接落 stderr:proxy 对 start() 的 reject 走 unhandledRejection 静默 exit,不留原因无从排查
          process.stderr.write(`✖ zcode-cdp-relay 监听失败(127.0.0.1:${relay.port == null ? "随机端口" : relay.port}): ${(err && err.message) || err}\n`);
          reject(err);
        });
        relay.server.listen(0, "127.0.0.1", () => {
          relay.port = relay.server.address().port;
          relay.hkTimer = setInterval(() => {
            const now = Date.now();
            for (const [client, info] of relay.pending) {
              if (now - info.heldAt > holdMs) {
                log(`⚠️ 中继挂起连接超 ${holdMs}ms 无 upstream → 销毁(backend 将收到连接错误)`);
                client.destroy();
                relay.pending.delete(client);
              }
            }
          }, 1000);
          resolve(relay.port);
        });
      });
    },

    connect(client) {
      const upstream = net.connect(relay.upstreamPort, "127.0.0.1");
      const entry = { client, upstream };
      relay.inFlight.add(entry);
      upstream.on("connect", () => {
        relay.inFlight.delete(entry);
        relay.pipes.add(entry);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      const drop = () => {
        relay.inFlight.delete(entry);
        try { client.destroy(); } catch {}
        try { upstream.destroy(); } catch {}
        relay.pipes.delete(entry);
      };
      upstream.on("error", drop);
      upstream.on("close", () => { relay.inFlight.delete(entry); try { client.destroy(); } catch {} relay.pipes.delete(entry); });
      client.on("close", () => { relay.inFlight.delete(entry); try { upstream.destroy(); } catch {} relay.pipes.delete(entry); });
    },

    attach(port) {
      relay.upstreamPort = port;
      for (const [client] of relay.pending) {
        relay.pending.delete(client);
        relay.connect(client);
      }
    },

    detach() {
      relay.upstreamPort = null;
      for (const entry of relay.pipes) {
        try { entry.client.destroy(); } catch {}
        try { entry.upstream.destroy(); } catch {}
      }
      relay.pipes.clear();
      // inFlight 一并销毁:socket destroy 后 connect 回调不再派发,detach 之后旧 upstream 无从接通
      for (const entry of relay.inFlight) {
        try { entry.client.destroy(); } catch {}
        try { entry.upstream.destroy(); } catch {}
      }
      relay.inFlight.clear();
      // pending(挂起中)保留:teardown 期间到达的新请求在新一轮 attach 后自然流动
    },

    // ensure 失败:销毁挂起连接,让 backend 收到连接错误
    failHeld() {
      for (const [client] of relay.pending) {
        client.destroy();
        relay.pending.delete(client);
      }
    },

    hasHeld() { return relay.pending.size > 0; },

    stop() {
      relay.detach();
      relay.failHeld();
      if (relay.hkTimer) { clearInterval(relay.hkTimer); relay.hkTimer = null; }
      if (relay.server) { try { relay.server.close(); } catch {} relay.server = null; }
    },
  };
  return relay;
}

module.exports = { createRelay };
