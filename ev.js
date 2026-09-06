import { store, demoFallbackEnabled } from './store.js';
import { $, fmtGBP, fmtT, formatElapsed } from './format.js';
import { logIssue, logDebug, sanityCheck, renderDiagnostics } from './diagnostics.js';
import { krakenGQL } from './api.js';
import { renderPowerMeter, renderChartScale, chartMax, isChartDense, chartLabelOrBlank, renderWeekBars } from './charts.js';
import { estimateSessionCostP, rateState } from './rates.js';
import { daysElapsedInMonth } from './usage.js';
import { ensureHistIntensity, intensityForRange, intensityMeanInHourBand, carbonBandForRange, ensureCarbonForecast, carbonForecastForRange } from './carbon.js';

// Settings takes an optional WLTP spec pair (range in miles, usable battery
// kWh); the mi/kWh ratio is derived from it per-account. This fallback
// (Polestar 2 Standard Range: 67kWh usable, 322mi WLTP → 322/67 ≈ 4.8)
// applies when Settings is unfilled.
const EV_RANGE_MI_PER_KWH_FALLBACK = 4.8;
function getEvRangeMiPerKwh() {
  const c = store.creds || {};
  if (c.wltpMiles > 0 && c.wltpBatteryKwh > 0) return c.wltpMiles / c.wltpBatteryKwh;
  return EV_RANGE_MI_PER_KWH_FALLBACK;
}
// Usable battery kWh directly (not the derived ratio) — for "cost to fully
// charge" (kWh × rate) and the header caption. Same 67kWh fallback.
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

// Vehicle registration (make/model) never changes in normal use, so it's
// fetched once ever and cached in localStorage; every later call is a no-op.
// Query shape is a guess from a community GitHub issue, not official docs —
// confirmed working against a real account but wrapped defensively.
//
// Make on the title line, model as a smaller caption beneath. Battery kWh is
// appended to the caption via " · " rather than merged into the model
// string, because Octopus's raw model text sometimes already contains a
// (gross) kWh figure that wouldn't match Settings' usable-kWh value.
export function formatVehicleName(make, model) {
  if (!make) return { title: '', caption: '' };
  const batteryNote = `${getEvBatteryKwh()} kWh usable`;
  const caption = model ? `${model} · ${batteryNote}` : batteryNote;
  return { title: ` — ${make}`, caption };
}

