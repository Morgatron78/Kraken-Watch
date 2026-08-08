# Kraken Watch

A personal installable PWA dashboard for Octopus Energy — current rate, live
usage, Intelligent Octopus Go EV charging, consumption, and billing, all on
one screen, with your own API credentials stored only on your device.

## Current status

| Panel | What it shows | Status |
|---|---|---|
| Current rate | Now/standard/off-peak rates, next change | **Live** |
| Live usage | Current draw (W), £/hr estimate, color-coded by level | **Live** — needs an Octopus Home Mini (or similar registered device); shows a plain "not available" message if you don't have one |
| EV charging | Dispatch windows, session kWh/cost, this week — auto-collapses when idle with nothing scheduled. Dispatch windows and week chart sit in their own pink sub-panel (electricity's color); the active "Dispatching now" slot and header status badge both go pink while charging | **Live**, via Kraken GraphQL |
| Consumption (electricity + gas) | Day (electricity-only, half-hourly)/Week/Month/Year views, tap any bar for that period's full breakdown | **Live** |
| Billing | Account balance and projected balance as two neutral side-by-side boxes with a CREDIT/DEBIT pill; account number shown as a header pill. Direct Debit (estimated) and Spend this month/Predicted as two side-by-side columns. Bill history: last 12 bills, most recent always expanded with its breakdown collapsible, older 11 behind a toggle and always shown expanded — each row shows billing period, real total (matching the bill's own "Total charges for bill"), itemized per-fuel charges with kWh and that fuel's own sub-period, and a link to the actual bill. Below that, a bill-total-over-time chart: rolling window of the same 12 bills, stacked gas (blue)/electricity (pink) per bill, with a trend pill comparing the latest bill to the average over that period | **Live** |
| Insights | Collapsed by default. Per-fuel trend vs. 7-day average, rate/charge splits, weekday/weekend pattern, best/worst day, monthly trajectory, seasonal gas narrative, balance runway projection, annual standing charge total | **Live**, lazy-loads a month of data on first expand |

If a live call fails, that section shows "Unavailable" rather than a fake
number. Demo data is available for testing but is **off by default** —
turn it on in Settings ("Show demo data when something fails to load") if
you want to see placeholder values instead.

## Color language

Each color means one specific thing, consistently, everywhere it appears —
this took several rounds of back-and-forth to land, so worth preserving
rather than re-litigating from scratch:

- **Pink** — electricity's identity. Panel border, current-rate figure and
  badge, predicted month/year, peak-rate chart segments (day/week/hourly),
  the EV sub-panel border, active dispatch slot/badge.
- **Blue** — gas's identity, the same way pink is electricity's. Panel
  border, predicted figures, usage chart segments, Year view totals.
- **Mint** — "this is the cheaper one," never fuel-specific. Off-peak rate,
  CREDIT balance status, cheapest-day extremes, the weekday side of
  weekday/weekend.
- **Coral** — genuine financial warnings only: DEBIT balance, a declining
  balance runway, sync errors. Deliberately *not* reused for "priciest
  day"/weekend-costs-more (see amber) or peak rate (see pink), even though
  early attempts tried both — keeping it scoped to "something's wrong"
  avoids diluting that meaning.
- **Amber** — "this is the more expensive one," fuel-agnostic, parallel to
  mint's "cheaper" role: the Priciest tag in extremes cards, the weekend
  side of weekday/weekend. Also independently used for "pending/caution"
  states elsewhere (EV's "planned" tag and scheduled slots, the live-usage
  medium-draw tier, the "stale" sync dot) — these aren't the same concept,
  but don't currently clash.
- **Violet** — general UI chrome only (buttons, focus rings, the generic
  progress bar), no longer used for anything fuel- or rate-specific.
  Retired from that role deliberately, since it used to mean both
  "electricity" and "peak rate" at once and never quite signaled either
  reliably.

One recurring bug worth remembering if extending any "vs average"
indicator: the color needs to follow whether the direction is *good or bad
news*, not the raw arithmetic sign. Spending above average is bad (coral),
spending below is good (mint) — the opposite of the balance-trend pill
nearby, where "up" genuinely is good (balance growing). Two separate
instances of this exact bug shipped and were caught by the user, not code
review — worth double-checking by hand whenever a new comparison like this
gets added.

## Performance

Automatic background refresh runs in two tiers, not one flat interval:

- **Fast tier** (rates + EV status, ~2 requests): every 5 minutes.
- **Slow tier** (billing — week/month consumption bars, MTD, bill history,
  itemized breakdown, the bill-total chart; ~25+ requests): every 30
  minutes.
- **Live usage**: its own 30-second poll, independent of both tiers.

The billing bundle alone fires ~25 requests per run; running that as often
as the cheap stuff was very likely tripping Octopus's rate limits
intermittently, showing up as real, available data occasionally flashing
"Unavailable" for no visible reason. Manual refresh (🔄) and the initial
app load still trigger everything at once regardless of tier timing.

`rateCache` is wiped once a day (checked from the fast tier) rather than
left to grow — otherwise a long-running session would accumulate a new set
of entries every calendar day indefinitely.

## Approximations worth knowing about

- **Billing cycle assumes a calendar month** (1st to end-of-month), since
  Octopus's API doesn't expose your actual billing/Direct Debit date.
- **Direct Debit amount is estimated from your last actual payment**, since
  Octopus doesn't appear to create the next payment's record until close to
  the collection date. Labeled "Direct Debit (est.)" so it's clear it's an
  assumption, not a confirmed upcoming transaction — reasonable since UK
  energy Direct Debits are periodically reviewed but typically stay fixed
  for months.
- **"Latest available day" instead of "Today"** — both electricity and gas
  smart meter data typically lag into the following day via Octopus's REST
  API, so there's rarely a same-day figure to show. The app shows whichever
  day actually has data, labeled with its real date.
- **Gas m³→kWh conversion** uses the standard industry approximation
  (×1.02264 correction factor). **Calorific value is configurable** in
  Settings → Advanced (defaults to 40.0) — Octopus's own calorific value
  drifts slightly over time, so if your gas figures look a little off,
  check your latest bill's usage breakdown for the exact value it used and
  enter that.
- **EV dispatch rate** is approximated as today's cheapest electricity rate,
  since dispatches report kWh added but not the exact rate live at that
  moment. Usually accurate since IOG dispatches land in the off-peak window.
- **Predicted monthly cost** is a simple linear projection (today's average
  daily cost carried across the rest of the month) — won't anticipate
  seasonal changes in usage.
- **Standing charge in the consumption charts** is a flat daily estimate
  from the last fetched rate, not re-checked per day.
- **Bill breakdown total** is computed by summing only the charge-type
  transactions (electricity, gas) for that billing period — it deliberately
  excludes Direct Debit payments and Octoplus points-redeemed credits,
  which are account balance movements rather than part of what the bill
  itself charged. This matches the bill's own "Total charges for bill"
  figure exactly, rather than a net cash-movement number.
- **Per-item kWh/date-range formatting doesn't assume a specific unit
  enum** — it displays whatever unit string Octopus's API actually returns
  (mapped to a friendly label like "kWh" where recognised, falls back to a
  readable version of the raw value otherwise), so it keeps working even if
  that enum value turns out to differ from what was confirmed during
  development.
- **Kraken GraphQL schema is unofficial.** EV dispatch field names are based
  on community reverse-engineering (the
  [Home Assistant Octopus Energy integration](https://github.com/BottlecapDave/HomeAssistant-OctopusEnergy)
  is the best reference), not published docs, since Octopus doesn't
  officially document this API.
- **Bill transaction schema quirks worth remembering**, found the hard way
  while building the bill breakdown: `account.transactions.edges.node` is a
  concrete `TransactionType`, not a union/interface — despite `__typename`
  reporting values like `BillCharge`/`BillCredit` for display purposes,
  those aren't valid inline-fragment targets on it. The per-fuel
  `consumption` field needs `... on Charge { consumption { ... } }`
  specifically — `Charge`, not `BillCharge`, which is a different,
  unrelated type elsewhere in the schema. Amount fields on
  `TransactionAmountType` are named `net`/`tax`/`gross`, not
  `netAmount`/`taxAmount`/`grossAmount` like similar-looking types
  elsewhere. When extending this further, introspect first
  (`__type(name: "X") { fields { name } }`, logged via `logDebug` behind a
  temporary diagnostic call) rather than guessing field names — a wrong
  guess fails the *entire* query it's part of, not just that field, and
  GraphQL error messages here are often specific enough to name the actual
  fix directly.
- **Battery %, live charge rate, and smart-charging on/off aren't shown** —
  Octopus's dispatch data genuinely doesn't expose vehicle/charger state,
  only dispatch windows (start/end/kWh).

If numbers look wrong, check **Settings → Show diagnostics panel** — every
sync logs reading counts, rate ranges, and totals, which is usually enough
to spot the actual cause rather than guessing.

## Considered and decided against

- **Octopus Saving Sessions / Octoplus points** — the relevant GraphQL
  fields (`savingSessions`, `joinSavingSessionsCampaign`) are deprecated on
  Octopus's side as of early 2026, with no confirmed working replacement.
  Not built.
- **Polestar/Smartcar integration** (state of charge, charging status in the
  EV panel) — researched thoroughly (real signal names, ~$3/month Smartcar
  plan, webhook-based to avoid 12V battery drain risk) and technically
  viable, but parked since the user can already see this via existing phone
  widgets. Revisit if wanted later — the groundwork is already scoped.
- **Native app wrapper with Lock Screen/Watch widgets** — technically
  possible via Capacitor, but genuine widgets need a separate native
  Swift/WidgetKit codebase and a paid ($99/year) Apple Developer account for
  the required App Group entitlement. Decided the cost/complexity wasn't
  worth it versus the PWA's current workflow.

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

Versioning switched to MAJOR.MINOR at v1.0 (previously a flat incrementing
number). MINOR bumps (v1.1, v1.2...) cover regular fixes and small-to-moderate
additions; MAJOR only moves (v2.0) for something that feels like a genuine
new generation of the app — a big new capability, or a real architecture
shift.

The footer shows the app version (e.g. "v1.2") — check it after a deploy to
confirm the new build actually landed. On every release, bump **four**
things together, all to the same number:

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
cache. Without a version-tagged URL, a new service worker could install
successfully but still pull `styles.css`/`app.js` from a stale CDN edge
cache using the old URL, baking outdated code into an otherwise "fresh"
install. Bumping the query string on every release makes each version a
guaranteed cache miss everywhere, browser and CDN both.

This doesn't fully solve staleness for `index.html` itself, since the page
URL can't be query-string-versioned the same way (it's what people
actually navigate to) — if the page itself seems stale right after a
deploy, that's GitHub's CDN propagation delay, typically resolving within
a few minutes on its own.

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
