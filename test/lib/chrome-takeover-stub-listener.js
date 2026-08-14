#!/usr/bin/env node
// chrome-takeover-stub-listener — 测试用假 "Agent Chrome" listener(仅测试用)
// 文件名故意含 "chrome-takeover":进程命令行(node .../chrome-takeover-stub-listener.js)
// 因此命中 lease 的 isAgentChromePid → release 链路会像杀真 Agent Chrome 一样
// SIGTERM 掉本进程,端口随之释放 —— 与生产语义一致,让 L2 能验证完整租约回收。
"use strict";

const port = parseInt(process.argv[2] || "0", 10);
if (!port) { console.error("usage: chrome-takeover-stub-listener <port>"); process.exit(1); }
require("net").createServer(s => s.end()).listen(port, "127.0.0.1");
