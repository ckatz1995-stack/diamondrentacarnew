---
name: run-diamondrentacarnew
description: Run, verify, screenshot, or smoke-test the Diamond Rent A Car booking UI pages. Use when asked to run the app, verify a CSS/HTML change, check a page looks right, test a design update, or confirm the booking UI is healthy.
---

# Diamond Rent A Car — Booking UI

Six self-contained HTML pages live in `src/public/booking-ui/`. They run inside Wix iframes in production but can be served locally with Python's built-in HTTP server and inspected with curl. There is no build step — edit the HTML, re-run the driver.

## Prerequisites

```bash
python3 --version   # 3.x — present in this container
curl --version      # present in this container
```

No installs needed.

## Run (agent path) — smoke driver

The driver is `.claude/skills/run-diamondrentacarnew/smoke.sh`. Run it from the repo root:

```bash
bash .claude/skills/run-diamondrentacarnew/smoke.sh --verbose
```

It:
1. Starts `python3 -m http.server 7789` in the background (`src/public/booking-ui/`)
2. Fetches each page to a temp file (mandatory — `echo "$body"` silently truncates pages over ~33KB)
3. Checks for ~33 structural markers across all 6 pages
4. Exits 0 if all pass, 1 if any fail

Expected output (all healthy):

```
── index.html
  PASS  amber body
  PASS  header
  ...
Results: 33 passed, 0 failed
```

## Run (human path)

```bash
cd src/public/booking-ui
python3 -m http.server 7788
# open http://localhost:7788/index.html in a browser
```

This is useless headless; use the smoke driver instead.

## What the driver checks per page

| Page | Extra checks |
|---|---|
| `index.html` | `stats-bar`, `fleet-grid`, `reviews-grid`, `cta-strip` |
| `checkout.html` | `btn-submit` |
| `options.html` | `mobile-flow-patch` (second `<style>` tag — must stay) |
| `vehicles.html` | `search-wrap` |
| `terms.html` | `termsMain` |
| `success.html` | `sideBookingNo` |

All pages: amber body token (`c8a438`), `site-header`, `footer`, `</style>` closed.

## Validate Wix backend linting

```bash
npm run check:smoke
```

Note: currently fails on one warning in `src/backend/data.js` (unused `context` param). This is a pre-existing issue unrelated to UI changes.

## Gotchas

- **`echo "$body" | grep` silently fails for large pages.** `index.html` is ~472KB. Bash's `echo` on a shell variable of that size is unreliable — patterns that exist in the file are not found. Always use a temp file: `curl -s "$url" > "$TMP" && grep -q "$pattern" "$TMP"`. The driver does this.
- **`set -e` + `((FAIL++))` = instant death.** In bash, `((expr))` exits 1 when the expression evaluates to 0 (i.e., when `FAIL` was 0 before increment). Under `set -e` this kills the script. Use `((FAIL++)) || true` or drop `-e`.
- **Port 7789 may be occupied** from a previous run. Kill it first: `kill $(lsof -ti:7789) 2>/dev/null || true`.
- **options.html has two `<style>` tags** — the second is `<style id="mobile-flow-patch">`. This is intentional. CSS overrides always inject into the first `</style>` only.
- **CSS changes in a stacked override system** — all design CSS is appended as override blocks before `</style>`. Later blocks win. The last block is always the amber body theme (`WARM AMBER BODY`).
