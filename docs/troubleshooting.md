# Troubleshooting / 排查清单

When something goes wrong with zcode-cdp, work through this page in order. Most issues fall into one of these buckets.

---

## Quick diagnostic commands

```bash
# What's the port table look like right now?
node bin/zcode-cdp-lease.js status

# Is a specific port's Chrome actually up?
curl -s http://127.0.0.1:9223/json/version | head

# Who owns a port's lease?
cat /tmp/zcode-cdp/ports/9223.lock/owner.json

# Reap stale locks and orphan Chromes
node bin/zcode-cdp-lease.js reap

# Show full port table (cdp-takeover view, includes durable ports)
./bin/cdp-takeover status
```

---

## Symptom → Cause → Fix

### "This session has no CDP tools"

**Usually a misconception.** The tools are statically registered (`tools/list` always responds) even when no Chrome is running — that's the whole point of the lazy proxy. In `READY_IDLE` state, the proxy answers `tools/list` with the full tool set; Chrome only starts on the first actual `browser_*` call.

**Real causes if tools are genuinely missing**:
- The proxy process failed to start → check `~/.zcode/v2/logs/<date>.log` (ZCode) or the CC startup output
- The MCP server isn't registered in your client config → verify `config/mcp-server.example.json` was copied correctly

---

### Port is occupied but nothing connects

```bash
# 1. Is something actually listening?
lsof -iTCP:9223 -sTCP:LISTEN -P -n

# 2. Is it an Agent Chrome?
ps -p $(lsof -iTCP:9223 -sTCP:LISTEN -t) -o args= | grep -q chrome-takeover && echo "agent" || echo "non-agent"
```

- **Non-agent listener** → some other app grabbed the port. Either kill that app, or change `CDP_PORTS` to use a different range.
- **Agent Chrome but stale** → lease was orphaned. Run `node bin/zcode-cdp-lease.js reap`.
- **No listener, but lock exists** → stale lock file. `reap` will clean it.

---

### Orphan Chrome (port alive, no lease)

A session exited without cleanly releasing. This happens after crashes or forced `kill -9`.

```bash
# Verify no owner
ls /tmp/zcode-cdp/ports/9223.lock/ 2>/dev/null   # if absent or empty → orphan

# Confirm it's an Agent Chrome (don't kill non-agent listeners!)
ps -p $(lsof -iTCP:9223 -sTCP:LISTEN -t) -o args= | grep -q chrome-takeover

# Manually close it
kill $(lsof -iTCP:9223 -sTCP:LISTEN -t)
```

> ⚠️ Only kill Agent Chromes (command line contains `chrome-takeover`). Killing a non-agent listener may disrupt a real service.

---

### Injected JS doesn't take effect

Two usual suspects:

**1. Top-level `return` in `Runtime.evaluate` (expression mode)**

This is a SyntaxError, but `evaluate` **silently returns None** instead of throwing — the hardest bug to spot.

```javascript
// ❌ WRONG — silently fails, returns None
return document.title;

// ✅ CORRECT — wrap in IIFE
(() => { return document.title; })();

// ✅ ALSO FINE — single expression, no return
document.title
```

**Diagnostic rule**: when debugging "I injected it but nothing happened", check for top-level `return` first.

**2. Editor needs physical events**

`element.click()` from JS only fires the `click` event, not the full `mousedown`/`mouseup`/`focus` chain. Rich editors (Draft.js, ProseMirror, Slate, Quill) need the full chain to enter edit mode.

**Fix**: use CDP `Input.dispatchMouseEvent` (physical mouse down/up) for any interaction with a rich editor, not JS `.click()`.

---

### "False success" after clicking publish/submit

You clicked publish, the URL didn't change, so you assumed it worked. **It didn't.**

Many sites show success/error via a transient Toast that disappears in ~1 second. If you only check URL or page content after the Toast is gone, you'll report success for a failed action.

