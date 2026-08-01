# Watchdog Postmortem / 看门狗事故复盘

> **两次孤儿 proxy CPU 99% 跑几小时不被杀的事件，及最终根因坐实。**

这是 `zcode-cdp` 项目里写得最重的一篇文档。它记录的不是"我们修了一个 bug"，而是一段**取证 → 假设验证 → 多轮诊断 → 共同根因**的完整工程故事：两次生产事故、三轮诊断、一个让三层看门狗同时失效的共同根因。

如果你维护过常驻进程（daemon / MCP server / agent runtime），下面这段经历大概率会在你的某个项目里重演。我们把每一步猜想——包括被证伪的那些——都留在这里，目的只有一个：**让下一个在凌晨对着 `top` 里一个 99% 的 PID 发呆的人，少走几小时弯路。**

---

## TL;DR

- **现象**：`zcode-cdp-proxy` 在父进程（`zcode-cli`）退出后变成孤儿，单核跑到 99% CPU，连续几小时甚至十几小时不被任何看门狗杀掉；`kill`（SIGTERM）无效，必须 `kill -9`。
- **根因**：父进程退出后，proxy 的 stderr pipe 对端关闭。proxy 任何 `log()` → `process.stderr.write` 抛 **EPIPE** → 触发 `uncaughtException` handler → handler 第一行又 `log()` → 又 write → 又 EPIPE → **无限递归异常风暴**。V8 疯狂抓堆栈（`CaptureSimpleStackTrace` + 大量 `malloc`）烧满一个核，同时把主线程和 worker 线程都拖死，三层看门狗全部失效。
- **修复**：`uncaughtException` / `unhandledRejection` handler 改成**纯同步、只有 `process.exit(1)`**（删掉里面的 `log()`）；`log()` 函数本身 `try { write } catch {}` 吞掉错误。两处合起来从根上切断了"handler 里 write 失败又抛异常"的递归源。
- **教训**：遇到 CPU 异常，**第一步是 `sample <pid> 5` 看调用栈，而不是猜**。本次先猜 stdin 噪声（错）、再猜间歇 busy-loop（部分对），最后靠 `sample` 取证才坐实是 EPIPE 异常风暴。三轮才坐实，前两轮改的代码留作多层防御兜底，但都不是根治。

---

## 背景：三层看门狗设计

`zcode-cdp-proxy` 是一个状态机驱动的懒加载代理，每个 ZCode 会话独立 spawn 一个实例，全权持有 stdio（MCP JSON-RPC 通道），背后懒挂一个 `playwright-mcp` 进程。它一旦被父进程遗忘而又没干净退出，就会变成一个**孤儿**：占着端口、占着 Chrome、空耗一个核。

为了防"主线程卡死 / 孤儿常驻"，proxy 设计了三层防线：

| 层 | 机制 | 跑在哪 | 触发条件 → 动作 |
|----|------|--------|----------------|
| **CPU 看门狗**（软） | `setInterval(1000)` 实测回调间隔 | 主线程 | 连续 `WATCHDOG_TRIES`（3）次延迟 > `WATCHDOG_LAG_MS`（2000ms）→ 同步 `process.exit(99)` |
| **孤儿超时**（软） | `setInterval(60000)` 查 `lastBusinessTime` | 主线程 | `ORPHAN_TIMEOUT_MS`（30min）无真实 MCP 业务请求 → `cleanupAndExit(0)` |
| **硬看门狗** | `worker_threads` 独立事件循环，每 2s 查心跳 + 独立 CPU 采样 | **worker 线程** | 主线程 `HARD_KILL_MS`（60s）无心跳，**或**滑动窗口内 CPU 持续超阈值 → worker `process.kill(mainPid, SIGKILL)` |

软看门狗的核心思路是"借 setInterval 当探针"——正常情况 1s 一个回调，回调间隔≈1000ms；一旦主线程事件循环被淹没（正是 99% CPU 的症状），回调会延迟到达，连续 3 次延迟超 2s 就判定卡死：

```javascript
// zcode-cdp-proxy.js:693-714（节选）
watchdogTimer = setInterval(() => {
  const now = Date.now();
  const lag = now - lastTick - 1000;  // 预期 1000ms，超出部分即事件循环延迟
  lastTick = now;
  if (lag > WATCHDOG_LAG_MS) {
    lagCount++;
    if (lagCount >= WATCHDOG_TRIES) {
      // 同步退出，绝不调 async cleanupAndExit
      process.exit(99);
    }
  } else {
    lagCount = 0;
  }
}, 1000);
```

