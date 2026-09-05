import { store, demoFallbackEnabled } from './store.js';
import { $, fmtGBP, fmtT, formatElapsed } from './format.js';
import { logIssue, logDebug, sanityCheck, renderDiagnostics } from './diagnostics.js';
import { krakenGQL } from './api.js';
import { renderPowerMeter, renderChartScale, chartMax, isChartDense, chartLabelOrBlank, renderWeekBars } from './charts.js';
import { estimateSessionCostP, rateState } from './rates.js';
import { daysElapsedInMonth } from './usage.js';

// range in miles, usable battery kWh), from which the actual mi/kWh ratio
// is derived per-account instead of assuming everyone's on a Polestar 2.
// This constant now only serves as the fallback for anyone who hasn't
// filled in Settings yet, kept at the original Polestar 2 Standard Range
// Single Motor figure (69kWh gross/67kWh usable, 322mi WLTP — 322/67≈4.8)
// so existing behaviour doesn't silently change for users who never touch
// the new fields.
const EV_RANGE_MI_PER_KWH_FALLBACK = 4.8;
function getEvRangeMiPerKwh() {
  const c = store.creds || {};
  if (c.wltpMiles > 0 && c.wltpBatteryKwh > 0) return c.wltpMiles / c.wltpBatteryKwh;
  return EV_RANGE_MI_PER_KWH_FALLBACK;
}
// v2.211: separate accessor for the usable battery kWh itself, not just
// the derived mi/kWh ratio — needed for "cost to fully charge" (kWh × rate
// directly, more accurate than reversing the ratio) and the header
// caption. Same 67kWh fallback as the ratio constant above, for the same
// reason: existing behaviour for anyone who hasn't touched Settings
// shouldn't silently change.
const EV_BATTERY_KWH_FALLBACK = 67;
function getEvBatteryKwh() {
  const c = store.creds || {};
  return (c.wltpBatteryKwh > 0) ? c.wltpBatteryKwh : EV_BATTERY_KWH_FALLBACK;
}

let evPrevWorthSeeing = false;
let evManualOverride = null; // null = auto, true/false = user's explicit choice

function applyEvCollapse(worthSeeing) {
  if (worthSeeing && !evPrevWorthSeeing) evManualOverride = null; // rising edge: force back to auto (open)
  evPrevWorthSeeing = worthSeeing;
  const expanded = evManualOverride !== null ? evManualOverride : worthSeeing;
  $('ev-body').classList.toggle('hidden', !expanded);
  $('ev-card').classList.toggle('ev-collapsed', !expanded);
  $('ev-chevron').textContent = expanded ? '▾' : '▸';
  $('ev-header').setAttribute('aria-expanded', String(expanded));
}

// Vehicle registration (make/model) genuinely never changes in normal use —
// unlike everything else in this app, it doesn't belong on any recurring
// timer at all. Fetched once, ever, and cached in localStorage alongside
// credentials; every later call is a no-op. Query shape is a guess from a
// community GitHub issue, not official docs — confirmed working against a
// real account (Polestar 2, provider Jedlix) via diagnostics, but still
// wrapped defensively in case the field ever comes back differently.
// v2.198: make on the title line, full model as its own smaller caption
// line beneath — restored after v2.197 wrongly collapsed both onto one
// line. (v2.197 also removed the old first-word/remainder split of the
// model string, which is still correct and stays removed: now that
// Settings lets the user enter make and model as free text, the caption
// is simply the model field verbatim, not a trimmed remainder.)
// v2.211: battery kWh appended separately via " · ", not merged into the
// model string itself — Octopus's raw model text for some accounts
// happens to already include a kWh figure of its own (e.g. "...Single
// Motor (69 kWh)", the vehicle's gross capacity), which wouldn't
// necessarily match Settings' usable-kWh figure feeding the cost
// calculations, and a custom model override might not include one at
// all. Keeping them visually and textually separate avoids ever showing
// two different kWh numbers stitched into one string with no indication
// they're from different sources.
export function formatVehicleName(make, model) {
  if (!make) return { title: '', caption: '' };
  const batteryNote = `${getEvBatteryKwh()} kWh usable`;
  const caption = model ? `${model} · ${batteryNote}` : batteryNote;
  return { title: ` — ${make}`, caption };
}

export async function loadVehicleInfoOnce() {
  const creds = store.creds || {};
  if (creds.vehicleChecked) {
    // v2.191: prefer the user's own custom name if they've set one,
    // falling back to whichever value Octopus's device record returned.
    const displayMake = creds.customVehicleMake || creds.vehicleMake;
    const displayModel = creds.customVehicleModel || creds.vehicleModel;
    if (displayMake) {
      const { title, caption } = formatVehicleName(displayMake, displayModel);
      $('ev-name').textContent = title;
      if (caption) { $('ev-caption').textContent = caption; $('ev-caption').classList.remove('hidden'); }
    }
    return;
  }
  try {
    const vehicleData = await krakenGQL(`
      query RegisteredVehicle($accountNumber: String!) {
        registeredKrakenflexDevice(accountNumber: $accountNumber) {
          provider vehicleMake vehicleModel
        }
      }`, { accountNumber: store.creds.accountNumber });
    const v = vehicleData?.registeredKrakenflexDevice;
    store.creds = { ...store.creds, vehicleChecked: true, vehicleMake: v?.vehicleMake || null, vehicleModel: v?.vehicleModel || null };
    // v2.191: same custom-name preference on first load as the cached path
    // above — creds.customVehicleMake/Model persist across this refresh
    // (only vehicleMake/vehicleModel, the raw API values, get overwritten
    // here), so a saved override keeps showing even after the API values
    // themselves change underneath it.
    const displayMake = store.creds.customVehicleMake || v?.vehicleMake;
    const displayModel = store.creds.customVehicleModel || v?.vehicleModel;
    if (displayMake) {
      const { title, caption } = formatVehicleName(displayMake, displayModel);
      $('ev-name').textContent = title;
      if (caption) { $('ev-caption').textContent = caption; $('ev-caption').classList.remove('hidden'); }
    }
    logDebug('Registered vehicle', v ? `provider=${v.provider}, make=${v.vehicleMake}, model=${v.vehicleModel}` : '(none returned)');
  } catch (err) {
    // Don't mark as checked on failure — a transient error should still
    // retry on the next app open, unlike a genuine "no vehicle" result.
    logIssue('Registered vehicle check', err);
  }
}

// EV cost investigation, concluded: both plausible GraphQL paths tested
// and confirmed empty/null, not query mistakes. SmartFlexChargingSession
// .cost returns null for every real session (confirmed earlier this
// session). costOfCharge (deprecated, but tested anyway since deprecated
// doesn't necessarily mean broken — real evidence from the Polestar app's
// own cost overview suggested it might still work) returned a genuinely
// empty array once the correct DataFrequency enum value (MONTHLY, not
// MONTH) was used — a real, successful query with no data, not an error.
// Best working theory: Polestar computes its own cost client-side (kWh ×
// a known tariff rate), the same approximation technique this app already
// uses elsewhere for elec/gas — nothing hidden we're missing, just a
// different app doing the same kind of estimate. Cost stays out of the EV
// panel; if a future EV cost figure is ever wanted, it would need the same
// approximated-rate approach rather than a real Octopus-sourced value.
//
// Rate-matching investigated separately and now closed as a dead end: a
// one-time evidence check (since removed) compared the 31 Jul bill, which
// showed the off-peak rate applied to a midday SmartFlex dispatch, against
// this app's own already-fetched standard rate history for the same
// timestamps. The app's rate history showed the ordinary peak rate, not
// the bill's off-peak override — confirming the retroactive SmartFlex
// override is per-appliance/invisible to standard rate history, not
// property-wide. This data source cannot see the rate actually applied to
// a dispatch, so rate-matching has no data to match against, regardless
// of settlement time. Any future EV cost figure must use the
// approximated-rate approach above, not rate-matching.
//
// Reopened and re-concluded a second time: a screenshot of Octopus's own
// app showed the reconciled off-peak rate genuinely visible for a real
// EV dispatch, on Octopus's own Usage screen — evidence the reconciled
// figure exists *somewhere*, even though the REST-side conclusion above
// still held. Investigated Kraken GraphQL's billing/ledger surface via
// live introspection instead: `completedDispatches(accountNumber) ->
// UpsideDispatchType` looked like the strongest lead by field shape
// (start/end/delta), and an early test at the time returned genuinely
// empty. Correction, found later the same session: that field is real
// and does work — it's now the live data source for the Windows tab's
// Completed rows (see loadEVSmartFlex). The earlier "empty" result was
// most likely querying deprecated field names (startDt/endDt/deltaKwh)
// rather than the current ones (start/end/delta), not evidence the field
// itself is disconnected from EV charging. It still doesn't answer the
// cost question this paragraph is about, though: UpsideDispatchType has
// no cost or rate field at all, only kWh (`delta`) — confirmed working
// for energy, still no path to real cost through it. The other real
// lead, `account.transactions(fromDate,
// toDate)` — already proven, working code, used by the Billing panel
// above — does return real settled Charge transactions with a
// `consumption { startDate endDate }` window, but only at *billed-period*
// granularity: one lump-sum electricity charge covering several days,
// one for the whole month for gas. No per-dispatch or per-half-hour
// resolution exists at that level either. Both realistic GraphQL avenues
// are now genuinely tested and exhausted, not just assumed — reinforcing
// the original conclusion via a completely different path. EV cost stays
// an estimate; nothing found changes that. (Separately, real cost was
// found — after this comment was written — to possibly exist as a
// `Money` field directly on the session itself; see the still-open probe
// noted in project memory, not yet conclusive.)

