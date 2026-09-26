#!/usr/bin/env node
// zcode-cdp-lease — 统一 CDP 端口租约管理
//
// 供 zcode-cdp-proxy.js (require) 和 cdp-takeover (CLI) 共享，消除两套
// 各自不一致的锁判断。核心不变量：
//   - mkdir 是唯一原子抢占点
//   - owner.json 含 leaseId，删除/更新前必须核对，防 PID 复用和误删新锁
//   - 非 Agent listener 永不自动 kill
//   - 完全无锁的 durable Agent Chrome 只当「端口忙」处理，不抢占（人工 durable
//     是合法形态）；有锁但 owner 无效的 Agent Chrome 是 SIGKILL 崩溃残留，可回收
//   - owner 必须是常驻进程：短命 CLI 一退出 pid 即成孤儿（cdpcc 因此下线）
//   - Chrome 未退出前不得释放 lease
//
// 锁格式:
//   $LOCK_ROOT/<port>.lock/           ← mkdir 原子抢锁
//   $LOCK_ROOT/<port>.lock/owner.json ← hbAt 为毫秒 epoch 心跳，ENSURING 期间持有者刷新
//
// 兼容旧锁(只读判定，不创建;保留清理 v0.1.0 残留):
//   /tmp/zcode-cdp-port-<port>.lock/pid   (旧 proxy)
//   /tmp/cdpcc-port-<port>.lock/pid       (旧 cdpcc)
//
// CLI 用法:
//   node zcode-cdp-lease.js reserve [kind] [preferredPort]
//     → JSON: {port, leaseId} 或 {error: ...}
//   node zcode-cdp-lease.js release <port> <leaseId>
//     → JSON: {ok: true} 或 {error: ...}
//   node zcode-cdp-lease.js mark-active <port> <leaseId> <browserPid>
//   node zcode-cdp-lease.js check <port>           → JSON: {busy: bool, reason: ...}
//   node zcode-cdp-lease.js reap                   → JSON: {reaped: [...]}
//   node zcode-cdp-lease.js status                 → JSON: [{port, state, ...}]

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

// ---- 可测试性：环境覆盖，生产默认不变 ----
// env 数值解析 fail-loud：非法值点名报错退出，绝不静默回退默认掩盖配置错误
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v)) {
    process.stderr.write(`[lease] 环境变量 ${name} 非法(需整数): "${raw}"\n`);
    process.exit(1);
  }
  return v;
}

function portsEnv(name, fallback) {
  const raw = process.env[name] === undefined || process.env[name] === "" ? fallback : process.env[name];
  const ports = raw.split(/\s+/).filter(Boolean).map(Number);
  if (!ports.length || ports.some(p => !Number.isInteger(p))) {
    process.stderr.write(`[lease] 环境变量 ${name} 非法(需空格分隔端口号): "${raw}"\n`);
    process.exit(1);
  }
  return ports;
}

const LOCK_ROOT = process.env.CDP_LOCK_ROOT || "/tmp/zcode-cdp/ports";
const SHARED_PORTS = portsEnv("CDP_PORTS", "9223 9224 9225 9226 9227 9228 9229");
const SCRIPT_PORTS = portsEnv("CDP_SCRIPT_PORTS", "9324 9326");
// 默认须 >= cdp-takeover 自身 15s 监听预算；首启整 profile rsync(分钟级)靠持有者 hb 心跳兜底
const STARTUP_GRACE_MS = intEnv("CDP_STARTUP_GRACE_MS", 15000);

// ---- 工具函数 ----
function nowISO() { return new Date().toISOString(); }

