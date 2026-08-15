# Architecture / 架构

本文档面向想要理解 `zcode-cdp` 内部设计、做贡献、或评估能否在自己环境跑的开发者。所有声称均可对照 `bin/` 下源码核验，源码行号会在关键处给出。

阅读前置：知道 Chrome DevTools Protocol (CDP) 是 Chrome 自带的调试协议（`--remote-debugging-port`），知道 MCP (Model Context Protocol) 是 ZCode/Claude Code 给 agent 注入结构化工具的标准方式。

---

## 1. 三层架构总览

`zcode-cdp` 解决的问题是：**让 AI agent（ZCode / Claude Code）能在用户已登录的真实 Chrome 上跑浏览器自动化，同时不浪费资源（不碰浏览器的窗口 = 0 Chrome 进程）。**

它分三层，每层职责清晰、可独立使用：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          第 1 层：能力层 (MCP)                           │
│   zcode-cdp-proxy.js —— 懒加载 MCP 代理(请求观察者 + Chrome 生命周期)      │
│   zcode-cdp-relay.js —— 本地 TCP 中继(backend 的 endpoint 永远有效)       │
│   每个会话独立 spawn 一个；持有 stdio，背后常驻一个 playwright-mcp          │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ 首次 browser_* 调用时才下沉
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       第 2 层：编排 / 启动层                             │
│   cdp-takeover       —— Chrome 启动器（durable / managed 双模式）         │
│   zcode-cdp-lease.js —— 端口租约管理（原子 mkdir + leaseId ownership）    │
│   cdpcc              —— Claude Code 启动 wrapper（注入 cdp MCP 配置）     │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ 起好的 Chrome 监听固定端口
                               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       第 3 层：直连客户端层                              │
│   用户的 Python / playwright 脚本                                        │
│   通过裸 WebSocket 或 playwright connect_over_cdp 直连固定端口 Chrome     │
│   （9324 / 9326 durable 端口，不进会话租约池）                           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 两条数据路径

**路径 A：MCP 工具调用（agent 驱动，懒加载，relay 架构）**

```
agent 决定调 browser_navigate
        │
        ▼  JSON-RPC over stdio(全双工透传,proxy 只观察不代办)
zcode-cdp-proxy.js  (请求观察者 + Chrome 生命周期管理)
        │  首次 browser_* → ENSURING: reserve → cdp-takeover → relay.attach → ACTIVE
        ├─► zcode-cdp-lease.js   reserve()  领端口 9223-9229
        ├─► cdp-takeover --managed --lease-id <id>   起 Chrome
        └─► 常驻 playwright-mcp(会话期只 spawn 一次)
                │  endpoint 永远指向本地 TCP 中继(127.0.0.1 随机端口)
                ▼
        zcode-cdp-relay.js —— 无状态字节管道
                │  无 upstream 时挂起新连接(带超时);attach 后接通
                ▼  WebSocket/HTTP over TCP
            Chrome(端口 922x,动态)
```

backend 从生到死只 spawn 一次;Chrome 的起停、端口轮换全部发生在中继的 upstream
侧,backend 无感知(对它只是断线重连——2026-08-15 实验证实 playwright-mcp 的
`browser_close` 后可完全复用)。**中继的挂起语义天然替代了应用层请求缓冲**:
ensure 进行期间 backend 发起的连接被挂起,Chrome 就绪后自然流动,零缓冲代码。

**路径 B：直连客户端（用户脚本，固定端口）**

```
Python / playwright 脚本
        │
        │  cdp-takeover 9324        （durable 模式，人工直调，无 lease）
        ▼
   Chrome 监听 9324（带独立 profile，继承登录态）
        ▲
        │  ws://127.0.0.1:9324  或  playwright.chromium.connect_over_cdp(...)
   用户脚本（常驻）
```

两条路径共享 Chrome 启动器（`cdp-takeover`）和端口隔离（端口 + profile 两层），但租约模型不同：会话池（9223-9229）走 lease，固定端口（93xx）不走 lease，只判"端口忙"。

---

## 2. 为什么是 MCP，不是 skill

这是项目最核心的设计决策。

