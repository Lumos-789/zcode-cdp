#!/usr/bin/env node
// L1 — zcode-cdp-lease 单元回测(无 Chrome,临时 CDP_LOCK_ROOT 隔离)
// 直接 require lease 模块调用 API:reserve 的 owner = 本测试进程(常驻存活),
// 与生产语义一致(proxy 也是常驻进程持锁);CLI 通道另用只读 status 冒烟。
// 覆盖:reserve → check → mark-active → release → re-reserve 生命周期,
// stale(孤儿)/zombie 两种异常锁的判定与回收,以及本轮修复的行为钉子:
//   F1   kind=cdpcc 库调用/CLI 均拒发租约
//   F2   hb 心跳:hbAt 毫秒 epoch + 归属校验;zombie 基准 = max(hbAt, createdAt)
//   F6   有锁+owner 死+Agent Chrome 在监听 → stale 可回收
//   F6   无锁+Agent Chrome 在监听 → durable busy 红线(reap 不收/不杀,reserve 不抢占)
//   F7   TOCTOU:kill 等待窗口内 owner 换人 → 删前复核放弃(reap 不收/reserve 换端口)
//   F13  zombie 抢占:子进程 owner 停心跳超宽限 → reserve SIGTERM 杀 owner、锁回收、端口接管
//   F20  裸锁宽限期内 busy、超龄可回收;池外端口 throw;非法数值 env 模块加载期拒启
//   回归#1 旧 cdpcc/v0.1.0 legacy stale 锁:reserve 接管端口 + reap 回收(曾因删错路径永久阻塞)
//   原子性:两子进程并发 reserve 同池 → mkdir 原子抢占保证单赢家
// 端口全部 19xxx,不碰生产 9223-9229。
"use strict";

// 必须在 require lease 模块之前设置 env(模块加载时固化锁根与端口池)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn, spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const LOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-lease-test-"));
const ART = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-lease-art-"));
process.env.CDP_LOCK_ROOT = LOCK_ROOT;
process.env.CDP_PORTS = "19231 19232 19233";
process.env.CDP_SCRIPT_PORTS = "19324";

const L = require(path.join(REPO, "bin", "zcode-cdp-lease.js"));
const { step, run, afterAll, assert, sleep } = require("./lib/harness");

const LEASE_CLI = path.join(REPO, "bin", "zcode-cdp-lease.js");
const STUB_LISTENER = path.join(REPO, "test", "lib", "chrome-takeover-stub-listener.js");
const TERMPROOF_LISTENER = path.join(REPO, "test", "lib", "chrome-takeover-stub-listener-termproof.js");
const RACER = path.join(REPO, "test", "lib", "reserve-racer.js");
const OWNER = path.join(REPO, "test", "lib", "lease-owner.js");

const lockDir = port => path.join(LOCK_ROOT, `${port}.lock`);
const ownerFile = port => path.join(lockDir(port), "owner.json");
// kind 必须是本进程命令行的子串(ownerPidValid 的 marker 校验)
const KIND = "lease.test";

afterAll(async () => fs.rmSync(LOCK_ROOT, { recursive: true, force: true }));

// ---- 测试期子进程/监听器管理 ----
const spawned = [];
afterAll(async () => {
  for (const c of spawned) { try { c.kill("SIGKILL"); } catch {} }
  fs.rmSync(ART, { recursive: true, force: true });
});

function spawnListener(port, script = STUB_LISTENER, extraArgs = []) {
  const child = spawn(process.execPath, [script, String(port), ...extraArgs], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function waitListening(port, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (L.portPid(port)) return;
    await sleep(80);
  }
  throw new Error(`listener on ${port} never came up within ${timeoutMs}ms`);
}

async function waitFile(file, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(file)) return;
    await sleep(50);
  }
  throw new Error(`marker ${file} not written within ${timeoutMs}ms (SIGTERM never sent?)`);
}

