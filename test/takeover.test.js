#!/usr/bin/env node
// L1.6 — cdp-takeover CLI 回测(真跑 bin/cdp-takeover,零真实 Chrome)
// 覆盖:平台守卫(注入输出 Linux 的假 uname)、--managed 三种缺参 fail-loud、
// --lease-id 缺值/未知参数、CDP_PORTS 池覆盖下的 status(用表内子集 9225/9226,
// 纯只读)、全局锁无泄漏(acquire 后报错退出不残留)、池满 fail-loud、池外端口
// 立即报错。
//
// 安全红线:所有调用 HOME 指向临时目录(即使脚本未来被改得越过防重入,也碰不到
// 真实 profile,更拉不起 Chrome);被测路径全部在 rsync/启动 Chrome 之前退出,
// 并逐条断言临时 HOME 零 profile 痕迹(仅白名单放行 flog 结算日志);绝不绑定 9223-9229/93xx。
//
// 设计上测不了(原因如实记录,不硬凑):
//  1) status 的 运行/被占(非agent) 行渲染:需要真实 listener 占用表内端口;
//     agent/非 agent 判定语义已由 lease.test.js 的 durable/stale 用例覆盖。
//     (原「--refresh + 端口在跑 → 报错」因 port_meta 是静态表、CDP_PORTS 池内
//      端口到不了该检查而测不了;F20 动态 meta 后已可达,见下方 step。)
// 已修回归(已钉 step):CDP_PORTS 含表外端口时 status 曾在 owner=$(port_meta ...)
// 处被 set -e 杀掉;动态 meta 后池内端口恒可解析,owner 列显示 session,全表打完 exit 0。
// F20 根因修复:port_meta 动态化——池内端口按池内索引生成 session 配置,
// 93xx 保留静态表;自定义池端口不再报「不在支持范围」(下方三个 step)。
"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { step, run, afterAll, assert, sleep } = require("./lib/harness");

const REPO = path.join(__dirname, "..");
const TAKEOVER = path.join(REPO, "bin", "cdp-takeover");
const STUB_LISTENER = path.join(REPO, "test", "lib", "chrome-takeover-stub-listener.js");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-takeover-test-home-"));
const LOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-takeover-test-locks-"));
const GLOBAL_LOCK = `/tmp/cdp-takeover.${process.env.USER}.lock`;
const BASE_ENV = { ...process.env, HOME, CDP_LOCK_ROOT: LOCK_ROOT };

const spawned = [];
afterAll(async () => {
  for (const c of spawned) { try { c.kill("SIGKILL"); } catch {} }
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(LOCK_ROOT, { recursive: true, force: true });
});

function runTakeover(args, extraEnv = {}, timeoutMs = 30000) {
  const r = spawnSync("bash", [TAKEOVER, ...args], {
    env: { ...BASE_ENV, ...extraEnv }, encoding: "utf8", timeout: timeoutMs,
  });
  if (r.error) throw r.error;
  return { code: r.status, signal: r.signal, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function spawnListener(port) { // agent 形态:命令行含 chrome-takeover
  const child = spawn(process.execPath, [STUB_LISTENER, String(port)], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function waitListening(port, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const up = await new Promise(res => {
      const s = net.connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); res(true); });
      s.on("error", () => res(false));
    });
    if (up) return;
    await sleep(100);
  }
  throw new Error(`port ${port} never listening within ${timeoutMs}ms`);
}

// 统一版 flog 结算日志会向 $HOME/.zcode/v2/logs/cdp-proxy-<日期>.log 落一行结果(日志副作用,
// 非 profile 副作用)。安全红线仍是「零 Chrome profile 痕迹」:白名单只放行该日志文件本身,
// 其余任何写入(含 .zcode 下的其他路径)都算失败。
const homeEmpty = () => {
  const walk = (dir, prefix) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const rel = `${prefix}${e.name}`;
    return e.isDirectory() ? walk(path.join(dir, e.name), `${rel}/`) : [rel];
  });
  return walk(HOME, "")
    .every(rel => /^\.zcode\/v2\/logs\/cdp-proxy-\d{4}-\d{2}-\d{2}\.log$/.test(rel));
};

step("平台守卫(F19): 注入输出 Linux 的假 uname → exit 1 且点名仅支持 macOS", async () => {
  const fakebin = fs.mkdtempSync(path.join(os.tmpdir(), "cdp-fakebin-"));
  try {
    fs.writeFileSync(path.join(fakebin, "uname"), "#!/bin/sh\necho Linux\n");
    fs.chmodSync(path.join(fakebin, "uname"), 0o755);
    const r = runTakeover(["status"], { PATH: `${fakebin}:${process.env.PATH}` });
    assert.strictEqual(r.code, 1, `code=${r.code} stderr=${r.stderr}`);
    assert.ok(/仅支持 macOS/.test(r.stderr), r.stderr);
  } finally {
    fs.rmSync(fakebin, { recursive: true, force: true });
  }
});