孤儿超时则用 `lastBusinessTime` 而非 `lastStdinTime`——这是第一轮诊断的产物（后文详述）：`zcode-cli` 周期发的 keepalive / progress 噪声会刷新 `lastStdinTime` 让孤儿检测失效，实测 30min 内只要有 1 字节 stdin 就逃过。只有 `BUSINESS_METHODS` 正则匹配的真实 MCP 方法（`initialize` / `tools/` / `resources/` / `prompts/` / `ping`）才刷新 `lastBusinessTime`。

**为什么是三层，不是一层？** 因为它们针对不同的失效模式，互为兜底：

- 前两层跑在主线程事件循环里，能优雅处理"业务卡顿 / 被遗忘"这类软故障——干净释放租约、退 Chrome、退进程。
- 但前两层有一个致命前提：**主线程事件循环还在转**。一旦主线程陷入同步 busy-loop，`setInterval` 回调永远排不上队，前两层会**一起被卡死**。脚本注释里 PID 19791 的 19 小时裸奔正是此场景。
- 所以才有第三层硬看门狗：把它放到 `worker_threads`，worker 有独立的事件循环和 libuv 线程池，主线程 busy-loop 不影响 worker 计时。worker 到点直接发 `SIGKILL`——不可拦截，绕过所有异步清理逻辑，确保必死。worker 源码用内联 Blob，避免外部文件依赖：

```javascript
// worker 内联源码（zcode-cdp-proxy.js:593-648，双路检测节选）
parentPort.on("message", msg => {
  if (msg.type === "init") mainPid = msg.pid;
  else if (msg.type === "heartbeat") lastHeartbeat = msg.ts;
});
setInterval(() => {
  if (!mainPid || killed) return;
  // 第 1 路：心跳缺失（主线程完全卡死）
  const lag = Date.now() - lastHeartbeat;
  if (lag > HARD_KILL_MS) {
    killed = true;
    try { process.kill(mainPid, "SIGKILL"); } catch {}
    return;
  }
  // 第 2 路：独立 CPU 检测（绕过主线程事件循环，抓间歇 busy-loop）
  try {
    const out = execSync("ps -p " + mainPid + " -o time=", { encoding: "utf8" });
    // ... 算 CPU 增量，滑动窗口判定 ...
    if (cpuSamples.length >= HARD_CPU_TRIES && highCount >= HARD_CPU_TRIES) {
      killed = true;
      try { process.kill(mainPid, "SIGKILL"); } catch {}
    }
  } catch (e) {}
}, 2000);
```

这个设计的隐含假设是：**三层防线是"独立"的**——软防线管软故障，硬防线管硬故障，SIGTERM handler 管外部信号。一个故障打穿一层很正常，但同时打穿三层"不应该发生"。

然后事故来了。三层同时失效。

---

## 事故一：2026-07-23 — 硬看门狗 kill 目标写错

### 现象

PID 54278，`node zcode-cdp-proxy.js`，单核 99%，跑了**近 15 小时**未被任何看门狗杀掉。`SIGTERM` 无响应，最终只能 `SIGKILL`（`kill -9`）。

这其实有前科。脚本注释里自记：PID 19791 曾经跑了 **19 小时**，99% CPU，看门狗一次都没触发。两次现象完全一致——一个本该被自家看门狗杀掉的进程，在系统里裸奔了大半天，直到有人肉眼看 `top` 才发现。

### 根因

硬看门狗的 worker 源码里，kill 目标写成了：

```javascript
process.kill(process.ppid, "SIGKILL");
```

看起来很自然——"杀掉我的父进程"嘛。但这里有一个 `worker_threads` 的语义陷阱：

**在 `worker_threads` 里，`process.ppid` 指向的不是"主线程所在的进程"，而是"主进程的父进程"。**

也就是说，worker 里的 `process.ppid` 解析到的是 `launchd`（PID 1，macOS 的 init）或者 `zcode-cli`——一个普通用户根本没权限发信号的系统进程。于是 `process.kill(process.ppid, "SIGKILL")` 抛 **`EPERM`**（权限不足），kill 静默失败。

硬看门狗其实一直在正常计时——心跳确实停了，到点确实发了 kill——但它 kill 的目标压根不是主进程，而是 launchd。EPERM 一抛，worker 自己的 `try/catch` 把它吞了，一切看起来风平浪静，主进程继续裸奔。

### 完整链路

```
主线程陷入 busy-loop
        │
        ▼
软看门狗 setInterval 排不上队（主线程事件循环不转）
        │
        ▼  软防线失效
硬看门狗 worker 正常计时，到点发 SIGKILL
        │
        ▼  process.kill(process.ppid, ...) → 目标是 launchd/zcode-cli
        ▼
EPERM（普通用户对系统进程发信号，权限不足）
        │
        ▼  硬防线失效
SIGTERM handler 也排不上队（同样依赖主线程事件循环）
        │
        ▼  信号防线失效
三层防线同时失效，进程裸奔直到人工发现
```

