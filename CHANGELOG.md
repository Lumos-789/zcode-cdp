# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- 文档：端口表同步 9325 durable 槽实况——README / architecture / port-lease / troubleshooting 标注 cdp-takeover 内置 9324 9325 9326（9325 为 MjAI 周榜守护专用）；lease 默认 `CDP_SCRIPT_PORTS=9324 9326` 不变
## [0.2.0] — 2026-08-15

- relay 架构：本地 TCP 中继 + 单常驻 backend，激活循环零重启；CLOSING 过渡态防重复激活
- 回归测试体系：L0 静态 / L1 租约 / L1.5 中继 / L2 状态机，`npm test` 一键跑
- `cdp-takeover`：启动前从日常 profile 恢复扩展工具栏 pin 状态

## [0.1.0] — 2026-08-02

- 首个公开版本：proxy / lease / takeover / cdpcc 四核心脚本
- 端口租约（原子 mkdir + leaseId）、profile 登录态继承、三层看门狗、六篇文档

[Unreleased]: https://github.com/Lumos-789/zcode-cdp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Lumos-789/zcode-cdp/releases/tag/v0.2.0
[0.1.0]: https://github.com/Lumos-789/zcode-cdp/releases/tag/v0.1.0