**Skill 是说明书，MCP 是机器本身。** Skill 教 agent "怎么做事"（步骤、注意事项），它本身不给 agent 新本事。MCP server 是一个真实进程，给 agent 注入新的结构化工具（`browser_navigate` / `browser_click` ...），agent 调用工具时是在和这个进程通信。

**浏览器是需要常驻进程托着的有状态资源。** 一条浏览器自动化任务通常是：

```
navigate("https://example.com")  →  click(登录按钮)  →  type(密码)  →  submit
```

每一步都依赖**同一个活着的 Chrome 进程**：登录后的 cookie、页面 DOM 状态、已打开的 tab。如果每步都临时起一个 Chrome 再关掉，登录态、中间状态全没了。所以必须有 **daemon**：一个长期活着的进程，替 agent 持有 Chrome 的连接。

**daemon + 结构化工具 = MCP。** 这正是 MCP 的形式：一个 stdio 上的 JSON-RPC server，常驻后台，对 agent 暴露一组工具。`zcode-cdp-proxy.js` 就是这个 daemon——它替代了 ZCode 全局配置里 `cdp` 这个 MCP 的 `command`，每个会话独立 spawn 一个（见 `bin/zcode-cdp-proxy.js:2-9`）。

skill 做不到这件事，因为 skill 没有"持有进程"的能力。引用 proxy.js 顶部注释原文：

> 替代 playwright-mcp 作为 config.json 里 cdp 的 command。每个 ZCode 会话独立 spawn 一个本 proxy 实例。proxy 全权持有 stdio(MCP JSON-RPC 通道)，背后常驻一个 playwright-mcp 进程(endpoint 指向本地中继)。

如果只写一个 skill 教 agent "去 spawn 一个 Chrome"，agent 每次调用都得自己想办法管这个 Chrome 的生命周期，跨调用状态完全无法保持。MCP 把这层复杂性藏在 daemon 里，agent 看到的就是干净的 `browser_*` 工具。

---

## 3. 状态机详解（核心）

proxy 是一个**请求观察者**：所有 client→backend 消息照常透传，仅解析后观察
`browser_*` 调用并驱动 Chrome 生命周期。状态机只管 Chrome 的在/不在（
`bin/zcode-cdp-proxy.js` 的 `ST` 定义）。

> **架构演进注**：v0.1.x 采用 placeholder/real 双 backend 切换 + synthetic
> initialize + activation batch + generation fencing 四件套（9 状态）。v0.2.0
> 起实测 playwright-mcp 的 `browser_close` 后可完全复用，遂改为"本地 TCP 中继 +
> 单常驻 backend"，四件套整体删除（回归验证见
> `docs/backtest.md`）。下文描述当前架构。

### 状态定义

| 状态 | 含义 |
|------|------|
| `IDLE` | 0 端口租约 0 Chrome;backend 常驻应答 `initialize`/`tools/list` |
| `ENSURING` | 正在领租约 + 起 Chrome + 接通中继(期间请求靠中继挂起语义流动) |
| `ACTIVE` | Chrome 在线,中继已接通,一切透传 |
| `CLOSING` | `browser_close` 响应已返回、租约/中继正在释放的过渡窗口 |
| `SHUTTING_DOWN` | 退出中（stdin EOF/SIGTERM/SIGINT/SIGHUP） |
| `EXITED` | 已退出 |

### 状态流转图

```
        ┌────────────────────────────────────────────────┐
        │                                                │
        ▼                                                │
     ┌───────┐  首次 browser_*(非 close)  ┌───────────┐  │
  ┌─►│ IDLE  │ ─────────────────────────► │ ENSURING  │  │
  │  └───────┘                             └─────┬─────┘  │
  │      ▲  ▲        lease 失败/Chrome 起不来:        │      │
  │      │  └──────────── failHeld + 回 IDLE ◄────────┤      │
  │      │                                          ensure 成功│
  │      │  teardown 完成(锁删+中继断)                   ▼      │
  │      │  有挂起连接 → 自动重新 ensure ────────► ┌────────┐ │
  │      └────────────────────────────────────────│ ACTIVE │ │
  │             ▲                                 └───┬────┘ │
  │             │      browser_close 响应返回:          │      │
  │             │      先转发响应,再 teardown      ┌────▼─────┐│
  │             └──────────────────────────────── │ CLOSING  ││
  │                                               └──────────┘│
  │   IDLE/CLOSING 收到 browser_close → 直接成功响应(不起 Chrome)│
  └───────────────────────────────────────────────────────────┘

   任何状态  ──── stdin EOF / SIGTERM / SIGINT / SIGHUP ────►  SHUTTING_DOWN ────► EXITED
```

