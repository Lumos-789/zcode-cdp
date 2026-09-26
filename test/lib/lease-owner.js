#!/usr/bin/env node
// lease-owner — 僵尸 owner 替身子进程(仅测试用)
// require 真实 lease reserve 持锁后单行 JSON 打 stdout 并常驻,且不再发 hb 心跳
// (模拟 proxy 卡死:owner 活着、端口无 listener、心跳停止 → 超宽限后另一进程
// reserve 时判 zombie 走 kill-owner 分支)。kind=文件名 "lease-owner":
// ownerPidValid 的 marker 校验要求 kind 是 owner 命令行的子串。不装 SIGTERM
// handler:zombie 分支第一发 SIGTERM 即退出,测试据 signalCode 断言击杀信号。
// 锁清理由父测试负责。argv[2]=端口(可选,传则 reserve 该端口)。
"use strict";

const path = require("path");
const L = require(path.join(__dirname, "..", "..", "bin", "zcode-cdp-lease.js"));

(async () => {
  const preferred = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  const r = await L.reserve("lease-owner", preferred);
  process.stdout.write(JSON.stringify(r) + "\n");
  setInterval(() => {}, 60000); // 常驻持锁,等被 SIGTERM
})().catch(e => { process.stderr.write(String((e && e.stack) || e) + "\n"); process.exit(1); });
