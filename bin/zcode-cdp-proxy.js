#!/usr/bin/env node
// zcode-cdp-proxy — ZCode 多会话 CDP 端口池(lazy 版,本地中继架构)
//
// 作为 config.json 里 cdp 的 command。每个 ZCode 会话独立 spawn 一个本 proxy。
// proxy 全权持有 stdio(MCP JSON-RPC 通道),背后挂一个常驻 playwright-mcp:
//
// 架构(本地中继):
//   - 启动:在 127.0.0.1 随机端口开一个无状态 TCP 中继,spawn 唯一的
//     playwright-mcp,endpoint 永远指向中继 → backend 从生到死只起一次。
//   - 中继:纯字节管道,零解析。无 upstream(Chrome)时挂起新连接(带超时),
//     upstream 就绪后接通 —— 用连接挂起语义天然替代旧的 activation batch。
//   - proxy 是 JSON-RPC 观察者:见 browser_* 且无 Chrome → 异步 ensure
//     (reserve → cdp-takeover → 接通中继);browser_close 响应后 → teardown
//     (断中继、杀 Chrome、释放租约)。所有消息始终透传。
//   - 状态机:IDLE → ENSURING → ACTIVE → IDLE(+SHUTTING_DOWN/EXITED)。
//   - 依据:playwright-mcp 单实例在 browser_close 后可完全复用(实验证实),Chrome 起停/端口轮换对 backend 只是断线重连。
//
// 防护设计(勿删):
//   - 三层看门狗:软(事件循环 lag)/孤儿(业务心跳超时)/硬(worker 线程 SIGKILL)
//   - stdout/stderr 限流与 buf 上限、stdin inBuf 上限(防 O(n²) 与刷屏)
//   - 启动期同父进程去重(防 proxy 堆积)
//   - uncaughtException 纯同步退出(绝不写可能已坏的 stderr,防递归异常风暴)
//
// 端口池:9223-9229(7 个会话临时端口)。脚本 durable 端口使用 93xx,不进租约池。
// 租约:统一使用 zcode-cdp-lease.js 管理(原子 mkdir + leaseId ownership 校验)。

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const L = require("./zcode-cdp-lease.js");
const { createRelay } = require("./zcode-cdp-relay.js");

// ---- 可测试性:环境覆盖,生产默认不变 ----
// 解析 @playwright/mcp 的 cli.js 路径（优先 env，其次 require.resolve 自动发现）
function resolvePlaywrightMcpCli() {
  if (process.env.CDP_PLAYWRIGHT_MCP_CLI) return process.env.CDP_PLAYWRIGHT_MCP_CLI;
  try { return require.resolve("@playwright/mcp/cli.js"); } catch {}
  try { return require.resolve("@playwright/mcp/package.json").replace(/package\.json$/, "cli.js"); } catch {}
  // 兜底：npm global / mac Homebrew 常见路径
  const home = os.homedir();
  const candidates = [
    home + "/.npm-global/lib/node_modules/@playwright/mcp/cli.js",
    "/usr/local/lib/node_modules/@playwright/mcp/cli.js",
    "/usr/lib/node_modules/@playwright/mcp/cli.js",
  ];
  for (const p of candidates) { try { if (fs.readFileSync(p, "utf8")) return p; } catch {} }
  throw new Error(
    "未找到 @playwright/mcp。请 `npm install -g @playwright/mcp`，或设置 CDP_PLAYWRIGHT_MCP_CLI 指向其 cli.js"
  );
}
const CLI = resolvePlaywrightMcpCli();
// takeover 脚本与本 proxy 同目录（bin/cdp-takeover）
const TAKEOVER = process.env.CDP_TAKEOVER || path.join(__dirname, "cdp-takeover");
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.CDP_HEALTH_CHECK_MS || "5000", 10);
const RELAY_HOLD_MS = parseInt(process.env.CDP_RELAY_HOLD_MS || String(30 * 1000), 10); // 中继无 upstream 时挂起新连接的上限