step("--managed 缺参: 三种缺法均 exit 1,fail-loud 文案点名缺失项,且不占全局锁", async () => {
  const cases = [
    { args: ["--managed"], mustContain: ["--managed 需要 --lease-id 与 --target-port", "--lease-id", "--target-port"] },
    { args: ["--managed", "19258"], mustContain: ["--managed 需要 --lease-id 与 --target-port", "--lease-id"] },
    { args: ["--managed", "--lease-id", "t1"], mustContain: ["--managed 需要 --lease-id 与 --target-port", "--target-port"] },
  ];
  for (const c of cases) {
    const r = runTakeover(c.args);
    assert.strictEqual(r.code, 1, `${JSON.stringify(c.args)}: code=${r.code} stderr=${r.stderr}`);
    for (const s of c.mustContain) {
      assert.ok(r.stderr.includes(s), `${JSON.stringify(c.args)}: stderr 缺 "${s}": ${r.stderr}`);
    }
  }
  assert.ok(!fs.existsSync(GLOBAL_LOCK), "缺参报错须发生在 acquire_lock 之前,不残留全局锁");
});

step("参数解析 fail-loud: --lease-id 缺值 / 未知参数 → exit 1", async () => {
  const a = runTakeover(["--lease-id"]);
  assert.strictEqual(a.code, 1, a.stderr);
  assert.ok(/需要一个值/.test(a.stderr), a.stderr);
  const b = runTakeover(["--bogus"]);
  assert.strictEqual(b.code, 1, b.stderr);
  assert.ok(/未知参数/.test(b.stderr), b.stderr);
});

step("status 池感知(F20⑪): CDP_PORTS=表内子集 9225/9226 → 只显示该子集+93xx(纯只读)", async () => {
  // 只读路径:仅 lsof/ps 探测 + 读临时锁根,不绑定/不修改任何生产端口;
  // 行状态(空闲/运行)取决于机器实况,不做断言,只断言行集随 CDP_PORTS 收缩
  const r = runTakeover(["status"], { CDP_PORTS: "9225 9226" });
  assert.strictEqual(r.code, 0, r.stderr);
  for (const p of ["9225", "9226", "9324", "9326"]) {
    assert.ok(r.stdout.includes(p), `status 应含 ${p}:\n${r.stdout}`);
  }
  for (const p of ["9223", "9224", "9227", "9228", "9229"]) {
    assert.ok(!r.stdout.includes(p), `status 不应含未选入池的 ${p}:\n${r.stdout}`);
  }
  assert.ok(!fs.existsSync(GLOBAL_LOCK), "status 不应占用全局锁");
  assert.ok(homeEmpty(), "status 不应写 HOME");
});

step("status 表外端口容错(回归#2 已修): CDP_PORTS 含静态表外端口 → exit 0 全表打完,owner 列动态显示 session", async () => {
  // 回归钉子:曾因 owner=$(port_meta $p) 在 set -e 下遇表外端口 return 1 而中途 exit 1。
  // F20 动态 meta 后池内端口(含静态表外如 19401)恒可解析,owner 列显示动态生成的
  // session;status 遍历集(PORTS+SCRIPT_PORTS)中已不存在无法解析的端口
  const r = runTakeover(["status"], { CDP_PORTS: "9225 19401" });
  assert.strictEqual(r.code, 0, r.stderr);
  for (const p of ["9225", "19401", "9324", "9326"]) {
    assert.ok(r.stdout.includes(p), `status 应含 ${p}:\n${r.stdout}`);
  }
  assert.ok(/^19401\s+(空闲|占位|运行|被占)\s+\S+\s+session\s/m.test(r.stdout), `静态表外池内端口 owner 列应动态显示 session:\n${r.stdout}`);
  assert.ok(homeEmpty(), "status 不应写 HOME");
});

step("全局锁无泄漏(F8) + --managed 三件套放行到 lease 校验: 报错退出后锁必清、HOME 必空", async () => {
  const a = runTakeover(["19258"]); // 池外端口: acquire_lock 后 port_meta 失败 exit 1
  assert.strictEqual(a.code, 1, a.stderr);
  assert.ok(/不在支持范围/.test(a.stderr), a.stderr);
  assert.ok(!fs.existsSync(GLOBAL_LOCK), "报错退出后全局锁应被 trap 清理(F8)");
  const b = runTakeover(["--managed", "--lease-id", "t1", "19258"]);
  assert.strictEqual(b.code, 1, b.stderr);
  assert.ok(!/--managed 需要/.test(b.stderr), `参数齐全不得再报缺参: ${b.stderr}`);
  assert.ok(/"reason":"free"/.test(b.stderr), `verify_lease 的 check JSON 应打到 stderr: ${b.stderr}`);
  assert.ok(!fs.existsSync(GLOBAL_LOCK), "报错退出后全局锁应被 trap 清理(F8)");
  assert.ok(homeEmpty(), "报错路径不得写 HOME(无 profile 副作用)");
});

