import { store } from './store.js';
import { $, fmtGBP } from './format.js';
import { logIssue, logDebug, sanityCheck } from './diagnostics.js';
import { krakenGQL } from './api.js';
import { renderChartScale } from './charts.js';
import { rateState } from './rates.js';
import { carbonState } from './carbon.js';

// Uses Octopus's smartMeterTelemetry field, confirmed working via a
// documented real-world example (near-10-second-resolution readings from a
// registered smart device, typically an Octopus Home Mini) — not something
// every account has, so this degrades to a plain "not available" message
// rather than faking numbers when no device is found.

let liveDeviceId = null;
let liveUnavailable = false;

async function getLiveDeviceId() {
  if (liveDeviceId) return liveDeviceId;
  if (liveUnavailable) return null;
  try {
    const data = await krakenGQL(`
      query SmartDevices($accountNumber: String!) {
        account(accountNumber: $accountNumber) {
          electricityAgreements(active: true) {
            meterPoint { meters(includeInactive: false) { smartDevices { deviceId } } }
          }
        }
      }`, { accountNumber: store.creds.accountNumber });
    const agreements = data?.account?.electricityAgreements || [];
    let meterCount = 0;
    for (const a of agreements) {
      for (const m of (a?.meterPoint?.meters || [])) {
        meterCount++;
        const deviceId = (m?.smartDevices || [])[0]?.deviceId;
        if (deviceId) { liveDeviceId = deviceId; return liveDeviceId; }
      }
    }
    // Query succeeded but found nothing — logged so "genuinely no device" and
    // "a one-off empty result" don't look identical with no way to tell them apart.
    logDebug('Live device lookup', `${agreements.length} agreement(s), ${meterCount} meter(s) scanned, no smartDevices found on any of them`);
  } catch (err) {
    logIssue('Live device lookup', err);
  }
  liveUnavailable = true;
  return null;
}

// Rough household-scale thresholds, not tied to anything account-specific —
// meant as a quick "is this normal or is something big running" signal, not
// a precise measure. Easy to retune once real usage patterns are visible.
function liveWattsColor(watts) {
  if (watts < 500) return 'var(--mint)';
  if (watts < 1500) return 'var(--yellow)';
  if (watts < 3000) return 'var(--amber)';
  return 'var(--coral)';
}