// ---- 防护阈值(env 可覆盖) ----
const OUTPUT_RATE_LIMIT = parseInt(process.env.CDP_OUTPUT_RATE_LIMIT || "500", 10);   // backend stdout 行/秒(超限丢弃并告警)
const BUF_MAX_BYTES = parseInt(process.env.CDP_BUF_MAX_BYTES || String(2 * 1024 * 1024), 10); // stdout buf 上限 2MB
const STDERR_RATE_LIMIT = parseInt(process.env.CDP_STDERR_RATE_LIMIT || "200", 10);   // backend stderr 段/秒
const ORPHAN_TIMEOUT_MS = parseInt(process.env.CDP_ORPHAN_TIMEOUT_MS || String(30 * 60 * 1000), 10); // 孤儿超时 30min
const WATCHDOG_LAG_MS = parseInt(process.env.CDP_WATCHDOG_LAG_MS || "2000", 10);      // 事件循环延迟阈值
const WATCHDOG_TRIES = parseInt(process.env.CDP_WATCHDOG_TRIES || "3", 10);           // 连续触发次数
const HARD_KILL_MS = parseInt(process.env.CDP_HARD_KILL_MS || String(60 * 1000), 10); // 硬看门狗:worker 线程 60s 无心跳 → SIGKILL 自己(免疫 busy-loop)
const HARD_CPU_THRESHOLD = parseInt(process.env.CDP_HARD_CPU_THRESHOLD || "85", 10);  // 硬看门狗 CPU 检测:主进程 CPU% 超此值视为 busy-loop
const HARD_CPU_TRIES = parseInt(process.env.CDP_HARD_CPU_TRIES || "5", 10);           // 硬看门狗 CPU 检测:滑动窗口(2*N 次采样)内 ≥ N 次超阈值 → SIGKILL;容忍间歇 busy-loop 的间隙样本
const INBUF_MAX_BYTES = parseInt(process.env.CDP_INBUF_MAX_BYTES || String(2 * 1024 * 1024), 10); // stdin inBuf 上限 2MB(防无换行堆积)

// ---------------- 日志(全走 stderr,MCP 协议走 stdout) ----------------
// ⚠️ log() 必须 swallow write 错误:父进程退出后 stderr pipe 对端关闭,
// process.stderr.write 抛 EPIPE → 触发 uncaughtException → handler 里若再 log() 会
// 递归异常风暴。这里 try/catch 兜底,write 失败静默。
function log(...a) {
  try { process.stderr.write(`[cdp-proxy ${process.pid} ${hhmmss()}] ${a.join(" ")}\n`); } catch {}
}
function hhmmss() { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":"); }

// ==================== 状态机 ====================
// IDLE → ENSURING → ACTIVE → CLOSING → IDLE;(any) → SHUTTING_DOWN → EXITED
// CLOSING:browser_close 响应已返回、租约/中继正在释放的过渡窗口。
// 该窗口内到达的 browser_close 直接返回成功(浏览器确实在关闭),避免走真转发
// 路径触发 backend 重连 → 挂起连接 → 误"自动重新激活"。
const ST = {
  IDLE: "IDLE",
  ENSURING: "ENSURING",
  ACTIVE: "ACTIVE",
  CLOSING: "CLOSING",
  SHUTTING_DOWN: "SHUTTING_DOWN",
  EXITED: "EXITED",
};

let state = ST.IDLE;
let stateLock = Promise.resolve();
function serialize(fn) {
  const next = stateLock.then(() => fn());
  stateLock = next.catch(() => {});
  return next;
}

function setState(newState) {
  if (state === ST.EXITED || state === ST.SHUTTING_DOWN) return;
  log(`状态: ${state} → ${newState}`);
  state = newState;
}

// ==================== 本地 TCP 中继(bin/zcode-cdp-relay.js) ====================
// backend 的 endpoint 永远指向这里;Chrome 起停/端口轮换只改 upstream。
// 纯字节管道,零解析。无 upstream 时挂起新连接(带超时),attach 后接通;
// detach 销毁已接通管道(backend 侧 WS 断开,下次调用自动重连)。
const relay = createRelay({ holdMs: RELAY_HOLD_MS, log });

// ==================== backend(唯一常驻实例) ====================
let backend = null;      // { child }
let takeoverChild = null;
let lease = null;        // { port, leaseId }
let browserPid = null;
let closeRequestId = null; // 等待中的 browser_close 响应 id

function spawnBackend(endpoint) {
  // 不加 --isolated:该 flag 会让 backend 对接管 Chrome 自建隔离 BrowserContext,
  // 永不认领启动 NTP 标签,首次 navigate 必开第二个窗口(空窗口+新窗口双开)。
  // 去掉后 backend 用默认 context,配合 cdp-takeover 等启动标签就绪,原地导航。
  const args = [CLI, "--cdp-endpoint", endpoint, "--browser", "chrome"];
  const child = spawn("node", args, { stdio: ["pipe", "pipe", "pipe"] });
  log(`backend spawn: node ${CLI.split("/").pop()} → ${endpoint}(PID ${child.pid})`);
  // stderr 限流:防 playwright-mcp 刷屏淹没事件循环
  let stderrCount = 0, stderrWindow = Date.now(), stderrSuppressed = 0;
  child.stderr.on("data", d => {
    if (Date.now() - stderrWindow >= 1000) { stderrCount = 0; stderrWindow = Date.now(); }
    if (++stderrCount > STDERR_RATE_LIMIT) { stderrSuppressed++; return; }
    process.stderr.write(`[playwright-mcp] ${d}`);
  });
  child.on("error", err => {
    log(`backend spawn error: ${err.message}`);
    cleanupAndExit(1);
  });
  child.on("exit", (code, sig) => {
    // 唯一 backend 死亡 = proxy 失去服务能力(tools/list 也无法应答)→ 退出让 ZCode 重拉
    log(`backend 退出 code=${code} sig=${sig}(唯一实例,proxy 无法继续服务)`);
    cleanupAndExit(1);
  });
  return { child };
}

