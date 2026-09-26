// harness — 极简顺序测试辅助(零依赖,node>=18)
// 用法:
//   const { step, run, assert, sleep, waitFor, afterAll } = require("./lib/harness");
//   step("名字", async () => { assert.ok(...) });
//   afterAll(async () => { /* 无论成败都执行的清理 */ });
//   run();
"use strict";

const assert = require("assert");

const steps = [];
const teardowns = [];
let failed = 0;

function step(name, fn) { steps.push([name, fn]); }
function afterAll(fn) { teardowns.push(fn); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 轮询等待条件成立(默认 100ms 一次):固定 sleep 硬断言在慢机上必 flake,
// 一律改 waitFor;超时抛错前再判一次,防"轮询间隙刚好错过"的边界竞态。
async function waitFor(condFn, timeoutMs = 8000, desc = "condition") {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (condFn()) return;
    await sleep(100);
  }
  if (condFn()) return;
  throw new Error(`timeout(${timeoutMs}ms) waiting for: ${desc}`);
}

async function run() {
  for (const [name, fn] of steps) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
    } catch (e) {
      failed++;
      console.error(`[FAIL] ${name}`);
      console.error(`       ${e && e.message ? e.message.split("\n")[0] : e}`);
    }
  }
  for (const fn of teardowns) {
    // 清理异常不再静默吞:打印后继续跑后续清理(吞掉会把资源泄漏伪装成通过)
    try { await fn(); } catch (e) {
      console.error(`[TEARDOWN-ERROR] ${e && e.stack ? e.stack : e}`);
    }
  }
  console.log(failed ? `\n❌ ${failed} step(s) FAILED` : "\n✅ all steps passed");
  process.exit(failed ? 1 : 0);
}

module.exports = { step, run, afterAll, assert, sleep, waitFor };
