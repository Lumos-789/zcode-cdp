# zcode-cdp

让 AI Agent 通过 Chrome DevTools Protocol 接管一台真实、已登录的 Chrome——带端口租约、看门狗与状态机治理的 MCP 工具集。仅支持 macOS。

## 安装

需要 Node >= 18。两种方式任选：

```bash
git clone https://github.com/Lumos-789/zcode-cdp.git && cd zcode-cdp
npm i -g .        # 装出 zcode-cdp-proxy / zcode-cdp-lease / cdp-takeover 三个命令
# 或把本仓 bin/ 目录加进 PATH
```

## 注册为 MCP server

见 [`config/mcp-server.example.json`](config/mcp-server.example.json)：Claude Code 直接把整个文件内容作为项目 `.mcp.json`；ZCode 取内层 `cdp` 对象放进 `~/.zcode/cli/config.json` 的 `mcp.servers`。

## 端口模型

- `9223-9229`：会话临时池，最多 7 个并发 Agent Chrome，proxy 按租约自动 pick。
- `93xx`：durable 固定端口约定，供人工长期常驻或 Python/playwright 直连客户端，不进租约池。

## 安全提示

- 首次在某端口启动会把日常 Chrome profile（含登录态）rsync 复制到 `~/.chrome-takeover-<port>`，之后独立演化。热拷贝活体 profile 存在登录态快照不一致的概率风险——重要账号操作前建议先关闭日常 Chrome。
- profile 目录命名中的 `chrome-takeover` 是运行时红线，不可改名：Agent Chrome 的判定（`isAgentChromePid`）依赖进程参数里的这个目录名，改名会导致租约治理认不出 Agent Chrome。

## 测试

```bash
npm test    # = bash test/backtest.sh，零真实 Chrome、不碰生产端口的分层回测
```