function forwardToBackend(line) {
  if (!backend || !backend.child || backend.child.stdin.destroyed || !backend.child.stdin.writable) {
    log("⚠️ 无可写 backend,丢弃消息:", line.slice(0, 120));
    return false;
  }
  try {
    backend.child.stdin.write(line + "\n");
    return true;
  } catch (e) {
    log("⚠️ forwardToBackend 写入失败:", e.message);
    return false;
  }
}

// 从 backend 读 JSON-RPC,按行切分后透传给 ZCode(stdout)
// 含 buf 上限保护(防 O(n²) 增长)+ stdout 行速率限流(超限丢弃本批剩余行并告警;
// 大 snapshot 是合法场景,不杀 backend —— CPU 异常由三层看门狗兜底)
function wireBackendOutput(b) {
  let buf = "";
  let outLines = 0, outWindow = Date.now();
  b.child.stdout.on("data", d => {
    buf += d.toString();
    if (buf.length > BUF_MAX_BYTES) {
      log(`⚠️ stdout buf 超 ${BUF_MAX_BYTES} bytes,截断到最后 64KB(可能是无换行大数据块)`);
      buf = buf.slice(-65536);
    }
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (Date.now() - outWindow >= 1000) { outLines = 0; outWindow = Date.now(); }
      if (++outLines > OUTPUT_RATE_LIMIT) {
        log(`⚠️ backend stdout 限流:${outLines} 行/秒,本批剩余行丢弃`);
        return;
      }
      if (line.trim()) handleBackendLine(line);
    }
  });
}

// 处理 backend 输出:拦截 browser_close response(先转发,再触发 teardown)
function handleBackendLine(line) {
  if (closeRequestId !== null) {
    let msg;
    try { msg = JSON.parse(line); } catch { /* 非 JSON,正常转发 */ }
    if (msg && msg.id === closeRequestId) {
      process.stdout.write(line + "\n");
      closeRequestId = null;
      serialize(() => teardown());
      return;
    }
  }
  process.stdout.write(line + "\n");
}

// ==================== ensure / teardown(Chrome 生命周期) ====================

// 异步确保接管 Chrome 在线:reserve → cdp-takeover → 接通中继 → ACTIVE
function ensure() {
  serialize(async () => {
    if (state !== ST.IDLE) return;
    if (state === ST.SHUTTING_DOWN || state === ST.EXITED) return;
    setState(ST.ENSURING);

    // 1. 领端口租约(kind 必须是进程命令行中的子串 → "zcode-cdp-proxy")
    const r = await L.reserve("zcode-cdp-proxy");
    if (!r) {
      log("❌ 端口池已满(7 个会话全在用)");
      setState(ST.IDLE);
      relay.failHeld();
      return;
    }
    lease = r;
    log(`领到端口 ${lease.port}(leaseId ${lease.leaseId.slice(0, 8)})`);

    if (state === ST.SHUTTING_DOWN || state === ST.EXITED) { await releaseLease(); return; }

    // 2. 起 Chrome(cdp-takeover managed 模式,幂等 + 重试)
    const ok = await startChrome(lease.port);
    if (!ok) {
      log(`❌ 端口 ${lease.port} 的 Chrome 起不来(见 cdp-takeover 输出)`);
      await releaseLease();
      setState(ST.IDLE);
      relay.failHeld();
      return;
    }
    if (state === ST.SHUTTING_DOWN || state === ST.EXITED) { await releaseLease(); return; }

    // 3. 记录 browser PID 到 lease + 接通中继
    const bp = L.portPid(lease.port);
    browserPid = bp ? parseInt(bp, 10) : null;
    if (lease) L.markActive(lease.port, lease.leaseId, browserPid);

    relay.attach(lease.port);
    setState(ST.ACTIVE);
    log(`✅ 激活完成 → 端口 ${lease.port}`);
  });
}