export async function loadEV() {
  const smartFlexOk = await loadEVSmartFlex().catch(err => { logIssue('EV SmartFlex data', err); return false; });
  if (smartFlexOk) return true;

  // No legacy fallback — a failed sync now shows a genuine Unavailable
  // state rather than silently substituting the old dispatch-only UI with
  // different (older, less accurate) data. Recovers naturally on the next
  // auto-sync. The old dispatch-only path is archived separately
  // (ev-legacy-archive.js) if this decision ever needs revisiting.
  if (demoFallbackEnabled()) {
    populateDemoEV();
  } else {
    $('ev-tag').textContent = 'Unavailable';
    $('ev-tag').className = 'card-tag tag-dim';
    $('ev-battery-row').classList.add('hidden');
    $('ev-schedule-preview').classList.add('hidden');
    $('ev-warnings').classList.add('hidden');
    $('ev-pmeter').classList.add('hidden');
    $('ev-view-toggle').classList.add('hidden');
    $('ev-week-legend').classList.add('hidden');
    $('ev-slots-session').classList.add('hidden');
    $('ev-slots-dispatch').classList.remove('hidden');
    $('ev-slots-dispatch').innerHTML = '<div class="slot">Unavailable right now</div>';
    $('ev-week').innerHTML = '';
    $('ev-week-scale').innerHTML = '';
    $('ev-history-period-label').textContent = 'This week';
    $('ev-week-kwh-total').textContent = '—';
    $('ev-week-session-count').textContent = '—';
    $('insights-ev-panel').classList.add('hidden');
  }
  return false;
}

// New path: devices → SmartFlexVehicle → chargingSessions. devices() takes
// no deviceType filter (confirmed by a real runtime error: "Unknown
// argument 'deviceType' on field 'Query.devices'" — the earlier docs
// screenshot showing that enum value was almost certainly from a
// different, similarly-named device query, not this one). Returns every
// device on the account regardless of type, so the client-side
// .find(d => d.chargingSessions) below does the real filtering — already
// built as a safety net, turned out to be load-bearing.
// Every other field here was confirmed via live introspection this session
// (see park-up notes) except SmartFlexChargingProblem, which wasn't found
// under that name and is deliberately left out rather than guessed — same
// discipline that caught the deviceType issue above rather than blindly
// trying more argument names. cost.amount's unit (pounds vs pence) isn't
// independently confirmed by introspection alone — assumed pounds decimal
// (the common GraphQL Money convention) and worth a sanity check against a
// real screenshot once deployed; wrong would show as an obviously-scaled
// number (e.g. "£22" for a small top-up), not a broken query.
// SmartFlexDispatch.dispatches inside each session was meant to give
// per-window detail (start/end/type/kWh) so the Windows tab's completed
// rows could come from this one query. Confirmed via diagnostic (v2.232)
// that it comes back empty on this account, even for an ordinary, fully
// real session. Was kept in the query as a fallback for the Day view's
// hourly buckets, but v2.253 removed Day entirely (nearly every session
// is an overnight charge straddling two calendar days, making an
// hour-of-today bucketing close to meaningless) — with that gone, this
// was its only remaining consumer, so the field itself is now dropped
// from the query too rather than left in unused.
// completedDispatches (fetched below, alongside plannedDispatches) is
// the real replacement — confirmed working via Octopus's own official
// docs (start/end/delta are current; startDt/endDt/deltaKwh deprecated)
// and used for the Windows tab's completed rows. One known, accepted
// limitation: it appears to cap at roughly 24 entries (confirmed via a
// user screenshot — a window known to exist from the evening before had
// silently dropped off the returned list, replaced by more recent ones).
// On a normal-speed charger that's more than enough for any single
// session; on a slow one (this account's "granny charger"), a long
// overnight charge can exceed it, meaning the Completed list — and its
// own window count — reflects only the most recent ~24 windows, not
// necessarily the whole session from its true start. Accepted as a
// genuine, understood gap rather than something to build around: the
// Completed list is still useful data even when it isn't the complete
// picture, so long as nothing elsewhere in the app quietly assumes it
// is. That's specifically why "This session"'s own kWh total does NOT
// sum from this data — see its own comment for why.
const badgeHtml = type => `<span class="slot-badge ${type === 'BOOST' ? 'badge-boost' : 'badge-smart'}">${type}</span>`;

// v2.187: SmartFlexChargingProblem — a union of SmartFlexChargingError
// (a `cause` enum) and SmartFlexChargingTruncation (a `truncationCause`
// enum, plus original/achievable SoC — the charge was cut short before
// reaching its planned target). Both enums mix genuinely benign outcomes
// in with real problems, confirmed via live introspection: SOC_LIMIT_
// REACHED/FULL_CHARGE/NO_SCHEDULED_CHARGE/POWER_TAPERING and BOOST_
// CHARGING/CHARGING_OPTIMISATION_CREATED all just describe a normal or
// intentional outcome, not a fault — showing a warning badge for those
// would violate this app's own rule that coral only ever means a
// genuine problem. Everything else in both enums is a real one.
const BENIGN_CAUSES = new Set(['SOC_LIMIT_REACHED', 'FULL_CHARGE', 'NO_SCHEDULED_CHARGE', 'POWER_TAPERING', 'BOOST_CHARGING', 'CHARGING_OPTIMISATION_CREATED']);
const CAUSE_LABELS = {
  COMMUNICATION_ERROR: 'Comms error', THIRD_PARTY_CHARGING_INTERFERENCE: 'Charger interference',
  POWER_DISCREPANCY: 'Power discrepancy', FAILURE_CAUSE_ERROR: 'Charging error',
  CUSTOMER_ACTION_REQUIRED: 'Needs attention', NO_CHARGING: 'Didn\u2019t charge',
  POST_CHARGE_BATTERY_DRAIN: 'Drained after charge', UNKNOWN_CHARGING_ERROR_CAUSE: 'Unknown error',
  DISCONNECTED: 'Disconnected early', DEVICE_DEAUTH_SUCCESS: 'Device deauthorised',
  SUSPENDED: 'Suspended', UNKNOWN_TRUNCATION_CAUSE: 'Charge cut short'
};
function realProblemLabel(session) {
  for (const p of (session.problems || [])) {
    const cause = p.cause || p.truncationCause;
    if (cause && !BENIGN_CAUSES.has(cause)) return CAUSE_LABELS[cause] || cause;
  }
  return null;
}
// v2.190: hoisted to module level — was previously only defined inside
// the old problemBadgeHtml() (own-row badge layout), removed once that
// layout was reverted in favour of the inline right-aligned one below,
// which needs this same icon markup directly.
const warnTriangleSvgSm = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

let expandedProblemSessions = new Set(); // keys = session start ISO strings, survives re-renders
let lastRenderedSessions = null, lastRenderedNow = null; // so the click handler can re-render without needing to know which list (8-day/expanded) is currently showing