export async function loadVehicleInfoOnce() {
  const creds = store.creds || {};
  if (creds.vehicleChecked) {
    // Prefer the user's saved custom name, falling back to the device record.
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
    // Same custom-name preference as the cached path above — only the raw
    // API values (vehicleMake/vehicleModel) are overwritten here, so a saved
    // override keeps showing even after the API values change underneath it.
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

// EV cost is an estimate (kWh × today's approximated rate), never a real
// Octopus figure — no API path exposes the per-dispatch reconciled rate.
// See README "Considered and decided against" for the full investigation.

export async function loadEV() {
  const smartFlexOk = await loadEVSmartFlex().catch(err => { logIssue('EV SmartFlex data', err); return false; });
  if (smartFlexOk) return true;

  // A failed sync shows a genuine Unavailable state, not a fallback to
  // older/less accurate data; recovers on the next auto-sync. The old
  // dispatch-only path is in ev-legacy-archive.js if this needs revisiting.
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
    $('ev-history-period-label').textContent = 'Week';
    $('ev-week-kwh-total').textContent = '—';
    $('ev-week-session-count').textContent = '—';
    $('insights-ev-panel').classList.add('hidden');
  }
  return false;
}

// devices → SmartFlexVehicle → chargingSessions. devices() takes no
// deviceType filter (confirmed by a runtime error), so it returns every
// device and the client-side .find(d => d.chargingSessions) does the real
// filtering. Fields confirmed via live introspection except
// SmartFlexChargingProblem, deliberately left out rather than guessed.
// cost.amount's unit is assumed pounds decimal (unconfirmed).
//
// SmartFlexDispatch.dispatches (per-window detail inside a session) was
// dropped from the query: it came back empty on this account, and its only
// consumer (the removed Day view) is gone. completedDispatches (fetched
// below) is the replacement for the Windows tab's Completed rows. Known
// limitation: it caps at ~24 entries, so a long overnight charge on a slow
// charger shows only its most recent ~24 windows — which is why "This
// session"'s kWh total is NOT summed from this data.
const badgeHtml = type => `<span class="slot-badge ${type === 'BOOST' ? 'badge-boost' : 'badge-smart'}">${type}</span>`;

// Small grid-intensity marker for a dispatch-window row — a leaf glyph plus
// the figure, coloured mint/amber/coral to match the Carbon card's
// low/moderate/high ramp. Empty when there's no matched intensity for the
// window (history not warmed that far back, or beyond the 48h forecast).
const leafSvgSm = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>';
const carbonChip = (band, g) => (band && g != null)
  ? `<span class="win-carbon win-carbon-${band}" title="Grid carbon intensity over this window">${leafSvgSm}${g} g</span>`
  : '';

// SmartFlexChargingProblem — a union of SmartFlexChargingError (a `cause`
// enum) and SmartFlexChargingTruncation (a `truncationCause` enum, charge
// cut short before its planned target). Both enums mix benign outcomes in
// with real problems; the benign ones below just describe a normal or
// intentional outcome, so no warning badge (coral only ever means a genuine
// problem). Everything else in both enums is a real one.
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
const warnTriangleSvgSm = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';

let expandedProblemSessions = new Set(); // keys = session start ISO strings, survives re-renders
let lastRenderedSessions = null, lastRenderedNow = null; // so the click handler can re-render without needing to know which list (8-day/expanded) is currently showing

// Sessions-tab renderer, factored out so it runs against either the default
// 8-day `sessions` array or a wider on-demand fetch (see showMoreEVSessions).
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
    // No SoC start→finish % — there's no real measured start point (using
    // the previous session's final % only holds if nothing touched the
    // battery in between). Miles added is computed client-side from kWh, so
    // marked "(Est.)". Coloured by session type (mint Smart / pink Boost),
    // matching the SMART/BOOST badge and mint's app-wide "cheaper" role.
    const milesText = kwh != null
      ? `<span class="slot-miles-line"><span class="slot-soc-gain ${s.type === 'BOOST' ? 'slot-miles-boost' : 'slot-miles-smart'}">+${Math.round(Math.abs(kwh) * getEvRangeMiPerKwh())} miles</span><span class="slot-soc-gain"> (Est.)</span></span>`
      : '';
    // Problem warning: a small icon-only toggle that reveals a detail row
    // with the full message on click. Expand state is keyed by session start
    // time in expandedProblemSessions so it survives re-renders.
    const problem = realProblemLabel(s);
    const problemKey = s.start;
    const isExpanded = problem && expandedProblemSessions.has(problemKey);
    const miniPillHtml = problem
      ? `<button type="button" class="badge-problem-mini" data-problem-key="${problemKey}" aria-expanded="${isExpanded}">${warnTriangleSvgSm}</button>`
      : '';
    const detailRowHtml = isExpanded
      ? `<div class="slot-row" style="margin-top:2px;"><span class="slot-badge badge-problem" style="margin-left:0;">${warnTriangleSvgSm}${problem}</span></div>`
      : '';
    // Estimated cost — right-aligned under the miles figure, at the kWh
    // figure's size. See estimateSessionCostP for why today's rate is used.
    const costP = estimateSessionCostP(s);
    const costLine = costP != null ? `<span class="slot-cost-line">${fmtGBP(costP / 100)} <span class="est">(Est.)</span></span>` : '';
    // Carbon for the session: mean regional grid intensity over its window
    // (from carbon.js's on-demand history cache) × kWh. Sits on the same line
    // as the cost — left of it, under the kWh figure — absent when the
    // history fetch didn't reach this far back.
    const gPerKwh = kwh != null ? intensityForRange(startD.getTime(), new Date(s.end).getTime()) : null;
    const co2Text = gPerKwh != null
      ? `≈ <b>${(Math.abs(kwh) * gPerKwh / 1000).toFixed(1)} kg</b> CO₂ · grid avg ${Math.round(gPerKwh)} g/kWh`
      : '';
    const row2 = (co2Text || costLine)
      ? `<div class="slot-row-inline slot-row-inline-2"><span class="slot-co2">${co2Text}</span><span class="soc-col">${costLine}</span></div>`
      : '';
    // Carbon-band leaf, left of the SMART/BOOST pill (and right of the
    // problem-warning pill) — a quick visual read of how clean the grid was
    // while this session charged (mint/amber/coral), mirroring the
    // dispatch-window chips. Absent when the intensity history doesn't reach
    // this session.
    const co2Band = kwh != null ? carbonBandForRange(startD.getTime(), new Date(s.end).getTime()) : null;
    const bandLeaf = co2Band ? `<span class="slot-leaf slot-leaf-${co2Band}" title="Grid carbon while charging: ${co2Band}">${leafSvgSm}</span>` : '';
    return `<div class="slot">
      <div class="slot-row"><span><span class="slot-date">${dayLabel}</span> · ${fmtT(s.start)} – ${fmtT(s.end)}${elapsed ? ` (${elapsed})` : ''}</span><span class="slot-row-right">${miniPillHtml}${bandLeaf}${badgeHtml(s.type)}</span></div>
      <div class="slot-row-inline"><span class="left-group"><b>${kwh != null ? Math.abs(kwh).toFixed(1) + ' kWh' : '—'}</b></span><span class="soc-col">${milesText}</span></div>
      ${row2}
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

// "Show more" doubles the window (8→16→32→64…), re-fetching only tiers not
// already in evSessionsCache; "Show less" reverts straight to the 8-day
// base. A separate on-demand fetch, not a widening of the default 8-day
// query, so nothing depending on that scope (mini-stats, Windows tab) is
// affected. first: 30 is the only value on this field confirmed safe
// anywhere in the app; first: 200 hit "Invalid pagination parameters", so
// pageInfo.hasNextPage is surfaced honestly rather than guessing a higher cap.
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
    await ensureHistIntensity(now.getTime() - nextDays * 24 * 60 * 60 * 1000);
    renderEVSessionSlots(cached, now);
    lessBtn.classList.remove('hidden');
    return;
  }
  const original = moreBtn.querySelector('span').textContent;
  moreBtn.querySelector('span').textContent = 'Loading…';
  moreBtn.disabled = true;
  try {
    const sessions = await fetchEVSessionsWindow(nextDays);
    renderDiagnostics(); // redraw now so logDebug output shows immediately, not at the next scheduled sync
    if (sessions.length) {
      evSessionsCache.set(nextDays, sessions);
      evSessionsWindowDays = nextDays;
      await ensureHistIntensity(now.getTime() - nextDays * 24 * 60 * 60 * 1000);
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
  if (!vehicle) return false; // no EV device on this path, or wrong shape

  const sessions = (vehicle.chargingSessions?.edges || []).map(e => e.node).filter(Boolean);
  evLoadedSessions = sessions;
  const planned = data.plannedDispatches || [];
  const now = new Date();

  // Warm both grid-intensity feeds before rendering: history (back to the
  // oldest session on screen) for the per-session CO₂ lines, the weekly
  // carbon insight and completed-window tags; the 48h forecast for the
  // planned/active dispatch-window tags. Both best-effort — a failure just
  // omits those figures.
  const oldestSessionMs = sessions.reduce(
    (min, s) => Math.min(min, new Date(s.start).getTime()),
    now.getTime() - 8 * 24 * 60 * 60 * 1000
  );
  await Promise.allSettled([ensureHistIntensity(oldestSessionMs), ensureCarbonForecast()]);
  const isActiveWindow = (d, n) => n >= new Date(d.start) && n < new Date(d.end);
  const activeDispatch = planned.find(d => isActiveWindow(d, now));
  // completedDispatches comes back in reverse time order; sorted ascending
  // to match the Planned rows below (oldest-first), so the combined Windows
  // list reads one direction top to bottom. `delta` is negative for import
  // (Math.abs where used). No date-range arg, so filtered client-side to the
  // same rolling window as sessions.
  const windowStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const completedDispatchWindows = (data.completedDispatches || [])
    .filter(d => new Date(d.start) >= windowStart)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  $('ev-tag').textContent = activeDispatch ? 'CHARGING' : (planned.length ? 'SCHEDULED' : 'IDLE');
  $('ev-tag').className = activeDispatch ? 'card-tag tag-pink' : (planned.length ? 'card-tag tag-amber' : 'card-tag tag-dim');
  applyEvCollapse(!!activeDispatch || planned.length > 0);

  // Target SoC/time — a list of per-day schedule entries
  // (SmartFlexDeviceSchedule: dayOfWeek/time/max), matched on today's
  // day-of-week. DayOfWeek enum values assumed to be uppercase day names
  // (a wrong guess just shows no target text, it can't break the query).
  // Computed here, above the battery gauge, so the gauge's limit marker can
  // reuse it.
  const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const schedules = vehicle.preferences?.schedules || [];
  const todaySchedule = schedules.find(s => s.dayOfWeek === dayNames[now.getDay()]);

  // Battery gauge
  const soc = vehicle.status?.stateOfCharge?.value;
  if (soc != null) {
    $('ev-battery-row').classList.remove('hidden');
    const pct = Math.min(100, Math.max(0, soc));
    $('ev-battery-pct').innerHTML = `${Math.round(pct)}<span>%</span>`;
    $('ev-battery-fill').style.width = `${pct}%`;

    // Limit marker: prefer today's schedule target (todaySchedule.max, what
    // actually governs charging day to day), falling back to the device-level
    // stateOfChargeLimit.upperSocLimit only if no schedule entry exists for
    // today — that field is null on this account even with a target in
    // effect. The restricted zone shows whenever SoC hasn't passed the limit
    // (limitPct >= pct), so it stays visible at "Target reached" too.
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

  // Target SoC/time text (todaySchedule computed above).
  if (todaySchedule && todaySchedule.max != null && todaySchedule.time) {
    $('ev-battery-target').textContent = `Target ${Math.round(todaySchedule.max)}% by ${todaySchedule.time.slice(0, 5)}`;
    // "Target reached" once SoC hits it; otherwise a countdown, but only
    // while today's target time is still ahead (a passed target would give
    // a nonsensical negative countdown).
    if (soc != null && soc >= todaySchedule.max) {
      $('ev-battery-countdown').textContent = 'Target reached';
    } else {
    const [th, tm] = todaySchedule.time.split(':').map(Number);
    let targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), th, tm);
    // The target time recurs daily, so if today's occurrence has passed,
    // roll to tomorrow's — otherwise the countdown goes blank during an
    // overnight charge past a morning target, which is the normal case.
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

  // Weekly schedule preview — shows each day's target time (most accounts
  // have every day scheduled, so the time is what's worth comparing, not
  // set-vs-unset). Days with no entry show "—". Highlights whichever target
  // is still upcoming, not "today": a day's entry is an overnight charge
  // completing that morning, so once today's target time has passed it's
  // tomorrow's that matters.
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

  // currentState — Octopus's device state machine. Most values are one-time
  // onboarding milestones that sit fixed for an established device; only the
  // states that vary day-to-day for a live device are surfaced.
  // BOOSTING/SMART_CONTROL_IN_PROGRESS are normal operation, not warnings.
  const state = vehicle.status?.currentState;

  if (state === 'LOST_CONNECTION') {
    warnings.push({ level: 'coral', text: 'Lost connection to vehicle' });
  } else if (state === 'SMART_CONTROL_OFF') {
    warnings.push({ level: 'amber', text: 'Smart control is currently off' });
  } else if (state === 'SMART_CONTROL_NOT_AVAILABLE') {
    // Fires whenever the vehicle is simply disconnected — not a fault.
    // Suppressed while the panel tag reads IDLE; still shown if a dispatch
    // is scheduled or active, where it would be a real problem.
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

  // Flag Boost sessions from the last 7 days — a lightweight insight that
  // reuses this area's styling. Boost is a manual charge outside the smart
  // schedule, so a type check is a reliable signal without needing to detect
  // "charged during a peak window" directly.
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

  // Half-hourly windows don't scale to an overnight session (a 12h charge
  // is 24 rows), so contiguous windows are grouped into runs; a real gap
  // starts a new run. No badgeHtml — this data source has no Smart/Boost
  // type field.
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
  // One summary line per run (time span + total kWh); a run of 1 window and
  // a run of 9 render identically. No per-window expand — once the total's
  // shown, per-window granularity (0.4 kWh at 09:00…) isn't worth a tap.
  dispatchSlots.innerHTML = runs.map((r) => {
    const totalKwh = r.windows.reduce((sum, d) => sum + Math.abs(d.delta || 0), 0);
    const rs = new Date(r.start).getTime(), re = new Date(r.end).getTime();
    const g = intensityForRange(rs, re);
    const chip = g != null ? carbonChip(carbonBandForRange(rs, re), Math.round(g)) : '';
    const summaryLabel = `${fmtT(r.start)} – ${fmtT(r.end)} · ${totalKwh.toFixed(1)} kWh`;
    return `<div class="slot done"><span>${summaryLabel}${chip}</span><b><span class="live-dot-label">${runIcon}Completed</span></b></div>`;
  }).join('');
  // The "only recent windows shown" note appears only when Completed AND
  // visible Planned are both empty — i.e. the tab would otherwise show
  // nothing at all (checking Completed alone left it sitting above genuine
  // Planned rows).
  const visiblePlanned = planned.filter(d => isActiveWindow(d, now) || new Date(d.end) > now);
  if (!completedDispatchWindows.length && sessions.length && !visiblePlanned.length) {
    dispatchSlots.insertAdjacentHTML('beforeend', '<div class="slot"><span>Only completed windows within the last 12 hours are shown here. See Sessions tab for full charging history.</span></div>');
  }
  // plannedDispatches can hold stale entries whose time has fully passed
  // without being cleared, if Octopus revises the schedule and supersedes
  // an old window (seen: an old "00:30–01:00" still marked "Planned" after
  // 01:00, above the active "01:00–12:00" that replaced it). visiblePlanned
  // above filters those out.
  visiblePlanned.forEach(d => {
    const isActive = isActiveWindow(d, now);
    // Active = lightning bolt (the panel's "charging" symbol), planned =
    // clock. Pulse animation is on the .dispatch-icon class.
    const iconHtml = isActive
      ? '<svg class="dispatch-icon" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
      : '<svg class="planned-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>';
    const label = `<span class="live-dot-label">${iconHtml}${isActive ? 'Dispatching now' : 'Planned'}</span>`;
    const cls = isActive ? ' active' : ' scheduled';
    // Forecast intensity for the window — the "is my upcoming charge landing
    // in the green?" signal, right where the schedule is listed.
    const fc = carbonForecastForRange(new Date(d.start).getTime(), new Date(d.end).getTime());
    const chip = fc ? carbonChip(fc.band, fc.g) : '';
    dispatchSlots.insertAdjacentHTML('beforeend', `<div class="slot${cls}"><span>${fmtT(d.start)} – ${fmtT(d.end)}${chip}</span><b>${label}</b></div>`);
  });
  if (!dispatchSlots.children.length) dispatchSlots.innerHTML = '<div class="slot">No dispatch windows scheduled</div>';

  // Session view. Guarded on evSessionsWindowDays === 8: once the user has
  // expanded, a later auto-refresh must not re-render with the narrow 8-day
  // list, or the expanded view would silently revert. Tradeoff: the expanded
  // view then goes static until a full reload — better than undoing an
  // explicit choice.
  evDefaultSessions = sessions;
  attachEVProblemToggleListener();
  if (evSessionsWindowDays === 8) renderEVSessionSlots(sessions, now);

  // "Show more" / "Show less" — a centered button pair. "Show more" is
  // always visible; "Show less" appears once expanded and reverts to the
  // 8-day base. Visibility is tied to evViewMode a few lines below so the
  // pair only shows under the Sessions tab.
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

  // Reapply the selected tab — every render above un-hides dispatchSlots to
  // rebuild it, which would otherwise leave Dispatch showing after an
  // auto-refresh regardless of what the user had selected.
  $('ev-slots-dispatch').classList.toggle('hidden', evViewMode !== 'dispatch');
  $('ev-slots-session').classList.toggle('hidden', evViewMode !== 'session');
  $('ev-view-dispatch-btn').classList.toggle('active', evViewMode === 'dispatch');
  $('ev-view-session-btn').classList.toggle('active', evViewMode === 'session');
  $('ev-sessions-toggle-wrap').classList.toggle('hidden', evViewMode !== 'session');

  $('ev-view-toggle').classList.remove('hidden');
  $('ev-week-legend').classList.remove('hidden');

  // Power meter, shown only while actively charging (a real power reading
  // exists); kept out of the DOM otherwise rather than showing a placeholder.
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

// Shared bar+scale+legend renderer for the EV history chart — identical
// drawing logic across Week/Month/Day, only the bucket-building differs.
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

  // Period-total estimated cost. Shown as "—" rather than a partial figure
  // if today's rates haven't loaded or any session lacks an estimate — a
  // partial total would be misleading, not just imprecise.
  const allSessions = buckets.flatMap(b => b.sessions);
  // NB: `.map(s => estimateSessionCostP(s))`, not `.map(estimateSessionCostP)` —
  // the latter passes the array index as the 2nd `rates` arg, so every call
  // returns null (this is why the stat silently went to "—").
  const costsP = allSessions.map(s => estimateSessionCostP(s));
  const costTotalP = costsP.every(c => c != null) ? costsP.reduce((s, c) => s + c, 0) : null;
  $('ev-week-cost-total').textContent = costTotalP != null ? fmtGBP(costTotalP / 100) : '—';

  // Period carbon total — same all-or-"—" rule: shown only when every
  // session's window resolved against the intensity history.
  const co2gList = allSessions.map(s => {
    const g = intensityForRange(new Date(s.start).getTime(), new Date(s.end || s.start).getTime());
    return g != null ? Math.abs(s.energyAdded?.value || 0) * g : null;
  });
  const co2TotalG = co2gList.every(c => c != null) ? co2gList.reduce((s, c) => s + c, 0) : null;
  $('ev-week-co2-total').textContent = co2TotalG != null ? `${(co2TotalG / 1000).toFixed(1)} kg` : '—';

  // Smart/Boost split as an explicit percentage in the legend labels, next
  // to the swatch each describes. Left blank (not hidden) for an empty
  // period — the legend itself still needs to show.
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

// 7 daily buckets from the sessions already loaded for the live card (no
// new fetch).
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

// Streak + busiest-day for the Insights panel. Builds its own week buckets
// rather than reusing Charge History's evWeekBuckets, which changes with
// that card's Day/Week/Month toggle — these are inherently weekly concepts.
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

  // Carbon of this week's Smart charging vs a peak-time charge. kWh-weighted
  // mean of the regional grid intensity over each Smart session's window
  // (from carbon.js's history cache), against the mean intensity of the
  // 4–7pm slots over the same week as the "if you'd charged at peak" baseline.
  // Only Smart sessions — Boost is the user's deliberate choice, not the
  // smart-scheduling story this line is about.
  const weekStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  let smartKwh = 0, smartCo2g = 0;
  for (const bk of buckets) {
    for (const s of bk.sessions) {
      if (s.type === 'BOOST') continue;
      const kwh = Math.abs(s.energyAdded?.value || 0);
      const g = intensityForRange(new Date(s.start).getTime(), new Date(s.end).getTime());
      if (g != null && kwh > 0) { smartKwh += kwh; smartCo2g += kwh * g; }
    }
  }
  const carbonLine = $('insights-ev-carbon');
  if (smartKwh > 0) {
    const avgG = smartCo2g / smartKwh;
    const peakG = intensityMeanInHourBand(weekStartMs, now.getTime(), 16, 19);
    let rel = '';
    if (peakG != null && peakG > 0) {
      const pct = Math.round((1 - avgG / peakG) * 100);
      rel = pct > 0 ? ` · ~${pct}% cleaner than a 4–7pm charge`
        : pct < 0 ? ` · ~${-pct}% dirtier than a typical 4–7pm charge`
          : ' · about the same as a 4–7pm charge';
    }
    carbonLine.innerHTML = `Smart charging this week averaged <b>${Math.round(avgG)} gCO₂/kWh</b>${rel}`;
  } else {
    carbonLine.textContent = '';
  }

  // Charging costs — point-in-time, not period-based like the rest of this
  // panel: today's off-peak/standard rate against the Settings range (per
  // mile) or battery kWh (full charge). Gated by the same hasAnyData check
  // so it only shows once there's some EV activity.
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

// Month is the only period needing a new, wider-range fetch. One generous
// single fetch (first: 100 — first: 400 hit "Invalid pagination
// parameters") rather than multi-page pagination, with pageInfo.hasNextPage
// checked so an unusually heavy month is flagged rather than under-counted.
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
              edges { node { ... on SmartFlexChargingSession { start end type energyAdded { value } } } }
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
  // Elapsed days only, matching Usage's Month view — no trailing empty bars
  // for days that haven't happened yet.
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
    $('ev-history-period-label').textContent = 'Week';
    result = buildEVWeekBuckets(evLoadedSessions || [], now);
  } else {
    $('ev-history-period-label').textContent = 'Month';
    const monthData = await loadEVMonthData(now);
    if (!monthData) {
      $('ev-week').innerHTML = '<div class="slot">Unable to load right now</div>';
      $('ev-week-scale').innerHTML = '';
      $('ev-week-kwh-total').textContent = '—';
      $('ev-week-session-count').textContent = '—';
      renderDiagnostics(); // redraw now so this on-demand failure is visible, not at the next scheduled sync
      return;
    }
    // Warm the intensity history back to the 1st so the month's EST. CO₂
    // stat can resolve every session (the 8-day warm-up in loadEVSmartFlex
    // doesn't reach that far). Best-effort.
    await ensureHistIntensity(new Date(now.getFullYear(), now.getMonth(), 1).getTime());
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
  // Per-type and total estimated cost. A group (Smart/Boost) shows its cost
  // only if every session in it has one; the combined Total only if every
  // session in the bucket does — a partial sum would mislead.
  const costSuffix = costP => costP != null ? ` · £${(costP / 100).toFixed(2)}` : '';
  const smartCostsP = smartSessions.map(s => estimateSessionCostP(s));
  const smartCostP = smartCostsP.every(c => c != null) ? smartCostsP.reduce((s, c) => s + c, 0) : null;
  const boostCostsP = boostSessions.map(s => estimateSessionCostP(s));
  const boostCostP = boostCostsP.every(c => c != null) ? boostCostsP.reduce((s, c) => s + c, 0) : null;
  const allCostsP = bucket.sessions.map(s => estimateSessionCostP(s));
  const totalCostP = allCostsP.every(c => c != null) ? allCostsP.reduce((s, c) => s + c, 0) : null;

  // Same all-or-nothing rule for carbon as for cost: a group's figure shows
  // only if every session in it matched the intensity history.
  const co2Suffix = g => g != null ? ` · ${(g / 1000).toFixed(1)} kg` : '';
  const sessionCo2g = s => {
    const g = intensityForRange(new Date(s.start).getTime(), new Date(s.end || s.start).getTime());
    return g != null ? Math.abs(s.energyAdded?.value || 0) * g : null;
  };
  const groupCo2g = list => { const cs = list.map(sessionCo2g); return cs.length && cs.every(c => c != null) ? cs.reduce((a, b) => a + b, 0) : null; };
  const smartCo2 = groupCo2g(smartSessions);
  const boostCo2 = groupCo2g(boostSessions);
  const totalCo2 = groupCo2g(bucket.sessions);

  // Session count sits with the type label (Smart/Boost), keeping the value
  // line to just the three figures — kWh · cost · carbon — so it doesn't
  // wrap on a phone.
  let rows = '';
  if (smartSessions.length) {
    rows += `<div class="breakdown-row"><span class="label"><span class="dot" style="background:var(--mint)"></span>Smart <span class="bd-count">×${smartSessions.length}</span></span><span class="val">${bucket.smart.toFixed(1)} kWh${costSuffix(smartCostP)}${co2Suffix(smartCo2)}</span></div>`;
  }
  if (boostSessions.length) {
    rows += `<div class="breakdown-row"><span class="label"><span class="dot" style="background:var(--pink)"></span>Boost <span class="bd-count">×${boostSessions.length}</span></span><span class="val">${bucket.boost.toFixed(1)} kWh${costSuffix(boostCostP)}${co2Suffix(boostCo2)}</span></div>`;
  }
  box.innerHTML = `<div class="breakdown-date">${dateLabel}</div>${rows}<div class="breakdown-total"><span>Total</span><span>${total.toFixed(1)} kWh${costSuffix(totalCostP)}${co2Suffix(totalCo2)}</span></div>`;
}

let evWeekBuckets = null;
let evWeekSelectedDay = null;
let evHistoryPeriod = 'week';
let evLoadedSessions = null;
let evMonthCache = null; // { key: 'YYYY-M', sessions: [...] } — avoids refetching when toggling back to a month already viewed
let evHistoryDates = null;
let evHistoryDateFormat = 'weekday';
let evViewMode = 'dispatch'; // the user's Dispatch/Sessions tab choice, so re-renders reapply it instead of resetting to Dispatch

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
    $('ev-history-period-label').textContent = 'Week';
    $('ev-week-kwh-total').textContent = '62.4 kWh';
    $('ev-week-session-count').textContent = '9';
    $('insights-ev-panel').classList.add('hidden');
}

// These four handlers live here rather than in main.js's init() so every EV
// state variable (evManualOverride, evViewMode, evWeekSelectedDay,
// evHistoryPeriod) stays private to this module.

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
  evViewMode = view;
  $('ev-view-dispatch-btn').classList.toggle('active', view === 'dispatch');
  $('ev-view-session-btn').classList.toggle('active', view === 'session');
  $('ev-slots-dispatch').classList.toggle('hidden', view !== 'dispatch');
  $('ev-slots-session').classList.toggle('hidden', view !== 'session');
  // Correct the show-more/show-less wrap's visibility here too, not just on
  // the next periodic re-render. Optional-chained: the element may not exist
  // yet on the very first click before loadEVSmartFlex has run.
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
