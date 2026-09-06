/* ==========================================================================
   Kraken Watch — entry point (init, event wiring, refresh tiers).
   -------------------------------------------------------------------------
   - Octopus REST API (consumption, tariffs, account/balance): documented,
     stable, API key over HTTP Basic Auth.
   - Kraken GraphQL API (Intelligent Octopus Go dispatches): the same API
     the official Octopus app uses, but not officially published — field
     names come from community reverse-engineering (the Home Assistant
     Octopus Energy integration) and may need adjusting if the schema
     changes. On a GraphQL failure the EV card falls back to demo data and
     flags itself rather than breaking the page.
   ========================================================================== */

import { store, logSyncAttempt, demoFallbackEnabled } from './store.js';
import { $, fmtP, APP_VERSION } from './format.js';
import { resetDiagnostics, logIssue, logRawDebug, getSyncIssues, renderDiagnostics } from './diagnostics.js';
import { checkRateLimitBlocked } from './api.js';
import { clearRateCacheIfNewDay, rateState, fetchElecRates, rateAt } from './rates.js';
import {
  loadLiveUsage, loadLive30, closeLive30, openLive30, isLive30Open, pauseLive30Polling, resumeLive30PollingIfOpen,
} from './live-usage.js';
import {
  loadEV, loadVehicleInfoOnce,
  handleEvHeaderClick, handleEvViewToggleClick, handleEvWeekClick, handleEvHistoryPeriodToggleClick,
} from './ev.js';
import {
  handleUnitToggleClick, handlePeriodToggleClick, handleDatePickerBtnClick,
  handlePickerPrevMonthClick, handlePickerNextMonthClick, handlePickerGridClick,
  handleResetToTodayClick, handleFuelWeekBarClick, handleElecDayBarClick,
} from './usage.js';
import { loadBilling, handleBillYearBarClick } from './billing.js';
import { loadCarbon, gridCarbonText } from './carbon.js';
import { handleInsightsHeaderClick, handleInsightsRunwayBarClick } from './insights.js';
import { handleHeatmapToggle } from './heatmap.js';
import { loadOctoplus, handleOctoplusResultsToggle } from './octoplus.js';
import { meterDebugNote, openSettings, closeSettings, saveSettings, initTheme, handleAppearanceChange } from './settings.js';

/* ------------------------------ Rendering -------------------------------- */

function setSyncStatus(state, label) {
  const dot = $('sync-dot');
  dot.className = 'dot' + (state === 'stale' ? ' stale' : state === 'error' ? ' error' : '');
  $('sync-text').textContent = label;
}

/* ------------------------------ Data loaders ------------------------------ */