step("池满 fail-loud: CDP_PORTS 池全被 stub 占用 → exit 1 报『都在用』并点名生效池", async () => {
  const c1 = spawnListener(19255);
  const c2 = spawnListener(19256);
  await waitListening(19255);
  await waitListening(19256);
  const r = runTakeover([], { CDP_PORTS: "19255 19256" }); // 自动选端口
  assert.strictEqual(r.code, 1, `code=${r.code} stderr=${r.stderr}`);
  assert.ok(/都在用/.test(r.stderr), r.stderr);
  assert.ok(r.stderr.includes("19255 19256"), `池满提示应点名生效池: ${r.stderr}`);
  assert.ok(!fs.existsSync(GLOBAL_LOCK), "池满退出后全局锁应被 trap 清理");
  assert.ok(homeEmpty(), "池满退出不得触碰 profile");
  c1.kill(); c2.kill();
  await sleep(200);
});

step("自定义池端口可分配(F20 根因修复): status 对池内端口动态生成 owner=session(非表外 -)", async () => {
  // 动态 port_meta:CDP_PORTS 池内端口不再因静态表缺失显示 owner=-;93xx 静态表保留
  const r = runTakeover(["status"], { CDP_PORTS: "19257" });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/^19257\s+(空闲|占位|运行|被占)\s+\S+\s+session\s/m.test(r.stdout), `池内端口 owner 列应为 session:\n${r.stdout}`);
  assert.ok(/^9324\s+\S+\s+\S+\s+scripts\s/m.test(r.stdout), `93xx 静态表应保留(scripts):\n${r.stdout}`);
  assert.ok(homeEmpty(), "status 不应写 HOME");
});

step("自定义池端口可分配(F20 根因修复): 池内端口过 port_meta → agent 在跑走复用 exit 0,回显 owner=session", async () => {
  // agent 形态 stub(命令行含 chrome-takeover)占住池内端口:防重入复用分支在
  // port_meta 之后,exit 0 + 回显「(PID,session)」即证明动态 meta 生成成功且
  // 不再报「不在支持范围」;复用路径不进 rsync/Chrome
  const listener = spawnListener(19257);
  await waitListening(19257);
  const r = runTakeover(["19257"], { CDP_PORTS: "19257" });
  assert.strictEqual(r.code, 0, `code=${r.code} stderr=${r.stderr}`);
  assert.ok(/Agent Chrome 已在跑 — 端口 19257（PID \d+，session）/.test(r.stdout), r.stdout);
  assert.ok(!/不在支持范围/.test(r.stderr), r.stderr);
  assert.ok(homeEmpty(), "复用路径不得写 profile");
  assert.ok(!fs.existsSync(GLOBAL_LOCK), "复用退出后全局锁应被 trap 清理");
  listener.kill();
  await sleep(200);
});

step("--refresh + 池内端口有实例在跑: 报「前置条件不满足」fail-loud(原设计上测不了#1,动态 meta 后可达)", async () => {
  const listener = spawnListener(19259);
  await waitListening(19259);
  const r = runTakeover(["19259", "--refresh"], { CDP_PORTS: "19259" });
  assert.strictEqual(r.code, 1, `code=${r.code} stderr=${r.stderr}`);
  assert.ok(/--refresh 前置条件不满足：端口 19259 有实例在跑/.test(r.stderr), r.stderr);
  assert.ok(!/不在支持范围/.test(r.stderr), r.stderr);
  assert.ok(homeEmpty(), "报错路径不得写 profile");
  assert.ok(!fs.existsSync(GLOBAL_LOCK), "退出后全局锁应被 trap 清理");
  listener.kill();
  await sleep(200);
});

step("--refresh + 池外端口: 立即 fail-loud,不进 rsync/Chrome(池外端口在 port_meta 即被拒,rsync 不可达)", async () => {
  const r = runTakeover(["19258", "--refresh"]);
  assert.strictEqual(r.code, 1, r.stderr);
  assert.ok(/不在支持范围/.test(r.stderr), r.stderr);
  assert.ok(homeEmpty(), "不得产生任何 profile 目录");
  assert.ok(!fs.existsSync(GLOBAL_LOCK), "退出后全局锁应被 trap 清理");
});

run();
