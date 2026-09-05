# Kraken Watch — improvement plan

Living document. Three phases:

- **Phase 1** — build system, tests, robustness fixes. Pays for itself immediately; do regardless of roadmap.
- **Phase 2** — break the monolith into ES modules, separate fetch from render, consolidate scattered state. Worth it if the feature roadmap is substantial.
- **Phase 3** — features (EV control mutations, IndexedDB cache, tariff replay, carbon, etc.). Not scoped here.

Ordering: Phase 1 → Phase 2 → Phase 3, though Phase 2 module extraction may interleave with early Phase 3 work where a feature naturally lands in a not-yet-extracted module.

---

## Decisions

| # | Decision | Status |
|---|---|---|
| 1 | HTML-escaping of API strings + not persisting the password | **Declined** — owner accepts the risk for a personal single-user app |
| 2 | Gas unit: add a Settings "m³ / kWh / auto" dropdown | **Declined** — fix the heuristic (whole-dataset, single threshold, single function) + diagnostics line; the existing calorific-value field covers the realistic case |
| 3 | Service worker: `vite-plugin-pwa` (`injectManifest`) vs hand-rolled ~40-line plugin | **Resolved** — `vite-plugin-pwa`, `injectManifest` mode |
| 4 | Chart de-dup (B6) in scope | **Open** — cleanup only, no bug attached; safe to drop |
| 5 | Version/cache-bust mechanism | **Resolved** — git commit SHA, computed automatically at build time, not a manual bump. Semver in `package.json` becomes a purely optional, occasional, human-meaningful label with no functional role — see 1A step 3 below for why a manual bump can't reliably do the one job this number has. |

Constraints that hold across all phases: **stays vanilla JS** (no framework), rendering stays `innerHTML` string templates, `styles.css` stays one file unless splitting is trivial.

---

# Phase 1 — build, tests, robustness

## 1A. Vite build + GitHub Actions deploy

**Goal:** `git push` → CI builds → deploys to Pages. Content-hashed filenames replace all four manual version bumps (`APP_VERSION`, `sw.js` `CACHE`, two `?v=` strings) with one number in `package.json`.

### Verified de-risking facts
- No inline `on*=` handlers in `index.html`; no `window.*` globals in `app.js`. Module conversion is safe.
- One `<script src="app.js?v=2.265">`, one `<link ... styles.css?v=2.265">`.
- Root `package.json` is the orphaned push-notify one (no `version` field); `web-push` dep is unused (push is deprecated, no workflow exists).
- No `.gitignore`, no `.claude/`.

### Steps
1. **Repurpose root `package.json`** for the app (source stays at repo root — no `src/` move yet).
   - `name: "kraken-watch"`, `"version": "2.265"`, `"type": "module"`.
   - Drop `web-push`.
   - `devDependencies`: `vite`, `vitest` (+ SW plugin per decision 3).
   - Scripts: `dev`, `build`, `preview`, `test`.
2. **`vite.config.js`:**
   ```js
   import { defineConfig } from 'vite';
   import { execSync } from 'node:child_process';
   import { VitePWA } from 'vite-plugin-pwa';
   import pkg from './package.json' with { type: 'json' };

   const buildSha = execSync('git rev-parse --short HEAD').toString().trim();

   export default defineConfig({
     base: './',
     define: {
       __APP_VERSION__: JSON.stringify(pkg.version),
       __BUILD_SHA__: JSON.stringify(buildSha),
     },
     build: { manifest: true, outDir: 'dist' },
     plugins: [
       VitePWA({
         strategies: 'injectManifest',
         srcDir: '.',
         filename: 'sw.js',
         injectManifest: { injectionPoint: 'self.__WB_MANIFEST' },
         manifest: false,        // keep the hand-written manifest.json as-is
         devOptions: { enabled: false },
       }),
     ],
   });
   ```
