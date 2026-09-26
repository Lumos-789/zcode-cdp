#!/bin/bash
# zcode-cdp 标准回测(回归验证)流程 — 总入口
#
# 分层(由快到慢,由静到动;上层失败不影响下层继续跑,最后汇总):
#   L0 静态自检     语法 + 关键契约 marker(chrome-takeover / 端口池 / 默认锁路径)
#   L1 lease 单元   临时 CDP_LOCK_ROOT 隔离,reserve/release/check/reap 生命周期
#                   + stale/zombie/durable 红线/TOCTOU 复核/并发竞态/cdpcc 拒发
#   L1.5 relay 单元 TCP 中继纯内存;L1.6 takeover CLI 真跑脚本(stub listener,零 Chrome)
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
# bin/cdpcc 与 hooks/cdp-ensure.sh 已下线删除(契约3),不再有 bash -n 检查;
# 其不存在由下方「三入口」检查的负向断言钉住

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
# CDP_PORTS 池覆盖口径一致:lease 走 portsEnv,takeover 走 read -a,默认池同为 9223-9229
grep -qF 'portsEnv("CDP_PORTS"' bin/zcode-cdp-lease.js \
  && grep -qF '${CDP_PORTS:-9223 9224 9225 9226 9227 9228 9229}' bin/cdp-takeover \
  && ok "契约: lease 与 takeover 均支持 CDP_PORTS 覆盖端口池(口径一致)" \
  || bad "契约: lease 与 takeover 均支持 CDP_PORTS 覆盖端口池(口径一致)"
grep -qF 'cdpcc 入口已下线' bin/zcode-cdp-lease.js \
  && ok "契约: lease 拒发 cdpcc 租约(入口已下线)" \
  || bad "契约: lease 拒发 cdpcc 租约(入口已下线)"
grep -q '/tmp/zcode-cdp/ports' bin/zcode-cdp-lease.js \
  && ok "契约: 默认 LOCK_ROOT=/tmp/zcode-cdp/ports" \
  || bad "契约: 默认 LOCK_ROOT=/tmp/zcode-cdp/ports"
grep -q 'zcode-cdp-lease.js' bin/zcode-cdp-proxy.js \
  && ok "契约: proxy require lease(同目录)" \
  || bad "契约: proxy require lease(同目录)"
grep -q 'zcode-cdp-relay.js' bin/zcode-cdp-proxy.js \
  && ok "契约: proxy require relay(中继模块)" \
  || bad "契约: proxy require relay(中继模块)"
# --managed 契约:grep 实际 fail-loud 报错文案(不是只 grep 参数名——只 grep 参数名时
# 删掉整个校验块仍会假绿)。删掉校验块,此串消失,本检查必须变红。
grep -qF -- '--managed 需要 --lease-id 与 --target-port' bin/cdp-takeover \
  && ok "契约: takeover --managed 缺参 fail-loud 报错文案存在" \
  || bad "契约: takeover --managed 缺参 fail-loud 报错文案存在"
node -e '
const fs = require("fs");
const p = require("./package.json");
const got = Object.keys(p.bin).sort();
const want = ["cdp-takeover", "zcode-cdp-lease", "zcode-cdp-proxy"];
if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`bin 应为三入口 ${JSON.stringify(want)},实际 ${JSON.stringify(got)}`);
for (const f of Object.values(p.bin)) fs.accessSync(f);
if (fs.existsSync("bin/cdpcc")) throw new Error("bin/cdpcc 应已删除(契约3)");
if (fs.existsSync("hooks/cdp-ensure.sh")) throw new Error("hooks/cdp-ensure.sh 应已删除(契约3)");
' && ok "package.json bin 三入口齐全(cdpcc/hooks 已下线)" \
  || bad "package.json bin 三入口齐全(cdpcc/hooks 已下线)"

echo ""
echo "===== L1 lease 单元(隔离锁根,无 Chrome)====="
if node test/lease.test.js; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo ""
echo "===== L1.5 relay 单元(TCP 中继,纯内存)====="
if node test/relay.test.js; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo ""
echo "===== L1.6 takeover CLI(真跑脚本,stub listener,零 Chrome)====="
if node test/takeover.test.js; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

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