// 释放浏览器:断中继、释放租约(内含杀 Agent Chrome)、回 IDLE。
// teardown 完成时若中继仍有挂起连接(释放期间到达的新请求)→ 自动重新 ensure。
async function teardown() {
  closeRequestId = null;
  setState(ST.CLOSING);
  relay.detach();
  await releaseLease();
  setState(ST.IDLE);
  if (relay.hasHeld()) {
    log("teardown 完成但中继有挂起连接 → 自动重新激活");
    ensure();
  }
}

// Chrome 启动:cdp-takeover --managed --lease-id
async function startChrome(port) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (state === ST.SHUTTING_DOWN || state === ST.EXITED) return false;

    const code = await new Promise(resolve => {
      const args = [TAKEOVER, String(port)];
      if (lease) args.push("--managed", "--lease-id", lease.leaseId);
      takeoverChild = spawn("bash", args, { stdio: ["ignore", "pipe", "pipe"] });
      takeoverChild.stdout.on("data", d => process.stderr.write(`[cdp-takeover] ${d}`));
      takeoverChild.stderr.on("data", d => process.stderr.write(`[cdp-takeover] ${d}`));
      takeoverChild.on("error", err => { log(`takeover spawn error: ${err.message}`); resolve(-1); });
      takeoverChild.on("exit", resolve);
    });

    if (code === 0) { takeoverChild = null; break; }

    // 非零:Chrome 可能已在跑(幂等成功)或被全局锁挡(需重试)
    if (await L.portPid(port)) {
      log(`cdp-takeover 退码 ${code} 但端口已监听,视为成功`);
      takeoverChild = null;
      break;
    }
    if (attempt < 5) {
      log(`cdp-takeover 退码 ${code},等 ${attempt * 300}ms 重试(${attempt}/5)`);
      await L.sleep(attempt * 300);
    } else {
      log("cdp-takeover 5 次重试均失败");
      takeoverChild = null;
      return false;
    }
  }

  // 确认 Chrome 真起来了(等端口监听)
  for (let i = 0; i < 20; i++) {
    if (state === ST.SHUTTING_DOWN || state === ST.EXITED) return false;
    if (await L.portPid(port)) return true;
    await L.sleep(500);
  }
  return false;
}

// 释放当前 lease(杀 Agent Chrome + 删锁,核对 leaseId)
async function releaseLease() {
  stopTakeoverChild();
  if (lease) {
    await L.release(lease.port, lease.leaseId);
    log(`释放端口 ${lease.port}`);
    lease = null;
    browserPid = null;
  }
}

function stopTakeoverChild() {
  if (takeoverChild) {
    try { takeoverChild.kill("SIGTERM"); } catch {}
    takeoverChild = null;
  }
}

// ---- 健康检查(ACTIVE 状态,检测 Chrome 死亡/被替换;非 idle timeout) ----
let healthCheckTimer = null;
function startHealthCheck() {
  stopHealthCheck();
  healthCheckTimer = setInterval(() => {
    if (state !== ST.ACTIVE || !lease) return;
    serialize(async () => {
      if (state !== ST.ACTIVE || !lease) return;
      const listener = L.portPid(lease.port);
      if (!listener) {
        log(`⚠️ Chrome 在端口 ${lease.port} 上消失(listener gone)→ 回 IDLE`);
        await teardown();
      } else if (!L.isAgentChromePid(listener)) {
        log(`⚠️ 端口 ${lease.port} 的 listener 变成非 Agent Chrome → 释放租约回 IDLE(不杀非 Agent)`);
        await teardown();
      }
    });
  }, HEALTH_CHECK_INTERVAL_MS);
}
function stopHealthCheck() {
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
}

// ==================== CPU 看门狗 + 孤儿超时 ====================
// 看门狗:setInterval(1000) 实测回调间隔,连续 WATCHDOG_TRIES 次延迟 > WATCHDOG_LAG_MS
//          → 说明事件循环被淹没(正是 99% CPU 的症状)→ 自杀退出(ZCode 自动重拉新实例)
// 孤儿超时:超过 ORPHAN_TIMEOUT_MS 无真实 MCP 业务请求 → 判定为孤儿 proxy,退出
let watchdogTimer = null;
let orphanTimer = null;
// 业务活动时间戳:只有真实 MCP 业务请求(initialize/tools/list 等)才刷新。
// orphan 判定用此字段而非 stdin 心跳 —— 后者会被 zcode-cli 的 keepalive/
// progress 类 stdin 噪声刷新,导致孤儿超时永不触发(实测:30min 内只要有 1 字节 stdin
// 数据,孤儿就逃过)。用业务活动度作为"还活着"的证据,30min 无真实请求即判孤儿退出。
let lastBusinessTime = Date.now();
// MCP 业务方法白名单:这些才算"真实使用",其余(如 ping/progress/通知噪声)不刷新 lastBusinessTime
const BUSINESS_METHODS = /^(initialize$|notifications\/initialized$|tools\/|resources\/|prompts\/|ping$)/;

