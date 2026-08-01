# Platform Notes / 平台踩坑笔记

Hard-won lessons from automating sites with strong anti-bot defenses. This document captures general patterns; specific site names are illustrative.

> ⚠️ **Scope**: These notes are for legitimate automation of accounts you own or are authorized to manage (content management, personal data backup, authorized testing). Respect each site's ToS. The [disclaimer in README](../README.md#disclaimer) applies.

---

## 1. The "three prohibitions" for direct CDP clients

When you connect to a real Chrome via `connect_over_cdp` (Playwright) or a raw WebSocket, the browser's fingerprint is already that of a genuine Chrome — because it **is** a genuine Chrome. Trying to "enhance" it with anti-detection patches actually **increases** your detection risk.

| ❌ Don't | ✅ Do |
|----------|-------|
| `add_init_script` to delete `navigator.webdriver` | Leave the fingerprint alone — it's already real |
| Install `puppeteer-extra-plugin-stealth` | Rely on the genuine Chrome fingerprint |
| `context = browser.new_context()` (creates a fresh fingerprint) | Use the existing default context (`browser.contexts[0]`) |
| Override `navigator.userAgent` | Use Chrome's real UA |

**Why `add_init_script` breaks things**: under CDP, certain init-script patterns silently break network requests — pages load wrong or connections stall. The mechanism is poorly documented but reproducible. Just don't.

---

## 2. Behavioral anti-detection (do this instead)

The fingerprint is real; what you need to fake is the **behavior**. Bots are detected by rhythm, not by fingerprint.

### Human-like scrolling
```python
import random

async def human_scroll(page):
    for _ in range(random.randint(3, 7)):
        # Scroll down a random amount
        await page.mouse.wheel(0, random.randint(300, 800))
        await asyncio.sleep(random.uniform(0.4, 1.2))
        # Occasionally scroll back up a little (humans re-read)
        if random.random() < 0.3:
            await page.mouse.wheel(0, -random.randint(80, 200))
            await asyncio.sleep(random.uniform(0.3, 0.8))
        # Occasional "looking around" pause
        if random.random() < 0.2:
            await asyncio.sleep(random.uniform(1.5, 3.5))
```

### Session budget
Set a hard cap on requests per session. Example: **10 requests per 30 minutes** for sensitive platforms. When you hit the limit, stop — don't try to "just finish one more".

```python
class SessionBudgetExceeded(Exception): pass

class RateLimiter:
    def __init__(self, max_requests=10, window_seconds=1800):
        self.max = max_requests
        self.window = window_seconds
        self.timestamps = []

    def acquire(self):
        now = time.time()
        self.timestamps = [t for t in self.timestamps if now - t < self.window]
        if len(self.timestamps) >= self.max:
            raise SessionBudgetExceeded(f"{self.max} req / {self.window}s exceeded")
        self.timestamps.append(now)
```

### Exponential backoff on failure
If a request fails or returns a "are you human?" page, **stop immediately**. Don't retry hard — retrying the same way is what gets accounts banned.

---

## 3. Capturing data without triggering anti-scrape

### Prefer GraphQL / XHR interception over DOM scraping
DOM scraping requires more page interactions (more behavior to fake). If the page loads data via XHR/GraphQL, intercept the response instead — one network event vs. many clicks/scrolls.

**Playwright example**:
```python
captured = []

async def on_response(response):
    if "graphql" in response.url and "ArticleInfo" in response.request.post_data:
        try:
            captured.append(await response.json()
        except: pass

page.on("response", on_response)
# Trigger one navigation; capture fires once
await page.goto(url)
# captured[0] now has the data — no scrolling needed
```

### Fall back to SSR state when no XHR
Some pages render server-side with state embedded in `<script>` tags. Read it via `page.evaluate`:

```python
data = await page.evaluate(
    "() => window.__INITIAL_STATE__ && window.__INITIAL_STATE__.article"
)
```

Pair with `page.wait_for_function("() => window.__INITIAL_STATE__")` to ensure it's populated before reading.

---

## 4. Editing rich-text editors (Draft.js, ProseMirror, etc.)

### The problem
Calling `editor.innerHTML = "..."` or `textarea.value = "..."` doesn't update the editor's internal model. The editor shows your text briefly, then either reverts or submits empty content.

### The fix: simulate paste
For Draft.js specifically, dispatch a real `paste` event via `ClipboardEvent`:

```javascript
// Run inside page.evaluate (or via Runtime.evaluate)
function pasteIntoDraftjs(editorEl, text) {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData("text/plain", text);
  const pasteEvent = new ClipboardEvent("paste", {
    clipboardData: dataTransfer,
    bubbles: true,
    cancelable: true,
  });
  editorEl.dispatchEvent(pasteEvent);
}
```

