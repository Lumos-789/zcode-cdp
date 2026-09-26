#!/usr/bin/env node
// chrome-takeover-stub-listener-termproof — SIGTERM 不退出的假 "Agent Chrome"(仅测试用)
// 文件名含 "chrome-takeover" → 命中 lease 的 isAgentChromePid;故意吞掉 SIGTERM,
// 把 killAgentChrome 的「SIGTERM → 等待 3s」窗口拉满,让测试能在「判定 stale 之后、
// 删锁之前」的窗口内换掉 owner.json,验证 forceRemoveOrphanLock 的删前复核(TOCTOU)。
// 收到 SIGTERM 时写 marker 文件(argv[2],测试据此得知判定阶段已结束、kill 窗口已开);
// lease 等待超时后 SIGKILL 本进程 —— 这是预期退出路径,测试收尾也 SIGKILL 兜底。
"use strict";

const fs = require("fs");
const port = parseInt(process.argv[2] || "0", 10);
const marker = process.argv[3] || "";
if (!port) { console.error("usage: chrome-takeover-stub-listener-termproof <port> [termMarkerFile]"); process.exit(1); }
process.on("SIGTERM", () => {
  if (marker) { try { fs.writeFileSync(marker, String(process.pid)); } catch {} }
  // 故意不退出:模拟优雅退出极慢的 Chrome,拉长 kill 等待窗口
});
require("net").createServer(s => s.end()).listen(port, "127.0.0.1");
