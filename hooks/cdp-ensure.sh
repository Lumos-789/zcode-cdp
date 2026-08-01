#!/bin/bash
# cdp-ensure.sh — Claude Code PreToolUse hook(matcher: mcp__cdp__.*)
#
# 本 hook 服务 cdpcc(Claude Code 懒加载浏览器)链路。
# ZCode 的 cdp proxy 链路不依赖本 hook(proxy 自行管理 Chrome 启动),
# 普通 ZCode 会话没有 CDPCC_PORT,所以这里直接 exit 0 放行(no-op,预期行为)。
#
# agent 首次(及每次)调 mcp__cdp__* 工具前,确保本窗口端口的 Agent Chrome 在线。
# CDPCC_PORT 由懒加载 cdpcc 启动时 export,经 CC 主进程环境继承到此 hook 子进程。
#
# cdp-takeover 幂等:端口已有 Agent Chrome → 直接 exit 0(不重启);没有 → 起 + 等就绪
# (内部 ≤15s 轮询 lsof,就绪才返回)。返回后 playwright/mcp 的 connectOverCDP 才连。
cat >/dev/null  # 读掉 stdin(PreToolUse 输入 JSON),本脚本只靠触发,不解析内容

PORT="${CDPCC_PORT:-}"
if [ -z "$PORT" ]; then exit 0; fi  # 非 cdpcc 窗口本不会触发(无 cdp 工具),defensive 放行

if ! command -v cdp-takeover >/dev/null 2>&1; then
  echo "cdp-ensure: 未在 PATH 找到 cdp-takeover（请把本仓库 bin/ 加入 PATH 或设 CDP_TAKEOVER）" >&2
  exit 2
fi
if ! cdp-takeover "$PORT" >/tmp/cdpcc-ensure-$PORT.log 2>&1; then
  echo "cdp-ensure: 起端口 $PORT 的 Agent Chrome 失败,见 /tmp/cdpcc-ensure-$PORT.log" >&2
  exit 2   # block,让 Claude 知道浏览器没起来
fi
exit 0     # 放行工具调用
