// harness — 极简顺序测试辅助(零依赖,node>=18)
// 用法:
//   const { step, run, assert, sleep, afterAll } = require("./lib/harness");
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
    try { await fn(); } catch {}
  }
  console.log(failed ? `\n❌ ${failed} step(s) FAILED` : "\n✅ all steps passed");
  process.exit(failed ? 1 : 0);
}

module.exports = { step, run, afterAll, assert, sleep };