### 修复

主线程启动 worker 时，把自己的真实 PID 显式传过去：

```javascript
// 主线程（zcode-cdp-proxy.js:653）
hardWatchdogWorker.postMessage({ type: "init", pid: process.pid });
```

worker 收到后用它（而不是 `process.ppid`）作为 SIGKILL 目标：

```javascript
// worker 内联源码（zcode-cdp-proxy.js:593-648）
parentPort.on("message", msg => {
  if (msg.type === "init") mainPid = msg.pid;
  // ...
});
// 到点：
process.kill(mainPid, "SIGKILL");
```

不依赖 `worker_threads` 里 `process.pid` / `process.ppid` 的歧义语义，跨线程显式传值。同时加 `killed` latch 防重复 kill。

### 验证

写了一个对照实验，主线程主动 `while(true)` 制造 busy-loop，分别跑新旧两套 kill 目标逻辑：

```bash
# 新逻辑：主线程 postMessage 真实 PID → worker 用它作 SIGKILL 目标
# 主线程 while(true) → worker 300ms 后成功 SIGKILL
# 进程 exit code = 137（128 + SIGKILL(9)）✅

# 旧逻辑对照：worker 仍用 process.ppid
# → kill EPERM ❌（证实诊断：目标指向 launchd）
```

- **新逻辑**（`postMessage` 传 PID）：主线程 busy-loop → worker 约 300ms 后成功 `SIGKILL`，进程 `exit 137`。✅
- **旧逻辑**（`process.ppid`）：`FAIL: kill EPERM`。❌——直接证实了诊断。

`exit 137` 是 `SIGKILL` 的标准信号编码（128 + 9），证明 worker 确实发出了不可拦截的致命信号，进程是被自家看门狗干掉的，而不是其他原因。

### 教训

`worker_threads` 里 `process.ppid` 的语义**不是"主线程所在进程"**，而是"主进程的父进程"。拿它当自杀目标，会指向 `launchd`，普通用户 EPERM。任何需要跨线程引用主进程的操作，都应该由主线程显式 `postMessage` 传入真实 PID，不要依赖 worker 里进程标识符的歧义语义。

> **关于 busy-loop 触发路径**：54278 已杀无法回溯。当时的猜想是 `inBuf` 收到无换行的超长数据时，`inBuf += chunk` 字符串拼接 `O(n²)` 增长导致 CPU 100%。基于这个猜想加了 `INBUF_MAX_BYTES`（2MB）截断兜底。**这个猜想后来被证明是错的**——见事故二。但 `INBUF_MAX_BYTES` 作为防御性兜底保留了下来。

---

## 事故二：2026-07-26 — EPIPE 异常风暴（真根因）

7/23 的 PID 修复部署后，我们以为这件事结束了。三天后它回来了，而且更凶。

### 现象

2026-07-26，一天之内连续出现**多个**孤儿 proxy 裸奔：

| PID | 持续时间 | PPID |
|-----|---------|------|
| 64663 | 1h05m | 1 |
| 90434 | 19m | 1 |
| 84030 | 15m | 1 |
| 97706 | 15m | 1 |
| 13503 | 13m | 1 |

每一个都烧一个核到 ~99%，系统 Load 一度飙到 **6.86**。全部 `PPID=1`——意味着父 `zcode-cli` 早已退出，进程被 `launchd` 收养。跑的都是 **7/23 PID 修复后的当前版本**。

`kill`（SIGTERM）无效，必须 `kill -9`。SIGTERM handler 排不进事件循环。

**这是最让人崩溃的时刻**：我们刚刚"修复"了硬看门狗，验证通过，部署上线——结果孤儿照样冒出来，硬看门狗照样没杀掉它们。一个被证伪的修复，比没有修复更让人焦虑，因为它意味着**你对系统的理解是错的**。

### 取证（这一步是整个故事的转折）

不再猜了。直接抓调用栈。

对 PID 13503 跑 macOS 自带的 `sample` 工具，采样主线程 5 秒：

```bash
sample 13503 5
```

`sample` 是 macOS 自带的进程采样器（Linux 下对应 `perf record` / `gdb attach`），它会以高频抓取目标进程各线程的调用栈，5 秒后输出"每个栈帧被采样到的次数"。这比 `top` 给一个笼统的 99% 有用得多——它告诉你那 99% **具体花在哪一行代码**。

结果触目惊心：**4198 个采样，几乎全部落在同一条调用链上**：

```text
SpinEventLoop → uv__run_check → CheckImmediate
  → InternalMakeCallback → ReportPendingMessages
  → TriggerUncaughtException → v8 Function::Call
  → Builtin_ErrorConstructor → ErrorUtils::Construct
  → CaptureSimpleStackTrace → OptimizedJSFrame::Summarize
  → 大量 malloc
```

