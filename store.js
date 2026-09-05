// Credentials (backed by localStorage) plus two small diagnostic logs that
// persist across app reloads: the sync-attempt history (kw_sync_log) and
// the rolling REST-call-in-the-last-hour count (kw_rest_call_log). Both
// exist so the diagnostics panel can tell "this app has a bug" apart from
// "Octopus's API had a blip" — see the comments on each below.

export const store = {
  get creds() {
    try { return JSON.parse(localStorage.getItem('kw_creds') || 'null'); }
    catch { return null; }
  },
  set creds(v) { localStorage.setItem('kw_creds', JSON.stringify(v)); },
  clear() { localStorage.removeItem('kw_creds'); }
};

// Persistent sync-attempt log — survives app closes/reopens, unlike
// syncIssues/debugNotes (in app.js) which only ever reflect the current
// moment. A transient failure that already recovered by the time you next
// open the app is otherwise invisible; this is specifically for spotting
// whether failures are a real pattern (same component, clustered in time)
// or genuinely occasional — i.e. telling "this app has a bug" apart from
// "Octopus's API had a blip", which is the whole point of keeping it.
const SYNC_LOG_CAP = 60; // ~5h of fast-tier history at 5min intervals, mixed with slow-tier entries — enough to spot a pattern without bloating localStorage indefinitely
export function obfuscateApiKey(key) {
  if (!key) return '(none)';
  return key.length > 12 ? `${key.slice(0, 12)}…` : key;
}

export function logSyncAttempt(tier, results, apiKeySnapshot, detail) {
  try {
    const log = JSON.parse(localStorage.getItem('kw_sync_log') || '[]');
    // Cap each detail line's length — these can carry a REST error's full
    // response body/headers, and 60 entries' worth of long strings would
    // otherwise bloat localStorage for no real diagnostic benefit beyond
    // a couple hundred characters.
    const d = (detail || []).map(s => String(s).slice(0, 300));
    log.push({ t: Date.now(), tier, r: results, k: obfuscateApiKey(apiKeySnapshot), d });
    while (log.length > SYNC_LOG_CAP) log.shift();
    localStorage.setItem('kw_sync_log', JSON.stringify(log));
  } catch { /* non-critical, skip silently if storage is full/unavailable */ }
}
export function getSyncLog() {
  try { return JSON.parse(localStorage.getItem('kw_sync_log') || '[]'); }
  catch { return []; }
}

// Rolling count of REST calls in the trailing 60 minutes — not a rate
// limiter, just a diagnostic: if a 401 hits, this tells us directly
// whether we were anywhere near Octopus's documented 100-calls/hour shared
// limit at that moment, rather than having to infer it after the fact.
// Persisted to localStorage (like kw_sync_log) so the count survives an
// app-start reload — previously an in-memory-only array meant the visible
// "N REST calls in the last hour" figure silently reset to 0 on every
// reload despite the label implying a genuine rolling hour.
function loadRestCallLog() {
  try { return JSON.parse(localStorage.getItem('kw_rest_call_log') || '[]'); }
  catch { return []; }
}
let restCallLog = loadRestCallLog();
function saveRestCallLog() {
  try { localStorage.setItem('kw_rest_call_log', JSON.stringify(restCallLog)); }
  catch { /* non-critical, skip silently if storage is full/unavailable */ }
}
export function recordRestCall() {
  const now = Date.now();
  restCallLog.push(now);
  restCallLog = restCallLog.filter(t => now - t < 60 * 60 * 1000);
  saveRestCallLog();
}
export function restCallsInLastHour() {
  const now = Date.now();
  restCallLog = restCallLog.filter(t => now - t < 60 * 60 * 1000);
  return restCallLog.length;
}
