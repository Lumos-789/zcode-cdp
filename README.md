# zcode-cdp

> **为 AI Coding Agent 设计的"已登录浏览器接管"框架** —— 让 agent 用真人已登录的 Chrome 干活，配套生产级端口租约 / 看门狗 / 状态机治理。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](#兼容性)
[![MCP](https://img.shields.io/badge/MCP-stdio-orange.svg)](https://modelcontextprotocol.io/)

> English: a **logged-in browser takeover framework** for AI coding agents (ZCode / Claude Code / Codex). Drives your real, already-logged-in Chrome via the Chrome DevTools Protocol, with production-grade port lease / watchdog / state-machine governance.

---

## 为什么用它

通用浏览器自动化（Playwright / Puppeteer / browser-use）的共同前提是**每次起一个全新的、无登录态的浏览器实例**。当你的场景是：

- agent 要操作**已登录账号**（公司后台、扫码登录生态、短信验证站点、付费订阅内容），不想把密码/2FA 重新喂给临时浏览器；
- 多个 agent 会话要**并发**各持一个 Chrome，互不抢端口、互不串数据；
- Chrome 需要**长期存活**（durable），跨客户端复用，而不是每次冷启动；

zcode-cdp 的答案：

| 能力 | 做法 |
|---|---|
| 登录态继承 | 首次 `rsync` 日常 Chrome profile 到每端口独立目录，之后独立演化；`--refresh` 随时刷新 |
| 懒启动 | 状态机托管：首次 `browser_*` 调用才起 Chrome，**不碰浏览器的会话 = 0 Chrome 进程** |
| 并发治理 | 统一端口租约池（9223–9229），原子 `mkdir` 抢锁 + `leaseId` ownership 校验 |
| 稳定性 | 三层看门狗（软 lag / 硬 worker 线程 SIGKILL / 异常兜底）+ 限流 + 启动期去重 |
| 不重放 | Chrome 异常不自动重放请求，杜绝重复提交/发布 |
| 客户端 | MCP 工具（ZCode / Claude Code / Codex）/ 裸 WebSocket / Playwright `connect_over_cdp` 三通道共享同一端口池 |

```
Agent 客户端 (ZCode / Claude Code / Codex / Python 脚本)
        │ MCP stdio 或 CDP 直连
        ▼
zcode-cdp-proxy (懒加载状态机) ── zcode-cdp-lease (端口租约)
        ▼
cdp-takeover (Chrome 启动器 + profile rsync)
        ▼
N 个已登录 Chrome：会话临时池 9223-9229（7 槽）+ 脚本固定端口 93xx（durable）
```

---

## 快速开始

前置：Node.js ≥ 18、Chrome、`npm install -g @playwright/mcp`。

1. 克隆仓库，把 `bin/` 加入 PATH：

   ```bash
   git clone https://github.com/Lumos-789/zcode-cdp.git
   export PATH="$PWD/zcode-cdp/bin:$PATH"   # 或写进 ~/.zshrc
   ```

2. 注册 MCP（按你的客户端三选一）：

   **ZCode**（`~/.zcode/cli/config.json`）/ **Claude Code**（`~/.claude.json` 或项目级 `.mcp.json`）：

   ```json
   {
     "mcpServers": {
       "cdp": { "type": "stdio", "command": "node",
                "args": ["/absolute/path/to/zcode-cdp/bin/zcode-cdp-proxy.js"] }
     }
   }
   ```

   **Codex**（CLI / ChatGPT.app 内置版，`~/.codex/config.toml`）：

   ```toml
   [mcp_servers.cdp]
   command = "/usr/local/bin/node"   # 绝对路径
   args = ["/absolute/path/to/zcode-cdp/bin/zcode-cdp-proxy.js"]
   ```

3. 重启 agent，对它说：「打开 https://your-dashboard.example.com，把今天的订单数读出来」。首次调用自动：rsync 你日常 Chrome 的登录态 → 启动接管 Chrome → 工具直达。`browser_close` 用完即释放。

> 首次 rsync 需要几十秒（取决于日常 profile 大小），之后秒级。

## 三种使用方式

| 模式 | 谁用 | 怎么起 | 生命周期 |
|---|---|---|---|
| **lazy proxy** | ZCode / Codex | MCP 配置即生效 | 首次 `browser_*` 懒启动；`browser_close` 释放回 IDLE |
| **cdpcc** | Claude Code | `cdpcc [claude args]` | 启动时预占端口；CC 退出自动关 Chrome |
| **durable** | Python / 人工 | `cdp-takeover [port]` | 跨客户端长期存活，直到手动关 |

```bash
cdp-takeover 9324              # durable：给脚本一个固定端口
cdp-takeover 9324 --refresh    # 强制从日常 Chrome 重 rsync 登录态（实例须已关）
cdp-takeover status            # 端口占用总览
```

```python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9324")
    # 用你已登录的真人 Chrome 干活；用完只断连接，绝不杀 Chrome
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](./docs/architecture.md) | 三层架构、状态机、看门狗、关键正确性设计 |
| [docs/port-lease.md](./docs/port-lease.md) | 端口租约：原子抢锁、leaseId、stale 回收、CLI |
| [docs/profile-management.md](./docs/profile-management.md) | 登录态：rsync 继承、隔离、刷新、安全注意 |
| [docs/platform-notes.md](./docs/platform-notes.md) | 反爬与编辑器踩坑：三禁令、拟人行为、Draft.js 注入 |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | 症状 → 原因 → 修复 |
| [docs/backtest.md](./docs/backtest.md) | 回归测试：`npm test` 一键跑三层，零 Chrome 副作用 |

## 配置

所有环境变量都有默认值，不设也能跑。常用的：

| 变量 | 默认 | 作用 |
|---|---|---|
| `CDP_PORTS` | `9223...9229` | 会话临时端口池 |
| `CDP_SCRIPT_PORTS` | `9324 9326` | 脚本固定端口（status 显示用） |
| `CDP_LOCK_ROOT` | `/tmp/zcode-cdp/ports` | 租约锁目录 |
| `CDP_ORPHAN_TIMEOUT_MS` | 30min | 无业务空闲自退 |
| `CDP_HARD_KILL_MS` / `CDP_HARD_CPU_THRESHOLD` | 60s / 85% | 硬看门狗阈值 |

完整列表见脚本头部注释或 [docs/architecture.md](./docs/architecture.md)。

## 兼容性

- **macOS** 主力测试；**Linux** 应可用（profile 源路径需手动调整）；Windows 未测试。
- 客户端：任何能注册 stdio MCP server 的 agent（ZCode、Claude Code、Codex 均实测）。

## 免责声明

> ⚠️ 本工具**仅用于自动化你有合法权限访问的账号和站点**。请遵守目标网站的 ToS 与当地法律；对滥用本工具进行批量抓取、规避反爬、账号滥用等行为，作者不承担责任。接管已登录 profile 意味着真实登录态会暴露给 agent，请仅在可信环境中使用。

## License

[MIT](./LICENSE) © 2026 [Lumos-789](https://github.com/Lumos-789)
