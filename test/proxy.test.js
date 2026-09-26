#!/usr/bin/env node
// L2 — zcode-cdp-proxy 状态机端到端回测(stub 化 backend + takeover,零真实 Chrome)
// 验证链路:placeholder 应答 → 首次 browser_ 激活(flush batch)→ browser_close
// 释放回 READY_IDLE → rearm 后非浏览器请求仍可应答(回归 #1: placeholder 重启补
// synthetic 握手)→ close 后 browser_ 重新激活(回归 #2: 缓冲请求重放)→ 退出清理。
//
// 本轮新增钉住的修复:
//   F4  启动期慢窗口(reap 被 stale 锁+顽固 listener 拖住)发 initialize/tools/list
//       → 入队 flush 后正常应答,不再静默丢弃(实例 B)
//   F3  stdout buf 超限截断后的残行绝不写进 stdout,其后完整行完好(实例 C)
//   F5  ensure 异常 → 回滚回 IDLE,下次 browser_* 可重试(实例 D)
//   F2  ENSURING 期间 lease 心跳刷新 owner.json.hbAt,ACTIVE 后冻结(实例 F)
//   F6  持租约时 stdout EPIPE 崩溃 → exit hook 兜底杀 listener + 删锁(实例 E)
//   F14 软看门狗:注入极小 lag 阈值 → 连续超限 → 同步 exit(99)+exit hook 杀 backend(实例 W1)
//       硬看门狗第 1 路:注入极小心跳缺失阈值 → worker 线程 SIGKILL 主进程+子进程(实例 W2);
//       第 2 路 CPU 滑窗检测需真实高 CPU 采样窗口,受机器负载影响无法确定性触发,不硬凑(见 W2 注释)
//   退出清理: 持租约 SIGTERM → 锁删 + stub listener(Agent Chrome 替身)被杀(实例 A)
//
// 环境隔离:CDP_LOCK_ROOT / CDP_PORTS 指向临时目录与 19xxx 随机端口,不碰生产
// 9223-9229/93xx 池;CDP_HEALTH_CHECK_MS 调大跳过健康检查(stub listener 非 Agent
// Chrome 语义,会被误判);CDP_WATCHDOG_LAG_MS 拉大屏蔽软看门狗(测试机高负载的
// 事件循环 lag 是环境噪声,不是被测行为,否则慢机偶发 exit(99) flake)。
//
// ⚠️ 实例必须串行生命周期:proxy 有同父进程去重(findOlderSiblingProxy),多个
// proxy 同时活在同一测试父进程下时后启动的会让位退出 → 每个实例在各自收尾 step
// 内 SIGTERM 并等待退出后才启动下一实例。
"use strict";

