#!/bin/bash
# zcode-cdp 标准回测(回归验证)流程 — 总入口
#
# 分层(由快到慢,由静到动;上层失败不影响下层继续跑,最后汇总):
#   L0 静态自检     语法 + 关键契约 marker(chrome-takeover / 端口池 / 默认锁路径)
#   L1 lease 单元   临时 CDP_LOCK_ROOT 隔离,reserve/release/check/reap 生命周期
#   L2 proxy 状态机 stub 化 backend+takeover,端到端 激活→close→rearm→再激活
#
# 全程零真实 Chrome、零用户 profile 副作用、不碰生产 9223-9229 端口。
# 改代码后跑 `npm test`。

set -uo pipefail
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "[PASS] $1"; }
bad()  { FAIL=$((FAIL+1)); echo "[FAIL] $1"; }
check() { # check <描述> <命令...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else bad "$desc"; fi
}

echo "===== L0 static(语法 + 契约 marker)====="
check "node --check bin/zcode-cdp-proxy.js" node --check bin/zcode-cdp-proxy.js
check "node --check bin/zcode-cdp-lease.js"  node --check bin/zcode-cdp-lease.js
check "bash -n bin/cdp-takeover"  bash -n bin/cdp-takeover
check "bash -n bin/cdpcc"         bash -n bin/cdpcc
check "bash -n hooks/cdp-ensure.sh" bash -n hooks/cdp-ensure.sh

# 契约 marker:改了会出事故的锚点(见 skill/README 红线)
grep -q 'chrome-takeover-' bin/cdp-takeover \
  && ok "marker: profile 目录 ~/.chrome-takeover-<port>" \
  || bad "marker: profile 目录 ~/.chrome-takeover-<port>"
grep -q 'chrome-takeover' bin/zcode-cdp-lease.js \
  && ok "marker: lease 的 isAgentChromePid 判定" \
  || bad "marker: lease 的 isAgentChromePid 判定"
grep -q '9223 9224 9225 9226 9227 9228 9229' bin/zcode-cdp-lease.js \
  && ok "契约: lease SHARED_PORTS = 9223-9229" \
  || bad "契约: lease SHARED_PORTS = 9223-9229"
grep -q '9223 9224 9225 9226 9227 9228 9229' bin/cdp-takeover \
  && ok "契约: takeover PORTS 与 lease 池一致" \
  || bad "契约: takeover PORTS 与 lease 池一致"
grep -q '/tmp/zcode-cdp/ports' bin/zcode-cdp-lease.js \
  && ok "契约: 默认 LOCK_ROOT=/tmp/zcode-cdp/ports" \
  || bad "契约: 默认 LOCK_ROOT=/tmp/zcode-cdp/ports"
grep -q 'zcode-cdp-lease.js' bin/zcode-cdp-proxy.js \
  && ok "契约: proxy require lease(同目录)" \
  || bad "契约: proxy require lease(同目录)"
grep -q 'zcode-cdp-relay.js' bin/zcode-cdp-proxy.js \
  && ok "契约: proxy require relay(中继模块)" \
  || bad "契约: proxy require relay(中继模块)"
grep -q -- '--managed' bin/cdp-takeover && grep -q -- '--lease-id' bin/cdp-takeover \
  && ok "契约: takeover managed 模式参数" \
  || bad "契约: takeover managed 模式参数"
node -e "const p=require('./package.json');for(const f of Object.values(p.bin)){require('fs').accessSync(f)}" \
  && ok "package.json bin 四入口文件齐全" \
  || bad "package.json bin 四入口文件齐全"

echo ""
echo "===== L1 lease 单元(隔离锁根,无 Chrome)====="
if node test/lease.test.js; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo ""
echo "===== L1.5 relay 单元(TCP 中继,纯内存)====="
if node test/relay.test.js; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo ""
echo "===== L2 proxy 状态机(stub backend/takeover 端到端)====="
if node test/proxy.test.js; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo ""
echo "===== 汇总 ====="
echo "L0+L1+L2 合计: $PASS 组通过, $FAIL 组失败"
if [ "$FAIL" -gt 0 ]; then
  echo "❌ BACKTEST FAILED"
  exit 1
fi
echo "✅ BACKTEST ALL GREEN"
