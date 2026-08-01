# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