### 关键设计点

**1. IDLE 时零占用，但 backend 常驻。** proxy 启动时开 TCP 中继（随机端口）并
spawn 唯一的 playwright-mcp（endpoint=中继）。不碰浏览器的会话 = 0 端口租约
0 Chrome；backend 进程与旧架构的"占位 backend"成本相同（1 个 playwright-mcp），
但**激活/关闭循环不再重启它**（旧架构每次循环杀+起各一次，浪费 1-2 秒）。

**2. 首次 `browser_*` 才激活，请求不缓冲。** `handleClientLine` 观察到
`browser_*`（非 close）且 IDLE 时，异步触发 `ensure()`（reserve →
cdp-takeover → relay.attach），**请求本身照常转发**——backend 连中继时因无
upstream 被挂起（上限 `CDP_RELAY_HOLD_MS`，默认 30s），Chrome 就绪后自然流动。
中继挂起语义替代了旧架构的 activation batch：零缓冲代码，时序天然正确。

**3. `browser_close` 先返回响应再释放。** ACTIVE 态收到 close：转发并记录
`closeRequestId`；backend 输出该 id 的响应时，**先把响应写给 ZCode**，再异步
`teardown()`（断中继 → 释放租约[内含杀 Agent Chrome] → 回 IDLE）。agent 看到
的是"close 成功"，而非超时。

**4. CLOSING 窗口防御。** 释放进行中（租约未删、state 仍 CLOSING）到达的
`browser_close` 直接返回成功（浏览器确实在关闭中），不转发——否则会触发
backend 重连中继 → 挂起连接 → teardown 完成时误判"有新需求"而重新激活
（旧架构 `CLOSE_PENDING` 状态挡的就是这个窗口，v0.2 的等价物；该行为缺口由
L2 回测抓出后修复）。

**5. teardown 的自动重激活 = 旧 batch 重放的等价语义。** teardown 完成时若中继
仍有挂起连接（释放期间到达的新 `browser_*` 触发 backend 重连），自动重新
`ensure()`——挂起连接在新 Chrome 就绪后自然流动，无需应用层重放。

**6. Chrome 异常不自动重放。** 健康检查发现 Chrome listener 消失/变为非 Agent
进程 → teardown 回 IDLE（**不杀非 Agent 进程**）。不重放刚才的请求——重放可能
导致重复提交。agent 自己决定要不要重试。backend 死亡是唯一致命异常：proxy
直接退出让 ZCode 重拉（唯一实例，无法降级服务）。

---

## 4. 关键正确性设计（vs 朴素实现）

一个"朴素实现"会直接把 stdio 桥接到 playwright-mcp，再起个 Chrome。这在生产里会出各种竞态。当前架构的关键设计：

### 4.1 本地 TCP 中继（`bin/zcode-cdp-relay.js`）

**为什么需要**：playwright-mcp 的 `--cdp-endpoint` 是启动参数，运行时不可改；而
MCP 客户端只在连接建立时发一次 `initialize`。若要让 endpoint 跟随动态分配的
Chrome 端口，就得反复重启 backend 并伪造握手（v0.1.x 的四件套复杂度来源）。
中继让 endpoint **永远有效**：backend 的 endpoint 固定指向中继，Chrome 端口只
存在于 upstream 侧。

**语义**：纯字节管道（`pipe` 双向，零解析，每条连接独立 upstream，支持
playwright 多连接）；无 upstream 时**挂起**新连接（不拒绝、不报错，上限
`CDP_RELAY_HOLD_MS` 默认 30s——ensure 失败时 `failHeld()` 销毁挂起连接，backend
收到连接错误，对应旧架构"激活失败对每个请求返回一次 error"）；`detach()` 只销毁
已接通管道，挂起连接保留——teardown 期间到达的新请求在新一轮 attach 后自然流动。

### 4.2 挂起语义替代应用层缓冲