// ---- 硬看门狗(worker 线程,免疫主线程 busy-loop)----
// 为什么放 worker:主线程 busy-loop(同步死循环/长同步块)会完全阻塞事件循环,跑在
// 主线程的看门狗(setInterval)自己也被卡死,防线形同虚设。worker 有独立的事件循环
// 和 libuv 线程池,不受影响。worker 每 2s 检查主线程心跳,超过 HARD_KILL_MS 无新心跳
// → 直接 process.kill(SIGKILL) 主进程(不可拦截,绕过所有 async cleanup,确保必死)。
// 心跳机制:主线程在 stdin data + 每秒 setInterval 里 postMessage 更新心跳。
const { Worker } = require("worker_threads");
let hardWatchdogWorker = null;
let heartbeatTimer = null;

function startHardWatchdog() {
  stopHardWatchdog();
  // Worker 源码用内联 Blob,避免外部文件依赖
  // ⚠️ SIGKILL 目标 PID 由主线程 postMessage 传入,不用 process.ppid
  //    (ppid 在某些环境下指向 launchd PID 1,普通用户 EPERM,看门狗形同虚设)。
  //
  // ⚠️ 双路检测:第 1 路心跳只能抓"主线程完全卡死";"间歇 busy-loop"(反复陷入长
  //    同步块,块间间隙让 setInterval 补跑、心跳照常)永远不触发。第 2 路 worker
  //    自己 execSync('ps -p <pid> -o time=') 采样主进程 CPU 增量,完全绕过主线程
  //    事件循环。判定用滑动窗口(最近 2N 次采样 ≥ N 次超阈值),容忍间隙样本。
  const workerSrc = `
    const { parentPort } = require("worker_threads");
    const { execSync } = require("child_process");
    let lastHeartbeat = Date.now();
    let mainPid = 0;
    let killed = false;
    const HARD_KILL_MS = ${HARD_KILL_MS};
    const HARD_CPU_THRESHOLD = ${HARD_CPU_THRESHOLD};
    const HARD_CPU_TRIES = ${HARD_CPU_TRIES};
    let lastCpuTime = null;
    let lastWall = null;
    const cpuSamples = [];  // 滑动窗口:最近 HARD_CPU_TRIES * 2 次采样的 CPU%(bool: 是否超阈值)
    const CPU_WINDOW = HARD_CPU_TRIES * 2;  // 窗口大小:连续触发次数的 2 倍,容忍间歇
    function parseTime(s) {
      const parts = s.trim().split(":").map(parseFloat);
      if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
      if (parts.length === 2) return parts[0]*60 + parts[1];
      return parts[0];
    }
    parentPort.on("message", msg => {
      if (!msg) return;
      if (msg.type === "init") mainPid = msg.pid;
      else if (msg.type === "heartbeat") lastHeartbeat = msg.ts;
    });
    setInterval(() => {
      if (!mainPid || killed) return;
      // 第 1 路:心跳缺失(主线程完全卡死,setInterval 排不上)
      const lag = Date.now() - lastHeartbeat;
      if (lag > HARD_KILL_MS) {
        killed = true;
        try { process.kill(mainPid, "SIGKILL"); } catch {}
        return;
      }
      // 第 2 路:独立 CPU 检测(主线程间歇 busy-loop,setInterval 能补跑但 CPU 持续高)
      // execSync 跑在 worker 自己的 libuv 线程池,不受主线程同步块影响。
      try {
        const now = Date.now();
        const out = execSync("ps -p " + mainPid + " -o time=", { encoding: "utf8" });
        const curCpuTime = parseTime(out);
        if (lastCpuTime !== null && lastWall !== null) {
          const cpuDelta = curCpuTime - lastCpuTime;
          const wallDelta = (now - lastWall) / 1000;
          const cpuPct = wallDelta > 0 ? (cpuDelta / wallDelta) * 100 : 0;
          cpuSamples.push(cpuPct > HARD_CPU_THRESHOLD ? 1 : 0);
          if (cpuSamples.length > CPU_WINDOW) cpuSamples.shift();
          // 滑动窗口判定:窗口内 ≥ HARD_CPU_TRIES 次高 CPU → 触发
          const highCount = cpuSamples.reduce((a, b) => a + b, 0);
          if (cpuSamples.length >= HARD_CPU_TRIES && highCount >= HARD_CPU_TRIES) {
            killed = true;
            try { process.kill(mainPid, "SIGKILL"); } catch {}
          }
        }
        lastCpuTime = curCpuTime;
        lastWall = now;
      } catch (e) {}  // ps 失败(主进程已退等)忽略,不误杀
    }, 2000);
  `;
  try {
    hardWatchdogWorker = new Worker(workerSrc, { eval: true });
    // 把主进程 PID 交给 worker 作为 SIGKILL 目标
    hardWatchdogWorker.postMessage({ type: "init", pid: process.pid });
    hardWatchdogWorker.on("error", err => {
      process.stderr.write(`[cdp-proxy ${process.pid} ${hhmmss()}] ⚠️ 硬看门狗 worker 异常: ${err.message}\n`);
    });
  } catch (e) {
    // fail-loud:硬看门狗是唯一能补救主线程 busy-loop 的防线(前两层 setInterval 都跑
    // 在主线程,卡死时一起死)。启动失败还继续跑 = 裸奔。
    // 直接退出,客户端会立即重拉新实例,新实例大概率能正常起 worker。
    process.stderr.write(`[cdp-proxy ${process.pid} ${hhmmss()}] ⛔ 硬看门狗 worker 启动失败: ${e.message} → 退出重拉,避免裸奔\n`);
    process.exit(1);
  }

  // 心跳:每 1s 一次,正常时远低于 HARD_KILL_MS 阈值
  heartbeatTimer = setInterval(() => {
    if (hardWatchdogWorker) {
      try { hardWatchdogWorker.postMessage({ type: "heartbeat", ts: Date.now() }); } catch {}
    }
  }, 1000);
}