const { spawn, spawnSync, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { step, run, afterAll, assert, sleep, waitFor } = require("./lib/harness");

const REPO = path.join(__dirname, "..");
const PROXY = path.join(REPO, "bin", "zcode-cdp-proxy.js");

// ---- 端口隔离:19xxx 随机 + lsof 探活避让,绝不碰生产 9223-9229/93xx ----
function portListening(port) {
  try {
    execFileSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-P", "-n", "-t"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}
const usedPorts = new Set();
function pickPort() {
  for (let i = 0; i < 60; i++) {
    const cand = 19000 + Math.floor(Math.random() * 1000);
    if (!usedPorts.has(cand) && !portListening(cand)) { usedPorts.add(cand); return cand; }
  }
  throw new Error("19xxx 范围内找不到空闲端口");
}

function newCfg(label) {
  return {
    label,
    port: pickPort(),
    lockRoot: fs.mkdtempSync(path.join(os.tmpdir(), `cdptmp-lock-${label}-`)),
    artDir: fs.mkdtempSync(path.join(os.tmpdir(), `cdptmp-art-${label}-`)),
  };
}
const cfgA = newCfg("a"), cfgB = newCfg("b"), cfgC = newCfg("c"), cfgD = newCfg("d");
const cfgE = newCfg("e"), cfgF = newCfg("f");
const cfgW1 = newCfg("w1"), cfgW2 = newCfg("w2");
const lockDirOf = c => path.join(c.lockRoot, `${c.port}.lock`);
const ownerPathOf = c => path.join(lockDirOf(c), "owner.json");

function makeEnv(cfg, extra = {}) {
  return {
    ...process.env,
    CDP_LOCK_ROOT: cfg.lockRoot,
    CDP_PORTS: String(cfg.port),
    CDP_SCRIPT_PORTS: "19324",
    CDP_PLAYWRIGHT_MCP_CLI: path.join(REPO, "test", "lib", "stub-backend.js"),
    CDP_TAKEOVER: path.join(REPO, "test", "lib", "stub-takeover"),
    CDP_TEST_ARTIFACT_DIR: cfg.artDir,
    CDP_HEALTH_CHECK_MS: "3600000",
    CDP_ORPHAN_TIMEOUT_MS: "3600000",
    CDP_STARTUP_GRACE_MS: "2000",
    CDP_WATCHDOG_LAG_MS: "600000",
    ...extra,
  };
}

// ---- driver:JSON-RPC over stdio 的极简 MCP 客户端 ----
let seq = 0;
const instances = [];
function launchProxy(env) {
  const child = spawn("node", [PROXY], { env });
  let outBuf = "";
  let stderrText = "";
  const rawLines = []; // 整行缓冲:对 stdout 的所有断言统一在稳定后对累积完整行做,不按 chunk 切
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", d => {
    outBuf += d;
    let i;
    while ((i = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, i);
      outBuf = outBuf.slice(i + 1);
      if (!line.trim()) continue;
      rawLines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", d => { stderrText += d; process.stderr.write(`    [proxy] ${d}`); });
  const inst = {
    child,
    rawLines,
    stderr: () => stderrText,
    request(method, params, timeoutMs = 30000) {
      const id = `t${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout(${timeoutMs}ms) waiting response for ${method}`));
        }, timeoutMs);
        pending.set(id, msg => { clearTimeout(timer); pending.delete(id); resolve(msg); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); },
  };
  instances.push(inst);
  return inst;
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function killStubListener(cfg) {
  try {
    const pidFile = path.join(cfg.artDir, `listener-${cfg.port}.pid`);
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
      if (pidAlive(pid)) process.kill(pid, "SIGKILL");
    }
  } catch {}
}
async function stopInstance(inst) {
  if (inst.child.exitCode === null) {
    try { inst.child.kill("SIGTERM"); } catch {}
    try { await waitFor(() => inst.child.exitCode !== null, 5000, "instance exit"); }
    catch { try { inst.child.kill("SIGKILL"); } catch {} }
  }
}

const trapChildren = [];
const ALL_CFGS = [cfgA, cfgB, cfgC, cfgD, cfgE, cfgF, cfgW1, cfgW2];
afterAll(async () => {
  for (const inst of [...instances].reverse()) await stopInstance(inst);
  for (const c of ALL_CFGS) killStubListener(c);
  for (const t of trapChildren) { try { if (t.exitCode === null) t.kill("SIGKILL"); } catch {} }
});
// 每实例的目录清理单独注册:单个失败由 harness [TEARDOWN-ERROR] 报出且不影响其余
for (const c of ALL_CFGS) {
  afterAll(async () => {
    try { fs.chmodSync(c.lockRoot, 0o700); } catch {} // D 步骤 chmod 0500 中途失败时兜底恢复
    fs.rmSync(c.lockRoot, { recursive: true, force: true });
    fs.rmSync(c.artDir, { recursive: true, force: true });
  });
}

// ==================== 实例 A:原状态机生命周期回归链 ====================
let A = null;

step("A1 proxy 启动:backend 常驻就绪进入 IDLE", async () => {
  A = launchProxy(makeEnv(cfgA));
  await waitFor(() => A.stderr().includes("backend 常驻就绪"), 20000, "backend ready log");
  assert.strictEqual(A.child.exitCode, null, "proxy should stay alive");
});

step("A2 initialize → placeholder 应答", async () => {
  const res = await A.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "backtest", version: "0.0.1" },
  });
  assert.ok(res.result, JSON.stringify(res));
  assert.strictEqual(res.result.serverInfo.name, "stub-backend");
  A.notify("notifications/initialized");
});

step("A3 激活前 tools/list → placeholder 应答(0 Chrome 0 端口)", async () => {
  const res = await A.request("tools/list", {});
  assert.ok(res.result.tools.some(t => t.name === "browser_navigate"), JSON.stringify(res).slice(0, 120));
  assert.ok(!fs.existsSync(lockDirOf(cfgA)), "no lease should exist before activation");
});

