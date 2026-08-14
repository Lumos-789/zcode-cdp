## ADDED Requirements

### Requirement: 懒激活与零闲置成本

系统在 MCP 客户端连接后、任何 `browser_*` 工具调用发生前,SHALL 不启动 Chrome、
不持有端口租约(IDLE 态 = 0 Chrome 进程 + 0 端口租约),但 SHALL 正常应答
`initialize` 与 `tools/list` 等协议请求。

#### Scenario: 激活前零占用
- **WHEN** proxy 启动并完成 `initialize` / `tools/list` 握手,尚未发生任何 `browser_*` 调用
- **THEN** 端口租约目录不存在,且无 Chrome 进程被启动

#### Scenario: 首次浏览器调用触发 ensure
- **WHEN** 处于 IDLE 态时收到 `tools/call browser_navigate`
- **THEN** 系统领取一个池内端口租约,启动该端口的接管 Chrome,接通中继后放行请求
- **AND** 该请求最终收到成功响应(而非排队超时)

### Requirement: 单常驻 backend

系统 SHALL 在整个 proxy 生命周期内只 spawn 一次 `@playwright/mcp` backend 进程,
其 endpoint 固定指向本地中继;浏览器激活、关闭、再激活的任意循环 SHALL NOT
导致 backend 进程重启。

#### Scenario: 激活循环不重启 backend
- **WHEN** 依次执行 `browser_navigate` → `browser_close` → `browser_navigate`
- **THEN** backend 进程 PID 保持不变

#### Scenario: close 后非浏览器请求立即应答
- **WHEN** `browser_close` 响应返回后再发送 `tools/list`
- **THEN** 收到正常工具清单响应(不悬挂、不需要客户端重新 initialize)

### Requirement: 本地 TCP 中继

系统 SHALL 在 `127.0.0.1` 的随机端口维护一个无状态 TCP 中继作为 backend 与
接管 Chrome 之间的字节管道;中继 SHALL NOT 解析或修改转发内容。

#### Scenario: 无 upstream 时挂起连接
- **WHEN** upstream(接管 Chrome)未就绪时 backend 向中继发起连接
- **THEN** 连接被挂起(不拒绝、不报错),直至 upstream 接通或挂起超时

#### Scenario: upstream 切换后新连接走新 upstream
- **WHEN** 接管 Chrome 被关闭并在另一端口重新启动后,backend 发起新连接
- **THEN** 新连接的数据被转发到新的 upstream 端口

### Requirement: browser_close 生命周期语义

`browser_close` 的响应 SHALL 先返回给客户端;响应返回后系统 SHALL 断开中继
upstream、关闭接管 Chrome、释放端口租约并回到 IDLE 态。IDLE 态收到
`browser_close` SHALL 直接返回成功响应(不启动 Chrome)。

#### Scenario: close 释放全部资源
- **WHEN** ACTIVE 态执行 `browser_close` 并收到响应
- **THEN** 端口租约被删除,接管 Chrome 进程退出,系统回到 IDLE

#### Scenario: IDLE 态 close 为无操作成功
- **WHEN** IDLE 态收到 `browser_close`
- **THEN** 直接收到成功响应,且无 Chrome 启动、无租约创建

### Requirement: 异常与退出清理

Chrome 在 ACTIVE 态消失或端口 listener 变为非接管 Chrome 时,系统 SHALL 释放
租约回到 IDLE(不杀非 Agent 进程);proxy 退出(stdin EOF / SIGTERM / SIGINT /
SIGHUP)时 SHALL 终止 backend、关闭接管 Chrome 并删除自有租约锁。

#### Scenario: Chrome 消失后回 IDLE
- **WHEN** ACTIVE 态下接管 Chrome 的端口 listener 消失
- **THEN** 系统释放租约回到 IDLE,后续 `browser_*` 调用可重新触发 ensure

#### Scenario: 持租约退出时清理
- **WHEN** proxy 持有租约且处于 ACTIVE 态时收到 SIGTERM
- **THEN** proxy 退出且租约锁目录被删除

### Requirement: 防护机制保持

系统 SHALL 保留既有防护机制:三层看门狗(事件循环延迟 / 孤儿业务超时 /
worker 线程硬看门狗)、backend stdout 限流与缓冲上限、stdin inBuf 上限、
启动期同父进程去重、异常处理器纯同步退出(EPIPE 教训)。

#### Scenario: 看门狗常量可配置
- **WHEN** 通过环境变量(如 `CDP_WATCHDOG_LAG_MS`、`CDP_HARD_KILL_MS`)设置阈值
- **THEN** 系统使用覆盖值且不影响其他默认阈值
