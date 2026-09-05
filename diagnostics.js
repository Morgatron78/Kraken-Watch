import { store, restCallsInLastHour, getSyncLog } from './store.js';
import { $, APP_VERSION } from './format.js';

// syncIssues/debugNotes only ever reflect the current moment (unlike the
// persistent sync log in store.js) — reset at the start of a sync via
// resetDiagnostics(), not by reassigning these directly. They're kept
// private to this module (no raw export) specifically so every mutation
// goes through a named function here instead of being poked at from
// outside — the whole reason this file exists as its own module.
let syncIssues = [];
let debugNotes = [];

// Called at the start of a full or fast-tier sync. loadSlowTier
// deliberately does NOT call this (see its own comment in app.js) — it
// runs far less often, so resetting here would wipe out billing issues
// before anyone saw them, the next time the fast tier's own 5-minute
// timer fires.
export function resetDiagnostics() {
  syncIssues = [];
  debugNotes = [];
}

export function logIssue(section, err) {
  console.warn(`${section} fallback:`, err.message);
  syncIssues.push(`${section}: ${err.message}`);
}

export function logDebug(label, msg) {
  console.info(`${label} debug:`, msg);
  debugNotes.push(`${label}: ${msg}`);
}

// A small, deliberate bypass of logIssue's "section: message" formatting —
// checkRateLimitBlocked's own message is already a complete sentence with
// no natural "section" to prefix it with.
export function logRawIssue(message) {
  syncIssues.push(message);
}

// Same bypass for a pre-formatted debug line (the meter-selection note) —
// also skips logDebug's console.info side effect, since it's a note
// attached to the tier that's about to run, not a fresh event worth its
// own console line.
export function logRawDebug(message) {
  debugNotes.push(message);
}

// So loadAll/loadFastTier/loadSlowTier can pass the current issues into
// logSyncAttempt's persistent record without this module needing to know
// anything about the sync log itself.
export function getSyncIssues() {
  return syncIssues;
}

export function renderDiagnostics() {
  const card = $('diagnostics-card');
  const showDiagnostics = store.creds?.showDiagnostics !== false; // default on
  const syncLog = getSyncLog();
  if (!showDiagnostics || (!syncIssues.length && !debugNotes.length && !syncLog.length)) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const hasIssues = syncIssues.length > 0;
  const diagIconSvg = hasIssues
    ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  $('diagnostics-title').innerHTML = `${diagIconSvg} ${hasIssues ? 'Diagnostics' : 'Diagnostics (debug info)'}`;
  $('diagnostics-title').style.color = syncIssues.length ? 'var(--coral)' : 'var(--text-dim)';
  const infoIconSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  const warnIconSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  const lines = [
    `${infoIconSvg} App version: ${APP_VERSION}`,
    `${infoIconSvg} ${restCallsInLastHour()} REST call(s) in the last hour (Octopus's documented shared limit is 100/hour)`,
    ...syncIssues.map(m => `${warnIconSvg} ${m}`),
    ...debugNotes.map(m => `${infoIconSvg} ${m}`)
  ];
  $('diagnostics-list').innerHTML = lines.join('<br>');

  // Recent sync history — separate from the lines above, which only ever
  // reflect the current moment. Shown newest-first, capped to the last 20
  // even though more may be stored, since this is meant to be scanned at a
  // glance rather than read in full. A component name only appears when it
  // failed (✗ + the error) — a clean run just shows "OK" with nothing to
  // scan past, so a real recurring problem stands out rather than getting
  // lost in a wall of "Rates✓ EV✓" repeated forty times.
  const historyBox = $('sync-history');
  if (historyBox) {
    if (!syncLog.length) {
      historyBox.innerHTML = '';
    } else {
      const recent = syncLog.slice(-10).reverse();
      historyBox.innerHTML = '<div class="sync-history-title">Recent syncs</div>' + recent.map(entry => {
        const time = new Date(entry.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const failed = Object.entries(entry.r).filter(([, ok]) => ok !== true).map(([k]) => k);
        const summary = failed.length ? `✗ ${failed.join(', ')}` : 'OK';
        const cls = failed.length ? 'sync-history-row fail' : 'sync-history-row';
        const detailLine = (failed.length && entry.d && entry.d.length)
          ? `<div class="sync-history-detail">${entry.d.join(' · ')}</div>` : '';
        return `<div class="${cls}"><span>${time} (${entry.tier}) · ${entry.k || '—'}</span><span>${summary}</span></div>${detailLine}`;
      }).join('');
    }
  }
}

// Several values from Kraken's undocumented GraphQL schema are read with an
// assumed unit that's never been independently confirmed — smartMeterTelemetry's
// demand as watts, its consumptionDelta as Wh, chargePointPowerOutput as kW.
// Getting one wrong wouldn't error (it'd just display a number that's off by
// a factor of 1000, or negative, or absurdly large), so a schema/unit change
// on Octopus's side could otherwise ship silently. This doesn't auto-detect
// or correct anything — the display keeps showing whatever came back either
// way — it just makes a value outside a plausible household-scale band show
// up in diagnostics, the same "surface it, don't guess" principle the gas
// unit detection and the rate-lookup miss counter already follow elsewhere
// in this app. Bands are best-effort plausibility ranges, not hard limits.
// Lives here (not live-usage.js/ev.js, its two call sites) since both of
// those are genuinely separate features and this is a generic diagnostic
// primitive neither one owns.
export function sanityCheck(value, { min, max, label, expected }) {
  if (value == null || Number.isNaN(value)) return value;
  if (value < min || value > max) {
    logDebug('Unit check', `${label} = ${value} outside plausible ${min}–${max} (expected ${expected})`);
  }
  return value;
}
