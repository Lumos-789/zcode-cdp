#!/usr/bin/env node
// zcode-cdp-proxy — ZCode 多会话 CDP 端口池(lazy 版,状态机驱动)
//
// 替代 playwright-mcp 作为 config.json 里 cdp 的 command。每个 ZCode 会话独立
// spawn 一个本 proxy 实例。proxy 全权持有 stdio(MCP JSON-RPC 通道),背后懒挂一个
// playwright-mcp 进程:
//   - READY_IDLE:spawn 一个「占位」playwright-mcp(endpoint 指向无效地址),只负责
//     应答 initialize / tools/list。不领端口、不起 Chrome → 开 N 个窗口其中不碰
//     CDP 的 = 0 端口 0 Chrome。
//   - 首次 browser_ 调用 → RESERVING → STARTING_BROWSER → STARTING_BACKEND → ACTIVE
//   - browser_close → 先返回响应给 ZCode → RELEASING → 回到 READY_IDLE
//   - Chrome/backend 异常 → 当前调用失败 → 回到 READY_IDLE(不自动重放)
//   - 退出(stdin EOF/SIGTERM/SIGINT/SIGHUP)→ SHUTTING_DOWN → EXITED
//
// 端口池:9223-9229(7 个会话临时端口)。脚本 durable 端口使用 93xx,不进租约池。
// 租约:统一使用 zcode-cdp-lease.js 管理(原子 mkdir + leaseId ownership 校验)。
//
// 关键正确性修复(vs 旧版):
//   - exactly-once enqueue:激活期间到达的请求只入队一次
//   - synthetic initialize:real backend 启动后先内部握手(initialize+initialized),
//     吞掉内部响应,然后才 flush 工具请求
//   - browser_close response-aware:先返回响应给 ZCode,再释放整份租约,重启 placeholder
//   - backend generation fencing:旧 placeholder 迟到输出不会污染新 backend
//   - 激活失败时对本轮 batch 每个 request 各返回一次 error 并清空

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const L = require("./zcode-cdp-lease.js");

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
const PLACEHOLDER_ENDPOINT = process.env.CDP_PLACEHOLDER_ENDPOINT || "http://127.0.0.1:1";
const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.CDP_HEALTH_CHECK_MS || "5000", 10);

// ---- 防护阈值(env 可覆盖) ----
const OUTPUT_RATE_LIMIT = parseInt(process.env.CDP_OUTPUT_RATE_LIMIT || "500", 10);   // backend stdout 行/秒
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
// ⚠️ log() 必须 swallow write 错误:父 zcode-cli 退出后 stderr pipe 对端关闭,
// process.stderr.write 抛 EPIPE → 触发 uncaughtException → handler 里若再 log() 会
// 递归异常风暴(2026-07-26 PID 13503 事故根因)。这里 try/catch 兜底,write 失败静默。
function log(...a) {
  try { process.stderr.write(`[cdp-proxy ${process.pid} ${hhmmss()}] ${a.join(" ")}\n`); } catch {}
}
function hhmmss() { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":"); }

// ==================== 状态机 ====================
// BOOTING → READY_IDLE → RESERVING → STARTING_BROWSER → STARTING_BACKEND → ACTIVE
//          → CLOSE_PENDING → RELEASING → READY_IDLE
//          → (any) SHUTTING_DOWN → EXITED
const ST = {
  BOOTING: "BOOTING",
  READY_IDLE: "READY_IDLE",
  RESERVING: "RESERVING",
  STARTING_BROWSER: "STARTING_BROWSER",
  STARTING_BACKEND: "STARTING_BACKEND",
  ACTIVE: "ACTIVE",
  CLOSE_PENDING: "CLOSE_PENDING",
  RELEASING: "RELEASING",
  SHUTTING_DOWN: "SHUTTING_DOWN",
  EXITED: "EXITED",
};

let state = ST.BOOTING;
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

