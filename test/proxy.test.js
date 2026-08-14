#!/usr/bin/env node
// L2 — zcode-cdp-proxy 状态机端到端回测(stub 化 backend + takeover,零真实 Chrome)
// 验证链路:placeholder 应答 → 首次 browser_ 激活(flush batch)→ browser_close
// 释放回 READY_IDLE → rearm 后非浏览器请求仍可应答(回归 #1: placeholder 重启补
// synthetic 握手)→ close 后 browser_ 重新激活(回归 #2: 缓冲请求重放)→ 退出清理。
//
// 环境隔离:CDP_LOCK_ROOT / CDP_PORTS 指向临时端口,不影响真实 9223-9229 池;
// CDP_HEALTH_CHECK_MS 调大跳过健康检查(stub listener 非 Agent Chrome,会被误判)。
"use strict";

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { step, run, afterAll, assert, sleep } = require("./lib/harness");

const REPO = path.join(__dirname, "..");
const PROXY = path.join(REPO, "bin", "zcode-cdp-proxy.js");
const PORT = 19223;
const LOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-proxy-test-"));
const ART_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-proxy-art-"));

const TEST_ENV = {
  ...process.env,
  CDP_LOCK_ROOT: LOCK_ROOT,
  CDP_PORTS: String(PORT),
  CDP_SCRIPT_PORTS: "19324",
  CDP_PLAYWRIGHT_MCP_CLI: path.join(REPO, "test", "lib", "stub-backend.js"),
  CDP_TAKEOVER: path.join(REPO, "test", "lib", "stub-takeover"),
  CDP_TEST_ARTIFACT_DIR: ART_DIR,
  CDP_HEALTH_CHECK_MS: "3600000",
  CDP_ORPHAN_TIMEOUT_MS: "3600000",
  CDP_STARTUP_GRACE_MS: "2000",
};

// ---- driver:JSON-RPC over stdio 的极简 MCP 客户端 ----
let seq = 0;
let stderrText = "";
function launchProxy() {
  const child = spawn("node", [PROXY], { env: TEST_ENV });
  let buf = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)(msg);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", d => { stderrText += d; process.stderr.write(`    [proxy] ${d}`); });
  return {
    child,
    request(method, params, timeoutMs = 30000) {
      const id = `t${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout(${timeoutMs}ms) waiting response for ${method}`));
        }, timeoutMs);
        pending.set(id, msg => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(msg);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
  };
}

function killListener() {
  try {
    const pidFile = path.join(ART_DIR, `listener-${PORT}.pid`);
    if (fs.existsSync(pidFile)) process.kill(parseInt(fs.readFileSync(pidFile, "utf8"), 10), "SIGKILL");
  } catch {}
}

let px = null;

afterAll(async () => {
  if (px && px.child.exitCode === null) {
    try { px.child.kill("SIGTERM"); } catch {}
    await sleep(1000);
    try { px.child.kill("SIGKILL"); } catch {}
  }
  killListener();
  fs.rmSync(LOCK_ROOT, { recursive: true, force: true });
  fs.rmSync(ART_DIR, { recursive: true, force: true });
});

const lockDir = path.join(LOCK_ROOT, `${PORT}.lock`);

step("proxy 启动进入 READY_IDLE(placeholder 就绪)", async () => {
  px = launchProxy();
  await sleep(1000);
  assert.ok(px.child.exitCode === null, "proxy should stay alive");
});

step("initialize → placeholder 应答", async () => {
  const res = await px.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "backtest", version: "0.0.1" },
  });
  assert.ok(res.result, JSON.stringify(res));
  assert.strictEqual(res.result.serverInfo.name, "stub-backend");
  px.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});

step("激活前 tools/list → placeholder 应答(0 Chrome 0 端口)", async () => {
  const res = await px.request("tools/list", {});
  assert.ok(res.result.tools.some(t => t.name === "browser_navigate"), JSON.stringify(res).slice(0, 120));
  assert.ok(!fs.existsSync(lockDir), "no lease should exist before activation");
});

step("首次 browser_ 调用 → 激活(领端口→stub takeover→real backend flush)", async () => {
  const res = await px.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_navigate", JSON.stringify(res).slice(0, 200));
  assert.ok(fs.existsSync(path.join(lockDir, "owner.json")), "lease owner.json should exist after activation");
});

// 轮询等待条件成立(stub 环境下 teardown 的 timer 调度偶发延迟,契约是最终一致)
async function waitFor(fn, desc, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return;
    await sleep(200);
  }
  throw new Error(`timeout waiting: ${desc}`);
}

step("browser_close → 响应返回 + 释放回 READY_IDLE", async () => {
  const res = await px.request("tools/call", { name: "browser_close", arguments: {} });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_close");
  await waitFor(() => !fs.existsSync(lockDir), "lease released after browser_close");
});

step("回归#1: close 后 tools/list 仍能应答(placeholder rearm 握手)", async () => {
  const res = await px.request("tools/list", {});
  assert.ok(res.result && res.result.tools, "placeholder should answer tools/list after rearm");
});

step("IDLE/CLOSING 收到 browser_close → 直接成功响应(不起 Chrome)", async () => {
  const res = await px.request("tools/call", { name: "browser_close", arguments: {} });
  assert.ok(/already closed/i.test(res.result.content[0].text), JSON.stringify(res).slice(0, 200));
});

step("回归#2: close 后再次 browser_ → 重新激活成功", async () => {
  const res = await px.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.org" } });
  assert.strictEqual(res.result.content[0].text, "stub ok: browser_navigate");
  assert.ok(fs.existsSync(path.join(lockDir, "owner.json")));
});

step("激活后再走一轮 close 生命周期(稳定性)", async () => {
  const nav = await px.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.net" } });
  assert.strictEqual(nav.result.content[0].text, "stub ok: browser_navigate");
  const close = await px.request("tools/call", { name: "browser_close", arguments: {} });
  assert.strictEqual(close.result.content[0].text, "stub ok: browser_close");
  await waitFor(() => !fs.existsSync(lockDir), "lease released after second close");
});

step("持有租约时 SIGTERM → 退出且锁被清理(exit hook 路径)", async () => {
  const nav = await px.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
  assert.ok(nav.result, "should activate and hold a lease first");
  assert.ok(fs.existsSync(lockDir), "lease held before SIGTERM");
  px.child.kill("SIGTERM");
  await sleep(1500);
  assert.notStrictEqual(px.child.exitCode, null, "proxy should have exited");
  assert.ok(!fs.existsSync(lockDir), "lock should be cleaned on exit");
});

step("回归#3: 全程 backend 只 spawn 一次(单常驻实例,激活循环不重启)", async () => {
  const spawnLines = stderrText.split("\n").filter(l => l.includes("backend spawn:"));
  assert.strictEqual(spawnLines.length, 1, `expected exactly 1 backend spawn, got ${spawnLines.length}:\n${spawnLines.join("\n")}`);
});

run();
