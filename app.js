/* ==========================================================================
   Kraken Watch — first build
   -------------------------------------------------------------------------
   - Octopus REST API (consumption, tariffs, account/balance): documented,
     stable, uses your API key over HTTP Basic Auth.
   - Kraken GraphQL API (Intelligent Octopus Go dispatches): this is the
     same API the official Octopus app uses, but it isn't officially
     published — field names here are based on community reverse-engineering
     (see the Home Assistant Octopus Energy integration on GitHub) and may
     need adjusting if Octopus changes their schema. If a GraphQL call
     fails, the EV card falls back to demo data and flags itself as such
     rather than breaking the page.
   ========================================================================== */

import { store, logSyncAttempt, getSyncLog, demoFallbackEnabled } from './store.js';
import { $, fmtGBP, fmtP, fmtKwh, fmtT, formatElapsed, APP_VERSION } from './format.js';
import { resetDiagnostics, logIssue, logDebug, logRawDebug, getSyncIssues, renderDiagnostics, sanityCheck } from './diagnostics.js';
import { octRest, krakenGQL, resetKrakenToken, checkRateLimitBlocked } from './api.js';
import { renderPowerMeter, renderChartScale, chartMax, isChartDense, chartLabelOrBlank, renderWeekBars, renderStackedBars } from './charts.js';
import {
  clearRateCacheIfNewDay, rateState, estimateSessionCostP, fetchElecRates, fetchGasRates, fetchStandingCharge,
  rateAt, m3ToKwh, detectGasUnit, GAS_M3_THRESHOLD_DAILY, GAS_M3_THRESHOLD_MONTHLY, costForRange, bucketReadingsByDay,
} from './rates.js';
import {
  loadLiveUsage, loadLive30, closeLive30, openLive30, isLive30Open, pauseLive30Polling, resumeLive30PollingIfOpen,
} from './live-usage.js';
import {
  loadEV, loadVehicleInfoOnce,
  handleEvHeaderClick, handleEvViewToggleClick, handleEvWeekClick, handleEvHistoryPeriodToggleClick,
} from './ev.js';
import {
  fuelData, dayTotal, breakdownRow, daysElapsedInMonth, daysInMonth, isoDate,
  renderFuelPanel, loadMonthData, loadPickedPeriodData,
  lastNDaysElecSplitWithStanding, lastNDaysGasSplitWithStanding, fetchYearMonthly,
  handleUnitToggleClick, handlePeriodToggleClick, handleDatePickerBtnClick,
  handlePickerPrevMonthClick, handlePickerNextMonthClick, handlePickerGridClick,
  handleResetToTodayClick, handleFuelWeekBarClick, handleElecDayBarClick,
} from './usage.js';
import { billingState, billMonthsData, loadBilling, handleBillYearBarClick } from './billing.js';
import { handleInsightsHeaderClick, handleInsightsRunwayBarClick } from './insights.js';

/* ------------------------------ Rendering -------------------------------- */

function setSyncStatus(state, label) {
  const dot = $('sync-dot');
  dot.className = 'dot' + (state === 'stale' ? ' stale' : state === 'error' ? ' error' : '');
  $('sync-text').textContent = label;
}

let meterDebugNote = null;

/* ------------------------------ Data loaders ------------------------------ */

async function loadRates() {
  try {
    const now = new Date();
    // v2.167: was `isoDate(now)` (= now.toISOString().slice(0,10), always
    // the UTC calendar date) with a literal Z appended to both boundaries
    // — meant to mean "today, local midnight to midnight" but actually
    // meaning "today, UTC midnight to midnight". During BST (UTC+1), local
    // time crosses into a new day up to an hour before UTC does — so for
    // roughly that hour every night, todayISO silently resolved to
    // yesterday's UTC date, and the whole day's rate fetch was anchored to
    // the wrong 24-hour window: shifted roughly an hour early, and not
    // reaching far enough into what was genuinely still "later today"
    // locally. Confirmed live: at 00:21 BST, this showed Standard and
    // Off-peak as identical (the fetched window had rolled into a stretch
    // containing only off-peak rate data) and "No change today" (nothing
    // in that wrongly-scoped array was later than `now`), even though a
    // real change back to standard rate was still hours away. Fixed by
    // building the boundary from local date components (`dayStart`, which
    // this function already computed a few lines below for its own
    // half-hourly expansion — pulled up here so both uses share it) and
    // letting `.toISOString()` do the correct UTC conversion itself,
    // rather than assembling a UTC-labelled string from a UTC-derived date
    // and treating it as local.
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
    } else {
      $('rate-value').innerHTML = `—<span>p/kWh</span>`;
      $('rate-value').style.color = 'var(--text-dim)';
      $('elec-unit-rate').textContent = 'Unavailable';
      $('rate-pill').className = 'card-tag tag-dim';
      $('rate-pill').innerHTML = '<span class="status-dot dim"></span>Unavailable';
      $('rate-standard').textContent = '—';
      $('rate-offpeak').textContent = '—';
      $('rate-next').textContent = '—';
    }
    return false;
  }
}