// ==================== backend 管理 ====================
// backend = { child, role, generation }
// generation 用于 fencing:只有当前 generation 的输出才转发给 ZCode
let backend = null;
let backendGeneration = 0;
let takeoverChild = null;

// 当前 lease
let lease = null;       // { port, leaseId }
let browserPid = null;

// 客户端 initialize 缓存(rearm placeholder 时用于内部握手)
let cachedClientInit = null;

// activation batch:激活期间到达的请求,exactly-once 入队
let activationBatch = [];  // [{ line, id }]

// in-flight request tracker:记录已转发的 request id(用于 browser_close 捕获)
let closeRequestId = null;

function spawnBackend(endpoint) {
  backendGeneration++;
  const gen = backendGeneration;
  const args = [CLI, "--cdp-endpoint", endpoint, "--browser", "chrome", "--isolated"];
  const child = spawn("node", args, { stdio: ["pipe", "pipe", "pipe"] });
  // stderr 限流:防 playwright-mcp 刷屏淹没事件循环
  let stderrCount = 0, stderrWindow = Date.now(), stderrSuppressed = 0;
  child.stderr.on("data", d => {
    if (Date.now() - stderrWindow >= 1000) { stderrCount = 0; stderrWindow = Date.now(); }
    if (++stderrCount > STDERR_RATE_LIMIT) { stderrSuppressed++; return; }
    process.stderr.write(`[playwright-mcp] ${d}`);
  });
  child.on("error", err => {
    log(`backend spawn error (gen ${gen}): ${err.message}`);
    // 如果是当前 backend → 视为 backend 异常退出
    if (backend && backend.child === child) {
      onBackendDied(gen, `spawn error: ${err.message}`);
    }
  });
  child.on("exit", (code, sig) => {
    log(`backend(gen ${gen}) 退出 code=${code} sig=${sig}`);
    if (backend && backend.child === child) {
      onBackendDied(gen, `exit code=${code} sig=${sig}`);
    }
  });
  return { child, role: "placeholder", generation: gen };
}

// backend 异常/正常退出处理
function onBackendDied(gen, reason) {
  if (state === ST.SHUTTING_DOWN || state === ST.EXITED) return;
  if (state === ST.READY_IDLE && backend && backend.generation === gen && backend.role === "placeholder") {
    // placeholder 退出 → proxy 无法继续应答,退出
    log(`placeholder backend 退出(reason: ${reason}),proxy 无法继续 → 退出`);
    cleanupAndExit(1);
    return;
  }
  if ((state === ST.ACTIVE || state === ST.CLOSE_PENDING) && backend && backend.generation === gen && backend.role === "real") {
    // real backend 意外退出 → 当前调用失败 → 释放资源 → 回 READY_IDLE
    log(`real backend 异常退出(reason: ${reason})→ 释放租约,回 READY_IDLE`);
    serialize(() => handleBackendFailure("real backend exited: " + reason));
    return;
  }
  // 激活期间 backend 退出 → 激活失败
  if ((state === ST.STARTING_BACKEND) && backend && backend.generation === gen) {
    log(`backend 启动期间退出(reason: ${reason})→ 释放租约,回 READY_IDLE`);
    serialize(() => failActivation("backend exited during startup: " + reason));
    return;
  }
}

