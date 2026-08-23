# Kraken Watch

A personal installable PWA dashboard for Octopus Energy — current rate, live
usage, Intelligent Octopus Go EV charging, consumption, and billing, all on
one screen, with your own API credentials stored only on your device.

## Current status

| Panel | What it shows | Status |
|---|---|---|
| Current rate | Now/standard/off-peak rates, next change | **Live** |
| Live usage | Current draw (W), £/hr estimate, color-coded by level. A "Last 30 min" toggle expands a pink Wh bar chart below the half-row — lazy-loaded only on expand, refreshes every 30s while open, stops the moment it's closed. Uses `smartMeterTelemetry` at `TEN_SECONDS` grouping, bucketed into 1-minute bars client-side (goes through Kraken GraphQL, so it never counts against the REST-call diagnostic) | **Live** — needs an Octopus Home Mini (or similar registered device); shows a plain "not available" message if you don't have one |
| EV charging | Built on Octopus's SmartFlex API (`devices` → `SmartFlexVehicle` → `chargingSessions`). Live battery gauge with target-SoC/countdown, a striped "restricted zone" beyond the charge limit — driven by today's actual schedule target (`preferences.schedules[today].max`), falling back to the device-level `stateOfChargeLimit.upperSocLimit` only if no schedule entry exists for today; the device-level field alone turned out to be null on this account even mid-schedule, which silently hid the marker entirely until this was found — and estimated range added — the mi/kWh conversion, WLTP range, and usable battery kWh are all Settings-configurable per vehicle (Settings → EV), falling back to a Polestar 2 Standard Range Single Motor spec if unset. Vehicle title shows make on one line, model as a smaller caption underneath, both freely editable in Settings (make ≤15 chars, model ≤60). A weekly schedule strip highlights whichever target is still upcoming. Below that, a compact **live power meter** (segmented bar, scaled against a max-charger-kW fallback constant — no Settings field for this yet) shows current draw only while actively charging; kept fully out of the DOM otherwise rather than a placeholder. A single consolidated warnings area covers suspension, dispatch failures, connection loss, SoC-limit violations, device alerts, and a "Boost session this week" flag. Two subpanels: **Charging Activity** (Windows/Sessions toggle). Session rows show elapsed time, kWh added, a muted estimated cost, and estimated miles added — no SoC %/gain figures (see Approximations for why that was removed). Any session with a genuine problem gets a small warning-icon toggle inline with the SMART/BOOST badge; tap to expand the full message. "Show more" doubles the session window each press (8→16→32→64 days, each tier cached); "Show less" resets to 8. **Charge History**: Week/Month toggle (Day view removed — nearly every real session is an overnight charge straddling two calendar days, which an hour-of-today bucketing handled by silently missing rather than showing usefully), real kWh scale, tap-to-breakdown, Smart/Boost split in the chart legend, estimated cost as a third header stat. **Open risk if the account ever switches to charger-based smart charging** (e.g. an Ohme charger): this whole panel is built against `SmartFlexVehicle` via an inline GraphQL fragment — a different device type would likely show Unavailable until queries are rebuilt against the real shape | **Live**, via Kraken GraphQL |
| Usage (electricity + gas) | Day (electricity-only, half-hourly)/Week/Month/Year views, tap any bar for that period's full breakdown. **Date picker**: a calendar icon next to the toggle opens a compact month grid — picking a day snaps Week/Month/Day to the matching real period, both fuels moving together | **Live** |
| Billing | Account balance and projected balance, Direct Debit (estimated), Spend this month/Predicted, bill history (last 15 bills, most recent expanded, itemized per-fuel with links to the real bill), a bill-total-over-time chart (last 12 distinct months). **Octopoints — archived, not deleted**: live testing returns Unauthorized, likely an account permissions gap; implementation preserved in `octopoints-archive.js` | **Live** |
| Insights | Collapsed by default. Per-fuel trend vs. 7-day average, rate/charge splits, weekday/weekend pattern, best/worst day, monthly trajectory, seasonal gas narrative, annual standing charge total, a standalone **EV Charging** panel (streak + busiest day), and a 12-month balance runway forecast (see below) | **Live**, lazy-loads a month of data on first expand |

**Balance runway forecast**: for each of the next 12 payment cycles, prices
*last year's same calendar month's real kWh* at *today's* blended rate,
plus today's standing charge × days in that month — falling back to a flat
repeat of this month's predicted cost when no matching month exists.
Chart bars show real cumulative trajectory (mint = credit, coral = debit);
tap a bar for that cycle's ledger breakdown (balance carried forward →
electricity/gas → subtotal → payment → projected balance) and which real
month it's priced from. Unit rate and Direct Debit amount both stay fixed
at today's value throughout, since neither is knowable that far out.