逐帧解读这条栈：

- `SpinEventLoop → uv__run_check → CheckImmediate`：libuv 的事件循环在转，但跑的是 `check` 阶段的 immediate 回调——通常是 `setImmediate` 或 `Promise` 的 reject 处理。
- `InternalMakeCallback → ReportPendingMessages`：V8 在派发 pending 的 rejection / exception 消息。
- `TriggerUncaughtException`：**这是关键**——V8 在触发 `uncaughtException`。
- `Builtin_ErrorConstructor → ErrorUtils::Construct`：在**构造一个新的 `Error` 对象**（注意：不是处理一个已存在的异常，而是 handler 里又 `log(err.stack)` 触发了新 Error 的构造）。
- `CaptureSimpleStackTrace → OptimizedJSFrame::Summarize`：给新 Error 抓堆栈，总结每一帧的源码位置。
- `大量 malloc`：抓堆栈要分配字符串内存存每一帧的文件名/行号/函数名。

这条栈翻译成人话：**主线程不在跑任何业务代码，它在 V8 的异常处理内部无限递归**——不断地构造 `Error` 对象、抓堆栈、为堆栈帧分配内存，然后又抛、又抓、又分配……

CPU 100% 的来源不是任何业务循环，而是 **V8 抓堆栈本身**。这是一个我们之前完全没考虑过的故障模式：不是"代码跑得慢"，而是"V8 在跑自己的内部机制，而且停不下来"。

> 一个插曲：抓栈时 PID 13503 已经跑了 13 分钟，仍烧一个核。这说明异常风暴是一个**稳态**——它不会自己耗尽内存崩溃（`malloc` 的对象会被 GC 回收，因为上一轮的 `Error` 在下一轮递归前就没引用了），也不会自己退出。它会一直烧到你杀掉它为止。这就是为什么 54278 能跑 15 小时、19791 能跑 19 小时。

### 完整链路

从 `sample` 的调用栈反推，整个故障链路是：

1. 父 `zcode-cli` 退出 → proxy 的 **stderr pipe 对端关闭**（pipe 是父子进程之间建的，父端关了，子端 write 就会报错）。
2. proxy 内部任何一处调 `log()` → `process.stderr.write(...)` 抛 **EPIPE**（broken pipe）。
3. 这个 EPIPE 没被任何 `try/catch` 接住 → 触发 `process.on("uncaughtException")` handler。
4. handler 当时的第一行是 `log("uncaughtException: " + err.stack)`——**又调了 `process.stderr.write`**。
5. stderr 对端还是关着的 → **又抛 EPIPE → 又触发 handler → 无限递归异常风暴**。
6. 每一轮递归，V8 都要构造 `Error` 对象、`CaptureSimpleStackTrace` 抓完整堆栈、`OptimizedJSFrame::Summarize` 总结每一帧、`malloc` 分配堆栈字符串内存——这些操作本身极耗 CPU。递归永不停止 → **CPU 100% 占满一个核**。
7. 主线程完全陷在 V8 异常抓栈的 `malloc` 风暴里，事件循环根本不转 → 软看门狗 `setInterval` 排不上队、SIGTERM handler 排不上队。
8. worker 线程也没幸免——异常风暴的 `malloc` 压力拖累了整个进程的 libuv，worker 的 `setInterval` + `execSync('ps ...')` 也排不上（实测 worker 累计 CPU 仅 0.47s，几乎没跑）→ **硬看门狗失效**。

```
父 zcode-cli 退出
        │
        ▼
proxy stderr pipe 对端关闭
        │
        ▼  log() → process.stderr.write 抛 EPIPE
        ▼
触发 uncaughtException handler
        │
        ▼  handler 第一行: log(err.stack) → 又 write → 又 EPIPE
        ▼
无限递归异常风暴（V8 抓堆栈 + malloc 烧 CPU）
        │
        ├─→ 主线程陷死 → 软看门狗 setInterval 排不上
        ├─→ 主线程陷死 → SIGTERM handler 排不上
        └─→ libuv 被拖累 → worker setInterval/execSync 排不上
                            → 硬看门狗失效
        │
        ▼
三层防线同时失效，进程裸奔
```

### 关键洞察：为什么之前的修复都没救

这是整个事故里最值得想清楚的一点。

7/23 的 PID 修复（`postMessage` 传真实 PID）针对的是：**主线程 busy-loop，worker 能正常跑但 kill 目标错了**。修对了 kill 目标，worker 到点就能杀。