// v2.189: Sessions-tab renderer, factored out so it can run against either
// the default 8-day `sessions` array or a wider on-demand fetch (see
// showMoreEVSessions) without duplicating the markup logic.
function renderEVSessionSlots(sessions, now) {
  lastRenderedSessions = sessions; lastRenderedNow = now;
  const sessionSlots = $('ev-slots-session');
  sessionSlots.innerHTML = [...sessions].reverse().map(s => {
    const kwh = s.energyAdded?.value;
    const startD = new Date(s.start);
    const dayLabel = startD.toDateString() === now.toDateString() ? 'Today'
      : startD.toDateString() === new Date(now - 86400000).toDateString() ? 'Yesterday'
      : startD.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const elapsed = formatElapsed(s.start, s.end);
    // v2.206: the SoC start→finish % is gone — it was never a real
    // measured start point. sessions[i-1].stateOfChargeFinal was being used
    // as this session's start %, which only holds if nothing touched the
    // battery between the two sessions; if the car was driven in between,
    // the "start" reads as whatever % the car happened to be at when this
    // session began, not where the previous session left off — producing
    // exactly the kind of drop (e.g. 95%→84%) that looks like this session
    // discharged the car, confirmed via a user screenshot. Miles added is
    // computed client-side from kWh (not a real Octopus figure either), so
    // marked "(Est.)" for the same reason the cost figure already is.
    // v2.208: "+33 miles" (excluding "(Est.)") colored by session type —
    // mint for Smart, pink for Boost — reusing the same type-color pairing
    // the SMART/BOOST badge already uses, not a new meaning for either
    // color. Conveniently also lines up with mint's broader "cheaper"
    // role app-wide, since Smart sessions genuinely are the cheaper ones.
    const milesText = kwh != null
      ? `<span class="slot-soc-gain ${s.type === 'BOOST' ? 'slot-miles-boost' : 'slot-miles-smart'}">+${Math.round(Math.abs(kwh) * getEvRangeMiPerKwh())} miles</span><span class="slot-soc-gain"> (Est.)</span>`
      : '';
    // v2.191: warning redesign — was a full text pill inline (v2.190),
    // now a small circular icon-only toggle; clicking it shows/hides a
    // third row with the full message, rather than the message always
    // being visible. Matches the "surface the key fact, drill down for
    // detail" pattern already used elsewhere in the app (breakdown boxes,
    // bill history). Expand state keyed by session start time, persisted
    // in expandedProblemSessions so it survives re-renders (auto-refresh,
    // toggling the 30-day view) rather than resetting every time.
    const problem = realProblemLabel(s);
    const problemKey = s.start;
    const isExpanded = problem && expandedProblemSessions.has(problemKey);
    const miniPillHtml = problem
      ? `<button type="button" class="badge-problem-mini" data-problem-key="${problemKey}" aria-expanded="${isExpanded}">${warnTriangleSvgSm}</button>`
      : '';
    const detailRowHtml = isExpanded
      ? `<div class="slot-row" style="margin-top:2px;"><span class="slot-badge badge-problem" style="margin-left:0;">${warnTriangleSvgSm}${problem}</span></div>`
      : '';
    // v2.192: estimated cost, paired with kWh (Option B, approved over
    // appending it inline with SoC/miles — groups the two "amount"
    // figures, energy and cost, together, while SoC/gain/miles stay their
    // own logical group). Uses estimateSessionCostP() — see that function
    // for the "why today's rate is fine even for older sessions" reasoning.
    const costP = estimateSessionCostP(s);
    const costText = costP != null ? `<span class="slot-cost">(Est. <b>${fmtGBP(costP / 100)}</b>)</span>` : '';
    return `<div class="slot">
      <div class="slot-row"><span><span class="slot-date">${dayLabel}</span> · ${fmtT(s.start)} – ${fmtT(s.end)}${elapsed ? ` (${elapsed})` : ''}</span><span class="slot-row-right">${miniPillHtml}${badgeHtml(s.type)}</span></div>
      <div class="slot-row-inline"><span class="left-group"><b>${kwh != null ? Math.abs(kwh).toFixed(1) + ' kWh' : '—'}</b>${costText}</span><span class="soc-col">${milesText}</span></div>
      ${detailRowHtml}
    </div>`;
  }).join('');
  if (!sessionSlots.children.length) sessionSlots.innerHTML = '<div class="slot">No charging sessions this week</div>';
}

let evProblemToggleListenerAdded = false;
function attachEVProblemToggleListener() {
  if (evProblemToggleListenerAdded) return;
  evProblemToggleListenerAdded = true;
  // Event delegation on the parent (not each button): sessionSlots.innerHTML
  // gets fully rebuilt on every render, which would destroy per-button
  // listeners, but a listener on the parent container itself survives
  // since the parent element is never replaced, only its children.
  $('ev-slots-session').addEventListener('click', (e) => {
    const btn = e.target.closest('.badge-problem-mini');
    if (!btn || !lastRenderedSessions) return;
    const key = btn.dataset.problemKey;
    if (expandedProblemSessions.has(key)) expandedProblemSessions.delete(key);
    else expandedProblemSessions.add(key);
    renderEVSessionSlots(lastRenderedSessions, lastRenderedNow);
  });
}

let evDefaultSessions = null; // the original 8-day list, cached so "Show less" can revert without a re-fetch
let evSessionsCache = new Map(); // keyed by day-count (16, 32, 64...), so repeated expand/collapse never re-fetches the same tier twice
let evSessionsWindowDays = 8; // the window currently on screen
let evSessionsToggleBtnAdded = false;

// v2.191: "Show more"/"Show less" — replaces v2.189/v2.190's flat "last 30
// days" with the user's own preferred approach: each "Show more" click
// doubles the window (8→16→32→64...), re-fetching only when that exact
// tier hasn't been seen before (cached in evSessionsCache by day-count).
// "Show less" always reverts straight to the base 8-day view rather than
// stepping back tier-by-tier — simpler, and matches the actual complaint
// (no way back at all), not a request for stepped undo. Deliberately a
// separate on-demand fetch rather than widening the default 8-day query,
// so nothing else that depends on that 8-day scope (mini-stats, Windows
// tab) is affected.
// first: 30 is the only value on this field confirmed genuinely safe
// anywhere in the app (the main loadEVSmartFlex card query, working all
// along). first: 200 hit "Invalid pagination parameters" — the same
// error loadEVMonthData already hit once at first: 400, where the cap
// was never actually pinned down, just guessed lower. Not guessing a
// second time here: staying at the one proven-safe value and surfacing
// pageInfo.hasNextPage honestly (same pattern as loadEVMonthData) so an
// under-count is visible in diagnostics rather than silent, instead of
// picking another untested first value.
async function fetchEVSessionsWindow(days) {
  const data = await krakenGQL(`
    query EVSessionsWindow($accountNumber: String!, $after: DateTime!) {
      devices(accountNumber: $accountNumber) {
        ... on SmartFlexVehicle {
          chargingSessions(after: $after, first: 30) {
            pageInfo { hasNextPage }
            edges { node {
              ... on SmartFlexChargingSession {
                start end type
                energyAdded { value }
                stateOfChargeFinal
                problems {
                  __typename
                  ... on SmartFlexChargingError { cause }
                  ... on SmartFlexChargingTruncation { truncationCause originalAchievableStateOfCharge achievableStateOfCharge }
                }
              }
            } }
          }
        }
      }
    }`, {
    accountNumber: store.creds.accountNumber,
    after: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  });
  const vehicle = (data?.devices || []).find(d => d && d.chargingSessions);
  const sessions = (vehicle?.chargingSessions?.edges || []).map(e => e.node).filter(Boolean);
  const hasMore = !!vehicle?.chargingSessions?.pageInfo?.hasNextPage;
  if (hasMore) logDebug('EV sessions window', `${days}-day window hit the 30-session cap — some older sessions in range are not shown`);
  return sessions;
}

async function showMoreEVSessions(moreBtn, lessBtn, now) {
  const nextDays = evSessionsWindowDays * 2;
  const cached = evSessionsCache.get(nextDays);
  if (cached) {
    evSessionsWindowDays = nextDays;
    renderEVSessionSlots(cached, now);
    lessBtn.classList.remove('hidden');
    return;
  }
  const original = moreBtn.querySelector('span').textContent;
  moreBtn.querySelector('span').textContent = 'Loading…';
  moreBtn.disabled = true;
  try {
    const sessions = await fetchEVSessionsWindow(nextDays);
    renderDiagnostics(); // v2.196: without this, logDebug() output (e.g. the hasNextPage warning above) doesn't appear until the next scheduled sync
    if (sessions.length) {
      evSessionsCache.set(nextDays, sessions);
      evSessionsWindowDays = nextDays;
      renderEVSessionSlots(sessions, now);
      lessBtn.classList.remove('hidden');
    }
  } catch (err) {
    logIssue(`EV ${nextDays}-day sessions`, err);
    renderDiagnostics();
  } finally {
    moreBtn.querySelector('span').textContent = original;
    moreBtn.disabled = false;
  }
}

function showLessEVSessions(lessBtn, now) {
  evSessionsWindowDays = 8;
  renderEVSessionSlots(evDefaultSessions, now);
  lessBtn.classList.add('hidden');
}