If a live call fails, that section shows "Unavailable" rather than a fake
number. Demo data is available for testing but is **off by default** —
turn it on in Settings ("Show demo data when something fails to load").

## Color language

Each color means one specific thing, consistently, everywhere it appears:

- **Pink** — electricity's identity. Panel border, current-rate figure and
  badge, predicted month/year, peak-rate chart segments, the EV sub-panel
  border, active dispatch slot/badge.
- **Blue** — gas's identity, the same way pink is electricity's.
- **Mint** — "this is the cheaper one," never fuel-specific. Off-peak rate,
  CREDIT balance status, cheapest-day extremes, the weekday side of
  weekday/weekend.
- **Coral** — genuine financial warnings only: DEBIT balance, a declining
  balance runway, sync errors. Deliberately not reused for "priciest
  day"/peak rate, to keep it scoped to "something's wrong."
- **Amber** — "this is the more expensive one," fuel-agnostic, parallel to
  mint. Also independently used for "pending/caution" states elsewhere
  (planned dispatch slots, medium live-usage draw, stale sync dot) — not
  the same concept, but they don't currently clash.
- **Violet** — general UI chrome only (buttons, focus rings, progress
  bar), no longer used for anything fuel- or rate-specific.

One recurring bug worth remembering for any "vs average" indicator: the
color needs to follow whether the direction is *good or bad news*, not the
raw arithmetic sign — spending above average is bad (coral), below is good
(mint), the opposite of the balance-trend pill nearby where "up" is good.
Two instances of this exact bug have shipped and been caught by the user,
not code review — worth double-checking by hand for any new comparison.

## Typography

Two families, each with one job:

- **Space Grotesk** — titles and headlines only (card titles, panel
  titles, the brand name, buttons). Nothing else uses it.
- **Inter** — everything smaller: labels, captions, chart text, data
  values, pills, breakdown rows, session rows. Keeps
  `font-variant-numeric: tabular-nums` so numeric columns align.

Five deliberate size tiers for anything smaller than a title (all Inter):

| Role | Examples | Size |
|---|---|---|
| Uppercase eyebrow labels | `.stat-label`, `.big-label`, `.insight-label` | 10px |
| Dim secondary captions | `.runway-detail`, `.trend-caption`, `.forecast-caption` | 10.5px |
| Chart axis/scale labels | `.chart-scale`, `.time-axis`, `.forecast-scale` | 9px |
| List/row item text | `.breakdown-row`, `.bh-item`, `.slot` | 11.5px |
| Pills/badges/toggles | `.card-tag`, `.trend-pill`, `.unit-toggle-btn` | 10.5px |

Within a list row, the one or two genuinely primary values (a session's
date and its kWh added, say) go bold + full text color; everything else —
labels, secondary figures, estimates — stays the dim secondary color, so
there's one clear thing to catch at a glance per row, not several
competing for attention. Session rows are the clearest example of this in
practice.

**A real gotcha worth remembering for any future font/size migration**: a
global find/replace on an old font name only catches rules that
*explicitly* declared it — any rule silently inheriting the page default
instead sails straight through untouched. The only reliable check is
auditing for *any* rule missing a font-family in the target category, not
just grepping for the old value.

## Icons

Every icon in the app is a hand-inlined SVG — no icon font, no library, no
CDN dependency, for offline PWA reliability (the same reasoning behind
Google Fonts being the only external asset the app loads). Shared stroke
style: `viewBox="0 0 24 24"`, `stroke="currentColor"`, `stroke-width="2"`,
round caps/joins, `fill="none"`, sized via the `<svg>` element's own
`width`/`height` rather than font-size.

**Sizing**: every card-title/panel-title icon is 26px. Small inline icons
(settings, warnings, checkmarks) stay smaller, matching their dense
context. Diagnostics log glyphs are deliberately left as plain characters
— a dense technical readout reads better with simple glyphs than 10+
repeated icon instances.

**Color** follows the color language above: electricity-specific icons
pink, gas blue, Balance runway's icon dynamic mint/coral, fuel-agnostic
icons neutral.

**Lessons from the original emoji→SVG migration**: icons set entirely via
JS (`.innerHTML`/`.textContent` at render time, never in static HTML) are
easy to miss in a sweep that only checks the template — any future icon
audit needs to check *rendered* output or grep the JS file too, not just
HTML. A case-sensitive text match for a bulk style change can also silently
skip a real instance with different casing — match on class/id, not
visible text, for anything like that in future. Plain Unicode characters
like "ℹ"/"⚠" render as small colorful emoji by default on iOS even though
they're "just text" — worth checking for that specifically if adding any
new plain-character indicator.