function portPid(port) {
  try {
    const out = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -P -n -t 2>/dev/null`, { encoding: "utf8" });
    return out.split("\n").filter(Boolean)[0] || "";
  } catch { return ""; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidCommand(pid) {
  if (!pid) return "";
  try { return execSync(`ps -p ${pid} -o command= 2>/dev/null`, { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

function isAgentChromePid(pid) {
  return pidCommand(pid).includes("chrome-takeover");
}

// 获取进程启动时间（秒级 epoch），用于防 PID 复用
function pidStartTime(pid) {
  try {
    // macOS: ps -p PID -o lstart= → "Mon Jul 10 10:00:00 2026"
    const lstart = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: "utf8" }).trim();
    return String(Math.floor(new Date(lstart).getTime() / 1000));
  } catch { return ""; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomLeaseId() {
  return require("crypto").randomBytes(8).toString("hex");
}

// ---- 锁路径 ----
function lockPath(port) { return path.join(LOCK_ROOT, `${port}.lock`); }
function ownerPath(port) { return path.join(lockPath(port), "owner.json"); }

function readOwner(port) {
  try {
    const raw = fs.readFileSync(ownerPath(port), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

function writeOwner(port, owner) {
  owner.updatedAt = nowISO();
  fs.writeFileSync(ownerPath(port), JSON.stringify(owner, null, 2));
}

// ---- 旧锁兼容（只读） ----
function readLegacyLockPid(port) {
  // 旧 proxy 锁
  try {
    return String(fs.readFileSync(`/tmp/zcode-cdp-port-${port}.lock/pid`, "utf8")).trim();
  } catch {}
  // 旧 cdpcc 锁
  try {
    return String(fs.readFileSync(`/tmp/cdpcc-port-${port}.lock/pid`, "utf8")).trim();
  } catch {}
  return "";
}

// owner 进程身份校验：PID 存活 + 启动时间匹配（或 command marker 匹配）
function ownerPidValid(pid, expectedStartTime, marker) {
  if (!pid || !pidAlive(pid)) return false;
  // 优先用启动时间校验（最准确防 PID 复用）
  if (expectedStartTime) {
    const actual = pidStartTime(pid);
    if (actual && actual === expectedStartTime) {
      if (marker && !pidCommand(pid).includes(marker)) return false;
      return true;
    }
    // 启动时间不匹配 → PID 被复用
    if (actual && actual !== expectedStartTime) return false;
  }
  // 回退到 command marker
  if (marker) return pidCommand(pid).includes(marker);
  return true; // 无校验条件，只看 PID 存活
}

// ---- 端口忙判定（含 listener + 新 lease + 旧锁 + durable Chrome） ----
// 返回: { busy: bool, reason: string, ownerKind?: string }
//   stale/zombie 时附 owner: 判定时的 owner.json 快照(null=裸锁)，供删除前复核防 TOCTOU
function checkPort(port) {
  // 1. 端口有 listener
  const listener = portPid(port);
  if (listener) {
    if (isAgentChromePid(listener)) {
      // 有 Agent Chrome 监听：lease 且 owner 有效 → active；有锁但 owner 无效 →
      // SIGKILL 崩溃残留，可回收；完全无锁 → 人工 durable 合法占用，绝不抢占
      const owner = readOwner(port);
      if (owner && ownerPidValid(owner.ownerPid, owner.ownerStartTime, owner.kind)) {
        return { busy: true, reason: `active lease (owner ${owner.kind} PID ${owner.ownerPid})`, ownerKind: owner.kind, leaseState: owner.state };
      }
      if (owner || fs.existsSync(lockPath(port))) {
        return {
          busy: false,
          reason: `stale lease (owner ${owner ? `PID ${owner.ownerPid} dead/reused` : "no owner.json"}, agent chrome PID ${listener} still listening)`,
          ownerKind: "orphan", stale: true, owner: owner || null,
        };
      }
      return { busy: true, reason: `durable Agent Chrome (PID ${listener}, no lease)`, ownerKind: "durable" };
    }
    // 非 Agent listener。但如果有本系统的 lease(owner 存活)在管理这个端口,
    // 仍应报告 lease 状态(否则 status 会把活跃 lease 报成 external)。
    const owner = readOwner(port);
    if (owner && ownerPidValid(owner.ownerPid, owner.ownerStartTime, owner.kind)) {
      return { busy: true, reason: `active lease (owner ${owner.kind} PID ${owner.ownerPid}, listener ${listener} non-agent)`, ownerKind: owner.kind, leaseState: owner.state };
    }
    return { busy: true, reason: `non-agent listener (PID ${listener}: ${pidCommand(listener).slice(0, 60)})`, ownerKind: "external" };
  }

  // 2. 新 lease 存在且 owner 存活
  const owner0 = readOwner(port);
  if (owner0) {
    if (ownerPidValid(owner0.ownerPid, owner0.ownerStartTime, owner0.kind)) {
      // owner 活着。锁龄基准 = max(hbAt, createdAt)：ENSURING 期间 proxy 持续心跳，
      // 首启整 profile rsync(分钟级)也不会超宽限被误判 zombie；缺 hbAt 回退 createdAt
      const hbMs = typeof owner0.hbAt === "number" ? owner0.hbAt : 0;
      const createdMs = new Date(owner0.createdAt).getTime();
      const age = Date.now() - Math.max(hbMs, Number.isFinite(createdMs) ? createdMs : 0);
      if (age < STARTUP_GRACE_MS) {
        return { busy: true, reason: `lease starting (owner ${owner0.kind} PID ${owner0.ownerPid}, ${Math.round(age / 1000)}s)`, ownerKind: owner0.kind };
      }
      // 超过宽限期但端口无 listener → 可能是 zombie（owner 活但 Chrome 死了）
      // 不直接判定为空闲；返回 zombie 标记，由调用方决定是否回收
      return { busy: false, reason: `zombie lease (owner ${owner0.kind} PID ${owner0.ownerPid} alive but no listener, ${Math.round(age / 1000)}s since last hb/created)`, ownerKind: owner0.kind, zombie: true, owner: owner0 };
    }
    // owner 已死或 PID 复用 → 孤儿 lease，可回收
    return { busy: false, reason: `stale lease (owner PID ${owner0.ownerPid} dead/reused)`, ownerKind: "orphan", stale: true, owner: owner0 };
  }

  // 2.5 裸锁（mkdir 后写 owner 前被杀）：宽限期内当忙，超期可回收
  if (fs.existsSync(lockPath(port))) {
    let ageMs = 0;
    try { ageMs = Date.now() - fs.statSync(lockPath(port)).mtimeMs; } catch {}
    if (ageMs >= STARTUP_GRACE_MS) {
      return { busy: false, reason: `stale bare lock (no owner.json, ${Math.round(ageMs / 1000)}s old)`, ownerKind: "orphan", stale: true, owner: null };
    }
    return { busy: true, reason: `bare lock creating (no owner.json, ${Math.round(ageMs / 1000)}s)`, ownerKind: "creating" };
  }

  // 3. 旧锁兼容
  const legacyPid = readLegacyLockPid(port);
  if (legacyPid) {
    // 检查旧 proxy 锁
    if (pidAlive(legacyPid) && pidCommand(legacyPid).includes("zcode-cdp-proxy")) {
      // 旧 owner 活着。如果在启动宽限期内 → 忙；否则 zombie
      return { busy: true, reason: `legacy proxy lock (PID ${legacyPid})`, ownerKind: "legacy-proxy" };
    }
    if (pidAlive(legacyPid) && pidCommand(legacyPid).includes("cdpcc")) {
      return { busy: true, reason: `legacy cdpcc lock (PID ${legacyPid})`, ownerKind: "legacy-cdpcc" };
    }
    // 旧 owner 死了 → 可回收（legacy 锁不在 LOCK_ROOT、无 leaseId 可复核，走 legacy 直删）
    return { busy: false, reason: `legacy stale lock (PID ${legacyPid} dead)`, ownerKind: "legacy-orphan", stale: true, legacy: true };
  }

  return { busy: false, reason: "free", ownerKind: "free" };
}

// ---- 原子抢锁 ----
function ensureLockRoot() {
  try { fs.mkdirSync(LOCK_ROOT, { recursive: true }); } catch {}
}

function tryMkdir(port) {
  ensureLockRoot();
  try {
    fs.mkdirSync(lockPath(port), { recursive: false });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

// 安全删除锁目录：只有 owner.json 中的 leaseId 匹配时才删
function removeLockIfOwner(port, leaseId) {
  const owner = readOwner(port);
  if (!owner) {
    // 无 owner.json：可能是 mkdir 后崩溃。检查锁龄
    try {
      const stat = fs.statSync(lockPath(port));
      if (Date.now() - stat.mtimeMs > STARTUP_GRACE_MS) {
        fs.rmSync(lockPath(port), { recursive: true });
        return true;
      }
    } catch {}
    return false;
  }
  if (owner.leaseId !== leaseId) return false;
  try { fs.rmSync(lockPath(port), { recursive: true }); return true; } catch { return false; }
}

// 强制删除孤儿锁：删除前重读 owner.json，仍与判定时的快照(leaseId+ownerPid；
// null=判定时是裸锁)一致才删——判定与删除之间隔着秒级 kill 等待，不一致说明已有
// 新 owner 接管，放弃删除让上层换端口/重试，绝不删新锁
function forceRemoveOrphanLock(port, judgedOwner) {
  const owner = readOwner(port);
  if (judgedOwner) {
    if (!owner) return false;
    if (String(owner.leaseId) !== String(judgedOwner.leaseId)) return false;
    if (String(owner.ownerPid) !== String(judgedOwner.ownerPid)) return false;
  } else if (owner) {
    return false;
  }
  try { fs.rmSync(lockPath(port), { recursive: true }); return true; } catch { return false; }
}

// 删除旧锁（兼容迁移）
function removeLegacyLock(port) {
  try { fs.rmSync(`/tmp/zcode-cdp-port-${port}.lock`, { recursive: true }); } catch {}
  try { fs.rmSync(`/tmp/cdpcc-port-${port}.lock`, { recursive: true }); } catch {}
}

// 安全关闭 Agent Chrome：SIGTERM → 等待 → SIGKILL
async function killAgentChrome(port) {
  let pid = portPid(port);
  if (!pid) return;
  if (!isAgentChromePid(pid)) {
    try { process.stderr.write(`[lease] 端口 ${port} listener PID ${pid} 非 Agent Chrome,不杀\n`); } catch {}
    return; // 非 Agent 永不杀
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const cur = portPid(port);
    if (!cur) return;
    if (i === 0) {
      try { process.stderr.write(`[lease] 端口 ${port} SIGTERM 后 300ms 仍在监听(PID ${cur}),继续等待\n`); } catch {}
    }
  }
  pid = portPid(port);
  if (pid && isAgentChromePid(pid)) {
    try { process.stderr.write(`[lease] 端口 ${port} SIGTERM 超时 3s → SIGKILL PID ${pid}\n`); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

// ---- 核心 API ----

// 领取一个空闲端口租约
// kind: "zcode-cdp-proxy"（owner 必须是常驻进程，pid 会一直活到 lease 结束）
//   "cdpcc" 已下线：短命 CLI 的 pid 写进 owner.json 后进程即退出，租约出生即
//   孤儿被抢，直接拒绝返回 null
// 返回: { port, leaseId } 或 null（端口池满）
async function reserve(kind = "zcode-proxy", preferredPort = null) {
  if (kind === "cdpcc") return null;
  if (preferredPort !== null && preferredPort !== undefined) {
    if (!Number.isInteger(preferredPort)) {
      throw new Error(`reserve 端口参数非法(需整数端口号): ${preferredPort}`);
    }
    if (!SHARED_PORTS.includes(preferredPort)) {
      throw new Error(`端口 ${preferredPort} 不在池 ${Math.min(...SHARED_PORTS)}-${Math.max(...SHARED_PORTS)}`);
    }
  }
  const pid = process.pid;
  const startTime = pidStartTime(pid);
  const leaseId = randomLeaseId();

  const candidates = preferredPort ? [preferredPort] : SHARED_PORTS;

  for (const port of candidates) {
    const status = checkPort(port);
    if (status.busy) continue;

    // 孤儿/stale/zombie → 先回收再抢
    if (status.stale) {
      // owner 已死 → 清孤儿 Chrome + 删旧锁（删前复核仍是被判定的那把锁；
      // legacy stale 的锁不在 LOCK_ROOT、无 leaseId 可复核，直接删 v0.1.0 残留）
      await killAgentChrome(port);
      if (status.legacy) {
        removeLegacyLock(port);
      } else {
        if (!forceRemoveOrphanLock(port, status.owner || null)) continue;
        removeLegacyLock(port);
      }
    } else if (status.zombie) {
      // owner 活但 Chrome 死了 → 这是 zombie。不能只删锁；
      // 先终止 zombie owner，再清锁。
      const owner = status.owner;
      if (owner && owner.ownerPid && pidAlive(owner.ownerPid)) {
        try { process.kill(owner.ownerPid, "SIGTERM"); } catch {}
        // 等待退出
        for (let i = 0; i < 20; i++) {
          await sleep(200);
          if (!pidAlive(owner.ownerPid)) break;
        }
        if (pidAlive(owner.ownerPid)) {
          try { process.kill(owner.ownerPid, "SIGKILL"); } catch {}
        }
      }
      if (!forceRemoveOrphanLock(port, owner || null)) continue;
    }

    // 原子抢锁
    if (!tryMkdir(port)) continue;

    // 写 owner.json
    const owner = {
      version: 1,
      port,
      kind,
      leaseId,
      ownerPid: pid,
      ownerStartTime: startTime,
      state: "reserved",
      browserPid: null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    try {
      writeOwner(port, owner);
    } catch (e) {
      // 写 metadata 失败 → 回滚
      try { fs.rmSync(lockPath(port), { recursive: true }); } catch {}
      continue;
    }

    return { port, leaseId };
  }

  return null;
}

// 标记 lease 为 active（Chrome 已启动）
function markActive(port, leaseId, browserPid) {
  const owner = readOwner(port);
  if (!owner || owner.leaseId !== leaseId) return false;
  owner.state = "active";
  owner.browserPid = browserPid || null;
  writeOwner(port, owner);
  return true;
}

// 心跳：持有者（ENSURING 期间的 proxy）刷新 hbAt，zombie 判定基准取 max(hbAt, createdAt)
function hb(port, leaseId) {
  const owner = readOwner(port);
  if (!owner || owner.leaseId !== leaseId) return false;
  owner.hbAt = Date.now();
  writeOwner(port, owner);
  return true;
}

// 释放 lease（必须 leaseId 匹配）
async function release(port, leaseId) {
  const owner = readOwner(port);
  if (!owner || owner.leaseId !== leaseId) return false;

  // 先杀 Chrome（如果有 listener）
  await killAgentChrome(port);

  // 再删锁（核对 leaseId）
  removeLockIfOwner(port, leaseId);
  return true;
}

// 回收所有孤儿（启动期 / 手动触发）
async function reap() {
  const reaped = [];
  const allPorts = [...new Set(SHARED_PORTS)];
  for (const port of allPorts) {
    const status = checkPort(port);
    if (status.stale) {
      await killAgentChrome(port);
      // 删除前复核仍是被判定的那把锁；已被新 owner 接管则本轮跳过；
      // legacy stale 的锁不在 LOCK_ROOT、无 leaseId 可复核，直接删 v0.1.0 残留
      if (status.legacy) {
        removeLegacyLock(port);
        reaped.push({ port, reason: status.reason });
      } else if (forceRemoveOrphanLock(port, status.owner || null)) {
        removeLegacyLock(port);
        reaped.push({ port, reason: status.reason });
      }
    } else if (status.zombie) {
      const owner = status.owner;
      if (owner && owner.ownerPid && pidAlive(owner.ownerPid)) {
        try { process.kill(owner.ownerPid, "SIGTERM"); } catch {}
        for (let i = 0; i < 20; i++) { await sleep(200); if (!pidAlive(owner.ownerPid)) break; }
        if (pidAlive(owner.ownerPid)) { try { process.kill(owner.ownerPid, "SIGKILL"); } catch {} }
      }
      if (forceRemoveOrphanLock(port, owner || null)) {
        reaped.push({ port, reason: status.reason });
      }
    }
  }
  return reaped;
}

// 打印全部端口状态
function statusAll() {
  const allPorts = [...new Set([...SHARED_PORTS, ...SCRIPT_PORTS])];
  return allPorts.map(port => {
    const s = checkPort(port);
    const owner = readOwner(port);
    const listener = portPid(port);
    return {
      port,
      busy: s.busy,
      reason: s.reason,
      ownerKind: s.ownerKind,
      listenerPid: listener || null,
      ownerPid: owner ? owner.ownerPid : null,
      leaseState: owner ? owner.state : null,
    };
  });
}

// ---- CLI ----
if (require.main === module) {
  const cmd = process.argv[2];
  function out(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

  (async () => {
    switch (cmd) {
      case "reserve": {
        // kind 需是 owner 进程命令行的子串(ownerPidValid 用它做 marker 校验)
        const kind = process.argv[3] || "zcode-cdp-proxy";
        if (kind === "cdpcc") { out({ error: "cdpcc 入口已下线,不再发放租约" }); process.exit(1); }
        const portArg = process.argv[4];
        const preferred = portArg ? Number(portArg) : null;
        const r = await reserve(kind, preferred);
        if (r) out(r);
        else out({ error: "CDP 端口池已满(7 个会话全在用 9223-9229),关掉一个会话再重试" });
        break;
      }
      case "release": {
        const port = parseInt(process.argv[3], 10);
        const leaseId = process.argv[4];
        const r = await release(port, leaseId);
        out({ ok: r });
        break;
      }
      case "mark-active": {
        const port = parseInt(process.argv[3], 10);
        const leaseId = process.argv[4];
        const browserPid = process.argv[5] ? parseInt(process.argv[5], 10) : null;
        const r = markActive(port, leaseId, browserPid);
        out({ ok: r });
        break;
      }
      case "check": {
        const port = parseInt(process.argv[3], 10);
        out(checkPort(port));
        break;
      }
      case "reap": {
        const r = await reap();
        out({ reaped: r });
        break;
      }
      case "status": {
        out(statusAll());
        break;
      }
      case "kill-chrome": {
        const port = parseInt(process.argv[3], 10);
        await killAgentChrome(port);
        out({ ok: true });
        break;
      }
      default:
        out({ error: `unknown command: ${cmd}. Available: reserve, release, mark-active, check, reap, status, kill-chrome` });
        process.exit(1);
    }
  })().catch(e => { out({ error: e.message }); process.exit(1); });
}

module.exports = {
  SHARED_PORTS, SCRIPT_PORTS, LOCK_ROOT,
  portPid, pidAlive, pidCommand, isAgentChromePid, pidStartTime,
  checkPort, reserve, release, markActive, hb, reap, statusAll,
  killAgentChrome, removeLockIfOwner, readOwner, writeOwner,
  readLegacyLockPid, removeLegacyLock, sleep, log: null,
};
