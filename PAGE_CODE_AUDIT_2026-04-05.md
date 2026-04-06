# Full Page Code Audit (Wix Frontend) — 2026-04-05

## Scope
Reviewed every file under `src/pages/*.js` (18 files, 3025 lines total).

## Methodology
1. Manual read-through of all page controllers.
2. Static pattern checks for:
   - message-bridge handler consistency (`postMessage`/`onMessage`),
   - swallowed exceptions (`catch {}`),
   - cache invalidation behavior on navigation/query change,
   - navigation and auth/logout flows,
   - sensitive payload handling.
3. CLI checks (`check:undone`, `lint`) and environment diagnostics.

## Key Findings (priority order)

### 1) Cached query-dependent data is not invalidated on route/query change (High)
**Probability of production bug:** 70%

Affected pages cache lookup data once and then only re-send cached values even when URL query changes:
- `Options.i5rsb.js` (`categoryItem`, `fleetModels`, `pricingCatalog`),
- `Checkout.c371l.js` (`categoryItem`, `memberPrefill`, `pricingCatalog`),
- `Categories.qtahg.js` (`vehicleItems`, `vehiclesMeta`, `pricingCatalog`),
- `Rental Terms.gd1k0.js` (`pricingCatalog`).

These files use `wixLocation.onChange(() => resend())`, but `resend()` does not clear memoized state first.

**Impact:** stale category/model/pricing shown after in-app navigation, especially in SPA-like transitions.

**Recommendation:** before each `resend()` call triggered by location change, reset relevant cache variables to `null`/empty and re-fetch.

---

### 2) Sensitive password value is echoed back to UI bridge (High)
**Probability of security/privacy issue:** 65%

In `Account Settings.ehaf1.js`, the handler for `setStaffPassword` posts `password: payload.newPassword` back to HTML component.

**Impact:** password may appear in logs/UI state snapshots/devtools and cross-frame message payloads.

**Recommendation:** never return plaintext password to frontend bridge; return only status metadata (success, user, timestamp, policy flags).

---

### 3) Heavy use of silent catches reduces debuggability (Medium)
**Probability of hidden defects increasing MTTR:** 60%

Multiple pages have many `catch (_) {}` blocks (notably `Booking Board`, `Daily View`, `Fleet Chart`, `Myroom`).

**Impact:** operational failures (wrong selector, bridge mis-bind, postMessage failures) can remain invisible.

**Recommendation:** keep user-safe behavior, but log structured warnings in at least debug mode.

---

### 4) Inconsistent HTML bridge protocol across pages (Medium)
**Probability of integration drift over time:** 55%

Different pages implement partially overlapping message contracts (`request-vehicle-category-data`, `request-vehicles-data`, `categories-ready`, etc.) and fallback selector strategies.

**Impact:** harder maintenance, increased risk when shared iframe bundle changes message type names.

**Recommendation:** define a versioned bridge contract document + shared helper for message parsing/posting/retry.

---

### 5) Placeholder pages still shipped (Low)
**Probability of confusion/cleanup debt:** 35%

`Dashboard.eh252.js` and `New Page.zv4ph.js` are intentional placeholders.

**Impact:** low runtime risk; moderate maintenance ambiguity.

**Recommendation:** map them to actual Wix page existence and remove when safe.

## Page-by-page quick status
- `Account Settings.ehaf1.js`: Functional, but password echo finding (High).
- `Booking Board.vjirh.js`: Functional flow; many silent catches (Medium).
- `Booking.q77ve.js`: Good defensive parsing; bridge duplication with other booking pages (Low/Medium).
- `Categories.qtahg.js`: Rich logic; cache invalidation risk (High).
- `Checkout.c371l.js`: Rich logic; cache invalidation risk (High).
- `Contract.cysy3.js`: Complex and mostly defensive; silent catches and large surface (Medium).
- `Daily View.yjgoi.js`: Functional; silent catch density (Medium).
- `Dashboard.eh252.js`: Placeholder only (Low).
- `Fleet Chart.ed11o.js`: Functional; silent catch density (Medium).
- `Home Login.gxie4.js`: Functional auth bridge; moderate silent catches (Low/Medium).
- `Home Page.l2zf7.js`: Stable simple bridge; no major blocker found (Low).
- `Myroom.exiuw.js`: Functional; silent catches and bridge dependency (Medium).
- `New Page.zv4ph.js`: Placeholder only (Low).
- `Options.i5rsb.js`: Cache invalidation risk (High).
- `Rental Terms.gd1k0.js`: Cache invalidation risk (Medium/High).
- `Success.tk6s9.js`: Stable bridge style page (Low).
- `Vehiclecard.i3kns.js`: Functional; moderate silent catches (Low/Medium).
- `masterPage.js`: Shared nav/logout listener; should be kept minimal and audited for message-origin policy (Medium).

## Checks executed
- `npm run check:undone` ✅
- `npm run lint` ✅ (lint pipeline now aligned with `eslint.config.cjs`)
- `npm run check:smoke` ✅ (`node --check` for page controllers + lint + unfinished markers check)

## Suggested next actions (ordered)
1. Remove password echo from account settings bridge.
2. Add cache invalidation on `wixLocation.onChange` for query-dependent page caches.
3. Introduce shared `bridgeUtils` for `normalizeMessage`, `post`, and message-type constants.
4. Replace fully silent catches with at least `console.warn` + context in non-prod/dev mode.
5. Align lint toolchain (pin local eslint version or migrate to flat config).