// 把一行 JSON-RPC 写给当前 backend
function forwardToBackend(line) {
  if (!backend || !backend.child || !backend.child.stdin.destroyed) {
    if (!backend || !backend.child || !backend.child.stdin.writable) {
      log("⚠️ 无可写 backend,丢弃消息:", line.slice(0, 120));
      return false;
    }
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
// generation fencing:只有当前 generation 的输出才转发
// 含 buf 上限保护(防 O(n²) 增长)+ stdout 行速率限流(防 backend 刷屏淹没事件循环)
function wireBackendOutput(b) {
  let buf = "";
  const gen = b.generation;
  let outLines = 0, outWindow = Date.now(), floodTripped = false;
  b.child.stdout.on("data", d => {
    if (backend !== b) return; // 不是当前 backend,丢弃
    buf += d.toString();

    // buf 上限保护:超 BUF_MAX_BYTES 截断到最后 64KB,防 O(n²) 字符串增长
    if (buf.length > BUF_MAX_BYTES) {
      log(`⚠️ stdout buf 超 ${BUF_MAX_BYTES} bytes,截断到最后 64KB(可能是无换行大数据块)`);
      buf = buf.slice(-65536);
    }

    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);

      // 速率限流:1 秒窗口内超 OUTPUT_RATE_LIMIT 行 → 熔断(只对 real backend 触发)
      if (Date.now() - outWindow >= 1000) { outLines = 0; outWindow = Date.now(); }
      if (++outLines > OUTPUT_RATE_LIMIT) {
        if (b.role === "real" && !floodTripped) {
          floodTripped = true;
          log(`🔥 backend stdout 限流:${outLines} 行/秒 → 杀 real backend,回 READY_IDLE`);
          serialize(() => handleBackendFailure("backend output flood (> " + OUTPUT_RATE_LIMIT + " lines/s)"));
        }
        return; // 本批剩余行全部丢弃
      }

      if (line.trim()) handleBackendLine(line, gen);
    }
  });
}

// 处理 backend 输出:拦截 synthetic initialize response 和 browser_close response
function handleBackendLine(line, gen) {
  // 拦截 synthetic initialize response(用于内部握手)
  if (syntheticInitPending && gen === backendGeneration) {
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(line + "\n"); return; }
    if (msg.id === SYNTHETIC_INIT_ID) {
      syntheticInitPending = false;
      log("收到 synthetic initialize response → 吞掉,继续握手");
      onSyntheticInitDone();
      return;
    }
  }

  // 拦截 browser_close response:先转发给 ZCode,再触发 release
  if (closeRequestId !== null) {
    let msg;
    try { msg = JSON.parse(line); } catch { /* 非 JSON,正常转发 */ }
    if (msg && msg.id === closeRequestId) {
      process.stdout.write(line + "\n");
      closeRequestId = null;
      serialize(() => releaseAfterClose());
      return;
    }
  }

  // 正常透传
  process.stdout.write(line + "\n");
}

// ---- synthetic initialize 协议 ----
const SYNTHETIC_INIT_ID = "__cdp_proxy_synthetic_init__";
let syntheticInitPending = false;
let syntheticInitResolve = null;

function sendSyntheticInit(b) {
  syntheticInitPending = true;
  const initMsg = {
    jsonrpc: "2.0",
    id: SYNTHETIC_INIT_ID,
    method: "initialize",
    params: cachedClientInit || {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "zcode-cdp-proxy", version: "1.0" },
    },
  };
  b.child.stdin.write(JSON.stringify(initMsg) + "\n");
  return new Promise(resolve => { syntheticInitResolve = resolve; });
}

