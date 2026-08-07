# Kraken Watch — first build

A installable PWA dashboard for Octopus Energy: current rate + 24h curve, Intelligent
Octopus Go EV charging, and billing (with predicted monthly cost and account balance).

## What's live vs demo data right now

| Card | Status |
|---|---|
| Current rate + 24h curve | **Live** |
| Today's consumption (kWh) | **Live** |
| Account balance | **Live** |
| EV dispatch windows (planned/completed) | **Live**, via Kraken GraphQL |
| EV session/weekly kWh + cost | **Live** — derived from dispatch data, rate approximated (see note below) |
| Billing: yesterday/today, MTD, predicted month, 7-day bars — electricity | **Live** |
| Billing: yesterday/today, MTD, predicted month, 7-day bars — gas | **Live**, with a unit conversion approximation (see below) |
| Account balance projection | **Live** — derived from predicted cost, see approximation below |
| Last bill (issue date + PDF link) | **Live** — via Octopus's documented GraphQL `account.bills` field |

If a live call fails for any reason (wrong credentials, network, schema change), that
section falls back to demo data automatically rather than showing a broken page, and
the sync indicator top-right turns amber/red to tell you something didn't come through.

### Approximations worth knowing about

- **Billing cycle = calendar month.** Octopus's API doesn't expose your actual
  billing/direct-debit date, so "month to date" and "predicted this month" assume
  the 1st-to-end-of-month as the cycle. If your real billing day differs, the
  predicted total will be off — edit `daysElapsedInMonth`/`daysInMonth` in `app.js`
  if you want to hardcode your actual cycle start day instead.
- **"Today" / "Yesterday" can show "No data yet."** Octopus's smart meter
  consumption data typically lags 24-48h behind real time, so very recent days
  often have no readings available yet even though month-to-date figures (which
  include older, already-synced days) look normal. This is expected, not a bug —
  the app now distinguishes "genuinely used £0.00" from "no readings yet" rather
  than showing a bare £0.00 that looks broken.
- **Electricity costs were being badly underestimated for multi-rate tariffs**
  (like Intelligent Go) until this fix — a rate-lookup bug silently defaulted
  any reading that didn't hit an exact boundary match to the *cheapest* rate in
  the whole date range, mispricing standard-rate daytime usage as off-peak.
  Caught by comparing month-to-date figures against the real Octopus app (£2.95
  shown here vs £15.02 actual — a ~5x gap, consistent with under-pricing most
  daytime usage at the ~7.5p off-peak rate instead of ~32p standard). Gas looked
  fine throughout because Flexible Octopus only has one rate all day, so the
  bug's fallback happened to still be correct there. Fixed by matching each
  reading to the most recent rate period that started at or before it, rather
  than requiring an exact `to` boundary. If costs still look off after this,
  the app now logs "N reading(s) had no matching rate period" in the
  diagnostics panel — worth checking that count if numbers seem wrong again.
- **Electricity showing near-£0 usage cost turned out to be a meter-selection
  bug, not a rates bug.** Debug instrumentation revealed the electricity
  consumption endpoint was returning zero readings entirely — the £2.95/£18.31
  figures seen while debugging the rate-matching issue above were pure
  standing charge (£0.59/day × 5 days), with no usage cost included at all.
  Root cause: accounts can have more than one electricity/gas meter point on
  record (e.g. after a smart meter exchange), and auto-detection was blindly
  taking the first one it found — which can be an old, decommissioned meter
  with no data, even though its tariff/agreement info still resolves fine
  (agreements live on the meter point, so a stale one can still show a
  valid-looking current tariff). Fixed by preferring the meter point with an
  active agreement and the most recently listed meter within it, plus added a
  manual override in Settings (⚙ → "Advanced: set meter details manually") to
  paste in the correct MPAN/MPRN and serial directly if auto-detection ever
  gets it wrong again. **If you already had credentials saved before this
  update, reopen Settings and tap "Save & connect" once more (no changes
  needed) to re-run detection with the fixed logic.**
- **Diagnostics panel now always shows debug info, not just errors.** Every
  sync logs a line like "Electricity MTD: 91 reading(s), 8 rate period(s)
  (7.50p–32.02p), 12.40 kWh total" — check this first if numbers look wrong
  again, since it shows reading counts, rate ranges, and totals directly
  rather than requiring another guess-and-redeploy round.
- **Predicted cost is a simple linear projection** — today's average daily cost
  carried across the rest of the month. It won't anticipate things like gas usage
  rising as winter sets in.
