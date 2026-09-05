# Changelog

Kraken Watch's early history (roughly v2.9–v2.264) predates any real commit
discipline — the git log for that period is almost entirely
`Add files via upload` from the claude.ai web workflow, so the *why* behind
each change lived in `// v2.xxx:` comments in the source instead.

This file is the extraction of those notes into one place, so the source can
carry just the load-bearing "why this code is shaped this way" and not the
full edit history. Entries are newest-first. From ~v2.265 onward, look at the
git commit messages instead — they carry this detail now.

Version numbers are the `package.json` `version` at the time; they don't map
to git tags for the pre-v2.265 era.

---

### v2.264 — "only completed windows shown" note over-eager
The Windows-tab note ("Only completed windows within the last 12 hours are
shown…") only checked whether the Completed list was empty, not whether
Planned rows were about to render right below it. A real screenshot showed
the note sitting directly above five genuine Planned rows, reading as if the
whole tab were empty. Now shown only when Completed *and* Planned are both
empty (reusing the same stale-entry filter the Planned rows already apply).

### v2.261 — standing-charge segment always renders full-strength
Replaced the v2.258/v2.259 grey-segment treatment for incomplete days. The
standing charge is a known fixed daily rate regardless of whether
consumption has settled, so it always renders normally; greying it implied
it was uncertain too. The genuinely-uncertain part (off-peak/peak, or gas
usage) is now zeroed out entirely for an incomplete day rather than shown
muted.

### v2.260 — permanent grey bars on genuine zero-usage days
v2.258's "both cost categories must be nonzero" check, plus v2.259 greying
any `hasData:false` bar, made a real zero-usage day (e.g. away from home)
stay grey forever, never superseded. Fixed in `lastNDaysElecSplit` /
`lastNDaysCost`: once a day is ≥3 days old (past Octopus's documented
24–48h settlement lag), trust `readings.length` alone. Recent days keep the
stricter check where the placeholder-zero risk is real.

### v2.259 — grey out chart bars for unsettled days
Bars for any `hasData:false` day were greyed to signal "not settled yet."
Superseded by v2.260/v2.261 after it caused permanent greying (see above).

### v2.258 — tighten "has data" to require both cost categories nonzero
Intended to stop a barely-started day reading as complete. Introduced the
regressions fixed in v2.260/v2.261.

### v2.256 — Windows-tab empty note describes the real cause
Message reworded to name the permanent cause (the confirmed 24-window
rolling cap — old windows age off once nothing dispatches) rather than the
earlier, inaccurate "temporary sync delay" framing.

### v2.255 — drop per-window expand in the Completed run rows
Once the summary row itself showed the run's total kWh, the child rows' only
remaining unique data was per-window granularity (0.4 kWh at 09:00, 0.5 at
09:30…), which proved low-value. Expand-to-see-detail removed entirely.

### v2.254 — single-window run kWh fix
Fixed the kWh total for a run consisting of a single dispatch window.
Superseded by the v2.240-series rework (see v2.240).

### v2.253 — remove the EV Day view
Nearly every session is an overnight charge straddling two calendar days,
making hour-of-today bucketing close to meaningless. Removing Day also
removed the last consumer of `SmartFlexDispatch.dispatches` (confirmed empty
on this account anyway — see v2.232).

### v2.251 — compact power meter replaces the EV mini-boxes
The This Session / Power / Sessions today / Cost mini boxes were replaced
with a single compact power meter, shown only while there's real power
flow. (No Settings field for max charger output yet — the meter scales to a
sensible default.)

### v2.250 — battery-gauge limit marker sourced from the schedule
The limit marker was driven by `stateOfChargeLimit.upperSocLimit`, a
separate device-level absolute cap distinct from the "Target X% by HH:MM"
schedule shown elsewhere. Now uses the schedule's own target; `todaySchedule`
was hoisted above the gauge block so both can read it.

### v2.243 — Completed runs: drop the window-count + chevron pill
Part of the iterative rework of the Completed dispatch list; superseded by
v2.240's final single-summary-line form.

### v2.242 — Completed runs: drop kWh from the per-run summary
Also superseded by the v2.240 rework.

### v2.240 — group Completed dispatch windows into runs
Individual half-hourly rows don't scale to an overnight session (a 12h
charge = 24 rows). Contiguous windows are now grouped into runs; a genuine
gap starts a new run. The summary line shows the run's time span and total
kWh; a run of 1 window and a run of 9 render through the identical format.
This supersedes v2.240/v2.242/v2.243/v2.254 — see git history if that
reasoning is ever needed again.