**Fix**: after clicking publish/submit, wait ~1s then check for `.Toast-text` (or the site's equivalent toast/error selector) **before** declaring success.

---

### `closed` shadow DOM can't be pierced

Some sites (e.g. Xiaohongshu's `<xhs-publish-btn>`) use **closed** shadow DOM. Even `DOM.getDocument({depth:-1, pierce:true})` can't reach inside.

**Workarounds**:
- If the host element is a single button → use the host's `getBoundingClientRect()` to compute center, then physical-click at those coordinates.
- If the host is a button bar → screenshot the region, find the target button by its feature color (e.g. red submit button), take pixel median, click there.

**Mind DPR**: screenshots are device pixels; `Input.dispatchMouseEvent` uses CSS pixels. Divide by `devicePixelRatio` (macOS Retina is typically 2.0; verify with `window.devicePixelRatio`).

---

### Port mismatch between launcher and connector

If you start Chrome on one port and try to connect on another, you'll get connection refused.

```bash
# Verify they match
lsof -iTCP:9324 -sTCP:LISTEN    # what Chrome listens on
# vs. what your client points at:
grep -i endpoint your-script.py
```

9222 is the historical default (playwright-mcp's legacy). The current pool is 9223–9229 (session) + 93xx (script-fixed). Don't mix them.

---

### Proxy CPU 99% for hours, won't respond to SIGTERM

> **2026-07-26 root cause**: EPIPE exception storm. Parent agent exits → stderr pipe closes → every `log()` throws EPIPE → `uncaughtException` handler calls `log()` again → infinite recursive exception → V8 stack-capture storm → CPU 100%, all watchdogs fail because they depend on the event loop running.

**If this somehow recurs** (it shouldn't — v0.1.0 has the fix):

```bash
# Step 1: DO NOT GUESS — sample the stack first
sample <pid> 5

# If you see TriggerUncaughtException / CaptureSimpleStackTrace dominating
# → it's still an exception storm (some other IO is throwing)
# Step 2: stop the bleeding
kill -9 <pid>
```

See [`watchdog-postmortem.md`](watchdog-postmortem.md) for the full story.

---

### Browser opens an empty window first, then a second window for the actual page

> **2026-09-01 root cause** (fixed in fc03f38): two stacked issues.

**Symptom**: on lazy start, the takeover Chrome shows a blank NTP window first, then a second window opens with the target page. One redundant blank window every time (sometimes manifesting as two tabs).

**Cause (two layers, both required to fix)**:

1. **`zcode-cdp-proxy.js` passed `--isolated` to playwright-mcp.** With `--cdp-endpoint`, that flag makes the backend create its own isolated BrowserContext (`Target.createBrowserContext` + `Target.createTarget` in it — captured via `DEBUG=pw:protocol`), so it **never claims the startup NTP tab**; the first `browser_navigate` always opens a new window. The takeover Chrome already runs a dedicated profile per port — the isolation is pointless. Fix: drop the flag; the backend then uses the default context and claims the startup tab.
2. **The DevTools port listens before the startup tab exists** (race). `cdp-takeover` used to return as soon as the port listened, so the backend could connect while `pages()` was still empty → `ensureTab()` still created an extra tab. Fix: after the port listens, poll `/json/list` until a `type=page` target appears (≤10s, fail-open) before reporting ready.

**How this was pinned down** (reusable technique): reproduce via the full proxy chain, then re-run with `DEBUG=pw:protocol` inherited by the backend and grep `Target.attachedToTarget` / `Target.createBrowserContext` — the NTP attaching in the default context while the backend's page lands in a *different* context id is the smoking gun.

**Lesson**: for flags that configure page/context ownership on an attached browser (`--isolated`, `--extension`, viewport options), verify against the CDP target graph, not just "it connects and navigates".

---

### Lease survives the agent that created it

**Symptom**: a port shows "occupied" forever, even after you've quit the agent.

**Cause**: the agent process was `kill -9`'d before its cleanup trap ran, leaving the lease file behind.

**Fix**:

```bash
node bin/zcode-cdp-lease.js reap    # reaps leases whose owner PID is dead
```

Or manually verify the owner is really gone, then delete:

```bash
# Check owner PID
cat /tmp/zcode-cdp/ports/9223.lock/owner.json | grep ownerPid
# Confirm it's dead
ps -p <ownerPid>      # should print "No matching process"
# Remove
rm -rf /tmp/zcode-cdp/ports/9223.lock
```

---

## Debug logging

All proxy logs go to **stderr** (stdout is reserved for the MCP JSON-RPC protocol).

```bash
# If running proxy manually:
node bin/zcode-cdp-proxy.js 2> proxy.log

# Tail in real time:
tail -f proxy.log
```

Log lines look like:
```
[cdp-proxy 54278 14:23:01] READY_IDLE — placeholder spawned
[cdp-proxy 54278 14:23:15] activating (port 9223)
[cdp-proxy 54278 14:23:18] ACTIVE — backend ready
```

---

## Environment variable reference

| Var | Default | Purpose |
|-----|---------|---------|
| `CDP_PLAYWRIGHT_MCP_CLI` | auto-resolved | Path to `@playwright/mcp/cli.js` |
| `CDP_TAKEOVER` | `<repo>/bin/cdp-takeover` | Path to the takeover script |
| `CDP_PORTS` | `9223 ... 9229` | Session-temporary pool |
| `CDP_SCRIPT_PORTS` | `9324 9326` | Script-fixed ports for status display |
| `CDP_LOCK_ROOT` | `/tmp/zcode-cdp/ports` | Where lock files live |
| `CDP_ORPHAN_TIMEOUT_MS` | `1800000` (30min) | Idle proxy self-exit |
| `CDP_HARD_KILL_MS` | `60000` | Hard watchdog heartbeat timeout |
| `CDP_HARD_CPU_THRESHOLD` | `85` | CPU% considered busy-loop |
| `CDP_STARTUP_GRACE_MS` | `8000` | Grace period before reaping new locks |
| `CDP_STALE_LOCK_AGE_MS` | `30000` | Lock age considered stale |