async function loadRates() {
  try {
    const now = new Date();
    // Build the day boundary from local date components and let
    // `.toISOString()` do the UTC conversion — don't assemble a
    // UTC-labelled string from a UTC-derived date and treat it as local.
    // During BST that shifted the whole 24h rate window ~1h early, so for
    // about an hour each night the fetch anchored to yesterday's UTC date.
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(+dayStart + 24 * 60 * 60 * 1000 - 60000);
    const fromISO = dayStart.toISOString();
    const toISO = dayEnd.toISOString();
    const rows = await fetchElecRates(fromISO, toISO);
    if (!rows.length) throw new Error('No rate data returned');

    // Still expand into 48 half-hourly points — not drawn as a curve anymore,
    // but used for today's average/max and the off-peak threshold check.
    const points = Array.from({ length: 48 }, (_, i) => {
      const t = +dayStart + i * 30 * 60 * 1000;
      return rateAt(rows, t) ?? rows[0].rate;
    });

    const nowIdx = Math.min(47, Math.floor((now - dayStart) / (30 * 60 * 1000)));
    const current = points[nowIdx];
    const threshold = Math.min(...points) + 1; // treat near-minimum as off-peak window

    rateState.offPeakRateP = Math.min(...points);
    rateState.currentRateP = current;
    rateState.standardRateP = Math.max(...points);

    $('rate-value').innerHTML = `${Math.round(current)}<span>p/kWh</span>`;
    $('elec-unit-rate').textContent = `${current.toFixed(1)}p`;
    const isCheap = current <= threshold;
    $('rate-value').style.color = isCheap ? 'var(--mint)' : 'var(--pink)';
    $('rate-pill').className = 'card-tag ' + (isCheap ? 'tag-mint' : 'tag-pink');
    $('rate-pill').innerHTML = isCheap ? '<span class="status-dot"></span>Off-peak' : '<span class="status-dot pink"></span>Standard';
    $('rate-standard').textContent = fmtP(Math.max(...points));
    $('rate-offpeak').textContent = fmtP(rateState.offPeakRateP);

    // Next change: look at the actual rate-change rows, not the expanded points.
    const nextRow = rows.find(r => r.from > +now);
    if (nextRow) {
      const d = new Date(nextRow.from);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      $('rate-next').textContent = `${hh}:${mm} → ${nextRow.rate.toFixed(2)}p`;
    } else {
      $('rate-next').textContent = 'No change today';
    }
    $('rate-carbon').textContent = gridCarbonText(); // whatever the carbon feed has so far ("—" until its first load)
    return true;
  } catch (err) {
    logIssue('Rates', err);
    if (demoFallbackEnabled()) {
      rateState.offPeakRateP = 7.5;
      rateState.currentRateP = 7.5;
      rateState.standardRateP = 28.9;
      $('rate-value').innerHTML = `8<span>p/kWh</span>`;
      $('rate-value').style.color = 'var(--mint)';
      $('elec-unit-rate').textContent = '7.5p (demo)';
      $('rate-pill').className = 'card-tag tag-mint';
      $('rate-pill').innerHTML = '<span class="status-dot"></span>Off-peak (demo)';
      $('rate-standard').textContent = '28.9p';
      $('rate-offpeak').textContent = '8.0p';
      $('rate-next').textContent = '05:30 → 28.90p';
      $('rate-carbon').textContent = gridCarbonText();
    } else {
      $('rate-value').innerHTML = `—<span>p/kWh</span>`;
      $('rate-value').style.color = 'var(--text-dim)';
      $('elec-unit-rate').textContent = 'Unavailable';
      $('rate-pill').className = 'card-tag tag-dim';
      $('rate-pill').innerHTML = '<span class="status-dot dim"></span>Unavailable';
      $('rate-standard').textContent = '—';
      $('rate-offpeak').textContent = '—';
      $('rate-next').textContent = '—';
      $('rate-carbon').textContent = gridCarbonText();
    }
    return false;
  }
}