## Performance

Automatic background refresh runs in three tiers:

- **Live usage**: its own 30-second poll, independent of everything else.
- **Fast tier** (rate + EV status): every 5 minutes.
- **Slow tier** (consumption bars, MTD, bills, standing charges,
  balance/Direct Debit): every 6 hours — this data genuinely can't change
  faster than that (smart meter settlement lag, monthly billing, etc).

Manual refresh and initial app load trigger everything at once regardless
of tier timing. Vehicle registration info (make/model) is fetched once per
app lifetime, not on any recurring tier — cached in `store.creds`, every
later call a no-op.

**Usage bars** use one wide-range REST call per fuel per period, bucketed
into individual days locally in JS, rather than one call per day —
cold-start REST volume dropped from roughly 30 calls to about 11.
Octopus's documented shared rate limit is 100 REST calls/hour; the
diagnostics panel shows a live rolling count against it.

**GraphQL page-size lesson**: `chargingSessions`'s `first:` argument has a
real, undocumented cap — values as low as 100–200 have hit "Invalid
pagination parameters" on this account. `first: 30` is the only value
confirmed safe anywhere the app uses this field; if extending any session
fetch, use 30 or paginate via `pageInfo.hasNextPage`/cursor rather than
guessing a larger single fetch.

## Diagnostics

Settings → "Show diagnostics panel when syncing" (on by default) reveals a
debug panel above the main content whenever there's something worth
showing:

- **Current-moment info**: whatever the most recent sync logged — rate
  periods matched, days with/without data, REST-call-in-the-last-hour
  count, any warnings from that run.
- **Recent syncs**: a persistent log (`localStorage`, capped at 60
  entries) — timestamp/trigger (`app-start`/`button`/`fast`/`slow`),
  obfuscated API key snapshot, pass/fail per component, and captured error
  detail (the real response body or exception message) for any failure.

If you ever need to debug something new: reproduce it, then screenshot
this panel. The detail line usually tells you whether it's a real API
error or a client-side bug.

