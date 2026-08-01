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
│   zcode-cdp-proxy.js —— 状态机驱动的懒加载 MCP 代理                      │
│   每个会话独立 spawn 一个；持有 stdio，背后懒挂 playwright-mcp            │
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

**路径 A：MCP 工具调用（agent 驱动，懒加载）**

```
agent 决定调 browser_navigate
        │
        ▼  JSON-RPC over stdio
zcode-cdp-proxy.js  (state machine)
        │  首次 browser_* → RESERVING → STARTING_BROWSER → STARTING_BACKEND → ACTIVE
        ├─► zcode-cdp-lease.js   reserve()  领端口 9223-9229
        ├─► cdp-takeover --managed --lease-id <id>   起 Chrome
        └─► spawn 真 playwright-mcp（--cdp-endpoint http://127.0.0.1:<port>）
                │
                ▼  JSON-RPC over stdio（proxy 透传）
            playwright-mcp ──CDP──► Chrome（端口 922x）
```

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

> 替代 playwright-mcp 作为 config.json 里 cdp 的 command。每个 ZCode 会话独立 spawn 一个本 proxy 实例。proxy 全权持有 stdio(MCP JSON-RPC 通道)，背后懒挂一个 playwright-mcp 进程。

如果只写一个 skill 教 agent "去 spawn 一个 Chrome"，agent 每次调用都得自己想办法管这个 Chrome 的生命周期，跨调用状态完全无法保持。MCP 把这层复杂性藏在 daemon 里，agent 看到的就是干净的 `browser_*` 工具。

---

## 3. 状态机详解（核心）

整个 proxy 的行为由一个显式状态机驱动（`bin/zcode-cdp-proxy.js:80-109`）。状态机保证：在错误的时间收到的请求不会造成破坏（比如激活中收到的请求会被缓冲，不会丢也不会重复执行）。

### 状态定义

| 状态 | 含义 |
|------|------|
| `BOOTING` | 启动期，还没 spawn 占位 backend |
| `READY_IDLE` | 占位 backend 就绪，0 端口 0 Chrome，只应答 `initialize`/`tools/list` |
| `RESERVING` | 正在领端口租约 |
| `STARTING_BROWSER` | 正在起 Chrome（调 `cdp-takeover`） |
| `STARTING_BACKEND` | 正在起真 playwright-mcp + 内部握手 |
| `ACTIVE` | 真 backend 就绪，正常透传工具调用 |
| `CLOSE_PENDING` | 已转发 `browser_close`，等响应返回后释放 |
| `RELEASING` | 正在杀 Chrome + 删锁 + 重启占位 |
| `SHUTTING_DOWN` | 退出中（stdin EOF/SIGTERM/SIGINT/SIGHUP） |
| `EXITED` | 已退出 |

### 状态流转图

```
                              ┌─────────────┐
                              │   BOOTING   │
                              └──────┬──────┘
                                     │ spawn 占位 backend
                                     ▼
        ┌──────────────────────► READY_IDLE ◄──────────────────────┐
        │                       └──┬─────────┘                      │
        │                          │ 首次 browser_*                  │
        │                          ▼                                │
        │                    ┌───────────┐                          │
        │                    │ RESERVING │──── lease 失败 ──► failActivation ──► READY_IDLE
        │                    └─────┬─────┘                          ▲
        │                          │ lease OK                        │
        │                          ▼                                │
        │                ┌────────────────────┐                     │
        │                │ STARTING_BROWSER   │──── Chrome 起不来 ──┘
        │                └─────────┬──────────┘
        │                          │ Chrome 就绪
        │                          ▼
        │                ┌────────────────────┐
        │                │ STARTING_BACKEND   │──── backend 启动期退出 ──► failActivation ──► READY_IDLE
        │                └─────────┬──────────┘      （synthetic initialize 失败）
        │                          │ 握手完成 + flush batch
        │                          ▼
        │                      ┌────────┐
        │      browser_close   │ ACTIVE │──── Chrome 异常 / backend 死 ──► handleBackendFailure ──┐
        │   ┌─────────────────►└───┬────┘                                                          │
        │   │                      │ 记录 closeRequestId, 转 CLOSE_PENDING                          │
        │   │                      ▼                                                                │
        │   │              ┌───────────────┐                                                        │
        │   │              │ CLOSE_PENDING │                                                        │
        │   │              └──────┬────────┘                                                        │
        │   │                     │ 收到 close 响应 → 先返回给 ZCode                                 │
        │   │                     ▼                                                                  │
        │   │              ┌────────────┐                                                            │
        │   │              │ RELEASING  │                                                            │
        │   │              └─────┬──────┘                                                            │
        │   │                    │ 杀 Chrome + 删锁 + 重启占位                                       │
        │   └────────────────────┼──────────────────────────────────────────────────────────────────┘
        │                        │
        └────────────────────────┘  (回 READY_IDLE)

   任何状态  ──── stdin EOF / SIGTERM / SIGINT / SIGHUP ────►  SHUTTING_DOWN  ────►  EXITED
```

### 关键设计点

**1. READY_IDLE 时只有占位 backend，不起 Chrome。** proxy 一启动就 spawn 一个"占位"playwright-mcp，它的 `--cdp-endpoint` 指向 `http://127.0.0.1:1`（无效地址，`PLACEHOLDER_ENDPOINT`，见 `zcode-cdp-proxy.js:56`）。占位 backend 只负责应答 `initialize` 和 `tools/list`，绝不真正碰 CDP。所以**开 N 个不碰浏览器的 ZCode 窗口 = 0 个 Chrome 进程、0 个端口被领**——这是资源节约的根本机制。