export async function loadAll(source = 'app-start') {
  const apiKeySnapshot = store.creds?.apiKey;
  setSyncStatus('ok', 'Syncing…');
  resetDiagnostics();
  if (meterDebugNote) logRawDebug(`Meter selection: ${meterDebugNote}`);
  // Rates load first — EV cost estimates reuse today's off-peak rate from this call.
  const ratesResult = await loadRates().catch(() => false);
  // Live usage runs alongside the others but is excluded from the overall
  // sync-status calculation below — not having a telemetry device is a
  // normal, expected state for most accounts, not a sync failure.
  lastSlowTierAt = Date.now(); // this call does the slow tier's own work (loadBilling) directly — see shouldRunSlowTier
  // loadLiveUsage / loadCarbon / loadOctoplus are best-effort side feeds —
  // excluded from the sync-status calc below (no telemetry device, a NESO
  // blip, or an account that isn't on Octoplus aren't Octopus sync failures).
  const [, , , evSettled, billingSettled] = await Promise.allSettled([loadLiveUsage(), loadCarbon(), loadOctoplus(), loadEV(), loadBilling()]);
  const results = [evSettled, billingSettled];
  const allResults = [ratesResult, ...results.map(r => r.status === 'fulfilled' ? r.value : false)];
  // Capture the reason if either promise rejected outright. Internal paths
  // in loadBilling/loadEV log their own failures, but an uncaught exception
  // escaping all of them lands here — where checking only .status would
  // discard the actual error.
  if (evSettled.status === 'rejected') logIssue('EV (uncaught)', evSettled.reason);
  if (billingSettled.status === 'rejected') logIssue('Billing (uncaught)', billingSettled.reason);
  await checkRateLimitBlocked();
  logSyncAttempt(source, {
    Rates: ratesResult,
    EV: evSettled.status === 'fulfilled' ? evSettled.value : false,
    Billing: billingSettled.status === 'fulfilled' ? billingSettled.value : false
  }, apiKeySnapshot, getSyncIssues());
  const allReal = allResults.every(v => v === true);
  const anyReal = allResults.some(v => v === true);
  if (allReal) setSyncStatus('ok', `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  else if (anyReal) setSyncStatus('stale', demoFallbackEnabled() ? 'Partially synced — some demo data' : 'Partially synced — some data unavailable');
  else setSyncStatus('error', demoFallbackEnabled() ? 'Using demo data — check settings' : 'Data unavailable — check settings');
  renderDiagnostics();
}

// Background refresh runs in two tiers because re-check frequency varies:
//
// - Fast tier (this function): rates + EV, ~2 requests, both time-sensitive
//   (rate boundaries, charging start/stop) and cheap — fine to check often.
// - Slow tier (loadSlowTier): billing, ~25+ requests per run, none of it
//   changing within minutes (consumption lags 24-48h). Running that bundle
//   as often as the fast tier was likely tripping Octopus's rate limit,
//   showing as data flaking to "Unavailable" for no visible reason.
//
// Both tiers update sync status/diagnostics independently. The initial load
// and the manual refresh button still call the full loadAll() above.

// Tracks when the slow tier last actually ran (set both here and in
// loadAll(), which runs the billing-equivalent work directly) — read by
// the visibility-resume handler below to decide whether reopening the app
// warrants a fresh billing pull or would just repeat one from moments ago.
let lastSlowTierAt = null;
const SLOW_TIER_MIN_INTERVAL_MS = 30 * 60 * 1000;
export function shouldRunSlowTier(lastAt, now) {
  if (lastAt == null) return true;
  return (now - lastAt) >= SLOW_TIER_MIN_INTERVAL_MS;
}

async function loadFastTier() {
  const apiKeySnapshot = store.creds?.apiKey;
  clearRateCacheIfNewDay();
  resetDiagnostics();
  if (meterDebugNote) logRawDebug(`Meter selection: ${meterDebugNote}`);
  const ratesResult = await loadRates().catch(() => false);
  const [, evSettled] = await Promise.allSettled([loadCarbon(), loadEV()]);
  const evResult = evSettled.status === 'fulfilled' ? evSettled.value : false;
  await checkRateLimitBlocked();
  logSyncAttempt('fast', { Rates: ratesResult, EV: evResult }, apiKeySnapshot, getSyncIssues());
  const allResults = [ratesResult, evResult];
  const allReal = allResults.every(v => v === true);
  const anyReal = allResults.some(v => v === true);
  if (allReal) setSyncStatus('ok', `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  else if (anyReal) setSyncStatus('stale', demoFallbackEnabled() ? 'Partially synced — some demo data' : 'Partially synced — some data unavailable');
  else setSyncStatus('error', demoFallbackEnabled() ? 'Using demo data — check settings' : 'Data unavailable — check settings');
  renderDiagnostics();
}

// Deliberately doesn't clear syncIssues/debugNotes — the fast tier does
// that (it runs more often, so it's the natural baseline-reset point). If
// this also cleared them, anything logged here would just get wiped by
// the next fast-tier run 5 minutes later, making billing issues
// effectively invisible in diagnostics.
async function loadSlowTier() {
  // Recorded before attempting, not after succeeding — a repeatedly
  // failing account shouldn't get hammered every time the tab regains
  // focus, only on the normal interval.
  lastSlowTierAt = Date.now();
  const apiKeySnapshot = store.creds?.apiKey;
  let billingSettled;
  try {
    billingSettled = await loadBilling();
  } catch (err) {
    logIssue('Billing (uncaught)', err);
    billingSettled = false;
  }
  logSyncAttempt('slow', { Billing: billingSettled }, apiKeySnapshot, getSyncIssues());
  if (billingSettled === true) setSyncStatus('ok', `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  else setSyncStatus('stale', demoFallbackEnabled() ? 'Partially synced — some demo data' : 'Partially synced — some data unavailable');
  renderDiagnostics();
}
/* --------------------------------- Init ----------------------------------- */

// startAutoRefresh is called from both init() (returning user with saved
// credentials) and the end of saveSettings() (first-time setup) — the only
// two ways the app content becomes visible — so autoRefreshStarted guards
// against double-starting if both fire in one session.
//
// The interval IDs are tracked so every recurring fetch (both tiers, live
// usage, the Last-30-min poll) can be paused while the tab is hidden and
// restarted when it isn't, rather than burning against the rate limit for a
// screen nobody's looking at. Two-tier rationale is at loadFastTier above.
let fastTierIntervalId = null;
let slowTierIntervalId = null;
let liveUsageIntervalId = null;

function stopAutoRefreshTimers() {
  if (fastTierIntervalId) { clearInterval(fastTierIntervalId); fastTierIntervalId = null; }
  if (slowTierIntervalId) { clearInterval(slowTierIntervalId); slowTierIntervalId = null; }
  if (liveUsageIntervalId) { clearInterval(liveUsageIntervalId); liveUsageIntervalId = null; }
  // Paused, not closed — live-usage.js's own live30Open flag is left as-is
  // (see closeLive30, which is the actual "the user closed it" path and
  // also resets that flag) so a tab that goes hidden with the panel open
  // resumes polling it, rather than silently losing the fact that it was
  // open, when the tab is visible again.
  pauseLive30Polling();
}

function startAutoRefreshTimers() {
  // Idempotent — pageshow and visibilitychange can both fire for the same
  // bfcache-restore transition, and without this guard that would double-
  // schedule every interval rather than the second call being a no-op.
  if (fastTierIntervalId) return;
  fastTierIntervalId = setInterval(loadFastTier, 5 * 60 * 1000);
  // Usage bars/MTD, bills, standing charges, balance/DD — everything
  // in loadBilling() — genuinely can't reveal new information more often
  // than this. Smart meter consumption lags 24-48h regardless of how often
  // we ask; bills land on Octopus's own roughly-monthly schedule; standing
  // charges change over weeks, not minutes. 30 minutes was needlessly
  // frequent and was very likely the main contributor to hitting Octopus's
  // documented 100-calls/hour shared rate limit.
  slowTierIntervalId = setInterval(loadSlowTier, 6 * 60 * 60 * 1000);
  // Live usage refreshes faster on its own — 30s, matching roughly how
  // often new telemetry actually shows up, without re-running either tier.
  liveUsageIntervalId = setInterval(() => loadLiveUsage().catch(() => {}), 30 * 1000);
  resumeLive30PollingIfOpen();
}

// Runs once when the tab regains focus (or returns from the bfcache) after
// having been hidden — not on every visibility event, and never
// overlapping itself if one is already in flight (e.g. a rapid tab-switch
// double-fire). Fast tier is cheap enough to always re-run; slow tier only
// if shouldRunSlowTier says genuinely enough time has passed, so reopening
// the app a minute after switching away doesn't repeat a ~25-request
// billing pull for nothing new.
let resumeRefreshInFlight = false;
async function refreshOnResume() {
  if (resumeRefreshInFlight) return;
  resumeRefreshInFlight = true;
  try {
    await loadFastTier().catch(() => {});
    if (shouldRunSlowTier(lastSlowTierAt, Date.now())) await loadSlowTier().catch(() => {});
    await loadLiveUsage().catch(() => {});
    if (isLive30Open()) await loadLive30().catch(() => {});
  } finally {
    resumeRefreshInFlight = false;
  }
}

let autoRefreshStarted = false;
export function startAutoRefresh() {
  if (autoRefreshStarted) return;
  autoRefreshStarted = true;
  // Not a timer — vehicle registration never changes in normal use, so this
  // runs once per app lifetime (the function itself no-ops on every later
  // call once cached), not on any recurring schedule at all.
  loadVehicleInfoOnce().catch(() => {});
  startAutoRefreshTimers();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefreshTimers();
    else { refreshOnResume(); startAutoRefreshTimers(); }
  });
  // Covers the bfcache-restore case (e.g. an iOS Safari swipe-back into an
  // already-loaded tab) — visibilitychange alone doesn't always fire here,
  // but the page is exactly as stale as if it had been hidden the whole
  // time it sat in the cache.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) { refreshOnResume(); startAutoRefreshTimers(); }
  });
}

function init() {
  $('app-version').textContent = APP_VERSION;
  initTheme();
  $('input-appearance').addEventListener('change', handleAppearanceChange);
  $('settings-btn').addEventListener('click', openSettings);
  $('connect-btn').addEventListener('click', openSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click', saveSettings);
  $('toggle-api-key-visibility').addEventListener('click', () => {
    const field = $('input-api-key');
    const btn = $('toggle-api-key-visibility');
    const showing = field.type === 'text';
    field.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
    btn.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
  });
  $('advanced-toggle').addEventListener('click', () => $('advanced-fields').classList.toggle('hidden'));
  $('live30-toggle').addEventListener('click', () => { isLive30Open() ? closeLive30() : openLive30(); });
  $('ev-header').addEventListener('click', handleEvHeaderClick);
  $('ev-view-toggle').addEventListener('click', handleEvViewToggleClick);
  $('ev-week').addEventListener('click', handleEvWeekClick);
  $('ev-history-period-toggle').addEventListener('click', handleEvHistoryPeriodToggleClick);

  // Insights — collapsed by default; data is lazy-loaded on the first
  // expand only, since it needs a full month's data (~30 calls) that
  // shouldn't be paid for on every app load if the user never opens this.
  $('insights-header').addEventListener('click', handleInsightsHeaderClick);
  $('heatmap-toggle').addEventListener('click', handleHeatmapToggle);
  $('octoplus-results-toggle').addEventListener('click', handleOctoplusResultsToggle);

  // £ / kWh toggle — per fuel panel, instant re-render from cached data.
  document.querySelectorAll('.unit-toggle[data-fuel] .unit-toggle-btn').forEach(btn => {
    btn.addEventListener('click', handleUnitToggleClick);
  });

  // Day / Week / Month / Year toggle — shared across both fuel panels.
  document.querySelectorAll('.unit-toggle[data-role="period"] .unit-toggle-btn').forEach(btn => {
    btn.addEventListener('click', handlePeriodToggleClick);
  });

  // Date picker: calendar button opens/closes the panel; month nav browses
  // without changing the pick; tapping a day picks it and closes the panel;
  // reset/jump-to-today both clear the pick and fall back to the normal
  // today-anchored view everywhere else in the app already uses.
  $('date-picker-btn').addEventListener('click', handleDatePickerBtnClick);
  $('picker-prev-month').addEventListener('click', handlePickerPrevMonthClick);
  $('picker-next-month').addEventListener('click', handlePickerNextMonthClick);
  $('picker-grid').addEventListener('click', handlePickerGridClick);
  $('date-picker-reset').addEventListener('click', handleResetToTodayClick);
  $('picker-jump-today').addEventListener('click', handleResetToTodayClick);

  // Tap a bar to see that day's (or month's) breakdown; tap the same bar
  // again to close it. Event delegation so it works regardless of how many
  // bars get re-rendered (week/month/year all reuse this).
  ['elec', 'gas'].forEach(fuel => {
    $(`${fuel}-week`).addEventListener('click', handleFuelWeekBarClick);
  });

  // Same tap-to-reveal pattern for the bill-total-over-time chart — tap a
  // month's bar to see its gas/electricity split underneath (and a note +
  // link if that month combined more than one bill). Re-renders just the
  // selection/breakdown, not the whole chart, since the bar heights
  // themselves don't change on tap.
  $('bill-year-bars').addEventListener('click', handleBillYearBarClick);

  // Same tap-to-reveal pattern for the balance runway forecast — tap a
  // cycle's bar to see that month's payment/electricity/gas composition.
  $('insights-runway-bars').addEventListener('click', handleInsightsRunwayBarClick);

  // Same tap-to-reveal pattern for the Day view's half-hourly slots.
  $('elec-day-bars').addEventListener('click', handleElecDayBarClick);


  $('sync-btn').addEventListener('click', async () => {
    const btn = $('sync-btn');
    btn.classList.add('spinning');
    try { await loadAll('button'); } finally { btn.classList.remove('spinning'); }
  });

  if (store.creds?.apiKey) {
    $('connect-card').classList.add('hidden');
    $('app-content').classList.remove('hidden');
    loadAll();
    startAutoRefresh();
  }

  if ('serviceWorker' in navigator) {
    // updateViaCache: 'none' forces the browser to always fetch sw.js fresh
    // over the network rather than from HTTP cache when checking for updates —
    // without this, some hosts/CDNs can keep serving a stale sw.js indefinitely,
    // which means the app never picks up new app.js/index.html versions.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}

// Only bootstrap against a document that actually has this app's markup —
// #connect-btn is present unconditionally in index.html's initial HTML, so
// its absence means this module was imported into some other document (a
// test's bare jsdom document, most likely) rather than loaded as the real
// page's own script. That's also what keeps `npm test` side-effect-free:
// every test file imports from this module, and none of them should
// trigger a real init() wiring up listeners against elements that don't
// exist.
if (document.getElementById('connect-btn')) {
  // As a module script, this file is deferred — DOMContentLoaded may
  // already have fired by the time it runs, so the event alone isn't
  // reliable.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
