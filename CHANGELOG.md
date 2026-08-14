# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **标准回测(回归验证)体系** — `npm test` 一键跑三层,零真实 Chrome 副作用(详见 `docs/backtest.md`)
  - **L0 静态自检**(`test/backtest.sh`):语法 + 契约 marker(`chrome-takeover` 运行时 marker、9223-9229 端口池、默认锁路径、bin 四入口)
  - **L1 租约单元**(`test/lease.test.js`):reserve → check → mark-active → release → re-reserve 生命周期 + stale/zombie 异常锁判定与回收 + leaseId 归属校验
  - **L2 状态机端到端**(`test/proxy.test.js`):stub 化 backend/takeover,覆盖 激活 → close → rearm → 再激活 → SIGTERM 清理 全链路
  - stub listener 文件名故意含 `chrome-takeover`,使 release 链路按真 Chrome 语义回收租约

### Fixed
- **proxy: `browser_close` 后 placeholder 未重新握手** — `restartPlaceholder()` 起的新占位 backend 是全新进程,而客户端只在连接建立时发一次 `initialize`;旧版 close 之后透传的 `tools/list` 等非浏览器请求会因 backend 未初始化而悬挂。现在 rearm 时用缓存的客户端参数补 synthetic initialize(回归用例:`proxy.test.js` 回归#1)
- **proxy: 释放期间到达的请求悬挂** — `CLOSE_PENDING`/`RELEASING` 缓冲的请求原先要等下一次激活才被 flush;现在 `releaseAfterClose()` 回 READY_IDLE 后立即重放(非 `browser_` 透传给新 placeholder,`browser_` 按 READY_IDLE 语义重新处理)(回归用例:回归#2)
- **cdp-takeover: `status` 循环变量残留** — `lease_pid`/`lease_state` 跨迭代不清空,单个活跃租约会把其后所有无锁端口误显示成"占位 lease=active"。每轮重置修复
- **cdpcc: 端口数量文案** — 注释/报错写"六个端口开不了第 7 个",实际池为 9223-9229 七个
- **lease: CLI 文档与实现不一致** — 头注释的 `reserve [--kind <kind>]` 改为实际位置参数 `reserve [kind] [preferredPort]`;CLI 默认 kind 统一为 `zcode-cdp-proxy`(与 proxy 实际传值一致)

### Changed
- proxy 清理只写不读的死代码(`placeholderInitialized`、`lastStdinTime`)

## [0.1.0] — 2026-08-02

### 🎉 First public release

Open-sourced the internal Chrome DevTools Protocol takeover framework that has been battle-tested in production for ~2 months against heavy anti-crawler Chinese platforms (Zhihu, Xiaohongshu, etc.).

### Added
- **Core scripts** (4 files, ~1800 lines total)
  - `bin/zcode-cdp-proxy.js` (979 LOC) — state-machine-driven lazy MCP proxy; spawns a placeholder backend so that N agent windows touching no browser = 0 Chrome processes
  - `bin/zcode-cdp-lease.js` (455 LOC) — unified port lease manager (atomic `mkdir` + `leaseId` ownership check) shared by proxy / cdpcc / cdp-takeover
  - `bin/cdp-takeover` (279 LOC) — boots/retakes a per-port real Chrome with profile rsync for login-state inheritance
  - `bin/cdpcc` (86 LOC) — Claude Code launcher that injects a single-port MCP config on demand
- **Hook**: `hooks/cdp-ensure.sh` — Claude Code PreToolUse hook ensuring the Agent Chrome is up before the first `mcp__cdp__*` call
- **Docs**: architecture overview, watchdog postmortem (two CPU-99% orphan incidents and their root causes), port lease model, profile management, troubleshooting checklist, platform-specific notes
- **Sample config** (`config/mcp-server.example.json`) and **bug report template**

### Hardened (vs the private pre-open-source lineage)
- **Removed hardcoded absolute paths** in proxy.js / cdpcc / cdp-ensure.sh — now resolved via `require.resolve("@playwright/mcp/cli.js")`, `command -v`, and `__dirname`-relative lookups, overridable by env vars
- **Generalized project-specific comments** — no more mentions of internal project names in code or docs

### Known limitations
- macOS is the primary testbed; Linux should work (profile path may need adjustment); Windows is untested
- The `takeover profile` mechanism is Chrome-on-macOS-specific out of the box (`~/Library/Application Support/Google/Chrome`); users on other platforms need to set the source profile path manually
- This release ships only the JavaScript/bash core. A reference Python direct-CDP client is planned for v0.2

### Battle scars carried into v0.1.0
- **2026-07-23**: worker_threads `process.ppid` semantics bug — hard watchdog killed launchd instead of the proxy (EPERM). Fixed by passing the real main-PID via `postMessage`.
- **2026-07-26**: EPIPE exception storm — parent zcode-cli exit closed the stderr pipe, every `log()` threw EPIPE → `uncaughtException` handler called `log()` again → infinite recursive exception storm → CPU 100%, all three watchdog layers failed simultaneously because they all depended on the main thread / worker being able to run callbacks. Root-caused via `sample <pid> 5` stack inspection. Fixed by making the `uncaughtException` handler pure-synchronous (`process.exit(1)` only, no IO) and wrapping `log()`'s `stderr.write` in `try/catch`.

See [`docs/watchdog-postmortem.md`](docs/watchdog-postmortem.md) for the full story.

[Unreleased]: https://github.com/Lumos-789/zcode-cdp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Lumos-789/zcode-cdp/releases/tag/v0.1.0
