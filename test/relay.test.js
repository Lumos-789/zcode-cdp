#!/usr/bin/env node
// L1.5 — zcode-cdp-relay(TCP 中继)单元回测
// 覆盖 spec 场景:无 upstream 挂起 / attach 接通转发 / detach 断管道 /
// 新 upstream 轮换 / failHeld 销毁 / 挂起超时。纯内存 TCP,零依赖。
"use strict";

const net = require("net");
const { step, run, afterAll, assert, sleep } = require("./lib/harness");
const { createRelay } = require("../bin/zcode-cdp-relay.js");

// 起一个 echo server 模拟 Chrome(upstream)
function startEcho() {
  return new Promise(resolve => {
    const server = net.createServer(s => s.on("data", d => s.write(d)));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
// 起一个"接收即关"的 server,用于模拟 Chrome 换端口后的新实例
function startSink() {
  return new Promise(resolve => {
    const server = net.createServer(s => s.on("data", () => { try { s.end(); } catch {} }));
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const cleanups = [];
async function freshRelay(opts = {}) {
  const relay = createRelay({ log: () => {}, ...opts });
  await relay.start();
  cleanups.push(() => relay.stop());
  return relay;
}
function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}
const nextData = (sock, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("no data within " + ms + "ms")), ms);
  sock.once("data", d => { clearTimeout(t); resolve(d); });
});
const closed = (sock, ms = 3000) => new Promise(resolve => {
  const t = setTimeout(resolve, ms); // 超时=未关闭
  sock.once("close", () => { clearTimeout(t); resolve(true); });
});

afterAll(async () => {
  for (const fn of cleanups) { try { await fn(); } catch {} }
});

let relay, echo, sink, c1;

step("无 upstream 时新连接挂起(不拒绝、不断开)", async () => {
  relay = await freshRelay();
  assert.ok(relay.port > 0, "relay should listen on a random port");
  c1 = await connect(relay.port);
  // server 侧 connection 回调与 client connect 事件存在调度竞态,轮询等待挂起登记
  for (let i = 0; i < 20 && !relay.hasHeld(); i++) await sleep(50);
  assert.strictEqual(relay.hasHeld(), true, "connection should be held");
  await sleep(400);
  assert.ok(!c1.destroyed, "held socket must stay open");
});

step("attach 后挂起连接接通并可双向转发", async () => {
  echo = await startEcho(); cleanups.push(() => new Promise(r => echo.server.close(r)));
  relay.attach(echo.port);
  await sleep(200);
  assert.strictEqual(relay.hasHeld(), false, "held connection should be wired");
  c1.write("ping");
  const back = await nextData(c1);
  assert.strictEqual(back.toString(), "ping", "echo through relay");
});

step("attach 后的新连接直接接通", async () => {
  const c2 = await connect(relay.port);
  await sleep(100);
  c2.write("hello");
  const back = await nextData(c2);
  assert.strictEqual(back.toString(), "hello");
  c2.destroy();
});

step("detach 断开已接通管道,后续新连接重新挂起", async () => {
  relay.detach();
  assert.strictEqual(await closed(c1), true, "wired socket should be closed by detach");
  const c3 = await connect(relay.port);
  await sleep(200);
  assert.strictEqual(relay.hasHeld(), true, "new connection held again after detach");
  c3.destroy();
  relay.failHeld();
});

step("detach 后 attach 新端口:新连接走新 upstream(端口轮换)", async () => {
  sink = await startSink(); cleanups.push(() => new Promise(r => sink.server.close(r)));
  relay.attach(sink.port);
  const c4 = await connect(relay.port);
  await sleep(100);
  assert.strictEqual(relay.hasHeld(), false);
  c4.write("x"); // sink 收到即 end → client 侧收到 FIN
  assert.strictEqual(await closed(c4), true, "traffic reached the NEW upstream (sink closes)");
});

step("failHeld 销毁挂起连接", async () => {
  relay.detach();
  const c5 = await connect(relay.port);
  await sleep(150);
  assert.strictEqual(relay.hasHeld(), true);
  relay.failHeld();
  assert.strictEqual(await closed(c5), true, "held socket destroyed by failHeld");
});

step("挂起超时:超 holdMs 的连接被销毁", async () => {
  const shortRelay = await freshRelay({ holdMs: 300 });
  const c6 = await connect(shortRelay.port);
  const closeP = closed(c6, 2500); // 先挂监听再等销毁发生,避免错过 close 事件
  await sleep(1500);
  assert.strictEqual(await closeP, true, "held socket destroyed after holdMs");
  assert.strictEqual(shortRelay.hasHeld(), false);
});

step("stop() 全量清理", async () => {
  const r2 = createRelay({ log: () => {} });
  await r2.start();
  const c7 = await connect(r2.port);
  r2.stop();
  assert.strictEqual(await closed(c7), true, "held socket destroyed by stop()");
});

run();