### v2.239 — filter stale Planned dispatch entries; shared active-window helper
`plannedDispatches` can hold entries whose time has fully passed without
being cleared, if Octopus revises its plan mid-window. A real screenshot
showed an old "00:30–01:00" window still marked "Planned" well after 01:00,
above the active "01:00–12:00" that superseded it. Now filters out anything
already ended and not currently active. The start/end comparison was pulled
into one `isActiveWindow` helper used in all three places that needed it.

### v2.238 — sort completedDispatches ascending
Octopus returns `completedDispatches` in "reverse time order" by design;
sorted ascending here to match the rest of the list (Planned / Dispatching
now).

### v2.232 — confirmed SmartFlexDispatch.dispatches comes back empty
Diagnostic confirmed the per-window `dispatches` array inside each session
returns empty on this account even for an ordinary, fully real session.
Kept in the query as a Day-view fallback until v2.253 removed Day.

### v2.229 — Completed rows use an icon + "Completed" label
Moved the checkmark from a "✓" glued onto the time text into its own icon
paired with "Completed", matching the bolt ("Dispatching now") and clock
("Planned") icon+label treatment.

### v2.227 — icons on "Dispatching now" and "Planned"
"Dispatching now" got the app's lightning-bolt symbol (reused from the panel
header) in place of an abstract dot; "Planned" got a clock icon. Bolt = now,
clock = waiting. Pulse animation moved onto a `.dispatch-icon` class so it
works on any shape.

### v2.224 — remove "Next planned dispatch window" row
Exact-duplicate information already shown in the Windows list right below it
(same time range, same "Planned" status), confirmed via a screenshot showing
both rows at once. The v2.221 non-active-window fix became dead code and was
noted as such.

### v2.221 — pick the first non-active planned window, not planned[0]
Fix for the "Next planned dispatch window" value. Made moot by v2.224
removing that row.

### v2.220 — target countdown handles the daily recurrence
The schedule's target time recurs daily, but the countdown only checked
today's occurrence — once that clock-time passed it broke. Now rolls to the
next day's occurrence.

### v2.219 — balance forecast: MTD-blended rate first, flat average as fallback
Reverted v2.218's priority order. The blended MTD rate reflects the
account's actual off-peak/standard mix; a flat 50/50 average systematically
overstates electricity cost for an off-peak-skewed (IOG) household. Flat
average is used only when MTD data genuinely isn't available (the v2.217
crash case).

### v2.218 — balance forecast primary source = flat off-peak/standard average
Made the flat average primary to fix sync-time volatility, demoting
MTD-blended to fallback. The accuracy regression this caused was reverted in
v2.219.