function onSyntheticInitDone() {
  // 发送 notifications/initialized
  if (backend && backend.child && backend.child.stdin.writable) {
    backend.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  if (syntheticInitResolve) {
    const r = syntheticInitResolve;
    syntheticInitResolve = null;
    r();
  }
}

// ==================== 激活流程 ====================

// 主激活入口:由 handleClientLine 在首次 browser_ 调用时触发
function startActivation(firstLine) {
  if (state !== ST.READY_IDLE) return; // 已经在激活中或不可激活
  serialize(() => doActivate(firstLine));
}

async function doActivate(firstLine) {
  if (state === ST.SHUTTING_DOWN || state === ST.EXITED) return;
  setState(ST.RESERVING);

  // 1. 领端口租约
  // kind 必须是进程命令行中的子串(zcode-cdp-proxy.js → "zcode-cdp-proxy")
  const r = await L.reserve("zcode-cdp-proxy");
  if (!r) {
    log("❌ 端口池已满(7 个会话全在用)");
    failActivation("CDP 端口池已满(7 个会话全在用 9223-9229),关掉一个会话或调用 browser_close 释放后再重试");
    return;
  }
  lease = r;
  log(`领到端口 ${lease.port}(leaseId ${lease.leaseId.slice(0, 8)})`);

  if (state === ST.SHUTTING_DOWN || state === ST.EXITED) { await releaseLease(); return; }

  setState(ST.STARTING_BROWSER);

  // 2. 起 Chrome(cdp-takeover managed 模式)
  const ok = await startChrome(lease.port);
  if (!ok) {
    failActivation(`端口 ${lease.port} 的 Chrome 起不来(见 cdp-takeover 输出)`);
    return;
  }

  if (state === ST.SHUTTING_DOWN || state === ST.EXITED) { await releaseLease(); return; }

  // 记录 browser PID 到 lease
  const bp = L.portPid(lease.port);
  browserPid = bp ? parseInt(bp, 10) : null;
  if (lease) L.markActive(lease.port, lease.leaseId, browserPid);

  setState(ST.STARTING_BACKEND);

  // 3. 杀占位 backend → 起真 backend
  stopBackend();

  const real = spawnBackend(`http://127.0.0.1:${lease.port}`);
  real.role = "real";
  backend = real;
  wireBackendOutput(real);

  // 等待 backend stdout 可写
  await new Promise(resolve => {
    if (real.child.stdin.writable) resolve();
    else real.child.stdin.on("pipe", resolve);
    setTimeout(resolve, 2000);
  });

  if (state === ST.SHUTTING_DOWN || state === ST.EXITED) { await releaseLease(); return; }

  // 4. synthetic initialize 握手
  log("real backend 启动,执行 synthetic initialize...");
  await sendSyntheticInit(real);

  if (state === ST.SHUTTING_DOWN || state === ST.EXITED) { await releaseLease(); return; }

  // 5. flush activation batch(exactly-once)
  setState(ST.ACTIVE);
  const batch = activationBatch;
  activationBatch = [];
  for (const item of batch) {
    forwardToBackend(item.line);
  }
  log(`✅ 激活完成 → 端口 ${lease.port},flush ${batch.length} 个排队请求`);
}

// Chrome 启动:cdp-takeover --managed --lease-id
async function startChrome(port) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (state === ST.SHUTTING_DOWN || state === ST.EXITED) return false;

    const code = await new Promise(resolve => {
      const args = [TAKEOVER, String(port)];
      // managed 模式:让 takeover 核验 lease ownership
      if (lease) {
        args.push("--managed", "--lease-id", lease.leaseId);
      }
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

// 激活失败:settle batch(每个 request 返回一次 error)+ 释放 + 回 READY_IDLE
async function failActivation(reason) {
  log(`❌ 激活失败: ${reason}`);
  settleBatch(reason);
  await releaseLease();
  setState(ST.READY_IDLE);
  // placeholder 应该还在,确认它可用
  if (!backend || backend.role !== "placeholder") {
    log("激活失败后 placeholder 不在,重启 placeholder");
    restartPlaceholder();
  }
}

// backend 运行中异常:失败当前调用 + 释放 + 回 READY_IDLE
async function handleBackendFailure(reason) {
  // 如果有 in-flight request,给它们 error(我们无法精确知道哪个,但 real backend 死了 → 所有 pending 都失败)
  settleBatch(reason);

  // 如果有 closeRequestId 也在等 → 取消
  closeRequestId = null;

  await releaseLease();
  setState(ST.READY_IDLE);
  restartPlaceholder();
}

// settle batch:对本轮 activationBatch 中每个有 id 的 request 返回一次 error,然后清空
function settleBatch(reason) {
  for (const item of activationBatch) {
    if (item.id !== undefined && item.id !== null) {
      const err = JSON.stringify({
        jsonrpc: "2.0",
        id: item.id,
        error: { code: -32603, message: reason },
      });
      process.stdout.write(err + "\n");
    }
  }
  activationBatch = [];
}

// browser_close 完成后释放整份租约,重启 placeholder
async function releaseAfterClose() {
  setState(ST.RELEASING);
  log("browser_close 响应已返回 → 释放整份租约");

  stopBackend();
  await releaseLease();
  setState(ST.READY_IDLE);
  restartPlaceholder();
  // 重放释放期间缓冲的请求(否则会悬挂到下一次激活才被 flush):
  // 非 browser_ 请求透传给新 placeholder;browser_ 请求按 READY_IDLE 语义重新处理
  // (browser_close 直接成功,browser_* 触发新一轮激活)。
  const batch = activationBatch;
  activationBatch = [];
  for (const item of batch) handleClientLine(item.line);
  log("已回到 READY_IDLE,等待下次 browser_ 调用");
}

// 释放当前 lease(杀 Chrome + 删锁)
async function releaseLease() {
  stopTakeoverChild();
  stopBackend();
  if (lease) {
    await L.release(lease.port, lease.leaseId);
    log(`释放端口 ${lease.port}`);
    lease = null;
    browserPid = null;
  }
}

// 停止 takeover child
function stopTakeoverChild() {
  if (takeoverChild) {
    try { takeoverChild.kill("SIGTERM"); } catch {}
    takeoverChild = null;
  }
}

// 停止当前 backend(不杀 placeholder,只杀 real;切换时用)
function stopBackend() {
  if (backend && backend.child) {
    backend.child.removeAllListeners("exit");
    backend.child.removeAllListeners("error");
    try { backend.child.kill("SIGTERM"); } catch {}
    backend = null;
  }
}

// 重启 placeholder backend(回 READY_IDLE 时用)
function restartPlaceholder() {
  stopBackend();
  const ph = spawnBackend(PLACEHOLDER_ENDPOINT);
  ph.role = "placeholder";
  backend = ph;
  wireBackendOutput(ph);
  // rearm 握手:placeholder 是全新进程,而 ZCode 只在连接建立时发一次 initialize,
  // 不会重发。不握手的话,close 之后透传进来的 tools/list 等非浏览器请求会因
  // backend 未初始化而悬挂/报错(响应被 handleBackendLine 的 synthetic 拦截吞掉)。
  if (cachedClientInit) sendSyntheticInit(ph).catch(() => {});
  log("placeholder backend 重启就绪");
}

// ---- 健康检查(ACTIVE 状态,检测 Chrome/backend 死亡,非 idle timeout) ----
let healthCheckTimer = null;
function startHealthCheck() {
  stopHealthCheck();
  healthCheckTimer = setInterval(() => {
    if (state !== ST.ACTIVE) return;
    if (!lease) return;
    serialize(async () => {
      if (state !== ST.ACTIVE) return;
      const listener = L.portPid(lease.port);
      if (!listener) {
        log(`⚠️ Chrome 在端口 ${lease.port} 上消失(listener gone)`);
        await handleBackendFailure("Chrome listener disappeared");
      } else if (!L.isAgentChromePid(listener)) {
        log(`⚠️ 端口 ${lease.port} 的 listener 变成非 Agent Chrome`);
        // 不杀非 Agent;释放 lease 让 proxy 回 idle
        await handleBackendFailure("port listener is no longer Agent Chrome");
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
// 孤儿超时:stdin 超过 ORPHAN_TIMEOUT_MS 无数据 → 判定为孤儿 proxy,退出
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
// 根因:旧版看门狗用 setInterval,跑在主线程事件循环里。当主线程陷入同步 busy-loop
// (如 inBuf 无换行无限增长、或某段代码死循环),事件循环被完全阻塞,setInterval 回调
// 永远排不上队 → 看门狗自己也被卡死,防线形同虚设。PID 19791 正是此场景:99% CPU 跑了
// 19 小时,看门狗一次都没触发。
//
// 解法:把看门狗放到 worker_threads。worker 有独立的事件循环和 libuv 线程池,主线程
// busy-loop 不影响 worker 的 setInterval 计时。worker 每 2s 检查主线程发来的心跳时间戳;
// 超过 HARD_KILL_MS 无新心跳 → worker 直接 process.kill(SIGKILL) 干掉主进程(SIGKILL
// 不可被拦截,绕过 cleanupAndExit 的所有异步逻辑,确保必死)。
//
// 心跳机制:主线程在 stdin data + 每秒 setInterval 里 postMessage 更新心跳。正常情况
// 心跳频繁,worker 永不触发。主线程卡死 → 心跳停 → worker 60s 后杀。
const { Worker } = require("worker_threads");
let hardWatchdogWorker = null;
let heartbeatTimer = null;

function startHardWatchdog() {
  stopHardWatchdog();
  // Worker 源码用内联 Blob,避免外部文件依赖
  // ⚠️ kill 目标修正:旧版用 process.ppid(主进程的父进程 = launchd, PID 1),普通用户
  //    EPERM 失败 → 硬看门狗形同虚设,主线程 busy-loop 时进程能裸奔十几小时不被杀
  //    (PID 19791 跑 19h、PID 54278 跑 15h 均因此)。改由主线程启动时 postMessage 传入
  //    主进程真实 PID,worker 用它来 SIGKILL。不依赖 worker 内 process.pid/ppid 歧义语义。
  //
  // ⚠️ 双路检测(2026-07-26 新增第 2 路):原心跳机制只能抓"主线程完全卡死"(连 setInterval
  //    回调都排不上)。但 PID 64663/84030/90434/97706 实测是"间歇 busy-loop"——主线程反复
  //    陷长同步块(秒级),块间间隙让 setInterval 回调被批量补跑,心跳照常发,worker 看到的
  //    lag 始终很小 → 永不触发。新增第 2 路独立 CPU 检测:worker 自己 execSync('ps -p <pid>
  //    -o time=') 读主进程 CPU 时间,两次采样算增量,完全绕过主线程事件循环。
  //    详见 knowledge/general/cdp.md §4 看门狗事故记录。
  //
  // ⚠️ 判定策略用"滑动窗口"而非"连续 N 次":间歇 busy-loop(如 5s 块 + 1s 间隙)周期里,
  //    worker 2s 采样一次,采样点会周期性落在间隙上(测到 50%),连续判定永远凑不齐。
  //    改成最近 N 次采样里 ≥ M 次高 CPU 就触发,容忍偶尔落在间隙的样本。
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
    // 在主线程,卡死时一起死)。启动失败还继续跑 = 裸奔,等于把事故风险留到下一次复现。
    // 直接退出,ZCode 会立即重拉新实例,新实例大概率能正常起 worker。
    // 详见 knowledge/general/cdp.md §4 看门狗事故记录。
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
        // 资源清理交给 OS(Chrome/backend SIGTERM 由 exit hook 兜底),ZCode 会重拉新实例。
        // 详见 knowledge/general/cdp.md §4 看门狗事故记录(2026-07-26)。
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
  // 场景:zcode-cli 发了畸形/超长无换行数据,旧版 inBuf 无限增长 → 字符串拼接 O(n²) → CPU 100%
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

function handleClientLine(line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { log("⚠️ 非 JSON,丢弃:", line.slice(0, 120)); return; }

  // 业务活动度心跳:真实 MCP 业务方法才刷新 lastBusinessTime(用于 orphan 检测)。
  // 区别于 lastStdinTime(任何 stdin 字节都刷新,会被 keepalive 噪声绕过孤儿超时)。
  if (msg.method && BUSINESS_METHODS.test(msg.method)) {
    lastBusinessTime = Date.now();
  }

  // 缓存客户端 initialize 参数(rearm placeholder 时用)
  if (msg.method === "initialize" && msg.params) {
    cachedClientInit = msg.params;
  }

  const isBrowserCall = msg.method === "tools/call" && msg.params && typeof msg.params.name === "string" && msg.params.name.startsWith("browser_");
  const isBrowserClose = isBrowserCall && msg.params.name === "browser_close";

  // ---- 状态分发 ----
  switch (state) {
    case ST.READY_IDLE:
      if (isBrowserClose) {
        // dormant 状态收到 browser_close:直接返回成功(已释放),不启动 Chrome
        log("READY_IDLE 收到 browser_close → 直接返回成功(无需启动 Chrome)");
        if (msg.id !== undefined) {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: "Browser already closed (no active CDP session)." }] },
          }) + "\n");
        }
        return;
      }
      if (isBrowserCall) {
        // 首次 browser_ 调用 → 触发激活(exactly-once enqueue)
        activationBatch.push({ line, id: msg.id !== undefined ? msg.id : null });
        startActivation(line);
        return;
      }
      // 非浏览器调用:透传给 placeholder
      forwardToBackend(line);
      return;

    case ST.RESERVING:
    case ST.STARTING_BROWSER:
    case ST.STARTING_BACKEND:
      // 激活期间:所有消息 exactly-once 入队(包括 browser_ 和非 browser_)
      // 检查是否已在 batch 中(防重复)
      if (!activationBatch.some(item => item.line === line)) {
        activationBatch.push({ line, id: msg.id !== undefined ? msg.id : null });
      }
      return;

    case ST.ACTIVE:
      if (isBrowserClose) {
        // browser_close:转发,但记录 request id 用于捕获响应
        closeRequestId = msg.id !== undefined ? msg.id : null;
        forwardToBackend(line);
        setState(ST.CLOSE_PENDING);
        return;
      }
      // 正常透传
      forwardToBackend(line);
      return;

    case ST.CLOSE_PENDING:
      // close 执行期间到达的新请求:缓冲,待 rearm 后作为新 activation 处理
      // 不能发给正在 dispose 的 backend
      if (!activationBatch.some(item => item.line === line)) {
        activationBatch.push({ line, id: msg.id !== undefined ? msg.id : null });
      }
      return;

    case ST.RELEASING:
      // 正在释放:缓冲
      if (!activationBatch.some(item => item.line === line)) {
        activationBatch.push({ line, id: msg.id !== undefined ? msg.id : null });
      }
      return;

    case ST.SHUTTING_DOWN:
    case ST.EXITED:
      // 退出中:丢弃(settle 会处理 pending)
      return;

    default:
      forwardToBackend(line);
  }
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
    // settle pending batch
    settleBatch("proxy shutting down");

    // 停 takeover child
    stopTakeoverChild();

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
// 2026-07-26 事故根因(经 sample 取证坐实):父 zcode-cli 退出后 stderr pipe 对端关闭,
// 任何 log() → process.stderr.write 抛 EPIPE → 触发本 handler → handler 又调 log()
// → 又 write → 又 EPIPE → 无限递归异常风暴。V8 疯狂抓堆栈(CaptureSimpleStackTrace)
// 占满 CPU,worker 线程也被拖累无法 SIGKILL。PID 13503 跑 13 分钟烧核即此场景。
// 修复:handler 里只用 try/catch 包裹的同步操作,绝不 write 已坏的 stderr,直接 exit。
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
  log("启动 lazy CDP proxy(占位 backend,READY_IDLE = 0 端口 0 Chrome)");

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

  // 启动占位 backend
  const ph = spawnBackend(PLACEHOLDER_ENDPOINT);
  ph.role = "placeholder";
  backend = ph;
  wireBackendOutput(ph);

  setState(ST.READY_IDLE);
  startHealthCheck();
  startWatchdog();
  startHardWatchdog(); // 硬看门狗:worker 线程,免疫主线程 busy-loop
  log("占位 backend 就绪,READY_IDLE,等待首个 browser_ 调用才激活");
})();