step("A4 首次 browser_ 调用 → 激活(领端口→stub takeover→real backend flush)", async () => {
  const res = await A.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_navigate", JSON.stringify(res).slice(0, 200));
  await waitFor(() => fs.existsSync(ownerPathOf(cfgA)), 15000, "lease owner.json after activation");
});

step("A5 browser_close → 响应返回 + 释放回 READY_IDLE", async () => {
  const res = await A.request("tools/call", { name: "browser_close", arguments: {} });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_close");
  await waitFor(() => !fs.existsSync(lockDirOf(cfgA)), 15000, "lease released after browser_close");
});

step("A6 回归#1: close 后 tools/list 仍能应答(placeholder rearm 握手)", async () => {
  const res = await A.request("tools/list", {});
  assert.ok(res.result && res.result.tools, "placeholder should answer tools/list after rearm");
});

step("A7 IDLE/CLOSING 收到 browser_close → 直接成功响应(不起 Chrome)", async () => {
  const res = await A.request("tools/call", { name: "browser_close", arguments: {} });
  assert.ok(/already closed/i.test(res.result.content[0].text), JSON.stringify(res).slice(0, 200));
});

step("A8 回归#2: close 后再次 browser_ → 重新激活成功", async () => {
  const res = await A.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.org" } });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_navigate");
  await waitFor(() => fs.existsSync(ownerPathOf(cfgA)), 15000, "re-activation lease");
});

step("A9 激活后再走一轮 close 生命周期(稳定性)", async () => {
  const nav = await A.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.net" } });
  assert.strictEqual(nav.result.content[0].text, "stub ok: browser_navigate");
  const close = await A.request("tools/call", { name: "browser_close", arguments: {} });
  assert.strictEqual(close.result.content[0].text, "stub ok: browser_close");
  await waitFor(() => !fs.existsSync(lockDirOf(cfgA)), 15000, "lease released after second close");
});

step("A10 持有租约时 SIGTERM → 退出 + 锁清理 + stub listener(Agent Chrome 替身)被杀", async () => {
  const nav = await A.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
  assert.ok(nav.result, "should activate and hold a lease first");
  await waitFor(() => fs.existsSync(ownerPathOf(cfgA)), 15000, "lease held before SIGTERM");
  await waitFor(() => portListening(cfgA.port), 15000, "stub listener up before SIGTERM");
  const listenerPid = parseInt(fs.readFileSync(path.join(cfgA.artDir, `listener-${cfgA.port}.pid`), "utf8"), 10);
  assert.ok(pidAlive(listenerPid), "stub listener should be alive while lease held");
  A.child.kill("SIGTERM");
  await waitFor(() => A.child.exitCode !== null, 15000, "proxy exit after SIGTERM");
  assert.ok(!fs.existsSync(lockDirOf(cfgA)), "lock should be cleaned on exit");
  await waitFor(() => !pidAlive(listenerPid), 15000, "stub listener (Agent Chrome stand-in) killed via release path");
});

step("A11 回归#3: 全程 backend 只 spawn 一次(退出后对累积 stderr 整段计数)", async () => {
  const spawnLines = A.stderr().split("\n").filter(l => l.includes("backend spawn:"));
  assert.strictEqual(spawnLines.length, 1, `expected exactly 1 backend spawn, got ${spawnLines.length}:\n${spawnLines.join("\n")}`);
});

// ==================== 实例 B:F4 启动期排队 flush ====================
let B = null;

