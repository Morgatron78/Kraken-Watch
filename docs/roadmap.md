# Kraken Watch — feature review & roadmap

Written after Phases 1 & 2 (build tooling + de-monolith) landed. This is a
full inventory of what the app does today, a gap analysis against the
Octopus API surface, and a considered plan for what to build next.

---

## 1. Current feature inventory

Six cards, all live against real APIs, degrading to "Unavailable" (or opt-in
demo data) on failure.

| Card | What it does today |
|---|---|
| **Current rate** | Now / standard / off-peak unit rate, next scheduled change. REST `standard-unit-rates`. |
| **Live usage** | Instantaneous draw in W, £/hr-if-sustained estimate, colour-banded. "Last 30 min" toggle: lazy Wh bar chart, 30s refresh while open. Kraken `smartMeterTelemetry` at 10s grouping, bucketed to 1-min bars client-side. Needs a registered smart device (Home Mini). |
| **EV charging** | Kraken `devices → SmartFlexVehicle`. Battery gauge + target-SoC countdown + restricted-zone marker; estimated range; weekly schedule strip; live power meter (while charging); consolidated warnings (suspension, dispatch failure, lost connection, SoC-limit, alerts, "Boost this week"). Sub-panels: **Charging Activity** (Windows/Sessions toggle, per-session kWh + estimated cost + estimated miles, problem badges, "Show more" 8→64d) and **Charge History** (Week/Month, tap-to-breakdown, Smart/Boost split). All **read-only**. |
| **Usage (elec + gas)** | Day (elec-only, half-hourly) / Week / Month / Year, tap-any-bar breakdown, calendar date-picker snapping both fuels to the same period. REST `consumption` (one wide call per fuel per period, bucketed locally). |
| **Billing** | Account balance + projected balance, Direct Debit (estimated), spend MTD + predicted, last-15-bills history (itemised per-fuel, links to real bill PDFs), bill-total-over-time chart (12 distinct months). Octopoints archived (returns Unauthorized). |
| **Insights** (lazy) | Per-fuel trend vs 7-day avg, rate/charge splits, weekday/weekend pattern, best/worst day, monthly trajectory, seasonal gas narrative, annual standing-charge total, EV streak + busiest day, and a 12-month **balance runway forecast** (last year's real kWh priced at today's rate). |

**Known loose ends in the current code — all closed in Phase 3a:**
- ~~`Money` field on the EV session object~~ — closed. No cost field is
  queried; a speculative field probe isn't worth risking the whole query
  for a value the twice-run investigation says isn't there. (README.)
- ~~`usage.js` `TEMPORARY diagnostic` block~~ — removed. Answered: a
  prior-year `group_by=month` request returns only the last ~2 months with
  data, the same retention floor as the finer queries — so monthly
  aggregation is no escape hatch, and `fetchYearMonthly` is current-year
  only with no `yearsAgo` param.
- ~~`ev.js` `cost.amount` pounds-decimal assumption~~ — the comment was
  stale (no cost field has been queried for some time); removed.

---

## 2. Octopus API — used vs available

### REST (`api.octopus.energy/v1`, API-key auth, ~100 calls/hr shared limit)

| Endpoint | Used? |
|---|---|
| `/accounts/{n}/` | ✅ (meter points, tariff codes, at Settings save) |
| `/products/` + `/products/{code}/` | ⚠️ product code derived from tariff code, `/products/` list itself unused |
| `electricity-tariffs/.../standard-unit-rates`, `standing-charges` | ✅ |
| `gas-tariffs/.../standard-unit-rates`, `standing-charges` | ✅ |
| `electricity-tariffs/.../day-unit-rates`, `night-unit-rates` | ❌ (Economy-7 style; N/A for IOG) |
| `electricity/gas-meter-points/.../consumption/` | ✅ |

REST is essentially fully exploited for this account's tariff shape.

### GraphQL (`api.octopus.energy/v1/graphql/`, login-token auth)

| Capability | Query/Mutation | Used? | Note |
|---|---|---|---|
| Account, bills, transactions, payments, balance | query | ✅ | Billing card |
| `smartMeterTelemetry` | query | ✅ | Live usage |
| `devices → SmartFlexVehicle`, `chargingSessions`, `preferences.schedules`, `status` | query | ✅ | EV card (read) |
| `plannedDispatches`, `completedDispatches` | query | ✅ | EV Windows |
| **`triggerBoostCharge` / `updateBoostCharge` / `deleteBoostCharge`** | **mutation** | ❌ | bump-charge now |
| **`vehicleChargingPreferences`** + set target SoC | query + mutation | ❌ | "charge to X%" |
| **set target ready-by time** | mutation | ❌ | "ready by 07:00" |
| **smart-charge on/off (smart pause)** | mutation | ❌ | pause smart control |
| **`octoplusOffers` / `octoplusRewards` / `claimOctoplusReward` / `joinOctoplusCampaign`** | query + mutation | ❌ | Free Electricity / Saving Sessions, points |
| `wheelOfFortuneSpins` | query | ❌ | unused-spin nudge |
| `electricityMeterReadings` / `createElectricityMeterReading` (+ gas) | query + mutation | ❌ | manual reading submit — low value with a smart meter |
| Referrals | query + mutation | ❌ | out of scope |