7/26 当天紧急加的 worker 独立 CPU 检测（worker 自己 `execSync('ps -p <pid> -o time=')` 读主进程 CPU，滑动窗口判定）针对的是：**主线程间歇 busy-loop**——主线程反复陷入长同步块（秒级），块间间隙让 `setInterval` 回调被批量补跑，心跳照常发，worker 看到的 lag 始终很小，心跳检测永不触发。所以加了第 2 路完全绕过主线程事件循环的 CPU 采样。

**这两个修复都假设：故障是"主线程在跑业务代码时卡住"**——要么完全卡死（busy-loop），要么间歇卡死。它们的对策都是"worker 检测到主线程不正常，发 SIGKILL"。

但 EPIPE 异常风暴是**更根本的故障**：

- 主线程不是在跑业务代码卡住，而是**在 V8 异常处理内部递归**——连"业务代码"这层都到不了。
- 更要命的是，异常风暴的 `malloc` 压力**把 worker 也拖死了**。worker 有独立事件循环没错，但它和主线程共享同一个进程的堆和 libuv 线程池。`malloc` 风暴让内存分配变慢、让 libuv 的 I/O 操作排队，worker 的 `setInterval` 和 `execSync` 都被拖到几乎不跑（实测累计 0.47s CPU）。

**三层防线（软 / 硬 / SIGTERM）全部失效，因为它们都依赖"主线程或 worker 至少有一个能跑回调"，而异常风暴把两者都淹了。** 这不是某一条防线的设计缺陷，而是所有防线共享了一个**共同失效模式**。

### 最终修复（2026-07-26，已实证）

诊断坐实后，修复方向就清晰了：**从根上消除"handler 里 write 失败又抛异常"这个递归源**，让 EPIPE 无论怎么触发都不会形成风暴。

**修复前的代码（事故根因）**：

```javascript
// 修复前（事故根因，伪代码还原）
function log(...a) {
  process.stderr.write(`[cdp-proxy ...] ${a.join(" ")}\n`);  // 裸 write，不 catch
}
process.on("uncaughtException", (err) => {
  log("uncaughtException: " + err.stack);  // ← 又 write，stderr 已坏 → 又抛 EPIPE
  // ... 其他处理 ...
});
```

**修复 1：`uncaughtException` / `unhandledRejection` handler 改纯同步**

```javascript
// zcode-cdp-proxy.js:947-954
// ⚠️ 必须纯同步、绝不写 stderr、直接 process.exit。
process.on("uncaughtException", () => {
  try { process.exit(1); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", () => {
  try { process.exit(1); } catch {}
  process.exit(1);
});
```

handler 体里**只有 `process.exit(1)`**，删除了原来的 `log("uncaughtException: " + err.stack)`。无论 EPIPE 怎么触发，handler 都是 O(1) 退出，根本不进入递归。这是根治——递归源被切断了。注意 handler 连 `err` 参数都不接、连 `err.stack` 都不看——任何对 err 的访问都可能触发 V8 的惰性堆栈构造，在异常路径里多一事不如少一事。

**修复 2：`log()` 函数 swallow write 错误**

```javascript
// zcode-cdp-proxy.js:75-77
function log(...a) {
  try { process.stderr.write(`[cdp-proxy ${process.pid} ${hhmmss()}] ${a.join(" ")}\n`); } catch {}
}
```

上游防御：即使别处调 `log()`，`write` 失败也不抛，根本不进 `uncaughtException`。和修复 1 互为兜底——修复 1 防 handler 内部递归，修复 2 防 handler 被触发。两层防御针对的是同一个故障的两个入口：修复 2 让"普通 log 失败"不触发 handler；修复 1 让"handler 被其他原因触发后"不递归。

**修复 3：保留之前所有防线作为多层防御**

软看门狗同步退出（`process.exit(99)`，不走 async `cleanupAndExit`）、worker CPU 检测、`startHardWatchdog` fail-loud（worker 启动失败直接 `process.exit(1)` 重拉）——全部保留。即使主防线（异常 handler）未来又出现别的漏洞，这些兜底还在。

### 验证

精确复现 EPIPE 场景：父进程关闭 proxy 的 stderr 读端 + 关闭 stdin（模拟 `zcode-cli` 退出）。

```bash
# 复现脚本思路（精确模拟 zcode-cli 退出）：
# 1. spawn proxy 子进程，捕获其 stderr pipe
# 2. 关闭 stderr 读端（模拟父进程退出后 pipe 对端消失）
# 3. 关闭 stdin（EOF，触发 proxy 的 stdin end handler）
# 4. 计时，看 proxy 多久退出、exit code 几

# 修复前（事故版本）：proxy 不退出，CPU 立刻飙到 99%，必须 kill -9
# 修复后：
#   → proxy 1507ms 内干净退出，exit code = 1
#   → 无异常风暴，无 CPU 飙升
```