**A real bug this caught, worth remembering the shape of**: a
persistent, `id`-referenced DOM element (a bill-history toggle button) was
being moved into a container that a later `.innerHTML =` assignment then
wiped — breaking every *second* sync in a session while the *first* always
worked, which looked exactly like an intermittent auth problem until the
diagnostics log's captured error text showed the real `null is not an
object` exception. Lesson: never move a persistent `id`-referenced element
into content a later `.innerHTML =` might wipe — render moved content
fresh each time, or move it back to a safe position before any risky
reassignment.

## Approximations worth knowing about

- **Real EV session cost isn't shown, and can't be derived from rate
  history.** `SmartFlexChargingSession.cost`/`costOfCharge` both return
  null. Tested directly against a real bill: IOG retroactively applies an
  off-peak rate to dispatches outside the normal off-peak window, but that
  override never appears in standard rate history via REST, however long
  you wait for settlement. Re-investigated a second time via Kraken
  GraphQL's billing/ledger surface (`completedDispatches` returns empty
  for this account — a different smart-device program sharing the naming
  convention; `account.transactions` only has billed-period granularity,
  not per-dispatch) — both realistic avenues now genuinely exhausted.
  **An estimated cost is shown instead**: Smart sessions priced at today's
  known off-peak rate, Boost at today's known standard rate — reasonable
  since the tariff is fixed 12 months at a time, so a full historical-rate
  pipeline isn't worth the complexity for a difference that'd only matter
  right at a renewal boundary.
- **Session start SoC / SoC gained — built, then removed.** Originally
  shown as "95% → 100%" per session, inferring the session's start % from
  the *previous* session's end %. That assumption only holds if nothing
  touched the battery between sessions — it silently broke whenever the
  car was driven or charged elsewhere in between, producing readings like
  a 95%→84% "drop" for a session that actually added charge. Removed
  entirely rather than patched, since it was never a real measured value
  to begin with. Estimated miles added (computed client-side from kWh, not
  a real Octopus figure either) is labeled "(Est.)" for the same reason.
- **Estimated range added** uses a Settings-configurable mi/kWh figure per
  vehicle (falls back to a Polestar 2 Standard Range Single Motor spec:
  69kWh gross/67kWh usable, 322mi WLTP). WLTP is a lab figure, so
  real-world efficiency normally runs lower.
- **Octopoints history labels** are humanized from `reasonCode`
  client-side (e.g. `SAVING_SESSION_REWARD` → "Saving session reward"),
  not a hardcoded mapping — no enum list exists to confirm real values
  against.
- **Billing cycle assumes a calendar month**, since Octopus's API doesn't
  expose your actual billing/Direct Debit date. **Direct Debit amount** is
  estimated from your last actual payment, labeled "(est.)".
- **"Latest available day" instead of "Today"** — smart meter data
  typically lags a day via Octopus's REST API; the app shows whichever day
  actually has data, labeled with its real date.
- **Date-picker's standing charge is applied flat from today's cached
  value**, regardless of which historical date is picked — a deliberate
  scope-limiting choice (a full historical lookup would cost an extra API
  call per picked range for a figure that rarely differs by more than a
  few pence/day).
- **Date-picker's electricity history has a real floor — roughly two
  months back — that gas doesn't share.** Confirmed via testing: the REST
  call succeeds normally, it just comes back with zero readings that far
  back on this account. Nothing to fix — a real limit of the data source,
  not a bug.
- **Gas m³→kWh conversion** uses the standard industry ×1.02264 factor.
  **Calorific value is configurable** in Settings → Advanced (default
  40.0) — check your latest bill's usage breakdown if gas figures look
  off.
- **Predicted monthly cost** is a simple linear projection (today's
  average daily cost carried across the rest of the month) — won't
  anticipate seasonal changes.
- **Bill total chart can show fewer than 12 months** if any month has more
  than one bill (a mid-cycle tariff switch, for example) — 15 bills are
  fetched (not a flat 12) to buffer against a single switch.
- **Bill breakdown total** sums only charge-type transactions
  (electricity, gas) for that period — deliberately excludes Direct Debit
  payments and points-redeemed credits, matching the bill's own "Total
  charges for bill" figure.
- **Kraken GraphQL schema is unofficial** — EV dispatch field names are
  based on community reverse-engineering (the [Home Assistant Octopus
  Energy integration](https://github.com/BottlecapDave/HomeAssistant-OctopusEnergy)
  is the best reference), not published docs.
- **Bill transaction schema quirks worth remembering**: `account.
  transactions.edges.node` is a concrete `TransactionType`, not a
  union/interface, despite `__typename` reporting display values like
  `BillCharge`/`BillCredit` — the real inline-fragment target is `Charge`,
  not `BillCharge` (a different, unrelated type elsewhere). Amount fields
  on `TransactionAmountType` are `net`/`tax`/`gross`, not
  `netAmount`/etc. When extending this further, introspect first
  (`__type(name: "X") { fields { name } }`) rather than guessing — a wrong
  field guess fails the *entire* query it's part of.

If numbers look wrong, check **Settings → Show diagnostics panel** —
every sync logs reading counts, rate ranges, and totals.

## Considered and decided against

- **EV live card's This session/Power/Sessions today/Cost mini-boxes** —
  replaced (not just redesigned) with the single power meter described
  above. This session was permanently stuck at 0.0 kWh — it read from the
  in-progress session record, which only populates once that session
  *completes*, and sessions close at the scheduled target boundary rather
  than when charging actually stops, so a multi-day charge never caught
  up. Sessions today rarely told you anything useful, and Cost/estimated
  range both duplicated numbers already visible in the session list below.
  Several intermediate designs (a "Last session" box, SoC-gained/duration
  sub-text, a cost estimate box) were mocked up and discarded in favour of
  the meter once it became clear all of it was information findable
  elsewhere on the same panel.
- **EV Charge History Day view** — removed (see table row above); its
  hourly bucketing function bucketed a session at its own start hour and
  silently dropped it entirely if that start fell before the start of
  today, which is exactly what an overnight session does — not a
  cosmetic issue, a real case of the view actively hiding data rather
  than just being less detailed than Week/Month.
- **Session SoC start→finish % and gain** — see Approximations above; the
  underlying assumption (state carries continuously between sessions)
  doesn't hold once the car is driven or charged elsewhere, so it was
  removed rather than patched.
- **A SoC mini fill-bar** for session rows, replacing the (now-removed)
  text SoC — mocked up, declined in favor of the simpler text-only
  treatment the row settled on.
- **Octopus Saving Sessions** — the relevant GraphQL fields are deprecated
  on Octopus's side as of early 2026, no confirmed working replacement.
  (Octopoints is a distinct feature that *was* built and later archived
  for a different reason — see Billing row above.)
- **EV push notifications** — built, later deprecated: GitHub Actions cron
  wasn't firing reliably. Any future "notify me" feature needs a different
  scheduling approach.
- **Native app wrapper with Lock Screen/Watch widgets** — possible via
  Capacitor, but genuine widgets need a separate native Swift/WidgetKit
  codebase and a paid Apple Developer account. Not worth it vs. the PWA's
  current workflow.
- **EV Charge History Year view** — mocked up, dropped: EV charging
  doesn't have a real seasonal story the way heating does.
- **Splitting the EV panel** into live/history halves — considered early
  on, the panel is considered complete as one card.
- **A "Today" home-screen summary card, plus four analytics ideas** (EV
  annual stats, personal records, baseload, a replay-based tariff
  comparison) — all mocked up, all declined. The summary card duplicated
  what's already one tap away. The other four were pure text/number
  blocks with nothing visual, and every existing panel here pairs a
  number with something visual — the bar for revisiting any of them is a
  genuinely visual treatment, not a leaner text-only version. Feasibility
  notes if ever revisited: EV annual stats' data is confirmed clean
  (away-from-home charging never appears in `chargingSessions`); personal
  records needs a new daily-resolution year fetch and would be unreliable
  for electricity beyond the ~2-month floor; baseload needs to exclude any
  slot overlapping an EV charging session; tariff comparison has no
  existing plumbing for any tariff other than the account's own.
- **`current`/`reAuthenticationState`** (device status fields) — confirmed
  to exist via introspection but not useful (one-time onboarding
  milestone) or never resolved to a working value.

## Setup

1. Get your **API key**: Octopus dashboard → Personal details → API access.
2. Get your **account number**: it's on your dashboard, format `A-AAAA1111`.
3. Host the folder somewhere with HTTPS (see below).
4. Open the app, tap the ⚙ icon, enter your API key, account number, and —
   for EV dispatch data — your Octopus account **email and password** (this
   is separate from the API key because Intelligent Go data comes from the
   same API the Octopus app itself uses, which authenticates by login
   rather than API key).

Your credentials are stored only in the browser's `localStorage` on your
device — nothing is sent anywhere except directly to Octopus's own API.

## Hosting it

Currently hosted on **GitHub Pages** (free, no deploy-credit limits worth
worrying about for personal use). Push this folder to a repo (**public**,
so GitHub Actions minutes are unlimited if you set up notifications later),
enable Pages in repo settings (`main` branch, `/root`).

Other free options if needed: Netlify Drop, Vercel — but GitHub Pages is
what this project actually uses day to day.

## Installing on iPhone

1. Open your hosted URL in **Safari** (must be Safari, not Chrome).
2. Tap the **Share** icon → **Add to Home Screen**.
3. It'll appear as a normal app icon and open full-screen.

## Updating after a change

Versioning is MAJOR.MINOR. MINOR bumps (v2.1, v2.2...) cover regular fixes
and small-to-moderate additions; MAJOR only moves for something that feels
like a genuine new generation of the app.

The footer shows the app version — check it after a deploy to confirm the
new build actually landed. On every release, bump **four** things
together, all to the same number — including a release that only touches
HTML/CSS with no JS content changes at all, since GitHub Pages' CDN cache
is keyed on the URL including the query string, not on whether the JS
specifically changed.

1. `APP_VERSION` in `app.js`
2. `CACHE` in `sw.js`
3. The `?v=NN` query string on `styles.css` and `app.js` in **both**
   `index.html` (the `<link>`/`<script>` tags) and `sw.js` (the `SHELL`
   array) — these must match exactly, or the service worker will try to
   cache a URL that doesn't exist in the page and silently fail to update
   the shell.

**Why the query strings exist:** GitHub Pages sits behind a CDN with its
own cache timing that `updateViaCache: 'none'` can't override — that
setting only controls the *browser's* local cache, not GitHub's edge
cache. Bumping the query string on every release makes each version a
guaranteed cache miss everywhere, browser and CDN both.

This doesn't fully solve staleness for `index.html` itself, since the page
URL can't be query-string-versioned the same way — if the page itself
seems stale right after a deploy, that's GitHub's CDN propagation delay,
typically resolving within a few minutes on its own.

If a change still doesn't appear after confirming the version bump:

1. Wait a few minutes for GitHub's CDN to catch up, then reload.
2. On iPhone: fully close the app (swipe it away in the app switcher), or
   as a last resort go to **Settings → Safari → Advanced → Website Data**,
   find the site, and remove it — clears both the HTTP cache and the
   service worker registration.

## App icon

Custom PNG (`icon-192.png`, `icon-512.png`, `icon-maskable.png`), used for
both the installed home-screen icon and the in-app topbar mark. Swap those
three files for different artwork if you want, keeping the same sizes.