export async function loadLiveUsage() {
  const deviceId = await getLiveDeviceId();
  if (!deviceId) {
    $('live-unavailable').classList.remove('hidden');
    $('live-body').style.display = 'none';
    $('live-tag').style.display = 'none';
    $('live30-toggle').classList.add('hidden');
    closeLive30();
    return false;
  }
  $('live-unavailable').classList.add('hidden');
  $('live-body').style.display = '';
  $('live30-toggle').classList.remove('hidden');

  try {
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 60 * 1000); // only need the latest reading now — no chart to fill
    const data = await krakenGQL(`
      query LiveTelemetry($deviceId: String!, $start: DateTime!, $end: DateTime!) {
        smartMeterTelemetry(deviceId: $deviceId, grouping: TEN_SECONDS, start: $start, end: $end) {
          readAt demand consumptionDelta
        }
      }`, { deviceId, start: start.toISOString(), end: now.toISOString() });

    const points = data?.smartMeterTelemetry || [];
    if (!points.length) throw new Error('No telemetry points returned for the last 2 minutes');

    const latest = points[points.length - 1];
    const watts = sanityCheck(Math.round(latest.demand), { min: 0, max: 30000, label: 'Live demand', expected: 'W' });
    $('live-watts').innerHTML = `${watts}<span>W</span>`;
    $('live-watts').style.color = liveWattsColor(watts);
    $('live-updated').textContent = `Updated ${new Date(latest.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    $('live-tag').style.display = '';
    logDebug('Live telemetry', `${points.length} point(s), latest demand ${latest.demand}W, raw consumptionDelta ${latest.consumptionDelta}`);

    // Cost-per-hour if this draw were sustained for a full hour — meant to
    // translate raw watts into something that actually motivates turning
    // something off, not a prediction of what you'll really spend.
    const rateP = rateState.currentRateP ?? rateState.offPeakRateP;
    if (rateP != null) {
      const poundsPerHour = (watts / 1000) * rateP / 100;
      $('live-cost-rate').innerHTML = `≈ <b style="color:var(--mint)">${fmtGBP(poundsPerHour)}</b>/hr at this rate`;
    } else {
      $('live-cost-rate').textContent = '';
    }

    // Same idea in carbon terms — this draw sustained for an hour, at the
    // current grid intensity. Only shown once the carbon feed has loaded.
    if (carbonState.currentGco2 != null) {
      const kgPerHour = (watts / 1000) * carbonState.currentGco2 / 1000;
      $('live-carbon-rate').innerHTML = `≈ <b>${kgPerHour.toFixed(2)} kg</b> CO₂/hr at ${carbonState.currentGco2} g/kWh`;
    } else {
      $('live-carbon-rate').textContent = '';
    }

    return true;
  } catch (err) {
    logIssue('Live usage', err);
    $('live-tag').style.display = 'none';
    $('live-updated').textContent = 'Unavailable right now';
    $('live-cost-rate').textContent = '';
    $('live-carbon-rate').textContent = '';
    return false;
  }
}

// Last-30-minutes panel — lazy-loaded only when opened, then kept live with
// its own 30s refresh while open. Goes through krakenGQL, not octRest, so it
// never touches the REST-call diagnostic counter (that tracks the separate
// REST API). Uses the same TEN_SECONDS grouping proven to work for the
// 2-minute query above rather than guessing at an unconfirmed coarser enum
// that could break the whole query; up to 180 raw points are bucketed
// client-side into 1-minute bars instead.
let live30Open = false;
let live30Interval = null;

export function bucketTelemetryByMinute(points, now) {
  const buckets = Array.from({ length: 30 }, () => 0);
  const windowStart = new Date(now.getTime() - 30 * 60 * 1000);
  for (const p of points) {
    const t = new Date(p.readAt);
    const minutesAgo = Math.floor((now - t) / 60000);
    const idx = 29 - minutesAgo; // idx 0 = oldest, idx 29 = most recent minute
    if (idx >= 0 && idx < 30) buckets[idx] += (+p.consumptionDelta || 0);
  }
  return buckets;
}

export async function loadLive30() {
  const deviceId = await getLiveDeviceId();
  if (!deviceId) return false;
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 60 * 1000);
    const data = await krakenGQL(`
      query LiveTelemetry30($deviceId: String!, $start: DateTime!, $end: DateTime!) {
        smartMeterTelemetry(deviceId: $deviceId, grouping: TEN_SECONDS, start: $start, end: $end) {
          readAt consumptionDelta
        }
      }`, { deviceId, start: start.toISOString(), end: now.toISOString() });

    const points = data?.smartMeterTelemetry || [];
    // Checked once across the whole batch (its maximum), not per point —
    // a genuine unit change would affect essentially every reading, so the
    // max alone catches it without logging once per point (up to 180 of
    // them here) on every 30s refresh.
    sanityCheck(Math.max(...points.map(p => +p.consumptionDelta || 0), 0), { min: 0, max: 1000, label: 'consumptionDelta (10s reading, batch max)', expected: 'Wh' });
    const buckets = bucketTelemetryByMinute(points, now);
    const totalWh = buckets.reduce((s, v) => s + v, 0);

    $('live30-total').innerHTML = `<b>${totalWh.toFixed(0)}</b> Wh used`;
    const max = Math.max(...buckets, 0.01);
    renderChartScale('live30-scale', max, v => v.toFixed(0));
    $('live30-bars').innerHTML = buckets.map((v, i) => {
      const h = Math.max(1, Math.round((v / max) * 70));
      const isLatest = i === buckets.length - 1;
      return `<div class="live30-bar${isLatest ? ' latest' : ''}" style="height:${h}px" title="${v.toFixed(1)} Wh"></div>`;
    }).join('');
    const startLabel = new Date(now.getTime() - 30 * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const midLabel = new Date(now.getTime() - 15 * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const endLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('live30-axis').innerHTML = `<span>${startLabel}</span><span>${midLabel}</span><span>${endLabel}</span>`;
    return true;
  } catch (err) {
    logIssue('Live usage (30 min)', err);
    return false;
  }
}

export function closeLive30() {
  live30Open = false;
  $('live30-toggle')?.setAttribute('aria-expanded', 'false');
  $('live30-panel')?.classList.add('hidden');
  if (live30Interval) { clearInterval(live30Interval); live30Interval = null; }
}

export function openLive30() {
  live30Open = true;
  $('live30-toggle').setAttribute('aria-expanded', 'true');
  $('live30-panel').classList.remove('hidden');
  loadLive30();
  // Own 30s refresh while open, matching the headline draw figure's cadence
  // — stops the moment the panel closes, so it's not fetching in the
  // background when nobody's looking at it.
  live30Interval = setInterval(loadLive30, 30 * 1000);
}

// The three exports below exist only for the visibility-aware refresh
// (startAutoRefreshTimers/stopAutoRefreshTimers/refreshOnResume): that code
// needs to pause and resume this panel's poll without touching its DOM
// visibility or its "the user has this open" flag, which is exactly what
// openLive30/closeLive30 do and must NOT be reused for.
export function isLive30Open() {
  return live30Open;
}
export function pauseLive30Polling() {
  if (live30Interval) { clearInterval(live30Interval); live30Interval = null; }
}
export function resumeLive30PollingIfOpen() {
  if (live30Open) live30Interval = setInterval(loadLive30, 30 * 1000);
}