**2. 首次 `browser_*` 才激活。** `handleClientLine` 检测到 `tools/call` 且方法名以 `browser_` 开头时（`zcode-cdp-proxy.js:780`），把请求入 `activationBatch`，触发 `startActivation` → `doActivate`。激活流程五步（`zcode-cdp-proxy.js:311-377`）：

```
RESERVING          领端口（lease.reserve）
STARTING_BROWSER   起 Chrome（cdp-takeover --managed，最多重试 5 次）
STARTING_BACKEND   杀占位 → 起真 backend（--cdp-endpoint 指向真实端口）
                   synthetic initialize 内部握手
ACTIVE             flush activationBatch（exactly-once）
```

**3. `browser_close` 先返回响应再释放。** 见 `zcode-cdp-proxy.js:819-825, 254-264`：进入 `CLOSE_PENDING`，转发请求并记下 `closeRequestId`；当 backend 输出该 id 的响应时，**先把响应写给 ZCode**，再异步 `releaseAfterClose`。这样 agent 看到的是"close 成功"，而不是"close 超时/无响应"。

**4. Chrome 异常不自动重放。** 任何异常（real backend 退出、Chrome listener 消失、stdout 限流熔断）都走 `handleBackendFailure`：当前调用失败、释放租约、回 `READY_IDLE`。**不会重放**刚才的请求——因为重放可能导致"重复提交订单/重复发帖"。agent 自己决定要不要重试。

**5. READY_IDLE 收到 `browser_close` 直接返回成功。** 不需要起 Chrome 来关 Chrome（`zcode-cdp-proxy.js:786-797`）。

---

## 4. 关键正确性修复（vs 朴素实现）

一个"朴素实现"会直接把 stdio 桥接到 playwright-mcp，再起个 Chrome。这在生产里会出各种竞态。proxy.js 头部注释列了五条关键修复（`zcode-cdp-proxy.js:18-24`），逐条解释：

### 4.1 exactly-once enqueue（精准一次入队）

激活期间（`RESERVING` / `STARTING_BROWSER` / `STARTING_BACKEND`）到达的所有请求，无论是否 `browser_*`，都进 `activationBatch`，且**去重**（按原始行比对，`zcode-cdp-proxy.js:813`）。激活完成后一次性 flush 给真 backend。这保证：

- 激活期间到达的请求不会丢（不会因为 backend 还没起好就被拒绝）。
- 不会重复执行（同一个请求不会被转发两次）。

### 4.2 synthetic initialize（内部握手）

真 backend 起来后，**不能直接 flush 工具请求**——playwright-mcp 要求先完成 MCP 握手（`initialize` → `notifications/initialized`）才会处理后续请求。但 ZCode 已经和占位 backend 握过手了，不会再来一次。

解法（`zcode-cdp-proxy.js:271-301`）：proxy 自己用特殊 id `__cdp_proxy_synthetic_init__` 发一个 `initialize`，收到响应后**吞掉**（不转发给 ZCode），再发 `notifications/initialized`，然后才 flush batch。`handleBackendLine` 会拦截这个 id（`zcode-cdp-proxy.js:243-252`）。

### 4.3 browser_close response-aware（先响应后释放）

见上文 §3 设计点 3。`handleBackendLine` 检测 `closeRequestId` 匹配的响应，先 `process.stdout.write` 给 ZCode，再 `serialize(() => releaseAfterClose())`（`zcode-cdp-proxy.js:255-264`）。顺序至关重要：先释放会导致 agent 收不到响应。

### 4.4 backend generation fencing（世代隔离）

`backendGeneration` 是个单调递增计数器，每次 spawn backend 都自增（`zcode-cdp-proxy.js:135`）。`wireBackendOutput` 给每个 backend 闭包绑定它自己的 generation，输出回调里检查 `if (backend !== b) return`（`zcode-cdp-proxy.js:210`）——**旧 placeholder 迟到的输出不会污染新 real backend 的 stdout 流**。这在 placeholder 被杀但 stdout buffer 里还有残余数据时尤其重要。

### 4.5 激活失败 settle batch（批量结算）

激活失败时（lease 失败、Chrome 起不来、backend 启动期退出），`failActivation` 调 `settleBatch`：对 `activationBatch` 里**每个有 id 的 request 各返回一次 error**，然后清空 batch（`zcode-cdp-proxy.js:425-463`）。这保证 agent 每个挂起的请求都拿到一次明确答复（不会无限挂起，也不会答复两次），然后回 `READY_IDLE` 等下次调用。

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
| `bin/zcode-cdp-proxy.js` | 979 | 状态机驱动的懒加载 MCP 代理（核心） |
| `bin/zcode-cdp-lease.js` | 455 | 统一端口租约管理（原子 mkdir + leaseId） |
| `bin/cdp-takeover` | 279 | Chrome 启动器（durable / managed 双模式 + profile rsync） |
| `bin/cdpcc` | 86 | Claude Code 启动 wrapper（注入 cdp MCP 配置 + 预占端口） |

详细看门狗事故复盘见 `docs/watchdog-postmortem.md`。