旧架构需要 `activationBatch`（exactly-once 入队、去重、激活失败批量 settle）。
新架构里 ensure 期间的请求**照常转发**：backend 连中继 → 挂起 → Chrome 就绪 →
attach 接通 → 请求流动。缓冲、去重、结算代码整体消失，时序由 TCP 连接状态保证。

### 4.3 browser_close response-aware（先响应后释放）

`handleBackendLine` 检测 `closeRequestId` 匹配的响应，先 `process.stdout.write`
给 ZCode，再 `serialize(() => teardown())`。顺序至关重要：先释放会导致 agent
收不到响应。

### 4.4 CLOSING 窗口防御

释放是异步的（杀 Chrome 最多 3s）。窗口内到达的 `browser_close` 若走真转发，
会触发 backend 重连中继 → 挂起 → teardown 完成时误判新需求 → 无限激活循环。
CLOSING 态直接回成功响应，语义上"浏览器正在关闭"与"已关闭"等价。（该缺口由
L2 回测在真实时序下抓出。）

### 4.5 防护机制（三层看门狗 + 限流，v0.1 事故结晶，原样保留）

stdout 限流超限改为**丢弃 + 告警**（大 snapshot 是合法场景），不再杀 backend
（唯一实例，杀 = proxy 死）；CPU 异常交由三层看门狗兜底（§7）。

---

## 5. 端口池与租约模型

`zcode-cdp-lease.js` 是统一租约管理器，被 proxy（`require`）和 cdpcc/cdp-takeover（CLI）共享，消除三套各自不一致的锁判断（`zcode-cdp-lease.js:1-9`）。

### 端口分配表

| 端口段 | 用途 | 进租约池？ |
|--------|------|-----------|
| 9223-9229（7 个） | 会话临时池：ZCode / Codex / cdpcc 的临时浏览器 | 是，`SHARED_PORTS` |
| 9324, 9326 | 脚本固定端口：Python/playwright durable 直连客户端 | 否，`SCRIPT_PORTS`，只判端口忙 |

每个端口还有独立 profile（`--user-data-dir`）和不同头像（avatar_index），做到**端口 + profile 两层隔离**（`cdp-takeover:4-12, 40-53`）。

### 锁格式

```
$LOCK_ROOT/<port>.lock/              ← mkdir 是唯一原子抢占点
$LOCK_ROOT/<port>.lock/owner.json    ← 含 leaseId、ownerPid、ownerStartTime、state...
```

`LOCK_ROOT` 默认 `/tmp/zcode-cdp/ports`（`zcode-cdp-lease.js:38`）。`owner.json` 结构（`zcode-cdp-lease.js:298-309`）：

```json
{
  "version": 1,
  "port": 9223,
  "kind": "zcode-cdp-proxy",
  "leaseId": "a1b2c3d4e5f6g7h8",      // 16 hex, 删除/更新前必核对
  "ownerPid": 13503,
  "ownerStartTime": "1789...",          // 进程启动 epoch 秒，防 PID 复用
  "state": "reserved" | "active",
  "browserPid": 54278,
  "createdAt": "...", "updatedAt": "..."
}
```

**核心不变量（`zcode-cdp-lease.js:5-10`）：**
- `mkdir` 是唯一原子抢占点
- `owner.json` 含 `leaseId`，删除/更新前必须核对（防 PID 复用 + 防误删别人的新锁）
- 非 Agent listener 永不自动 kill
- 无 lease 的 durable Agent Chrome 只当"端口忙"处理，不抢占
- Chrome 未退出前不得释放 lease

### 兼容旧锁（只读判定）

迁移期间需要识别老版本遗留的锁文件（`zcode-cdp-lease.js:16-18, 103-113, 173-186`）：

```
/tmp/zcode-cdp-port-<port>.lock/pid   （旧 proxy）
/tmp/cdpcc-port-<port>.lock/pid       （旧 cdpcc）
```

读这些锁时**只判定不创建**：旧 owner 还活着就当忙，死了就当可回收。

### 端口忙判定（`checkPort`）

`checkPort(port)` 按优先级判定（`zcode-cdp-lease.js:135-189`）：

