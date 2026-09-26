#!/usr/bin/env node
// reserve-racer — 并发 reserve 竞态测试的参赛子进程(仅测试用)
// require 真实 lease 模块 reserve,结果单行 JSON 打到 stdout 后保持存活 5s:
// 对手进程判定本锁时 owner 必须仍是活进程(若立刻退出,锁会因 owner 已死被判
// 孤儿回收,竞态测试退化为「先后」测试)。锁清理由父测试负责。
"use strict";

const path = require("path");
const L = require(path.join(__dirname, "..", "..", "bin", "zcode-cdp-lease.js"));

(async () => {
  const r = await L.reserve("reserve-racer");
  process.stdout.write(JSON.stringify(r) + "\n");
  await new Promise(res => setTimeout(res, 5000));
  process.exit(0);
})().catch(e => { process.stderr.write(String((e && e.stack) || e) + "\n"); process.exit(1); });