async function loadAll(source = 'app-start') {
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
  const [, evSettled, billingSettled] = await Promise.allSettled([loadLiveUsage(), loadEV(), loadBilling()]);
  const results = [evSettled, billingSettled];
  const allResults = [ratesResult, ...results.map(r => r.status === 'fulfilled' ? r.value : false)];
  // If either promise rejected outright, capture the real reason — this is
  // the one boundary with no logging at all until now. Every internal path
  // inside loadBilling/loadEV calls logIssue() on its own failures, but an
  // uncaught exception that somehow escapes all of those internal
  // try/catches would land here instead, and previously vanished
  // completely: we checked .status to get true/false but never touched
  // .reason, discarding the actual error.
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

// Automatic background refresh runs in two tiers rather than one flat
// interval, since "how often does this need re-checking" varies wildly:
//
// - Fast tier (this function): rates + EV, ~2 requests total. Both are
//   genuinely time-sensitive — a tariff rate changes at a fixed boundary,
//   and EV charging can start/stop — and both are cheap, so there's no
//   real cost to checking them often.
// - Slow tier (loadSlowTier below): billing, which alone fires ~25+
//   requests every run (7-day elec/gas consumption bars, MTD, bill
//   history, itemized breakdown). None of that changes meaningfully
//   within minutes — smart meter consumption already lags 24-48h — so
//   running that whole bundle as often as the fast tier was very likely
//   tripping Octopus's rate limits intermittently, showing up as real,
//   available data occasionally flaking to "Unavailable" for no visible
//   reason.
//
// Both tiers update sync status/diagnostics independently on completion;
// the initial load and the manual refresh button still call the full
// loadAll() above, so opening the app or tapping refresh always gets
// everything at once regardless of tier timing.

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
  const [evSettled] = await Promise.allSettled([loadEV()]);
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
/* ------------------------------ Settings UI ------------------------------- */

function openSettings() {
  const c = store.creds || {};
  $('input-api-key').value = c.apiKey || '';
  $('input-api-key').type = 'password';
  $('toggle-api-key-visibility').textContent = 'Show';
  $('input-account').value = c.accountNumber || '';
  $('input-email').value = c.email || '';
  $('input-password').value = c.password || '';
  $('input-elec-mpan').value = c.manualElecMpan || '';
  $('input-elec-serial').value = c.manualElecSerial || '';
  $('input-gas-mprn').value = c.manualGasMprn || '';
  $('input-gas-serial').value = c.manualGasSerial || '';
  $('input-calorific-value').value = c.calorificValue || '';
  if (c.manualElecMpan || c.manualGasMprn) $('advanced-fields').classList.remove('hidden');
  // v2.191: defaults to whatever Octopus's own device record returned
  // (c.vehicleMake/vehicleModel) unless the user has already saved a
  // genuine override (c.customVehicleMake/Model) — so the field always
  // starts pre-filled with the current real value, editable in place.
  $('input-ev-make').value = c.customVehicleMake || c.vehicleMake || '';
  $('input-ev-model').value = c.customVehicleModel || c.vehicleModel || '';
  $('input-ev-wltp-miles').value = c.wltpMiles || '';
  $('input-ev-wltp-kwh').value = c.wltpBatteryKwh || '';
  $('input-show-diagnostics').checked = c.showDiagnostics !== false;
  $('input-use-demo-fallback').checked = c.useDemoFallback === true;
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

async function saveSettings() {
  const apiKey = $('input-api-key').value.trim();
  const accountNumber = $('input-account').value.trim();
  const email = $('input-email').value.trim();
  const password = $('input-password').value;
  const manualElecMpan = $('input-elec-mpan').value.trim();
  const manualElecSerial = $('input-elec-serial').value.trim();
  const manualGasMprn = $('input-gas-mprn').value.trim();
  const manualGasSerial = $('input-gas-serial').value.trim();
  const calorificValueRaw = $('input-calorific-value').value.trim();
  const calorificValue = calorificValueRaw ? parseFloat(calorificValueRaw) : null;
  if (calorificValueRaw && (!Number.isFinite(calorificValue) || calorificValue <= 0)) {
    alert('Gas calorific value must be a positive number.'); return;
  }
  // v2.191: custom vehicle name — only actually saved as an override if it
  // genuinely differs from the current API-returned value; if the user
  // left the field exactly as pre-filled, this intentionally leaves no
  // override set, so the display keeps following Octopus's own device
  // record automatically (e.g. if the vehicle is ever swapped) rather
  // than permanently freezing to whatever happened to show the one time
  // Settings was opened and saved.
  const evMakeInput = $('input-ev-make').value.trim().slice(0, 15);
  const evModelInput = $('input-ev-model').value.trim().slice(0, 60);
  const priorCreds = store.creds || {};
  const customVehicleMake = evMakeInput && evMakeInput !== (priorCreds.vehicleMake || '') ? evMakeInput : null;
  const customVehicleModel = evModelInput && evModelInput !== (priorCreds.vehicleModel || '') ? evModelInput : null;
  const wltpMilesRaw = $('input-ev-wltp-miles').value.trim();
  const wltpKwhRaw = $('input-ev-wltp-kwh').value.trim();
  const wltpMiles = wltpMilesRaw ? parseFloat(wltpMilesRaw) : null;
  const wltpBatteryKwh = wltpKwhRaw ? parseFloat(wltpKwhRaw) : null;
  if (wltpMilesRaw && (!Number.isFinite(wltpMiles) || wltpMiles <= 0)) {
    alert('WLTP range must be a positive number.'); return;
  }
  if (wltpKwhRaw && (!Number.isFinite(wltpBatteryKwh) || wltpBatteryKwh <= 0)) {
    alert('Battery capacity must be a positive number.'); return;
  }
  const showDiagnostics = $('input-show-diagnostics').checked;
  const useDemoFallback = $('input-use-demo-fallback').checked;
  if (!apiKey || !accountNumber) { alert('API key and account number are required.'); return; }

  store.creds = { ...store.creds, apiKey, accountNumber, email, password, manualElecMpan, manualElecSerial, manualGasMprn, manualGasSerial, calorificValue, customVehicleMake, customVehicleModel, wltpMiles, wltpBatteryKwh, showDiagnostics, useDemoFallback };
  resetKrakenToken();

  // Best-effort: look up meter points + tariff codes automatically from the account.
  // Accounts can have more than one electricity/gas meter point on record (e.g.
  // after a smart meter exchange, the old meter point often stays listed) —
  // blindly taking index [0] can pick a decommissioned meter with no consumption
  // data even though its tariff/agreement info still resolves fine. This prefers
  // the currently-occupied property and the meter point with an active agreement.
  try {
    const acct = await octRest(`/accounts/${accountNumber}/`);
    const properties = acct.properties || [];
    const prop = properties.find(p => !p.moved_out_at) || properties[0];

    const now = new Date();
    const isActive = a => !a.valid_to || new Date(a.valid_to) > now;

    const elecMps = prop?.electricity_meter_points || [];
    const elecMp = elecMps.find(mp => (mp.agreements || []).some(isActive)) || elecMps[0];
    const gasMps = prop?.gas_meter_points || [];
    const gasMp = gasMps.find(mp => (mp.agreements || []).some(isActive)) || gasMps[0];

    const agreement = elecMp?.agreements?.find(isActive);
    const gasAgreement = gasMp?.agreements?.find(isActive);
    const creds = store.creds;
    creds.elecMpan = elecMp?.mpan;
    creds.elecSerial = elecMp?.meters?.[elecMp.meters.length - 1]?.serial_number;
    creds.gasMprn = gasMp?.mprn;
    creds.gasSerial = gasMp?.meters?.[gasMp.meters.length - 1]?.serial_number;
    if (agreement?.tariff_code) {
      // tariff codes look like E-1R-INTELLI-VAR-22-10-14-C — product code is the middle segment
      const parts = agreement.tariff_code.split('-');
      creds.elecTariffCode = agreement.tariff_code;
      creds.elecProductCode = parts.slice(2, -1).join('-');
    }
    if (gasAgreement?.tariff_code) {
      const parts = gasAgreement.tariff_code.split('-');
      creds.gasTariffCode = gasAgreement.tariff_code;
      creds.gasProductCode = parts.slice(2, -1).join('-');
    }
    store.creds = creds;

    meterDebugNote = `${properties.length} propert${properties.length === 1 ? 'y' : 'ies'}, ` +
      `${elecMps.length} elec meter point(s) (using MPAN ${elecMp?.mpan || '—'}, serial ${creds.elecSerial || '—'}, ${elecMp?.meters?.length || 0} meter(s) on record), ` +
      `${gasMps.length} gas meter point(s) (using MPRN ${gasMp?.mprn || '—'}, serial ${creds.gasSerial || '—'})`;
  } catch (err) {
    logIssue('Meter-point lookup', err);
  }

  // Manual overrides always win over auto-detection, if provided.
  if (manualElecMpan && manualElecSerial) {
    const creds = store.creds;
    creds.elecMpan = manualElecMpan;
    creds.elecSerial = manualElecSerial;
    store.creds = creds;
  }
  if (manualGasMprn && manualGasSerial) {
    const creds = store.creds;
    creds.gasMprn = manualGasMprn;
    creds.gasSerial = manualGasSerial;
    store.creds = creds;
  }

  closeSettings();
  $('connect-card').classList.add('hidden');
  $('app-content').classList.remove('hidden');
  loadAll();
  startAutoRefresh();
}

/* --------------------------------- Init ----------------------------------- */

// Two-tier automatic background refresh (see the comment above loadFastTier
// for the full reasoning): rates + EV are cheap and time-sensitive, so they
// keep checking every 5 minutes like before. Billing is expensive (~25+
// requests) and not time-sensitive, so it drops to every 6 hours —
// that bundle running as often as everything else was the likely cause
// of intermittent "Unavailable" flashes on data that genuinely was there.
//
// Called both from init() (a returning user who already has saved
// credentials) and from the end of saveSettings() (first-time setup) —
// those are the only two ways the app content becomes visible, and this
// needs to start regardless of which one just happened. autoRefreshStarted
// guards against ever double-starting these on the rare path where both
// could theoretically fire in the same session (e.g. saving settings again
// after an initial successful load).
// Interval IDs, tracked (previously discarded) so every recurring fetch —
// both tiers, live usage, and the Last-30-min panel's own poll if it's
// open — can be paused while the tab is hidden and cleanly restarted when
// it isn't, rather than running unattended in the background indefinitely
// and burning against Octopus's shared rate limit for a screen nobody is
// looking at.
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
function startAutoRefresh() {
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
  $('settings-btn').addEventListener('click', openSettings);
  $('connect-btn').addEventListener('click', openSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click', saveSettings);
  // Single static row, unlike bill-history's per-row toggles which get
  // rebuilt (and re-delegated) every sync — this one only ever needs
  // wiring once, since #octo-history itself is what gets refreshed.
  $('octo-toggle').addEventListener('click', () => {
    const open = $('octo-toggle').getAttribute('aria-expanded') === 'true';
    $('octo-toggle').setAttribute('aria-expanded', String(!open));
    $('octo-toggle').querySelector('span').textContent = open ? 'Show history' : 'Hide history';
    $('octo-history').classList.toggle('hidden', open);
  });
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

  // £ / kWh toggle — per fuel panel, instant re-render from cached data.
  document.querySelectorAll('.unit-toggle[data-fuel] .unit-toggle-btn').forEach(btn => {
    btn.addEventListener('click', handleUnitToggleClick);
  });

  // Day / Week / Month / Year toggle — shared across both fuel panels.
  // Month/Year data is fetched lazily on first use rather than on every
  // sync; Day is electricity-only, but the fetch is harmless to attempt
  // unconditionally since renderFuelPanel handles gas's "not available"
  // state regardless of whether fuelData.elec.day ends up populated.
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