1. 端口有 listener → 是 Agent Chrome？有 lease 且 owner 匹配 = active；无 lease = durable 占用；非 Agent = external（绝不杀）
2. 无 listener 但有 lease → owner 存活且锁龄 < 启动宽限期（8s）= starting（忙）；owner 活但超宽限期无 listener = zombie；owner 死 = orphan（可回收）
3. 旧锁兼容判定
4. 都没有 = free

`zombie`（owner 活但 Chrome 死）和 `orphan`（owner 死）都会被 `reserve` / `reap` 回收：先 SIGTERM 再 SIGKILL 掉僵尸 owner，再删锁（`zcode-cdp-lease.js:270-292, 348-370`）。

### 三种使用模式

| 模式 | 调用方 | lease？ | Chrome 起法 |
|------|--------|--------|------------|
| **lazy proxy** | ZCode 全局 MCP | 是（proxy 自动领/释） | 首次 `browser_*` 时 proxy 调 `cdp-takeover --managed` |
| **cdpcc** | Claude Code wrapper | 是（cdpcc 预占，hook 触发起 Chrome） | PreToolUse hook `cdp-ensure.sh` 调 `cdp-takeover` |
| **durable** | 用户脚本 / 人工 | 否 | `cdp-takeover <port>` 直起，长期常驻 |

---

## 6. cdp-takeover 双模式

`cdp-takeover` 是 Chrome 启动器，有两种模式（`cdp-takeover:13-24`）：

### durable（默认）

```
cdp-takeover              # 自动找 9223-9229 第一个空闲端口
cdp-takeover <port>       # 显式端口（含 93xx）
cdp-takeover <port> --refresh   # 强制从源 rsync profile（实例须已关）
```

人工或脚本直接调用，Chrome 跨客户端连接长期存在，**不创建会话 lease**。供直接 CDP 客户端（Python 裸 WebSocket / playwright `connect_over_cdp`）使用。

### managed（`--managed --lease-id <id>`）

```
cdp-takeover <port> --managed --lease-id <id>   # proxy/cdpcc 内部调用
```

由 `zcode-cdp-proxy` 或 `cdpcc` 调用，核验调用者确实拥有该端口 lease 后启动 Chrome（`cdp-takeover:107-116, 174`）。proxy/cdpcc 退出时通过 lease 释放自动带走 Chrome。

### profile rsync（继承登录态）

Chrome 启动需要独立 profile（`--user-data-dir`），但用户希望 agent 能用自己已登录的账号。决策是**首次从源 profile rsync 继承，之后独立演化**（`cdp-takeover:210-224`）：

- 源：`$HOME/Library/Application Support/Google/Chrome`（`cdp-takeover:35`，即 macOS 标准 Chrome profile 目录）
- 目标：每端口独立目录（`PROFILE_DST`）
- 首次：`rsync -a --delete` 排除 `SingletonLock/Socket/Cookie/lockfile`
- 之后：独立演化，不覆盖（要刷新登录态用 `--refresh`）

profile 还会被打上**每端口不同的头像**（avatar_index），方便用户在屏幕上区分各实例（`cdp-takeover:226-257`）。

启动参数（`cdp-takeover:261-268`）：

```bash
--remote-debugging-port=<port>
--remote-allow-origins=*
--user-data-dir=<PROFILE_DST>
--window-position=<每端口不同>
--no-first-run --no-default-browser-check
```

启动后轮询 `lsof` 等端口监听，15s 不就绪判失败（`cdp-takeover:270-279`）。

---

## 7. 三层看门狗

proxy 是长驻进程，最大的事故风险是**主线程 busy-loop（99% CPU 裸奔十几小时）**。为此设计了三层看门狗，层层兜底。详细的事故复盘和演进史见 `docs/watchdog-postmortem.md`（本文只列机制）。

### 第 1 层：软看门狗（主线程 setInterval）

`startWatchdog()`（`zcode-cdp-proxy.js:689-725`）跑在主线程事件循环里：

