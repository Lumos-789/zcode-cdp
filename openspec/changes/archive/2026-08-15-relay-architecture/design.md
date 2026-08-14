# Design: relay-architecture

## 核心思路

用一个"永远有效的 endpoint"消灭双 backend 切换。proxy 启动时开本地 TCP 中继
(`127.0.0.1:0` 随机端口),backend 的 `--cdp-endpoint` 指向中继并常驻一生。
Chrome 的起停、端口轮换全部发生在中继的 upstream 侧,backend 无感知
(对它只是"断线重连",2026-08-15 实验证实 playwright-mcp 支持该模式)。

## 组件与数据流

```
ZCode(stdio JSON-RPC)
   │ 全双工透传(proxy 只观察,不代办协议)
zcode-cdp-proxy ──观察: browser_* 触发 ensure / browser_close 响应触发 teardown
   │                    ┌─ TCP 中继(挂起语义) ─┐
   └─ spawn 一次 ──▶ playwright-mcp ──connect──▶ │(无 upstream 时挂起)
                                                  │(有 upstream 时 pipe)
                                     接管 Chrome :9223-9229(upstream,动态)
```

### TCP 中继(新增,~50 行)

- `net.createServer`,listen `127.0.0.1:0` 拿随机端口;纯字节 `pipe` 双向,零解析。
- 无 upstream 时:client socket 挂起(不 destroy),存入 pending 队列;upstream
  接通时逐个 `net.connect` 接上。挂起超时(默认 30s,`CDP_RELAY_HOLD_MS`)销毁,
  让 backend 收到连接错误。
- teardown 时:主动 destroy 当前管道两侧 socket(backend 的 WS 随之断开,触发其
  内部清理;下次调用它会重连中继)。
- 每条 client 连接独立接 upstream(支持 playwright 多连接)。

### 请求观察(替代原状态机分发)

所有 client→backend 消息照常透传,仅解析后做三件事:

1. `tools/call browser_*`(非 close)且 `state === IDLE` → 触发 `ensure()`
   (异步;请求本身不缓冲——中继挂起语义保证它等 Chrome 就绪后自然流动)。
2. `tools/call browser_*` 且 `state === ENSURING` → 忽略(ensure 已在途)。
3. `browser_close`:ACTIVE 态转发并记录请求 id,响应到达后触发 `teardown()`;
   IDLE 态直接回成功响应(与旧版一致)。

### ensure / teardown

- `ensure()`: `L.reserve(kind)` → `startChrome(port)`(沿用重试 + 幂等逻辑,
  `cdp-takeover <port> --managed --lease-id`) → 等端口 listener → `relay.attach(port)`
  → `state = ACTIVE`。失败:销毁挂起连接(backend 报错给客户端)→ 释放 → IDLE。
- `teardown()`: `relay.detach()`(destroy 管道)→ `L.release(port, leaseId)`
  (内部杀 Agent Chrome + 删锁)→ `state = IDLE`。

### 状态机(9 → 3)

`IDLE → ENSURING → ACTIVE → IDLE`;退出路径 `SHUTTING_DOWN → EXITED`。
CLOSE 过程并入 teardown(异步完成,期间新 `browser_*` 若到达,teardown 完成后由
IDLE 分支重新触发 ensure——天然的重放语义,替代旧 activationBatch 重放)。

### 保留原样的部分

`resolvePlaywrightMcpCli`、日志与 EPIPE 防护、三层看门狗(worker 线程源码)、
stdout/stderr 限流、inBuf 上限、启动期 `findOlderSiblingProxy` 去重、orphan
业务心跳、`cleanupAndExit` 信号语义、lease.js 与 cdp-takeover 全部。

## 删除的部分(对应旧代码)

placeholder/real 双 backend、`spawnBackend` 的 role/generation、synthetic
initialize(`SYNTHETIC_INIT_ID`/`cachedClientInit`/`sendSyntheticInit`)、
`activationBatch` 与 exactly-once 去重、generation fencing、`closeRequestId`
之外的 `restartPlaceholder`、`handleBackendDied` 的角色分派(backend 死 = proxy
死,唯一实例无切换语义)。

## 测试策略

- `test/relay.test.js`(新增,单测层):直接驱动中继模块——无 upstream 挂起、
  接通转发、detach 后新连接走新 upstream、挂起超时。
- `test/proxy.test.js`(适配):对外断言全部保留(懒激活、激活、close、close 后
  tools/list、再激活、IDLE close、SIGTERM 清理);新增"backend PID 跨激活循环
 不变"断言。stub-backend 需补一条:收到 `tools/call` 时向中继发起 TCP 连接
  (模拟 playwright 的连接行为),使 L2 能覆盖中继路径。
- 半 live(手动,不进 `npm test`):真 playwright-mcp + 真 Chrome(9224 既有
  profile)+ 隔离 `CDP_LOCK_ROOT`,验证 WS 转发与 close 重连。

## 已知权衡

- ensure 期间到达的请求依赖中继挂起而非应用层缓冲:语义等价,但挂起超时(30s)
  内 ensure 必须完成(实际 3-5s);超时销毁会让该请求收到连接错误——与旧架构
  activation 失败返回 error 的行为对齐。
- backend 成为单点:它崩溃则 proxy 退出(ZCode 重拉新实例)。旧架构 placeholder
  崩溃同样导致退出,风险面不变。
