# Tasks: relay-architecture

## 1. 中继模块(在 proxy 内实现,可单测导出)

- [x] 1.1 实现 TCP 中继:随机端口监听、无 upstream 挂起(带 `CDP_RELAY_HOLD_MS`
      超时)、`attach(port)`/`detach()`/`stop()`、双向 pipe、每连接独立 upstream
      (独立模块 `bin/zcode-cdp-relay.js`)
- [x] 1.2 `test/relay.test.js`:挂起/接通/转发/detach-重连/failHeld/超时/stop 七场景

## 2. proxy 重写

- [x] 2.1 骨架:保留 CLI 解析、日志/EPIPE 防护、看门狗三层、限流、inBuf 上限、
      启动去重、orphan 心跳;状态机收敛为 IDLE/ENSURING/ACTIVE/CLOSING
      (CLOSING:close 释放过渡窗口,挡住窗口内到达的 browser_close 走真转发路径
      ——L2 回测抓出的行为缺口,旧架构 CLOSE_PENDING 的等价物)
- [x] 2.2 单 backend spawn(endpoint=中继端口)+ 全双工透传 + 请求观察
      (browser_* 触发 ensure、close 响应触发 teardown、IDLE/CLOSING close 假成功)
- [x] 2.3 ensure( reserve → startChrome 重试 → relay.attach → ACTIVE)与
      teardown(relay.detach → release → IDLE;完成时有挂起连接则自动重新 ensure,
      等价旧 activationBatch 重放);失败路径 failHeld 销毁挂起连接
- [x] 2.4 健康检查(ACTIVE 态 listener 消失/非 Agent → teardown,不杀非 Agent)
      与退出清理(SIGTERM/EOF 全资源释放,含 relay.stop)

## 3. 回测与验证

- [x] 3.1 stub-backend 补 TCP 连接行为(收到 browser_* 时连中继,--cdp-endpoint
      从 argv 解析;detach 断开后下次调用重连)
- [x] 3.2 `test/proxy.test.js` 适配 + 新增"backend 只 spawn 一次"断言(回归#3)
      + close 释放断言改轮询(stub 环境 teardown timer 偶发延迟,契约是最终一致);
      `npm test` 三连跑全绿(17 组)
- [x] 3.3 半 live:真 playwright-mcp + 真 Chrome 9224 + 隔离锁根 —— navigate →
      close(锁释放) → 再 navigate(重新激活,同一 backend) → close,零 Chrome
      残留,WS over 中继真实转发验证通过

## 4. 文档与收尾

- [x] 4.1 docs/architecture.md 重写为新架构;docs/backtest.md 补中继层说明
- [x] 4.2 CHANGELOG 0.2.0;README 架构一瞥更新
- [x] 4.3 同步 `~/bin/` 脚本;openspec validate --strict 通过后 archive
