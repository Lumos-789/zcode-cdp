#!/usr/bin/env node
// L1 — zcode-cdp-lease 单元回测(无 Chrome,临时 CDP_LOCK_ROOT 隔离)
// 直接 require lease 模块调用 API:reserve 的 owner = 本测试进程(常驻存活),
// 与生产语义一致(proxy/cdpcc 也是常驻进程持锁);CLI 通道另用只读 status 冒烟。
// 覆盖:reserve → check → mark-active → release → re-reserve 生命周期,
// 以及 stale(孤儿)/zombie 两种异常锁的判定与回收。
"use strict";

// 必须在 require lease 模块之前设置 env(模块加载时固化锁根与端口池)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const LOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-lease-test-"));
process.env.CDP_LOCK_ROOT = LOCK_ROOT;
process.env.CDP_PORTS = "19231 19232 19233";
process.env.CDP_SCRIPT_PORTS = "19324";

const L = require(path.join(REPO, "bin", "zcode-cdp-lease.js"));
const { step, run, afterAll, assert } = require("./lib/harness");

const lockDir = port => path.join(LOCK_ROOT, `${port}.lock`);
// kind 必须是本进程命令行的子串(ownerPidValid 的 marker 校验)
const KIND = "lease.test";

afterAll(async () => fs.rmSync(LOCK_ROOT, { recursive: true, force: true }));

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
  // 只验证 check 语义;zombie 的 reserve 抢占路径会 kill owner(=本进程),不能测
  try {
    fs.mkdirSync(lockDir(19233), { recursive: true });
    fs.writeFileSync(path.join(lockDir(19233), "owner.json"), JSON.stringify({
      version: 1, port: 19233, kind: KIND, leaseId: "zombie-lease",
      ownerPid: process.pid, ownerStartTime: "", state: "reserved",
      createdAt: new Date(Date.now() - 60000).toISOString(), // 60s 前,超 8s 宽限
      updatedAt: new Date().toISOString(),
    }));
    const s = L.checkPort(19233);
    assert.strictEqual(s.busy, false, JSON.stringify(s));
    assert.strictEqual(s.zombie, true, JSON.stringify(s));
  } finally {
    fs.rmSync(lockDir(19233), { recursive: true, force: true });
  }
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

run();