结果：proxy **1507ms 内干净退出（exit 1）**，无异常风暴，无需 `kill -9`。✅

这 1507ms 里发生了什么：stdin EOF 触发 `cleanupAndExit(0)`（异步路径，正常退出流程），与此同时 stderr 已关，任何 `log()` 调用因修复 2 的 `try/catch` 静默吞掉 EPIPE，不触发 `uncaughtException`。整个退出路径干净。

同时回归验证，确保修复没有破坏其他场景：
- 间歇 busy-loop（之前修复针对的场景）：约 14s 内被 worker `SIGKILL`，exit 137。✅
- 完全卡死 busy-loop（事故一场景）：约 300ms 被 worker `SIGKILL`。✅
- 空闲 / 轻负载：不误杀，proxy 正常常驻。✅

三种故障模式 + 正常场景，全部行为正确。修复完成。

### 关键转折：busy-loop 根源至此坐实

这一步是整个事故的 "Aha moment"。

7/23 时我们猜想 busy-loop 的触发路径是 `inBuf` 字符串拼接 `O(n²)`。基于这个猜想加了 `INBUF_MAX_BYTES` 截断。**这个猜想是错的。**

真正的根源是 **EPIPE 异常风暴**。之前所有观察到的"间歇 busy-loop"现象——主线程周期性高 CPU、Load 飙升、worker 心跳时断时续——都是异常风暴的**表象**：主线程在异常抓栈的 `malloc` 风暴中间歇让出 CPU（V8 的递归在某些点会短暂回到事件循环），看起来就像"间歇 busy-loop"。实际上根一直在 `uncaughtException` 递归。

**没有 `sample` 取证，我们可能永远停在"间歇 busy-loop"这个半对半错的描述上，继续往 worker CPU 检测里堆滑窗参数，而真正的递归源就在 handler 的第一行里。**

---

## 三条教训

### 1. 取证优先于猜想

本次经过**三轮诊断**才坐实根因：

- **第一轮**：猜"stdin 噪声污染心跳"——改了代码，验证发现假设错误，回滚。
- **第二轮**：模拟"间歇 busy-loop"——加了 worker CPU 检测，验证通过，但生产仍复现。
- **第三轮**：用 `sample <pid> 5` 抓调用栈——才看到主线程在 `TriggerUncaughtException → CaptureSimpleStackTrace` 风暴里，坐实 EPIPE 异常风暴。

前两个猜想都导致改了无效代码。**遇到 CPU 异常，第一步就该 `sample <pid> 5`（macOS）/ `perf record`（Linux）/ `py-spy`（Python）看调用栈，而不是对着现象猜根因。** 现象是表象，调用栈是事实。猜想的成本是你可能花一天改了一段无关代码，然后半夜被同一个事故叫醒。

### 2. `uncaughtException` handler 必须是"纯同步、无副作用、直接 exit"的最小代码

这是 Node.js 的通用铁律，不只本脚本。

任何 I/O 操作（`write` / `log` / 网络请求 / 文件写）都可能**再次抛异常**。在异常处理路径里，"再次抛异常"就是递归源。EPIPE 是本次的载体，但还有无数种：ENOSPC（磁盘满，写日志失败）、ECONNRESET（往已关的 socket 写）、ENOMEM（malloc 失败）……每一种都能让 handler 自己变成递归风暴。

handler 里应该只有：

```javascript
process.on("uncaughtException", () => {
  try { process.exit(1); } catch {}
  process.exit(1);
});
```

要记日志？在 `process.on("exit")` 里同步写——但 `exit` handler 里连 `fs.writeSync` 都要小心。最稳的是让外部系统（systemd / launchd / 容器编排）去收尸记日志，进程自己别在异常路径里做任何 I/O。

### 3. 多防线系统最怕"共同根因"

三层看门狗设计严密：软防线管软故障、硬防线管硬故障、SIGTERM 管外部信号。一个故障打穿一层很正常。

但三层防线有一个**共享的隐含假设**：主线程或 worker 至少有一个能跑回调。EPIPE 异常风暴同时摧毁了主线程（V8 递归）和 worker（libuv 被拖累）——**一个根因，打穿了所有防线的共同前提**。这就是"共同失效模式"（common mode failure）：防线的数量不重要，关键是它们是否**独立**。如果 N 条防线共享同一个前提，那一个能击穿这个前提的故障，就能一次性废掉全部 N 条。

设计防线时，要主动问：**这几条防线，共享了什么前提？有没有一个故障能同时打破这个前提？** 这次教训告诉我们：worker 有独立事件循环 ≠ worker 完全独立——它和主线程共享堆、共享 libuv、共享进程地址空间。真正的独立只有"独立进程"（另一个 daemon 监控）这一层，而那会引入新的复杂度。工程就是在这些权衡里找平衡。