step("B1 F4: 启动期慢窗口发 initialize/tools/list → 排队 flush 后正常应答(不再丢)", async () => {
  // 构造 reap 慢窗口:stale 锁(owner 已死)+ 命令行含 chrome-takeover 的顽固
  // listener(SIGTERM 后拖延 2.5s 才退)→ proxy 启动期 reap 的 killAgentChrome
  // 等待窗口被拉长到 ~3s,backend 在此之后才赋值。
  const trapScript = path.join(cfgB.artDir, "chrome-takeover-trap-listener.js");
  fs.writeFileSync(trapScript, [
    '"use strict";',
    'const port = parseInt(process.argv[2], 10);',
    'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 2500));',
    'require("net").createServer(s => s.end()).listen(port, "127.0.0.1");',
    '',
  ].join("\n"));
  const dead = spawnSync("node", ["-e", "process.exit(0)"]);
  assert.ok(dead.pid, "dead pid for stale owner");
  fs.mkdirSync(lockDirOf(cfgB), { recursive: true });
  fs.writeFileSync(path.join(lockDirOf(cfgB), "owner.json"), JSON.stringify({
    version: 1, port: cfgB.port, kind: "zcode-cdp-proxy", leaseId: "stale-trap-lease",
    ownerPid: dead.pid, ownerStartTime: "", state: "active", browserPid: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  const trap = spawn("node", [trapScript, String(cfgB.port)], { stdio: "ignore" });
  trapChildren.push(trap);
  await waitFor(() => portListening(cfgB.port), 5000, "trap listener up");

  // backend 未就绪即发请求:旧代码在启动窗口直接丢弃 → initialize 永远无响应
  B = launchProxy(makeEnv(cfgB));
  const initPromise = B.request("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "backtest", version: "0.0.1" },
  }, 30000);
  const listPromise = B.request("tools/list", {}, 30000);
  B.notify("notifications/initialized"); // 与上面两请求同窗口排队,共 3 行
  const init = await initPromise;
  assert.ok(init.result, JSON.stringify(init).slice(0, 200));
  assert.strictEqual(init.result.serverInfo.name, "stub-backend");
  const list = await listPromise;
  assert.ok(list.result.tools.some(t => t.name === "browser_navigate"), JSON.stringify(list).slice(0, 200));
  assert.ok(
    B.stderr().includes("flush 启动期排队消息 3 行 → backend"),
    "queued startup-window lines must be flushed to backend (F4), stderr:\n" + B.stderr().slice(-800)
  );
});

step("B2 F4 后续: flush 后 browser_* 正常激活(启动窗口结束后生命周期不受影响)", async () => {
  const res = await B.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_navigate", JSON.stringify(res).slice(0, 200));
  await waitFor(() => fs.existsSync(ownerPathOf(cfgB)), 15000, "lease acquired after flush");
});

step("B3 F4 收尾: close 释放 + SIGTERM 退出(为后续实例让位,见文件头串行约束)", async () => {
  const res = await B.request("tools/call", { name: "browser_close", arguments: {} });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_close");
  await waitFor(() => !fs.existsSync(lockDirOf(cfgB)), 15000, "lease released");
  B.child.kill("SIGTERM");
  await waitFor(() => B.child.exitCode !== null, 15000, "instance B exit");
});

// ==================== 实例 C:F3 stdout buf 截断残行 ====================
let C = null;

step("C1 F3: buf 超限截断的残行绝不写进 stdout,其后完整行完好", async () => {
  // BUF 调小到 70000(必须 >64KB:截断保尾 slice(-65536) 才会真截掉头部置残行标记)
  // + backend 注入 10 万字节无换行走私数据:截断后切出的第一"行"是残行,旧代码会
  // 当完整行写 stdout → 客户端收到非法 JSON 且真实响应已丢。
  const bigBackend = path.join(cfgC.artDir, "bigline-backend.js");
  fs.writeFileSync(bigBackend, [
    '"use strict";',
    '// 测试专用 stub backend:initialize 正常应答;tools/call name=bigline 时先写',
    '// 100000 字节无换行数据(触发 proxy stdout buf 截断),随后写完整合法响应行。',
    'let buf = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", d => {',
    '  buf += d;',
    '  let i;',
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
    '    if (!line.trim()) continue;',
    '    let msg; try { msg = JSON.parse(line); } catch { continue; }',
    '    if (msg.id === undefined || msg.id === null) continue;',
    '    if (msg.method === "initialize") {',
    '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bigline-backend", version: "0.0.1" } } }) + "\\n");',
    '    } else if (msg.method === "tools/call" && msg.params && msg.params.name === "bigline") {',
    '      process.stdout.write("X".repeat(100000));',
    '      process.stdout.write("\\n" + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "bigline ok" }] } }) + "\\n");',
    '    } else {',
    '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo" }] } }) + "\\n");',
    '    }',
    '  }',
    '});',
    '',
  ].join("\n"));
  C = launchProxy(makeEnv(cfgC, { CDP_BUF_MAX_BYTES: "70000", CDP_PLAYWRIGHT_MCP_CLI: bigBackend }));
  await waitFor(() => C.stderr().includes("backend 常驻就绪"), 20000, "C backend ready");
  const init = await C.request("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "backtest", version: "0.0.1" },
  }, 30000);
  assert.strictEqual(init.result.serverInfo.name, "bigline-backend", JSON.stringify(init).slice(0, 200));

  const res = await C.request("tools/call", { name: "bigline", arguments: {} }, 30000);
  assert.strictEqual(res.result.content[0].text, "bigline ok", "truncation 之后的完整响应行必须完好送达");

  // 客户端收到的每一行都必须是合法 JSON:残行若泄漏(65536 字节的 X 尾巴)这里必炸
  assert.ok(C.rawLines.length >= 2, "should have received initialize + bigline responses");
  for (const line of C.rawLines) {
    let parseable = true;
    try { JSON.parse(line); } catch { parseable = false; }
    assert.ok(parseable, `client received non-JSON stdout line (${line.length} bytes): ${line.slice(0, 80)}...`);
  }
  assert.ok(C.stderr().includes("丢弃截断残行"), "dropped fragment must leave its stderr anchor");
});

step("C2 F3 收尾: SIGTERM 退出(串行约束)", async () => {
  C.child.kill("SIGTERM");
  await waitFor(() => C.child.exitCode !== null, 15000, "instance C exit");
});

// ==================== 实例 D:F5 ensure 失败回滚可重试 ====================
let D = null;

step("D1 F5: ensure 失败(锁根不可写)→ 回滚回 IDLE,下次 browser_* 可重试", async () => {
  // 锁根 chmod 0500:reserve 的原子 mkdir 得 EACCES → ensure 走整体 try/catch 的
  // 异常路径(修复前该异常会被 serialize 静默吞掉,state 永久卡 ENSURING)。
  fs.chmodSync(cfgD.lockRoot, 0o500);
  D = launchProxy(makeEnv(cfgD));
  await waitFor(() => D.stderr().includes("backend 常驻就绪"), 20000, "D backend ready");

  const nav1 = await D.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }, 30000);
  assert.ok(nav1.result, "backend 应答不受 ensure 失败影响(消息照常透传)");
  await waitFor(() => D.stderr().includes("❌ ensure 异常"), 15000, "ensure rollback log anchor");
  assert.ok(!fs.existsSync(lockDirOf(cfgD)), "失败路径不得残留锁目录");

  // 回 IDLE 的行为证明:恢复可写后同一会话内再次 browser_* 能重新走完整激活
  fs.chmodSync(cfgD.lockRoot, 0o700);
  const nav2 = await D.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.org" } }, 30000);
  assert.strictEqual(nav2.result.content[0].text, "stub ok: browser_navigate", JSON.stringify(nav2).slice(0, 200));
  await waitFor(() => fs.existsSync(ownerPathOf(cfgD)), 15000, "retry acquires lease (state really back to IDLE)");
  // owner.json(reserve 完成)早于激活完成(startChrome 需 ~1s),用轮询防竞态
  await waitFor(() => D.stderr().includes("✅ 激活完成"), 15000, "retry should complete activation");
});