async function loadEVSmartFlex() {
  const data = await krakenGQL(`
    query EVSmartFlexData($accountNumber: String!, $after: DateTime!) {
      devices(accountNumber: $accountNumber) {
        ... on SmartFlexVehicle {
          make model
          chargePointPowerOutput
          status { ... on SmartFlexVehicleStatus { stateOfCharge { value } isSuspended testDispatchFailureReason currentState stateOfChargeLimit { upperSocLimit isLimitViolated } } }
          alerts { ... on SmartFlexDeviceAlert { message publishedAt } }
          preferences { ... on SmartFlexDevicePreferences { schedules { dayOfWeek time max } } }
          chargingSessions(after: $after, first: 30) {
            edges {
              node {
                ... on SmartFlexChargingSession {
                  start end type
                  energyAdded { value }
                  stateOfChargeFinal
                  problems {
                    __typename
                    ... on SmartFlexChargingError { cause }
                    ... on SmartFlexChargingTruncation { truncationCause originalAchievableStateOfCharge achievableStateOfCharge }
                  }
                }
              }
            }
          }
        }
      }
      plannedDispatches(accountNumber: $accountNumber) { start end delta }
      completedDispatches(accountNumber: $accountNumber) { start end delta }
    }`, {
      accountNumber: store.creds.accountNumber,
      after: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    });

  const vehicle = (data.devices || []).find(d => d && d.chargingSessions);
  if (!vehicle) return false; // no EV device on this path, or wrong shape — fall back to legacy

  const sessions = (vehicle.chargingSessions?.edges || []).map(e => e.node).filter(Boolean);
  evLoadedSessions = sessions; // Day view reuses this — no new fetch needed, today is always within this rolling window
  const planned = data.plannedDispatches || [];
  const now = new Date();
  // v2.239: pulled out into a shared helper — used here, and again below
  // when filtering stale planned entries, rather than duplicating the
  // same start/end comparison in three separate places.
  const isActiveWindow = (d, n) => n >= new Date(d.start) && n < new Date(d.end);
  const activeDispatch = planned.find(d => isActiveWindow(d, now));
  // v2.238: Octopus's own docs describe completedDispatches as returning
  // "reverse time order" by design — sorted ascending here to match the
  // rest of this list (Planned/Dispatching now, further below), which is
  // naturally oldest-first, so the combined Windows list reads in one
  // consistent direction top to bottom rather than backwards then
  // forwards. `delta` is documented as negative for import (charging) —
  // Math.abs() where used below, same convention as energyAdded
  // elsewhere in this file. No date-range argument on this field, so
  // filtered client-side to the same rolling window as sessions.
  const windowStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const completedDispatchWindows = (data.completedDispatches || [])
    .filter(d => new Date(d.start) >= windowStart)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  $('ev-tag').textContent = activeDispatch ? 'CHARGING' : (planned.length ? 'SCHEDULED' : 'IDLE');
  $('ev-tag').className = activeDispatch ? 'card-tag tag-pink' : (planned.length ? 'card-tag tag-amber' : 'card-tag tag-dim');
  applyEvCollapse(!!activeDispatch || planned.length > 0);

  // v2.224: "Next planned dispatch window" removed entirely — it was
  // exact-duplicate information already shown in the Windows list right
  // below it (same time range, same "Planned" status), confirmed via a
  // user screenshot showing both rows stating "08:30 – 12:00" at once.
  // The v2.221 fix above (finding the first non-active window rather than
  // blindly using planned[0]) is no longer needed since nothing reads
  // that value anymore.

  // Target SoC/time — actual model is a list of per-day schedule entries
  // (SmartFlexDeviceSchedule: dayOfWeek/time/max/min/upperLimit), not the
  // flat weekday/weekend pair originally assumed from an unrelated,
  // deprecated type. Matches today's day-of-week against the list; DayOfWeek
  // enum values are assumed to be standard uppercase day names (unconfirmed
  // directly, but this is client-side matching after a successful fetch —
  // a wrong guess here just shows no target text, it can't break the query
  // the way a wrong GraphQL field/fragment guess would).
  // Hoisted above the battery gauge block (v2.250) so the gauge's limit
  // marker can use this same value — see note below.
  const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const schedules = vehicle.preferences?.schedules || [];
  const todaySchedule = schedules.find(s => s.dayOfWeek === dayNames[now.getDay()]);

  // Battery gauge — genuinely new, wasn't available via the legacy path at all
  const soc = vehicle.status?.stateOfCharge?.value;
  if (soc != null) {
    $('ev-battery-row').classList.remove('hidden');
    const pct = Math.min(100, Math.max(0, soc));
    $('ev-battery-pct').textContent = `${Math.round(pct)}%`;
    $('ev-battery-fill').style.width = `${pct}%`;

    // Limit marker (v2.250 fix) — previously driven entirely by
    // stateOfChargeLimit.upperSocLimit, a separate device-level absolute
    // cap that's distinct from the "Target X% by HH:MM" schedule shown
    // just below (todaySchedule.max) — confirmed via a real screenshot
    // showing a live 90% schedule target with zero marker/hatch, meaning
    // upperSocLimit was null on this account even while a schedule target
    // was actively in effect. Now prefers today's actual schedule target
    // (what's really governing charging behaviour day to day), falling
    // back to the device-level limit only if no schedule entry exists for
    // today. Also fixed: the restricted zone previously only showed while
    // strictly below the limit (limitPct > pct) — once SoC reached the
    // target exactly ("Target reached"), the zone vanished even though the
    // region beyond target is still genuinely restricted. Now shows
    // whenever pct hasn't gone past the limit (limitPct >= pct).
    const limit = todaySchedule?.max ?? vehicle.status?.stateOfChargeLimit?.upperSocLimit;
    if (limit != null) {
      const limitPct = Math.min(100, Math.max(0, limit));
      $('ev-battery-limit').classList.remove('hidden');
      $('ev-battery-limit').style.left = `${limitPct}%`;
      if (limitPct >= pct) {
        $('ev-battery-restricted').classList.remove('hidden');
        $('ev-battery-restricted').style.width = `${100 - limitPct}%`;
      } else {
        $('ev-battery-restricted').classList.add('hidden');
      }
    } else {
      $('ev-battery-limit').classList.add('hidden');
      $('ev-battery-restricted').classList.add('hidden');
    }
  } else {
    $('ev-battery-row').classList.add('hidden');
  }

  // Target SoC/time text — todaySchedule already computed above the
  // battery gauge block (v2.250), reused here.
  if (todaySchedule && todaySchedule.max != null && todaySchedule.time) {
    $('ev-battery-target').textContent = `Target ${Math.round(todaySchedule.max)}% by ${todaySchedule.time.slice(0, 5)}`;
    // Countdown — only shown if today's target time hasn't passed yet;
    // once it has, "X hours until target" would be nonsensical (negative
    // or referring to a target that's already come and gone).
    // v2.150: if the battery has actually reached (or passed) the target
    // %, say so plainly instead of either a stale countdown or, once the
    // target time passes, blank text that reads as broken.
    if (soc != null && soc >= todaySchedule.max) {
      $('ev-battery-countdown').textContent = 'Target reached';
    } else {
    const [th, tm] = todaySchedule.time.split(':').map(Number);
    let targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), th, tm);
    // v2.220: the schedule's target time recurs daily (same time shown for
    // all 7 days in the weekly strip below), but this only ever checked
    // *today's* occurrence — once that clock-time passed, the countdown
    // went blank instead of rolling to tomorrow's occurrence, even while
    // actively charging overnight past it. That's not an edge case, it's
    // the normal case for any overnight session with a morning target —
    // confirmed via a user report of the countdown missing while charging
    // in the evening, target already past for "today." Roll forward one
    // day so the countdown always counts down to the next real occurrence.
    if (targetDate <= now) targetDate = new Date(targetDate.getTime() + 86400000);
    if (targetDate > now) {
      const diffMin = Math.round((targetDate - now) / 60000);
      const h = Math.floor(diffMin / 60), m = diffMin % 60;
      $('ev-battery-countdown').textContent = `${h > 0 ? h + 'h ' : ''}${m}m to go`;
    } else {
      $('ev-battery-countdown').textContent = '';
    }
    }
  } else {
    $('ev-battery-target').textContent = '';
    $('ev-battery-countdown').textContent = '';
  }

  // Weekly schedule preview — the schedules array already has all 7 days,
  // previously only today's entry was ever looked at. Originally a dot
  // row (which days have a target set), but real-world testing showed
  // that's the wrong question — most accounts have every day scheduled,
  // so "set vs unset" barely varies while the actual target *time* is
  // the genuinely useful thing to compare across days. Days with no
  // schedule entry show "—" rather than a blank gap.
  // v2.153: highlight whichever target is still upcoming, not blindly
  // "today" — a day's entry represents an overnight charge completing
  // that morning, so once today's target time has passed, today's own
  // entry is already done and the next one that actually matters is
  // tomorrow's. Renamed the CSS hook from .today to .upcoming to match.
  let upcomingIdx = now.getDay();
  const todayEntryForHighlight = schedules.find(s => s.dayOfWeek === dayNames[now.getDay()]);
  if (todayEntryForHighlight?.time) {
    const [uh, um] = todayEntryForHighlight.time.split(':').map(Number);
    const todayTargetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), uh, um);
    if (todayTargetDate <= now) upcomingIdx = (upcomingIdx + 1) % 7;
  }
  if (schedules.length) {
    $('ev-schedule-preview').classList.remove('hidden');
    $('ev-schedule-preview').innerHTML = dayNames.map((d, i) => {
      const entry = schedules.find(s => s.dayOfWeek === d);
      const isUpcoming = i === upcomingIdx;
      const label = ['S', 'M', 'T', 'W', 'T', 'F', 'S'][i];
      const timeText = entry?.time ? entry.time.slice(0, 5) : '—';
      return `<div class="schedule-day${isUpcoming ? ' upcoming' : ''}"><div class="schedule-day-label">${label}</div><div class="schedule-day-time">${timeText}</div></div>`;
    }).join('');
  } else {
    $('ev-schedule-preview').classList.add('hidden');
  }

  // Consolidated warnings — collects every applicable condition into one
  // list rather than five separate boxes, so the panel shows exactly what's
  // wrong (0 to N lines) without stacking clutter regardless of how many
  // fire at once. Each condition stays silent unless genuinely true, same
  // "invisible unless it matters" pattern as before.
  const warnings = [];

  if (vehicle.status?.isSuspended) {
    warnings.push({ level: 'coral', text: 'Vehicle control is currently suspended by Octopus' });
  }

  // testDispatchFailureReason returns an explicit "no failure" enum value
  // (renders as literal "none" once lowercased) rather than null when
  // nothing's failed — confirmed via real data, a truthy check alone fired
  // constantly. Excluded case-insensitively since the exact casing Octopus
  // uses isn't independently confirmed.
  const failReason = vehicle.status?.testDispatchFailureReason;
  if (failReason && failReason.toUpperCase() !== 'NONE') {
    warnings.push({ level: 'amber', text: `Last test dispatch failed — ${failReason.replace(/_/g, ' ').toLowerCase()}` });
  }

  // currentState — Octopus's own device state machine. Most of its values
  // (SETUP_COMPLETE, SMART_CONTROL_CAPABLE, the AUTHENTICATION_*/TEST_*
  // ones) are one-time onboarding milestones, not ongoing status — for an
  // established device they'd just sit at one value forever, no different
  // from the already-confirmed-unhelpful `current` lifecycle field. Only
  // the states that could genuinely vary day-to-day for a device that's
  // already live are surfaced here. BOOSTING/SMART_CONTROL_IN_PROGRESS are
  // deliberately not warnings — normal operation, already reflected by the
  // status pill.
  const state = vehicle.status?.currentState;

  if (state === 'LOST_CONNECTION') {
    warnings.push({ level: 'coral', text: 'Lost connection to vehicle' });
  } else if (state === 'SMART_CONTROL_OFF') {
    warnings.push({ level: 'amber', text: 'Smart control is currently off' });
  } else if (state === 'SMART_CONTROL_NOT_AVAILABLE') {
    // v2.150: this fires constantly whenever the vehicle is simply
    // disconnected — genuinely just means "no vehicle currently plugged
    // in to control," not a fault. Suppressed while the panel's own tag
    // reads IDLE (no active or planned dispatch); still shown if it fires
    // while a dispatch is scheduled/active, where it would be a real problem.
    if (activeDispatch || planned.length) {
      warnings.push({ level: 'amber', text: 'Smart control is not available for this vehicle right now' });
    }
  }

  if (vehicle.status?.stateOfChargeLimit?.isLimitViolated) {
    const limit = vehicle.status.stateOfChargeLimit.upperSocLimit;
    const current = vehicle.status.stateOfCharge?.value;
    const limitText = limit != null && current != null ? ` (${Math.round(current)}% vs ${Math.round(limit)}% limit)` : '';
    warnings.push({ level: 'amber', text: `Battery limit exceeded${limitText}` });
  }

  (vehicle.alerts || []).forEach(a => {
    if (a?.message) warnings.push({ level: 'amber', text: a.message });
  });

  // v2.154: flag Boost sessions from the last 7 days — a lightweight
  // insight rather than a device-status warning, but reuses this area's
  // existing styling since the user approved that placement. Boost is a
  // manual charge outside the smart dispatch schedule, so it's a reliable
  // type-based signal without needing the rate-matching this app already
  // ruled out (see EV cost investigation notes) — deliberately not trying
  // to detect "charged during a peak window" directly.
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const boostSessionsThisWeek = sessions.filter(s => s.type === 'BOOST' && new Date(s.start) >= weekStart);
  if (boostSessionsThisWeek.length) {
    const n = boostSessionsThisWeek.length;
    warnings.push({ level: 'amber', text: `${n} Boost session${n === 1 ? '' : 's'} this week charged outside off-peak hours — likely cost more than a Smart dispatch would have` });
  }

  const warningsEl = $('ev-warnings');
  if (warnings.length) {
    warningsEl.classList.remove('hidden');
    const warnTriangleSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    warningsEl.innerHTML = warnings.map(w => `<div class="warning-line ${w.level}">${warnTriangleSvg} ${w.text}</div>`).join('');
  } else {
    warningsEl.classList.add('hidden');
    warningsEl.innerHTML = '';
  }

  // v2.240: individual half-hourly rows don't scale to a real overnight
  // session (a 12h charge is 24 separate rows) — grouped into runs of
  // contiguous windows instead. A genuine gap between windows (nothing
  // dispatched in between) naturally starts a new run rather than being
  // hidden inside one. No badgeHtml() here — this data source has no type
  // (Smart/Boost) field (confirmed absent, not guessed — see the
  // meta.source investigation, since closed).
  const dispatchSlots = $('ev-slots-dispatch');
  dispatchSlots.classList.remove('hidden'); // rebuilt below, visibility corrected against evViewMode after render
  const runs = [];
  completedDispatchWindows.forEach(d => {
    const last = runs[runs.length - 1];
    if (last && new Date(last.end).getTime() === new Date(d.start).getTime()) {
      last.end = d.end;
      last.windows.push(d);
    } else {
      runs.push({ start: d.start, end: d.end, windows: [d] });
    }
  });
  const runIcon = '<svg class="completed-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  // v2.255: expand-to-see-per-window-detail removed entirely — once the
  // summary row itself started showing the run's total kWh (see below),
  // the child rows' only remaining unique information was per-window
  // granularity (0.4 kWh at 09:00, 0.5 at 09:30, etc.), which turned out
  // to be low-value once you already know the run's total. Removing it
  // also meant the tap target, chevron, and the run's window-count pill
  // no longer had a purpose — a run of 1 window and a run of 9 now render
  // through the exact same summary line, just with a different number in
  // it, rather than needing two different formats. Was: v2.240 (grouping
  // + expand), v2.242 (kWh dropped from summary), v2.243 (window count +
  // chevron pill), v2.254 (single-window kWh fix) — this supersedes all
  // four; see git history if any of that reasoning is needed again.
  dispatchSlots.innerHTML = runs.map((r, i) => {
    const totalKwh = r.windows.reduce((sum, d) => sum + Math.abs(d.delta || 0), 0);
    const summaryLabel = `${fmtT(r.start)} – ${fmtT(r.end)} · ${totalKwh.toFixed(1)} kWh`;
    // v2.229: checkmark moved from a plain "✓" glued onto the time text
    // into its own icon paired with "Completed", matching how the bolt
    // and clock icons pair with "Dispatching now"/"Planned" — all three
    // states now follow the same icon+label shape instead of this one
    // being built differently. Uses currentColor rather than its own
    // accent, so it inherits the same dim treatment .slot.done already
    // applies to everything in this row via opacity, rather than adding
    // a fourth distinct color to a row that's deliberately muted.
    return `<div class="slot done"><span>${summaryLabel}</span><b><span class="live-dot-label">${runIcon}Completed</span></b></div>`;
  }).join('');
  // v2.256: message text describes the real, permanent cause (the
  // confirmed 24-window rolling cap — once nothing's dispatched recently
  // enough to keep the list populated, older windows have already aged
  // off) rather than the earlier, inaccurate framing of a temporary sync
  // delay.
  // v2.264 fix: the condition only checked whether Completed was empty,
  // not whether Planned windows were about to render right below the
  // note — confirmed via a real screenshot showing the note sitting
  // directly above five genuine Planned rows, reading as if the whole
  // tab were empty when it plainly wasn't. Hoisted the same filter the
  // Planned rows below already use (see v2.239's own comment) so the
  // note can check it too — only shown now when Completed AND Planned
  // are both empty, i.e. the tab would otherwise show nothing at all.
  const visiblePlanned = planned.filter(d => isActiveWindow(d, now) || new Date(d.end) > now);
  if (!completedDispatchWindows.length && sessions.length && !visiblePlanned.length) {
    dispatchSlots.insertAdjacentHTML('beforeend', '<div class="slot"><span>Only completed windows within the last 12 hours are shown here. See Sessions tab for full charging history.</span></div>');
  }
  // v2.239: was `planned.forEach` unconditionally — but plannedDispatches
  // can genuinely hold stale entries whose time has already fully passed
  // without ever being cleared, if Octopus's own backend later revises
  // the schedule and supersedes an old window with a new one (a real,
  // documented behavior — planned windows can change dynamically after
  // being viewed). Confirmed via a user screenshot: an old "00:30–01:00"
  // window still showing "Planned" well after 01:00, sitting directly
  // above the genuinely active "01:00–12:00" window that superseded it.
  // Filtering out anything whose end time has already passed and isn't
  // the currently active one, rather than rendering every stale entry
  // Octopus happens to still be holding onto.
  visiblePlanned.forEach(d => {
    const isActive = isActiveWindow(d, now);
    // v2.150: swapped the static "●" character for a pulsating dot.
    // v2.227: swapped the dot for the same lightning-bolt shape already
    // used as this panel's own header icon — reuses the app's existing
    // "actively charging" symbol rather than an abstract dot, and pairs
    // naturally with the new clock icon on "Planned" below (bolt = now,
    // clock = waiting). Pulse animation moved from the old dot's own
    // inline style onto the new .dispatch-icon class — same keyframes,
    // works identically on any shape, not just a circle.
    const iconHtml = isActive
      ? '<svg class="dispatch-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
      : '<svg class="planned-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';
    // v2.227: "Planned" also gets a small icon now (a clock), matching
    // the treatment "Dispatching now" already has, instead of being
    // plain text next to a colored one.
    const label = `<span class="live-dot-label">${iconHtml}${isActive ? 'Dispatching now' : 'Planned'}</span>`;
    const cls = isActive ? ' active' : ' scheduled';
    dispatchSlots.insertAdjacentHTML('beforeend', `<div class="slot${cls}"><span>${fmtT(d.start)} – ${fmtT(d.end)}</span><b>${label}</b></div>`);
  });
  if (!dispatchSlots.children.length) dispatchSlots.innerHTML = '<div class="slot">No dispatch windows scheduled</div>';

  // Session view — whole charging sessions, oldest-first to match, each
  // with its own real kWh and estimated cost/miles, plus type badge.
  // v2.189: factored into its own function, callable with either the
  // default 8-day `sessions` or a wider on-demand fetch (see
  // showMoreEVSessions below) — same rendering logic either way, just a
  // different input list. Guarded on evSessionsWindowDays > 8: once the
  // user has expanded, later auto-refreshes (every 5 min) must not
  // re-render with the narrow 8-day list, or the expanded view would
  // silently revert on its own a few minutes after being requested. The
  // real tradeoff: the expanded view then stays static (no fresh data)
  // until the page is next fully reloaded — better than reverting a
  // user's explicit choice without asking.
  evDefaultSessions = sessions;
  attachEVProblemToggleListener();
  if (evSessionsWindowDays === 8) renderEVSessionSlots(sessions, now);

  // v2.191: "Show more"/"Show less" — two buttons, centered as a pair
  // (width-to-content, not full-width — v2.189/v2.190 were full-width).
  // "Show more" is always visible and doubles the window each press;
  // "Show less" only appears once actually expanded, and reverts fully to
  // the 8-day base. v2.191 fix: was appearing under the Windows/Dispatch
  // tab too (created once, unconditionally, with no visibility tie to
  // evViewMode) — now hidden/shown in the same place the tab visibility
  // itself gets reapplied, a few lines below.
  const sessionSlotsContainer = $('ev-slots-session');
  if (!evSessionsToggleBtnAdded) {
    evSessionsToggleBtnAdded = true;
    const wrap = document.createElement('div');
    wrap.id = 'ev-sessions-toggle-wrap';
    wrap.style.cssText = 'display:flex;justify-content:center;gap:8px;margin-top:12px;';
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'bh-breakdown-toggle';
    moreBtn.innerHTML = '<span>Show more</span><svg viewBox="0 0 10 6" fill="none" width="9" height="6"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const lessBtn = document.createElement('button');
    lessBtn.type = 'button';
    lessBtn.className = 'bh-breakdown-toggle hidden';
    lessBtn.innerHTML = '<span>Show less</span><svg viewBox="0 0 10 6" fill="none" width="9" height="6"><path d="M1 5L5 1L9 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    moreBtn.addEventListener('click', () => showMoreEVSessions(moreBtn, lessBtn, new Date()));
    lessBtn.addEventListener('click', () => showLessEVSessions(lessBtn, new Date()));
    wrap.appendChild(moreBtn); wrap.appendChild(lessBtn);
    sessionSlotsContainer.parentNode.insertBefore(wrap, sessionSlotsContainer.nextSibling);
  }

  // v2.150 fix: reapply whichever tab the user actually has selected. Every
  // render above unconditionally shows dispatchSlots (rebuilding it needs
  // it un-hidden), which previously left it visibly on top of Sessions
  // view after any auto-refresh — this restores the correct tab instead of
  // defaulting back to Dispatch every time.
  $('ev-slots-dispatch').classList.toggle('hidden', evViewMode !== 'dispatch');
  $('ev-slots-session').classList.toggle('hidden', evViewMode !== 'session');
  $('ev-view-dispatch-btn').classList.toggle('active', evViewMode === 'dispatch');
  $('ev-view-session-btn').classList.toggle('active', evViewMode === 'session');
  // v2.191: the show-more/show-less pair belongs only to the Sessions tab.
  $('ev-sessions-toggle-wrap').classList.toggle('hidden', evViewMode !== 'session');

  $('ev-view-toggle').classList.remove('hidden');
  $('ev-week-legend').classList.remove('hidden');

  // v2.251: This session/Sessions today/Cost mini boxes removed entirely —
  // see the styles.css comment above .pmeter for why. Replaced with a
  // single compact power meter, shown only while there's a real power
  // reading to show (i.e. actively charging); kept fully out of the DOM
  // otherwise rather than showing a placeholder, same convention used for
  // the battery-limit marker etc.
  const power = vehicle.chargePointPowerOutput;
  if (activeDispatch && power != null) {
    $('ev-pmeter').classList.remove('hidden');
    renderPowerMeter(sanityCheck(+power, { min: 0, max: 100, label: 'chargePointPowerOutput', expected: 'kW' }));
  } else {
    $('ev-pmeter').classList.add('hidden');
  }

  await setEVHistoryPeriod(evHistoryPeriod);
  renderEVInsights(sessions, now);

  return true;
}

