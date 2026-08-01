# Profile (Login State) Management / Profile 与登录态管理

The single biggest reason zcode-cdp exists: **let an agent use a real, already-logged-in Chrome**, instead of a fresh browser where you have to re-authenticate every site.

This document covers how login state is inherited, isolated, refreshed, and what to watch out for.

---

## 1. The core idea: rsync once, evolve independently

Each port gets its own profile directory: `~/.chrome-takeover-<port>/` (e.g. `~/.chrome-takeover-9223/`).

**First time** a port is started by `cdp-takeover`, the profile is **rsync'd from your everyday Chrome** (default source: `$HOME/Library/Application Support/Google/Chrome` on macOS). This copies over:

- Login sessions (Zhihu, Bilibili, Xiaohongshu, X, GitHub, …)
- Cookies, localStorage, IndexedDB
- Saved passwords (if Chrome has them)
- Extensions and their settings

**After that initial rsync, the profile evolves independently.** Logins you do inside the agent Chrome stay in that port's profile; logins you do later in your everyday Chrome don't auto-propagate.

---

## 2. Why "rsync once" instead of "always sync"

Three reasons:

1. **Stability of source** — your daily-use Chrome already has the sites you care about logged in and stable. One rsync brings all of that.
2. **Protect agent-side state** — sites the agent logs into (that aren't in your daily Chrome) accumulate in the agent profile. If you re-rsynced every launch, you'd blow those away.
3. **Manual refresh is rare** — in practice, you only need to refresh when you've logged into a new site in your daily Chrome and want the agent to inherit it. That's occasional, not per-launch.

---

## 3. Refreshing the login state

When you've added new logins to your everyday Chrome and want them in an agent port:

```bash
# 1. Quit the agent Chrome on that port first (rsync on a running instance corrupts it)
#    On macOS: Cmd+Q on that Chrome window, or:
kill $(lsof -iTCP:9223 -sTCP:LISTEN -t)

# 2. Force re-rsync from source
./bin/cdp-takeover 9223 --refresh

# 3. Restart normally next time you need it
./bin/cdp-takeover 9223
```

> ⚠️ `--refresh` will **refuse to run if the Chrome on that port is still alive** — rsync on a hot profile can corrupt the SingletonLock and crash Chrome on next start. Always quit first.

---

## 4. Per-port isolation

Each port's profile is fully independent:

```
~/.chrome-takeover-9223/   ← profile for port 9223 (avatar 8)
~/.chrome-takeover-9224/   ← profile for port 9224 (avatar 16)
~/.chrome-takeover-9225/   ← profile for port 9225 (avatar 24)
...
```

This means:
- **Multi-account isolation** — port 9223 can be logged in as account A on a site, port 9224 as account B. They never collide.
- **Disk cost** — each profile is a full Chrome profile. With 7 ports, that's 7× the disk of one profile. Acceptable trade-off for isolation.
- **Independent login decay** — if a site's session expires on port 9223, port 9224 is unaffected.

### Per-port Chrome avatars
`cdp-takeover` assigns each port a different Chrome built-in avatar (the cartoon icons in Chrome's profile picker) so you can visually tell which window is which port at a glance. The avatar index is baked into the `port_meta()` table in `bin/cdp-takeover`.

---

## 5. Setting the source profile path

By default, the source is your everyday Chrome at:

| OS | Default source |
|----|----------------|
| macOS | `$HOME/Library/Application Support/Google/Chrome` |
| Linux | `$HOME/.config/google-chrome` |
| Windows | untested — set `PROFILE_SRC` in `cdp-takeover` manually |

To point at a different Chrome (e.g. Chrome Beta, or a Chromium derivative), edit `PROFILE_SRC` in `bin/cdp-takeover`:

```bash
PROFILE_SRC="$HOME/Library/Application Support/Google/Chrome Beta"
```

---

## 6. What gets excluded from rsync

To avoid breaking the destination Chrome's single-instance guarantees:

```
--exclude='SingletonLock'
--exclude='SingletonSocket'
--exclude='SingletonCookie'
--exclude='lockfile'
```

These are runtime coordination files; copying them would make the destination Chrome think another instance is already running.

---

## 7. The security angle — what you should know

> 🔴 **Taking over an already-logged-in profile means your real login state is exposed to the agent.**

This is the whole point of the tool, but it has security implications:

- The agent can read cookies, localStorage, and saved passwords for every site you're logged into.
- The agent can act as you on those sites — post, delete, change settings.
- If the agent environment is shared or untrusted, this is dangerous.

**Mitigations**:
- Only use takeover in an agent environment you trust (your own machine, your own agent runtime).
- For sensitive accounts (banking, email with recovery access), consider a separate Chrome profile that you don't rsync from.
- Audit agent actions on high-value sites — zcode-cdp does **not** auto-replay failed actions, which limits accidental repeated posts, but it can't undo a successful one.
- Rotate session cookies if you ever suspect compromise.

---

## 8. Migrating from the legacy single profile

If you used a pre-v0.1 lineage with a single `~/.chrome-takeover/` profile, `cdp-takeover` auto-migrates it to the 9223 slot on first run (preserving existing login state). No manual action needed.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent Chrome opens but sites show logged-out | Source profile had no active session for that site | Log in manually inside the agent Chrome once; it'll persist |
| `--refresh` fails with "instance running" | Chrome on that port still alive | Quit Chrome first (Cmd+Q or kill the listener PID) |
| Profile corrupt after refresh | You rsync'd while Chrome was running | Delete `~/.chrome-takeover-<port>/` and re-run `cdp-takeover <port> --refresh` |
| Two ports show the same avatar | Avatar index collision in `port_meta()` | Edit the table in `bin/cdp-takeover` to give each port a unique index |
| Disk full after using many ports | 7+ full Chrome profiles | Delete profiles for ports you don't use: `rm -rf ~/.chrome-takeover-9229/` |