step("D2 F5 收尾: close 释放 + SIGTERM 退出", async () => {
  const res = await D.request("tools/call", { name: "browser_close", arguments: {} });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_close");
  await waitFor(() => !fs.existsSync(lockDirOf(cfgD)), 15000, "lease released");
  D.child.kill("SIGTERM");
  await waitFor(() => D.child.exitCode !== null, 15000, "instance D exit");
});

// ==================== 实例 E:F6 exit hook 崩溃路径兜底清理 ====================
let E = null;

step("E1 F6: 持租约时 stdout EPIPE 崩溃 → exit hook 兜底杀 listener + 删锁", async () => {
  // cleanupAndExit 覆盖不到的纯同步退出路径(uncaughtException 的 exit(1)):
  // 关闭本侧 stdout 读端 → proxy 下一次写 stdout 得 EPIPE → uncaughtException →
  // exit(1) → exit hook 同步兜底(SIGKILL takeoverChild/SIGTERM backend/杀本租约
  // 端口的 Agent Chrome 替身/删锁)。锁删 Chrome 活 = durable 永久占端口,必须钉住。
  E = launchProxy(makeEnv(cfgE));
  await waitFor(() => E.stderr().includes("backend 常驻就绪"), 20000, "E backend ready");
  const nav = await E.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }, 30000);
  assert.ok(nav.result, "activate and hold a lease first");
  await waitFor(() => fs.existsSync(ownerPathOf(cfgE)), 15000, "lease held before crash");
  await waitFor(() => portListening(cfgE.port), 15000, "stub listener up before crash");
  const listenerPid = parseInt(fs.readFileSync(path.join(cfgE.artDir, `listener-${cfgE.port}.pid`), "utf8"), 10);
  assert.ok(pidAlive(listenerPid), "stub listener should be alive while lease held");
  E.child.stdout.destroy(); // 本侧读端关闭,proxy 下次写 stdout 必 EPIPE
  // 触发一次 stdout 写(tools/list 的响应),不等其 promise
  E.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "e2", method: "tools/list", params: {} }) + "\n");
  await waitFor(() => E.child.exitCode !== null, 15000, "proxy exits via EPIPE crash path");
  assert.strictEqual(E.child.exitCode, 1, "uncaughtException 路径应 exit(1)");
  assert.ok(!fs.existsSync(lockDirOf(cfgE)), "exit hook 应兜底删锁");
  await waitFor(() => !pidAlive(listenerPid), 15000, "exit hook 应兜底杀 Agent Chrome 替身");
});