// Stacked week chart (SMART/BOOST) with tap-to-breakdown — the one chart
// in the app that never had this, closed out now that session-level data
// makes a per-day breakdown genuinely worthwhile. Returns the per-day
// bucket data so the click handler (wired once in init()) can look up
// whichever day gets tapped without recomputing.
// Shared bar+scale+legend renderer — identical drawing logic across all
// three periods (Week/Month/Day), only the bucket-building differs.
function renderEVHistoryBars(buckets, labels) {
  const max = chartMax(buckets.map(b => b.smart + b.boost));
  const maxBarHeight = 44;
  const isDense = isChartDense(buckets.length);
  $('ev-week').classList.toggle('dense', isDense);
  $('ev-week').innerHTML = buckets.map((b, i) => {
    const total = b.smart + b.boost;
    const h = Math.max(2, Math.round((total / max) * maxBarHeight));
    const smartH = total > 0 ? Math.round((b.smart / total) * h) : 0;
    const boostH = total > 0 ? h - smartH : 0;
    const neutralH = total > 0 ? 0 : h; // no sessions at all in this bucket — a plain neutral floor, not a false Boost claim
    return `<div class="ev-week-col">
      <div class="ev-week-stack" data-i="${i}" style="height:${h}px">
        ${boostH ? `<div class="ev-week-seg boost" style="height:${boostH}px"></div>` : ''}
        ${smartH ? `<div class="ev-week-seg smart" style="height:${smartH}px"></div>` : ''}
        ${neutralH ? `<div class="ev-week-seg neutral" style="height:${neutralH}px"></div>` : ''}
      </div>
      <span data-i="${i}">${chartLabelOrBlank(labels[i], i, isDense)}</span>
    </div>`;
  }).join('');
  renderChartScale('ev-week-scale', max, v => v.toFixed(1));
  $('ev-week-legend').classList.remove('hidden');

  const kwhTotal = buckets.reduce((s, b) => s + b.smart + b.boost, 0);
  const sessionCount = buckets.reduce((s, b) => s + b.sessions.length, 0);
  $('ev-week-kwh-total').textContent = `${kwhTotal.toFixed(1)} kWh`;
  $('ev-week-session-count').textContent = `${sessionCount}`;

  // v2.192: period-total estimated cost, same estimateSessionCostP() used
  // in the Sessions tab and This-Session mini-box. Hidden as "—" rather
  // than a wrong/zero figure if today's rates haven't loaded, or if any
  // one session in the period is missing a cost estimate for the same
  // reason — a partial total would be misleading, not just imprecise.
  const allSessions = buckets.flatMap(b => b.sessions);
  const costsP = allSessions.map(estimateSessionCostP);
  const costTotalP = costsP.every(c => c != null) ? costsP.reduce((s, c) => s + c, 0) : null;
  $('ev-week-cost-total').textContent = costTotalP != null ? fmtGBP(costTotalP / 100) : '—';

  // v2.154: Smart/Boost split, as an explicit percentage rather than only
  // visible in the stacked bar colors — makes the cost-efficiency story
  // legible at a glance instead of requiring a visual read of bar segments.
  // Period-agnostic wording (no "this week"/"today" baked in) so it reads
  // correctly under Day/Week/Month alike without extra plumbing.
  // v2.161: merged directly into the legend labels (was a separate
  // `.split-line` element above the chart) — one fewer line on screen,
  // and the percentage now sits right next to the swatch it describes
  // instead of being stated twice in two different places. Left blank
  // (not hidden) for a genuinely empty period, since the legend itself
  // still needs to show — "Smart"/"Boost" with no trailing number reads
  // fine on its own.
  const smartPctEl = $('ev-week-legend-smart-pct');
  const boostPctEl = $('ev-week-legend-boost-pct');
  if (smartPctEl && boostPctEl) {
    if (kwhTotal > 0) {
      const smartTotal = buckets.reduce((s, b) => s + b.smart, 0);
      const smartPct = Math.round((smartTotal / kwhTotal) * 100);
      smartPctEl.textContent = `${smartPct}%`;
      boostPctEl.textContent = `${100 - smartPct}%`;
    } else {
      smartPctEl.textContent = '';
      boostPctEl.textContent = '';
    }
  }
}