function beatHeartbeat() {
  // stdin data 时额外补一次心跳(高频 stdin 场景也保持鲜活)
  if (hardWatchdogWorker) {
    try { hardWatchdogWorker.postMessage({ type: "heartbeat", ts: Date.now() }); } catch {}
  }
}

function stopHardWatchdog() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (hardWatchdogWorker) {
    try { hardWatchdogWorker.terminate(); } catch {}
    hardWatchdogWorker = null;
  }
}

function startWatchdog() {
  stopWatchdog();
  let lastTick = Date.now();
  let lagCount = 0;
  watchdogTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - 1000;  // 预期 1000ms,超出部分即事件循环延迟
    lastTick = now;
    if (lag > WATCHDOG_LAG_MS) {
      lagCount++;
      log(`⚠️ 事件循环延迟 ${Math.round(lag)}ms (${lagCount}/${WATCHDOG_TRIES})`);
      if (lagCount >= WATCHDOG_TRIES) {
        // ⚠️ 同步退出,绝不调 async cleanupAndExit。
        // 间歇 busy-loop 场景(主线程反复陷入长同步块,块间有间隙):软看门狗会触发
        // (每次同步块产生墙钟延迟,累积到 WATCHDOG_TRIES 次就触发),但 cleanupAndExit
        // 内含 await releaseLease(),主线程下一秒又进同步块 → await 排不进 → 卡在
        // SHUTTING_DOWN,proxy 半死不活。改同步 process.exit 打破这个死结。
        // 资源清理交给 OS(Chrome/backend SIGTERM 由 exit hook 兜底),客户端会重拉新实例。
        log(`🔥 CPU 看门狗触发:事件循环连续 ${WATCHDOG_TRIES} 次延迟超 ${WATCHDOG_LAG_MS}ms → 同步强制退出(不走 async cleanup,避免间歇 busy-loop 卡死 cleanup)`);
        process.exit(99);
      }
    } else {
      lagCount = 0;
    }
  }, 1000);

  orphanTimer = setInterval(() => {
    // 用业务活动度(lastBusinessTime)而非 stdin 心跳:zcode-cli 周期发的 keepalive/
    // progress 噪声会刷新 stdin 活动让孤儿检测失效;只有真实 MCP 请求才证明
    // 本 proxy 还在被使用,30min 无真实业务 = 孤儿(被 zcode-cli spawn 后遗忘)
    if (Date.now() - lastBusinessTime > ORPHAN_TIMEOUT_MS) {
      log(`(${Math.round(ORPHAN_TIMEOUT_MS / 60000)}min 无真实 MCP 业务请求 → 判定为孤儿 proxy(被 zcode-cli 遗忘),退出)`);
      cleanupAndExit(0);
    }
  }, 60000);
}
function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (orphanTimer) { clearInterval(orphanTimer); orphanTimer = null; }
}