- **CPU lag 检测**：`setInterval(1000)` 实测回调间隔，连续 `WATCHDOG_TRIES`（默认 3）次延迟 > `WATCHDOG_LAG_MS`（默认 2000ms）→ 说明事件循环被淹没 → `process.exit(99)` 同步退出（不走 async cleanup，避免间歇 busy-loop 卡死在 SHUTTING_DOWN）。
- **孤儿超时**：用 `lastBusinessTime`（只有真实 MCP 业务方法才刷新，`BUSINESS_METHODS` 正则白名单），超过 `ORPHAN_TIMEOUT_MS`（默认 30min）无真实业务 → 判孤儿退出。注意：不用 `lastStdinTime`，因为 zcode-cli 周期发的 keepalive/progress 噪声会刷新 stdin 心跳让孤儿检测失效。

### 第 2 层：硬看门狗（worker_threads 独立事件循环）

软看门狗跑在主线程，主线程 busy-loop 时它自己也被卡死。所以硬看门狗放到 `worker_threads` 里（`zcode-cdp-proxy.js:558-672`），worker 有独立的事件循环和 libuv 线程池。**双路检测：**

- **第 1 路（心跳缺失）**：主线程每 1s `postMessage` 心跳。worker 每 2s 检查，超过 `HARD_KILL_MS`（默认 60s）无新心跳 → worker 直接 `process.kill(mainPid, "SIGKILL")`。SIGKILL 不可被拦截，绕过所有 async cleanup 逻辑。
- **第 2 路（独立 CPU 检测）**：worker 自己 `execSync('ps -p <pid> -o time=')` 读主进程 CPU 时间，两次采样算增量 → CPU%。完全绕过主线程事件循环，专抓"间歇 busy-loop"（主线程反复陷长同步块、块间间隙让 setInterval 补跑、心跳照常发，第 1 路永远触发不了）。判定用**滑动窗口**（最近 `HARD_CPU_TRIES*2` 次采样里 ≥ `HARD_CPU_TRIES` 次超 `HARD_CPU_THRESHOLD`），容忍偶尔落在间隙的样本。

主进程 PID 由主线程启动时 `postMessage` 传给 worker（不依赖 worker 内 `process.pid/ppid` 歧义语义——旧版用 `process.ppid` 指向 launchd PID 1，普通用户 EPERM 失败导致硬看门狗形同虚设）。

硬看门狗 worker 启动失败直接 `process.exit(1)`（fail-loud）：硬看门狗是唯一能补救主线程 busy-loop 的防线，启动失败还继续跑等于裸奔，ZCode 会立即重拉新实例（`zcode-cdp-proxy.js:657-664`）。

### 第 3 层：异常兜底

`uncaughtException` / `unhandledRejection` handler 必须**纯同步、绝不写 stderr、直接 `process.exit`**（`zcode-cdp-proxy.js:941-954`）。这是 2026-07-26 事故的教训：父 zcode-cli 退出后 stderr pipe 对端关闭，任何 `log()` → `process.stderr.write` 抛 EPIPE → 触发 handler → handler 又 log → 又 EPIPE → 无限递归异常风暴，V8 疯狂抓栈占满 CPU，连 worker 线程都被拖累无法 SIGKILL。

### 启动期去重（防堆积）

`findOlderSiblingProxy()`（`zcode-cdp-proxy.js:862-904`）：启动时按 PPID 找同一 zcode-cli 名下更早的 proxy 实例。如果 sibling 是 busy-loop 僵尸（CPU > 50%）→ SIGKILL 它自己接管；如果正常 → 自己退出让位。从源头斩断"zcode-cli 反复 spawn 但不回收旧实例"导致的堆积。按 PPID 隔离保证不同 ZCode 窗口互不干扰。

---

## 附录：源码索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `bin/zcode-cdp-proxy.js` | ~700 | 懒加载 MCP 代理：请求观察 + ensure/teardown + 看门狗（核心） |
| `bin/zcode-cdp-relay.js` | ~120 | 本地 TCP 中继：挂起语义、attach/detach、纯字节管道 |
| `bin/zcode-cdp-lease.js` | ~460 | 统一端口租约管理（原子 mkdir + leaseId） |
| `bin/cdp-takeover` | ~280 | Chrome 启动器（durable / managed 双模式 + profile rsync） |
| `bin/cdpcc` | ~100 | Claude Code 启动 wrapper（注入 cdp MCP 配置 + 预占端口） |

详细看门狗事故复盘见 `docs/watchdog-postmortem.md`；回归验收见 `docs/backtest.md`。
