# Kraken Watch

A personal installable PWA dashboard for Octopus Energy — current rate, live
usage, Intelligent Octopus Go EV charging, consumption, and billing, all on
one screen, with your own API credentials stored only on your device.

## Current status

| Panel | What it shows | Status |
|---|---|---|
| Current rate | Now/standard/off-peak rates, next change | **Live** |
| Live usage | Current draw (W), £/hr estimate, color-coded by level. A "Last 30 min" toggle expands a pink Wh bar chart below the half-row — lazy-loaded only on expand, refreshes every 30s while open, stops the moment it's closed. Uses `smartMeterTelemetry` at `TEN_SECONDS` grouping, bucketed into 1-minute bars client-side (goes through Kraken GraphQL, so it never counts against the REST-call diagnostic) | **Live** — needs an Octopus Home Mini (or similar registered device); shows a plain "not available" message if you don't have one |
| EV charging | Built on Octopus's SmartFlex API (`devices` → `SmartFlexVehicle` → `chargingSessions`). Live battery gauge with target-SoC/countdown below it, a striped "restricted zone" marker beyond `stateOfChargeLimit.upperSocLimit`, and estimated range added (`EV_RANGE_MI_PER_KWH`, a single named constant — currently set for a Polestar 2 Standard Range Single Motor's 2024+ spec; update if the vehicle on the account ever changes). A weekly schedule strip highlights whichever target is still upcoming (today's if not yet passed, otherwise tomorrow's) rather than blindly "today". A single consolidated warnings area covers `isSuspended`, `testDispatchFailureReason` (excluding its `NONE` sentinel), `currentState` (LOST_CONNECTION/SMART_CONTROL_OFF/SMART_CONTROL_NOT_AVAILABLE — the last one suppressed while genuinely Idle, since it fires on simple disconnection and isn't a fault — other `currentState` values are one-time onboarding milestones, not shown), `stateOfChargeLimit.isLimitViolated`, device `alerts`, and a lightweight "Boost session this week" flag (type-based, not time-window-based — Boost is a manual charge outside the smart dispatch schedule, a reliable signal without needing rate-matching). Battery meter/schedule/warnings sit in a shared `#ev-stack` flex container using `gap` for spacing between them rather than individual margins — a hidden child contributes zero gap automatically, so collapsing/expanding the card never needs a margin override or transition to look clean. Two subpanels: **Charging Activity** (Windows/Sessions toggle — 30-min dispatch windows or whole-session view, both derived from one query, SMART=mint/BOOST=pink badges, active dispatch shown with a pulsating dot matching Live Usage's; the selected tab is tracked in a variable and reapplied after every render, since the render function itself needs to temporarily un-hide the Dispatch panel to rebuild it) and **Charge History**, a genuine consumption-style chart matching the exact pattern elec/gas Usage already uses — Day/Week/Month toggle (Year deliberately not built: EV charging doesn't have a real seasonal story the way heating does), real kWh scale, tap-to-breakdown, the Smart/Boost split merged directly into the chart legend labels ("Smart · 92%" / "Boost · 8%", v2.161 — previously a separate caption line above the chart, removed once the legend could show the same information without a second element). Day falls back to bucketing a session at its own start hour when it has no nested dispatch records (Boost-type charges don't generate them the way Smart/scheduled ones do — the earlier version relied on dispatches alone and silently showed nothing for a Boost-only day). Month uses its own wider-range query, deliberately dropping the `dispatches` sub-field for a lighter payload, with a real `pageInfo.hasNextPage` check that surfaces an honest "partial data" note. Estimated cost (third mini box, hidden until today's rates have loaded) prices Smart sessions at today's known off-peak rate and Boost at today's standard rate — a type-based assumption, not real rate-matching, which was investigated separately and confirmed a dead end (see Approximations below); a shown £0.00 or omitted figure would misleadingly read as free rather than an estimate. No fallback to the old dispatch-only path on failure — shows a genuine Unavailable state instead, recovering on the next auto-sync. **Open risk if the account ever switches to charger-based smart charging** (e.g. an Ohme charger integrated with Octopus instead of the car): this whole panel is built against Octopus's `SmartFlexVehicle` device type via an inline GraphQL fragment — if charger-integrated charging shows up as a different device type, that fragment won't match and the panel will likely fall into Unavailable until the queries are rebuilt against whatever the real device shape turns out to be, discovered via live introspection the same way everything else in this schema was | **Live**, via Kraken GraphQL |
| Usage (electricity + gas) | Day (electricity-only, half-hourly)/Week/Month/Year views, tap any bar for that period's full breakdown — for electricity, the Week/Month breakdown box also shows that day's own half-hourly bar chart (mint/pink, matching the Day view's own colors, no legend needed since the card already has one), with a y-axis scale that switches between £ and kWh together with the rest of the box. Zero extra fetch — the same wide-range call that builds the Week/Month totals already pulls every half-hourly reading, this just keeps them instead of discarding them after summing. Gas doesn't get this, since gas readings settle once per day with no intra-day shape to show. **Date picker** (v2.139–v2.152): a calendar icon next to the Day/Week/Month/Year toggle (hidden in Year, which has no single date to anchor to) opens a compact month grid — picking a day snaps Week to the Sun–Sat week around it, Month to that day's whole month, or Day to that exact date, with a small pill showing the current pick and a one-tap way back to today. Both fuels move together, since it's one shared toggle above both panels. Three separate bugs shipped and were fixed across v2.143/v2.144/v2.152, all the same root cause in different code paths — see the date-picker section below for the full story | **Live** |
| Billing | Account balance and projected balance as two neutral side-by-side boxes with a CREDIT/DEBIT pill; account number shown as a header pill. Direct Debit (estimated) and Spend this month/Predicted as two side-by-side columns. Bill history: fetches the last 15 bills (see below for why), most recent always expanded with its breakdown collapsible, the rest behind a toggle and always shown expanded — each row shows billing period, real total (matching the bill's own "Total charges for bill"), itemized per-fuel charges with kWh and that fuel's own sub-period, and a link to the actual bill. Below that, a bill-total-over-time chart grouped by calendar month (not one bar per bill — see below), stacked gas (blue)/electricity (pink), capped to the most recent 12 distinct months. **Octopoints — archived, deactivated as of v2.150** (built v2.147, redesigned v2.148): live device testing returned an Unauthorized error, most likely an account permissions gap rather than a code bug. Deactivated to stop spending API calls on it; the full implementation is preserved in `octopoints-archive.js` and can be reinstated if the permissions question gets resolved | **Live** |
| Insights | Collapsed by default. Per-fuel trend vs. 7-day average, rate/charge splits, weekday/weekend pattern, best/worst day, monthly trajectory, seasonal gas narrative, annual standing charge total, a standalone **EV Charging** panel (charging streak dots, busiest day highlight — placed right after Gas, ahead of Balance runway/Standing charges, since EV data is more dynamic week-to-week), and a 12-month season-aware balance runway forecast (see below) | **Live**, lazy-loads a month of data on first expand |

**Balance runway forecast**, in more detail: for each of the next 12 payment
cycles, prices *last year's same calendar month's real kWh* (from the same
bill-history data already fetched for the bill-total chart, no extra API
calls) at *today's* blended rate, plus today's standing charge × the exact
number of days in that month. Falls back to a flat repeat of this month's
own predicted cost only when no matching month exists in the bill history
(new account, or a bill-bunching gap from a tariff switch). Chart bars show
the real cumulative trajectory (mint = projected credit, coral = projected
debit) rather than each cycle's raw composition — tap a bar to see that
cycle's payment/electricity/gas breakdown and which real month it's priced
from. Two things stay fixed at today's value throughout, since neither is
knowable this far out: the unit rate (variable tariffs will likely differ
by the time a given month arrives) and the Direct Debit amount (Octopus
reviews and can change it).

If a live call fails, that section shows "Unavailable" rather than a fake
number. Demo data is available for testing but is **off by default** —
turn it on in Settings ("Show demo data when something fails to load") if
you want to see placeholder values instead.

**Balance runway breakdown — history worth knowing (v2.150/v2.166).**
Originally auto-selected and opened the breakdown box for the
lowest-balance month whenever nothing had been tapped yet, so "lowest
point" was visible without a tap — confirmed with the user as intended
after it was first reported as a bug. Later reconsidered: once the
breakdown became a richer ledger (below), auto-opening one felt like more
content appearing than was asked for, so v2.166 removed it —
`selectedForecastCycle` now stays `null` until an actual tap, purely
show/hide with no other behavior change. The breakdown itself was also
restructured as a proper ledger (v2.166): balance carried forward →
Electricity/Gas costs → energy subtotal → Payment → Projected balance,
reusing Billing's own `.bh-item` styling (same coral-charge/mint-credit
convention) rather than the original flat 3-line list, so the final
balance reads as something derived rather than just stated. A genuinely
separate issue from either of these — accidental taps firing during a
mobile scroll gesture on the same chart — was real and is fixed via
`touch-action:pan-y` on the bar elements.

**The picked-week date bug family (v2.143/v2.144/v2.152).** Three separate
pieces of code, in three separate releases, each independently assumed
the day you tapped in the date picker was the *last* day of the resulting
week — when a picked week is actually always fetched as a fixed
Sunday-to-Saturday span regardless of which day was tapped. First the
fetch itself used the wrong anchor (wrong week's data shown); then the
breakdown-box date label used the same wrong assumption (right week,
wrong real-world date on tap); then the chart's own axis labels did too
(right breakdown date, wrong day-letter above the bar). Each was confirmed
and fixed independently as it surfaced. Worth checking this same
assumption first if anything in the picked-week path ever looks subtly
off again — it's a pattern that's bitten this codebase three times.

**Electricity history floor**: going back further than roughly 2 months
returns genuinely empty data for electricity specifically — see
Approximations below for the full detail, including the honest in-app
warning that surfaces this case.

**The Current rate/Live usage spacing saga (v2.162–v2.165), a real CSS
lesson worth keeping.** Current rate's three lines (Standard/Off-peak/
Next) are one text block joined by `<br>`, using `.meta`'s
`line-height:1.7` — the gap between its lines comes *entirely* from that
leading, with zero margin involved. Live usage's equivalent lines
(`.sub`) are separate block elements, and the first two attempts to match
the spacing (v2.162: nudge the margin down a couple of px; v2.163: add an
explicit but mismatched `line-height` on top of a margin) both missed
because they treated margin and line-height as interchangeable — they
compound instead of replacing each other, so tweaking one while the other
is still present doesn't reliably converge on the target. The fix that
actually worked (v2.164) matched `.meta`'s mechanism exactly: the same
`line-height:1.7`, with margin removed *between* consecutive `.sub`
elements specifically (`.sub + .sub{margin-top:0}`) so the gap comes from
shared leading the same way `.meta`'s internal lines do, while the first
line keeps an explicit gap from the value above it. v2.165 applied the
identical logic to the "Last 30 min" toggle button below the two `.sub`
lines, which had its own disconnected flat margin. The general lesson:
when matching the visual rhythm of one CSS block (line-height-driven)
from a different structure (separate elements with margins), reproduce
the *mechanism*, not just the visible gap — guessing pixel values against
the wrong mechanism can miss entirely or overcorrect unpredictably. Also
worth remembering: this sandbox's mockup renderer can't load the real
font (no network access), so a mockup comparison that looks convincing
here doesn't guarantee it'll hold on the real device — confirmed
literally happened once in this saga (v2.162's mockup looked like a fix,
the live device showed no change at all).

**UTC-vs-local date-boundary bug (v2.167), only visible for about an hour
a night.** Two rate-fetching call sites (`loadRates()` for electricity,
and gas's "today's unit rate" fetch in `loadBilling()`) built their day
window using `isoDate(now)` — `now.toISOString().slice(0,10)`, always the
*UTC* calendar date — with a literal `Z` appended to both boundaries. The
intent was "today, local midnight to midnight"; the actual effect was
"today, UTC midnight to midnight". Those are the same thing for almost
the entire day, but during BST (UTC+1) local time crosses into a new
calendar day up to an hour before UTC does — so for roughly that hour
every night, `todayISO` silently resolved to *yesterday's* UTC date, and
the whole day's rate fetch was anchored to a window shifted about an hour
early, cutting off well before the real end of local "today". Caught live
via a screenshot taken at 00:21 BST: Standard and Off-peak both showed
identically (the wrongly-scoped window happened to contain only off-peak
data) and the panel read "No change today" despite a real transition
being hours away — both symptoms of the one bug, not two. Fixed by
building the boundary from local date components
(`new Date(now.getFullYear(), now.getMonth(), now.getDate())`) and
letting `.toISOString()` do the UTC conversion correctly itself, rather
than assembling a UTC-labelled string from a UTC-derived date and
treating it as local. Verified numerically before shipping, not just
reasoned through — simulating the exact scenario showed the old window as
`Aug 17 01:00 BST → Aug 18 00:59 BST` (missing the whole rest of the real
day) against the fixed `Aug 18 00:00 BST → Aug 18 23:59 BST`. The general
lesson: `Date.prototype.toISOString()` is always UTC — pairing its output
with a literal `Z` is only "today" if UTC and local agree on what day it
is right now, which isn't guaranteed for up to an hour a day whenever the
local timezone has a non-zero UTC offset. `isoDate()`'s one other call
site (a payment-date string comparison in `loadBilling`) has the same
theoretical exposure but wasn't touched — far lower real-world impact (a
date-only compare, not a fetch-window boundary), and nothing was actually
observed wrong there.

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

## Typography

Two families, each with one job:

- **Space Grotesk** — titles and headlines only: card titles, panel titles
  (`.card-title`, `.fuel-panel-title`, `.live30-title`), headline text
  (`.runway-headline`), the brand name, buttons. Nothing else uses it.
- **Inter** — everything smaller: labels, captions, chart text, data values,
  pills, breakdown rows. Replaced IBM Plex Mono in v2.76 — mono looked the
  part but stopped being legible once the Insights/diagnostics/balance-runway
  panels started packing real density into small spaces. Inter holds up
  much better below 11px and keeps `font-variant-numeric: tabular-nums` so
  numeric columns (rates, breakdown amounts) still align the way the old
  mono figures did.

Five deliberate size tiers for anything smaller than a title (all Inter):

| Role | Examples | Size |
|---|---|---|
| Uppercase eyebrow labels | `.stat-label`, `.big-label`, `.insight-label` | 10px |
| Dim secondary captions | `.runway-detail`, `.trend-caption`, `.forecast-caption` | 10.5px |
| Chart axis/scale labels | `.chart-scale`, `.time-axis`, `.forecast-scale` | 9px |
| List/row item text | `.breakdown-row`, `.bh-item`, `.slot` | 11.5px |
| Pills/badges/toggles | `.card-tag`, `.trend-pill`, `.unit-toggle-btn` | 10.5px |

Before this pass, the same five roles were scattered across 8+ different
sizes (9px–11.5px) with no clear logic, and roughly half the "small text"
rules were silently inheriting Space Grotesk rather than ever declaring a
font at all — invisible until sizes were compared side by side.

**A real gotcha from doing this migration, worth remembering for the next
one:** a global find/replace on the old font name (`IBM Plex Mono`) only
catches rules that *explicitly* declared it. Any rule that never declared a
font-family — and was silently inheriting the page default instead — sails
straight through that kind of sweep untouched, even though it's exactly the
kind of rule a font migration is supposed to catch. 18 rules were like this
here. The only reliable check is auditing for *any* rule missing a
font-family in the target category, not just grepping for the old value.

## Icons

Every icon in the app (v2.137) is a hand-inlined SVG — no icon font, no
icon library, no CDN dependency, matching the project's zero-external-
dependency approach for offline PWA reliability (the same reasoning behind
Google Fonts being the only external asset the app ever loads). All icons
share one stroke style: `viewBox="0 0 24 24"`, `stroke="currentColor"`,
`stroke-width="2"`, `stroke-linecap="round"`, `stroke-linejoin="round"`,
`fill="none"` — sized per context via the `<svg>` element's own
`width`/`height` attributes rather than a wrapping font-size. This wasn't a
new convention invented for this pass — the sync button's icon has always
been a hand-copied Feather Icons path; v2.136 extended that same approach
to every icon that was previously an emoji.

**Sizing**: every card-title/fuel-panel-title/live30-title icon is 26px,
applied uniformly. Small supporting/inline icons (settings, diagnostics
title, connect-account state, gas-day-unavailable, EV warning lines,
session checkmarks) stay smaller, matching their inline/dense context
rather than acting as standalone panel identity icons. The per-line glyphs
inside the diagnostics log itself (info/warning/pass/fail markers in the
sync history and issue list) were deliberately left as plain characters
rather than converted to SVGs — a dense technical readout reads better with
simple glyphs than with 10+ repeated icon instances.

**Color**: follows the app's own documented color language above rather
than a new rule. Electricity-specific icons (Current rate, Live usage, EV
charging, the Electricity fuel-icon) are pink; the Gas fuel-icon is blue;
Balance runway's icon is dynamic — mint when the headline says payments
look sufficient, coral when it doesn't, same logic the headline's own text
color already used. Fuel-agnostic icons (Usage, Billing, Insights,
Standing charges, Settings, Diagnostics, Connect-account) stay neutral
(inherit the surrounding text color) since they don't represent one fuel.

**A real bug worth remembering**: the Insights electricity trajectory icon
and the Balance runway status icon are both set entirely via JS
(`.textContent`/`.innerHTML` at render time, never present in the static
HTML) — the initial emoji-removal pass only swept static markup and missed
both, so they kept showing emoji after that release shipped. Gas's own
trajectory icon (added v2.164, mirrored from electricity's) uses the
identical `.innerHTML`-at-render pattern, so it carries the same risk —
worth remembering for either fuel, not just electricity, if this class of
bug ever needs checking for again. Same root cause hit the Diagnostics
panel title a second way: the static HTML had
the right SVG, but a JS function overwrote it via `.textContent` on every
render, which wipes child nodes (the SVG) and replaces them with plain
text. The lesson: an emoji sweep needs to check *rendered* output, or at
minimum grep the JS file for emoji too, not just the HTML template —
`.textContent` assignments are exactly the kind of thing that silently
undoes a static fix.

Standing charges (Insights) reuses the exact same calendar icon as the
(not yet built) date-picker mockup. Balance runway kept the literal
fuel-pump shape over a trending-up alternative — a deliberate choice, not
a default; the emoji was already a visual pun on "running low" that the
pump icon preserves.

**v2.138 fixed two more gaps, both found by the user testing live rather
than by review:**
- The EV panel's own card-title ("EV charging", lowercase c) was never
  resized/colored in v2.136 — the batch script that applied 26px+pink used
  an exact case-sensitive text match against "EV Charging" (capital C),
  which only exists in the *Insights* panel's copy of that title. The real
  EV panel header uses lowercase "charging" and was silently skipped. A
  case-sensitive find is exactly the kind of check that passes cleanly
  while still missing a real instance — worth doing a case-insensitive
  sweep, or better, matching on the element's class/id rather than its
  visible text, next time this kind of bulk edit is needed.
- The plain-Unicode "ℹ"/"⚠" characters left in the diagnostics log and the
  EV panel's warning lines render as small *colorful* icons by default on
  iOS (Apple gives both characters emoji presentation unless explicitly
  told otherwise) — visually indistinguishable from leftover emoji even
  though they were technically "just text," which defeated the point of
  removing emoji at all. Replaced with small (11–13px) inline SVGs using
  the same stroke style as everything else. Checkmark/cross glyphs
  elsewhere (sync history "✓"/"✗") don't have this problem — those two
  characters aren't in Unicode's default-emoji-presentation set — so they
  were left as plain text.

## Performance

Automatic background refresh runs in three tiers, not one flat interval:

- **Live usage**: its own 30-second poll, independent of everything else.
- **Fast tier** (rate + EV status, ~2 requests): every 5 minutes.
- **Slow tier** (everything in `loadBilling()` — consumption bars, MTD,
  bills, standing charges, balance/Direct Debit; ~11 requests after the
  optimisation below): every 6 hours. This data genuinely can't change
  faster than that regardless of how often it's asked — smart meter
  consumption has a 24–48h settlement lag, bills land on Octopus's own
  roughly-monthly schedule, standing charges change over weeks not
  minutes. 30 minutes (the original interval) was needlessly frequent.

Manual refresh (🔄) and the initial app load still trigger everything at
once regardless of tier timing.

**Vehicle registration info** (make/model) is fetched once per app
lifetime, not on any recurring tier at all — it doesn't belong on a timer
since it never changes in normal use. Cached in `store.creds`; every later
call is a no-op.

**Usage bars** used to fire one REST call per day (7 calls for a
week, up to 31 for a month) — now one wide-range call per fuel, with the
response bucketed into individual days locally in JS afterward
(`bucketReadingsByDay`). Cold-start REST volume dropped from roughly 30
calls to about 11. The rate-matching/cost-calculation logic itself didn't
change at all — same algorithm, just fed by one combined response instead
of several narrow ones.

`rateCache` is wiped once a day (checked from the fast tier) rather than
left to grow — otherwise a long-running session would accumulate a new set
of entries every calendar day indefinitely.

Octopus's documented shared rate limit is 100 REST calls/hour across all
usage, including direct use of Octopus's own app/website on the same
account. The diagnostics panel (see below) shows a live rolling count
against this limit. In practice this turned out not to be what was
causing the "Unavailable" symptom described in an earlier version of this
section — see **Diagnostics** for what it actually was.

## Diagnostics

Settings → "Show diagnostics panel when syncing" (on by default) reveals a
debug panel above the main content whenever there's something worth
showing. It has two parts:

**Current-moment info** — whatever the most recent sync logged: rate
periods matched, days with/without data, REST-call-in-the-last-hour count,
and any `⚠` warnings from that specific run. This resets at the start of
every sync, so it only ever reflects the most recent one.

**Recent syncs** — a persistent log, unlike the section above. Survives
app restarts (stored in `localStorage` under `kw_sync_log`, capped at the
last 60 entries). Each entry records:
- **Timestamp and trigger**: `app-start` (page load), `button` (manual
  refresh tap), `fast`, or `slow` (the automatic tiers) — these used to
  all show as a single undifferentiated "manual", which mattered a lot
  when tracking down the bug below.
- **Obfuscated API key** (first 12 characters, same truncation Octopus's
  own dashboard uses) — captured at the *start* of that sync, not read
  fresh when displayed, so it genuinely reflects what was in effect for
  that batch of calls even if the stored key changed later in the
  session.
- **Pass/fail per component** (Rates/EV/Billing).
- **Captured error detail**, for any failed component that has it — the
  actual response body and headers from a failed REST call (up to 300
  characters), or the real exception message if something threw instead
  of a request simply failing. This is the piece that actually solved a
  real bug (below); before it existed, a failure's pass/fail status was
  visible in history but *why* it failed was only ever shown for the
  single most recent sync, gone the moment the next one ran — even an
  unrelated background one.

If you ever need to debug something new: reproduce it, then screenshot
this panel. The detail line is usually enough to tell whether it's a real
API error (shows Octopus's own message) or a client-side bug (shows a
JavaScript exception like "X is not a function" or "null is not an
object").

### A real bug this caught, worth knowing about

For a long stretch, billing would intermittently fail with what looked
exactly like an API-key/auth problem — 401s, "Unavailable" panels,
seemingly fixed by regenerating the key, only to recur later. It was never
actually about the key at all.

The real cause: `loadBilling()` moves the "N more" bill-history toggle
button — a persistent, `id`'d element — from its static home in the page
into a freshly-rendered container *inside* `#last-bill-row` every time it
runs. Fine the first time. But the *second* time in the same session,
`$('last-bill-row').innerHTML = ...` wipes that container's contents —
and since the toggle is now living inside it from the first run, that
wipe destroys the toggle outright. Every later reference to it then
throws `null is not an object`, and critically, this happened right at
the very start of the function, before any of its own error handling
even ran — so nothing was ever logged until a separate fix (capturing
`Promise.allSettled`'s rejection reason, previously checked for
pass/fail and then discarded) finally surfaced the real error text.

It explains the entire pattern: app-start is always a fresh page load (the
toggle is safe in its static position), so it always worked; any *second*
sync in the same session — a button press, or an automatic tier tick —
always failed, regardless of the API key, rate limits, or anything
network-related.

**The lesson for extending this further**: never move a persistent,
`id`-referenced DOM element into content that a later `.innerHTML =`
assignment might wipe. If something like this needs to happen again,
either render the moved content fresh from a template each time (like the
per-bill "Show breakdown" toggles already do) or move the element back to
a safe position before every risky reassignment, not just once.

## Approximations worth knowing about

- **Octopoints history labels are humanized from `reasonCode` client-side**
  (e.g. `SAVING_SESSION_REWARD` → "Saving session reward"), not a
  hardcoded mapping of Octopus's actual reason values — the schema
  documents `reasonCode` only as "the reason the entry was being added,"
  with no enum list available to confirm the real values against. A
  generic underscore-to-space, capitalize-first-letter transform, so
  labels should read sensibly regardless of the exact strings Octopus
  actually sends, but the wording itself isn't guaranteed to match any
  official copy.
- **`LoyaltyPointsBalanceInput`'s exact field name is inferred, not
  screenshotted directly** — the schema's deprecation notice for the old
  bare `accountNumber` argument says to "use input object with
  accountNumber (+ optional accountUserId)," which is what the balance
  query is built against, but the input type's own field list was never
  seen directly the way `LoyaltyPointLedgersInput`'s was. If Octopus ever
  renames it, the balance fetch would start failing — the panel would
  just hide itself rather than error, per how every other optional
  section here degrades.
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
- **Date-picker's standing charge is applied flat from today's cached
  value, regardless of which date is picked.** If your standing charge has
  changed since a picked historical period, the breakdown box will show
  today's rate rather than the one that actually applied then. A
  deliberate scope-limiting choice, not an oversight — fully historicizing
  it would need an extra API call per picked range purely to look up a
  past standing charge, for a figure that rarely changes and rarely
  differs by more than a few pence/day even when it does.
- **Date-picker's electricity history has a real, observed floor —
  roughly two months back — that gas doesn't share.** Confirmed via
  testing: picking a week further back than that shows the app's own
  honest "No data available for this period" warning, with no error
  logged anywhere (checked diagnostics specifically) — meaning the REST
  call itself succeeds normally, it just comes back with zero consumption
  readings for that range. So this isn't a rates problem and isn't a bug
  in how the request is built — the electricity meter's own consumption
  history via the public REST API genuinely doesn't reach back that far
  on this account, while the gas meter's does. Octopus's own app can
  still show older electricity data in some cases, likely because it can
  draw on internal read history the public consumption endpoint doesn't
  expose the same way. Nothing to fix here — just a real limit of what
  this app's data source can offer. **v2.157 near-miss**: this warning
  element (`${fuel}-period-nodata`, referenced via a template-literal
  `$()` call) was briefly misdiagnosed as dead markup during a code
  review — a literal-string-only search for `$('...')`/
  `getElementById('...')` doesn't catch a fuel-templated reference like
  this one, the exact same blind spot already known from `${fuel}-week`
  and others. Removed, then immediately caught live (a real error plus
  gas silently failing to render at all, since the thrown exception
  halted the rest of that render pass) and restored in v2.158. Lesson for
  any future dead-code sweep in this file: always grep for
  `` `${fuel}- `` (and any other template-literal prefix) specifically,
  not just literal-string calls, before concluding an id is unused.
- **Gas m³→kWh conversion** uses the standard industry approximation
  (×1.02264 correction factor). **Calorific value is configurable** in
  Settings → Advanced (defaults to 40.0) — Octopus's own calorific value
  drifts slightly over time, so if your gas figures look a little off,
  check your latest bill's usage breakdown for the exact value it used and
  enter that.
- **Real EV session cost isn't shown, and can't be derived from rate
  history.** `SmartFlexChargingSession.cost` and the deprecated
  `costOfCharge` aggregate both return null/empty for real data. A
  follow-up theory — matching a session's dispatch times against this
  app's own already-fetched rate history, the same way Polestar's own app
  appears to show real £ costs — was tested directly against a real bill
  and confirmed a dead end: IOG retroactively applies an off-peak rate to
  SmartFlex dispatches that land outside the normal off-peak window, but
  that override never appears in standard rate history via the REST API,
  no matter how long you wait for settlement. **An *estimated* cost is
  shown instead** (v2.154): Smart sessions priced at today's known
  off-peak rate, Boost at today's known standard rate — a simple
  type-based assumption rather than matching a session to its actual
  real-time rate, labeled "(est.)" in the UI so it reads as an
  approximation rather than a confirmed figure. Same type-based reasoning
  powers the "Boost session this week" warning-area flag — Boost is a
  reliable signal of "charged outside the smart schedule" without needing
  rate-matching at all.

  **Reopened and re-concluded a second time (v2.168–v2.183).** A
  screenshot of Octopus's own app showed the reconciled off-peak rate
  genuinely visible for a real EV dispatch, on Octopus's own Usage
  screen — evidence the figure exists *somewhere*, even though the
  REST-side conclusion above still held. Investigated Kraken GraphQL's
  billing/ledger surface via live introspection instead of the REST rate
  endpoint this time. Two real leads, both genuinely tested to
  conclusion, not just assumed: `completedDispatches(accountNumber) ->
  UpsideDispatchType` looked like the strongest candidate by field shape
  (`start`/`end`/`delta`) but returned completely empty for this account —
  most likely a different Octopus smart-device program (battery/solar
  dispatches) that happens to share the platform's naming convention, not
  functionally connected to EV charging here. `account.transactions(fromDate,
  toDate)` — already-proven, already-working code that powers this app's
  own Billing panel — does return real settled `Charge` transactions with
  a genuine `consumption { startDate endDate }` window, but only at
  *billed-period* granularity: one lump-sum electricity charge covering
  several days, one for the whole month for gas. No per-dispatch or
  per-half-hour resolution exists at that level either. Both realistic
  GraphQL avenues are now genuinely exhausted, reinforcing the original
  REST-based conclusion via a completely different path rather than
  contradicting it. EV cost stays an estimate — see memory for the full
  step-by-step if this ever needs revisiting.
- **Estimated range added is a single hardcoded conversion constant**
  (`EV_RANGE_MI_PER_KWH = 4.8`), based on a Polestar 2 Standard Range
  Single Motor's 2024+ spec (69kWh gross/67kWh usable, 322mi WLTP,
  sourced from Polestar's own published figures) — specific to whichever
  vehicle is actually on this account. WLTP is a lab figure, so real-world
  efficiency normally runs lower; labeled "(est.)" for the same reason.
  Would need updating if the vehicle ever changes, or if the exact model
  year/battery turns out to differ from what's assumed here.
- **Predicted monthly cost** is a simple linear projection (today's average
  daily cost carried across the rest of the month) — won't anticipate
  seasonal changes in usage.
- **Standing charge in the consumption charts** is a flat daily estimate
  from the last fetched rate, not re-checked per day.
- **Bill total chart can show fewer than 12 months** if any month has more
  than one bill (a tariff switch mid-billing-cycle, for example) — grouping
  by calendar month means a second bill in the same month uses up a fetch
  slot without adding a new month. 15 bills are fetched instead of a flat
  12 to buffer against this, which covers a single tariff switch, but
  someone who switches several times in a year could still see fewer than
  12 months.
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
- **`UpsideDispatchType.meta`** (on the retired legacy dispatch query) was
  confirmed via introspection to hold only `location` (`AT_HOME` or null,
  completed dispatches) and `source` (`smart-charge`/`test-charge`/
  `bump-charge`, planned dispatches) — dispatch classification, not cost or
  rate data. Belongs to the legacy `completedDispatches`/`plannedDispatches`
  query, fully retired since the SmartFlex rewrite; not worth reviving for
  this.

If numbers look wrong, check **Settings → Show diagnostics panel** — every
sync logs reading counts, rate ranges, and totals, which is usually enough
to spot the actual cause rather than guessing.

## Considered and decided against

- **Octopus Saving Sessions** — the relevant GraphQL fields
  (`savingSessions`, `joinSavingSessionsCampaign`) are deprecated on
  Octopus's side as of early 2026, with no confirmed working replacement.
  Not built. (A distinct, unrelated feature — Octopoints — *was* built and
  later archived for a different reason; see the Billing row and
  Approximations above, not this entry.)
- **EV push notifications** — built earlier in the project, later
  deprecated due to inconsistent GitHub Actions workflow scheduling (the
  cron trigger wasn't firing reliably). Not a candidate to resurrect via
  that mechanism; any future "notify me" feature would need a different
  scheduling approach entirely.
- **Native app wrapper with Lock Screen/Watch widgets** — technically
  possible via Capacitor, but genuine widgets need a separate native
  Swift/WidgetKit codebase and a paid ($99/year) Apple Developer account for
  the required App Group entitlement. Decided the cost/complexity wasn't
  worth it versus the PWA's current workflow.
- **EV Charge History Year view** — mocked up alongside Month for direct
  comparison, then dropped: EV charging doesn't have a real seasonal story
  the way heating does, so 12 monthly totals is a coarser view that doesn't
  add much over Month. Day/Week/Month cover the panel fully.
- **Splitting the EV panel** into a live/current-state card and a separate
  pattern/history view (mirroring how Usage splits from Insights) —
  proposed early on, later reconsidered once the panel's real shape settled;
  the EV panel is considered complete as one card, no split wanted.
- **EV session cost via historical rate-matching** — investigated in depth,
  confirmed a dead end via direct evidence against a real bill (see
  Approximations above). Octopus's rate history genuinely can't see the
  rate actually applied to a SmartFlex dispatch.
- **`reAuthenticationState`** — a guessed field name on the vehicle status
  type, never resolved via introspection; not chased further once the other
  candidates in the same investigation (`currentState`, `stateOfChargeLimit`)
  panned out.
- **A "Today" home-screen summary card**, plus four analytics ideas from an
  external review of the project (EV annual stats, personal records,
  baseload, a replay-based tariff comparison) — all fully designed and
  mocked up, all ultimately declined. The dashboard card was dropped first,
  on its own simpler ground: everything in it duplicated what was already
  one scroll or tap away, so it didn't reduce any real friction regardless
  of how it looked. The other four were mocked as pure text/number stat
  blocks — no chart, no gauge, nothing visual — and every existing panel in
  this app pairs a number with something visual. Reviewing the mockups
  side by side against the rest of the dashboard made that mismatch
  obvious, and the decision was to hold the line on visual consistency
  rather than ship four panels that would read as a different app bolted
  on. If any of these come back later, the bar is a genuinely visual
  treatment, not just a leaner version of the same text-only shape.
  Feasibility notes if ever revisited: EV annual stats' data was confirmed
  clean (away-from-home charging never appears in `chargingSessions`, so
  no location-mixing risk); personal records would need a new
  daily-resolution year-long fetch (Year view currently only pulls monthly
  totals) and would be unreliable for electricity specifically beyond the
  ~2-month history floor; baseload can reuse the existing half-hourly fetch
  but needs to exclude any slot overlapping an EV charging session or it
  just measures charging activity, not baseload; tariff comparison has no
  existing plumbing for any tariff other than the account's own and would
  need ongoing maintenance as Octopus retires/replaces tariff products.
- **`current`** (a device lifecycle-status field) — confirmed via
  introspection to exist, but it's a one-time onboarding milestone, static
  for an already-established device. Not useful to surface.

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
things together, all to the same number — including a release that only
touches HTML/CSS with no JS content changes at all, since GitHub Pages'
CDN cache is keyed on the URL including the query string, not on whether
the JS specifically changed. This was learned the hard way once: a
CSS/HTML-only change was initially shipped reusing the previous release's
version numbers, which risked being silently swallowed by the CDN cache
since, as far as caching is concerned, nothing had changed.

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