// ==================== 实例 F:F2 ENSURING 期间 lease 心跳 ====================
let F = null;

// owner.json 可能正被 proxy 的心跳写(writeFileSync 无原子性保证),读侧重试防撕裂
async function readOwnerSafe(ownerPath) {
  for (let i = 0; i < 5; i++) {
    try { return JSON.parse(fs.readFileSync(ownerPath, "utf8")); } catch {}
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error("owner.json 读取持续失败: " + ownerPath);
}

step("F1 F2: ENSURING 期间 lease 心跳递增 hbAt,ACTIVE 后冻结", async () => {
  // 慢 takeover(先拖 2s 再起 listener)拉长 ENSURING 窗口;listener 文件名含
  // chrome-takeover 以命中 Agent Chrome 判定,close 释放链路可杀
  const slowListener = path.join(cfgF.artDir, "chrome-takeover-slow-listener.js");
  fs.writeFileSync(slowListener, [
    '"use strict";',
    'const port = parseInt(process.argv[2], 10);',
    'require("net").createServer(s => s.end()).listen(port, "127.0.0.1");',
    '',
  ].join("\n"));
  const slowTakeover = path.join(cfgF.artDir, "slow-takeover"); // startChrome 用 bash 起,必须 bash 脚本
  fs.writeFileSync(slowTakeover, [
    '#!/bin/bash',
    '# 测试专用慢 cdp-takeover:延迟 2s 起 listener,拉长 proxy 的 ENSURING 窗口',
    'set -euo pipefail',
    'PORT="${1:?missing port}"',
    'ART_DIR="${CDP_TEST_ARTIFACT_DIR:-/tmp/zcode-cdp-test}"',
    'mkdir -p "$ART_DIR"',
    'sleep 2',
    `nohup node "${slowListener}" "$PORT" >/dev/null 2>&1 &`,
    'echo $! > "$ART_DIR/listener-$PORT.pid"',
    'for _ in $(seq 1 15); do',
    '  if lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then echo "slow-takeover: listening on $PORT"; exit 0; fi',
    '  sleep 1',
    'done',
    'echo "slow-takeover: never came up" >&2; exit 1',
    '',
  ].join("\n"));
  fs.chmodSync(slowTakeover, 0o755);

  F = launchProxy(makeEnv(cfgF, { CDP_LEASE_HB_MS: "300", CDP_TAKEOVER: slowTakeover }));
  await waitFor(() => F.stderr().includes("backend 常驻就绪"), 20000, "F backend ready");
  const navPromise = F.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }, 30000);
  await waitFor(() => fs.existsSync(ownerPathOf(cfgF)), 15000, "lease acquired (ENSURING starts)");
  await sleep(700); // ≥2 个心跳周期
  const hb1 = (await readOwnerSafe(ownerPathOf(cfgF))).hbAt;
  assert.ok(typeof hb1 === "number" && hb1 > 0, "ENSURING 期间 owner.json 应有 hbAt 心跳(F2)");
  await sleep(700);
  const hb2 = (await readOwnerSafe(ownerPathOf(cfgF))).hbAt;
  assert.ok(typeof hb2 === "number" && hb2 > hb1, `hbAt 应在 ENSURING 期间递增(${hb1} → ${hb2})`);
  const nav = await navPromise;
  assert.strictEqual(nav.result.content[0].text, "stub ok: browser_navigate");
  await waitFor(() => F.stderr().includes("✅ 激活完成"), 15000, "activation completes");
  await sleep(800);
  const hb3 = (await readOwnerSafe(ownerPathOf(cfgF))).hbAt;
  await sleep(800);
  const hb4 = (await readOwnerSafe(ownerPathOf(cfgF))).hbAt;
  assert.strictEqual(hb3, hb4, "ACTIVE 后心跳应停止(hbAt 冻结)");
});