3. **`app.js` → module:**
   - `index.html`: `<script type="module" src="/app.js">`; drop `?v=` on script + stylesheet (Vite content-hashes the built filenames instead — see below).
   - `const APP_VERSION = 'v' + __APP_VERSION__ + ' (' + __BUILD_SHA__ + ')';` — e.g. `v2.265 (a1b2c3d)`. `package.json`'s semver stays a manual, purely cosmetic label bumped whenever you like; the SHA half is what actually confirms a specific deploy landed, since it's automatic and can't be forgotten.
   - Last line — handles the deferred-module `DOMContentLoaded` race **and** lets tests import without running `init()`:
     ```js
     if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
     else init();
     ```
4. **Service worker** — `vite-plugin-pwa` in `injectManifest` mode. Keeps the hand-written `sw.js` fetch handler, `activate` cleanup, and the `octopus.energy`/`googleapis.com` bypass verbatim; the plugin injects the precache list at `self.__WB_MANIFEST` (per-file content hashes for anything not already hash-named, e.g. `index.html`, `manifest.json`, icons — the JS/CSS bundles are already content-hashed by Vite so need no separate revision). `CACHE` is **not** tied to the git SHA (that would need `define` to cross into the plugin's separate SW bundle step, which is a real but plugin-version-specific detail not worth depending on) — instead it's a small hash computed from `self.__WB_MANIFEST` itself, inside `sw.js`, at the SW's own top level: `kraken-watch-<hash of the manifest's url:revision pairs>`. That changes exactly when the actual precached content changes (any shell file's hash/revision differs), self-contained with zero cross-build coordination, and correctly does *nothing* on a commit that doesn't touch any shell file — strictly better than SHA-tied naming on both counts, so it's the one place where SHA isn't used.
5. **`.github/workflows/deploy.yml`** — `push` to `main`: `npm ci` → `npm test` → `npm run build` → `upload-pages-artifact` (`dist`) → `deploy-pages` (in a `needs: build` job). Separate `pull_request` job runs build + test only (no deploy).
6. **Manual one-time (owner):** repo Settings → Pages → Source: **GitHub Actions**.
7. **`.gitignore`:** `node_modules/`, `dist/`, `.vite/`.
8. **`.claude/launch.json`** → `npm run dev`, port 5173.

### Release flow after this
`npm version patch && git push --follow-tags`. No `sw.js` / `?v=` / `APP_VERSION` edits.

### Risks
| Risk | Mitigation |
|---|---|
| First post-migration deploy: clients hold old SW `kraken-watch-v2.265`. | Existing SW does `skipWaiting` + `clients.claim` + delete-other-caches, nav handler is network-first → fetches new `index.html` → new hashed assets → new SW installs & cleans up. Verify on one device first. |
| `base: './'` vs asset path resolution under the Pages subpath. | `npm run preview` locally; check built `index.html`. |
| `import.meta.env.DEV` used before Vite lands. | Don't add 3B/3E's DEV gate until this PR merges. |

**Effort:** largest single item, ~½ day incl. an end-to-end deploy test.

## 1B. Git discipline

- Real commits from local, one per logical change, conventional-ish messages.
- Feature branch → PR → merge to `main`, so CI runs before deploy.
- Existing history left as-is (pushed, public, no value rewriting).
- **`CHANGELOG.md`** started for new work. The ~150 inline `v2.xxx` comments in `app.js` left alone this pass (they carry genuine "why" context); optional thinning later.

**Effort:** ~zero, discipline only.

## 1C. Tests (Vitest) — done

Shared the "make functions importable" prerequisite with 1A.

- `vitest` + `jsdom` as dev deps, `test/` dir, `"test": "vitest run"`.
- `vitest.config.js` is deliberately separate from `vite.config.js` (that config runs a git subprocess + PWA manifest injection at load time, unwanted on every test run); it needs its own `define` stand-ins for `__APP_VERSION__`/`__BUILD_SHA__` since Vitest doesn't read the app's Vite config.
- `environment: 'jsdom'` — required even before `init()` is a concern, since module-load-time code (`loadRestCallLog()`) touches `localStorage` directly, which doesn't exist in plain Node.
- The bottom-of-file bootstrap now guards on `document.getElementById('connect-btn')` existing before wiring `init()` at all — not just the `readyState` check — since jsdom's `document.readyState` can't be relied on to still read `'loading'` by the time a bare test-file import runs. This also reads as a legitimate production safeguard on its own merits ("only bootstrap against a document that actually has this app's markup"), not a test-only hack.
- `estimateSessionCostP` refactored to take rates as an optional second argument (defaulting to the module cache), so it's testable without reaching into module state.
- `trendVsAverage` extracted from the duplicated inline logic in `renderInsightsElec`/`renderInsightsGas` — this is the "colour follows good/bad *news*, not arithmetic sign" logic the README documents as having shipped inverted twice.

### First batch — 7 functions, 28 assertions, all passing
`test/rates.test.js`: `rateAt`, `bucketReadingsByDay`. `test/ev.test.js`: `bucketTelemetryByMinute`, `estimateSessionCostP`, `formatElapsed`, `formatVehicleName`. `test/insights.test.js`: `trendVsAverage`.

The three functions originally slated for this batch that don't exist yet (`m3ToKwh`/`detectGasUnit`, `sanityCheck`, `shouldRunSlowTier`) get their tests alongside their own PRs (3A, 3B, 3D respectively) instead — see each section below.

CI: `npm test` runs before `npm run build` in the `build` job, on both `push` and `pull_request`.

**Effort:** ~2 hrs actual.

## Robustness fixes

Each its own branch/PR. 3A first (real bug value); rest independent.

### 3A. Unify gas m³→kWh — done
Three sites decided "is this m³?" three ways, all off `results[0]` only, thresholds 50 / 50 / 500:
`costForRange`, `lastNDaysCost` (both daily-granularity, threshold 50), `fetchYearMonthly` (monthly-granularity, threshold 500). Bill items (`itemToKwh`) already keyed off the real `unit` field correctly and just needed routing through the shared conversion.

**Correction made during implementation, not as originally planned:** the plan above proposed a single new threshold (15) shared across every site. That was wrong on two counts, both caught before landing:
1. **One threshold can't work across granularities.** `fetchYearMonthly` deals in monthly totals (a genuine winter month can be 100+ m³ for a large house), while `costForRange`/`lastNDaysCost` deal in **daily** totals — confirmed from the app's own "your smart meter only reports gas readings once a day" message, i.e. these were never half-hourly readings to begin with. A month-scale value and a day-scale value need different cutoffs; there was never going to be one safe number for both.
2. **The daily threshold shouldn't have been re-tuned at all.** The original value (50) was presumably already validated against this app's real account history; a fresh back-of-envelope estimate isn't stronger evidence than that. The actual bug was the *inconsistency* between sites and the *per-first-reading* fragility — not the threshold numbers. Both original values (50 for daily, 500 for monthly) were kept exactly; a first test run with an invented 15 caught this before it shipped.

```js
function m3ToKwh(m3) { return m3 * 1.02264 * gasCalorificValue() / 3.6; }
const GAS_M3_THRESHOLD_DAILY = 50;   // costForRange, lastNDaysCost — matches the original per-site value
const GAS_M3_THRESHOLD_MONTHLY = 500; // fetchYearMonthly — matches the original value
function detectGasUnit(values, threshold) {
  const nums = values.filter(v => Number.isFinite(v));
  if (!nums.length) return 'KILOWATT_HOUR';
  return Math.max(...nums) < threshold ? 'CUBIC_METERS' : 'KILOWATT_HOUR';
}
```
All three REST sites now decide the unit once per whole fetched batch (not per first reading, not per day-bucket) and share one conversion function; `itemToKwh` routes through the same `m3ToKwh`. A diagnostics line on `costForRange`'s debug path now reports the detected unit. No new Settings UI (decision 2 stands) — the REST consumption endpoint genuinely has no unit field, so the magnitude heuristic is the only signal available, but deciding once per dataset removes the fragility.

**Tests:** 10 assertions in `test/gas.test.js` — `m3ToKwh`'s formula and Settings-override behaviour, and `detectGasUnit` at both granularities, including a fixture specifically constructed so the old per-first-reading bug and the new whole-batch fix would disagree (proving the fix actually changes behaviour, not just refactors it). 38/38 tests passing overall. **Effort:** ~1.5 hrs actual, including the threshold correction.

### 3B. Sanity-check unit assumptions — done
`latest.demand` assumed W, `consumptionDelta` assumed Wh, `chargePointPowerOutput` assumed kW — none independently confirmed against Octopus's undocumented schema. Implemented exactly as planned, no auto-detection or correction — a wrong assumption should be *visible*, not silently absorbed or clamped:
```js
export function sanityCheck(value, { min, max, label, expected }) {
  if (value == null || Number.isNaN(value)) return value;
  if (value < min || value > max)
    logDebug('Unit check', `${label} = ${value} outside plausible ${min}–${max} (expected ${expected})`);
  return value;
}
```
Wired at all three sites with the planned bands (`demand` 0–30000 W, `chargePointPowerOutput` 0–100 kW, per-10s `consumptionDelta` 0–1000 Wh) — the displayed value is always returned unchanged, plausible or not; only a diagnostics line differs. `consumptionDelta` is checked once against the whole fetched batch's *maximum* in `loadLive30`, not per point — a genuine unit change would affect essentially every reading, so the max alone catches it without logging up to 180 times (one per 10s point) on every 30s refresh. Kept out of the pure, tested `bucketTelemetryByMinute` itself, which stays side-effect-free; the check lives in its caller instead.

No clamping was added anywhere (the "optionally clamp the power-meter fill" idea from the original plan was dropped) — clamping would have meant the fill bar and the printed number could disagree, which is worse than an occasionally-oversized bar.

**Tests:** 5 assertions in `test/sanity-check.test.js` — in-band passthrough (no log), out-of-band passthrough (still returns the value, still logs — proving it never clamps), below-minimum, null/undefined/NaN all skipping the check entirely, and both band boundaries themselves counting as in-band. Verified via `console.info` spy that the log genuinely fires only when expected. 54/54 tests passing.

**Effort:** ~45 min, as estimated.

### 3C. Fetch timeout — done
`octRest`, `getKrakenToken`, `krakenGQL` had no timeout — a hung mobile request left the app on "Syncing…" indefinitely, since nothing would ever settle the promise either way. One shared `FETCH_TIMEOUT_MS = 15000` (not per-call — 15s is generous for any single request/response round trip; revisit per-call only if a specific query genuinely needs longer) wired into all three via `AbortSignal.timeout()`, which iOS 16+ supports comfortably for this app's installed-PWA target.

`isTimeoutError(err)` centralizes the `TimeoutError`/`AbortError` name check so all three catch blocks agree on what counts as a timeout, rather than three near-duplicate checks. `krakenGQL`'s timeout error names the actual GraphQL operation (`extractGqlOperationName(query)`, e.g. "AccountBalance → timed out after 15s") rather than a generic "GraphQL" — this file has many differently-shaped `krakenGQL` calls sharing one function, unlike `octRest` where the path itself already identifies the request. Timeouts surface as ordinary rejections through the existing `Promise.allSettled`/`logIssue` flow — no new handling needed there.

**Tests:** 7 assertions in `test/api.test.js` — `isTimeoutError` against both real error names plus a non-timeout error and nullish input; `extractGqlOperationName` against a query, a mutation, and an anonymous operation. 45/45 tests passing overall.

**Effort:** ~30 min, as estimated.

### 3D. Pause timers when hidden, coalesced refresh on resume — done
`startAutoRefresh` set 3 intervals with their IDs discarded, no visibility awareness at all; `openLive30`'s own 30s poll had the same gap.

- Interval IDs are now tracked (`fastTierIntervalId`, `slowTierIntervalId`, `liveUsageIntervalId`), split into `startAutoRefreshTimers()`/`stopAutoRefreshTimers()`. `stopAutoRefreshTimers()` also clears `live30Interval` if the Last-30-min panel is open, but deliberately leaves `live30Open` itself untouched — that flag means "the user has this open," which stays true through a hidden tab; `closeLive30()` (the user actually closing it) is the only path that resets it. `startAutoRefreshTimers()` resumes `live30Interval` if `live30Open` is still true, and is idempotent (a `pageshow` and `visibilitychange` can both fire for the same bfcache-restore transition, and a missing guard here would have double-scheduled every interval).
- `visibilitychange`: `hidden` → `stopAutoRefreshTimers()`. `visible` → `refreshOnResume()` (fire-and-forget) then `startAutoRefreshTimers()`. `refreshOnResume()` always runs `loadFastTier()`, runs `loadSlowTier()` only if `shouldRunSlowTier(lastSlowTierAt, Date.now())`, and runs `loadLiveUsage()`/`loadLive30()` (the latter only if the panel's open) — guarded by `resumeRefreshInFlight` so an overlapping second trigger (e.g. `pageshow` alongside `visibilitychange`) is a no-op rather than a duplicate fetch burst.
- `lastSlowTierAt` is set both at the top of `loadSlowTier()` (before attempting — a repeatedly-failing account shouldn't get hammered every time the tab regains focus) and in `loadAll()` itself, which does the slow tier's actual work (`loadBilling()`) directly during the initial/manual full sync.
- `pageshow` with `event.persisted` runs the identical resume path, covering the bfcache-restore case (e.g. an iOS Safari swipe-back into an already-loaded tab).

**Verified live**, not just unit-tested: seeded fake credentials to get past the connect screen, then used `Object.defineProperty` to fake `document.hidden`/`visibilityState` and dispatched real `visibilitychange`/`pageshow` events against the built production preview. Console error count (each a real, expected 400/401 from the fake credentials, not a JS crash) stayed flat while "hidden," then jumped on each simulated resume — confirming both paths actually fire the refresh and nothing fires while hidden.

**Tests:** 4 assertions for `shouldRunSlowTier` in `test/refresh.test.js` (never-run, just-under, exactly-at, and well-past the interval). 49/49 tests passing overall.

**Effort:** ~1.5 hrs, including live verification.

### 3E. `$(id)` drift detection — done
- **Dev-only warning**: `$` now branches on `import.meta.env.DEV` — the dev version warns and returns `null` on a missing id, the production version is the original bare `document.getElementById(id)`, so nothing changes in what ships. **Verified live, both branches**: removed `#sync-dot` from the DOM and clicked "Sync now" against both a `vite dev` server and the production `vite preview` build. Dev printed `[kw] missing #sync-dot`; production threw the exact same opaque `TypeError: Cannot set properties of null` the README's bill-history-toggle story describes, with zero warning overhead, confirming the dev branch is genuinely compiled away rather than just usually not firing.
- **Build-time id cross-check** (`scripts/check-ids.mjs`, wired into the CI `build` job via `npm run check-ids`, so it runs on both `push` and `pull_request`): extracts every `id="…"` from `index.html`, plus every id `app.js` **assigns to an element it builds at runtime** (`insertAdjacentHTML`/template-literal markup with `id="…"`, or `el.id = '…'` on a `createElement`'d node — `ev-sessions-toggle-wrap`, `bh-pill-group`, and `ev-month-partial-note` all work this way) — missing that second source on the first run produced 3 false positives before the check was corrected to include it. Cross-references that combined set against every statically-resolvable `$('…')`/`getElementById('…')` call in `app.js`, skipping (and counting, not guessing at) any template-literal call with `${…}` interpolation. Errors and exits 1 on a genuine miss; a real index.html id with no static JS reference is printed as informational only, since it may well be built from an interpolated template the script can't resolve. **Run against the current codebase: zero missing ids, confirming no existing drift** — 24 informational "unreferenced" ids, all explained (template-literal-constructed, referenced only from the archived/disabled `octopoints-archive.js`, or CSS-only anchors).

Highest-value piece in this batch — catches HTML/JS drift before deploy, which is exactly the bug class the bill-history-toggle incident was.

**Tests:** 10 assertions in `test/check-ids.test.js`, covering all four extraction functions plus `findIdIssues` end-to-end (including a fixture specifically constructed with a genuine drift, to prove the check actually fails when it should, not just that it passes on good input). 65/65 tests passing overall.

**Effort:** ~1.5 hrs, including the runtime-defined-id correction.

### 3F. De-dup dense-chart logic (decision 4 — optional)
`renderStackedBars` (~L685), `renderEVHistoryBars` (~L3144), partly `renderWeekBars` (~L659) re-implement `max` calc, `isDense = length > 10`, `.dense` toggle, "every 5th label when dense", "always emit `<span>` even when empty (`&nbsp;`)". Extract `chartMax(values)` and `denseLabels(labels, opts)`; refactor all three. Purely visual — verify with demo-mode screenshots. Lowest priority, no bug attached.

**Tests:** `chartMax`, `denseLabels`. **Effort:** ~1–2 hrs + visual check.

## Phase 1 sequencing

| # | PR | Depends on | Effort | Status |
|---|---|---|---|---|
| 1 | Vite build + Actions deploy + `.gitignore` + `package.json` (1A) | — | ~½ day | **Done** — merged, deployed, verified live |
| 2 | Vitest + first 7 tests + CI (1C) | 1 | ~2 hr | **Done** — 28 assertions passing, wired into CI |
| 3 | Gas unit unification + tests (3A) | 2 | ~1–2 hr | **Done** — threshold values corrected during implementation, see 3A |
| 4 | Fetch timeout (3C) | 1 | ~30 min | **Done** |
| 5 | Visibility/timers + test (3D) | 2 | ~1–2 hr | **Done** — verified live via simulated visibility events |
| 6 | Unit sanity checks (3B) | 1 | ~1 hr | **Done** |
| 7 | `$` dev warning + id cross-check + CI (3E) | 1 | ~1 hr | **Done** — verified live in both dev and prod builds; zero existing drift found |
| 8 | Chart de-dup (3F) — optional | 2 | ~1–2 hr | Next (last Phase 1 item; optional) |

1B runs throughout.

---

# Phase 2 — de-monolith

**Assessment:** the app is *not* poorly architected — it's a competently built monolith at its size limit. Conceptual separation already exists (the section banner comments are essentially a module list). The real weaknesses:

1. One 4,655-line file; ~30 loose module-level `let`s (`periodMode`, `selectedDay`, `pickedDate`, `fuelData`, `evViewMode`, `evWeekBuckets`, cached rates…) with nothing stopping any function touching any state.
2. Fetch and render interleaved in giant functions (`loadEVSmartFlex` ~450 lines = one query + 8 sub-renders + event wiring; `loadBilling` similar). Can't test data logic without a DOM; can't change a render without risking the fetch.
3. DOM used as a state store in places (`aria-expanded` read back to decide behaviour; `evManualOverride` vs `.classList.contains('hidden')`). The `bill-history-toggle` destruction bug is the symptom.
4. No shared "card" abstraction — every panel re-implements loading/error/empty/re-render.

**This is not a rewrite.** It's incremental module extraction along existing seams, behind the Phase 1 test net.

## Prerequisites
Phase 1 complete: Vite/ESM build, Vitest, CI. Without the test net and build this is too risky.

## Principles
- **One module per PR.** Each PR is *pure move + `import`/`export` rewiring* **or** *pure behaviour change* — never both.
- Tests green before merge; add characterization tests for a module's pure logic as it's extracted.
- No user-visible behaviour change per PR; demo-mode screenshot check for render-heavy modules.
- Keep the `v2.xxx` inline comments during moves (don't scrub + move together).
- Short-lived branches, merge fast, rebase — avoid stacked-PR conflicts.

## Module breakdown (extraction order — leaf/shared first)

| # | Module | Contents | Imports |
|---|---|---|---|
| 1 | `store.js` | `store` object, sync log (`logSyncAttempt`/`getSyncLog`), REST-call log | — |
| 2 | `format.js` | `fmtGBP`, `fmtP`, `fmtKwh`, `fmtT`, `formatElapsed`, `$` | — |
| 3 | `diagnostics.js` | `logIssue`, `logDebug`, `syncIssues`/`debugNotes` (as reset + accessor, not bare `let`), `renderDiagnostics` | store, format |
| 4 | `api.js` | `octRest`, `krakenGQL`, `getKrakenToken`, `checkRateLimitBlocked`, timeout wrapper | store, diagnostics |
| 5 | `charts.js` | `renderWeekBars`, `renderStackedBars`, `renderChartScale`, `renderPowerMeter`, `chartMax`, `denseLabels` | format |
| 6 | `rates.js` | `fetchElecRates`/`fetchGasRates`, `rateCache` + eviction, `rateAt`, `costForRange`, `bucketReadingsByDay`, gas conversion, `bufferedRateFrom`; cached-rate globals → exported mutable `rateState` object (only `rates.js` writes it) | api, store, diagnostics |
| 7 | `ev.js` | all EV (~1,200 lines): `loadEVSmartFlex`, session/dispatch renderers, history buckets, insights, demo | api, charts, rates, format, store |
| 8 | `usage.js` | fuel panels, `renderFuelPanel`, day/week/month/year, date picker, `lastNDaysElecSplit` etc. | api, rates, charts |
| 9 | `billing.js` | `loadBilling`, bill rows, bill-year chart, `restoreToggleToSafety`, demo/unavailable | api, rates, format, charts |
| 10 | `insights.js` | `loadInsights`, `renderInsights*`, balance forecast | rates, billing state, charts |
| 11 | `settings.js` | settings modal open/save, meter-point lookup | store, api |
| 12 | `main.js` (was `app.js`) | `init`, event wiring, `loadAll`/`loadFastTier`/`loadSlowTier`, `startAutoRefresh`, visibility handling | all |

Optional cosmetic: move the `.js` files into `src/`.

## Cross-cutting sub-tasks (own PRs, done per-module as extracted)
- **2.A — State consolidation.** Replace the ~30 loose `let`s with per-domain state objects (`usageState`, `evState`, `billingState`, `pickerState`). Render functions take state as input rather than reaching for globals.
- **2.B — fetch/render split.** `loadX()` → `fetchX(): Promise<Data>` + `renderX(data): void`. Highest value for `ev.js` and `billing.js`. This is what makes logic testable and what would have made the toggle bug structurally impossible.
- **2.C — Stop reading state from the DOM.** `evManualOverride`, insights/EV expanded flags, `aria-expanded` reads → explicit state.
- **2.D — Optional `card(el, { fetch, render })` helper** standardizing loading/error/empty — only if the repetition still grates after extraction.

## Risks
| Risk | Mitigation |
|---|---|
| Circular imports (charts ↔ rates ↔ ev) | Leaf-first order; shared pure helpers stay in `format.js` / `charts.js`; `rates.js` owns `rateState`, others only read it |
| Regression on render-heavy modules | Demo-mode screenshot diff per PR |
| Stacked-PR merge conflicts | Short-lived branches, merge fast, rebase |
| Many small modules → perf? | Vite bundles to one hashed file; no cost |

## Explicitly NOT in Phase 2
No framework. No change to the `innerHTML`-template rendering approach. No CSS restructure. No IndexedDB / offline / features (Phase 3).

## Effort
~12 module PRs + 3–4 cross-cutting PRs, each 1–3 hrs → ~1.5–2.5 days focused, spread over as many sessions as wanted. App fully working at every step; safe to pause between any two PRs.

---

# Phase 3 — features (not scoped here)

From the review, roughly in priority order: IndexedDB stale-while-revalidate cache; EV control mutations (`triggerBoostCharge`, `setVehicleChargePreferences`, `updateDeviceSmartControl`, charge-cap toggle); bill-prediction accuracy tracking; carbon footprint (`getProjectedRegionalCarbonIntensity`); half-hourly usage heatmap; tariff "what-if" replay; `weeklyUsageInsights` / `costOfUsage`; greener-nights forecast; rate-change history; CSV/JSON export; iOS Shortcuts endpoint.