// Week — unchanged logic, 7 daily buckets from the sessions already loaded
// for the live card (no new fetch).
function buildEVWeekBuckets(sessions, now) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - 6);
  const buckets = Array.from({ length: 7 }, () => ({ smart: 0, boost: 0, sessions: [] }));
  const dates = [];
  for (let i = 0; i < 7; i++) { const d = new Date(startOfWeek); d.setDate(d.getDate() + i); dates.push(d); }
  sessions.forEach(s => {
    const dayIdx = Math.floor((new Date(s.start) - startOfWeek) / 86400000);
    if (dayIdx < 0 || dayIdx > 6) return;
    const kwh = Math.abs(s.energyAdded?.value || 0);
    if (s.type === 'BOOST') buckets[dayIdx].boost += kwh; else buckets[dayIdx].smart += kwh;
    buckets[dayIdx].sessions.push(s);
  });
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const labels = dates.map(d => dayLabels[d.getDay()]);
  return { buckets, labels, dates, dateFormat: 'weekday' };
}

// Streak + busiest-day for the Insights panel — deliberately independent
// of Charge History's own Day/Week/Month toggle state (evWeekBuckets
// changes with whatever period the user has selected there), since these
// are inherently weekly concepts that wouldn't make sense recomputed for
// a single day or a whole month. Builds its own week buckets directly
// from the sessions already loaded, rather than reusing shared state.
function renderEVInsights(sessions, now) {
  const { buckets } = buildEVWeekBuckets(sessions, now);
  const panel = $('insights-ev-panel');
  const hasAnyData = buckets.some(b => b.sessions.length > 0);
  if (!hasAnyData) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const daysCharged = buckets.filter(b => b.sessions.length > 0).length;
  $('insights-ev-streak-dots').innerHTML = buckets.map(b => `<div class="ev-streak-dot${b.sessions.length ? ' charged' : ''}"></div>`).join('');
  $('insights-ev-streak-text').innerHTML = `Charged <b>${daysCharged}</b> of the last 7 days`;

  let busiestIdx = -1, busiestTotal = 0;
  buckets.forEach((b, i) => { const t = b.smart + b.boost; if (t > busiestTotal) { busiestTotal = t; busiestIdx = i; } });
  if (busiestIdx >= 0) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - 6);
    const busiestDate = new Date(startOfWeek); busiestDate.setDate(busiestDate.getDate() + busiestIdx);
    const b = buckets[busiestIdx];
    $('insights-ev-highlight').innerHTML = `Busiest day: <b>${dayNames[busiestDate.getDay()]}</b>, ${busiestTotal.toFixed(1)} kWh across ${b.sessions.length} session${b.sessions.length === 1 ? '' : 's'}`;
  }

  // v2.210/v2.211: charging costs — not period-based at all, unlike the
  // rest of this panel. Just today's off-peak/standard rate divided by
  // the Settings-configured range (mile figures) or multiplied directly
  // by the configured usable battery kWh (full-charge figure) — a
  // constant at any given moment, not an aggregate over these 7 days'
  // sessions specifically. Still lives inside this panel (gated by the
  // same hasAnyData check above) rather than always-visible, since it's
  // only relevant once there's some EV charging activity to speak of.
  const milesPerKwh = getEvRangeMiPerKwh();
  if (rateState.offPeakRateP != null && rateState.standardRateP != null && milesPerKwh > 0) {
    const batteryKwh = getEvBatteryKwh();
    const smartPPerMile = rateState.offPeakRateP / milesPerKwh;
    const boostPPerMile = rateState.standardRateP / milesPerKwh;
    $('insights-ev-cost-smart-mile').textContent = `${smartPPerMile.toFixed(1)}p`;
    $('insights-ev-cost-boost-mile').textContent = `${boostPPerMile.toFixed(1)}p`;
    // Per 100 miles: pence/mile × 100 miles = pence total, ÷100 = pounds.
    // (These two operations mathematically cancel out numerically — kept
    // explicit rather than simplified, since a bare "fmtGBP(smartPPerMile)"
    // would look like a copy-paste bug to a future reader, not the correct
    // per-100-miles figure it actually is.)
    $('insights-ev-cost-smart-100mi').textContent = fmtGBP((smartPPerMile * 100) / 100);
    $('insights-ev-cost-boost-100mi').textContent = fmtGBP((boostPPerMile * 100) / 100);
    // Full charge: battery kWh × rate directly, not derived from the
    // per-mile figure a second time — more accurate, avoids compounding
    // the rounding already applied to the displayed per-mile pence figure.
    $('insights-ev-cost-smart-full').textContent = fmtGBP(batteryKwh * rateState.offPeakRateP / 100);
    $('insights-ev-cost-boost-full').textContent = fmtGBP(batteryKwh * rateState.standardRateP / 100);
    $('insights-ev-cost-caption').textContent = `Full charge assumes ${batteryKwh} kWh usable battery (Settings → EV)`;
  } else {
    ['smart-mile', 'boost-mile', 'smart-100mi', 'boost-100mi', 'smart-full', 'boost-full'].forEach(id => {
      $(`insights-ev-cost-${id}`).textContent = '—';
    });
    $('insights-ev-cost-caption').textContent = '—';
  }
}