For simpler editors, native setter + `input` event:
```javascript
function setNativeValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(
    el.__proto__, "value"
  ).set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
```

### Always test injection with a tiny payload first
Before pasting 2000 words, paste `"test"` and verify it stuck. If the editor didn't enter edit mode (because you used JS click instead of physical click), you'll waste a lot of typed content.

---

## 5. File uploads

Use CDP's `DOM.setFileInputFiles` — works on `<input type="file">` even when hidden:

```python
# Playwright connect_over_cdp example
async def upload_file(page, input_selector, file_path):
    input_el = await page.query_selector(input_selector)
    await input_el.set_input_files(file_path)
```

Raw CDP version:
```python
# After locating the input element's backend nodeId
await cdp.send("DOM.setFileInputFiles", {
    "files": ["/path/to/image.png"],
    "nodeId": input_node_id,
})
```

> ⚠️ **IAB limitation**: the ZCode In-app Browser backend **does not support** file choosers. You must use the CDP backend (managed Chromium or a takeover Chrome) for uploads.

---

## 6. Detection of risk-control pages

When a platform detects automation, it may redirect to:
- A QR-code login wall (session expired)
- A "verify it's you" slider captcha
- An empty page with no content
- A "your account is restricted" notice

**Pattern**: snapshot a screenshot whenever you see unexpected state, save with a recognizable prefix, and **stop**.

```python
async def snapshot_risk(page, label="unknown"):
    risk_path = f"_risk_{label}_{int(time.time())}.png"
    await page.screenshot(path=risk_path)
    # Log and halt this session
    raise RiskControlDetected(f"saved: {risk_path}")
```

Do **not** retry through a risk wall. Once you're flagged, every subsequent request amplifies the flag. Stop, change account or wait, and investigate.

---

## 7. Fingerprint self-check

Before running a real session, verify your Chrome's fingerprint looks genuine:

```python
async def check_fingerprint(page):
    await page.goto("https://bot.sannysoft.com/")   # or creepjs
    await page.screenshot(path="_fingerprint.png")

    indicators = await page.evaluate("""() => ({
        webdriver: navigator.webdriver,
        plugins: navigator.plugins.length,
        languages: navigator.languages,
        webgl: !!document.createElement('canvas').getContext('webgl'),
        ua: navigator.userAgent,
        platform: navigator.platform,
    })""")
    # webdriver should be false / undefined
    # plugins.length should be > 0 (real Chrome has PDF plugins etc.)
    # Save to a log file for comparison across runs
    return indicators
```

The takeaway: if you're using a real Chrome via CDP, the fingerprint should look real. If `navigator.webdriver` is `true` or `plugins.length === 0`, something is wrong with how you connected.

---

## 8. Rate-limit signals — stop immediately

| Signal | Meaning |
|--------|---------|
| HTTP 429 | Hard rate limit; back off significantly |
| Empty JSON response with 200 | Soft rate limit; you've been flagged |
| "Verify your account" interstitial | Account under review; stop |
| Cloudflare challenge page | IP-level detection; rotate or pause |
| Sudden session logout | Account may be locked |

**The single most important rule in this entire document**: when you see a rate-limit signal, **stop**. Do not retry. Do not "wait a bit and try again" automatically. Investigate, change strategy, possibly change account. Retrying the same way is what transforms a soft flag into a permanent ban.

---

## 9. Per-platform quick reference (illustrative)

These are general patterns observed across platforms with strong anti-bot defenses. They are not site-specific exploits.

| Pattern | Example platforms | Notes |
|---------|-------------------|-------|
| Closed shadow DOM on action buttons | Short-video / social platforms | Use coordinate-based physical click (see §1 troubleshooting) |
| Draft.js-based editors | Q&A platforms, blogging platforms | Use paste-event injection, not innerHTML |
| GraphQL endpoints returning JSON | Most modern SPA platforms | Intercept response instead of scraping DOM |
| SSR with `__INITIAL_STATE__` | News / content platforms | Read state directly, no scrolling needed |
| Per-session request budgets | All platforms with anti-bot | 10 req / 30 min is a safe starting point; tune down if you see risk walls |
| QR-login walls on session expiry | Platforms that prefer mobile auth | Detect early, surface to user, don't auto-retry |

---

## Further reading

- [Profile management](profile-management.md) — how to inherit and isolate login state
- [Port lease model](port-lease.md) — running multiple agents without port races
- [Troubleshooting](troubleshooting.md) — symptom→cause→fix reference
