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

Typical cause: an exception storm (e.g. EPIPE from a closed stderr pipe after the parent agent exits) keeps V8 capturing stacks at full CPU; watchdogs that depend on the event loop can't run. Current versions exit hard on `uncaughtException` to prevent this, but if you ever see a proxy burning CPU:

```bash
# Step 1: DO NOT GUESS — sample the stack first
sample <pid> 5

# If you see TriggerUncaughtException / CaptureSimpleStackTrace dominating
# → it's an exception storm (some IO is throwing)
# Step 2: stop the bleeding
kill -9 <pid>
```

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

### Chrome instance alive but zero tabs open

**Symptom**: CDP self-check fails (e.g. "connection refused"-adjacent health errors or a probe that expects at least one tab), yet the DevTools port still answers — the durable Chrome is running with no open tabs (after a crash, or the last tab was closed manually).

**Fix**: no restart needed (restarting the durable Chrome risks disturbing the logged-in profile for nothing). Just open a fresh tab through the DevTools HTTP endpoint:

```bash
curl -X PUT "http://127.0.0.1:<port>/json/new"
```

The instance comes back with one new tab and the profile/login state intact — no restart needed (restarting the durable Chrome risks disturbing the logged-in profile for nothing).

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
[cdp-proxy 54278 14:23:01] IDLE — backend spawned
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