async function waitExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(res => {
    const t = setTimeout(res, timeoutMs);
    child.once("exit", () => { clearTimeout(t); res(); });
  });
}

function childOutput(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error(`child output timeout(${timeoutMs}ms)`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", d => { buf += d; });
    child.on("error", e => { clearTimeout(t); reject(e); });
    child.on("exit", (code, signal) => { clearTimeout(t); resolve({ out: buf, code, signal }); });
  });
}

function firstJsonLine(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`first line timeout, buf=${buf}`)); } }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", d => {
      if (settled) return;
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        settled = true; clearTimeout(t);
        try { resolve(JSON.parse(buf.slice(0, i))); }
        catch (e) { reject(new Error(`bad json line: ${buf.slice(0, i)}`)); }
      }
    });
    child.on("exit", () => { if (!settled) { settled = true; clearTimeout(t); reject(new Error(`child exited before first line, buf=${buf}`)); } });
  });
}

// 伪造 owner.json(直写,不走 writeOwner,避免 updatedAt 干扰;删除复核只比对 leaseId+ownerPid)
function forgeOwner(port, fields) {
  fs.mkdirSync(lockDir(port), { recursive: true });
  const owner = {
    version: 1, port,
    kind: fields.kind || "zcode-cdp-proxy",
    leaseId: fields.leaseId,
    ownerPid: fields.ownerPid,
    ownerStartTime: fields.ownerStartTime || "",
    state: "reserved", browserPid: null,
    createdAt: fields.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (fields.hbAt !== undefined) owner.hbAt = fields.hbAt;
  fs.writeFileSync(ownerFile(port), JSON.stringify(owner, null, 2));
  return owner;
}

let r1, r2;

step("reserve 返回第一个端口 + leaseId", async () => {
  r1 = await L.reserve(KIND);
  assert.ok(r1, "reserve should succeed");
  assert.strictEqual(r1.port, 19231);
  assert.ok(typeof r1.leaseId === "string" && r1.leaseId.length >= 16);
});

step("端口被占后 reserve 顺延到下一端口", async () => {
  r2 = await L.reserve(KIND);
  assert.ok(r2, "reserve should succeed");
  assert.strictEqual(r2.port, 19232);
  assert.notStrictEqual(r2.leaseId, r1.leaseId);
});

step("check: 已租端口 busy(启动宽限期内)", async () => {
  const s = L.checkPort(19231);
  assert.strictEqual(s.busy, true, JSON.stringify(s));
  assert.ok(/lease starting/.test(s.reason), s.reason);
});

step("mark-active: 正确 leaseId 成功,错误 leaseId 拒绝", async () => {
  assert.strictEqual(L.markActive(19231, r1.leaseId, null), true);
  assert.strictEqual(L.markActive(19231, "deadbeef", null), false);
  const s = L.checkPort(19231);
  assert.strictEqual(s.busy, true);
});

step("release: 错误 leaseId 拒绝,正确 leaseId 成功且锁目录删除", async () => {
  assert.strictEqual(await L.release(19231, "deadbeef"), false);
  assert.ok(fs.existsSync(lockDir(19231)), "wrong leaseId must not release");
  assert.strictEqual(await L.release(19231, r1.leaseId), true);
  assert.ok(!fs.existsSync(lockDir(19231)), "lock dir should be removed after release");
});

step("release 后端口可再次被 reserve", async () => {
  const r = await L.reserve(KIND);
  assert.ok(r);
  assert.strictEqual(r.port, 19231, "released port should be reusable first");
  await L.release(r.port, r.leaseId);
});

step("check: 伪造死 PID owner → stale(孤儿)", async () => {
  fs.mkdirSync(lockDir(19233), { recursive: true });
  fs.writeFileSync(path.join(lockDir(19233), "owner.json"), JSON.stringify({
    version: 1, port: 19233, kind: KIND, leaseId: "orphan-lease",
    ownerPid: 999999, ownerStartTime: "", state: "reserved",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  const s = L.checkPort(19233);
  assert.strictEqual(s.busy, false, JSON.stringify(s));
  assert.strictEqual(s.stale, true);
});

step("reap: 回收孤儿锁", async () => {
  const reaped = await L.reap();
  assert.ok(reaped.some(x => x.port === 19233), JSON.stringify(reaped));
  assert.ok(!fs.existsSync(lockDir(19233)), "orphan lock dir should be reaped");
});

step("check: owner 存活但无 listener 且超宽限期 → zombie", async () => {
  // 只验证 check 语义;reserve 抢占通道的 kill-owner 路径由下方子进程 owner 用例覆盖
  try {
    fs.mkdirSync(lockDir(19233), { recursive: true });
    fs.writeFileSync(path.join(lockDir(19233), "owner.json"), JSON.stringify({
      version: 1, port: 19233, kind: KIND, leaseId: "zombie-lease",
      ownerPid: process.pid, ownerStartTime: "", state: "reserved",
      createdAt: new Date(Date.now() - 60000).toISOString(), // 60s 前,超默认宽限(现 15s)
      updatedAt: new Date().toISOString(),
    }));
    const s = L.checkPort(19233);
    assert.strictEqual(s.busy, false, JSON.stringify(s));
    assert.strictEqual(s.zombie, true, JSON.stringify(s));
  } finally {
    fs.rmSync(lockDir(19233), { recursive: true, force: true });
  }
});

step("zombie 抢占(F13): 子进程 owner 停心跳超宽限 → 另一子进程 reserve → owner 被 SIGTERM、锁回收、端口接管", async () => {
  const port = 19249;
  const env = { ...process.env, CDP_PORTS: String(port) };
  // owner 子进程真实 reserve 持锁(常驻且停止心跳);默认宽限内应判 lease starting
  const owner = spawn(process.execPath, [OWNER, String(port)], { env });
  spawned.push(owner);
  const o = await firstJsonLine(owner);
  assert.ok(o && o.port === port, `owner 子进程应持锁 ${port}: ${JSON.stringify(o)}`);
  const grace = L.checkPort(port);
  assert.strictEqual(grace.busy, true, JSON.stringify(grace));
  assert.ok(/lease starting/.test(grace.reason), grace.reason);
  // 接管者注入 1ms 宽限:owner 心跳已停 → 立即超龄判 zombie,走 SIGTERM 杀 owner 分支
  const taker = spawn(process.execPath, [LEASE_CLI, "reserve", "zcode-cdp-proxy"],
    { env: { ...env, CDP_STARTUP_GRACE_MS: "1" } });
  spawned.push(taker);
  const { out, code } = await childOutput(taker, 20000);
  assert.strictEqual(code, 0, out);
  const res = JSON.parse(out.trim().split("\n").pop());
  assert.ok(res.port === port && res.leaseId, `reserve 应接管 zombie 端口 ${port}: ${out}`);
  await waitExit(owner, 5000);
  assert.strictEqual(owner.signalCode, "SIGTERM",
    `owner 应被 zombie 分支第一发 SIGTERM 终止,实际 code=${owner.exitCode} signal=${owner.signalCode}`);
  // 旧锁已删、新锁已建:owner.json 易主为接管者(非 owner 子进程、非本测试进程)
  const newOwner = L.readOwner(port);
  assert.ok(newOwner, "接管后锁应存在");
  assert.strictEqual(String(newOwner.ownerPid), String(taker.pid), `锁应易主为接管者 PID: ${JSON.stringify(newOwner)}`);
  assert.strictEqual(newOwner.leaseId, res.leaseId, "锁内 leaseId 须是接管者的");
  fs.rmSync(lockDir(port), { recursive: true, force: true });
});

step("statusAll: 汇总所有池内端口(CLI 通道冒烟)", async () => {
  const arr = L.statusAll();
  const ports = arr.map(x => x.port).sort();
  assert.deepStrictEqual(ports, [19231, 19232, 19233, 19324], JSON.stringify(ports));
  // CLI 出口只读冒烟(status):保证命令行通道可用
  const out = execFileSync("node", [path.join(REPO, "bin", "zcode-cdp-lease.js"), "status"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  const cliArr = JSON.parse(out.trim().split("\n").pop());
  assert.strictEqual(cliArr.length, 4, "CLI status should list all ports");
});

step("reserve 池满 → 返回 null", async () => {
  // 从干净锁根开始(不依赖前序 step 的残留状态)
  for (const d of fs.readdirSync(LOCK_ROOT)) fs.rmSync(path.join(LOCK_ROOT, d), { recursive: true, force: true });
  const held = [];
  for (const p of [19231, 19232, 19233]) held.push(await L.reserve(KIND));
  assert.ok(held.every(h => h && h.port), `all three reserves should succeed: ${JSON.stringify(held)}`);
  const full = await L.reserve(KIND);
  assert.strictEqual(full, null, "pool exhausted should return null");
  for (const h of held) await L.release(h.port, h.leaseId);
});

step("removeLockIfOwner: leaseId 不匹配不动锁", async () => {
  const r = await L.reserve(KIND);
  assert.ok(r);
  assert.strictEqual(L.removeLockIfOwner(r.port, "deadbeef"), false);
  assert.ok(fs.existsSync(lockDir(r.port)), "non-owner must not remove lock");
  assert.strictEqual(L.removeLockIfOwner(r.port, r.leaseId), true);
  assert.ok(!fs.existsSync(lockDir(r.port)));
});

// ---- 本轮修复的行为钉子 ----

step("hb 心跳(F2): hbAt 毫秒 epoch + 归属校验;新鲜 hbAt 以 max 基准抑制 zombie", async () => {
  const r = await L.reserve(KIND);
  assert.ok(r);
  // 把 createdAt 拉到 60s 前(超默认 15s 宽限):owner 活 + 无 listener → 应判 zombie
  const owner = L.readOwner(r.port);
  owner.createdAt = new Date(Date.now() - 60000).toISOString();
  L.writeOwner(r.port, owner);
  let s = L.checkPort(r.port);
  assert.strictEqual(s.zombie, true, JSON.stringify(s));
  // 错误 leaseId 心跳被拒
  assert.strictEqual(L.hb(r.port, "deadbeef"), false);
  // 正确 leaseId 心跳:hbAt 是毫秒 epoch
  const before = Date.now();
  assert.strictEqual(L.hb(r.port, r.leaseId), true);
  const o2 = L.readOwner(r.port);
  assert.ok(typeof o2.hbAt === "number" && o2.hbAt >= before && o2.hbAt <= Date.now(),
    `hbAt 应为当前毫秒 epoch: ${o2.hbAt}`);
  // 心跳刷新后不再判 zombie(基准 = max(hbAt, createdAt),不单看 createdAt)
  s = L.checkPort(r.port);
  assert.strictEqual(s.busy, true, JSON.stringify(s));
  assert.ok(/lease starting/.test(s.reason), s.reason);
  await L.release(r.port, r.leaseId);
});

step("裸锁(F20): 宽限期内 busy(creating),超龄 → stale 可回收", async () => {
  const port = 19233;
  fs.mkdirSync(lockDir(port)); // mkdir 后、写 owner 前被杀的形态
  let s = L.checkPort(port);
  assert.strictEqual(s.busy, true, JSON.stringify(s));
  assert.strictEqual(s.ownerKind, "creating", JSON.stringify(s));
  assert.ok(/bare lock creating/.test(s.reason), s.reason);
  // 拉老锁目录 mtime 到 120s 前 → 超宽限,可回收
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockDir(port), old, old);
  s = L.checkPort(port);
  assert.strictEqual(s.busy, false, JSON.stringify(s));
  assert.strictEqual(s.stale, true, JSON.stringify(s));
  assert.strictEqual(s.owner, null, "裸锁的判定快照 owner 应为 null");
  assert.ok(/stale bare lock/.test(s.reason), s.reason);
  const reaped = await L.reap();
  assert.ok(reaped.some(x => x.port === port), JSON.stringify(reaped));
  assert.ok(!fs.existsSync(lockDir(port)), "超龄裸锁应被回收删除");
});

step("PID 复用防护: ownerPid 活但 ownerStartTime 失配 → 判 stale(dead/reused)", async () => {
  const port = 19233;
  forgeOwner(port, { leaseId: "reused-lease", ownerPid: process.pid, ownerStartTime: "12345", kind: KIND });
  const s = L.checkPort(port);
  assert.strictEqual(s.busy, false, JSON.stringify(s));
  assert.strictEqual(s.stale, true, JSON.stringify(s));
  assert.ok(/dead\/reused/.test(s.reason), s.reason);
  const reaped = await L.reap();
  assert.ok(reaped.some(x => x.port === port), JSON.stringify(reaped));
  assert.ok(!fs.existsSync(lockDir(port)), "复用失配锁应被回收删除");
});

step("stale 回收(F6): 有锁 + owner 死 + Agent Chrome 在监听 → stale,可回收", async () => {
  const port = 19233;
  const listener = spawnListener(port);
  await waitListening(port);
  forgeOwner(port, { leaseId: "crash-lease", ownerPid: 999995 });
  const s = L.checkPort(port);
  assert.strictEqual(s.busy, false, JSON.stringify(s));
  assert.strictEqual(s.stale, true, JSON.stringify(s));
  assert.strictEqual(s.owner && s.owner.leaseId, "crash-lease", "stale 判定须附 owner 快照");
  const reaped = await L.reap();
  assert.ok(reaped.some(x => x.port === port), JSON.stringify(reaped));
  assert.ok(!fs.existsSync(lockDir(port)), "崩溃残留锁应被回收删除");
  await waitExit(listener, 5000); // 残留 Agent Chrome 被 SIGTERM 回收
});

step("legacy stale 回收(回归#1 已修): 旧 cdpcc 残留锁 owner 死 → reserve 接管端口且删残留,reap 可回收", async () => {
  const port = 19233;
  const legacyDir = "/tmp/cdpcc-port-19233.lock";
  // 模拟 v0.1.0 cdpcc 残留锁:pid 指向已死进程(legacy 路径硬编码 /tmp,19233 为测试专用口)
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "pid"), "999998");
  try {
    const s = L.checkPort(port);
    assert.strictEqual(s.busy, false, JSON.stringify(s));
    assert.strictEqual(s.stale, true, JSON.stringify(s));
    assert.strictEqual(s.ownerKind, "legacy-orphan", JSON.stringify(s));
    assert.strictEqual(s.legacy, true, "legacy stale 须带 legacy 标记");
    // reserve 应回收 legacy 残留并接管端口(回归:曾因 forceRemoveOrphanLock 删 LOCK_ROOT 路径必失败而永久跳过)
    const r = await L.reserve(KIND, port);
    assert.ok(r && r.port === port, `reserve 应接管 legacy stale 端口: ${JSON.stringify(r)}`);
    assert.ok(!fs.existsSync(legacyDir), "legacy 残留锁应被删除");
    assert.ok(fs.existsSync(ownerFile(port)), "新锁应建立");
    await L.release(r.port, r.leaseId);
    // reap 通道同样可回收 legacy 残留
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, "pid"), "999998");
    const reaped = await L.reap();
    assert.ok(reaped.some(x => x.port === port), JSON.stringify(reaped));
    assert.ok(!fs.existsSync(legacyDir), "reap 应删除 legacy 残留锁");
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
    fs.rmSync(lockDir(port), { recursive: true, force: true });
  }
});

step("durable 红线(F6): 无锁 + Agent Chrome 在监听 → busy,reap 不收/不杀,reserve 不抢占", async () => {
  const port = 19246;
  const listener = spawnListener(port);
  await waitListening(port);
  const s = L.checkPort(port);
  assert.strictEqual(s.busy, true, JSON.stringify(s));
  assert.strictEqual(s.ownerKind, "durable", JSON.stringify(s));
  assert.ok(/durable Agent Chrome/.test(s.reason), s.reason);
  const env = { ...process.env, CDP_PORTS: String(port) };
  const reapR = spawnSync(process.execPath, [LEASE_CLI, "reap"], { encoding: "utf8", env });
  const reaped = JSON.parse(reapR.stdout.trim().split("\n").pop()).reaped;
  assert.deepStrictEqual(reaped.filter(x => x.port === port), [], `durable 不得被 reap: ${reapR.stdout}`);
  const resR = spawnSync(process.execPath, [LEASE_CLI, "reserve", "zcode-cdp-proxy"], { encoding: "utf8", env });
  const res = JSON.parse(resR.stdout.trim().split("\n").pop());
  assert.ok(res.error && /端口池已满/.test(res.error), `单口池被 durable 占用时 reserve 应报池满: ${resR.stdout}`);
  assert.ok(!fs.existsSync(lockDir(port)), "durable 端口不得建锁抢占");
  assert.ok(L.pidAlive(listener.pid), "durable listener 绝不能被杀(红线)");
  listener.kill("SIGKILL");
  await waitExit(listener, 3000);
});

step("TOCTOU 复核(F7,reap 通道): kill 等待窗口内 owner 换人 → 删前放弃,新 owner 锁完好", async () => {
  const port = 19243;
  forgeOwner(port, { leaseId: "victim-lease", ownerPid: 999997 });
  const marker = path.join(ART, "term-19243-reap.marker");
  spawnListener(port, TERMPROOF_LISTENER, [marker]);
  await waitListening(port);
  const judged = L.checkPort(port);
  assert.strictEqual(judged.stale, true, JSON.stringify(judged));
  assert.strictEqual(judged.owner && judged.owner.leaseId, "victim-lease", JSON.stringify(judged));
  // 子进程走 CLI reap(单口池);等 SIGTERM marker 出现(判定阶段已结束、kill 窗口已开)
  // 再换 owner.json —— 模拟「判定与删除之间隔秒级 kill 等待,新 owner 完成接管」
  const child = spawn(process.execPath, [LEASE_CLI, "reap"], { env: { ...process.env, CDP_PORTS: String(port) } });
  spawned.push(child);
  const done = childOutput(child, 20000);
  await waitFile(marker, 8000);
  forgeOwner(port, { leaseId: "usurper-lease", ownerPid: 424242 });
  const { out, code } = await done;
  assert.strictEqual(code, 0, out);
  const parsed = JSON.parse(out.trim().split("\n").pop());
  assert.ok(!parsed.reaped.some(x => x.port === port), `不得回收已换 owner 的端口: ${out}`);
  const owner = L.readOwner(port);
  assert.ok(owner && owner.leaseId === "usurper-lease", "新 owner 的锁不得被删");
  assert.ok(fs.existsSync(lockDir(port)), "锁目录必须保留");
  fs.rmSync(lockDir(port), { recursive: true, force: true });
});

step("TOCTOU 复核(F7,reserve 通道): kill 等待窗口内 owner 换人 → 放弃该端口换下一端口", async () => {
  const victimPort = 19243, nextPort = 19244;
  forgeOwner(victimPort, { leaseId: "victim2-lease", ownerPid: 999996 });
  const marker = path.join(ART, "term-19243-reserve.marker");
  spawnListener(victimPort, TERMPROOF_LISTENER, [marker]);
  await waitListening(victimPort);
  const judged = L.checkPort(victimPort);
  assert.strictEqual(judged.stale, true, JSON.stringify(judged));
  const child = spawn(process.execPath, [LEASE_CLI, "reserve", "zcode-cdp-proxy"],
    { env: { ...process.env, CDP_PORTS: `${victimPort} ${nextPort}` } });
  spawned.push(child);
  const done = childOutput(child, 20000);
  await waitFile(marker, 8000);
  forgeOwner(victimPort, { leaseId: "usurper2-lease", ownerPid: 424243 });
  const { out, code } = await done;
  assert.strictEqual(code, 0, out);
  const res = JSON.parse(out.trim().split("\n").pop());
  assert.ok(res.port && res.leaseId, `reserve 应成功: ${out}`);
  assert.strictEqual(res.port, nextPort, `应换到下一端口: ${out}`);
  const owner = L.readOwner(victimPort);
  assert.ok(owner && owner.leaseId === "usurper2-lease", "victim 端口的新 owner 锁不得被删");
  assert.ok(fs.existsSync(lockDir(victimPort)), "锁目录必须保留");
  fs.rmSync(lockDir(victimPort), { recursive: true, force: true });
  fs.rmSync(lockDir(nextPort), { recursive: true, force: true });
});

step("并发 reserve 竞态: 两子进程抢同池 → mkdir 原子性保证单赢家", async () => {
  const port = 19741;
  const env = { ...process.env, CDP_PORTS: String(port) };
  const c1 = spawn(process.execPath, [RACER], { env });
  const c2 = spawn(process.execPath, [RACER], { env });
  spawned.push(c1, c2);
  const [o1, o2] = await Promise.all([firstJsonLine(c1), firstJsonLine(c2)]);
  const results = [o1, o2];
  const winners = results.filter(x => x && x.port);
  assert.strictEqual(winners.length, 1, `恰好一个赢家,实际 ${JSON.stringify(results)}`);
  assert.strictEqual(results.filter(x => !x || !x.port).length, 1, "另一个必须是 null(池满)");
  const winnerChild = (o1 && o1.port) ? c1 : c2;
  const owner = L.readOwner(port);
  assert.ok(owner, "赢家锁的 owner.json 必须存在");
  assert.strictEqual(owner.leaseId, winners[0].leaseId, "锁内 leaseId 必须是赢家的");
  assert.strictEqual(owner.ownerPid, winnerChild.pid, "锁内 ownerPid 必须是赢家进程");
  for (const c of [c1, c2]) c.kill("SIGKILL");
  await Promise.all([waitExit(c1, 3000), waitExit(c2, 3000)]);
  fs.rmSync(lockDir(port), { recursive: true, force: true });
});

step("fail-loud(F1/F20): cdpcc 拒发(库+CLI)、池外端口 throw、非法 env 拒启", async () => {
  assert.strictEqual(await L.reserve("cdpcc"), null, "kind=cdpcc 库调用必须直接拒发");
  const cli = spawnSync(process.execPath, [LEASE_CLI, "reserve", "cdpcc"], { encoding: "utf8", env: { ...process.env } });
  assert.strictEqual(cli.status, 1, "CLI reserve cdpcc 必须 exit 1");
  assert.ok(/cdpcc 入口已下线/.test(cli.stdout), cli.stdout);
  // 池外端口:fail-loud throw,消息按生效池区间点名
  await assert.rejects(L.reserve(KIND, 9225), /端口 9225 不在池 19231-19233/);
  await assert.rejects(L.reserve(KIND, "abc"), /端口参数非法/);
  // 非法数值 env:模块加载期拒启并点名变量
  const bad = spawnSync(process.execPath, [LEASE_CLI, "status"],
    { encoding: "utf8", env: { ...process.env, CDP_STARTUP_GRACE_MS: "abc" } });
  assert.strictEqual(bad.status, 1, "非法 env 必须拒启 exit 1");
  assert.ok(/CDP_STARTUP_GRACE_MS/.test(bad.stderr), bad.stderr);
});

run();