step("F2 F2 收尾: close 释放 + SIGTERM 退出", async () => {
  const res = await F.request("tools/call", { name: "browser_close", arguments: {} });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_close");
  await waitFor(() => !fs.existsSync(lockDirOf(cfgF)), 15000, "lease released");
  F.child.kill("SIGTERM");
  await waitFor(() => F.child.exitCode !== null, 15000, "instance F exit");
});

// ==================== 实例 W1/W2:看门狗触发路径(F14) ====================
// 确定性注入而非伪造压力:软看门狗 lag = tick 实测间隔 - 1000ms ≥ 0 恒成立,
// 阈值取 -1 + 连续 1 次即必触发;生产判定式(连续 N 次超阈值)不变,只压缩参数。
let W1 = null, W2 = null;

function backendPidOf(inst) {
  const m = /backend 常驻就绪\(PID (\d+)\)/.exec(inst.stderr());
  return m ? parseInt(m[1], 10) : null;
}

step("W1 F14 软看门狗: 注入极小 lag 阈值 → tick 延迟连续超限 → 同步 exit(99),exit hook 杀 backend", async () => {
  W1 = launchProxy(makeEnv(cfgW1, { CDP_WATCHDOG_LAG_MS: "-1", CDP_WATCHDOG_TRIES: "1" }));
  await waitFor(() => W1.child.exitCode !== null, 20000, "soft watchdog exit(99)");
  assert.strictEqual(W1.child.exitCode, 99,
    `软看门狗应以 99 同步退出,实际 code=${W1.child.exitCode} signal=${W1.child.signalCode}`);
  assert.ok(/看门狗触发/.test(W1.stderr()), W1.stderr());
  // exit(99) 不走 async cleanup;exit hook 须同步杀掉受管 backend(否则泄漏 node 进程)
  const backendPid = backendPidOf(W1);
  assert.ok(backendPid, "启动日志应含 backend PID");
  await waitFor(() => !pidAlive(backendPid), 5000, "backend killed by exit hook");
});

step("W2 F14 硬看门狗第 1 路: 注入极小心跳缺失阈值 → worker 线程 SIGKILL 主进程,受管 backend 一并击杀", async () => {
  // 确定性注入:心跳经 postMessage 从主线程到 worker 处理必有 ≥0ms 时延,worker
  // tick 时 lag = now - 最近心跳 ts ≥ 0 恒成立,阈值 -1 即必触发(第 1 tick ≈ +2s)。
  // 第 2 路 CPU 滑窗检测:需主进程真实持续高 CPU 才能凑满采样窗口,结果取决于机器
  // 负载与其他进程干扰,测试中无法确定性触发,不硬凑(判定代码路径与第 1 路同汇
  // 于 killChildren + SIGKILL,第 1 路已钉住击杀语义)。
  W2 = launchProxy(makeEnv(cfgW2, { CDP_HARD_KILL_MS: "-1" }));
  await waitFor(() => W2.child.exitCode !== null || W2.child.signalCode !== null, 20000, "hard watchdog SIGKILL");
  assert.strictEqual(W2.child.signalCode, "SIGKILL",
    `硬看门狗 worker 应 SIGKILL 主进程,实际 code=${W2.child.exitCode} signal=${W2.child.signalCode}`);
  // worker 击杀前先 killChildren():受管 backend 不得存活泄漏
  const backendPid = backendPidOf(W2);
  assert.ok(backendPid, "启动日志应含 backend PID");
  await waitFor(() => !pidAlive(backendPid), 5000, "backend killed by hard watchdog killChildren");
});

run();
