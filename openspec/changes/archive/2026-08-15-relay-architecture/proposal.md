# Proposal: relay-architecture

## Why

当前 `bin/zcode-cdp-proxy.js`(997 行,9 状态状态机)的核心复杂度来自一个可绕开的约束:
`@playwright/mcp` 的 `--cdp-endpoint` 是启动参数,运行时不可改;而 MCP 客户端(ZCode)
只在连接建立时发送一次 `initialize`。为了让 proxy 在浏览器未激活时也能应答协议握手,
旧架构维护了 placeholder/real 双 backend 切换,并配套 synthetic initialize、
activation batch(exactly-once 入队)、backend generation fencing、closeRequestId
拦截、placeholder rearm 等机制。

实证(2026-08-15 实验,见 docs/backtest.md 关联记录):playwright-mcp 单实例在
`browser_close` 之后可以完全复用(再次 `browser_navigate` 自动重建 context,
tools/list 正常)。即"每次 endpoint 变化就杀掉重启 backend"的前提不必要;
双 backend 切换及其全部配套机制都可以删除。2026-08-15 review 修复的两个
缺陷(rearm 握手缺失、缓冲请求悬挂)均发生在这条切换缝合线上——它是 bug 密集区。

## What Changes

- **重写 proxy 为"本地 TCP 中继 + 单常驻 backend"架构**:
  - proxy 启动时在 `127.0.0.1` 随机端口开一个无状态 TCP 中继(纯字节管道),
    backend 的 endpoint 永远指向该中继;backend 进程从生到死只起一次。
  - 中继无 upstream 时挂起新连接(带超时),upstream 就绪后接通——用连接挂起
    语义天然替代 activation batch,零缓冲代码。
  - proxy 作为 JSON-RPC 观察者:见 `browser_*` 调用且无 Chrome → 异步 ensure
    (reserve 端口 → cdp-takeover → 接通中继);`browser_close` 响应后 → 断中继、
    杀 Chrome、释放租约。所有消息始终透传(除 IDLE 态 `browser_close` 直接假成功)。
  - 状态机从 9 状态收敛为 IDLE / ENSURING / ACTIVE。
- **保留不动**(事故换来的稳定性资产):lease.js、cdp-takeover、三层看门狗、
  stdout 限流与 buf 上限、inBuf 上限、启动期去重、orphan 业务心跳、EPIPE 教训。
- **回测**:L2 状态机回测适配新架构(对外 JSON-RPC 语义不变,断言大部分保留),
  新增中继行为单测;L0/L1 原样。
- **文档**:docs/architecture.md 重写为新架构;CHANGELOG 记 0.2.0。

## Capabilities

### Modified
- `cdp-proxy`: 双 backend 切换 → 单常驻 backend + TCP 中继;行为契约
  (懒激活、close 释放、IDLE 零 Chrome、异常回 IDLE)保持不变。

## Impact

- 代码:`bin/zcode-cdp-proxy.js` 重写(约 997 → ~500 行);`test/proxy.test.js`
  适配 + `test/relay.test.js` 新增;docs 与 CHANGELOG。
- 兼容性:MCP 客户端(ZCode)零感知;config.json 无变化;cdpcc/durable 链路不受影响。
- 风险:WS over 中继的转发稳定性(透明字节管道,无解析;由回测 + 半 live 验证覆盖)。
- 回滚:git revert + 重新同步 `~/bin/`(config.json 的 command 路径不变)。
