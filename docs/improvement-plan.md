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

### 3A. Unify gas m³→kWh
Three sites decide "is this m³?" three ways, all off `results[0]` only, thresholds 50 / 50 / 500:
- `costForRange` (~L435), `lastNDaysCost` (~L3997), `fetchYearMonthly` (~L1945). Bill items (`itemToKwh` ~L3896) already key off `unit` correctly.

Change:
```js
function m3ToKwh(m3) { return m3 * 1.02264 * gasCalorificValue() / 3.6; }
function detectGasUnit(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return 'KILOWATT_HOUR';
  return Math.max(...nums) < 15 ? 'CUBIC_METERS' : 'KILOWATT_HOUR'; // one documented threshold, whole dataset
}
```
Replace all three REST sites; route `itemToKwh` through `m3ToKwh`. Add diagnostics line: `Gas: 48 readings, detected m³ (max 0.41) → kWh ×CV 39.5`. No new Settings UI (decision 2). REST consumption endpoint has no unit field, so magnitude heuristic is the only signal — but deciding once per dataset removes the fragility.

**Tests:** `m3ToKwh`, `detectGasUnit`. **Effort:** ~1–2 hrs.

### 3B. Sanity-check unit assumptions
`latest.demand` assumed W (~L2124); `consumptionDelta` summed as Wh (~L2173); `chargePointPowerOutput` assumed kW (~L59 / ~L3123). Don't auto-detect — make a wrong assumption *visible*:
```js
function sanityCheck(value, { min, max, label, expected }) {
  if (value == null || Number.isNaN(value)) return value;
  if (value < min || value > max)
    logDebug('Unit check', `${label} = ${value} outside plausible ${min}–${max} (expected ${expected})`);
  return value;
}
```
Bands: `demand` 0–30000 W; `chargePointPowerOutput` 0–100 kW; per-10s `consumptionDelta` 0–1000 Wh. Displayed values unchanged while plausible. Optionally clamp only the power-meter fill fraction.

**Tests:** `sanityCheck`. **Effort:** ~1 hr. (Best after 1A for a DEV gate.)

### 3C. Fetch timeout
`octRest` (~L162), `getKrakenToken` (~L191), `krakenGQL` (~L215) have no timeout — a hung mobile request leaves the app on "Syncing…" forever. iOS 16+ supports `AbortSignal.timeout`:
```js
const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
// catch: if (err.name === 'TimeoutError') throw new Error(`Timed out after 15s: ${url}`);
```
15s default; maybe 20s for `LastBill` + transactions. Timeouts become rejected results in the existing `Promise.allSettled` / `logIssue` flow.

**Effort:** ~30 min.

### 3D. Pause timers when hidden, coalesced refresh on resume
`startAutoRefresh` (~L4352) sets 3 intervals, IDs discarded, no visibility awareness. `openLive30` has its own.

- Store interval IDs.
- `visibilitychange`: `hidden` → `clearInterval` all (incl. live-30). `visible` → coalesced refresh then restart: `loadFastTier()` always; `loadSlowTier()` if `now - lastSlowTierAt > 30min`; `loadLiveUsage()` if live tag active; `loadLive30()` if that panel open.
- Track `lastSlowTierAt`. Handle `pageshow` `event.persisted` like `visible`. `refreshInFlight` guard.
- Extract `shouldRunSlowTier(lastAt, now)` (pure, tested in 1C).

**Tests:** `shouldRunSlowTier`. **Effort:** ~1–2 hrs.

### 3E. `$(id)` drift detection
- **Dev-only warning** (needs 1A): `$` wrapped to `console.warn` on missing id in `import.meta.env.DEV`, bare `getElementById` in prod.
- **Build-time id cross-check** (`scripts/check-ids.mjs`, in the `pull_request` job): extract `id="…"` from `index.html` (set A) and static `$('…')`/`getElementById('…')` from `app.js` (set B, skip calls with backtick/`+` — dynamic). Error + exit 1 on `B \ A`. Print `A \ B` as info.

Highest-value piece here — catches HTML/JS drift before deploy.

**Tests:** the check script. **Effort:** ~1 hr.

### 3F. De-dup dense-chart logic (decision 4 — optional)
`renderStackedBars` (~L685), `renderEVHistoryBars` (~L3144), partly `renderWeekBars` (~L659) re-implement `max` calc, `isDense = length > 10`, `.dense` toggle, "every 5th label when dense", "always emit `<span>` even when empty (`&nbsp;`)". Extract `chartMax(values)` and `denseLabels(labels, opts)`; refactor all three. Purely visual — verify with demo-mode screenshots. Lowest priority, no bug attached.

**Tests:** `chartMax`, `denseLabels`. **Effort:** ~1–2 hrs + visual check.

## Phase 1 sequencing

| # | PR | Depends on | Effort | Status |
|---|---|---|---|---|
| 1 | Vite build + Actions deploy + `.gitignore` + `package.json` (1A) | — | ~½ day | **Done** — merged, deployed, verified live |
| 2 | Vitest + first 7 tests + CI (1C) | 1 | ~2 hr | **Done** — 28 assertions passing, wired into CI |
| 3 | Gas unit unification + tests (3A) | 2 | ~1–2 hr | Next |
| 4 | Fetch timeout (3C) | 1 | ~30 min | |
| 5 | Visibility/timers + test (3D) | 2 | ~1–2 hr | |
| 6 | Unit sanity checks (3B) | 1 | ~1 hr | |
| 7 | `$` dev warning + id cross-check + CI (3E) | 1 | ~1 hr | |
| 8 | Chart de-dup (3F) — optional | 2 | ~1–2 hr | |

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
