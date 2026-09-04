# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Codex 客户端接入** — README 补 `~/.codex/config.toml` 的 `[mcp_servers.cdp]` TOML 注册方式。
  Codex 没有 PreToolUse hook，直接走 lazy proxy 模式（首次 `browser_*` 自动起 Chrome、
  `browser_close` 自动释放），无需 `cdp-ensure.sh`（该 hook 仅服务 Claude Code 的 cdpcc 链路）。
  实测：ChatGPT.app 内置 codex-cli 0.153.0-alpha.5，`codex exec` 一次通过
  navigate → 读取页面标题 → browser_close，会话池端口租约正常释放。

### Fixed
- **cdp-takeover: 扩展工具栏 pin 状态同步** — Chrome 在拷贝的 user-data-dir 中会重置
  `extensions.pinned_extensions`(实测 9224 从 4 个掉到 1 个),接管窗口的工具栏因此
  "看不到插件"(图标被收进拼图菜单)。现在每次启动接管 Chrome 前从日常 profile 恢复
  pin 列表;实测 Chrome 运行期不再重置。

## [0.2.0] — 2026-08-15

### 🏗️ Changed — relay 架构重写

**核心:删除 placeholder/real 双 backend 切换,改为"本地 TCP 中继 + 单常驻 backend"。**
依据:实测 playwright-mcp 单实例在 `browser_close` 后可完全复用(再次 navigate 自动
重建 context),"每次 endpoint 变化就重启 backend"的前提不必要;v0.1.1 的两个已修
缺陷(rearm 握手缺失、缓冲请求悬挂)都发生在切换逻辑上。

- **新增 `bin/zcode-cdp-relay.js`(TCP 中继)**:backend 的 endpoint 永远指向
  `127.0.0.1` 随机端口的中继;Chrome 起停/端口轮换只改 upstream。无 upstream 时
  **挂起**新连接(默认 30s 超时,`CDP_RELAY_HOLD_MS`),attach 后接通 —— 挂起语义
  天然替代应用层请求缓冲
- **proxy 重写**(`bin/zcode-cdp-proxy.js`):状态机 9 态收敛为
  IDLE/ENSURING/ACTIVE/CLOSING(+退出);整体删除 synthetic initialize、
  activationBatch(exactly-once 去重)、backend generation fencing、
  restartPlaceholder 等切换配套;backend 从生到死只 spawn 一次(激活循环零重启,
  每次 close→reopen 省约 1-2s)
- **新增 CLOSING 过渡态**:close 释放窗口内到达的 `browser_close` 直接返回成功,
  防止触发 backend 重连 → 挂起 → 误自动重新激活(L2 回测在真实时序下抓出的
  行为缺口,旧架构 `CLOSE_PENDING` 的等价物)
- **teardown 自动重激活**:释放期间到达的新请求(中继挂起连接)在释放完成后自动
  重新 ensure,等价旧 activationBatch 重放
- **stdout 限流熔断改为丢弃+告警**:大 snapshot 是合法场景,不再杀 backend
  (单常驻实例下杀 = proxy 死);CPU 异常仍由三层看门狗兜底
- **保留不动**(事故换来的资产):lease.js、cdp-takeover、三层看门狗、stderr 限流、
  inBuf 上限、启动期同父去重、orphan 业务心跳、EPIPE 纯同步退出
- lease.js:`killAgentChrome` 增加关键路径日志(非 Agent 不杀/SIGTERM 滞留/SIGKILL 兜底)

### Added
- 回测新增 **L1.5 relay 单元**(`test/relay.test.js`:挂起/接通/双向转发/
  detach-重挂/端口轮换/failHeld/超时/stop 八场景)
- L2 新增**回归#3(backend 只 spawn 一次)**断言;stub-backend 增加 TCP 连接模拟
  (收到 `browser_*` 时连中继,覆盖中继路径);close 释放断言改轮询最终一致

### Verified
- `npm test` 三连跑全绿(L0 14 + L1 12 + L1.5 8 + L2 11)
- 半 live:真 playwright-mcp + 真 Chrome(9224):navigate → close(锁释放) →
  再 navigate(同 backend 重新激活) → close,WS over 中继真实转发,零 Chrome 残留

### Known issues
- L2 stub 环境下偶发 teardown 轮询的 timer 调度延迟(Heisenbug,注入观察即消失);
  干净实验与半 live 多轮正常;无资源泄漏;根因未定位(疑 node `execSync` 嵌套
  事件循环交互),详见 `docs/backtest.md` 已知问题节

## [0.1.1] — 2026-08-15

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

[Unreleased]: https://github.com/Lumos-789/zcode-cdp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Lumos-789/zcode-cdp/releases/tag/v0.2.0
[0.1.1]: https://github.com/Lumos-789/zcode-cdp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Lumos-789/zcode-cdp/releases/tag/v0.1.0
