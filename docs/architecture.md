# Architecture / 架构

面向想理解 zcode-cdp 内部设计、做贡献、或评估能否在自己环境跑的开发者。所有声称可对照 `bin/` 下源码核验。

---

## 1. 三层架构

zcode-cdp 解决的问题是：**让 AI agent 能在用户已登录的真实 Chrome 上跑浏览器自动化，同时不浪费资源（不碰浏览器的窗口 = 0 Chrome 进程）。**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          第 1 层：能力层 (MCP)                           │
│   zcode-cdp-proxy.js —— 懒加载 MCP 代理(请求观察者 + Chrome 生命周期)      │
│   zcode-cdp-relay.js —— 本地 TCP 中继(backend 的 endpoint 永远有效)       │
│   每个会话独立 spawn 一个；持有 stdio，背后常驻一个 playwright-mcp          │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ 首次 browser_* 调用时才下沉
┌──────────────────────────────▼──────────────────────────────────────────┐
│                       第 2 层：编排 / 启动层                             │
│   cdp-takeover       —— Chrome 启动器（durable / managed 双模式）         │
│   zcode-cdp-lease.js —— 端口租约管理（原子 mkdir + leaseId ownership）    │
│   cdpcc              —— Claude Code 启动 wrapper（注入 cdp MCP 配置）     │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ 起好的 Chrome 监听固定端口
┌──────────────────────────────▼──────────────────────────────────────────┐
│                       第 3 层：直连客户端层                              │
│   Python / playwright 脚本，裸 WebSocket 或 connect_over_cdp 直连        │
│   固定端口 durable Chrome（93xx，不进会话租约池）                        │
└─────────────────────────────────────────────────────────────────────────┘
```

**路径 A：MCP 工具调用**（agent → proxy 观察透传 → lease 领端口 → cdp-takeover 起 Chrome → 中继接通 → playwright-mcp 工具直达）。
**路径 B：直连客户端**（脚本 → durable Chrome 固定端口）。两路径共享启动器与端口/profile 双层隔离；租约模型不同：会话池走 lease，固定端口只判"忙"。

**为什么是 MCP 不是 skill**：浏览器是需要常驻进程托着的有状态资源（navigate → click 登录 → type 密码，每步依赖同一个活 Chrome）。skill 是说明书，没有"持有进程"的能力；daemon + 结构化工具 = MCP。

## 2. 状态机（核心）

proxy 是**请求观察者**：所有 client→backend 消息照常透传，仅解析后观察 `browser_*` 调用并驱动 Chrome 生命周期。

| 状态 | 含义 |
|------|------|
| `IDLE` | 0 端口租约 0 Chrome；backend 常驻应答 `initialize`/`tools/list` |
| `ENSURING` | 正在领租约 + 起 Chrome + 接通中继（期间请求靠中继挂起语义流动） |
| `ACTIVE` | Chrome 在线，一切透传 |
| `CLOSING` | `browser_close` 响应已返回、资源释放中的过渡窗口 |
| `SHUTTING_DOWN` → `EXITED` | 退出中（stdin EOF / SIGTERM…）→ 已退出 |

关键设计（每条都对应过真实 bug）：

1. **首次 `browser_*` 才激活，请求不缓冲**：IDLE 时异步 `ensure()`（reserve → cdp-takeover → relay.attach），请求照常转发——backend 连中继因无 upstream 被**挂起**（上限 `CDP_RELAY_HOLD_MS` 默认 30s），Chrome 就绪后自然流动。TCP 挂起语义替代应用层缓冲/去重/结算代码，时序天然正确。
2. **本地 TCP 中继让 endpoint 永远有效**：playwright-mcp 的 `--cdp-endpoint` 是启动参数不可运行时改；中继（纯字节管道，每连接独立 upstream）让 backend endpoint 固定指向中继，Chrome 端口轮换只发生在 upstream 侧，backend 无感知。
3. **`browser_close` 先响应后释放**：先把 close 成功响应写给 agent，再异步 teardown（断中继 → 释放租约[内含杀 Chrome] → 回 IDLE）。
4. **CLOSING 窗口防御**：释放进行中到达的 close 直接回成功（"正在关闭"与"已关闭"等价），不转发——否则 backend 重连中继 → 挂起 → teardown 完成误判新需求 → 无限激活循环。
5. **Chrome 异常不自动重放**：健康检查发现 listener 消失 → teardown 回 IDLE，不重放刚才的请求——重放可能导致重复提交/发布；agent 自己决定是否重试。
6. **teardown 自动重激活**：释放期间到达的新 browser_* 触发的挂起连接，在新一轮 ensure 后自然流动。

## 3. 端口池与租约

`zcode-cdp-lease.js` 是统一租约管理器，被 proxy（require）和 cdpcc / cdp-takeover（CLI）共享。

| 端口段 | 用途 | 进租约池 |
|--------|------|-----------|
| 9223-9229（7 个） | 会话临时池 | 是（`CDP_PORTS`） |
| 9324, 9326 | 脚本固定端口（durable 直连） | 否（`CDP_SCRIPT_PORTS`，只判端口忙） |

分两段的原因：durable Chrome 的登录态是长期积累的稀缺资源，绝不能被会话池 pick 走。每端口还有独立 profile（`--user-data-dir`）与不同头像，做到**端口 + profile 两层隔离**。

锁与不变量、端口忙判定、回收规则、CLI 完整说明见 [port-lease.md](port-lease.md)。

## 4. cdp-takeover 双模式

- **durable**（默认）：`cdp-takeover [port] [--refresh]`，人工/脚本直调，跨客户端长期存在，不创建会话 lease。
- **managed**（`--managed --lease-id <id>`）：由 proxy / cdpcc 调用，核验租约所有权后启动；proxy/cdpcc 退出时通过 lease 释放自动带走 Chrome。参数组 fail-loud：`--managed` 必须与 `--lease-id`、显式端口成对传入，缺任一即 stderr 报错并 exit 1，绝不静默跳过 lease 核验按 durable 降级启动。

启动参数：`--remote-debugging-port` / `--remote-allow-origins=*` / `--user-data-dir=<每端口目录>` / 每端口不同 `--window-position` / `--no-first-run --no-default-browser-check`；启动后轮询端口监听，15s 不就绪判失败。

**profile rsync（登录态继承）**：首次从日常 Chrome（macOS 默认 `~/Library/Application Support/Google/Chrome`）`rsync -a --delete` 到每端口目录，排除 `Singleton*` 与 `lockfile`；之后独立演化，`--refresh` 强制刷新（拒绝在存活实例上执行——热 profile 上 rsync 会损坏 SingletonLock）。详见 [profile-management.md](profile-management.md)。

## 5. 稳定性：三层看门狗 + 限流

长驻 daemon 最大的风险是主线程 busy-loop（同步死循环/长同步块占满 CPU，事件循环被阻塞）。三层防线：

- **第 1 层软看门狗**（主线程 setInterval）：事件循环延迟连续 3 次 > 2s → 同步 `exit(99)`；孤儿检测用 `lastBusinessTime`（只有真实 MCP 业务方法刷新，客户端 keepalive 噪声不算），30min 无业务退出。
- **第 2 层硬看门狗**（worker_threads 独立事件循环——主线程卡死时它是唯一救星）：双路检测。心跳缺失 > 60s → SIGKILL；worker 独立采样主进程 CPU%（`ps -o time=` 增量法，绕过主线程事件循环），滑动窗口内多次超阈值 → SIGKILL，专抓间歇 busy-loop。worker 启动失败直接 fail-loud 退出。
- **第 3 层异常兜底**：`uncaughtException`/`unhandledRejection` handler 纯同步、绝不写 stderr、直接 exit——父进程退出后 stderr 对端关闭，handler 里写日志会触发 EPIPE 递归异常风暴。
- **限流**：backend stdout 限流超限丢弃+告警（大 snapshot 是合法场景），不杀 backend；stdin inBuf 上限防无换行堆积。
- **启动期去重**：按 PPID 找同客户端名下更早的 proxy 实例，busy-loop 僵尸 → SIGKILL 接管，正常 → 自己让位。

全部阈值可环境变量覆盖（`CDP_ORPHAN_TIMEOUT_MS` / `CDP_HARD_KILL_MS` / `CDP_HARD_CPU_THRESHOLD` / `CDP_RELAY_HOLD_MS` 等，见脚本头部）。回归保障见 [backtest.md](backtest.md)：L0 静态 / L1 租约 / L2 状态机三层，`npm test` 一键跑、零真实 Chrome 副作用。

## 附录：组件清单

| 文件 | 职责 |
|------|------|
| `bin/zcode-cdp-proxy.js` | 懒加载 MCP 代理：请求观察 + ensure/teardown + 看门狗 |
| `bin/zcode-cdp-relay.js` | 本地 TCP 中继：挂起语义、attach/detach、纯字节管道 |
| `bin/zcode-cdp-lease.js` | 统一端口租约管理（原子 mkdir + leaseId） |
| `bin/cdp-takeover` | Chrome 启动器（durable / managed 双模式 + profile rsync） |
| `bin/cdpcc` | Claude Code 启动 wrapper（注入 cdp MCP 配置 + 预占端口） |
