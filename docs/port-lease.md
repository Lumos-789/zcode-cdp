# Port Lease Model / 端口租约模型

How zcode-cdp prevents multiple agents / scripts from racing on the same Chrome instance, and how it cleans up after crashes.

> **TL;DR** — A unified lease manager (`zcode-cdp-lease.js`) is the single source of truth for who owns which port. Proxy, `cdpcc`, and `cdp-takeover` all share one atomic lock namespace. Locks carry a random `leaseId` token so a stale PID can't accidentally release a fresh lock.

---

## 1. Why a lease model

Naive "is the port listening?" checks are not enough:

- A Chrome process may outlive the agent that started it (intentional — durable mode).
- A dead agent's PID may be reused by the OS, so "PID alive?" lies.
- Multiple clients (ZCode proxy, Claude Code via cdpcc, Python scripts) must agree on who owns what.
- Crashes leave dangling locks that block new sessions forever unless cleaned up.

The lease model solves all four by combining **atomic acquisition** (`mkdir`) with **ownership tokens** (`leaseId`) and **stale-lock reaping**.

---

## 2. Port allocation

| Range | Purpose | Manager |
|-------|---------|---------|
| **9223–9229** | Session temporary pool (7 slots) — ZCode/Codex/cdpcc pick from here | proxy + cdpcc via `zcode-cdp-lease.js` |
| **93xx** (e.g. 9324, 9326) | Script-fixed durable ports — Python/playwright clients | User-managed, **not** in the shared pick pool |
| 9222 | Historical default (playwright-mcp / legacy) | Not in current pool |

> Configure via env: `CDP_PORTS="9223 9224 9225 9226 9227 9228 9229"` and `CDP_SCRIPT_PORTS="9324 9326"`.

### Why split into two ranges
Session-temporary ports are picked automatically and released on session exit. Script-fixed ports belong to long-lived durable Chromes that you start manually with `cdp-takeover <port>`; they must **not** be picked by the session pool, otherwise a session would steal a durable browser's login state.

---

## 3. Lock file format

```
$LOCK_ROOT/<port>.lock/          ← mkdir is the atomic acquisition point
$LOCK_ROOT/<port>.lock/owner.json
```

`LOCK_ROOT` defaults to `/tmp/zcode-cdp/ports`; override with `CDP_LOCK_ROOT`.

`owner.json` shape:

```json
{
  "port": 9223,
  "leaseId": "a1b2c3d4-...",
  "ownerPid": 12345,
  "ownerStartTime": "2026-08-02T01:23:45.000Z",
  "kind": "proxy",
  "state": "ACTIVE",
  "browserPid": 67890,
  "acquiredAt": "2026-08-02T01:23:45.000Z",
  "lastHeartbeat": "2026-08-02T01:24:50.000Z"
}
```

**Critical invariant**: the `leaseId` is a random token generated at acquisition. **Any release / update must verify `leaseId` ownership first** — this prevents a recycled PID from releasing a lock that a new owner now holds.

### Legacy lock compatibility (read-only)
Older lineages used `/tmp/zcode-cdp-port-<port>.lock/pid` (old proxy) and `/tmp/cdpcc-port-<port>.lock/pid` (old cdpcc). The lease manager reads these for status display only — it never creates or mutates them.

---

## 4. Three usage modes

| Mode | User | Lease? | Chrome lifecycle |
|------|------|--------|------------------|
| **ZCode lazy proxy** | ZCode sessions | Managed by `zcode-cdp-lease.js` | Lazy-started on first `browser_*`, released by `browser_close` |
| **cdpcc** | Claude Code | Managed | Started on first `mcp__cdp__*` call (via PreToolUse hook), released when CC exits |
| **durable** | Manual `cdp-takeover <port>` | **No lease** | Cross-client, long-lived; only human kills it |

### Why durable mode has no lease
Durable Chromes are started by a human for a long-running purpose (e.g. a Python scraper that runs for hours). They survive client restarts. Imposing a lease would force re-acquisition on every script run, complicating the common case. Instead, the lease manager treats a durable Chrome as "port busy, do not touch" — never auto-kills a non-leased Agent Chrome.

---

## 5. The iron rule for direct CDP clients

> **Projects using the CDP protocol directly (Python WebSocket / playwright `connect_over_cdp`): close only the WebSocket connection, NEVER kill the Chrome process.**

Durable Chromes are managed by humans. Killing one drops its accumulated login state and forces a fresh rsync. Always just disconnect.

---

## 6. CLI commands

```bash
# Reserve a port (returns {port, leaseId} or {error})
node bin/zcode-cdp-lease.js reserve [--kind <kind>] [--port <port>]

# Release a specific port (requires leaseId for ownership check)
node bin/zcode-cdp-lease.js release <port> <leaseId>

# Mark the browser as started (after Chrome is up)
node bin/zcode-cdp-lease.js mark-active <port> <leaseId> <browserPid>

# Check whether a port is busy (read-only, works for any lock lineage)
node bin/zcode-cdp-lease.js check <port>

# Reap stale locks and orphan Chromes
node bin/zcode-cdp-lease.js reap

# Show full port table
node bin/zcode-cdp-lease.js status
```

### How `reap` decides what's stale
- Lock exists but owner PID is dead → reaped (after grace period `CDP_STARTUP_GRACE_MS`, default 8s)
- Lock file older than `CDP_STALE_LOCK_AGE_MS` (default 30s) with no owner.json → reaped
- Non-Agent listener on a port → **never** auto-killed (could be a real user service)
- Agent Chrome with no lease (durable mode) → **never** reaped (treated as busy, not stale)

---

## 7. Reserving a fixed port for your own script

If you have a Python scraper that needs a stable port:

```bash
# 1. Start a durable Chrome on port 9401 (one-time, or after each reboot)
./bin/cdp-takeover 9401

# 2. Point your script at it
# In Python (websocket-client or similar):
#   ws://127.0.0.1:9401/devtools/page/<id>
# In playwright:
#   browser = await playwright.chromium.connect_over_cdp("http://127.0.0.1:9401")
```

Add your port to `CDP_SCRIPT_PORTS` so it shows up in `cdp-takeover status`:

```bash
export CDP_SCRIPT_PORTS="9324 9326 9401"
```

---

## 8. Common pitfalls

| Symptom | Cause | Fix |
|---------|--------|-----|
| "Port busy" but no Chrome on it | Stale lock from a crashed session | `node bin/zcode-cdp-lease.js reap` |
| Two sessions fighting over a port | Pre-v0.1 lineage with separate lock namespaces | Upgrade; all three clients now share `CDP_LOCK_ROOT` |
| Released lock but next session still sees it occupied | PID was reused between release and check | The `leaseId` check prevents this; if you hit it, file a bug with `status` output |
| Chrome dies but lock stays | Direct client killed Chrome instead of disconnecting | Don't kill Chrome from scripts (see §5); run `reap` to clean up |