The four EV-control mutations and the Octoplus surface are the two
meaningful unused areas. Both are confirmed real and in active use by the
mature [Home Assistant Octopus Energy integration](https://github.com/BottlecapDave/HomeAssistant-OctopusEnergy).

### External (not Octopus)

- **Carbon intensity** — [National Grid ESO Carbon Intensity API](https://carbonintensity.org.uk/):
  free, no auth, 48h+ forecast across 14 GB regions. Not currently used;
  the natural data source for a "greenest window tonight" feature.

---

## 3. Candidate features

Scored against the app's established discipline: every panel pairs a number
with a visual; read-only unless there's a deliberate reason; new work slots
in as its own ES module.

### A. Carbon intensity / "greener periods" — **recommended first**
- **What:** a card showing regional carbon intensity now + a ~16h forecast,
  banded low/moderate/high, with the cleanest upcoming window called out
  and cross-referenced against the IOG off-peak window (the "cheap and
  clean align" story). IOG already shifts load to off-peak; this says
  whether off-peak also happens to be green.
- **Data:** NESO Carbon Intensity API — free, no auth, `GET
  /regional/intensity/{from}/fw48h/postcode/{outcode}`.
- **Fit:** strong — it's a forecast chart, same shape as the rate curve.
- **Effort:** ~1 day. New `carbon.js` module, one card, its own refresh
  (data updates every 30 min). No credential handling.
- **Risk:** low. External read-only API; degrades to hidden on failure.

### A2. Carbon in existing panels — the retrospective half of the story
The card above answers *"when is the grid clean?"* (forecast). These
answer *"how clean is **my** usage?"* (retrospective, personalised) —
arguably the more interesting question, and each slots into a panel that
already exists.

> **Status: done.** Shipped in order:
> - Live usage `kg CO₂/hr` line + Current rate "Grid" line (with the card).
> - Historical matcher in `carbon.js`: `ensureHistIntensity` /
>   `intensityForRange` / `intensityMeanInHourBand` / `carbonBandForRange`
>   (half-hour-keyed cache, ≤13-day chunk fetches) plus `ensureCarbonForecast`
>   / `carbonForecastForRange` (48h forecast slots, shared in-flight with the
>   card so a parallel load is one fetch).
> - EV per-session `≈ kg CO₂ · grid avg N g/kWh` sub-line.
> - EV Insights *"Smart charging this week averaged N gCO₂/kWh · ~X% cleaner
>   than a 4–7pm charge"* line.
> - EV Windows-tab intensity chip (mint/amber/coral) on every dispatch row —
>   forecast-banded for planned/active, history-banded for completed.
> - Insights **This week's carbon** block: intensity-weighted weekly kg CO₂
>   from the retained half-hourly slots, avg g/kWh, greenest vs dirtiest day
>   (compared by intensity, not total).

| Panel | Addition | Effort |
|---|---|---|
| **EV charging** *(strongest fit)* | Per-session carbon next to the estimated cost (`22.1 kWh · ~£1.66 · ~1.5 kg CO₂`); an EV Insights line (*"smart charging this week averaged 78 gCO₂/kWh — ~40% below a peak-time charge"*); a small intensity tag on the active/planned dispatch window. IOG dispatches run overnight when the grid is usually greenest, so this is a genuinely novel "your smart charging is also low-carbon" angle. | ~1 day |
| **Live usage** | One line under the existing `≈ £0.11/hr`: `≈ 0.11 kg CO₂/hr at 142 g/kWh`. Reuses the current-intensity value once `carbon.js` exists. | ~½ day |
| **Current rate** | A `Grid now: Low carbon (142 g)` line, or tint the "Off-peak" pill green when off-peak is also clean. | ~½ day |
| **Usage / Insights** | `This week's electricity: 48 kWh · ~5.1 kg CO₂`; greenest/dirtiest day; a weekly smart-charging carbon-savings figure — parallels the spend insights. | ~1 day |

**Shared dependency:** the EV / weekly / Insights additions all need
*historical* regional intensity matched to half-hourly timestamps (the
NESO API has historical + regional data). Build that matcher once in
`carbon.js` — `intensityAt(timestamp)` / `intensityForRange(from, to)` —
and reuse it across all three. The Live usage and Current rate touches
need only the live value and can ship with the card itself.

### B. Usage heat map — **SHIPPED**
An hour-of-day × weekday grid (`heatmap.js`), cell colour = mean kWh per
half-hour over the last 28 days, as a collapsible "Time-of-day pattern"
sub-panel of the Usage card. Lazy-loaded on first open with its own single
REST call (28 days of half-hourly readings); electricity only. Gamma-curved
alpha ramp so the genuine peaks carry the colour, the busiest half-hour
outlined and called out in a one-line insight.

### C. Octoplus surface (Free Electricity / Saving Sessions + points) — **SHIPPED (pending a live check)**
`octoplus.js` — a standalone card (between Billing and Insights) showing the
Octopoints balance, upcoming Saving Sessions / Free Electricity events with
their reward and a "Joined" marker, and any unused Wheel of Fortune spins.

- **Data:** `octoplusAccountInfo` (enrolment probe), `loyaltyPointLedgers`
  (`balanceCarriedForward`), `savingSessions`, `wheelOfFortuneSpinsAllowed`
  — query shapes taken from the mature Home Assistant Octopus Energy
  integration. Read-only.
- **Gating:** fires a single `octoplusAccountInfo` probe first; if that
  errors or the account isn't `ENROLLED`, the whole card stays hidden. Each
  remaining part is its own query so one 401 doesn't sink the others.
  Best-effort side feed, out of the sync-status calc (like carbon).
- **Open:** the render path and all failure/hide paths are verified against
  stubbed responses, but this account may still return Unauthorized on some
  or all of these fields like the old `loyaltyPointsBalance` attempt did —
  needs one real sync to confirm. The diagnostics panel logs the
  `enrollmentStatus` and any per-query failure.

### D. EV control — **needs a decision, not just a task**
- **What:** bump/boost charge now; set charge target %; set ready-by time;
  pause/resume smart charging. Turns Kraken Watch from a dashboard into a
  remote.
- **Data:** `triggerBoostCharge` / `updateBoostCharge` / `deleteBoostCharge`,
  `vehicleChargingPreferences` + its setter mutation, smart-charge toggle
  mutation. All confirmed in the schema and used by the HA integration.
- **Prerequisites:**
  1. Confirm the login token has write scope for device control (the app
     authenticates by email/password, same as the Octopus app, so it
     *should* — but verify before building UI).
  2. A deliberate "yes, I want the app to act" — every button here is a
     real side effect on physical hardware.
  3. Confirmation step on each action, and an explicit state re-fetch
     after, since the optimistic UI could drift from what actually happened.
- **Fit:** it's controls, not a chart — a different kind of addition, but a
  legitimate one for an EV-focused dashboard.
- **Effort:** ~2–3 days once the scope check passes. Start with bump charge
  (one mutation, clearest value), then target SoC + ready-by, then the
  smart-charge toggle.
- **Risk:** medium — write operations, hardware side effects, and the app's
  first mutations. Rate-limit budget also matters (each action is a
  GraphQL call, and a poll to confirm it took).

### E. Offline data (not just shell)
- **What:** the service worker precaches the app shell but not data, so a
  cold open with no signal shows empty cards. Cache the last successful
  sync per card and render it (stamped "as of HH:MM") until fresh data
  arrives.
- **Effort:** ~1–1.5 days, touches `sw.js` and each loader.
- **Risk:** low-medium (stale-data-labelling needs to be unambiguous).

### Explicitly not recommended
- Manual meter-reading submission — the account has smart meters.
- Push notifications redo — still blocked on needing a real scheduler, not
  GitHub Actions cron.
- Native widgets — needs a Swift/WidgetKit codebase + paid Apple account.

---

## 4. Recommended plan

**Phase 3a — finish & tidy (½ day). — DONE.**
All three loose ends closed (see §1). The `group_by=month` diagnostic was
answered (same ~2-month floor as finer queries), its temp block removed and
`fetchYearMonthly` de-parameterised; the stale `cost.amount` comment
deleted; the `Money`-field probe formally closed as not worth pursuing.

**Phase 3b — carbon (~1 day card, then optional cross-panel).**
`carbon.js` + the standalone card + its own 30-min refresh, plus the two
cheap live-value touches (Live usage `kg CO₂/hr`, Current rate "grid now"
line). Highest value-to-risk of any new feature; no credential surface.
Then, if the appetite's there: the `intensityAt` / `intensityForRange`
historical matcher and the retrospective touches (EV per-session carbon
~1 day, weekly CO₂ + Insights ~1 day). And/or the **heat map** sub-panel
(~½ day, no new API).

**Phase 3c — Octoplus, only if the account participates (~1 day).**
One live `octoplusAccountInfo` query first to check it's not
Unauthorized like Octopoints was. If it works: a compact
free-electricity-sessions + points block, probably folded into the
Billing or Insights card rather than its own.

**Phase 3d — EV control, gated on a decision (~2–3 days + a scope check).**
Only if you want the app to act. Order: verify write scope → bump charge →
target SoC + ready-by → smart-charge toggle. Confirmation dialog + post-
action re-fetch on every one.

**Or:** do 3a and stop. The app is feature-complete by the README's own
"considered and decided against" standard, and everything above is
genuinely optional.