// Month — the one period needing a genuinely new, wider-range fetch.
// Deliberately drops the `dispatches` sub-field entirely (only needed for
// the Windows view / Day's hourly detail, neither of which apply at
// month scale) — meaningfully lighter payload for ~28-31 sessions worth
// of data. One generous single fetch rather than full multi-page
// pagination, with pageInfo.hasNextPage checked so an unusually heavy
// month is flagged honestly rather than silently under-counted — a real
// pagination loop can be added later if that check ever actually fires.
// first: 400 hit a real error — "Invalid pagination parameters" — while
// the same after/first pattern already works fine at first: 30 on the
// live card query, suggesting a page-size cap rather than a structural
// mistake. Reduced to 100 to test that theory; if this also errors, the
// real cap is lower still and needs finding properly rather than guessed
// again.
async function loadEVMonthData(now) {
  const key = `${now.getFullYear()}-${now.getMonth()}`;
  if (evMonthCache?.key === key) return evMonthCache;
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  try {
    const data = await krakenGQL(`
      query EVMonthHistory($accountNumber: String!, $after: DateTime!) {
        devices(accountNumber: $accountNumber) {
          ... on SmartFlexVehicle {
            chargingSessions(after: $after, first: 100) {
              pageInfo { hasNextPage }
              edges { node { ... on SmartFlexChargingSession { start type energyAdded { value } } } }
            }
          }
        }
      }`, { accountNumber: store.creds.accountNumber, after: startOfMonth.toISOString() });
    const vehicle = (data.devices || []).find(d => d && d.chargingSessions);
    const sessions = (vehicle?.chargingSessions?.edges || []).map(e => e.node).filter(Boolean);
    const hasMore = !!vehicle?.chargingSessions?.pageInfo?.hasNextPage;
    evMonthCache = { key, sessions, hasMore };
    return evMonthCache;
  } catch (err) {
    logIssue('EV month history', err);
    return null;
  }
}

function buildEVMonthBuckets(sessions, now) {
  // Matches Usage's own Month view exactly — only elapsed days, not
  // the full month padded with empty future placeholders. Grows day by
  // day through the month rather than showing a static 31-slot structure
  // with trailing empty bars for days that haven't happened yet.
  const elapsedDays = daysElapsedInMonth(now);
  const buckets = Array.from({ length: elapsedDays }, () => ({ smart: 0, boost: 0, sessions: [] }));
  const dates = Array.from({ length: elapsedDays }, (_, i) => new Date(now.getFullYear(), now.getMonth(), i + 1));
  sessions.forEach(s => {
    const day = new Date(s.start).getDate();
    const kwh = Math.abs(s.energyAdded?.value || 0);
    if (day < 1 || day > elapsedDays) return;
    if (s.type === 'BOOST') buckets[day - 1].boost += kwh; else buckets[day - 1].smart += kwh;
    buckets[day - 1].sessions.push(s);
  });
  const labels = dates.map(d => `${d.getDate()}`);
  return { buckets, labels, dates, dateFormat: 'dayOfMonth' };
}