---

## 诊断历程诚实记录

> 这一段是为了避免后人重蹈。如果只看修复 diff，你会以为我们一开始就知道是 EPIPE。不是的。

本次事故经过**三轮诊断**才坐实根因，前两轮的猜想都是错的或不完整的：

**第一轮（猜 stdin 噪声，错误）**：观察到孤儿 proxy 的 `lastStdinTime` 总是被刷新，怀疑是 `zcode-cli` 周期发的 keepalive / progress 噪声让孤儿超时失效。改了代码让孤儿判定改用 `lastBusinessTime`（只认真实 MCP 业务方法）。这个改动本身是对的（孤儿判定确实更准了），**但它没有解决 CPU 99% 的问题**——孤儿超时根本排不上队，因为主线程已经卡死了。验证时发现假设错误，CPU 问题依旧。

**第二轮（猜间歇 busy-loop，部分对）**：模拟主线程反复陷入长同步块的场景，加了 worker 独立 CPU 检测（`execSync('ps ...')` 读主进程 CPU 时间，滑动窗口判定）。验证通过——模拟的 busy-loop 确实被 worker 杀掉了。但生产仍复现，因为**真实的故障不是业务代码的 busy-loop，而是 V8 异常处理内部的递归**，而且 worker 自己也被拖死了，CPU 检测根本没机会跑。

**第三轮（`sample` 取证，坐实）**：终于不再猜，直接抓 PID 13503 的主线程调用栈。4198 个采样几乎全在 `TriggerUncaughtException → CaptureSimpleStackTrace`，一眼看出是异常风暴。反推到 EPIPE → handler 递归的完整链路，根因坐实。

**前两轮的修复（软看门狗同步退出、worker CPU 检测、`startHardWatchdog` fail-loud）全部保留作为多层防御兜底**——它们针对的故障模式（业务代码 busy-loop、worker 启动失败）是真实的，值得防御。但它们都不是这次的根治。**根治是 `uncaughtException` handler 改纯同步 + `log()` swallow write 错误。**

把这段写出来的目的：如果你将来接手这段代码，看到一个"看起来和异常处理无关"的 CPU 检测逻辑，不要以为它是冗余的——它是前两轮诊断留下的兜底，防的是另一类故障。多层防御的意义就在这里：每一条防线都假设其他防线可能失效。

---

## 排查指南

如果未来再出现 proxy CPU 99% 跑几小时不退：

### 第一步：取样，别猜

```bash
sample <pid> 5
```

看主线程调用栈落在哪。**不要先猜，先看事实。**

### 第二步：按调用栈定位

- 若大量采样在 `TriggerUncaughtException` / `CaptureSimpleStackTrace` / `ErrorUtils::Construct` / `OptimizedJSFrame::Summarize` → **仍是异常风暴**。说明还有某处 I/O 在抛异常且没被 swallow。排查所有 `process.stderr.write` / `fs.write` / `socket.write` 调用，确保都在 `try/catch` 里；排查所有 `uncaughtException` / `unhandledRejection` handler，确保都是纯同步 `process.exit`。
- 若大量采样在业务代码某个函数（如 `inBuf += chunk`、某个 `while` 循环）→ **业务 busy-loop**。worker CPU 检测应该能兜住；若没兜住，参考事故一的 worker 修复。
- 若采样分散、无明显热点 → 可能是 I/O 等待或锁竞争，需进一步用 `strace` / `dtruss` 看系统调用。

### 第三步：止血

```bash
kill -9 <pid>
```

SIGTERM 大概率排不进事件循环，直接 SIGKILL。ZCode 会自动重拉新实例。

### 第四步：事后取证

杀之前如果条件允许，先 `sample` 存一份调用栈，并 `ps -o pid,ppid,etime,%cpu,command -p <pid>` 记下元数据。杀完就回溯不了了。

---

## 附录：关键代码位置

所有修复都在 `bin/zcode-cdp-proxy.js`，行号基于当前版本：

| 修复 | 位置 | 内容 |
|------|------|------|
| `log()` swallow write | `:75-77` | `try { process.stderr.write(...) } catch {}` |
| 阈值常量 | `:59-69` | `WATCHDOG_LAG_MS` / `HARD_KILL_MS` / `HARD_CPU_THRESHOLD` 等，全部 env 可覆盖 |
| 硬看门狗 worker | `:575-672` | `postMessage` 传 PID、双路检测（心跳 + CPU）、fail-loud |
| 软看门狗同步退出 | `:689-725` | 触发后 `process.exit(99)` 不走 async cleanup |
| 异常 handler 纯同步 | `:947-954` | `uncaughtException` / `unhandledRejection` 只 `process.exit(1)` |
| 信号 handler | `:938-940` | `SIGTERM` / `SIGINT` / `SIGHUP` → `cleanupAndExit(0)` |
| `INBUF_MAX_BYTES` 截断 | `:742-745` | 防无换行大数据块无限增长（前两轮猜想的兜底） |