// ==================== 主 stdio:解析 ZCode → backend ====================
let inBuf = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", chunk => {
  beatHeartbeat(); // stdin 收到数据 → 刷新硬看门狗心跳
  inBuf += chunk;

  // inBuf 上限保护:超 INBUF_MAX_BYTES 截断到最后 64KB(防无换行大数据块无限增长 → O(n²) + OOM)
  if (inBuf.length > INBUF_MAX_BYTES) {
    log(`⚠️ stdin inBuf 超 ${INBUF_MAX_BYTES} bytes,截断到最后 64KB(可能是无换行大数据块)`);
    inBuf = inBuf.slice(-65536);
  }

  let idx;
  while ((idx = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, idx);
    inBuf = inBuf.slice(idx + 1);
    handleClientLine(line);
  }
});

process.stdin.on("end", () => {
  log("stdin EOF(ZCode 关闭)→ 退出清理");
  cleanupAndExit(0);
});
process.stdin.on("close", () => {
  log("stdin close → 退出清理");
  cleanupAndExit(0);
});

// 请求观察者:所有消息照常透传,仅观察 browser_* 触发生命周期。
// ensure 期间到达的请求不缓冲 —— 中继挂起语义保证它在 Chrome 就绪后自然流动。
function handleClientLine(line) {
  if (!line.trim()) return;
  let msg = null;
  try { msg = JSON.parse(line); } catch { log("⚠️ 非 JSON,丢弃:", line.slice(0, 120)); return; }

  // 业务活动度心跳:真实 MCP 业务方法才刷新 lastBusinessTime(用于 orphan 检测)
  if (msg && msg.method && BUSINESS_METHODS.test(msg.method)) {
    lastBusinessTime = Date.now();
  }

  const isBrowserCall = !!(msg && msg.method === "tools/call" && msg.params && typeof msg.params.name === "string" && msg.params.name.startsWith("browser_"));
  const isBrowserClose = isBrowserCall && msg.params.name === "browser_close";

  if (isBrowserClose && (state === ST.IDLE || state === ST.CLOSING)) {
    // dormant/关闭中 收到 browser_close:直接返回成功(已释放或正在释放),不启动 Chrome
    log("IDLE/CLOSING 收到 browser_close → 直接返回成功(无需启动 Chrome)");
    if (msg.id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "Browser already closed (no active CDP session)." }] },
      }) + "\n");
    }
    return;
  }
  if (isBrowserCall && !isBrowserClose && state === ST.IDLE) {
    // 首次 browser_ 调用 → 异步 ensure;请求照常转发(backend 连中继挂起,ensure 完成后流动)
    log("IDLE 收到 browser_* → 触发 ensure(异步)");
    ensure();
  }
  if (isBrowserClose && (state === ST.ACTIVE || state === ST.ENSURING)) {
    // browser_close:转发,记录请求 id 用于捕获响应后 teardown
    closeRequestId = msg.id !== undefined ? msg.id : null;
  }

  forwardToBackend(line);
}

// ==================== 启动期去重:同父进程下已有更早 proxy 实例 → 自己退出 ====================
// 根因:zcode-cli 在会话切换/重连时反复 spawn proxy 但不回收旧的,导致单 zcode-cli 名下
// 堆积 N 个 proxy 实例。proxy 的 stdin EOF / orphan 超时防线全部失效(父进程都活着、
// 周期发 stdin data)。本检测在启动期主动发现"我是某个 zcode-cli 名下的第 N 个"并让位给
// 最早那个,从源头斩断堆积。
//
// 按 PPID 隔离:不同 ZCode 窗口是不同 zcode-cli,PPID 不同,互不干扰。
function findOlderSiblingProxy() {
  const myPid = process.pid;
  const myPpid = process.ppid;
  const myStart = parseInt(L.pidStartTime(myPid) || "0", 10);
  if (!myPpid || !myStart) return null;

  let pids;
  try {
    // pgrep -f 列出所有 cmdline 含本脚本名的进程 PID
    pids = require("child_process")
      .execSync("pgrep -f zcode-cdp-proxy.js", { encoding: "utf8" })
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => parseInt(s, 10));
  } catch { return null; }  // pgrep 无匹配返回非零

  let older = null;
  for (const pid of pids) {
    if (pid === myPid) continue;
    // 取该 PID 的 PPID 和 CPU,用 ps -o 精确取(避免正则解析整行)
    let info;
    try {
      info = require("child_process")
        .execSync(`ps -o ppid=,pcpu= -p ${pid}`, { encoding: "utf8" })
        .trim().split(/\s+/);
    } catch { continue; }
    const ppid = parseInt(info[0], 10);
    const pcpu = parseFloat(info[1]);
    if (ppid !== myPpid) continue;  // 只管同一父进程(同一 zcode-cli 窗口)

    const sibStart = parseInt(L.pidStartTime(pid) || "0", 10);
    if (sibStart && sibStart < myStart) {
      // 找到更早的 sibling。优先记 CPU 异常的(>50% = busy-loop 嫌疑),
      // 这种 sibling 该被替换而不是让位 → 标记但继续找有没有正常的
      const rec = { pid, pcpu, start: sibStart, zombie: pcpu > 50 };
      if (!older || (older.zombie && !rec.zombie)) older = rec;  // 正常的优先于僵尸
      else if (!older.zombie && !rec.zombie && rec.start < older.start) older = rec;
      else if (older.zombie && rec.zombie && rec.pcpu > older.pcpu) older = rec;
    }
  }
  return older;
}