### v2.217 — cache today's live gas unit rate in rateState
Added `rateState.gasRateP`, populated from the same rate-API fetch that fills
`#gas-unit-rate`, so `computeBalanceForecast` can use it instead of
MTD-derived consumption (which crashed when MTD wasn't available).

### v2.214 — fetchYearMonthly accepts a yearsAgo offset
Added an optional offset (default 0 = current year) to probe whether a prior
year's `group_by=month` request retains data past the ~2-month floor
confirmed for finer daily/half-hourly queries. Diagnostic only; not wired
into any chart.

### v2.213 — self-heal expired Kraken JWT (KT-CT-1124)
The in-memory Kraken token had no expiry check, so once it expired every
call kept failing with "Signature of the JWT has expired" until the app was
fully closed and reopened. Now: on that specific error code, clear the
cached token and retry once with a fresh one. Guarded to a single retry so a
genuinely bad credential still fails cleanly.

### v2.212 — per-fuel standing-charge boxes in Insights
Broke the standing-charge display out per fuel (each its own box) instead of
only ever showing the combined total. The total line still sums both.

### v2.211 — expose usable battery kWh; separate battery-note rendering
Added a `getEvBatteryKwh()` accessor (not just the derived mi/kWh ratio) for
"cost to fully charge" (kWh × rate directly) and the header. Battery kWh is
appended to the vehicle caption via " · " rather than merged into the model
string, since Octopus's raw model text for some accounts already contains a
kWh figure.

### v2.210 — EV charging-cost figures are point-in-time, not period aggregates
The full-charge / per-mile cost figures in the EV insights panel use today's
off-peak/standard rate against the Settings-configured range or battery
kWh — a constant at any given moment, not a sum over the panel's 7-day
window. Kept inside the panel (behind the same has-data gate) rather than
always-visible.

### v2.208 — colour the session "+N miles" figure by session type
Mint for Smart, pink for Boost, reusing the SMART/BOOST badge colour pairing
(mint also carries the app-wide "cheaper" meaning, which lines up — Smart
sessions are the cheaper ones).

### v2.206 — remove the fake SoC start→finish % from session rows
`sessions[i-1].stateOfChargeFinal` was being used as this session's start
%, which only holds if nothing touched the battery between sessions. Driving
in between produced drops like 95%→84% that looked like the session
discharged the car (confirmed by a screenshot). Miles-added is computed
client-side from kWh and marked "(Est.)".

### v2.198 — vehicle name: make on the title line, model as caption
Restored the two-line layout after v2.197 wrongly collapsed both onto one
line. v2.197's removal of the old first-word/remainder split of the model
string stays — Settings now takes make and model as free text, so the
caption is the model field verbatim.

### v2.197 — (reverted) collapsed vehicle name onto one line
Collapsed make + model to a single line and dropped the model-string split.
The one-line layout was reverted in v2.198; the split removal was kept.

### v2.196 — force a diagnostics redraw after on-demand fetches
`logDebug()` output (e.g. the `hasNextPage` warning) didn't appear until the
next scheduled sync. On-demand actions ("Show more" sessions, the prior-year
probe) now call `renderDiagnostics()` themselves.

### v2.194 — EV tab-switch handler updates the show-more/show-less wrap
The immediate-feedback click handler predated the v2.191 show-more/show-less
wrap and never learned about it, so the wrap's visibility was only corrected
on the next 5-minute re-render. Confirmed live: switching to Sessions showed
content immediately but left the button invisible until then.

### v2.192 — shared session cost estimate (`estimateSessionCostP`)
One helper for the Sessions tab, Charge History, and the "This session"
box — was duplicated three ways. Uses today's off-peak/standard rate for
every session regardless of age: a deliberate simplification (the user's
tariff is fixed in 12-month periods), returning `null` rather than a guess
if today's rates haven't loaded. Optional `rates` arg makes it testable.

### v2.191 — several EV changes
- Vehicle name: prefer the user's saved custom make/model over Octopus's
  device-record values, on both the cached and first-load paths.
- Settings: custom vehicle name saved as an override only if it differs from
  the API value, so an untouched field keeps following the device record.
- Elapsed-time formatter (`formatElapsed`) added for session rows.
- Session warnings: full inline text pill → small circular icon-only toggle
  that reveals a detail row on click.
- "Show more" / "Show less" replacing v2.189/v2.190's flat "last 30 days":
  each "Show more" doubles the window (8→16→32→64…), re-fetching only the
  new tier; "Show less" reverts to the 8-day base. Buttons are a centered
  width-to-content pair, and belong only to the Sessions tab (they were
  leaking onto the Windows tab).

### v2.190 — (superseded) EV session problem badge as own-row layout
Own-row badge layout for charging problems, plus a flat "last 30 days"
session list. Both reworked in v2.191. `warnTriangleSvgSm` was hoisted to
module level when the inline right-aligned layout replaced it.

### v2.189 — factor out the Sessions-tab renderer
`renderEVSessionSlots` split out so it can run against either the default
8-day list or a wider on-demand fetch without duplicating markup.

### v2.187 — model SmartFlexChargingProblem correctly
It's a union of `SmartFlexChargingError` (a `cause` enum) and
`SmartFlexChargingTruncation` (a `truncationCause` enum plus
original/achievable SoC). Benign causes are filtered out;
`realProblemLabel` surfaces only genuine problems.

### v2.167 — rate fetch anchored to a UTC day boundary during BST
`isoDate(now)` + a literal `Z` meant "today, UTC midnight to midnight." In
BST, local time enters a new day up to an hour before UTC, so for ~that hour
each night the fetch window was shifted early. Confirmed live at 00:21 BST:
Standard and Off-peak showed identical, "No change today" despite a real
change hours away. Fixed by building the boundary from local date components
and letting `.toISOString()` do the UTC conversion. Same bug fixed in
`loadBilling`'s gas-rate fetch.

### v2.166 — balance forecast no longer auto-selects the lowest month
Was deliberate ("so tapping isn't required"), but with the breakdown now a
richer ledger, auto-opening one felt like unrequested content.
`selectedForecastCycle` stays `null` until a bar is tapped.

### v2.164 — gas Insights weekday/weekend + trajectory
Added the gas equivalents of the two previously elec-only Insights features,
mirrored exactly (same thresholds, wording, conventions). No reason found on
review for the original gap.

### v2.161 — EV Smart/Boost split merged into the legend labels
Was a separate `.split-line` element above the chart; now the percentage
sits next to the swatch it describes. Left blank (not hidden) for an empty
period so the legend still shows.

### v2.154 — standard-rate Boost cost estimate; Smart/Boost split %
`rateState.standardRateP` added to estimate Boost-session cost (Boost
charges happen outside the smart dispatch schedule, so assumed at standard
rate). The Smart/Boost split is shown as an explicit percentage, not just
bar colours, with period-agnostic wording.

### v2.153 — schedule strip highlights the upcoming target, not "today"
A day's entry represents an overnight charge completing that morning, so
once today's target time has passed, the still-upcoming target is the
relevant one to highlight.

### v2.151 — picked-week bar labels use the index directly
A picked week is fetched as an exact snapped Sun–Sat span, so bar index *is*
the weekday — no rotation. The rotation formula is only correct for the
default rolling 7-day window; applying it to a picked week mislabeled every
bar unless the tapped day was a Saturday. Same root cause as the v2.143 /
v2.144 picked-week fetch and breakdown-date bugs, in the axis labels.

### v2.150 — several fixes
- EV tab choice (`evViewMode`) persisted so auto-refresh re-renders reapply
  it instead of resetting to Dispatch.
- "Target reached" shown plainly when the battery has hit/passed the target
  %, instead of a stale or blank countdown.
- `SMART_CONTROL_NOT_AVAILABLE` warning suppressed while the panel's own tag
  already says IDLE — it just means "no vehicle plugged in," not a fault.
- Pulsating dot for the active dispatch window (later replaced by the bolt
  icon in v2.227).
- Octopoints feature archived (not deleted) — live testing returned
  `KT-CT-1111` Unauthorized, most likely an account permissions gap. Full
  implementation preserved in `octopoints-archive.js`.

### v2.143 / v2.144 — picked-week fetch and breakdown-date bugs
The picked-week fetch and the breakdown-date label both used the raw tapped
day as if it were the array's last entry rather than snapping to the
displayed Sun–Sat range. Fixed for the fetch and breakdown here; the axis
labels had the same bug, fixed in v2.151.