所有阈值都通过环境变量可覆盖（`CDP_WATCHDOG_LAG_MS` / `CDP_HARD_KILL_MS` / `CDP_HARD_CPU_THRESHOLD` 等），方便测试时缩短超时验证修复，生产用默认值。

---

## 附录：事件时间线

```text
2026-07-23
  ├─ PID 54278 发现：单核 99%，已跑近 15h，SIGTERM 无响应，SIGKILL
  ├─ 前科回溯：PID 19791 曾跑 19h（脚本注释自记）
  ├─ 诊断第一轮：猜 stdin 噪声污染心跳 → 改 orphan 判定用 lastBusinessTime
  │    └─ 验证：CPU 问题依旧，假设错误（但 orphan 判定改进保留）
  ├─ 诊断第二轮：猜间歇 busy-loop → 加 worker 独立 CPU 检测（滑动窗口）
  ├─ 硬看门狗 kill 目标修复：postMessage 传真实 PID（不再用 process.ppid）
  │    └─ 验证：while(true) → worker 300ms SIGKILL，exit 137 ✅
  └─ 猜想 busy-loop 触发路径 = inBuf O(n²) → 加 INBUF_MAX_BYTES 截断兜底
       （此猜想后被证伪，但兜底保留）

2026-07-23 ~ 2026-07-26
  └─ 7/23 修复版本部署上线

2026-07-26
  ├─ 孤儿风暴复现：PID 64663(1h05m) / 90434(19m) / 84030(15m) / 97706(15m) / 13503(13m)
  │    全部 PPID=1，跑的是 7/23 修复版本，Load 飙 6.86，kill 无效需 kill -9
  ├─ 诊断第三轮（转折）：sample 13503 5 抓主线程调用栈
  │    └─ 4198 采样几乎全在 TriggerUncaughtException → CaptureSimpleStackTrace
  ├─ 根因坐实：EPIPE → uncaughtException handler 递归 → V8 抓栈 malloc 风暴
  ├─ 最终修复部署：
  │    1. uncaughtException / unhandledRejection handler 改纯同步 process.exit(1)
  │    2. log() try/catch swallow write 错误
  │    3. 保留软看门狗同步退出 / worker CPU 检测 / fail-loud 作多层防御
  └─ 验证：EPIPE 复现 → proxy 1507ms 干净退出 exit 1 ✅（无需 kill -9）

2026-08-02
  └─ 本文档撰写（基于 cdp.md §4 事故记录 + proxy.js 源码）
```

---

## 附录：为什么不是 inBuf O(n²)

7/23 的猜想是 `inBuf` 字符串拼接 `O(n²)` 导致 busy-loop。这个猜想看起来合理：

```javascript
// 看起来可疑的代码（zcode-cdp-proxy.js:738）
inBuf += chunk;
```

字符串 `+=` 在 V8 里确实是 `O(n)` 的（要复制整个旧字符串），反复 `+=` 累积是 `O(n²)`。如果 `zcode-cli` 发了畸形/超长无换行数据，`inBuf` 无限增长，CPU 会飙。

但这个猜想有两个解释不通的地方：

1. **`INBUF_MAX_BYTES` 截断加上了，生产仍复现**。如果根因是 `inBuf`，截断到 2MB 后应该立刻好转。但 7/26 的孤儿们照样烧核。
2. **`sample` 调用栈不在 `inBuf += chunk` 这行**。4198 个采样全在 V8 异常处理内部，没有半个采样落在 stdin data handler 或字符串拼接上。

`sample` 取证直接否决了这个猜想。真实的根因（EPIPE 异常风暴）和 `inBuf` 毫无关系——它发生在 stderr 写入路径，不是 stdin 读取路径。我们最初之所以猜 `inBuf`，是因为它是代码里看起来最像"会 O(n²)"的地方，属于"对着代码猜"而非"看着证据查"。

`INBUF_MAX_BYTES` 截断作为防御性代码保留了下来——它防的是一个真实的（即使不是本次根因的）隐患。但我们要诚实承认：**它是基于一个错误猜想写的代码**。

---

*这份文档写于 2026-08-02，基于 `knowledge/general/cdp.md §4` 的事故记录与 `bin/zcode-cdp-proxy.js` 的源码。两次事故的每一个事实——PID、时长、调用栈、验证结果——都来自当时的生产记录，没有美化。如果你读到这里，是因为你也在维护一个不该死但就是死不掉的常驻进程。祝你的 `sample` 一次命中。*