// ==================== 退出清理 ====================
let cleaning = false;
async function cleanupAndExit(code) {
  if (cleaning) return;
  cleaning = true;
  setState(ST.SHUTTING_DOWN);
  stopHealthCheck();
  stopWatchdog();
  stopHardWatchdog(); // 停硬看门狗(正常退出时不需要它再杀自己)

  try {
    // 停 takeover child
    stopTakeoverChild();

    // 断中继管道
    relay.stop();

    // 停 backend
    if (backend && backend.child) {
      try { backend.child.kill("SIGTERM"); } catch {}
    }

    // 释放 lease(杀 Chrome + 删锁,核对 leaseId)
    await releaseLease();
  } catch (e) {
    log("cleanup 异常: " + e.message);
  }

  setState(ST.EXITED);
  process.exit(code);
}

process.on("SIGTERM", () => cleanupAndExit(0));
process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGHUP", () => cleanupAndExit(0));
// ⚠️ uncaughtException / unhandledRejection 必须纯同步、绝不写 stderr、直接 process.exit。
// 父进程退出后 stderr pipe 对端关闭,任何 log() → process.stderr.write 抛 EPIPE → 触发
// 本 handler → handler 又调 log() → 无限递归异常风暴,V8 疯狂抓栈占满 CPU。
// 修复原则:handler 里只用 try/catch 包裹的同步操作,绝不 write 可能已坏的 stderr,直接 exit。
process.on("uncaughtException", () => {
  try { process.exit(1); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", () => {
  try { process.exit(1); } catch {}
  process.exit(1);
});

// exit hook:最后保险(同步,带 leaseId 校验)
process.on("exit", () => {
  if (lease) {
    // exit hook 里不能 async,尽力同步删锁(Chrome 已由 cleanupAndExit 处理)
    L.removeLockIfOwner(lease.port, lease.leaseId);
  }
});

// ==================== 启动 ====================
(async () => {
  log("启动 lazy CDP proxy(本地中继架构,IDLE = 0 端口 0 Chrome)");

  // 启动期回收孤儿
  const reaped = await L.reap();
  if (reaped.length) log(`🧹 回收 ${reaped.length} 个孤儿: ${JSON.stringify(reaped)}`);

  // 启动期去重:同父 zcode-cli 下已有更早 proxy 实例 → 自己退出,从源头防堆积
  const sib = findOlderSiblingProxy();
  if (sib) {
    if (sib.zombie) {
      // sibling 是 busy-loop 僵尸(>50% CPU) → 杀掉它,自己接管
      log(`🧟 检测到同父进程下有 busy-loop sibling PID=${sib.pid} (CPU=${sib.pcpu}%) → 杀掉僵尸,自己接管`);
      try { process.kill(sib.pid, "SIGKILL"); } catch {}
    } else {
      // sibling 正常 → 让位给最早那个,自己退出(此时还没 spawn 任何子进程/租约,直接退即可)
      log(`↩️ 检测到同父进程下已有更早 proxy 实例 PID=${sib.pid} → 自己退出避免堆积(多窗口 PPID 不同,不受影响)`);
      process.exit(0);
    }
  }

  // 开中继(随机端口)→ spawn 唯一常驻 backend(endpoint=中继)
  const relayPort = await relay.start();
  log(`中继监听 127.0.0.1:${relayPort}(无 upstream 时挂起,上限 ${RELAY_HOLD_MS}ms)`);

  backend = spawnBackend(`http://127.0.0.1:${relayPort}`);
  wireBackendOutput(backend);

  setState(ST.IDLE);
  startHealthCheck();
  startWatchdog();
  startHardWatchdog(); // 硬看门狗:worker 线程,免疫主线程 busy-loop
  log(`backend 常驻就绪(PID ${backend.child.pid}),IDLE,等待首个 browser_ 调用才激活`);
})();