- **Gas consumption unit conversion.** Smart gas meters usually report in m³, not
  kWh, and converting needs the calorific value for your specific supply. The app
  uses the standard industry approximation (×1.02264 correction factor, calorific
  value 39.5) — close, but your actual bill may use a slightly different calorific
  value for your region/day.
- **EV dispatch rate.** Dispatches report kWh added but not the exact rate that was
  live at that moment, so the app applies today's cheapest electricity rate as a
  stand-in (IOG dispatches always land in the off-peak window, so this is usually
  accurate, but not exact if the off-peak rate changed between dispatches).
- **Last bill amount isn't shown**, only the issue date and a PDF link — the
  documented `BillInterface` GraphQL fields (`id`, `billType`, `fromDate`, `toDate`,
  `issuedDate`, `temporaryUrl`) don't include a billed amount directly. If you dig
  into `docs.octopus.energy/graphql` and find the right sub-type/fragment for the
  actual total, that'd be a good next addition.


## Setup

1. Get your **API key**: Octopus dashboard → Personal details → API access.
2. Get your **account number**: it's on your dashboard, format `A-AAAA1111`.
3. Host the folder somewhere with HTTPS (see below) or open `index.html` directly for
   a quick local test (some features need HTTPS to work as a proper installed PWA).
4. Open the app, tap the ⚙ icon, enter your API key, account number, and — for EV
   dispatch data — your Octopus account **email and password** (this is separate from
   the API key because Intelligent Go data comes from the same API the Octopus app
   itself uses, which authenticates by login rather than API key).

Your credentials are stored only in the browser's `localStorage` on your device —
nothing is sent anywhere except directly to Octopus's own API.

## Hosting it (needed for a proper install on iPhone)

Easiest free options, in order of simplicity:

- **Netlify Drop** — go to [app.netlify.com/drop](https://app.netlify.com/drop) and
  drag this whole folder in. Gives you a live HTTPS URL in seconds.
- **GitHub Pages** — push this folder to a repo, enable Pages in repo settings.
- **Vercel** — `vercel deploy` from this folder if you have the CLI.

## Installing on iPhone

1. Open your hosted URL in **Safari** (must be Safari, not Chrome).
2. Tap the **Share** icon → **Add to Home Screen**.
3. It'll appear as a normal app icon and open full-screen.

## If updates don't seem to show up after redeploying

The footer now shows the app version (e.g. "v32") — check it after a deploy
to confirm the new build actually landed, without needing to inspect `sw.js`
directly. Bump `APP_VERSION` in `app.js` and `CACHE` in `sw.js` together on
every release; they're meant to stay numerically in sync.


Two layers can cache the app: your host's CDN, and the service worker itself.
This project now sets `updateViaCache: 'none'` on registration and ships a
Netlify `_headers` file marking `sw.js`/`index.html` as never-cache, which
should make redeploys show up automatically going forward. If a change still
doesn't appear:

1. Bump the `CACHE` constant at the top of `sw.js` (e.g. `v9` → `v10`) —
   this forces a new cache and drops the old one on activate.
2. On iPhone: fully close the app (swipe it away in the app switcher), or as a
   last resort go to **Settings → Safari → Advanced → Website Data**, find the
   site, and remove it — that clears both the HTTP cache and the service
   worker registration, forcing a completely fresh install.

## EV push notifications (optional)

Silent push notifications when EV charging starts or finishes. This is a
genuinely new subsystem — a GitHub Actions workflow checks EV status every 5
minutes and pushes a notification on real transitions (idle/scheduled →
charging, and charging → not charging). It does **not** notify on idle →
scheduled, since that's already passively visible in the app.

**Important: this can't be tested end-to-end before you set it up.** GitHub
Actions execution and actual push delivery to your phone can only be
verified once it's live — expect to debug it the same way the rest of this
app got built, not assume it works perfectly first try.

### 1. Add the GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.
Add all of these:

| Secret name | Value |
|---|---|
| `OCTOPUS_ACCOUNT_NUMBER` | Your account number, e.g. `A-AAAA1111` |
| `KRAKEN_EMAIL` | Your Octopus account login email |
| `KRAKEN_PASSWORD` | Your Octopus account login password |
| `VAPID_PUBLIC_KEY` | `BIq7brwFs3Q_UHtekH2z3dX7zkd40WyOLarOvSoMSOF0N06xtDQcx6qBIQHShuBKHvwoq6irApOWhLyoozYk7U4` |
| `VAPID_PRIVATE_KEY` | `sNaKhNNE77zc07nkJ1srm70QtZs687GKWvz0tMaL-WI` |
| `PUSH_SUBSCRIPTION` | Added in step 2 below — leave this until then |

The VAPID keys above are a real key pair generated specifically for this
deployment (using Node's built-in crypto, not a placeholder). The public
half is also embedded in `app.js` (`VAPID_PUBLIC_KEY`) — that's expected,
public keys are meant to be public. The private key should only ever live
in this GitHub secret, never committed to the repo itself.

### 2. Subscribe from the app

Open the app → ⚙ Settings → scroll to **EV notifications** → tap
**"Enable EV notifications"**. This asks for notification permission, then
shows a block of JSON. Copy that whole block and paste it as the
`PUSH_SUBSCRIPTION` secret from step 1.

Must be done from the installed Home Screen app, not a Safari tab — iOS only
allows push subscriptions for installed PWAs.

### 3. Test it

Repo → **Actions** tab → **EV dispatch check** workflow → **Run workflow**
(the `workflow_dispatch` trigger exists specifically for this manual test,
separate from the 5-minute schedule). Check the run's logs — it'll say
either "Push sent," "No notification-worthy transition," or a specific
error. The Settings panel in the app also shows the last checker run and
last push status, pulled from `state/ev-status.json`.

### How it works

- `.github/workflows/ev-notify.yml` — the schedule (`*/5 * * * *`, best-effort
  timing, not exact)
- `scripts/ev-check.mjs` — logs into Kraken, checks dispatch status, compares
  against `state/ev-status.json`, sends a push on a real transition, commits
  the new state back to the repo
- Every run commits a state update, which — as a side effect — also keeps
  the repo "active," preventing GitHub's automatic disabling of scheduled
  workflows after 60 days of inactivity
- `sw.js` has `push` and `notificationclick` handlers; notifications are
  always sent with `silent: true`

### Known rough edges

- **State commits trigger a Pages rebuild every ~5 minutes.** Harmless and
  unmetered on GitHub Pages, but your repo's commit history and Pages
  deployment log will be noisy. A cleaner v2 would commit state to a
  separate branch that doesn't trigger Pages deploys — not done here to
  keep the first version simpler.
- **iOS push subscriptions can silently expire** (documented WebKit
  behavior, not something fixable in this code) — if notifications go quiet
  for suspiciously long, check Settings for "Subscription expired" and
  re-enable.
- **The `web-push` npm package version is pinned loosely** (`^3.6.7`) —
  if the Action starts failing at the `npm install` step after not running
  for a while, check whether a newer major version changed its API.

## Known limitations / next steps

- **Direct Debit amount is now estimated from your last actual payment**
  when no future-dated payment record exists yet (the usual case — Octopus
  doesn't seem to materialize the next payment until close to the
  collection date). Labeled "Direct Debit (est.)" with "Est. from last
  payment (date)" instead of "Next Direct Debit"/"Due (date)" so it's
  honest about being an assumption, not a confirmed fact. Reasonable since
  UK energy Direct Debits are periodically reviewed but typically stay
  fixed for months — but if Octopus revises your DD amount, this will be
  stale until the next real payment happens and updates it.

- **Demo data is now opt-in, off by default.** Settings → "Show demo data
  when something fails to load" (unchecked by default). When off, any
  section that fails to load shows "Unavailable"/"—" instead of a fake
  number — no demo data appears anywhere unless you explicitly turn it on.
  This applies to rates, EV, and all of billing; Live Usage and Consumption
  never showed demo data in the first place.

- **"Yesterday"/"Today" replaced with "latest available day"** — both
  electricity and gas smart meter data typically lag into the following
  day (sometimes further) via Octopus's REST consumption API; this isn't
  gas-specific, electricity has the same lag, confirmed via multiple
  independent sources. Rather than show a permanently-empty "Today" field,
  the app now scans backward through the week's data for the most recent
  day that actually has readings, and labels it with its real date.
- **Direct Debit lookup was relaxed.** Originally required `status ===
  'SCHEDULED'` on the next payment, which found nothing for some accounts —
  likely because Octopus doesn't create the individual payment record
  until closer to the collection date. Now just takes the nearest
  future-dated payment regardless of status, with the raw fetch results
  logged to diagnostics so a future "still not found" case is debuggable
  rather than another guess. Octopus's own docs confirm the field names
  used (`amount`, `paymentDate`, `status`) are correct; if this still
  doesn't surface your Direct Debit amount, the figure you see in the
  official app may come from a different field (`paymentSchedules`, which
  exists but whose exact shape isn't confirmed here) rather than individual
  payment records.
- **Current Rate and Live Usage lost their charts** in favor of compact,
  half-width cards side by side — the 24h rate curve and the live Wh bar
  chart both got cut after testing showed they added more visual noise than
  insight (the curve's info is fully covered by the "Next change" text; the
  live chart's per-10-second Wh deltas were too small/noisy to read well
  even after the unit fix). Live Usage gained a "≈ £X.XX/hr at this rate"
  line instead — an extrapolation ("if this draw continued for a full
  hour"), not a prediction of actual spend, meant to make raw watts feel
  more concrete.

- **Live usage needs an Octopus Home Mini (or similar registered smart
  device).** Uses `smartMeterTelemetry`, confirmed via a real working example
  (not just docs) at 10-second resolution. If your account has no registered
  telemetry device, the card says so plainly rather than faking a live
  number — this is genuinely not available for every account, unlike
  everything else in the app.
- **Wh conversion was wrong, now fixed.** Originally assumed `consumptionDelta`
  was in kWh (matching Octopus's REST convention elsewhere) and multiplied by
  1000. That was backwards — confirmed by the chart showing a 1000Wh scale
  with barely-visible bars for a ~57W reading, which is only ~0.16Wh over a
  10-second bucket. `consumptionDelta` appears to already be in Wh, so the
  app now uses it raw. Still worth spot-checking against the official app
  occasionally — the diagnostics panel logs the raw value for exactly that.
- **Polls every 30 seconds** independently of the main 5-minute sync, since
  "live" implies fresher data than the rest of the app needs.


- **Electricity/gas charts are now stacked** by standing charge, off-peak, and
  peak (electricity) or standing charge + usage (gas) — off-peak vs peak is
  worked out using the same "near the day's cheapest rate" threshold the rate
  curve uses. Standing charge is a flat daily estimate (from the last fetched
  rate), so it stays constant across days rather than being read fresh per
  day — a reasonable simplification since standing charges rarely change
  mid-cycle.

- **Projected end-of-month balance formula was wrong** until this fix — it
  subtracted only the not-yet-incurred remainder of the predicted cost
  (predicted total minus what's already been spent this month), on the
  assumption that this month's usage-to-date had already been deducted from
  the balance. That's not how Direct Debit billing works: Octopus deducts a
  cycle's cost in one lump sum when the next statement is issued, not
  continuously. Fixed to subtract the *full* predicted month cost from the
  current balance instead.

- **"Projected balance, after next Direct Debit"** uses Octopus's documented
  `account.payments` field, filtered to the nearest future-dated payment with
  status `SCHEDULED` — a real scheduled amount from your account, not an
  estimate. If there's no upcoming Direct Debit on file, that row hides itself.
- **Week/Month toggle** on the Consumption panels fetches daily figures one day
  at a time for the elapsed days in the month — fine for now, but on a
  month with lots of elapsed days this means more API calls than the week
  view; a future version could batch this into a single range request instead.

- **Kraken GraphQL schema is unofficial.** The EV dispatch query field names
  (`plannedDispatches`, `completedDispatches`, etc.) are based on community
  reverse-engineering (the [Home Assistant Octopus Energy integration](https://github.com/BottlecapDave/HomeAssistant-OctopusEnergy)
  is the best reference) rather than published docs, since Octopus doesn't officially
  document this API. If it doesn't return data, check that project's source for the
  current schema and adjust the query in `app.js` → `loadEV()`.
- **Battery %** isn't available from Octopus's API at all — that comes from your
  vehicle or charger's own integration (e.g. if you also have a car API or a
  smart-charger API), not Octopus.
- **Account balance** now uses the documented GraphQL `account.balance` field
  (confirmed against `docs.octopus.energy`) with `includeAllLedgers: true`, which
  Octopus's own docs recommend for accuracy — earlier builds guessed at a REST field.
- **Battery %, live charge rate, and smart-charging on/off** are shown as `—` rather
  than a number — Octopus's dispatch query genuinely doesn't expose vehicle/charger
  state, only dispatch windows (start/end/kWh). Earlier builds left old demo numbers
  (68%, 7.4kW, "On") sitting next to real data once dispatches loaded successfully,
  which looked live but wasn't — now anything not actually returned by the API
  shows as unavailable instead of a fake number.
- See the approximations list above for the billing-cycle, gas-conversion and
  EV-rate assumptions baked into the cost calculations — worth revisiting once you
  can compare a real bill against what the app predicts.
- App icon is a custom PNG (`icon-*.png`) — swap those files for different artwork if you want, keeping the same three sizes (192, 512, 512-maskable).
