#!/usr/bin/env node
// L1.5 — zcode-cdp-relay(TCP 中继)单元回测
// 覆盖 spec 场景:无 upstream 挂起 / attach 接通转发 / detach 断管道 /
// 新 upstream 轮换 / failHeld 销毁 / 挂起超时。
// 本轮新增(F9):upstream 连接失败双侧 drop 不残留 / detach 销毁在途(connect 已
// 发起未派发)连接 / client socket error → destroy。
// 纯内存 TCP,随机端口,零依赖。
"use strict";

const net = require("net");
const { step, run, afterAll, assert, sleep, waitFor } = require("./lib/harness");

// ---- F9 测试装置:给 relay 模块注入可切换的 net.connect ----
// relay 在模块加载时捕获 net 引用 → 在 require relay 之前用 Module._load 把
// "net" 换成代理对象:createServer 等经原型链透传真 net,connect 可在测试中切换成
// 「永不完成的连接」。本测试文件自身的 net 在 hook 之前已 require,始终是真 net。
const realNet = net;
const fakeNet = Object.create(realNet);
let connectImpl = realNet.connect.bind(realNet);
fakeNet.connect = function (...args) { return connectImpl(...args); };
const Module = require("module");
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "net") return fakeNet;
  return origLoad.apply(this, arguments);
};
const { createRelay } = require("../bin/zcode-cdp-relay.js");
Module._load = origLoad; // hook 只作用于上面这一次 require

// 永不完成的 connect:返回未连接的真 Socket(connect 回调永不派发),记录之供断言
const neverSockets = [];
function installNeverConnect() {
  connectImpl = () => { const s = new realNet.Socket(); neverSockets.push(s); return s; };
}
function restoreConnect() { connectImpl = realNet.connect.bind(realNet); }

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

// ---- 以下为本轮新增(F9) ----

// 拿一个"确认已关闭"的端口:connect 必得 ECONNREFUSED
function closedPort() {
  return new Promise(resolve => {
    const srv = net.createServer(() => {});
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
// 建连并预挂 close 监听:断言"稍后被销毁"时不能等 connect 后才挂,会错过 close 事件
function connectWatched(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const closeP = closed(sock, 5000);
    sock.once("connect", () => resolve({ sock, closeP }));
    sock.once("error", reject);
  });
}

step("F9: upstream 连接失败(连已关闭端口)→ 双侧 drop,pipes/inFlight 无残留", async () => {
  const r = createRelay({ log: () => {} });
  await r.start();
  cleanups.push(() => r.stop());
  const deadPort = await closedPort();
  r.attach(deadPort); // attach 后新连接走 connect 路径 → 真连 deadPort → ECONNREFUSED
  // 注:ECONNREFUSED 毫秒级完成,inFlight 登记是瞬态不可轮询观测;双侧 drop 的
  // 行为证明 = client 侧被连带销毁 + 集合归零
  const { sock: c, closeP } = await connectWatched(r.port);
  assert.strictEqual(await closeP, true, "upstream 连接失败应连带销毁 client 侧(双侧 drop)");
  await waitFor(() => r.inFlight.size === 0 && r.pipes.size === 0, 3000, "inFlight/pipes cleaned after failure");
  assert.ok(!r.hasHeld(), "失败连接不得残留为挂起");
  // 失败不破坏 relay:随后 attach 正常 upstream,新连接照常双向转发
  const echo2 = await startEcho();
  cleanups.push(() => new Promise(res => echo2.server.close(res)));
  r.attach(echo2.port);
  const c2 = await connect(r.port);
  c2.write("still-alive");
  assert.strictEqual((await nextData(c2)).toString(), "still-alive", "relay 仍可正常接通");
  c.destroy();
  c2.destroy();
});

step("F9: detach 时在途(connect 已发起、回调未派发)upstream 连接被同步销毁", async () => {
  const r = createRelay({ log: () => {} });
  await r.start();
  cleanups.push(() => r.stop());
  installNeverConnect();
  try {
    r.attach(59999); // 端口号任意:connect 已被注入,不会真连
    const c = await connect(r.port); // 真 client → relay server
    await waitFor(() => r.inFlight.size === 1, 3000, "in-flight connection registered in inFlight");
    assert.strictEqual(r.pipes.size, 0, "connect 未派发前不得进 pipes");
    assert.ok(!r.hasHeld(), "attach 后不应有挂起连接");
    const closeP = closed(c, 3000); // 先挂 close 监听再 detach,防错过销毁事件
    r.detach();
    assert.strictEqual(r.inFlight.size, 0, "detach 应同步清空 inFlight");
    assert.strictEqual(await closeP, true, "在途连接的 client 侧应被 destroy");
    const up = neverSockets[neverSockets.length - 1];
    assert.ok(up && up.destroyed, "在途 upstream socket 应被同步 destroy(此后 connect 回调无从派发)");
    await sleep(300);
    assert.strictEqual(r.pipes.size, 0, "detach 后不得再出现已接通管道(旧 upstream 无从接通)");
  } finally {
    restoreConnect();
  }
});

step("F9: client socket error → destroy,不击穿进程且 pending 清出", async () => {
  const r = createRelay({ log: () => {} });
  await r.start();
  cleanups.push(() => r.stop());
  const c = await connect(r.port);
  await waitFor(() => r.hasHeld(), 3000, "connection held first");
  // 直接向 server 侧 socket 注入 error(确定性触发,不依赖 TCP RST 时序):
  // relay 未挂 error 处理器时 emit 会同步抛错 → 本 step FAIL;挂了则 destroy
  const serverSide = [...r.pending.keys()][0];
  assert.ok(serverSide, "server 侧 socket 应可从 pending 取到");
  serverSide.emit("error", new Error("injected client-side error"));
  assert.ok(serverSide.destroyed, "error 处理器应同步 destroy 该 socket");
  await waitFor(() => !r.hasHeld(), 3000, "destroyed socket cleaned out of pending");
  // 进程存活且 relay 继续可用
  const c2 = await connect(r.port);
  await waitFor(() => r.hasHeld(), 3000, "后续连接仍正常挂起");
  c.destroy();
  c2.destroy();
});

run();