// Switches Charge History between Day/Week/Month. Month fetches on first
// use only (then cached); Day and Week both reuse evLoadedSessions with
// zero new network cost.
async function setEVHistoryPeriod(period) {
  evHistoryPeriod = period;
  evWeekSelectedDay = null;
  $('ev-week-breakdown').classList.add('hidden');
  document.getElementById('ev-month-partial-note')?.remove();
  document.querySelectorAll('#ev-history-period-toggle .unit-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.period === period);
  });

  const now = new Date();
  let result;
  if (period === 'week') {
    $('ev-history-period-label').textContent = 'This week';
    result = buildEVWeekBuckets(evLoadedSessions || [], now);
  } else {
    $('ev-history-period-label').textContent = 'This month';
    const monthData = await loadEVMonthData(now);
    if (!monthData) {
      $('ev-week').innerHTML = '<div class="slot">Unable to load right now</div>';
      $('ev-week-scale').innerHTML = '';
      $('ev-week-kwh-total').textContent = '—';
      $('ev-week-session-count').textContent = '—';
      renderDiagnostics(); // logIssue() only records the error, doesn't redraw the panel — without this, a failure from this on-demand action stays invisible until the next scheduled sync happens to redraw it
      return;
    }
    result = buildEVMonthBuckets(monthData.sessions, now);
    if (monthData.hasMore) {
      $('ev-week').insertAdjacentHTML('afterend', '<div class="warning-line amber" id="ev-month-partial-note" style="margin-top:10px;margin-bottom:0;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Showing partial data — more sessions exist than fetched</div>');
    }
  }

  evWeekBuckets = result.buckets;
  evHistoryDates = result.dates;
  evHistoryDateFormat = result.dateFormat;
  renderEVHistoryBars(result.buckets, result.labels);
}

function renderEVWeekBreakdown(index) {
  const box = $('ev-week-breakdown');
  const bucket = evWeekBuckets?.[index];
  if (!bucket || !bucket.sessions.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const date = evHistoryDates?.[index];
  let dateLabel = '';
  if (evHistoryDateFormat === 'weekday') {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    dateLabel = dayNames[date.getDay()];
  } else if (evHistoryDateFormat === 'hour') {
    dateLabel = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (evHistoryDateFormat === 'dayOfMonth') {
    dateLabel = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  const smartSessions = bucket.sessions.filter(s => s.type !== 'BOOST');
  const boostSessions = bucket.sessions.filter(s => s.type === 'BOOST');
  const total = bucket.smart + bucket.boost;
  // v2.192: per-fuel-type and total estimated cost, same
  // estimateSessionCostP() used elsewhere. A group (Smart or Boost) only
  // shows its cost if every session in it has one — a partial sum inside
  // a single fuel-type line would be misleading the same way a partial
  // period total would be. The combined Total cost only shows if every
  // session in the whole bucket has a cost, for the same reason.
  const costSuffix = costP => costP != null ? ` · £${(costP / 100).toFixed(2)}` : '';
  const smartCostsP = smartSessions.map(estimateSessionCostP);
  const smartCostP = smartCostsP.every(c => c != null) ? smartCostsP.reduce((s, c) => s + c, 0) : null;
  const boostCostsP = boostSessions.map(estimateSessionCostP);
  const boostCostP = boostCostsP.every(c => c != null) ? boostCostsP.reduce((s, c) => s + c, 0) : null;
  const allCostsP = bucket.sessions.map(estimateSessionCostP);
  const totalCostP = allCostsP.every(c => c != null) ? allCostsP.reduce((s, c) => s + c, 0) : null;
  let rows = '';
  if (smartSessions.length) {
    rows += `<div class="breakdown-row"><span class="label"><span class="dot" style="background:var(--mint)"></span>Smart</span><span class="val">${smartSessions.length} session${smartSessions.length === 1 ? '' : 's'} · ${bucket.smart.toFixed(1)} kWh${costSuffix(smartCostP)}</span></div>`;
  }
  if (boostSessions.length) {
    rows += `<div class="breakdown-row"><span class="label"><span class="dot" style="background:var(--pink)"></span>Boost</span><span class="val">${boostSessions.length} session${boostSessions.length === 1 ? '' : 's'} · ${bucket.boost.toFixed(1)} kWh${costSuffix(boostCostP)}</span></div>`;
  }
  box.innerHTML = `<div class="breakdown-date">${dateLabel}</div>${rows}<div class="breakdown-total"><span>Total</span><span>${total.toFixed(1)} kWh${costSuffix(totalCostP)}</span></div>`;
}

let evWeekBuckets = null;
let evWeekSelectedDay = null;
let evHistoryPeriod = 'week';
let evLoadedSessions = null;
let evMonthCache = null; // { key: 'YYYY-M', sessions: [...] } — avoids refetching when toggling back to a month already viewed
let evHistoryDates = null;
let evHistoryDateFormat = 'weekday';
let evViewMode = 'dispatch'; // v2.150: tracks the user's Dispatch/Sessions tab choice so re-renders (auto-refresh) can reapply it instead of hardcoding dispatch visible

function populateDemoEV() {
    applyEvCollapse(true);
    $('ev-tag').textContent = 'DEMO DATA';
    $('ev-battery-row').classList.add('hidden');
    $('ev-schedule-preview').classList.add('hidden');
    $('ev-warnings').classList.add('hidden');
    $('ev-pmeter').classList.remove('hidden');
    renderPowerMeter(2.3);
    $('ev-view-toggle').classList.add('hidden');
    $('ev-week-legend').classList.remove('hidden');
    $('ev-slots-dispatch').classList.remove('hidden');
    $('ev-slots-dispatch').innerHTML = `
      <div class="slot done"><span>00:30 – 04:00</span><b><span class="live-dot-label"><svg class="completed-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>Completed · 22.1 kWh</span></b></div>
      <div class="slot active"><span>● 04:00 – 05:30</span><b>Dispatching now · 7.4kW</b></div>
      <div class="slot"><span>Planned tonight</span><b>23:30 – 05:30</b></div>`;
    renderWeekBars('ev-week', [3.0, 2.2, 4.8, 0.1, 3.6, 2.6, 4.4], '', v => `${v.toFixed(1)} kWh`, 44, 'ev-week-scale');
    $('ev-history-period-label').textContent = 'This week';
    $('ev-week-kwh-total').textContent = '62.4 kWh';
    $('ev-week-session-count').textContent = '9';
    $('insights-ev-panel').classList.add('hidden');
}

// The four handlers below were originally inline arrow functions wired up
// in app.js's init() — moved here verbatim (not just their state) so
// init() stays pure DOM-event wiring and every EV state variable
// (evManualOverride, evViewMode, evWeekSelectedDay, evHistoryPeriod) stays
// entirely private to this module. A bare `evManualOverride = ...`
// reassignment from app.js isn't possible once this state lives here (ESM
// import bindings can't be reassigned by the importer) — relocating the
// whole handler sidesteps that far more cleanly than exporting a setter
// per variable.

export function handleEvHeaderClick() {
  const currentlyExpanded = !$('ev-body').classList.contains('hidden');
  evManualOverride = !currentlyExpanded;
  $('ev-body').classList.toggle('hidden', !evManualOverride);
  $('ev-card').classList.toggle('ev-collapsed', !evManualOverride);
  $('ev-chevron').textContent = evManualOverride ? '▾' : '▸';
  $('ev-header').setAttribute('aria-expanded', String(evManualOverride));
}

export function handleEvViewToggleClick(e) {
  const btn = e.target.closest('.unit-toggle-btn');
  if (!btn) return;
  const view = btn.dataset.view;
  evViewMode = view; // v2.150: persisted so re-renders (auto-refresh) reapply the chosen tab instead of resetting to Dispatch
  $('ev-view-dispatch-btn').classList.toggle('active', view === 'dispatch');
  $('ev-view-session-btn').classList.toggle('active', view === 'session');
  $('ev-slots-dispatch').classList.toggle('hidden', view !== 'dispatch');
  $('ev-slots-session').classList.toggle('hidden', view !== 'session');
  // v2.194 fix: this handler gives immediate feedback on tab click,
  // separate from loadEVSmartFlex()'s own periodic re-render (every
  // 5 min) — but it predates the v2.191 show-more/show-less wrap and
  // was never updated to know about it, so the wrap only ever got its
  // visibility corrected on the next scheduled re-render, not on the
  // actual click. Confirmed live: switching to Sessions showed the tab
  // content immediately but left the button invisible until an
  // auto-refresh happened to run minutes later. The element may not
  // exist yet on the very first click before loadEVSmartFlex has ever
  // run once, hence the optional-chaining guard.
  $('ev-sessions-toggle-wrap')?.classList.toggle('hidden', view !== 'session');
}

export function handleEvWeekClick(e) {
  const bar = e.target.closest('.ev-week-stack');
  if (!bar) return;
  const index = parseInt(bar.dataset.i, 10);
  if (Number.isNaN(index)) return;
  evWeekSelectedDay = (evWeekSelectedDay === index) ? null : index;
  document.querySelectorAll('#ev-week .ev-week-stack').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.i, 10) === evWeekSelectedDay);
  });
  document.querySelectorAll('#ev-week span[data-i]').forEach(el => {
    el.classList.toggle('active-day', parseInt(el.dataset.i, 10) === evWeekSelectedDay);
  });
  if (evWeekSelectedDay === null) $('ev-week-breakdown').classList.add('hidden');
  else renderEVWeekBreakdown(evWeekSelectedDay);
}

export function handleEvHistoryPeriodToggleClick(e) {
  const btn = e.target.closest('.unit-toggle-btn');
  if (!btn || btn.dataset.period === evHistoryPeriod) return;
  setEVHistoryPeriod(btn.dataset.period);
}
