[English](README.md) | **中文**

# zcode-cdp

> **为 AI Coding Agent 设计的"已登录浏览器接管"框架** —— 让 agent 用真人已登录的 Chrome 干活，配套生产级端口租约 / 看门狗 / 状态机治理。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](#兼容性)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/Lumos-789/zcode-cdp/releases/tag/v0.1.0)
[![MCP](https://img.shields.io/badge/MCP-stdio-orange.svg)](https://modelcontextprotocol.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](https://github.com/Lumos-789/zcode-cdp/blob/main/CONTRIBUTING.md)

---

## 为什么用它

通用浏览器自动化方案（Playwright / Puppeteer / 各 agent 自带的 browser-use）有一个共同前提：**起一个全新的、无登录态的浏览器实例，用完即弃**。这对"从零打开网页、完成一次性任务"很合适，但对以下场景无能为力：

- agent 需要操作**你已经登录好的**账号（公司后台、已扫码的微信生态、需要短信验证的金融站点、付费订阅内容……）
- 你不想把账号密码 / 2FA / Cookie 重新喂给一个临时浏览器
- 多个 agent 会话要**并发**地各自操控一个 Chrome，且互不抢端口、互不串数据、互不漏资源
- Chrome 要能**长期存活**（durable），跨多个客户端连接复用，而不是每次都冷启动

**zcode-cdp 的核心价值一句话**：

> **让 agent 用你已登录好的真人 Chrome 干活，且 N 个 agent 并发时不抢端口、不漏资源。**

### 具体解决什么问题

| # | 痛点 | zcode-cdp 怎么解 |
|---|------|------------------|
| 1 | **登录态丢失** —— 通用方案每次起全新浏览器，登录态/2FA/Cookie 全得重来 | 接管真人 Chrome：首次 `rsync` 日常 Chrome profile 继承全部登录态，之后独立演化 |
| 2 | **多 agent 并发抢端口** —— N 个会话同时连 9222 互相踩 | 统一端口租约池（9223–9229 共 7 槽），原子 `mkdir` 抢锁 + `leaseId` ownership 校验，杜绝双 owner 竞态 |
| 3 | **僵尸 Chrome 吃内存** —— 开 5 个 agent 窗口其中 3 个不碰浏览器，却挂了 3 份 Chrome | 懒加载：首次 `browser_*` 调用才起 Chrome，**不碰浏览器的窗口 = 0 Chrome 进程** |
| 4 | **孤儿进程烧 CPU** —— agent 崩溃后 Chrome/proxy 残留，单核 99% 跑几小时 | 三层看门狗（软 CPU lag / 孤儿超时 / 硬 worker 线程 SIGKILL），扛过两次真实生产事故（见 [事故复盘](docs/watchdog-postmortem.md)） |
| 5 | **重复提交/发布** —— 网络抖动触发自动重放，导致同一篇文章发两次 | Chrome/backend 异常**不自动重放**，下次 `browser_*` 再懒启动；exactly-once 入队 |
| 6 | **反爬识别 bot 指纹** —— stealth 插件反而暴露自动化 | 连真 Chrome 指纹本就真，禁 stealth / 禁 `new_context` / 禁覆盖 UA（详见 [反爬与编辑器踩坑](docs/platform-notes.md)） |
| 7 | **Python 脚本拿不到登录态** —— Playwright 自启的浏览器和 agent 用的不是同一个 | durable 模式：Python 裸 WebSocket / `connect_over_cdp` 直连固定端口的同一份 Chrome，共享登录态 |

它是怎么做到的：

| 维度 | 通用方案 (Playwright/Puppeteer/browser-use) | zcode-cdp |
|---|---|---|
| 浏览器登录态 | 全新实例，从零登录或注入 Cookie | **接管真人已登录 Chrome**（首次 `rsync` 日常 Chrome profile 继承登录态） |
| 启动模型 | agent 一启动就拉起浏览器 | **状态机懒启动**：不碰浏览器的窗口 = 0 Chrome 进程 |
| 并发治理 | 各自为政，易端口冲突 | **统一端口租约池**（原子 `mkdir` + leaseId ownership） |
| 稳定性 | 单层超时 | **三层看门狗**（软 / CPU / 硬 worker 线程，扛过 EPIPE 异常风暴） |
| 生命周期 | 用完即弃 | **durable 长期存活 + lazy 按需启动**双模式 |

---

## 核心特性

- 🔑 **接管真人已登录 Chrome** —— takeover profile 通过 `rsync` 从日常 Chrome 继承登录态，之后独立演化；`--refresh` 可随时强制刷新。
- 🧠 **中继懒加载 proxy** —— 本地 TCP 中继 + 单常驻 backend，状态机 `IDLE → ENSURING → ACTIVE → CLOSING → IDLE`；开 N 个不碰浏览器的窗口 = **0 个 Chrome 进程**，激活循环不重启 backend。
- 🔒 **端口租约与所有权** —— 统一 `mkdir` 原子抢锁 + `leaseId` 校验，防 PID 复用误删新锁；proxy / cdpcc / cdp-takeover 共享同一锁命名空间，杜绝双 owner 竞态。
- 🐕 **三层看门狗** —— 软看门狗（事件循环延迟）/ CPU 看门狗（主进程 CPU% busy-loop 检测）/ 硬看门狗（独立 worker 线程，60s 无心跳即 `SIGKILL`，免疫主线程卡死）。
- 🧰 **三种客户端通道** —— MCP 工具（`mcp__cdp__browser_*`）/ 裸 WebSocket / Playwright `connect_over_cdp`，三种客户端共享同一端口池。
- 🎭 **每端口 profile 隔离** —— 每个端口独立 profile + 不同卡通头像，多账号天然隔离，一眼分清哪个 Chrome 属于哪个会话。
- 🧹 **挂起语义替代缓冲** —— 激活期间 backend 连接在中继挂起，Chrome 就绪后自然流动；零应用层缓冲代码。

---

## 架构一瞥

```ascii
┌─────────────────────────────────────────────────────────────────────┐
│                     Agent Clients (顶层)                             │
│                                                                     │
│   ZCode 会话        Claude Code         Python 爬虫 / 自动化脚本     │
│   (MCP stdio)       (cdpcc wrapper)     (裸 CDP / playwright)        │
└─────────┬──────────────────┬──────────────────────┬─────────────────┘
          │                  │                      │
   ① MCP 工具调用     ① MCP 工具调用         ② 直连 CDP 协议
   (JSON-RPC stdio)   (JSON-RPC stdio)      (WebSocket / connect_over_cdp)
          │                  │                      │
┌─────────▼──────────────────▼──────────────────────│──────────────────┐
│              zcode-cdp-core (中层 / 治理层)         │                  │
│                                                    │                  │
│  ┌──────────────────┐  ┌────────────────────┐     │                  │
│  │ zcode-cdp-proxy   │  │  cdpcc             │     │                  │
│  │ (状态机懒加载)     │  │  (CC 端口预占)      │     │                  │
│  │  IDLE→ACTIVE  │  │  + cdp-ensure hook │     │                  │
│  └────────┬─────────┘  └─────────┬──────────┘     │                  │
│           │                       │                │                  │
│           └───────────┬───────────┘                │                  │
│                       ▼                            ▼                  │
│         ┌─────────────────────────────────────────────────┐          │
│         │   zcode-cdp-lease  (统一端口租约 / 所有权)        │          │
│         │   原子 mkdir + leaseId ownership 校验             │          │
│         └─────────────────────┬───────────────────────────┘          │
└───────────────────────────────┼──────────────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────────────┐
│            N 个已登录 Chrome 实例 (底层 / 端口池)                       │
│                                                                       │
│  会话临时池 (9223-9229, 最多 7 并发)        脚本固定端口 (93xx, durable) │
│  ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┐  ┌─────┬─────┐            │
│  │9223 │9224 │9225 │9226 │9227 │9228 │9229 │  │9324 │9326 │            │
│  │avatar│avatar│...  │     │     │     │     │  │     │     │           │
│  │profile│profile│    │     │     │     │     │  │     │     │           │
│  └─────┴─────┴─────┴─────┴─────┴─────┴─────┘  └─────┴─────┘            │
│   每端口: 独立 profile (rsync 继承登录态) + 不同头像, 互不串数据          │
└───────────────────────────────────────────────────────────────────────┘

两条路径:
  ① MCP 工具调用   Agent → proxy/cdpcc → lease 领端口 → 起 Chrome → @playwright/mcp → browser_* 工具
  ② 直连 CDP 协议  Python/Playwright → cdp-takeover <port> 起 durable Chrome → 直接连 WebSocket
```

---

## 60 秒上手

### 前置条件

- **Node.js ≥ 18**
- **Chrome**（macOS 主力测试，Linux 应该可用）
- 全局安装 MCP 后端：`npm install -g @playwright/mcp`

### 步骤

1. **克隆仓库**

   ```bash
   git clone https://github.com/Lumos-789/zcode-cdp.git
   cd zcode-cdp
   ```

2. **把 `bin/` 加入 PATH**（或记下绝对路径，下面要用）

   ```bash
   # 临时（当前 shell）
   export PATH="$PWD/bin:$PATH"

   # 永久（写入 ~/.zshrc 或 ~/.bashrc）
   echo 'export PATH="/path/to/zcode-cdp/bin:$PATH"' >> ~/.zshrc
   ```

3. **配置 MCP** —— 把下面这段拷进你 agent 客户端的 config.json，把路径改成你的绝对路径：

   ```json
   {
     "mcpServers": {
       "cdp": {
         "type": "stdio",
         "command": "node",
         "args": ["/absolute/path/to/zcode-cdp/bin/zcode-cdp-proxy.js"]
       }
     }
   }
   ```

   - **ZCode**：写入 `~/.zcode/cli/config.json`
   - **Claude Code**：写入 `~/.claude.json`，或项目级 `.mcp.json`
   - （Claude Code 用户也可直接用下文的 `cdpcc` 命令，免去手改配置）
   - **Codex**（CLI / ChatGPT.app 内置版）：写入 `~/.codex/config.toml`，TOML 格式：

     ```toml
     [mcp_servers.cdp]
     command = "/usr/local/bin/node"   # 建议绝对路径，App 环境的 PATH 可能不全
     args = ["/absolute/path/to/zcode-cdp/bin/zcode-cdp-proxy.js"]
     ```

     Codex 直接走 lazy proxy 模式（首次 `browser_*` 自动起 Chrome、`browser_close` 自动释放），无需 hook（`cdp-ensure.sh` 仅服务 Claude Code 的 cdpcc 链路）。

4. **重启 agent** —— 现在你的工具列表里多了一批 `mcp__cdp__browser_*`（navigate / click / type / snapshot / screenshot ……）。

5. **第一次调用** —— 让 agent 调任意 `browser_*` 工具。proxy 状态机自动流转：

   - 首次会从你日常 Chrome（`~/Library/Application Support/Google/Chrome`）`rsync` profile 到该端口目录，**继承你已登录的全部账号**；
   - 然后启动该端口的 Agent Chrome，挂上 `@playwright/mcp`，工具调用直达。
   - 之后该端口的 profile 独立演化，不影响你日常 Chrome。

> 首次 `rsync` 可能需要几十秒（取决于你日常 profile 大小）。后续启动秒级。

---

## 三种使用方式

| 模式 | 谁用 | 怎么起 | 生命周期 | 典型场景 |
|---|---|---|---|---|
| **ZCode lazy proxy** | ZCode 会话 | MCP 自动（写好 config 即生效） | 首次调用懒启动；`browser_close` 释放，回到 `IDLE` | ZCode agent 日常浏览/操作 |
| **cdpcc** | Claude Code | 命令行 `cdpcc [claude args]` | 启动时预占端口（不起 Chrome），首次调 `mcp__cdp__*` 由 hook 起 Chrome；**CC 退出自动关 Chrome** | 给 Claude Code 一个带浏览器的窗口 |
| **durable** | 人工 / Python 脚本 | `cdp-takeover [port]` | 跨客户端长期存在，直到手动关 | Playwright `connect_over_cdp`、裸 WebSocket 长连接爬取 |

### cdpcc —— 带浏览器的 Claude Code

```bash
cdpcc                          # 自动选空闲端口，启带 cdp 工具的 CC（Chrome 懒起）
cdpcc --resume                 # 透传给 claude
cdpcc /path/to/project         # 在指定目录起 CC
```

`cdpcc` 启动时只**预占端口 + 注入 MCP 配置**，不起 Chrome；等你（或 CC）第一次调 `mcp__cdp__*` 工具时，PreToolUse hook（`hooks/cdp-ensure.sh`）触发 `cdp-takeover` 把 Chrome 起到该端口。**不用浏览器 = 0 Chrome 进程**。

> 安装 hook：把 `hooks/cdp-ensure.sh` 配成 ZCode/CC 的 PreToolUse hook，matcher 填 `mcp__cdp__.*`。

### durable —— 给 Python / Playwright 直连

```bash
cdp-takeover                   # 自动找第一个空闲端口（9223-9229）
cdp-takeover 9324              # 显式端口（建议脚本固定端口走 93xx）
cdp-takeover 9324 --refresh    # 强制从源 rsync 该端口 profile（须先关实例）
cdp-takeover status            # 打印端口占用表
```

然后 Python 侧：

```python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp("http://127.0.0.1:9324")
    # 用你已登录的真人 Chrome 干活
```

### 端到端示例：让 agent 读取你已登录站点的数据

最常见的用法 —— 让 agent 访问一个需要登录的页面，读取数据：

```text
# 在 ZCode / Claude Code 里，对 agent 说：
"打开 https://your-company-dashboard.example.com，把今天的订单数读出来给我。"

# agent 会自动调用：
#   1. mcp__cdp__browser_navigate({ url: "https://your-company-dashboard.example.com" })
#      ↑ 首次调用，proxy 状态机自动：
#         IDLE → 领端口 9223 → rsync 你日常 Chrome profile（继承登录态）
#         → 启动 Agent Chrome → 挂 @playwright/mcp → 工具直达
#   2. mcp__cdp__browser_snapshot()   ← 读取页面 ARIA 树
#   3. mcp__cdp__browser_click({ ... })  ← 点开"今日订单" tab（如需要）
#   4. mcp__cdp__browser_take_screenshot()  ← 视觉确认
#
# 关键：因为用的是你已登录的 Chrome，不需要你喂账号密码；
#       用完调 browser_close，proxy 释放端口回 IDLE（Chrome 关闭）。
```

**进阶**：同一台机器上 3 个 agent 会话并发？没问题 —— 每个会话独立 spawn 一个 proxy，各自领不同端口（9223 / 9224 / 9225），互不干扰；其中不碰浏览器的会话 = 0 Chrome 进程。

---

---

## 配置 / 可调环境变量

所有变量都有合理默认值，**不设也能跑**。需要精细调优时按需覆盖。

### 路径与发现

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CDP_PLAYWRIGHT_MCP_CLI` | 自动发现（`require.resolve("@playwright/mcp/cli.js")`，兜底常见全局路径） | 指向 `@playwright/mcp` 的 `cli.js` 绝对路径 |
| `CDP_TAKEOVER` | `bin/cdp-takeover`（与 proxy 同目录） | 指向 `cdp-takeover` 脚本 |
| `CDP_LOCK_ROOT` | `/tmp/zcode-cdp/ports` | 端口租约锁目录（`<port>.lock/owner.json`） |

### 端口池

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CDP_PORTS` | `9223 9224 9225 9226 9227 9228 9229` | 会话临时端口池（ZCode/cdpcc 从中 pick 空闲，进租约） |
| `CDP_SCRIPT_PORTS` | `9324 9326` | 脚本固定端口（durable，不进 pick 池） |

### 看门狗与防护阈值

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CDP_ORPHAN_TIMEOUT_MS` | `1800000`（30 min） | 孤儿 Chrome（owner 已死、Chrome 还在）超时回收 |
| `CDP_HARD_KILL_MS` | `60000`（60 s） | 硬看门狗：worker 线程 N 秒无心跳即 `SIGKILL` 主进程（免疫 busy-loop 卡死） |
| `CDP_HARD_CPU_THRESHOLD` | `85` | 硬看门狗 CPU 检测：主进程 CPU% 超此值视为 busy-loop |
| `CDP_HARD_CPU_TRIES` | `5` | 滑动窗口（`2*N` 次采样）内 ≥ N 次超阈值 → `SIGKILL`（容忍间歇 busy-loop 的间隙样本） |
| `CDP_WATCHDOG_LAG_MS` | `2000` | 软看门狗：事件循环延迟阈值 |
| `CDP_WATCHDOG_TRIES` | `3` | 软看门狗：连续触发次数 |
| `CDP_HEALTH_CHECK_MS` | `5000` | 健康检查轮询间隔 |
| `CDP_OUTPUT_RATE_LIMIT` | `500` | backend stdout 限流（行/秒） |
| `CDP_STDERR_RATE_LIMIT` | `200` | backend stderr 限流（段/秒） |
| `CDP_BUF_MAX_BYTES` | `2097152`（2 MB） | backend stdout 缓冲上限 |
| `CDP_INBUF_MAX_BYTES` | `2097152`（2 MB） | stdin inBuf 上限（防无换行堆积） |
| `CDP_STARTUP_GRACE_MS` | `8000` | 启动宽限期（lease 判定新锁不算 stale） |
| `CDP_STALE_LOCK_AGE_MS` | `30000` | 锁龄超过此值且 owner 已死 → 视为 stale 回收 |
| `CDP_RELAY_HOLD_MS` | `30000` | TCP 中继无 upstream 时挂起新连接的上限（ms）；ensure 失败时挂起连接被销毁，backend 收到连接错误 |

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | **架构总览** —— 三层组件、状态机流转、端口池与 profile 模型 |
| [`docs/port-lease.md`](./docs/port-lease.md) | **端口租约模型** —— `mkdir` 原子抢锁、`leaseId` ownership、stale 回收、双 owner 竞态消除 |
| [`docs/watchdog-postmortem.md`](./docs/watchdog-postmortem.md) | **看门狗事故复盘** ★ —— 两次真实生产事故（`ppid` 误杀 launchd、EPIPE 异常风暴 CPU 100%）的根因与修复 |
| [`docs/profile-management.md`](./docs/profile-management.md) | **Profile 管理** —— `rsync` 继承登录态、`--refresh`、每端口头像、多账号隔离 |
| [`docs/troubleshooting.md`](./docs/troubleshooting.md) | **排查清单** —— 端口被占 / Chrome 不起 / 工具不出现 / stale 锁 等常见问题 |
| [`docs/platform-notes.md`](./docs/platform-notes.md) | **反爬与编辑器踩坑** —— CDP 三禁令、拟人滚动、Draft.js 注入、风控信号识别 |
| [`docs/backtest.md`](./docs/backtest.md) | **标准回测流程** —— L0 静态 / L1 租约 / L2 状态机三层回归,改代码后 `npm test` 一键跑,零真实 Chrome 副作用 |

CHANGELOG 见 [`CHANGELOG.md`](./CHANGELOG.md)，bug 上报模板见 [`.github/ISSUE_TEMPLATE/bug-report.md`](./.github/ISSUE_TEMPLATE/bug-report.md)。

---

## 兼容性

- **macOS**：主力测试平台，开箱即用。
- **Linux**：应该可用，但 Chrome profile 源路径需手动调整（默认硬编码 macOS 路径 `~/Library/Application Support/Google/Chrome`，Linux 下通常是 `~/.config/google-chrome`），`lsof` / `stat` 语法差异也已尽量规避。
- **Windows**：未测试，欢迎反馈。
- **Agent 客户端**：支持任何能注册 stdio MCP server 的客户端 —— ZCode、Claude Code、Codex（codex-cli 0.153 / ChatGPT.app 内置版实测：`codex exec` 走通 navigate → 读取页面标题 → close 全链路，端口租约正常释放）等。

---

## 免责声明

> ⚠️ **请务必阅读本节后再使用。**

- 本工具**仅用于自动化你有合法权限访问的账号和站点** —— 例如你自己的账号、你有授权的内容管理、CTF / 安全研究、个人数据备份等。
- 请遵守目标网站的 Terms of Service 和当地法律法规。**对滥用本工具进行批量抓取、规避反爬机制、账号滥用等行为，作者不承担任何责任。**
- **takeover 已登录 profile 意味着你的真实登录态会暴露给 agent**。请仅在你信任的 agent 环境中使用，避免在不可信的 agent / 第三方脚本中暴露高价值账号。

---

## 许可

[MIT](./LICENSE) © 2026 [Lumos-789](https://github.com/Lumos-789)

---

[English](README.md) | **中文**
