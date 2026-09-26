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
//   - uncaughtException 纯同步退出(不裸写可能已坏的 stderr,防递归异常风暴)
//   - 日志 stderr+文件双写、子进程进程组管理、父进程监控(排查现场/防孤儿进程)
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
// env 整数解析 fail-loud:非法值静默落 NaN 后,所有阈值比较(> NaN / Date.now()-t > NaN)
// 恒 false,看门狗/限流/截断防线全体无声失效 → 拒绝启动
function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    process.stderr.write(`[cdp-proxy] ⛔ 环境变量 ${name}="${raw}" 不是合法整数 → 拒绝启动\n`);
    process.exit(1);
  }
  return n;
}

// 解析 @playwright/mcp 的 cli.js 路径（优先 env，其次 require.resolve 自动发现）
// ⚠️ 该包 package.json 有 exports 限制,require.resolve("@playwright/mcp/cli.js") 必抛,
//    必须先解析包根再拼 cli.js;多级尝试逐级 try,全失败才报错
function resolvePlaywrightMcpCli() {
  if (process.env.CDP_PLAYWRIGHT_MCP_CLI) return process.env.CDP_PLAYWRIGHT_MCP_CLI;
  try {
    const cli = path.join(path.dirname(require.resolve("@playwright/mcp")), "cli.js");
    if (fs.existsSync(cli)) return cli;
  } catch {}
  try {
    const cli = require.resolve("@playwright/mcp/package.json").replace(/package\.json$/, "cli.js");
    if (fs.existsSync(cli)) return cli;
  } catch {}
  try { return require.resolve("@playwright/mcp/cli.js"); } catch {}
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
const HEALTH_CHECK_INTERVAL_MS = envInt("CDP_HEALTH_CHECK_MS", 5000);
const RELAY_HOLD_MS = envInt("CDP_RELAY_HOLD_MS", 30 * 1000); // 中继无 upstream 时挂起新连接的上限
const CHILD_TERM_GRACE_MS = envInt("CDP_CHILD_TERM_GRACE_MS", 2000); // 受管子进程 SIGTERM 宽限,超时升级 SIGKILL 进程组(见 stopChild)
const PARENT_CHECK_INTERVAL_MS = envInt("CDP_PARENT_CHECK_MS", 5000); // 父进程存活性检查间隔(见 startParentMonitor)

// ---- 防护阈值(env 可覆盖) ----
const OUTPUT_RATE_LIMIT = envInt("CDP_OUTPUT_RATE_LIMIT", 500);   // backend stdout 行/秒(超限延迟并告警)
const BUF_MAX_BYTES = envInt("CDP_BUF_MAX_BYTES", 2 * 1024 * 1024); // stdout buf 上限 2MB
const STDERR_RATE_LIMIT = envInt("CDP_STDERR_RATE_LIMIT", 200);   // backend stderr 段/秒
const ORPHAN_TIMEOUT_MS = envInt("CDP_ORPHAN_TIMEOUT_MS", 30 * 60 * 1000); // 孤儿超时 30min
const WATCHDOG_LAG_MS = envInt("CDP_WATCHDOG_LAG_MS", 2000);      // 事件循环延迟阈值
const WATCHDOG_TRIES = envInt("CDP_WATCHDOG_TRIES", 3);           // 连续触发次数
const HARD_KILL_MS = envInt("CDP_HARD_KILL_MS", 60 * 1000); // 硬看门狗:worker 线程 60s 无心跳 → SIGKILL 自己(免疫 busy-loop)
const HARD_CPU_THRESHOLD = envInt("CDP_HARD_CPU_THRESHOLD", 85);  // 硬看门狗 CPU 检测:主进程 CPU% 超此值视为 busy-loop
const HARD_CPU_TRIES = envInt("CDP_HARD_CPU_TRIES", 5);           // 硬看门狗 CPU 检测:滑动窗口(2*N 次采样)内 ≥ N 次超阈值 → SIGKILL;容忍间歇 busy-loop 的间隙样本
const INBUF_MAX_BYTES = envInt("CDP_INBUF_MAX_BYTES", 2 * 1024 * 1024); // stdin inBuf 上限 2MB(防无换行堆积)
const LEASE_HB_MS = envInt("CDP_LEASE_HB_MS", 5000);              // ENSURING 期间 lease 心跳间隔(见 startLeaseHb)
const METRICS_SUMMARY_INTERVAL_MS = envInt("CDP_METRICS_SUMMARY_MS", 5 * 60 * 1000); // metrics 周期汇总间隔(见 startMetricsSummary)

// ---------------- 日志(stderr + 文件双写,MCP 协议走 stdout) ----------------
// ⚠️ log() 必须 swallow write 错误:父进程退出后 stderr pipe 对端关闭,
// process.stderr.write 抛 EPIPE → 触发 uncaughtException → handler 里若再 log() 会
// 递归异常风暴。这里 try/catch 兜底,write 失败静默。
//
// 文件双写:客户端不转发 MCP server 的 stderr,proxy 的 stderr 日志实际蒸发 ——
// 「工具路由持续故障」排查时零现场。所有日志同时 append 到
// ~/.zcode/v2/logs/cdp-proxy-<日期>.log。env CDP_PROXY_LOG_FILE 覆盖路径,off/0/false 关闭。
// 文件写入同样 try/catch 静默:日志路径坏/磁盘满绝不能影响 proxy 本体。
const LOG_FILE = (() => {
  const env = process.env.CDP_PROXY_LOG_FILE;
  if (env === "off" || env === "0" || env === "false") return null;
  if (env) return env;
  try {
    const dir = path.join(os.homedir(), ".zcode", "v2", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return path.join(dir, `cdp-proxy-${date}.log`);
  } catch { return null; }
})();
function fileLog(line) {
  if (!LOG_FILE) return;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}
function log(...a) {
  const line = `[cdp-proxy ${process.pid} ${hhmmss()}] ${a.join(" ")}\n`;
  try { process.stderr.write(line); } catch {}
  fileLog(line);
}
// 子进程输出(playwright-mcp / cdp-takeover)双写:stderr 之外同步落文件
function teeChild(prefix, d) {
  const s = String(d);
  try { process.stderr.write(`[${prefix}] ${s}`); } catch {}
  fileLog(`[cdp-proxy ${process.pid} ${hhmmss()}] [${prefix}] ${s.endsWith("\n") ? s : s + "\n"}`);
}
function hhmmss() { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":"); }

// ---- metrics 观测:每工具调用量/延迟分桶/生命周期计数的可聚合元数据 ----
// 仅记录可聚合的元数据,严禁记录请求参数、URL、Cookie、token 或响应正文。
const metrics = {
  startedAt: Date.now(),
  calls: 0,
  completed: 0,
  errors: 0,
  unknownErrors: 0,
  unmatchedResponses: 0,
  inFlight: 0,
  maxInFlight: 0,
  byTool: Object.create(null),
  latencyBuckets: { lt100ms: 0, lt500ms: 0, lt2s: 0, lt10s: 0, gte10s: 0 },
  lifecycle: {
    backendSpawns: 0,
    backendExits: 0,
    takeoverSpawns: 0,
    childTerminated: 0,
    childKilled: 0,
    orphanExits: 0,
    parentLosses: 0,
    watchdogTriggers: 0,
  },
};
let metricsSummaryTimer = null;
let metricsSummaryEmitted = false;
function latencyBucket(ms) {
  if (ms < 100) return "lt100ms";
  if (ms < 500) return "lt500ms";
  if (ms < 2000) return "lt2s";
  if (ms < 10000) return "lt10s";
  return "gte10s";
}
function metricsSnapshot(reason) {
  return {
    event: "metrics_summary",
    reason,
    uptimeMs: Date.now() - metrics.startedAt,
    calls: metrics.calls,
    completed: metrics.completed,
    errors: metrics.errors,
    unknownErrors: metrics.unknownErrors,
    unmatchedResponses: metrics.unmatchedResponses,
    inFlight: metrics.inFlight,
    maxInFlight: metrics.maxInFlight,
    byTool: { ...metrics.byTool },
    latencyBuckets: { ...metrics.latencyBuckets },
    lifecycle: { ...metrics.lifecycle },
  };
}
function emitMetricsSummary(reason) {
  if (reason === "exit" && metricsSummaryEmitted) return;
  if (reason === "exit") metricsSummaryEmitted = true;
  log(JSON.stringify(metricsSnapshot(reason)));
}
function startMetricsSummary() {
  if (METRICS_SUMMARY_INTERVAL_MS <= 0) return;
  metricsSummaryTimer = setInterval(() => emitMetricsSummary("interval"), METRICS_SUMMARY_INTERVAL_MS);
}
function stopMetricsSummary() {
  if (metricsSummaryTimer) { clearInterval(metricsSummaryTimer); metricsSummaryTimer = null; }
}

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
const initialParentPid = process.ppid;
let parentCheckTimer = null;

// ---- 受管子进程生命周期(进程组语义:detached spawn → 组信号,防后代孤儿) ----
function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function signalChildGroup(child, signal) {
  if (!child || !child.pid) return;
  try { process.kill(-child.pid, signal); return; } catch {}
  try { child.kill(signal); } catch {}
}

function stopChildSync(child, signal = "SIGKILL") {
  if (!child || childExited(child)) return;
  signalChildGroup(child, signal);
}

function waitChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let done = false;
    let timer;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      resolve(value);
    };
    const onExit = () => finish(true);
    const onClose = () => finish(true);
    timer = setTimeout(() => finish(childExited(child)), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

async function stopChild(child, label) {
  if (!child || childExited(child)) return;
  log(`停止 ${label} PID=${child.pid}: SIGTERM`);
  signalChildGroup(child, "SIGTERM");
  if (await waitChildExit(child, CHILD_TERM_GRACE_MS)) {
    metrics.lifecycle.childTerminated++;
    return;
  }
  log(`停止 ${label} PID=${child.pid}: ${CHILD_TERM_GRACE_MS}ms 未退出 → SIGKILL 进程组`);
  signalChildGroup(child, "SIGKILL");
  await waitChildExit(child, 500);
  metrics.lifecycle.childKilled++;
}

function managedChildPids() {
  return [backend && backend.child, takeoverChild]
    .filter(child => child && child.pid && !childExited(child))
    .map(child => child.pid);
}

function notifyHardWatchdogChildren() {
  if (!hardWatchdogWorker) return;
  try { hardWatchdogWorker.postMessage({ type: "children", pids: managedChildPids() }); } catch {}
}

function spawnBackend(endpoint) {
  // 不加 --isolated:该 flag 会让 backend 对接管 Chrome 自建隔离 BrowserContext,
  // 永不认领启动 NTP 标签,首次 navigate 必开第二个窗口(空窗口+新窗口双开)。
  // 去掉后 backend 用默认 context,配合 cdp-takeover 等启动标签就绪,原地导航。
  const args = [CLI, "--cdp-endpoint", endpoint, "--browser", "chrome"];
  // detached: true → 子进程自成进程组组长,process.kill(-pid) 组信号才能覆盖其后代
  const child = spawn("node", args, { stdio: ["pipe", "pipe", "pipe"], detached: true });
  metrics.lifecycle.backendSpawns++;
  notifyHardWatchdogChildren();
  log(`backend spawn: node ${CLI.split("/").pop()} → ${endpoint}(PID ${child.pid})`);
  // stderr 限流:防 playwright-mcp 刷屏淹没事件循环
  let stderrCount = 0, stderrWindow = Date.now(), stderrSuppressed = 0;
  child.stderr.on("data", d => {
    if (Date.now() - stderrWindow >= 1000) { stderrCount = 0; stderrWindow = Date.now(); }
    if (++stderrCount > STDERR_RATE_LIMIT) { stderrSuppressed++; return; }
    teeChild("playwright-mcp", d);
  });
  child.on("error", err => {
    log(`backend spawn error: ${err.message}`);
    cleanupAndExit(1);
  });
  child.on("exit", (code, sig) => {
    metrics.lifecycle.backendExits++;
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

// ---- backend 赋值前的启动窗口消息队列 ----
// 启动 IIFE 里孤儿回收(reap)可 sleep 数秒,期间到达的客户端行若直接丢弃,initialize
// 握手会永久挂起 → 入队(上限 200 行),backend 赋值后按序 flush;超限或 flush 失败回
// JSON-RPC error(能 parse 出 id 就带 id),不静默。
const PRE_BACKEND_QUEUE_MAX = 200;
let preBackendQueue = [];

function rpcErrorForLine(line, message) {
  let id;
  try { id = JSON.parse(line).id; } catch {}
  if (id === undefined) { log("⚠️ 无法解析出请求 id,丢弃:", line.slice(0, 120)); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
}

function flushPreBackendQueue() {
  if (!preBackendQueue.length) return;
  const q = preBackendQueue;
  preBackendQueue = [];
  log(`flush 启动期排队消息 ${q.length} 行 → backend`);
  for (const line of q) {
    if (!forwardToBackend(line)) rpcErrorForLine(line, "proxy error: backend stdin write failed during startup flush");
  }
}

// 从 backend 读 JSON-RPC,按行切分后透传给 ZCode(stdout)
// 含 buf 上限保护(防 O(n²) 增长)+ stdout 行速率限流(超限部分留在 buf 延迟到下一秒窗口,
// 不丢响应 —— 大 snapshot 是合法场景,不杀 backend,CPU 异常由三层看门狗兜底)
function wireBackendOutput(b) {
  let buf = "";
  // 残行标记:buf 超限截断保尾后,头部必是被拦腰截断的残行,绝不能当完整 JSON-RPC 行
  // 写进 stdout(客户端会收到非法 JSON 且真实响应已丢)→ 截断后切出的第一个换行行整行丢弃
  let fragment = false;
  let outLines = 0, outWindow = Date.now();
  b.child.stdout.on("data", d => {
    buf += d.toString();
    if (buf.length > BUF_MAX_BYTES) {
      log(`⚠️ stdout buf 超 ${BUF_MAX_BYTES} bytes,截断到最后 64KB(可能是无换行大数据块)`);
      const kept = buf.slice(-65536);
      // 只有真截掉了头部才置残行标记(BUF_MAX_BYTES < 64KB 时 slice 是无操作,头部完好)
      if (kept.length < buf.length) fragment = true;
      buf = kept;
    }
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (fragment) {
        fragment = false;
        log(`⚠️ 丢弃截断残行(${line.length} bytes,非完整 JSON-RPC 行,不写 stdout)`);
        continue;
      }
      if (Date.now() - outWindow >= 1000) { outLines = 0; outWindow = Date.now(); }
      if (++outLines > OUTPUT_RATE_LIMIT) {
        log(`⚠️ backend stdout 限流:${outLines} 行/秒,剩余行延迟到下一秒窗口`);
        return;
      }
      if (line.trim()) handleBackendLine(line);
    }
  });
}

// ---- 工具调用观察:路由故障排查的核心证据 ----
// 记每个 tools/call 的 →(名字/到达)与 ←(dur/有无 error)。哪个调用、卡多久、
// 有没有响应,一眼可辨。不做完整 JSON.parse:大 snapshot 响应可达 MB 级,全量
// parse 会把 CPU 压力引入这条热路径(看门狗事故史);只扫前 256 字符找 id。
const pendingCalls = new Map(); // id(String) → { name, t0 };上限保护防响应丢失时无限增长
const RESP_ID_RE = /"id"\s*:\s*("([^"]*)"|-?\d+)/;
function trackClientCall(msg) {
  if (!msg || msg.method !== "tools/call" || msg.id === undefined) return;
  if (!msg.params || typeof msg.params.name !== "string") return;
  const name = msg.params.name;
  const id = String(msg.id);
  if (pendingCalls.has(id)) metrics.inFlight = Math.max(0, metrics.inFlight - 1);
  pendingCalls.set(id, { name, t0: Date.now() });
  metrics.calls++;
  metrics.inFlight++;
  metrics.maxInFlight = Math.max(metrics.maxInFlight, metrics.inFlight);
  const tool = metrics.byTool[name] || (metrics.byTool[name] = { calls: 0, completed: 0, errors: 0 });
  tool.calls++;
  if (pendingCalls.size > 200) {
    const oldest = pendingCalls.keys().next().value;
    if (pendingCalls.delete(oldest)) metrics.inFlight = Math.max(0, metrics.inFlight - 1);
  }
  log(`→ ${name} id=${msg.id}`);
}
function observeResponse(line) {
  const m = RESP_ID_RE.exec(line.slice(0, 256));
  if (!m) return;
  const id = m[2] !== undefined ? m[2] : m[1];
  const rec = pendingCalls.get(id);
  if (!rec) {
    metrics.unmatchedResponses++;
    return;
  }
  pendingCalls.delete(id);
  metrics.inFlight = Math.max(0, metrics.inFlight - 1);
  metrics.completed++;
  const duration = Date.now() - rec.t0;
  metrics.latencyBuckets[latencyBucket(duration)]++;
  // >1MB 不做 includes 扫描(约 5ms 级,省掉),error 与否记 unknown
  const errored = line.length <= 1048576 ? line.includes('"error"') : null;
  const tool = metrics.byTool[rec.name] || (metrics.byTool[rec.name] = { calls: 0, completed: 0, errors: 0 });
  tool.completed++;
  if (errored === true) { metrics.errors++; tool.errors++; }
  if (errored === null) metrics.unknownErrors++;
  log(`← ${rec.name} id=${id} dur=${duration}ms${errored === null ? " error=unknown(响应超1MB未扫描)" : errored ? " error=yes" : " error=no"}`);
}

// 处理 backend 输出:拦截 browser_close response(先转发,再触发 teardown)
function handleBackendLine(line) {
  observeResponse(line);
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

// ---- ENSURING 期间 lease 心跳 ----
// reserve→ACTIVE 可能远超 lease 的启动宽限窗(startChrome 重试 + 等端口监听最长 10s+),
// 期间若无心跳会被并发 proxy 按 zombie 回收误杀 → 每 CDP_LEASE_HB_MS 写一次 hbAt;
// 转 ACTIVE / 失败 / 释放即停(stopLeaseHb 挂在 releaseLease 内统一兜底)。
let leaseHbTimer = null;
function startLeaseHb() {
  stopLeaseHb();
  leaseHbTimer = setInterval(() => {
    if (!lease) return;
    try {
      if (!L.hb(lease.port, lease.leaseId)) log(`⚠️ lease 心跳失败:端口 ${lease.port} 归属校验未通过`);
    } catch (e) {
      log(`⚠️ lease 心跳异常: ${e && e.message}`);
    }
  }, LEASE_HB_MS);
}
function stopLeaseHb() {
  if (leaseHbTimer) { clearInterval(leaseHbTimer); leaseHbTimer = null; }
}

// 异步确保接管 Chrome 在线:reserve → cdp-takeover → 接通中继 → ACTIVE
// 主体整体 try/catch:未预期异常(如 lease fs 错误)若上抛会被 serialize 静默吞掉,
// state 永久卡 ENSURING 且不再接受任何 browser_* → 必须回滚(释放租约,内含守卫杀
// Agent Chrome)回 IDLE 让下次 browser_* 可重试;挂起中的调用由 failHeld 断开 →
// backend 收到连接错误回 JSON-RPC error。
function ensure() {
  serialize(async () => {
    if (state !== ST.IDLE) return;
    if (state === ST.SHUTTING_DOWN || state === ST.EXITED) return;
    setState(ST.ENSURING);
    try {
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
      startLeaseHb();

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
      stopLeaseHb();
      log(`✅ 激活完成 → 端口 ${lease.port}`);
    } catch (e) {
      log(`❌ ensure 异常: ${e && e.stack ? e.stack : e} → 回滚回 IDLE(下次 browser_* 可重试)`);
      try { await releaseLease(); } catch (e2) { log(`⚠️ 回滚释放租约异常: ${e2 && e2.message}`); }
      setState(ST.IDLE);
      relay.failHeld();
    }
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
      takeoverChild = spawn("bash", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
      metrics.lifecycle.takeoverSpawns++;
      const childPid = takeoverChild.pid;
      notifyHardWatchdogChildren();
      takeoverChild.stdout.on("data", d => teeChild("cdp-takeover", d));
      takeoverChild.stderr.on("data", d => teeChild("cdp-takeover", d));
      takeoverChild.on("error", err => { log(`takeover spawn error: ${err.message}`); resolve(-1); });
      // 退出即清引用并同步 worker 受管清单,防 managedChildPids 持有已死 PID 误杀复用者
      takeoverChild.on("exit", code => {
        if (takeoverChild && takeoverChild.pid === childPid) takeoverChild = null;
        notifyHardWatchdogChildren();
        resolve(code);
      });
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
  await stopTakeoverChild();
  stopLeaseHb();
  if (lease) {
    await L.release(lease.port, lease.leaseId);
    log(`释放端口 ${lease.port}`);
    lease = null;
    browserPid = null;
  }
}

async function stopTakeoverChild() {
  if (takeoverChild) {
    const child = takeoverChild;
    takeoverChild = null;
    await stopChild(child, "cdp-takeover");
    notifyHardWatchdogChildren();
  }
}

async function stopBackend() {
  if (!backend || !backend.child) return;
  const child = backend.child;
  backend = null;
  await stopChild(child, "playwright-mcp");
  notifyHardWatchdogChildren();
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
  // ⚠️ 击杀前先 killChildren() 清受管子进程(主线程传来的 children 消息维护),
  //    否则主进程死后 detached 子组继续存活;理由落 LOG_FILE,击杀不再零痕迹。
  const workerSrc = `
    const { parentPort } = require("worker_threads");
    const { execSync } = require("child_process");
    const LOG_FILE = ${JSON.stringify(LOG_FILE)};
    let lastHeartbeat = Date.now();
    let mainPid = 0;
    let childPids = [];
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
      else if (msg.type === "children" && Array.isArray(msg.pids)) {
        childPids = msg.pids.filter(pid => Number.isInteger(pid) && pid > 1);
      }
    });
    function killChildren() {
      for (const pid of childPids) {
        try { process.kill(-pid, "SIGKILL"); } catch {}
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    setInterval(() => {
      if (!mainPid || killed) return;
      // 第 1 路:心跳缺失(主线程完全卡死,setInterval 排不上)
      const lag = Date.now() - lastHeartbeat;
      if (lag > HARD_KILL_MS) {
        killed = true;
        try { if (LOG_FILE) require("fs").appendFileSync(LOG_FILE, "[cdp-proxy " + mainPid + " HARD-WATCHDOG] 🔥 主线程心跳缺失 " + Math.round(lag) + "ms > " + HARD_KILL_MS + "ms → SIGKILL\\n"); } catch (e) {}
        killChildren();
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
            try { if (LOG_FILE) require("fs").appendFileSync(LOG_FILE, "[cdp-proxy " + mainPid + " HARD-WATCHDOG] 🔥 主进程 busy-loop:滑动窗口 " + highCount + "/" + cpuSamples.length + " 次超 " + HARD_CPU_THRESHOLD + "% CPU → SIGKILL\\n"); } catch (e) {}
            killChildren();
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
    notifyHardWatchdogChildren();
    hardWatchdogWorker.on("error", err => {
      log(`⚠️ 硬看门狗 worker 异常: ${err.message}`);
    });
  } catch (e) {
    // fail-loud:硬看门狗是唯一能补救主线程 busy-loop 的防线(前两层 setInterval 都跑
    // 在主线程,卡死时一起死)。启动失败还继续跑 = 裸奔。
    // 直接退出,客户端会立即重拉新实例,新实例大概率能正常起 worker。
    log(`⛔ 硬看门狗 worker 启动失败: ${e.message} → 退出重拉,避免裸奔`);
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
        metrics.lifecycle.watchdogTriggers++;
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
      metrics.lifecycle.orphanExits++;
      log(`(${Math.round(ORPHAN_TIMEOUT_MS / 60000)}min 无真实 MCP 业务请求 → 判定为孤儿 proxy(被 zcode-cli 遗忘),退出)`);
      cleanupAndExit(0);
    }
  }, 60000);
}
function stopWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (orphanTimer) { clearInterval(orphanTimer); orphanTimer = null; }
}

// ---- 父进程监控:ppid 变化(父进程退出被过继)即判孤儿,30min 业务孤儿检测的快路径 ----
function startParentMonitor() {
  stopParentMonitor();
  if (!initialParentPid || initialParentPid === 1) return;
  parentCheckTimer = setInterval(() => {
    if (process.ppid !== initialParentPid) {
      metrics.lifecycle.parentLosses++;
      log(`父进程已变化 ${initialParentPid} → ${process.ppid},判定为孤儿 proxy → 退出清理`);
      cleanupAndExit(0);
    }
  }, PARENT_CHECK_INTERVAL_MS);
}

function stopParentMonitor() {
  if (parentCheckTimer) { clearInterval(parentCheckTimer); parentCheckTimer = null; }
}

// ==================== 主 stdio:解析 ZCode → backend ====================
let inBuf = "";
// 残行标记:inBuf 超限截断保尾后,头部必是被拦腰截断的残行,不能当完整行解析转发
let inFragment = false;
process.stdin.setEncoding("utf8");

process.stdin.on("data", chunk => {
  beatHeartbeat(); // stdin 收到数据 → 刷新硬看门狗心跳
  inBuf += chunk;

  // inBuf 上限保护:超 INBUF_MAX_BYTES 截断到最后 64KB(防无换行大数据块无限增长 → O(n²) + OOM)
  if (inBuf.length > INBUF_MAX_BYTES) {
    log(`⚠️ stdin inBuf 超 ${INBUF_MAX_BYTES} bytes,截断到最后 64KB(可能是无换行大数据块)`);
    const kept = inBuf.slice(-65536);
    // 只有真截掉了头部才置残行标记(见 wireBackendOutput 同款防线)
    if (kept.length < inBuf.length) inFragment = true;
    inBuf = kept;
  }

  let idx;
  while ((idx = inBuf.indexOf("\n")) >= 0) {
    const line = inBuf.slice(0, idx);
    inBuf = inBuf.slice(idx + 1);
    if (inFragment) {
      inFragment = false;
      log(`⚠️ 丢弃 stdin 截断残行(${line.length} bytes,不解析不转发)`);
      continue;
    }
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
// ensure 期间到达的请求不缓冲 —— 中继挂起语义保证它在 Chrome 就绪后自然流动;
// backend 赋值前的启动窗口则入队(flushPreBackendQueue),防止 initialize 被丢挂死握手。
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

  // 入队分支之前记 metrics:排队期调用也计入 calls,flush 后响应由 observeResponse 闭环
  trackClientCall(msg);

  if (!backend) {
    if (preBackendQueue.length >= PRE_BACKEND_QUEUE_MAX) {
      log(`⚠️ 启动期队列超限(${PRE_BACKEND_QUEUE_MAX}),拒绝消息:`, line.slice(0, 120));
      rpcErrorForLine(line, "proxy error: startup queue overflow (backend not ready)");
      return;
    }
    preBackendQueue.push(line);
    return;
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
  stopParentMonitor();
  stopMetricsSummary();
  stopHardWatchdog(); // 停硬看门狗(正常退出时不需要它再杀自己)
  stopLeaseHb();

  try {
    // 停 takeover child
    await stopTakeoverChild();

    // 断中继管道
    relay.stop();

    // 停 backend 并等待/强杀整个进程组,避免 playwright 后代脱离 proxy 变孤儿
    await stopBackend();

    // 释放 lease(杀 Chrome + 删锁,核对 leaseId)
    await releaseLease();
  } catch (e) {
    log("cleanup 异常: " + e.message);
  }

  setState(ST.EXITED);
  emitMetricsSummary("exit");
  process.exit(code);
}

process.on("SIGTERM", () => cleanupAndExit(0));
process.on("SIGINT", () => cleanupAndExit(0));
process.on("SIGHUP", () => cleanupAndExit(0));
// ⚠️ uncaughtException / unhandledRejection 必须纯同步、不裸写 stderr、直接 process.exit。
// 父进程退出后 stderr pipe 对端关闭,裸调 process.stderr.write 抛 EPIPE → 触发本 handler
// → handler 再裸写 → 无限递归异常风暴,V8 疯狂抓栈占满 CPU。log()/fileLog() 内部
// try/catch 吞错,经它们写不构成递归源;这里先 fileLog 落崩溃现场(stack 截 4000 字符)再 exit。
process.on("uncaughtException", err => {
  fileLog(`[cdp-proxy ${process.pid} ${hhmmss()}] 💥 uncaughtException: ${String((err && err.stack) || err).slice(0, 4000)}\n`);
  try { process.exit(1); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", reason => {
  fileLog(`[cdp-proxy ${process.pid} ${hhmmss()}] 💥 unhandledRejection: ${String((reason && reason.stack) || reason).slice(0, 4000)}\n`);
  try { process.exit(1); } catch {}
  process.exit(1);
});

// exit hook:最后保险(同步,带 leaseId 校验,不裸写 stderr —— uncaughtException 路径下
// stderr 可能已坏,裸写会触发递归异常风暴;log()/fileLog() 内部吞错,经它们写安全)。
// 必须兜底 cleanupAndExit 覆盖不到的纯同步退出路径(uncaughtException/unhandledRejection
// 的 exit(1)、软看门狗 exit(99)):只删锁不杀进程 = 「锁删 Chrome/backend 活」泄漏主源,
// 无锁 Agent Chrome 会按 durable 占用端口且永不回收。
// Chrome 只杀 isAgentChromePid 判定的 Agent Chrome(守卫语义同 lease.killAgentChrome,
// 绝不碰非 Agent 进程);同步退出等不了 SIGTERM 生效窗口,SIGTERM 后立即 SIGKILL 保必死。
// 受管子进程(backend/takeover)以进程组 SIGKILL 兜底(detached 子组不会被 proxy 退出自动带走)。
process.on("exit", () => {
  emitMetricsSummary("exit");
  stopChildSync(backend && backend.child);
  stopChildSync(takeoverChild);
  if (lease) {
    try {
      const listener = L.portPid(lease.port);
      const pid = listener ? parseInt(listener, 10) : NaN;
      if (pid && L.isAgentChromePid(pid)) {
        try { process.kill(pid, "SIGTERM"); } catch {}
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    } catch {}
    L.removeLockIfOwner(lease.port, lease.leaseId);
  }
});

// ==================== 启动 ====================
(async () => {
  log(`启动 lazy CDP proxy(本地中继架构,IDLE = 0 端口 0 Chrome;ppid=${process.ppid} node=${process.version}${LOG_FILE ? " file-log=" + LOG_FILE : " file-log=off"})`);

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
  flushPreBackendQueue();

  setState(ST.IDLE);
  startHealthCheck();
  startWatchdog();
  startParentMonitor();
  startHardWatchdog(); // 硬看门狗:worker 线程,免疫主线程 busy-loop
  startMetricsSummary();
  log(`backend 常驻就绪(PID ${backend.child.pid}),IDLE,等待首个 browser_ 调用才激活`);
})();
