# 标准回测(回归验证)流程

> 改任何 `bin/` 或 `hooks/` 下的代码后,跑 `npm test`。本文档定义回测分层、覆盖范围与
> 真机 live 冒烟的手动步骤。回测的定位是**回归防护网**:已知契约不回退、已修 bug 不复发。

## 分层设计

| 层 | 内容 | 依赖 | 耗时 | 脚本 |
|---|---|---|---|---|
| **L0 静态自检** | 语法检查 + 契约 marker 存在性 | 无 | ~2s | `test/backtest.sh` 内联 |
| **L1 lease 单元** | 端口租约生命周期(reserve/check/mark-active/release/reap/stale/zombie) | 无 Chrome | ~2s | `test/lease.test.js` |
| **L1.5 relay 单元** | TCP 中继七场景(挂起/接通/双向转发/detach-重挂/端口轮换/failHeld/超时/stop) | 无 Chrome | ~5s | `test/relay.test.js` |
| **L2 proxy 状态机** | 端到端:placeholder 应答 → 激活 → close → rearm → 再激活 → 退出清理 | stub backend + stub takeover | ~10s | `test/proxy.test.js` |

三层全部**零真实 Chrome、零用户 profile 副作用、不碰生产 9223-9229 端口**:

- L1/L2 用 `CDP_LOCK_ROOT` 指向临时目录、`CDP_PORTS` 指向 192xx 测试端口做环境隔离。
- L2 的 backend 是 `test/lib/stub-backend.js`(假 `@playwright/mcp`,标准 JSON-RPC 应答),
  takeover 是 `test/lib/stub-takeover`(起一个假 listener)。
- 假 listener 的脚本文件名故意含 `chrome-takeover`(`test/lib/chrome-takeover-stub-listener.js`),
  因此 lease 的 `isAgentChromePid` 认它是"Agent Chrome",release 链路会像杀真 Chrome 一样
  SIGTERM 它 —— 让 L2 验证完整的租约回收语义。

## 运行

```bash
npm test          # L0 + L1 + L2,全绿输出 "✅ BACKTEST ALL GREEN",任何失败 exit 1
bash test/backtest.sh   # 等价
node test/lease.test.js # 单跑某一层
node test/proxy.test.js
```

## 各层覆盖点

**L0 契约 marker**(改了会出事故的锚点,与 README「不可动的命名锚点」对应):

- profile 目录 `~/.chrome-takeover-<port>` 与 lease 的 `isAgentChromePid` 判定(运行时 marker)
- lease `SHARED_PORTS` 与 takeover `PORTS` 一致(9223-9229)
- 默认 `LOCK_ROOT=/tmp/zcode-cdp/ports`;proxy require lease(同目录耦合)
- takeover 的 `--managed --lease-id` 参数;package.json 四个 bin 入口齐全

**L1 租约不变量**:

- reserve 顺序分配 + 释放后可复用;池满返回 null
- release/mark-active 的 leaseId 归属校验(错 leaseId 拒绝,不误删他人锁)
- 死 owner → stale,reap 回收;活 owner 无 listener 超宽限期 → zombie
- `removeLockIfOwner` 非 owner 不动锁

**L2 状态机与回归用例**:

- IDLE = 0 端口 0 Chrome(激活前无锁),backend 常驻(全程只 spawn 一次)
- 首次 `browser_` 激活:reserve → takeover → relay.attach → 请求经中继流动
- `browser_close`:响应先返回,再释放租约回 IDLE(断言轮询等待最终一致 ——
  stub 环境下 teardown 的 timer 调度偶发延迟,见下"已知问题")
- **回归#1**: close 后 `tools/list` 仍能应答(单常驻 backend,无需重握手)
- **回归#2**: close 后再次 `browser_` 重新激活成功(teardown 自动重激活路径)
- **回归#3**: 全程 backend 只 spawn 一次(stderr 的 spawn 日志恰为 1 条)
- IDLE/CLOSING 收到 `browser_close` 直接成功响应(不起 Chrome)
- 持有租约时 SIGTERM → exit hook 清锁

**已知问题(未定位,如实记录)**:L2 stub 环境下偶发(约 6/7 概率、注入观察后消失的
Heisenbug)proxy 内 `setTimeout` 续体延迟 >1.5s(teardown 的轮询不推进),期间 IO
正常、退出清理正常完成、无资源泄漏;干净观察实验与半 live(真 playwright-mcp +
真 Chrome)多轮实测均正常。疑与 node `execSync` 嵌套事件循环/SIGCHLD reaping 交互
有关。回测断言因此对 close 释放采用轮询等最终一致(契约:锁最终删除),不锁精确耗时。
待验证条件:在 proxy 内以 async 版 portPid(替代 execSync)复测 L2 可否稳定复现。

## 半 live 验证(手动,不进 npm test)

真组件端到端(真 `@playwright/mcp` + 真 Chrome + 隔离 `CDP_LOCK_ROOT`):

```bash
# 用空闲池端口(如 9224,profile 已存在则秒起),锁根指向临时目录
CDP_LOCK_ROOT=$(mktemp -d) CDP_PORTS=9224 node <驱动脚本>
# 验证链:navigate 真实页面 → close(锁删) → 再 navigate(同 backend 重新激活)
# → close → 无 Chrome 残留(lsof 9224 为空)
```

2026-08-15 relay 架构验收实测:example.com → close → example.org 全链路通过,
backend 单实例,零残留。

## 已知盲区(为什么需要 live 冒烟)

stub 无法覆盖的部分,靠手动 live 验证:

1. **真 playwright-mcp 连接行为**(stub 不连 endpoint)
2. **真 Chrome 启动/profile rsync**(`cdp-takeover` 的 rsync、头像、窗口位置)
3. **health check 的 listener 校验**(L2 把 `CDP_HEALTH_CHECK_MS` 调大跳过了——stub listener
   之外的场景未覆盖)
4. **cdpcc / PreToolUse hook 链路**(需要真 Claude Code)

## live 冒烟(手动,只读优先)

```bash
# 1. 端口表应与真实占用一致(修复过的显示 bug 见 CHANGELOG 0.1.1)
cdp-takeover status

# 2. 活跃端口的真 Chrome 探活
curl -s http://127.0.0.1:9223/json/version | head -3

# 3. 需要完整链路验证时(有副作用,起真 Chrome):
cdp-takeover 9324                       # durable 模式起真 Chrome
curl -s http://127.0.0.1:9324/json/list # 确认 DevTools 可用
# 验完手动关掉该 Chrome(窗口 Cmd+Q 或 kill listener PID)
```

ZCode 会话内的最终验证:新开会话让 agent 调 `mcp__cdp__browser_navigate` → 操作 →
`browser_close`,观察 proxy 日志走完 `READY_IDLE → … → ACTIVE → RELEASING → READY_IDLE`。

## 新增回测用例的约定

- 修 bug 必须先把 bug 固化成失败用例(RED → GREEN),放进对应层:
  proxy 状态机问题进 L2,租约问题进 L1,命名/结构契约进 L0。
- 测试不依赖执行顺序残留状态(每 case 自清或从干净状态起)。
- 禁止在测试中触碰生产端口 9223-9229 与 93xx、用户 profile、真实 `@playwright/mcp`。
