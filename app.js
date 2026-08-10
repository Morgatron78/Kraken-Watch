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

const REST_BASE = 'https://api.octopus.energy/v1';
const GQL_BASE = 'https://api.octopus.energy/v1/graphql/';
// Bump alongside CACHE in sw.js on every release — shown in the footer so
// it's obvious at a glance whether a deploy actually landed.
const APP_VERSION = 'v2.92';

const store = {
  get creds() {
    try { return JSON.parse(localStorage.getItem('kw_creds') || 'null'); }
    catch { return null; }
  },
  set creds(v) { localStorage.setItem('kw_creds', JSON.stringify(v)); },
  clear() { localStorage.removeItem('kw_creds'); }
};

// Persistent sync-attempt log — survives app closes/reopens, unlike
// syncIssues/debugNotes below which only ever reflect the current moment.
// A transient failure that already recovered by the time you next open the
// app is otherwise invisible; this is specifically for spotting whether
// failures are a real pattern (same component, clustered in time) or
// genuinely occasional — i.e. telling "this app has a bug" apart from
// "Octopus's API had a blip", which is the whole point of keeping it.
const SYNC_LOG_CAP = 60; // ~5h of fast-tier history at 5min intervals, mixed with slow-tier entries — enough to spot a pattern without bloating localStorage indefinitely
function obfuscateApiKey(key) {
  if (!key) return '(none)';
  return key.length > 12 ? `${key.slice(0, 12)}…` : key;
}

function logSyncAttempt(tier, results, apiKeySnapshot, detail) {
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
function getSyncLog() {
  try { return JSON.parse(localStorage.getItem('kw_sync_log') || '[]'); }
  catch { return []; }
}

const $ = (id) => document.getElementById(id);
const fmtGBP = (n) => `£${Math.abs(n).toFixed(2)}`;

// Renders a balance figure as a hero number with a small "in credit"/"owed"
// suffix, coloring coral only when genuinely in debit — the exceptional case
// worth flagging, not the normal one.
function renderBalanceFigure(valueId, pillId, pounds) {
  const el = $(valueId);
  const owed = pounds < 0;
  el.classList.toggle('owed', owed);
  el.textContent = fmtGBP(pounds);
  const pill = $(pillId);
  if (pill) {
    pill.textContent = owed ? 'DEBIT' : 'CREDIT';
    pill.className = 'status-pill ' + (owed ? 'debit' : 'credit');
  }
}
const fmtP = (n) => `${n.toFixed(2)}p`;

/* ---------------------------- API helpers -------------------------------- */

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
function recordRestCall() {
  const now = Date.now();
  restCallLog.push(now);
  restCallLog = restCallLog.filter(t => now - t < 60 * 60 * 1000);
  saveRestCallLog();
}
function restCallsInLastHour() {
  const now = Date.now();
  restCallLog = restCallLog.filter(t => now - t < 60 * 60 * 1000);
  return restCallLog.length;
}

async function octRest(path) {
  const { apiKey } = store.creds || {};
  recordRestCall();
  const res = await fetch(`${REST_BASE}${path}`, {
    headers: { Authorization: 'Basic ' + btoa(`${apiKey}:`) },
    cache: 'no-store' // always hit the network — a browser-cached response for
    // an identical URL (e.g. re-checking the same past day) could otherwise
    // serve stale data even after the underlying logic is fixed elsewhere.
  });
  if (!res.ok) {
    // Capture what we can rather than just the status — the body especially
    // may say something Octopus-specific ("invalid token" reads very
    // differently from anything rate-limit-shaped), and this call count is
    // ours, not theirs, but directly checkable against their documented
    // 100/hour shared limit.
    let bodyText = '';
    try { bodyText = (await res.text()).slice(0, 200); } catch { /* body unreadable, proceed without it */ }
    const rateLimitHeaders = ['x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after']
      .map(h => res.headers.get(h)).filter(Boolean).join(', ');
    throw new Error(`REST ${path} → ${res.status}${bodyText ? ` | body: ${bodyText}` : ''}${rateLimitHeaders ? ` | headers: ${rateLimitHeaders}` : ''} | ${restCallsInLastHour()} REST call(s) in last hour`);
  }
  return res.json();
}

let krakenToken = null;
async function getKrakenToken() {
  if (krakenToken) return krakenToken;
  const { email, password } = store.creds || {};
  const query = `mutation krakenTokenAuthentication($email: String!, $password: String!) {
    obtainKrakenToken(input: {email: $email, password: $password}) { token }
  }`;
  const res = await fetch(GQL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { email, password } })
  });
  const json = await res.json();
  const token = json?.data?.obtainKrakenToken?.token;
  if (!token) throw new Error('Kraken auth failed');
  krakenToken = token;
  return token;
}

async function krakenGQL(query, variables) {
  const token = await getKrakenToken();
  const res = await fetch(GQL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || 'GraphQL error');
  return json.data;
}

// Kraken's GraphQL equivalent of the REST-call diagnostic, but deliberately
// narrow: the account-wide 50,000 points/hour ceiling is far beyond what
// this app's real usage could plausibly reach (rateLimitInfo itself costs
// only 1 point), so a routine "X/50,000 used" line would just be noise.
// The one thing actually worth surfacing is isBlocked — if GraphQL calls
// ever started failing en masse for no obvious reason, this rules a block
// in or out immediately rather than guessing, the same way capturing real
// response bodies (not just status codes) cracked the toggle-destruction
// bug rather than an assumption about rate limiting. Silent no-op on
// failure or when not blocked — this is a best-effort diagnostic, not
// something that should itself count as a sync failure.
async function checkRateLimitBlocked() {
  try {
    const data = await krakenGQL(`
      query RateLimitInfo {
        rateLimitInfo {
          pointsAllowanceRateLimit { isBlocked ttl }
        }
      }`, {});
    const info = data?.rateLimitInfo?.pointsAllowanceRateLimit;
    if (info?.isBlocked) {
      const resetMins = info.ttl ? Math.max(0, Math.round((info.ttl * 1000 - Date.now()) / 60000)) : null;
      syncIssues.push(`GraphQL account blocked for exceeding its points allowance${resetMins !== null ? ` — resets in ~${resetMins}m` : ''}`);
    }
  } catch (err) { /* best-effort — see comment above */ }
}

/* ------------------------- Rates & cost calculation ----------------------- */
// Shared helpers so the rate curve, billing, EV and consumption cards all use
// the same underlying rate/consumption data instead of each re-fetching it.

const rateCache = {}; // key: `${tariffCode}_${fromISO}_${toISO}` -> [{from,to,rate}]
// rateCache is never explicitly sized/evicted by key — instead the whole
// thing gets wiped once a day (see clearRateCacheIfNewDay, called from
// loadFastTier since that's the most frequent trigger). Without this, a
// PWA left open for days would accumulate one new set of entries per day
// forever — modest per-day (roughly 20-30 entries), but genuinely
// unbounded over a long enough session.
let rateCacheDay = new Date().toDateString();
function clearRateCacheIfNewDay() {
  const today = new Date().toDateString();
  if (today !== rateCacheDay) {
    for (const key in rateCache) delete rateCache[key];
    rateCacheDay = today;
  }
}
let cachedOffPeakRateP = null; // cheapest electricity rate seen today — used as the EV dispatch rate approximation
let cachedCurrentRateP = null; // right-now electricity rate — used for the live-usage £/hr estimate
let cachedElecStandingP = null;
let cachedGasStandingP = null;

// Rate queries use a wider lookback window than the actual date range being
// priced. Narrow single-day queries (used for the 7-day bars) were missing
// the currently-active rate period on recent days — gas in particular only
// has a couple of rate changes a month, so a tight 24h window sometimes
// doesn't span back far enough to catch the row whose valid_from covers it,
// leaving every reading that day unmatched and silently priced at £0 usage.
// The month-wide MTD query never hit this because its window is naturally
// wide enough. Buffering period_from here gives every query that same safety
// margin without changing what date range is actually being priced.
const RATE_LOOKBACK_DAYS = 45;
function bufferedRateFrom(fromISO) {
  const d = new Date(fromISO);
  d.setDate(d.getDate() - RATE_LOOKBACK_DAYS);
  return d.toISOString();
}

async function fetchElecRates(fromISO, toISO) {
  const { elecProductCode, elecTariffCode } = store.creds;
  const key = `elec_${elecTariffCode}_${fromISO}_${toISO}`;
  if (rateCache[key]) return rateCache[key];
  const data = await octRest(`/products/${elecProductCode}/electricity-tariffs/${elecTariffCode}/standard-unit-rates/?period_from=${bufferedRateFrom(fromISO)}&period_to=${toISO}&page_size=1500`);
  const rows = (data.results || [])
    .map(r => ({ from: +new Date(r.valid_from), to: r.valid_to ? +new Date(r.valid_to) : +new Date(toISO), rate: r.value_inc_vat }))
    .sort((a, b) => a.from - b.from);
  rateCache[key] = rows;
  return rows;
}

async function fetchGasRates(fromISO, toISO) {
  const { gasProductCode, gasTariffCode } = store.creds;
  if (!gasProductCode || !gasTariffCode) return [];
  const key = `gas_${gasTariffCode}_${fromISO}_${toISO}`;
  if (rateCache[key]) return rateCache[key];
  const data = await octRest(`/products/${gasProductCode}/gas-tariffs/${gasTariffCode}/standard-unit-rates/?period_from=${bufferedRateFrom(fromISO)}&period_to=${toISO}&page_size=1500`);
  const rows = (data.results || [])
    .map(r => ({ from: +new Date(r.valid_from), to: r.valid_to ? +new Date(r.valid_to) : +new Date(toISO), rate: r.value_inc_vat }))
    .sort((a, b) => a.from - b.from);
  rateCache[key] = rows;
  return rows;
}

async function fetchStandingCharge(fuel) {
  try {
    if (fuel === 'elec') {
      const { elecProductCode, elecTariffCode } = store.creds;
      const data = await octRest(`/products/${elecProductCode}/electricity-tariffs/${elecTariffCode}/standing-charges/?page_size=1`);
      return data.results?.[0]?.value_inc_vat ?? null;
    } else {
      const { gasProductCode, gasTariffCode } = store.creds;
      if (!gasProductCode || !gasTariffCode) return null;
      const data = await octRest(`/products/${gasProductCode}/gas-tariffs/${gasTariffCode}/standing-charges/?page_size=1`);
      return data.results?.[0]?.value_inc_vat ?? null;
    }
  } catch (err) {
    // Previously silent — any failure here (a 401, a network error, a
    // malformed response) was indistinguishable from the legitimate
    // "no gas tariff on file" case above, both just returning null with
    // zero trace anywhere. Now the actual reason gets captured before
    // falling back to null, so callers keep working exactly as before
    // (a missing standing charge is still handled gracefully) but a real
    // failure is no longer invisible.
    logIssue(`${fuel === 'elec' ? 'Electricity' : 'Gas'} standing charge`, err);
    return null;
  }
}

function rateAt(rows, timestamp) {
  // Find the most recent rate period that started at or before this timestamp,
  // scanning rows sorted ascending by `from`. This is more robust than requiring
  // an exact `to` boundary match: a strict range check silently fell back to
  // rows[0] (often the cheapest rate) whenever a boundary didn't line up exactly,
  // which quietly mispriced standard-rate electricity usage as off-peak. Only
  // returns null if the timestamp is before every known rate period.
  let match = null;
  for (const r of rows) {
    if (r.from <= timestamp) match = r;
    else break;
  }
  return match ? match.rate : null;
}

// Sums consumption × matching half-hourly rate over a date range. Gas readings
// from smart meters are usually in m3, not kWh — this applies the standard
// industry conversion (volume correction 1.02264 × calorific value ÷ 3.6) when
// the units look like m3. If your meter already reports kWh, remove that step.
// Calorific value drifts slightly over time and Octopus states the exact
// figure used on each bill — configurable in Settings → Advanced, defaulting
// to 40.0 (a typical current UK value) rather than an older hardcoded figure.
function gasCalorificValue() {
  return store.creds?.calorificValue || 40.0;
}
async function costForRange(fuel, fromISO, toISO, debugLabel) {
  const creds = store.creds;
  const isElec = fuel === 'elec';
  const mp = isElec ? creds.elecMpan : creds.gasMprn;
  const serial = isElec ? creds.elecSerial : creds.gasSerial;
  if (!mp || !serial) throw new Error(`No ${fuel} meter point on file`);

  const consPath = isElec
    ? `/electricity-meter-points/${mp}/meters/${serial}/consumption/?period_from=${fromISO}&period_to=${toISO}&page_size=1500`
    : `/gas-meter-points/${mp}/meters/${serial}/consumption/?period_from=${fromISO}&period_to=${toISO}&page_size=1500`;

  const [consData, rates] = await Promise.all([
    octRest(consPath),
    isElec ? fetchElecRates(fromISO, toISO) : fetchGasRates(fromISO, toISO)
  ]);
  if (!rates.length) throw new Error(`No ${fuel} rate data`);

  let kwh = 0, costPence = 0, missed = 0;
  for (const r of (consData.results || [])) {
    let consumption = r.consumption;
    if (!isElec && consData.results[0]?.consumption < 50) {
      // heuristic: small numbers with m3 units — convert to kWh
      consumption = consumption * 1.02264 * gasCalorificValue() / 3.6;
    }
    const rate = rateAt(rates, +new Date(r.interval_start));
    if (rate === null) { missed++; continue; }
    kwh += consumption;
    costPence += consumption * rate;
  }
  if (debugLabel) {
    const readingCount = (consData.results || []).length;
    const rateVals = rates.map(r => r.rate);
    const minR = rateVals.length ? Math.min(...rateVals).toFixed(2) : 'n/a';
    const maxR = rateVals.length ? Math.max(...rateVals).toFixed(2) : 'n/a';
    logDebug(debugLabel, `${readingCount} reading(s), ${rates.length} rate period(s) (${minR}p–${maxR}p), ${kwh.toFixed(2)} kWh total, ${missed} unmatched`);
  }
  if (missed > 0) {
    logIssue(`${fuel === 'elec' ? 'Electricity' : 'Gas'} rate lookup`,
      new Error(`${missed}/${(consData.results || []).length} reading(s) had no matching rate period and were excluded from the cost total`));
  }
  // hasData distinguishes "genuinely used this much" from "no readings back
  // yet" — smart meter consumption data usually lags 24-48h behind real
  // time, so very recent windows (today, sometimes yesterday) often have no
  // rows at all. But a reading-period placeholder can also land with rows
  // present and kwh totalling exactly zero before the real consumption
  // figure has settled — seen on gas specifically, worse than the usual
  // lag. A genuine zero-usage day (away on holiday) is rare enough that
  // treating 0 kWh as "not settled yet" is the safer default; it just means
  // an actual holiday day briefly shows as pending rather than £0, which
  // self-corrects once a later day's data supersedes it as "latest".
  const hasData = (consData.results || []).length > 0 && kwh > 0.001;
  return { kwh, cost: costPence / 100, hasData };
}

function daysElapsedInMonth(now = new Date()) {
  return now.getDate();
}
function daysInMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}
function isoDate(d) { return d.toISOString().slice(0, 10); }

// Splits an array of half-hourly readings into n local-calendar-day buckets,
// oldest first — same day ordering the old per-day-fetch loop produced, so
// every caller downstream needs no changes. A reading belongs to the day
// its own interval_start falls in, in local time (not UTC), matching how
// day boundaries are computed everywhere else in the app.
function bucketReadingsByDay(results, n, now = new Date()) {
  const buckets = Array.from({ length: n }, () => []);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const r of results) {
    const readingDay = new Date(+new Date(r.interval_start));
    const dayStart = new Date(readingDay.getFullYear(), readingDay.getMonth(), readingDay.getDate());
    const daysAgo = Math.round((+todayStart - +dayStart) / 86400000);
    const idx = n - 1 - daysAgo; // idx 0 = oldest, idx n-1 = today, matching the old loop's ordering
    if (idx >= 0 && idx < n) buckets[idx].push(r);
  }
  return buckets;
}

async function lastNDaysElecSplit(n) {
  const { elecMpan, elecSerial } = store.creds;
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
  const rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const dates = Array.from({ length: n }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i)));
  try {
    if (!elecMpan || !elecSerial) throw new Error('No elec meter point on file');
    const consPath = `/electricity-meter-points/${elecMpan}/meters/${elecSerial}/consumption/?period_from=${rangeStart.toISOString()}&period_to=${rangeEnd.toISOString()}&page_size=1500`;
    const [consData, rates] = await Promise.all([octRest(consPath), fetchElecRates(rangeStart.toISOString(), rangeEnd.toISOString())]);
    if (!rates.length) throw new Error('No elec rate data');
    const threshold = Math.min(...rates.map(r => r.rate)) + 1;
    const buckets = bucketReadingsByDay(consData.results || [], n, now);
    return buckets.map((readings, i) => {
      let offPeakKwh = 0, offPeakCostP = 0, peakKwh = 0, peakCostP = 0;
      for (const r of readings) {
        const rate = rateAt(rates, +new Date(r.interval_start));
        if (rate === null) continue;
        if (rate <= threshold) { offPeakKwh += r.consumption; offPeakCostP += r.consumption * rate; }
        else { peakKwh += r.consumption; peakCostP += r.consumption * rate; }
      }
      return {
        offPeakKwh, peakKwh, offPeakCost: offPeakCostP / 100, peakCost: peakCostP / 100,
        // Same reasoning as before: a placeholder reading-period with rows
        // present but kwh totalling zero is treated as not-yet-settled
        // rather than a genuine zero-usage day.
        hasData: readings.length > 0 && (offPeakKwh + peakKwh) > 0.001,
        date: dates[i]
      };
    });
  } catch (err) {
    logIssue('Electricity week breakdown', err);
    return dates.map(date => ({ offPeakKwh: 0, peakKwh: 0, offPeakCost: 0, peakCost: 0, hasData: false, date }));
  }
}

/* ------------------------------ Rendering -------------------------------- */

function setSyncStatus(state, label) {
  const dot = $('sync-dot');
  dot.className = 'dot' + (state === 'stale' ? ' stale' : state === 'error' ? ' error' : '');
  $('sync-text').textContent = label;
}

let syncIssues = [];
function logIssue(section, err) {
  console.warn(`${section} fallback:`, err.message);
  syncIssues.push(`${section}: ${err.message}`);
}
let debugNotes = [];
let meterDebugNote = null;
let fuelData = { elec: null, gas: null };

// Populated by loadBilling() with figures Insights reuses rather than
// recomputing — the balance and its trend are already fully calculated
// there, no reason to duplicate that logic. nextPaymentAmount/Date feed the
// 12-month balance forecast (each future cycle assumes this same amount
// recurs monthly — same assumption the single-cycle trend already made).
let billingState = { balancePounds: null, trend: null, hasNextPayment: false, nextPaymentAmount: null };
let fuelUnit = { elec: 'cost', gas: 'cost' };
function logDebug(label, msg) {
  console.info(`${label} debug:`, msg);
  debugNotes.push(`${label}: ${msg}`);
}
const demoFallbackEnabled = () => store.creds?.useDemoFallback === true;

function renderDiagnostics() {
  const card = $('diagnostics-card');
  const showDiagnostics = store.creds?.showDiagnostics !== false; // default on
  const syncLog = getSyncLog();
  if (!showDiagnostics || (!syncIssues.length && !debugNotes.length && !syncLog.length)) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  $('diagnostics-title').textContent = syncIssues.length ? '⚠ Diagnostics' : 'ℹ Diagnostics (debug info)';
  $('diagnostics-title').style.color = syncIssues.length ? 'var(--coral)' : 'var(--text-dim)';
  const lines = [
    `ℹ ${restCallsInLastHour()} REST call(s) in the last hour (Octopus's documented shared limit is 100/hour)`,
    ...syncIssues.map(m => `⚠ ${m}`),
    ...debugNotes.map(m => `ℹ ${m}`)
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
      const recent = syncLog.slice(-20).reverse();
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

function renderChartScale(scaleId, max, formatter) {
  if (!scaleId) return;
  const el = document.getElementById(scaleId);
  if (!el) return;
  const fmtVal = formatter || (v => v.toFixed(1));
  el.innerHTML = `<span>${fmtVal(max)}</span><span>${fmtVal(max / 2)}</span><span>${fmtVal(0)}</span>`;
}

function renderWeekBars(containerId, values, colorClass, formatter, maxBarHeight = 44, scaleId = null) {
  const el = $(containerId);
  // Bar height is driven by magnitude, not the raw signed value — EV
  // dispatch kWh can come back negative for short sessions (a real Octopus
  // measurement quirk, kept visible as-is in the signed text/tooltip below),
  // and a negative value divided against a near-zero max would otherwise
  // clamp every bar to the height floor regardless of actual size.
  const max = Math.max(...values.map(Math.abs), 0.01);
  renderChartScale(scaleId, max, formatter);
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = new Date().getDay();
  const showLabels = values.length <= 10; // month view (~28-31 bars) would overlap if labelled per-bar
  el.classList.toggle('dense', !showLabels);
  el.innerHTML = values.map((v, i) => {
    const isToday = i === values.length - 1;
    const h = Math.max(2, Math.round((Math.abs(v) / max) * maxBarHeight));
    const label = showLabels ? `<span>${labels[(today - (values.length - 1 - i) + 7) % 7]}</span>` : '';
    return `<div class="week-bar"><div class="col ${colorClass}${isToday ? ' today' : ''}" style="height:${h}px" title="${formatter ? formatter(v) : v}"></div>${label}</div>`;
  }).join('');
}

const fmtKwh = (v) => `${v.toFixed(1)} kWh`;

// Stacked variant: each day is [{value, cssClass}, ...] segments stacked
// bottom-to-top (e.g. standing charge, then off-peak, then peak). Segment
// order in the array is bottom-to-top.
function renderStackedBars(containerId, dayStacks, formatter, maxBarHeight = 44, scaleId = null, selectedIndex = null, isMonthMode = false) {
  const el = $(containerId);
  const totals = dayStacks.map(day => day.reduce((s, seg) => s + seg.value, 0));
  const max = Math.max(...totals, 0.01);
  renderChartScale(scaleId, max, formatter);
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = new Date().getDay();
  const showLabels = dayStacks.length <= 10;
  el.classList.toggle('dense', !showLabels);
  el.innerHTML = dayStacks.map((segs, i) => {
    const isToday = i === dayStacks.length - 1;
    const isSelected = i === selectedIndex;
    const segHtml = segs.map(seg => {
      const h = Math.max(seg.value > 0 ? 1 : 0, Math.round((seg.value / max) * maxBarHeight));
      return `<div class="col-seg ${seg.cssClass}${isToday ? ' today' : ''}" style="height:${h}px"></div>`;
    }).join('');
    // Month view: real day-of-month number (index+1, matching
    // dateForPeriodIndex's own month-mode logic) — the day-of-week formula
    // below only correctly handles up to a 7-bar span (a single +7
    // wraparound correction), so a longer month array pushed it negative
    // and printed literal "undefined". Numbers are also just more legible
    // for a month's worth of bars than cycling weekday letters anyway.
    const labelText = isMonthMode ? String(i + 1) : labels[(today - (dayStacks.length - 1 - i) + 7) % 7];
    const label = showLabels ? `<span class="${isSelected ? 'active-day' : ''}">${labelText}</span>` : '';
    return `<div class="week-bar"><div class="col-stack${isSelected ? ' selected' : ''}" data-index="${i}">${segHtml}</div>${label}</div>`;
  }).join('');
}

// Renders a fuel panel (elec/gas) from cached data in the currently-selected
// unit (cost or kWh) — pure re-render, no refetch, so the toggle is instant.
let periodMode = 'week';

// Tap-to-see-breakdown state, per fuel. null = no manual selection yet,
// defaults to the latest-available day. Reset to null whenever the
// Week/Month period changes, since the old index would point at a
// completely different day in the new array.
let selectedDay = { elec: null, gas: null };
// Tap-to-breakdown state for the bill-total-over-time chart. billMonthsData
// is repopulated on every loadBilling() run so the click handler always has
// the current grouped-by-month figures to hand, without needing to
// recompute or re-fetch anything.
let selectedBillMonth = null;
let billMonthsData = [];

// Maps an index in the current period array back to a real calendar date —
// week view counts backward from today, month view counts forward from the
// 1st of the current month.
function dateForPeriodIndex(index, arrayLength) {
  const now = new Date();
  if (periodMode === 'month') return new Date(now.getFullYear(), now.getMonth(), index + 1);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (arrayLength - 1 - index));
}

function breakdownRow(label, cssClass, costStr, kwhStr) {
  return `<div class="breakdown-row"><span class="label"><span class="dot ${cssClass}"></span>${label}${kwhStr ? ` (${kwhStr})` : ''}</span><span class="val">${costStr}</span></div>`;
}

// Bill-year chart's tap-to-breakdown — same pattern as renderBreakdown
// above, reusing the same .breakdown-box/.breakdown-row markup and CSS.
// Reads from billMonthsData (populated whenever the chart itself renders)
// rather than needing its own fetch or access to loadBilling's internals.
function renderBillYearBreakdown(index) {
  const box = $('bill-year-breakdown');
  if (!box) return;
  if (index === null || !billMonthsData[index]) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  const m = billMonthsData[index];
  const monthLabel = new Date(m.year, m.month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const billNote = m.bills.length > 1 ? ` · ${m.bills.length} bills` : '';
  const linkHtml = m.bills.length === 1 && m.bills[0].temporaryUrl
    ? `<div style="margin-top:10px;"><a class="bh-link" href="${m.bills[0].temporaryUrl}" target="_blank" aria-label="View bill">View Bill</a></div>`
    : '';
  box.innerHTML = `<div class="breakdown-date">${monthLabel}${billNote}</div>`
    + breakdownRow('Gas', 'seg-gas-usage', fmtGBP(m.gas), null)
    + breakdownRow('Electricity', 'seg-peak', fmtGBP(m.elec), null)
    + `<div class="breakdown-total"><span>Total</span><span>${fmtGBP(m.total)}</span></div>`
    + linkHtml;
}

function renderBreakdown(fuel, periodData, index) {
  const box = $(`${fuel}-breakdown`);
  if (!box) return;
  if (index === null || !periodData || !periodData[index]) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  const day = periodData[index];
  const date = dateForPeriodIndex(index, periodData.length);
  const dateLabel = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });

  let rows;
  if (fuel === 'elec') {
    rows = breakdownRow('Standing charge', 'seg-standing', fmtGBP(day.standing || 0), null)
      + breakdownRow('Off-peak', 'seg-offpeak', fmtGBP(day.offPeakCost || 0), fmtKwh(day.offPeakKwh || 0))
      + breakdownRow('Peak', 'seg-peak', fmtGBP(day.peakCost || 0), fmtKwh(day.peakKwh || 0));
  } else {
    rows = breakdownRow('Standing charge', 'seg-gas-standing', fmtGBP(day.standing || 0), null)
      + breakdownRow('Usage', 'seg-gas-usage', fmtGBP(day.cost || 0), fmtKwh(day.kwh || 0));
  }
  const total = dayTotal(fuel, day, 'cost');
  box.innerHTML = `<div class="breakdown-date">${dateLabel}</div>${rows}<div class="breakdown-total"><span>Total</span><span>${fmtGBP(total)}</span></div>`;
}

// Turns one day's split figures into stacked-bar segments, bottom-to-top.
// Standing charge only appears in £ mode — it has no kWh equivalent.
function buildDaySegments(fuel, day, unit) {
  if (fuel === 'elec') {
    const segs = [];
    if (unit === 'cost') segs.push({ value: day.standing || 0, cssClass: 'seg-standing' });
    segs.push({ value: unit === 'cost' ? day.offPeakCost : day.offPeakKwh, cssClass: 'seg-offpeak' });
    segs.push({ value: unit === 'cost' ? day.peakCost : day.peakKwh, cssClass: 'seg-peak' });
    return segs;
  }
  const segs = [];
  if (unit === 'cost') segs.push({ value: day.standing || 0, cssClass: 'seg-gas-standing' });
  segs.push({ value: unit === 'cost' ? day.cost : day.kwh, cssClass: 'seg-gas-usage' });
  return segs;
}

// Electricity's daily records are split (offPeakCost/peakCost/standing) for
// the stacked chart, while gas's are a flat {cost, kwh}. This normalizes
// either shape into one total — the bug this replaces read `.cost` directly,
// which is undefined on electricity's split shape and produced "£NaN".
function dayTotal(fuel, day, unit) {
  if (fuel === 'elec') {
    if (unit === 'cost') return (day.offPeakCost || 0) + (day.peakCost || 0) + (day.standing || 0);
    return (day.offPeakKwh || 0) + (day.peakKwh || 0);
  }
  if (unit === 'cost') return (day.cost || 0) + (day.standing || 0);
  return day.kwh || 0;
}

function renderFuelPanel(fuel) {
  const d = fuelData[fuel];
  if (!d) return;
  const unit = fuelUnit[fuel];
  const fmt = unit === 'cost' ? fmtGBP : fmtKwh;

  const isDay = periodMode === 'day';
  const isYear = periodMode === 'year';
  const isGasDay = isDay && fuel === 'gas';

  // Visibility: show/hide the right stat-rows and chart containers for the
  // current mode. Gas has no day-stats row at all — Day mode for gas shows
  // only the "not available" explanation, nothing else.
  $(`${fuel}-stats-wm`).classList.toggle('hidden', isDay || isYear);
  $(`${fuel}-stats-wm2`).classList.toggle('hidden', isDay || isYear);
  if (fuel === 'elec') $('elec-stats-day').classList.toggle('hidden', !isDay);
  $(`${fuel}-stats-year`).classList.toggle('hidden', !isYear);

  if (fuel === 'elec') {
    $('elec-wmy-chart').classList.toggle('hidden', isDay);
    $('elec-day-chart').classList.toggle('hidden', !isDay);
  } else {
    $('gas-wmy-chart').classList.toggle('hidden', isGasDay);
    $('gas-day-unavailable').classList.toggle('hidden', !isGasDay);
  }

  // Legend and "Unit rate now" footer: swap content for Year, since it's a
  // single-color total per month, not the standing/off-peak/peak split the
  // Week/Month legend describes — showing that legend in Year mode was a
  // real, confirmed bug (the legend markup existed but had no JS wiring at
  // all, so it silently never changed no matter what was on screen). The
  // unit-rate footer is hidden entirely in Year mode rather than relabeled,
  // since Year shows no cost figures at all for that rate to relate to.
  const legendEl = $(`${fuel}-wmy-legend`);
  if (legendEl) {
    legendEl.innerHTML = isYear
      ? `<span><i style="background:${fuel === 'elec' ? 'var(--pink)' : 'var(--gas-blue)'}"></i>Total usage</span>`
      : (fuel === 'elec'
        ? `<span><i style="background:repeating-linear-gradient(135deg,rgba(234,232,255,0.55) 0 2px,rgba(234,232,255,0.2) 2px 4px)"></i>Standing charge</span><span><i style="background:var(--mint)"></i>Off-peak</span><span><i style="background:var(--pink)"></i>Peak</span>`
        : `<span><i style="background:repeating-linear-gradient(135deg,rgba(234,232,255,0.55) 0 2px,rgba(234,232,255,0.2) 2px 4px)"></i>Standing charge</span><span><i style="background:var(--gas-blue)"></i>Usage</span>`);
  }
  const footEl = document.querySelector(`.fuel-panel.${fuel} .fuel-panel-foot`);
  if (footEl) footEl.classList.toggle('hidden', isYear);

  // £/kWh toggle only makes sense where £ is actually available — hidden
  // for Year, since group_by=month gives exact kWh but not an accurate cost
  // (see fetchYearMonthly for why).
  const toggleWrap = document.querySelector(`.unit-toggle[data-fuel="${fuel}"]`);
  if (toggleWrap) {
    toggleWrap.classList.toggle('hidden', isYear);
    // Sync the active button state here, unconditionally, rather than at the
    // end of the function — Day/Year both return early below, and this was
    // previously stranded after those returns, so the toggle's underlying
    // data changed correctly but the button itself never visually updated.
    toggleWrap.querySelectorAll('.unit-toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.unit === unit);
    });
  }

  if (isGasDay) return; // nothing else to render for gas in Day mode

  if (isDay && fuel === 'elec') { renderElecDayView(); return; }
  if (isYear) { renderYearView(fuel, unit, fmt); return; }

  // --- Week / Month (existing behaviour, unchanged) ---

  // "Latest available day" instead of a fixed Yesterday/Today pair — smart
  // meter data for both fuels typically lags into the next day (sometimes
  // further), so "Today" was reliably empty and "Yesterday" occasionally
  // was too. Scans the week array backward from today for the most recent
  // day that actually has data, and labels it with its real date.
  if (d.week) {
    const today = new Date();
    let found = null, daysAgo = -1;
    for (let i = d.week.length - 1; i >= 0; i--) {
      if (d.week[i].hasData !== false) { found = d.week[i]; daysAgo = d.week.length - 1 - i; break; }
    }
    if (found) {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo);
      const label = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $(`${fuel}-latest-label`).textContent = label;
      $(`${fuel}-latest`).textContent = fmt(dayTotal(fuel, found, unit));
    } else {
      $(`${fuel}-latest-label`).textContent = 'Latest available';
      $(`${fuel}-latest`).textContent = 'No data yet';
    }
    // Always the trailing 7 days regardless of whether Week or Month view is
    // currently toggled for the chart below — this is a fixed "last 7 days" figure.
    const weekTotal = d.week.reduce((sum, day) => sum + dayTotal(fuel, day, unit), 0);
    $(`${fuel}-week-total`).textContent = fmt(weekTotal);
  }

  $(`${fuel}-mtd`).textContent = d.mtd ? fmt(unit === 'cost' ? d.mtd.cost : d.mtd.kwh) : '—';
  $(`${fuel}-predicted`).textContent = d.predicted ? fmt(unit === 'cost' ? d.predicted.cost : d.predicted.kwh) : '—';

  const periodData = periodMode === 'month' ? d.month : d.week;
  if (periodData) {
    const dayStacks = periodData.map(day => buildDaySegments(fuel, day, unit));
    renderStackedBars(`${fuel}-week`, dayStacks, fmt, 58, `${fuel}-week-scale`, selectedDay[fuel], periodMode === 'month');
    renderBreakdown(fuel, periodData, selectedDay[fuel]);
  }
}

// --- Day view (electricity only) ---

let selectedDaySlot = { elec: null };

function renderElecDayView() {
  const day = fuelData.elec?.day;
  const unit = fuelUnit.elec;
  const fmt = unit === 'cost' ? fmtGBP : fmtKwh;

  if (!day || !day.slots || !day.slots.length) {
    $('elec-day-label').textContent = 'Latest available day';
    $('elec-day-total').textContent = 'No data yet';
    $('elec-day-peak').textContent = '—';
    $('elec-day-scale').innerHTML = '';
    $('elec-day-bars').innerHTML = '';
    $('elec-day-breakdown').classList.add('hidden');
    return;
  }

  const dateLabel = day.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('elec-day-label').textContent = dateLabel;
  const total = day.slots.reduce((s, sl) => s + (unit === 'cost' ? sl.cost : sl.kwh), 0);
  $('elec-day-total').textContent = fmt(total);

  // Highest half-hour, converted to an average kW over that slot — a real
  // but approximate figure, not a true instantaneous peak (that's what the
  // Live Usage card is for, at much finer resolution).
  let peakSlot = day.slots[0];
  for (const sl of day.slots) if (sl.kwh > peakSlot.kwh) peakSlot = sl;
  const peakTime = new Date(peakSlot.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('elec-day-peak').textContent = `${(peakSlot.kwh * 2).toFixed(2)} kW at ${peakTime}`;
  logDebug('Day view peak', `${day.slots.length} slot(s), peak ${peakSlot.kwh.toFixed(3)} kWh at ${peakSlot.start} (local ${peakTime})`);

  const values = day.slots.map(sl => unit === 'cost' ? sl.cost : sl.kwh);
  const max = Math.max(...values, 0.01);
  renderChartScale('elec-day-scale', max, unit === 'cost' ? fmtGBP : (v => v.toFixed(1)));

  $('elec-day-bars').innerHTML = day.slots.map((sl, i) => {
    const v = unit === 'cost' ? sl.cost : sl.kwh;
    const h = Math.max(v > 0 ? 1 : 0, Math.round((v / max) * 58));
    const cls = sl.isOffpeak ? 'offpeak' : 'peak';
    const isSelected = i === selectedDaySlot.elec;
    return `<div class="hour-bar"><div class="fill ${cls}${isSelected ? ' selected' : ''}" style="height:${h}px" data-index="${i}"></div></div>`;
  }).join('');

  renderElecDaySlotBreakdown(selectedDaySlot.elec);
}

function renderElecDaySlotBreakdown(index) {
  const box = $('elec-day-breakdown');
  const day = fuelData.elec?.day;
  if (index === null || !day || !day.slots[index]) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  const sl = day.slots[index];
  const startTime = new Date(sl.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const endTime = new Date(+new Date(sl.start) + 30 * 60000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  box.innerHTML = `<div class="breakdown-date">${startTime} – ${endTime}</div>`
    + `<div class="breakdown-row"><span>${sl.kwh.toFixed(2)} kWh at ${sl.rate.toFixed(2)}p (${sl.isOffpeak ? 'Off-peak' : 'Peak'})</span><span>${fmtGBP(sl.cost)}</span></div>`;
}

// --- Year view (both fuels, kWh only) ---

function renderYearView(fuel, unit, fmt) {
  const months = fuelData[fuel]?.year;
  const monthLabels = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const now = new Date();
  const currentMonthIdx = now.getMonth();

  if (!months) {
    $(`${fuel}-ytd`).textContent = '—';
    $(`${fuel}-year-predicted`).textContent = '—';
    $(`${fuel}-week`).innerHTML = '';
    $(`${fuel}-week-scale`).innerHTML = '';
    $(`${fuel}-breakdown`).classList.add('hidden');
    return;
  }

  const totalKwh = months.reduce((s, m) => s + m.kwh, 0);
  $(`${fuel}-ytd`).textContent = fmtKwh(totalKwh);

  // Simple linear projection: average full-year rate based on how much of
  // the year has actually elapsed so far (fraction of a year, not just
  // "months so far", so early in a month doesn't understate progress).
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const daysElapsed = Math.max(1, Math.round((now - startOfYear) / 86400000));
  const daysInYear = (now.getFullYear() % 4 === 0 && (now.getFullYear() % 100 !== 0 || now.getFullYear() % 400 === 0)) ? 366 : 365;
  const predicted = (totalKwh / daysElapsed) * daysInYear;
  $(`${fuel}-year-predicted`).textContent = fmtKwh(predicted);

  const max = Math.max(...months.map(m => m.kwh), 0.01);
  renderChartScale(`${fuel}-week-scale`, max, v => v.toFixed(0));

  const selIdx = selectedDay[fuel];
  const barColor = fuel === 'elec' ? 'var(--pink)' : 'var(--gas-blue)';
  const bars = [];
  for (let m = 0; m <= 11; m++) {
    const entry = months.find(x => x.month === m);
    const isFuture = m > currentMonthIdx;
    const isCurrent = m === currentMonthIdx;
    const v = entry ? entry.kwh : 0;
    const h = isFuture ? 4 : Math.max(v > 0 ? 2 : 4, Math.round((v / max) * 58));
    const fill = isFuture ? 'rgba(255,255,255,0.08)' : (isCurrent ? barColor : barColor);
    const isSelected = m === selIdx;
    bars.push(`<div class="week-bar"><div class="col-stack${isSelected ? ' selected' : ''}" data-index="${m}"><div class="col-seg" style="height:${h}px;background:${fill};opacity:${isCurrent ? '1' : (isFuture ? '1' : '0.75')}"></div></div><span class="${isSelected ? 'active-day' : ''}">${monthLabels[m]}</span></div>`);
  }
  $(`${fuel}-week`).innerHTML = bars.join('');

  renderYearBreakdown(fuel, months, selIdx);
}

// --- Insights (collapsed by default; data lazy-loaded on first expand) ---

let insightsLoaded = false;

async function loadInsights() {
  if (insightsLoaded) return;
  insightsLoaded = true;
  try {
    fuelData.elec = fuelData.elec || {};
    fuelData.gas = fuelData.gas || {};
    const tasks = [];
    if (!fuelData.elec.month) tasks.push(loadMonthData('elec'));
    if (!fuelData.gas.month) tasks.push(loadMonthData('gas'));
    if (!fuelData.gas.year) tasks.push(fetchYearMonthly('gas').then(y => { fuelData.gas.year = y; }));
    await Promise.all(tasks);
    if (fuelData.elec.month) {
      logDebug('Insights elec month', fuelData.elec.month.map((d, i) => `[${i}] £${dayTotal('elec', d, 'cost').toFixed(2)} (hasData:${d.hasData})`).join(' '));
    }
    if (fuelData.gas.month) {
      logDebug('Insights gas month', fuelData.gas.month.map((d, i) => `[${i}] £${dayTotal('gas', d, 'cost').toFixed(2)} (hasData:${d.hasData})`).join(' '));
    }
  } catch (err) {
    logIssue('Insights', err);
  }
  renderInsightsElec();
  renderInsightsGas();
  renderInsightsBilling();
  renderInsightsStanding();
}

// A month-array index maps directly to a calendar date (index 0 = the 1st).
// Deliberately independent of the shared `periodMode`/`dateForPeriodIndex`
// used by the Consumption panel — Insights can load while that panel is
// showing Week, Day, or Year, so it needs its own fixed month-index mapping.
function insightsMonthDate(index) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), index + 1);
}

function renderInsightsElec() {
  const week = fuelData.elec?.week;
  const month = fuelData.elec?.month;

  // Trend vs 7-day average. Deliberately starts from YESTERDAY, not today —
  // today's REST data is essentially always partial (the well-established
  // settlement lag means only a handful of early readings exist for most of
  // the day), so hasData:true for today means "something exists", not "this
  // day is actually complete". Treating a barely-started day as a genuine
  // low point was a real bug, not just an edge case.
  if (week) {
    let found = null, daysAgo = -1;
    for (let i = week.length - 2; i >= 0; i--) {
      if (week[i].hasData !== false) { found = week[i]; daysAgo = week.length - 1 - i; break; }
    }
    const avg = week.reduce((s, d) => s + dayTotal('elec', d, 'cost'), 0) / week.length;
    if (found) {
      const val = dayTotal('elec', found, 'cost');
      const dateStr = found.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const label = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `Latest available day (${dateStr})`;
      $('insights-elec-trend-label').textContent = label;
      $('insights-elec-trend-value').textContent = fmtGBP(val);
      const diff = avg > 0 ? ((val - avg) / avg) * 100 : 0;
      const pill = $('insights-elec-trend-pill');
      // Arrow/text follow the raw numeric direction, but the color needs to
      // be inverted from it: spending MORE than average is bad news (coral),
      // spending LESS is good news (mint) — opposite of what the shared
      // trend-pill up/down classes assume (where "up" always means mint,
      // correct for the balance trend elsewhere, but wrong here).
      pill.className = 'trend-pill ' + (diff <= 0 ? 'up' : 'down');
      pill.textContent = `${diff <= 0 ? '↓' : '↑'} ${Math.abs(diff).toFixed(0)}% ${diff <= 0 ? 'below' : 'above'} your 7-day average`;
      $('insights-elec-trend-caption').textContent = `Your average: ${fmtGBP(avg)}/day`;
    }
  }

  if (month) {
    // Off-peak vs standard split, by cost, across the month so far.
    // Excludes today specifically (not just future dates) — same reasoning
    // as the trend calculation above: today's data is essentially always
    // partial, so including it would understate the split and skew averages
    // toward whatever fraction of today happens to have settled so far.
    const now0 = new Date();
    const todayMidnight = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate());
    let offPeak = 0, standard = 0, offPeakKwh = 0, standardKwh = 0;
    let weekdayTotal = 0, weekdayCount = 0, weekendTotal = 0, weekendCount = 0;
    let high = null, low = null;
    const validDays = month.filter((d, i) => d.hasData !== false && insightsMonthDate(i) < todayMidnight);
    validDays.forEach((d) => {
      offPeak += d.offPeakCost || 0; standard += d.peakCost || 0;
      offPeakKwh += d.offPeakKwh || 0; standardKwh += d.peakKwh || 0;
    });
    const totalCost = offPeak + standard;
    const totalKwh = offPeakKwh + standardKwh;
    if (totalCost > 0) {
      const offPeakPct = (offPeak / totalCost) * 100, standardPct = 100 - offPeakPct;
      $('insights-elec-split-offpeak').style.width = offPeakPct + '%';
      $('insights-elec-split-standard').style.width = standardPct + '%';
      $('insights-elec-split-offpeak-pct').textContent = offPeakPct.toFixed(0) + '%';
      $('insights-elec-split-standard-pct').textContent = standardPct.toFixed(0) + '%';
      const kwhOffPeakPct = totalKwh > 0 ? (offPeakKwh / totalKwh) * 100 : offPeakPct;
      $('insights-elec-split-note').textContent =
        `By energy used, it's closer to ${kwhOffPeakPct.toFixed(0)}/${(100 - kwhOffPeakPct).toFixed(0)} — but Standard rate costs about 4x as much per kWh, so it dominates your bill more than usage alone would suggest.`;
    }

    // Weekday vs weekend, and best/worst day — same pass over the month.
    month.forEach((d, i) => {
      const date = insightsMonthDate(i);
      if (date >= todayMidnight || d.hasData === false) return;
      const total = dayTotal('elec', d, 'cost');
      const dow = date.getDay();
      if (dow === 0 || dow === 6) { weekendTotal += total; weekendCount++; }
      else { weekdayTotal += total; weekdayCount++; }
      if (!high || total > high.total) high = { total, date };
      if (!low || total < low.total) low = { total, date };
    });

    if (weekdayCount > 0 && weekendCount > 0) {
      const weekdayAvg = weekdayTotal / weekdayCount, weekendAvg = weekendTotal / weekendCount;
      const total = weekdayAvg + weekendAvg || 1;
      const weekdayPct = Math.min(88, Math.max(12, Math.round((weekdayAvg / total) * 100)));
      $('insights-elec-weekday-value').textContent = fmtGBP(weekdayAvg);
      $('insights-elec-weekend-value').textContent = fmtGBP(weekendAvg);
      $('insights-elec-weekday-bar').style.width = weekdayPct + '%';
      $('insights-elec-weekend-bar').style.width = (100 - weekdayPct) + '%';
      const diffPct = weekdayAvg > 0 ? ((weekendAvg - weekdayAvg) / weekdayAvg) * 100 : 0;
      const pill = $('insights-elec-pattern-headline');
      if (Math.abs(diffPct) < 5) {
        pill.className = 'trend-pill up';
        pill.textContent = '≈ No significant weekday/weekend difference';
      } else {
        const pricier = diffPct > 0 ? 'Weekends' : 'Weekdays';
        pill.className = 'trend-pill down';
        pill.textContent = `↑ ${pricier} cost ${Math.abs(diffPct).toFixed(0)}% more on average`;
      }
      $('insights-elec-weekday-block').classList.remove('hidden');
    } else {
      $('insights-elec-weekday-block').classList.add('hidden'); // not enough of both kinds yet this month
    }

    if (high && low) {
      $('insights-elec-high-value').textContent = fmtGBP(high.total);
      $('insights-elec-high-date').textContent = high.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('insights-elec-low-value').textContent = fmtGBP(low.total);
      $('insights-elec-low-date').textContent = low.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('insights-elec-extremes-block').classList.remove('hidden');
    } else {
      $('insights-elec-extremes-block').classList.add('hidden');
    }

    // Trajectory: first half of the elapsed month-to-date vs second half.
    if (validDays.length >= 6) {
      const mid = Math.floor(validDays.length / 2);
      const firstHalf = validDays.slice(0, mid), secondHalf = validDays.slice(mid);
      const firstAvg = firstHalf.reduce((s, d) => s + dayTotal('elec', d, 'cost'), 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, d) => s + dayTotal('elec', d, 'cost'), 0) / secondHalf.length;
      const diffPct = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;
      $('insights-elec-trajectory-icon').textContent = diffPct >= 0 ? '📈' : '📉';
      $('insights-elec-trajectory-text').innerHTML = Math.abs(diffPct) < 5
        ? 'Fairly steady so far this month — no clear upward or downward trend'
        : `More recent days running <b>${Math.abs(diffPct).toFixed(0)}% ${diffPct >= 0 ? 'higher' : 'lower'}</b> than earlier this month`;
      $('insights-elec-trajectory-block').classList.remove('hidden');
    } else {
      $('insights-elec-trajectory-block').classList.add('hidden'); // too early in the month for this to mean much
    }
  }
}

function renderInsightsGas() {
  const week = fuelData.gas?.week;
  const month = fuelData.gas?.month;
  const year = fuelData.gas?.year;

  if (week) {
    let found = null, daysAgo = -1;
    for (let i = week.length - 2; i >= 0; i--) {
      if (week[i].hasData !== false) { found = week[i]; daysAgo = week.length - 1 - i; break; }
    }
    const avg = week.reduce((s, d) => s + dayTotal('gas', d, 'cost'), 0) / week.length;
    if (found) {
      const val = dayTotal('gas', found, 'cost');
      const dateStr = found.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const label = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `Latest available day (${dateStr})`;
      $('insights-gas-trend-label').textContent = label;
      $('insights-gas-trend-value').textContent = fmtGBP(val);
      const diff = avg > 0 ? ((val - avg) / avg) * 100 : 0;
      const pill = $('insights-gas-trend-pill');
      pill.className = 'trend-pill ' + (diff <= 0 ? 'up' : 'down');
      pill.textContent = `${diff <= 0 ? '↓' : '↑'} ${Math.abs(diff).toFixed(0)}% ${diff <= 0 ? 'below' : 'above'} your 7-day average`;
      $('insights-gas-trend-caption').textContent = `Your average: ${fmtGBP(avg)}/day`;
    }
  }

  if (month) {
    const now1 = new Date();
    const todayMidnight1 = new Date(now1.getFullYear(), now1.getMonth(), now1.getDate());
    let standing = 0, usage = 0, high = null, low = null;
    month.forEach((d, i) => {
      const date = insightsMonthDate(i);
      if (date >= todayMidnight1 || d.hasData === false) return;
      standing += d.standing || 0; usage += d.cost || 0;
      const total = dayTotal('gas', d, 'cost');
      if (!high || total > high.total) high = { total, date };
      if (!low || total < low.total) low = { total, date };
    });
    const total = standing + usage;
    if (total > 0) {
      const standingPct = (standing / total) * 100, usagePct = 100 - standingPct;
      $('insights-gas-split-standing').style.width = standingPct + '%';
      $('insights-gas-split-usage').style.width = usagePct + '%';
      $('insights-gas-split-standing-pct').textContent = standingPct.toFixed(0) + '%';
      $('insights-gas-split-usage-pct').textContent = usagePct.toFixed(0) + '%';
    }
    if (high && low) {
      $('insights-gas-high-value').textContent = fmtGBP(high.total);
      $('insights-gas-high-date').textContent = high.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('insights-gas-low-value').textContent = fmtGBP(low.total);
      $('insights-gas-low-date').textContent = low.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('insights-gas-extremes-block').classList.remove('hidden');
    } else {
      $('insights-gas-extremes-block').classList.add('hidden');
    }
  }

  // Seasonal narrative from Year data — kWh-based (Year view is deliberately
  // kWh-only), comparing this month's total against the highest month so far.
  if (year && year.length >= 2) {
    const now = new Date();
    const thisMonth = year.find(m => m.month === now.getMonth());
    const peakMonth = year.reduce((max, m) => (m.kwh > (max?.kwh || 0) ? m : max), null);
    if (thisMonth && peakMonth && peakMonth.kwh > 0 && thisMonth.month !== peakMonth.month) {
      const dropPct = ((peakMonth.kwh - thisMonth.kwh) / peakMonth.kwh) * 100;
      const isLowest = year.every(m => m.month === thisMonth.month || m.kwh >= thisMonth.kwh);
      if (Math.abs(dropPct) >= 10) {
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        $('insights-gas-seasonal-text').textContent =
          `${dropPct > 0 ? 'Down' : 'Up'} ${Math.abs(dropPct).toFixed(0)}% from your highest month (${monthNames[peakMonth.month]})` +
          (isLowest && dropPct > 0 ? ' — your lowest month so far this year.' : '.');
        $('insights-gas-seasonal-note').classList.remove('hidden');
      }
    }
  }
}

// Season-aware 12-month balance forecast. For each of the next 12 payment
// cycles, prices *last year's same calendar month's actual kWh* (from
// billMonthsData, already fetched for the bill-year chart — no new API
// calls) at *today's* rate, rather than repeating this month's cost flat
// twelve times. Two things are genuinely unknowable this far out and stay
// fixed at today's value throughout: the unit rate (variable tariffs will
// likely differ by the time a given month arrives) and the Direct Debit
// amount (Octopus reviews and can change it). Everything else — the exact
// day count per month, today's standing charge, last year's real usage —
// is exact, not estimated.
//
// A cycle falls back to a flat repeat of this month's predicted cost only
// when no matching month exists in the bill history (new account, or a
// gap from tariff-switch bill bunching — same limitation already
// documented for the bill-year chart's 15-bill buffer).
function todayBlendedRateP(fuel) {
  const mtd = fuelData[fuel]?.mtd;
  if (!mtd || !mtd.kwh) return null;
  return (mtd.usageCost / mtd.kwh) * 100; // pence/kWh, usage-only — standing charge is added separately per cycle in computeBalanceForecast, so mixing it in here would double-count it
}

function computeBalanceForecast() {
  if (!billingState.hasNextPayment || billingState.balancePounds === null || billingState.nextPaymentAmount === null) return null;
  const elecRateP = todayBlendedRateP('elec');
  const gasRateP = todayBlendedRateP('gas');
  if (elecRateP === null && gasRateP === null) return null;

  const monthByKey = new Map(billMonthsData.map(m => [`${m.year}-${m.month}`, m]));
  const now = new Date();
  let running = billingState.balancePounds;
  const cycles = [];

  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const lastYearKey = `${d.getFullYear() - 1}-${d.getMonth()}`;
    const histMonth = monthByKey.get(lastYearKey);
    const days = daysInMonth(d);
    let elecCost, gasCost, fallback;

    if (histMonth && (histMonth.elecKwh > 0 || histMonth.gasKwh > 0) && elecRateP !== null) {
      elecCost = (histMonth.elecKwh * elecRateP / 100) + ((cachedElecStandingP || 0) / 100 * days);
      gasCost = gasRateP !== null ? (histMonth.gasKwh * gasRateP / 100) + ((cachedGasStandingP || 0) / 100 * days) : 0;
      fallback = false;
    } else {
      // No matching month last year — flat repeat of this month's own
      // predicted cost, same assumption the original single-cycle trend made.
      elecCost = fuelData.elec?.predicted?.cost || 0;
      gasCost = fuelData.gas?.predicted?.cost || 0;
      fallback = true;
    }

    const payment = billingState.nextPaymentAmount;
    running += payment - elecCost - gasCost;
    cycles.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      full: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      fallback,
      elec: -elecCost,
      gas: -gasCost,
      payment,
      cumulative: running,
      sourceYear: histMonth ? d.getFullYear() - 1 : null,
      sourceMonthLabel: histMonth ? new Date(d.getFullYear() - 1, d.getMonth(), 1).toLocaleDateString('en-GB', { month: 'short' }) : null
    });
  }
  return cycles;
}

let balanceForecastData = [];
let selectedForecastCycle = null;

function renderBalanceForecastBreakdown(index) {
  const box = $('insights-runway-breakdown');
  if (!box) return;
  if (index === null || !balanceForecastData[index]) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const d = balanceForecastData[index];
  const source = d.fallback
    ? `Not enough billing history for ${d.label} yet — using this month's own predicted cost as a flat estimate.`
    : `Based on ${d.sourceMonthLabel} ${d.sourceYear} usage, priced at today's rates`;
  box.innerHTML = `<div class="breakdown-date">${d.full}</div>`
    + `<div class="breakdown-source">${source}</div>`
    + breakdownRow('Payment', 'seg-payment', fmtGBP(d.payment), null)
    + breakdownRow('Electricity', 'seg-peak', fmtGBP(d.elec), null)
    + breakdownRow('Gas', 'seg-gas-usage', fmtGBP(d.gas), null)
    + `<div class="breakdown-total"><span>Projected balance</span><span style="color:${d.cumulative < 0 ? 'var(--coral)' : 'var(--mint)'}">${fmtGBP(d.cumulative)}</span></div>`;
}

function renderBalanceForecastChart() {
  const wrap = $('insights-runway-chart-wrap');
  if (!balanceForecastData.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  const maxPos = Math.max(...balanceForecastData.map(c => c.cumulative), 0);
  const minCumulative = Math.min(...balanceForecastData.map(c => c.cumulative), 0);
  const hasNegative = minCumulative < 0;
  const maxNeg = hasNegative ? Math.abs(minCumulative) : 0;
  const range = (maxPos + maxNeg) || 1; // only guards true div-by-zero, never fakes a negative range
  const chartH = 100;
  // No genuine debit cycle at all (common case, e.g. a well-sized DD) —
  // bars grow from a true bottom baseline instead of reserving space for a
  // negative region that doesn't exist. Previously this fell back to a
  // fake £1 negative range just to avoid dividing by zero, which pushed
  // the £0 label to sit almost exactly on top of a fabricated bottom
  // label — a real collision, not just a rounding artifact.
  const posH = hasNegative ? (maxPos / range) * chartH : chartH;
  const negH = chartH - posH;

  $('insights-runway-zeroline').style.top = posH + 'px';
  $('insights-runway-scale').innerHTML = hasNegative
    ? `<span style="position:absolute;top:0px;right:0;transform:translateY(-50%)">${fmtGBP(Math.ceil(maxPos))}</span>`
      + `<span style="position:absolute;top:${posH}px;right:0;transform:translateY(-50%)">£0</span>`
      + `<span style="position:absolute;top:${chartH}px;right:0;transform:translateY(-50%)">${fmtGBP(-Math.ceil(maxNeg))}</span>`
    : `<span style="position:absolute;top:0px;right:0;transform:translateY(-50%)">${fmtGBP(Math.ceil(maxPos))}</span>`
      + `<span style="position:absolute;top:${chartH}px;right:0;transform:translateY(-50%)">£0</span>`;

  $('insights-runway-bars').innerHTML = balanceForecastData.map((c, i) => {
    const isNeg = c.cumulative < 0;
    const h = isNeg ? Math.max(2, Math.round((Math.abs(c.cumulative) / maxNeg) * negH))
                     : Math.max(2, Math.round((c.cumulative / maxPos) * posH));
    const pos = isNeg ? `top:${posH}px;height:${h}px` : `bottom:${negH}px;height:${h}px`;
    const cls = 'forecast-bar' + (isNeg ? ' neg' : '') + (c.fallback ? ' fallback' : '') + (i === selectedForecastCycle ? ' selected' : '');
    return `<div class="forecast-col"><div class="forecast-bar-wrap" data-index="${i}"><div class="${cls}" style="${pos}"></div></div></div>`;
  }).join('');
  $('insights-runway-labels').innerHTML = balanceForecastData.map((c, i) =>
    `<span class="${i === selectedForecastCycle ? 'active-day' : ''}">${c.label}</span>`).join('');

  renderBalanceForecastBreakdown(selectedForecastCycle);
}

function renderInsightsBilling() {
  const icon = $('insights-runway-icon'), headline = $('insights-runway-headline'), detail = $('insights-runway-detail');
  balanceForecastData = computeBalanceForecast() || [];

  if (!balanceForecastData.length) {
    icon.textContent = '—';
    headline.textContent = 'Not enough data yet';
    headline.className = 'runway-headline';
    detail.textContent = 'Needs a Direct Debit figure and at least one fuel\'s rate to project from — see the Billing card above.';
    $('insights-runway-chart-wrap').classList.add('hidden');
    return;
  }

  if (selectedForecastCycle === null) {
    // Default to the lowest point — the number the headline itself refers
    // to, so tapping isn't required to see what "lowest point" means.
    let lowIdx = 0;
    balanceForecastData.forEach((c, i) => { if (c.cumulative < balanceForecastData[lowIdx].cumulative) lowIdx = i; });
    selectedForecastCycle = lowIdx;
  }

  const allPositive = balanceForecastData.every(c => c.cumulative >= 0);
  if (allPositive) {
    const lastMonth = balanceForecastData[balanceForecastData.length - 1];
    icon.textContent = '📈';
    headline.className = 'runway-headline ok';
    headline.textContent = 'Payments look sufficient';
    detail.textContent = `Projected to stay in credit through ${lastMonth.label}`;
  } else {
    const dipIdx = balanceForecastData.findIndex(c => c.cumulative < 0);
    const recoverIdx = balanceForecastData.findIndex((c, i) => i > dipIdx && c.cumulative >= 0);
    let lowIdx = 0;
    balanceForecastData.forEach((c, i) => { if (c.cumulative < balanceForecastData[lowIdx].cumulative) lowIdx = i; });
    icon.textContent = '⚠️';
    headline.className = 'runway-headline warn';
    if (recoverIdx !== -1) {
      headline.textContent = `Payments may be tight — dips into debit around ${balanceForecastData[dipIdx].label}, recovers by ${balanceForecastData[recoverIdx].label}`;
      detail.textContent = `Lowest point: ${fmtGBP(balanceForecastData[lowIdx].cumulative)} in ${balanceForecastData[lowIdx].label}`;
    } else {
      headline.textContent = `Payments look insufficient — still in debit by ${balanceForecastData[balanceForecastData.length - 1].label}`;
      detail.textContent = `Lowest point: ${fmtGBP(balanceForecastData[lowIdx].cumulative)} in ${balanceForecastData[lowIdx].label} — consider increasing your Direct Debit`;
    }
  }

  renderBalanceForecastChart();
}

function renderInsightsStanding() {
  if (!cachedElecStandingP && !cachedGasStandingP) return;
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const daysElapsed = Math.max(1, Math.round((now - startOfYear) / 86400000));
  const daysInYear = (now.getFullYear() % 4 === 0 && (now.getFullYear() % 100 !== 0 || now.getFullYear() % 400 === 0)) ? 366 : 365;
  const dailyRateP = (cachedElecStandingP || 0) + (cachedGasStandingP || 0);
  $('insights-standing-ytd').textContent = fmtGBP((dailyRateP * daysElapsed) / 100);
  $('insights-standing-full-year').textContent = fmtGBP((dailyRateP * daysInYear) / 100);
}

function renderYearBreakdown(fuel, months, monthIndex) {
  const box = $(`${fuel}-breakdown`);
  const now = new Date();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  if (monthIndex === null) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const isCurrent = monthIndex === now.getMonth();
  const isFuture = monthIndex > now.getMonth();
  const label = `${monthNames[monthIndex]}${isCurrent ? ' (month to date)' : ''} ${now.getFullYear()}`;
  const entry = months.find(m => m.month === monthIndex);
  if (isFuture || !entry) {
    box.innerHTML = `<div class="breakdown-date">${label}</div><div class="breakdown-row"><span>No data yet</span><span>—</span></div>`;
    return;
  }
  box.innerHTML = `<div class="breakdown-date">${label}</div><div class="breakdown-total"><span>Total</span><span>${fmtKwh(entry.kwh)}</span></div>`;
}


// Lazily fetches this-month daily figures the first time "Month" view is
// selected, so the app doesn't fetch ~30 days of data on every sync by default.
async function loadMonthData(fuel) {
  if (fuelData[fuel]?.month) return;
  const elapsedDays = daysElapsedInMonth(new Date());
  const out = fuel === 'elec'
    ? await lastNDaysElecSplitWithStanding(elapsedDays)
    : await lastNDaysGasSplitWithStanding(elapsedDays);
  fuelData[fuel] = fuelData[fuel] || {};
  fuelData[fuel].month = out;
}

// Adds the (roughly constant) daily standing charge onto each day's split,
// using whatever was last fetched by loadBilling — so the chart's standing-
// charge segment doesn't need its own API call per day.
async function lastNDaysElecSplitWithStanding(n) {
  const days = await lastNDaysElecSplit(n);
  const standing = cachedElecStandingP ? cachedElecStandingP / 100 : 0;
  return days.map(d => ({ ...d, standing }));
}
async function lastNDaysGasSplitWithStanding(n) {
  const days = await lastNDaysCost('gas', n);
  const standing = cachedGasStandingP ? cachedGasStandingP / 100 : 0;
  return days.map(d => ({ ...d, standing }));
}

// Electricity-only: half-hourly breakdown for a single day, used by Day view.
// Steps backward from today (same "consumption data lags" reality as
// everywhere else in the app) until it finds a day with actual readings,
// giving up after a few tries rather than looping indefinitely.
async function fetchElecDayHalfHourly() {
  const { elecMpan, elecSerial } = store.creds;
  if (!elecMpan || !elecSerial) throw new Error('No elec meter point on file');
  // A full day is 48 half-hour slots (46/47 on a DST-change day) — require
  // most of that before accepting a day as "available". A handful of early
  // readings trickling in for today passed the old "any data at all" check,
  // producing a near-empty 2-bar chart that looked broken rather than
  // genuinely incomplete.
  const MIN_SLOTS_FOR_COMPLETE_DAY = 40;
  for (let daysAgo = 0; daysAgo <= 3; daysAgo++) {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    const fromISO = dayStart.toISOString(), toISO = dayEnd.toISOString();
    const consPath = `/electricity-meter-points/${elecMpan}/meters/${elecSerial}/consumption/?period_from=${fromISO}&period_to=${toISO}&page_size=100`;
    const [consData, rates] = await Promise.all([octRest(consPath), fetchElecRates(fromISO, toISO)]);
    const results = consData.results || [];
    logDebug('Day view', `Checked ${dayStart.toDateString()}: ${results.length} reading(s)${results.length < MIN_SLOTS_FOR_COMPLETE_DAY ? ' — not enough for a full day, trying further back' : ' — using this day'}`);
    if (results.length < MIN_SLOTS_FOR_COMPLETE_DAY) continue; // incomplete — try further back
    const threshold = rates.length ? Math.min(...rates.map(r => r.rate)) + 1 : 0;
    const slots = results
      .map(r => {
        const rate = rateAt(rates, +new Date(r.interval_start));
        if (rate === null) return null;
        return {
          start: r.interval_start,
          kwh: r.consumption,
          rate,
          cost: r.consumption * rate / 100,
          isOffpeak: rate <= threshold
        };
      })
      .filter(Boolean)
      .sort((a, b) => +new Date(a.start) - +new Date(b.start));
    return { date: dayStart, slots };
  }
  return { date: null, slots: [] }; // genuinely no complete day in the last few days
}

// Monthly kWh totals for the calendar year so far, one API call per fuel via
// group_by=month. Deliberately kWh-only, not £ — a monthly total can't be
// converted to an accurate cost without knowing exactly when within the
// month the energy was used (rates change over time, and for electricity
// also vary by time of day), which group_by=month doesn't preserve. Getting
// real £ would mean the same day-by-day rate-matching Month view already
// does, just for the whole year — far more calls, so deliberately skipped
// for now in favour of an honest, exact kWh figure over a slow, blended-rate
// estimate.
async function fetchYearMonthly(fuel) {
  const creds = store.creds;
  const isElec = fuel === 'elec';
  const mp = isElec ? creds.elecMpan : creds.gasMprn;
  const serial = isElec ? creds.elecSerial : creds.gasSerial;
  if (!mp || !serial) throw new Error(`No ${fuel} meter point on file`);
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();
  const path = isElec
    ? `/electricity-meter-points/${mp}/meters/${serial}/consumption/?period_from=${yearStart}&period_to=${now.toISOString()}&group_by=month&page_size=100`
    : `/gas-meter-points/${mp}/meters/${serial}/consumption/?period_from=${yearStart}&period_to=${now.toISOString()}&group_by=month&page_size=100`;
  const data = await octRest(path);
  const results = (data.results || []).sort((a, b) => +new Date(a.interval_start) - +new Date(b.interval_start));
  return results.map(r => {
    let kwh = r.consumption;
    if (!isElec && results[0]?.consumption < 500) kwh = kwh * 1.02264 * gasCalorificValue() / 3.6; // m3 → kWh, same heuristic as costForRange
    return { month: new Date(r.interval_start).getMonth(), kwh, hasData: true };
  });
}

/* ------------------------------ Data loaders ------------------------------ */

async function loadRates() {
  try {
    const now = new Date();
    const todayISO = isoDate(now);
    const fromISO = `${todayISO}T00:00Z`;
    const toISO = `${todayISO}T23:59Z`;
    const rows = await fetchElecRates(fromISO, toISO);
    if (!rows.length) throw new Error('No rate data returned');

    // Still expand into 48 half-hourly points — not drawn as a curve anymore,
    // but used for today's average/max and the off-peak threshold check.
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const points = Array.from({ length: 48 }, (_, i) => {
      const t = +dayStart + i * 30 * 60 * 1000;
      return rateAt(rows, t) ?? rows[0].rate;
    });

    const nowIdx = Math.min(47, Math.floor((now - dayStart) / (30 * 60 * 1000)));
    const current = points[nowIdx];
    const threshold = Math.min(...points) + 1; // treat near-minimum as off-peak window

    cachedOffPeakRateP = Math.min(...points);
    cachedCurrentRateP = current;

    $('rate-value').innerHTML = `${Math.round(current)}<span>p/kWh</span>`;
    $('elec-unit-rate').textContent = `${current.toFixed(1)}p`;
    const isCheap = current <= threshold;
    $('rate-value').style.color = isCheap ? 'var(--mint)' : 'var(--pink)';
    $('rate-pill').className = 'card-tag ' + (isCheap ? 'tag-mint' : 'tag-pink');
    $('rate-pill').textContent = isCheap ? '● Off-peak' : '● Standard';
    $('rate-standard').textContent = fmtP(Math.max(...points));
    $('rate-offpeak').textContent = fmtP(cachedOffPeakRateP);

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
      cachedOffPeakRateP = 7.5;
      cachedCurrentRateP = 7.5;
      $('rate-value').innerHTML = `8<span>p/kWh</span>`;
      $('rate-value').style.color = 'var(--mint)';
      $('elec-unit-rate').textContent = '7.5p (demo)';
      $('rate-pill').className = 'card-tag tag-mint';
      $('rate-pill').textContent = '● Off-peak (demo)';
      $('rate-standard').textContent = '28.9p';
      $('rate-offpeak').textContent = '8.0p';
      $('rate-next').textContent = '05:30 → 28.90p';
    } else {
      $('rate-value').innerHTML = `—<span>p/kWh</span>`;
      $('rate-value').style.color = 'var(--text-dim)';
      $('elec-unit-rate').textContent = 'Unavailable';
      $('rate-pill').className = 'card-tag tag-dim';
      $('rate-pill').textContent = '● Unavailable';
      $('rate-standard').textContent = '—';
      $('rate-offpeak').textContent = '—';
      $('rate-next').textContent = '—';
    }
    return false;
  }
}

/* ------------------------------ Live usage -------------------------------- */
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

async function loadLiveUsage() {
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
    const watts = Math.round(latest.demand);
    $('live-watts').innerHTML = `${watts}<span>W</span>`;
    $('live-watts').style.color = liveWattsColor(watts);
    $('live-updated').textContent = `Updated ${new Date(latest.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    $('live-tag').style.display = '';
    logDebug('Live telemetry', `${points.length} point(s), latest demand ${latest.demand}W, raw consumptionDelta ${latest.consumptionDelta}`);

    // Cost-per-hour if this draw were sustained for a full hour — meant to
    // translate raw watts into something that actually motivates turning
    // something off, not a prediction of what you'll really spend.
    const rateP = cachedCurrentRateP ?? cachedOffPeakRateP;
    if (rateP != null) {
      const poundsPerHour = (watts / 1000) * rateP / 100;
      $('live-cost-rate').innerHTML = `≈ <b style="color:var(--mint)">${fmtGBP(poundsPerHour)}</b>/hr at this rate`;
    } else {
      $('live-cost-rate').textContent = '';
    }

    return true;
  } catch (err) {
    logIssue('Live usage', err);
    $('live-tag').style.display = 'none';
    $('live-updated').textContent = 'Unavailable right now';
    return false;
  }
}

// Last-30-minutes panel — lazy-loaded only when opened (not part of the
// regular 30s live poll), and kept genuinely live with its own 30s refresh
// while open, matching the request that this stay "truly live" like the
// headline draw figure. Goes through krakenGQL (Kraken's GraphQL endpoint),
// not octRest, so it never touches the REST-call diagnostic counter — that
// counter only tracks Octopus's separate REST API.
//
// Uses the same TEN_SECONDS grouping already proven to work for the 2-minute
// query above, rather than guessing at an unconfirmed coarser grouping enum
// value that could break the whole query if wrong (same caution already
// applied elsewhere in this file, e.g. the EV dispatch type introspection).
// Up to 180 raw points get bucketed client-side into 1-minute bars instead.
let live30Open = false;
let live30Interval = null;

function bucketTelemetryByMinute(points, now) {
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

async function loadLive30() {
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

function closeLive30() {
  live30Open = false;
  $('live30-toggle')?.setAttribute('aria-expanded', 'false');
  $('live30-panel')?.classList.add('hidden');
  if (live30Interval) { clearInterval(live30Interval); live30Interval = null; }
}

function openLive30() {
  live30Open = true;
  $('live30-toggle').setAttribute('aria-expanded', 'true');
  $('live30-panel').classList.remove('hidden');
  loadLive30();
  // Own 30s refresh while open, matching the headline draw figure's cadence
  // — stops the moment the panel closes, so it's not fetching in the
  // background when nobody's looking at it.
  live30Interval = setInterval(loadLive30, 30 * 1000);
}

// EV card collapse: hidden by default whenever idle with nothing scheduled,
// so it doesn't dominate the screen for a state where nothing's happening.
// Auto-opens the moment something becomes worth seeing (a dispatch starts or
// gets scheduled) — but only on that transition, not on every subsequent
// sync, so a deliberate manual collapse during an already-active session
// isn't immediately fought and reopened. User can always tap the header to
// toggle it manually regardless of state.
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
// Splits vehicle info into two pieces for the title-plus-caption layout:
// the title-line suffix ("— Polestar 2", matching the same em-dash
// convention already used by "Electricity — Intelligent Go" and
// "Gas — Flexible Octopus"), and whatever's left of the model string
// (e.g. "Standard Range Single Motor") for a smaller caption underneath.
// Best-effort based on the one real account confirmed via diagnostics, so
// may not generalise perfectly to every make/model Octopus could return.
function formatVehicleName(make, model) {
  if (!make) return { title: '', caption: '' };
  const words = model ? model.trim().split(/\s+/) : [];
  const shortModel = words[0] || '';
  const caption = words.slice(1).join(' ');
  return { title: ` — ${make}${shortModel ? ' ' + shortModel : ''}`, caption };
}

async function loadVehicleInfoOnce() {
  const creds = store.creds || {};
  if (creds.vehicleChecked) {
    if (creds.vehicleMake) {
      const { title, caption } = formatVehicleName(creds.vehicleMake, creds.vehicleModel);
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
    if (v?.vehicleMake) {
      const { title, caption } = formatVehicleName(v.vehicleMake, v.vehicleModel);
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

async function loadEV() {
  const smartFlexOk = await loadEVSmartFlex().catch(err => { logIssue('EV SmartFlex data', err); return false; });
  if (smartFlexOk) return true;
  return loadEVLegacy();
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
// SmartFlexDispatch.dispatches inside each session gives per-window
// detail (start/end/type/kWh), so the dispatch-window view is derived
// from the same one query rather than needing completedDispatches at all
// — only plannedDispatches stays as its own call, since chargingSessions
// is explicitly historical.
async function loadEVSmartFlex() {
  const data = await krakenGQL(`
    query EVSmartFlexData($accountNumber: String!, $after: DateTime!) {
      devices(accountNumber: $accountNumber) {
        ... on SmartFlexVehicle {
          make model
          status { ... on SmartFlexVehicleStatus { stateOfCharge { value } } }
          chargingSessions(after: $after, first: 30) {
            edges {
              node {
                ... on SmartFlexChargingSession {
                  start end type
                  cost { amount }
                  energyAdded { value }
                  stateOfChargeFinal
                  dispatches { start end type energyAddedKwh }
                }
              }
            }
          }
        }
      }
      plannedDispatches(accountNumber: $accountNumber) { start end delta }
    }`, {
      accountNumber: store.creds.accountNumber,
      after: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    });

  const vehicle = (data.devices || []).find(d => d && d.chargingSessions);
  if (!vehicle) return false; // no EV device on this path, or wrong shape — fall back to legacy

  const sessions = (vehicle.chargingSessions?.edges || []).map(e => e.node).filter(Boolean);
  const planned = data.plannedDispatches || [];
  const now = new Date();
  const activeDispatch = planned.find(d => now >= new Date(d.start) && now < new Date(d.end));

  $('ev-tag').textContent = activeDispatch ? 'CHARGING' : (planned.length ? 'SCHEDULED' : 'IDLE');
  $('ev-tag').className = activeDispatch ? 'card-tag tag-pink' : (planned.length ? 'card-tag tag-amber' : 'card-tag tag-dim');
  applyEvCollapse(!!activeDispatch || planned.length > 0);

  if (planned[0]) {
    const s = new Date(planned[0].start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const e = new Date(planned[0].end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('ev-ready').textContent = `${s} – ${e}`;
  } else {
    $('ev-ready').textContent = 'None scheduled';
  }

  // Battery gauge — genuinely new, wasn't available via the legacy path at all
  const soc = vehicle.status?.stateOfCharge?.value;
  if (soc != null) {
    $('ev-battery-row').classList.remove('hidden');
    const pct = Math.min(100, Math.max(0, soc));
    $('ev-battery-pct').textContent = `${Math.round(pct)}%`;
    $('ev-battery-fill').style.width = `${pct}%`;
  } else {
    $('ev-battery-row').classList.add('hidden');
  }

  const fmtT = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const badgeHtml = type => `<span class="slot-badge ${type === 'BOOST' ? 'badge-boost' : 'badge-smart'}">${type}</span>`;

  // Dispatch-window view — derived from each session's nested dispatches,
  // flattened and sorted oldest-first (same chronological-timeline
  // convention as before), now with a real SMART/BOOST badge per window.
  const allDispatches = [];
  sessions.forEach(s => (s.dispatches || []).forEach(d => allDispatches.push(d)));
  allDispatches.sort((a, b) => new Date(a.start) - new Date(b.start));

  const dispatchSlots = $('ev-slots-dispatch');
  dispatchSlots.classList.remove('hidden');
  dispatchSlots.innerHTML = allDispatches.map(d =>
    `<div class="slot done"><span>✓ ${fmtT(d.start)} – ${fmtT(d.end)}${badgeHtml(d.type)}</span><b>Completed · ${Math.abs(d.energyAddedKwh || 0).toFixed(1)} kWh</b></div>`
  ).join('');
  planned.forEach(d => {
    const isActive = now >= new Date(d.start) && now < new Date(d.end);
    const label = isActive ? '● Dispatching now' : 'Planned';
    const cls = isActive ? ' active' : ' scheduled';
    dispatchSlots.insertAdjacentHTML('beforeend', `<div class="slot${cls}"><span>${fmtT(d.start)} – ${fmtT(d.end)}</span><b>${label}</b></div>`);
  });
  if (!dispatchSlots.children.length) dispatchSlots.innerHTML = '<div class="slot">No dispatch windows scheduled</div>';

  // Session view — whole charging sessions, oldest-first to match, each
  // with its own real cost/kWh (not the approximated rate the legacy path
  // uses) and battery % reached, plus type badge.
  const sessionSlots = $('ev-slots-session');
  sessionSlots.innerHTML = [...sessions].reverse().map(s => {
    const kwh = s.energyAdded?.value;
    const cost = s.cost?.amount;
    const startD = new Date(s.start);
    const dayLabel = startD.toDateString() === now.toDateString() ? 'Today'
      : startD.toDateString() === new Date(now - 86400000).toDateString() ? 'Yesterday'
      : startD.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const socText = s.stateOfChargeFinal != null ? `<span class="slot-soc">→ ${Math.round(s.stateOfChargeFinal)}%</span>` : '';
    return `<div class="slot done">
      <div class="slot-row"><span>${dayLabel}, ${fmtT(s.start)} – ${fmtT(s.end)}</span>${badgeHtml(s.type)}</div>
      <div class="slot-row"><b>${kwh != null ? Math.abs(kwh).toFixed(1) + ' kWh' : '—'}${cost != null ? ' · £' + Math.abs(cost).toFixed(2) : ''}</b>${socText}</div>
    </div>`;
  }).join('');
  if (!sessionSlots.children.length) sessionSlots.innerHTML = '<div class="slot">No charging sessions this week</div>';

  $('ev-view-toggle').classList.remove('hidden');
  $('ev-week-legend').classList.remove('hidden');

  // This session / avg rate — now real per-session figures where available,
  // rather than approximating rate as today's cheapest.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todaysSessions = sessions.filter(s => new Date(s.start) >= startOfToday);
  const sessionKwh = todaysSessions.reduce((sum, s) => sum + Math.abs(s.energyAdded?.value || 0), 0);
  const sessionCost = todaysSessions.reduce((sum, s) => sum + Math.abs(s.cost?.amount || 0), 0);
  $('ev-added').textContent = `${sessionKwh.toFixed(1)} kWh`;
  $('ev-cost').textContent = `£${sessionCost.toFixed(2)}`;
  $('ev-avg-rate').textContent = sessionKwh > 0 ? `${((sessionCost / sessionKwh) * 100).toFixed(1)}p/kWh` : '—';

  evWeekBuckets = renderEVWeekChart(sessions, now);
  $('ev-week-breakdown').classList.add('hidden');
  evWeekSelectedDay = null;

  return true;
}

// Original path — completedDispatches/plannedDispatches only, kWh
// approximated at today's cheapest rate. Kept as the fallback for any
// account where the SmartFlex query above returns nothing (no EV device
// registered under that path, or a schema difference on another account).
async function loadEVLegacy() {
  try {
    const data = await krakenGQL(`
      query IOGStatus($accountNumber: String!) {
        completedDispatches(accountNumber: $accountNumber) { start end delta }
        plannedDispatches(accountNumber: $accountNumber) { start end delta }
      }`, { accountNumber: store.creds.accountNumber });

    const planned = data.plannedDispatches || [];
    const completed = data.completedDispatches || [];

    const now = new Date();
    const activeDispatch = planned.find(d => now >= new Date(d.start) && now < new Date(d.end));
    $('ev-tag').textContent = activeDispatch ? 'CHARGING' : (planned.length ? 'SCHEDULED' : 'IDLE');
    if (activeDispatch) $('ev-tag').className = 'card-tag tag-pink';
    else if (planned.length) $('ev-tag').className = 'card-tag tag-amber';
    else $('ev-tag').className = 'card-tag tag-dim';

    applyEvCollapse(!!activeDispatch || planned.length > 0);

    if (planned[0]) {
      const s = new Date(planned[0].start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const e = new Date(planned[0].end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('ev-ready').textContent = `${s} – ${e}`;
    } else {
      $('ev-ready').textContent = 'None scheduled';
    }

    $('ev-battery-row').classList.add('hidden');
    $('ev-view-toggle').classList.add('hidden');
    $('ev-week-legend').classList.add('hidden');
    $('ev-slots-session').classList.add('hidden');
    $('ev-slots-dispatch').classList.remove('hidden');

    const slots = $('ev-slots-dispatch');
    slots.innerHTML = '';
    [...completed].reverse().forEach(d => {
      slots.insertAdjacentHTML('beforeend', `<div class="slot done"><span>✓ ${new Date(d.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(d.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><b>Completed · ${Math.abs(+d.delta).toFixed(1)} kWh</b></div>`);
    });
    planned.forEach(d => {
      const isActive = now >= new Date(d.start) && now < new Date(d.end);
      const label = isActive ? '● Dispatching now' : 'Planned';
      const cls = isActive ? ' active' : ' scheduled';
      slots.insertAdjacentHTML('beforeend', `<div class="slot${cls}"><span>${new Date(d.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(d.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><b>${label}</b></div>`);
    });
    if (!slots.children.length) slots.innerHTML = '<div class="slot">No dispatch windows scheduled</div>';

    const rateP = cachedOffPeakRateP ?? 7.5;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todaysCompleted = completed.filter(d => new Date(d.start) >= startOfToday);
    const sessionKwh = todaysCompleted.reduce((s, d) => s + (+d.delta), 0);
    $('ev-added').textContent = `${Math.abs(sessionKwh).toFixed(1)} kWh`;
    $('ev-cost').textContent = fmtGBP(sessionKwh * rateP / 100);
    $('ev-avg-rate').textContent = `${rateP.toFixed(1)}p/kWh`;

    const dayTotals = Array(7).fill(0);
    const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - 6);
    completed.forEach(d => {
      const dayIdx = Math.floor((new Date(d.start) - startOfWeek) / 86400000);
      if (dayIdx >= 0 && dayIdx < 7) dayTotals[dayIdx] += (+d.delta);
    });
    renderWeekBars('ev-week', dayTotals, '', v => `${Math.abs(v).toFixed(1)} kWh`);
    const weekKwh = dayTotals.reduce((a, b) => a + b, 0);
    $('ev-week-totals').innerHTML = `<span><b>${Math.abs(weekKwh).toFixed(1)} kWh</b> added</span><span><b>${fmtGBP(weekKwh * rateP / 100)}</b> total</span><span><b>${rateP.toFixed(1)}p</b> avg</span>`;

    return true;
  } catch (err) {
    logIssue('EV dispatch', err);
    if (demoFallbackEnabled()) {
      populateDemoEV();
    } else {
      $('ev-tag').textContent = 'Unavailable';
      $('ev-tag').className = 'card-tag tag-dim';
      $('ev-ready').textContent = '—';
      $('ev-added').textContent = '—';
      $('ev-cost').textContent = '—';
      $('ev-avg-rate').textContent = '—';
      $('ev-battery-row').classList.add('hidden');
      $('ev-view-toggle').classList.add('hidden');
      $('ev-week-legend').classList.add('hidden');
      $('ev-slots-dispatch').innerHTML = '<div class="slot">Unavailable right now</div>';
      renderWeekBars('ev-week', [0, 0, 0, 0, 0, 0, 0], '');
      $('ev-week-totals').innerHTML = '<span>—</span><span>—</span><span>—</span>';
    }
    return false;
  }
}

// Stacked week chart (SMART/BOOST) with tap-to-breakdown — the one chart
// in the app that never had this, closed out now that session-level data
// makes a per-day breakdown genuinely worthwhile. Returns the per-day
// bucket data so the click handler (wired once in init()) can look up
// whichever day gets tapped without recomputing.
function renderEVWeekChart(sessions, now) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - 6);
  const buckets = Array.from({ length: 7 }, () => ({ smart: 0, boost: 0, sessions: [] }));
  sessions.forEach(s => {
    const dayIdx = Math.floor((new Date(s.start) - startOfWeek) / 86400000);
    if (dayIdx < 0 || dayIdx > 6) return;
    const kwh = Math.abs(s.energyAdded?.value || 0);
    if (s.type === 'BOOST') buckets[dayIdx].boost += kwh; else buckets[dayIdx].smart += kwh;
    buckets[dayIdx].sessions.push(s);
  });

  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = now.getDay();
  const max = Math.max(...buckets.map(b => b.smart + b.boost), 0.01);
  const maxBarHeight = 44;

  $('ev-week').innerHTML = buckets.map((b, i) => {
    const total = b.smart + b.boost;
    const h = Math.max(2, Math.round((total / max) * maxBarHeight));
    const smartH = total > 0 ? Math.round((b.smart / total) * h) : 0;
    const boostH = h - smartH;
    const label = labels[(today - (6 - i) + 7) % 7];
    return `<div class="ev-week-col">
      <div class="ev-week-stack" data-i="${i}" style="height:${h}px">
        ${boostH ? `<div class="ev-week-seg boost" style="height:${boostH}px"></div>` : ''}
        ${smartH ? `<div class="ev-week-seg smart" style="height:${smartH}px"></div>` : ''}
      </div>
      <span data-i="${i}">${label}</span>
    </div>`;
  }).join('');

  const weekKwh = buckets.reduce((s, b) => s + b.smart + b.boost, 0);
  const weekCost = sessions.reduce((s, sess) => {
    const d = new Date(sess.start);
    return d >= startOfWeek ? s + Math.abs(sess.cost?.amount || 0) : s;
  }, 0);
  $('ev-week-totals').innerHTML = `<span><b>${weekKwh.toFixed(1)} kWh</b> added</span><span><b>£${weekCost.toFixed(2)}</b> total</span><span><b>${weekKwh > 0 ? ((weekCost / weekKwh) * 100).toFixed(1) : '—'}p</b> avg</span>`;

  return buckets;
}

function renderEVWeekBreakdown(index) {
  const box = $('ev-week-breakdown');
  const bucket = evWeekBuckets?.[index];
  if (!bucket || !bucket.sessions.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const startOfWeek = new Date(new Date().setHours(0, 0, 0, 0)); startOfWeek.setDate(startOfWeek.getDate() - 6);
  const dayDate = new Date(startOfWeek); dayDate.setDate(dayDate.getDate() + index);
  const total = bucket.smart + bucket.boost;
  const cost = bucket.sessions.reduce((s, sess) => s + Math.abs(sess.cost?.amount || 0), 0);
  const smartCount = bucket.sessions.filter(s => s.type === 'SMART').length;
  const boostCount = bucket.sessions.filter(s => s.type === 'BOOST').length;
  const countLabel = bucket.sessions.length === 1 ? '1 session' : `${bucket.sessions.length} sessions`;
  const typeLabel = [smartCount && `${smartCount} smart`, boostCount && `${boostCount} boost`].filter(Boolean).join(', ');
  box.innerHTML = `<div class="breakdown-date">${dayNames[dayDate.getDay()]}</div>`
    + `<div class="breakdown-row"><span class="label">Sessions</span><span class="val">${countLabel}${typeLabel ? ` (${typeLabel})` : ''}</span></div>`
    + `<div class="breakdown-row"><span class="label">Added</span><span class="val">${total.toFixed(1)} kWh</span></div>`
    + `<div class="breakdown-total"><span>Cost</span><span>£${cost.toFixed(2)}</span></div>`;
}

let evWeekBuckets = null;
let evWeekSelectedDay = null;

function populateDemoEV() {
    applyEvCollapse(true);
    $('ev-tag').textContent = 'DEMO DATA';
    $('ev-ready').textContent = '23:30 – 05:30';
    $('ev-added').textContent = '9.6 kWh';
    $('ev-cost').textContent = '£0.72';
    $('ev-avg-rate').textContent = '7.5p/kWh';
    $('ev-battery-row').classList.add('hidden');
    $('ev-view-toggle').classList.add('hidden');
    $('ev-week-legend').classList.add('hidden');
    $('ev-slots-dispatch').classList.remove('hidden');
    $('ev-slots-dispatch').innerHTML = `
      <div class="slot done"><span>✓ 00:30 – 04:00</span><b>Completed · 22.1 kWh</b></div>
      <div class="slot active"><span>● 04:00 – 05:30</span><b>Dispatching now · 7.4kW</b></div>
      <div class="slot"><span>Planned tonight</span><b>23:30 – 05:30</b></div>`;
    renderWeekBars('ev-week', [3.0, 2.2, 4.8, 0.1, 3.6, 2.6, 4.4], '');
    $('ev-week-totals').innerHTML = `<span><b>62.4 kWh</b> added</span><span><b>£4.68</b> total</span><span><b>7.5p</b> avg</span>`;
}

// Moves the persistent #bill-history-toggle button back to its safe static
// position (directly before #bill-history) if it's currently living inside
// #last-bill-row from a previous sync. This is the fully-diagnosed root
// cause of billing intermittently failing — nothing to do with the API,
// rate limits, or credentials. loadBilling() moves this same element INTO
// last-bill-row's rendered content on a successful render; FOUR separate
// places in this file reassign last-bill-row's innerHTML on a later call
// (the real render, the demo-data path, the generic-failure path, and the
// optimistic per-sync reset) — any one of them, if the toggle is currently
// parked inside, destroys it outright, and every later reference throws
// "null is not an object" (or "Argument 1 ('node') ... must be an
// instance of Node" if a stale null gets passed to appendChild) before any
// of loadBilling()'s own try/catch blocks even run. An earlier version of
// this fix only guarded the real-render path and missed the other three —
// calling this once, unconditionally, at the very top of loadBilling()
// covers all four regardless of which one runs first.
function restoreToggleToSafety() {
  const existingToggle = document.getElementById('bill-history-toggle');
  const billHistoryEl = document.getElementById('bill-history');
  if (existingToggle && billHistoryEl && existingToggle.nextSibling !== billHistoryEl) {
    billHistoryEl.parentElement.insertBefore(existingToggle, billHistoryEl);
  }
}

async function loadBilling() {
  restoreToggleToSafety();
  if (demoFallbackEnabled()) populateDemoBilling();
  else clearBillingUnavailable();
  if (store.creds?.accountNumber) $('billing-account-number').textContent = store.creds.accountNumber;
  let anyLive = false;

  // --- Account balance ---
  // Uses the documented GraphQL `account.balance` field (confirmed via
  // docs.octopus.energy) rather than guessing at a REST field, and passes
  // includeAllLedgers: true as Octopus's own docs recommend for accuracy.
  let balancePounds = null;
  try {
    const data = await krakenGQL(`
      query AccountBalance($accountNumber: String!) {
        account(accountNumber: $accountNumber) { balance(includeAllLedgers: true) }
      }`, { accountNumber: store.creds.accountNumber });
    const balancePence = data?.account?.balance;
    if (typeof balancePence === 'number') {
      balancePounds = balancePence / 100;
      renderBalanceFigure('balance-now', 'balance-now-pill', balancePounds);
      anyLive = true;
    } else {
      // Query succeeded (no GraphQL error, krakenGQL didn't throw) but the
      // balance field itself came back missing/null — every real account
      // has one, so this is a genuine anomaly, not a normal empty state.
      // Previously this was silently skipped: no exception means no catch
      // block, which meant no logIssue() call at all — exactly the gap
      // found in testing, where a sync could report "Billing: false" with
      // zero captured detail because nothing ever technically threw.
      logIssue('Account balance', new Error(`Query succeeded but balance was ${JSON.stringify(balancePence)} (account: ${JSON.stringify(data?.account)})`));
    }
  } catch (err) { logIssue('Account balance', err); }

  // --- Next scheduled payment (for "balance after next Direct Debit") ---
  // Uses the documented `account.payments` field (confirmed field names:
  // amount, paymentDate, status — Octopus's own docs example shows
  // status: "SCHEDULED" as a real value). Originally filtered strictly to
  // status === 'SCHEDULED', which found nothing for some accounts — most
  // likely because Octopus doesn't materialize the individual payment
  // record until closer to the collection date. Relaxed to just "nearest
  // future-dated payment, whatever its status," which is more forgiving.
  let nextPayment = null;
  try {
    const data = await krakenGQL(`
      query NextPayment($accountNumber: String!) {
        account(accountNumber: $accountNumber) {
          payments(first: 30) { edges { node { amount paymentDate status } } }
        }
      }`, { accountNumber: store.creds.accountNumber });
    const today = isoDate(new Date());
    const allPayments = (data?.account?.payments?.edges || []).map(e => e.node);
    const upcoming = allPayments
      .filter(p => p.paymentDate >= today)
      .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
    if (upcoming[0]) nextPayment = upcoming[0];

    // No future-dated payment yet — fall back to the most recent PAST
    // payment as an estimate. UK energy Direct Debits are periodically
    // reviewed but typically stay fixed for months at a time, so the last
    // actual payment is a reasonable stand-in until Octopus creates the
    // real next-payment record. Flagged as an estimate so the UI can be
    // honest about it rather than presenting a guess as a confirmed fact.
    if (!nextPayment) {
      const past = allPayments
        .filter(p => p.paymentDate < today && p.status !== 'CANCELLED' && p.status !== 'FAILED')
        .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
      if (past[0]) nextPayment = { ...past[0], isEstimate: true };
    }

    logDebug('Next payment', `${allPayments.length} payment(s) fetched, ${upcoming.length} future-dated${nextPayment ? `, using: ${nextPayment.paymentDate} (${nextPayment.status}${nextPayment.isEstimate ? ', estimated from last payment' : ''})` : ', none usable'}`);
  } catch (err) { logIssue('Next payment', err); }

  // --- Cost so far this cycle (assumes calendar month as the cycle — Octopus's
  // API doesn't expose your actual billing-cycle start date, so this is an
  // approximation; swap in your real billing day here if you know it) ---
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const fromISO = monthStart.toISOString();
    const toISO = now.toISOString();
    const elapsedDays = daysElapsedInMonth(now);
    const totalDays = daysInMonth(now);

    const [elec, gas, elecStanding, gasStanding] = await Promise.all([
      costForRange('elec', fromISO, toISO, 'Electricity MTD'),
      costForRange('gas', fromISO, toISO, 'Gas MTD').catch(() => null),
      fetchStandingCharge('elec'),
      fetchStandingCharge('gas')
    ]);

    const elecStandingTotal = elecStanding ? (elecStanding / 100) * elapsedDays : 0;
    const gasStandingTotal = gasStanding ? (gasStanding / 100) * elapsedDays : 0;
    if (elecStanding) cachedElecStandingP = elecStanding;
    if (gasStanding) cachedGasStandingP = gasStanding;
    const elecMTD = elec.cost + elecStandingTotal;
    const gasMTD = gas ? gas.cost + gasStandingTotal : null;
    const combinedMTD = elecMTD + (gasMTD ?? 0);

    // Simple linear projection: today's daily average, carried across the rest
    // of the cycle. It won't account for seasonal swings (e.g. gas rising as
    // winter approaches) but is a reasonable early-month estimate. Applied to
    // kWh the same way, for the toggle's benefit.
    const avgDaily = combinedMTD / elapsedDays;
    const predictedTotal = avgDaily * totalDays;
    const elecPredictedCost = (elecMTD / elapsedDays) * totalDays;
    const gasPredictedCost = gasMTD !== null ? (gasMTD / elapsedDays) * totalDays : null;
    const elecPredictedKwh = (elec.kwh / elapsedDays) * totalDays;
    const gasPredictedKwh = gas ? (gas.kwh / elapsedDays) * totalDays : null;

    $('cost-mtd').textContent = fmtGBP(combinedMTD);
    $('cost-predicted').textContent = fmtGBP(predictedTotal);
    $('cycle-bar').style.width = `${Math.min(100, Math.round((elapsedDays / totalDays) * 100))}%`;
    $('cycle-day').textContent = `Day ${elapsedDays} / ${totalDays}`;

    fuelData.elec = fuelData.elec || {};
    // usageCost (excludes standing) feeds the balance forecast's blended
    // rate — mtd.cost includes standing charges (correct for the Billing
    // card's "spend so far" figure), but the forecast adds today's standing
    // charge separately per future month, so dividing by the
    // standing-inclusive cost would double-count it. Worse the smaller
    // this month's kWh is (e.g. gas in summer), since a fixed standing fee
    // gets spread over very little usage, inflating pence/kWh sharply.
    fuelData.elec.mtd = { cost: elecMTD, kwh: elec.kwh, usageCost: elec.cost };
    fuelData.elec.predicted = { cost: elecPredictedCost, kwh: elecPredictedKwh };
    if (elecStanding) $('elec-standing').textContent = `£${(elecStanding / 100).toFixed(2)}/day`;

    if (gasMTD !== null) {
      fuelData.gas = fuelData.gas || {};
      fuelData.gas.mtd = { cost: gasMTD, kwh: gas.kwh, usageCost: gas.cost };
      fuelData.gas.predicted = { cost: gasPredictedCost, kwh: gasPredictedKwh };
      if (gasStanding) $('gas-standing').textContent = `£${(gasStanding / 100).toFixed(2)}/day`;
      try {
        const todayISO = isoDate(now);
        const gasRatesToday = await fetchGasRates(`${todayISO}T00:00Z`, `${todayISO}T23:59Z`);
        const currentGasRate = rateAt(gasRatesToday, Date.now());
        if (currentGasRate !== null) $('gas-unit-rate').textContent = `${currentGasRate.toFixed(2)}p`;
      } catch { /* keep whatever was already showing (demo or "—") */ }
    }

    if (balancePounds !== null) {
      // Direct Debit accounts don't have usage deducted from the balance
      // continuously — it's billed in one lump when the next statement is
      // issued. So the projection subtracts the FULL predicted month cost,
      // not just the not-yet-incurred remainder (which would double-count
      // the "already billed" assumption that doesn't hold here).
      const projected = balancePounds - predictedTotal;
      renderBalanceFigure('balance-projected', 'balance-projected-pill', projected);

      if (nextPayment) {
        const afterDD = projected + (nextPayment.amount / 100);
        $('next-dd-amount').textContent = fmtGBP(nextPayment.amount / 100);
        $('next-dd-label').textContent = nextPayment.isEstimate ? 'Direct Debit (est.)' : 'Next Direct Debit';
        renderBalanceFigure('balance-after-dd', 'balance-after-dd-pill', afterDD);

        // Trend: is the incoming payment bigger or smaller than what this
        // month's predicted to cost? Positive = balance building (summer),
        // negative = balance drawing down (winter).
        const trend = (nextPayment.amount / 100) - predictedTotal;
        const pill = $('balance-trend-pill');
        pill.className = 'trend-pill ' + (trend >= 0 ? 'up' : 'down');
        pill.textContent = `${trend >= 0 ? '↑' : '↓'} ${fmtGBP(trend)}/mo`;
        billingState = { balancePounds, trend, hasNextPayment: true, nextPaymentAmount: nextPayment.amount / 100 };

        $('balance-after-dd-row').style.display = '';
      } else {
        $('balance-after-dd-row').style.display = 'none';
        billingState = { balancePounds, trend: null, hasNextPayment: false, nextPaymentAmount: null };
      }
    }

    anyLive = true;
  } catch (err) {
    logIssue('MTD/predicted cost', err);
  }

  // --- 7-day bars, per fuel (also used to find "latest available day" —
  // see note in renderFuelPanel; same-day/next-day data lag affects both
  // fuels, not just gas, so there's no reliable "today" figure for either) ---
  try {
    fuelData.elec = fuelData.elec || {};
    fuelData.elec.week = await lastNDaysElecSplitWithStanding(7);
    logDebug('Elec week breakdown', fuelData.elec.week.map((d, i) => `[${i}] £${dayTotal('elec', d, 'cost').toFixed(2)} (hasData:${d.hasData})`).join(' '));
    renderFuelPanel('elec');

    try {
      fuelData.gas = fuelData.gas || {};
      fuelData.gas.week = await lastNDaysGasSplitWithStanding(7);
      logDebug('Gas week breakdown', fuelData.gas.week.map((d, i) => `[${i}] £${dayTotal('gas', d, 'cost').toFixed(2)} (hasData:${d.hasData})`).join(' '));
      renderFuelPanel('gas');
    } catch (err) { logIssue('Gas daily cost', err); }

    anyLive = true;
  } catch (err) {
    logIssue('Daily cost', err);
  }

  // Last bill: real, via Octopus's documented GraphQL schema (account.bills),
  // itemized using account.transactions for each bill's date range. The most
  // recent bill is always shown in full (date, billing period, total); up to
  // 4 older bills are available behind the outer toggle using the identical
  // row shape. Each row's own itemized breakdown collapses independently to
  // save vertical space, defaulting closed.
  try {
    const data = await krakenGQL(`
      query LastBill($accountNumber: String!) {
        account(accountNumber: $accountNumber) {
          bills(first: 15) {
            edges { node { id issuedDate fromDate toDate temporaryUrl } }
          }
        }
      }`, { accountNumber: store.creds.accountNumber });

    const bills = (data?.account?.bills?.edges || []).map(e => e.node).filter(b => b.issuedDate);
    bills.sort((a, b) => new Date(b.issuedDate) - new Date(a.issuedDate));
    const latest = bills[0];
    if (latest) {
      // Itemized per-transaction breakdown, one fetch covering every listed
      // bill's date range. Best-effort: if this fails for any reason, every
      // row still falls back to date + link only, never blocking that base view.
      let txnsByBill = null;
      try {
        const earliest = bills.reduce((min, b) => b.fromDate < min ? b.fromDate : min, bills[0].fromDate);
        const spanEnd = bills.reduce((max, b) => b.toDate > max ? b.toDate : max, bills[0].toDate);
        const txnData = await krakenGQL(`
          query BillTransactions($accountNumber: String!, $fromDate: Date, $toDate: Date) {
            account(accountNumber: $accountNumber) {
              transactions(fromDate: $fromDate, toDate: $toDate, first: 100) {
                edges { node { __typename id postedDate title amounts { gross } } }
              }
            }
          }`, { accountNumber: store.creds.accountNumber, fromDate: earliest, toDate: spanEnd });
        const txns = (txnData?.account?.transactions?.edges || []).map(e => e.node).filter(t => t.postedDate && t.amounts);

        // Consumption (kWh + sub-period) fetched separately, on its own risk.
        // Two rounds of real API errors got us here: first confirmed
        // transactions.edges.node is a concrete TransactionType (no bare
        // `consumption` field, no inline fragment needed there); the API's
        // own error then named the correct fragment target directly —
        // `... on Charge`, not `BillCharge` (that name only existed on a
        // different, unrelated type from earlier introspection). Kept
        // decoupled from the main query either way, so a future failure
        // here only drops kWh rather than the whole breakdown again.
        try {
          const consData = await krakenGQL(`
            query BillChargeConsumption($accountNumber: String!, $fromDate: Date, $toDate: Date) {
              account(accountNumber: $accountNumber) {
                transactions(fromDate: $fromDate, toDate: $toDate, first: 100) {
                  edges {
                    node {
                      ... on Charge {
                        id
                        consumption { quantity unit startDate endDate }
                      }
                    }
                  }
                }
              }
            }`, { accountNumber: store.creds.accountNumber, fromDate: earliest, toDate: spanEnd });
          const consEdges = consData?.account?.transactions?.edges || [];
          const consByCharge = new Map(
            consEdges
              .map(e => e.node)
              .filter(n => n?.id && n?.consumption)
              .map(n => [n.id, n.consumption])
          );
          let matched = 0;
          txns.forEach(t => { if (consByCharge.has(t.id)) { t.consumption = consByCharge.get(t.id); matched++; } });
          logDebug('Bill charge consumption', `${consEdges.length} edge(s) returned, ${consByCharge.size} with id+consumption, ${matched}/${txns.length} txn(s) matched`);
        } catch (err) { logIssue('Bill charge consumption', err); }

        txnsByBill = bills.map(b => ({
          bill: b,
          items: txns.filter(t => t.postedDate >= b.fromDate && t.postedDate <= b.toDate)
        }));
      } catch (err) { logIssue('Bill transactions', err); }

      function isCharge(t) { return (t.__typename || '').includes('Charge'); }
      function itemDateRange(t) {
        if (!t.consumption?.startDate || !t.consumption?.endDate) return '';
        const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `<span class="bh-item-sub">${fmt(t.consumption.startDate)} – ${fmt(t.consumption.endDate)}</span>`;
      }
      function itemKwh(t) {
        if (!t.consumption?.quantity) return '';
        const unitMap = { KILOWATT_HOUR: 'kWh', CUBIC_METERS: 'm³', CUBIC_METRE: 'm³', CUBIC_FEET: 'ft³' };
        const unit = unitMap[t.consumption.unit] || (t.consumption.unit || '').toLowerCase().replace(/_/g, ' ');
        const qty = parseFloat(t.consumption.quantity);
        return ` · ${qty.toFixed(1)}${unit ? ' ' + unit : ''}`;
      }

      function billItemsHtml(items) {
        if (!items || !items.length) return '';
        const rows = items.map(t => {
          const charge = isCharge(t);
          const signed = (charge ? -t.amounts.gross : t.amounts.gross) / 100;
          const cls = charge ? 'v' : 'v credit';
          return `<div class="bh-item"><span class="l">${t.title}${itemKwh(t)}${itemDateRange(t)}</span><span class="${cls}">${signed < 0 ? '−' : '+'}£${Math.abs(signed).toFixed(2)}</span></div>`;
        }).join('');
        return rows;
      }
      // Total matches the bill's own "Total charges for bill" — sums only the
      // charge-type transactions (electricity, gas), excluding Direct Debit
      // payments and points-redeemed credits, which are account balance
      // movements rather than part of what the bill actually charged.
      function billTotal(items) {
        if (!items || !items.length) return null;
        const chargePence = items.filter(isCharge).reduce((sum, t) => sum + t.amounts.gross, 0);
        return (chargePence / 100).toFixed(2);
      }
      function billPeriod(b) {
        const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `${fmt(b.fromDate)} – ${fmt(b.toDate)}`;
      }
      function billRowHtml(b, collapsible) {
        const date = new Date(b.issuedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        const items = txnsByBill ? txnsByBill.find(x => x.bill.id === b.id)?.items : null;
        const linkHtml = b.temporaryUrl ? `<a class="bh-link" href="${b.temporaryUrl}" target="_blank" aria-label="View bill">View Bill</a>` : '<span class="bh-link" style="opacity:0.4">View Bill</span>';
        const total = billTotal(items);
        const itemsHtml = billItemsHtml(items);
        const toggleHtml = (itemsHtml && collapsible)
          ? `<div class="bh-pill-group" id="bh-pill-group"><button type="button" class="bh-breakdown-toggle" data-bill-id="${b.id}" aria-expanded="false"><span>Show breakdown</span><svg viewBox="0 0 10 6" fill="none" width="9" height="6"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>`
          : '<span></span>';
        const itemsClass = collapsible ? 'bh-items hidden' : 'bh-items';
        return `<div class="bh-row">
          <div class="bh-top">
            <div><div class="bh-date">${date}</div><div class="bh-period"><b>Billing period:</b> ${billPeriod(b)}</div></div>
            ${linkHtml}
          </div>
          <div class="bh-total-row">${toggleHtml}<div class="bh-total">${total !== null ? '£' + total : '—'}</div></div>
          ${itemsHtml ? `<div class="${itemsClass}" data-bill-id="${b.id}">${itemsHtml}</div>` : ''}
        </div>`;
      }

      // Toggle already guaranteed safe by restoreToggleToSafety() at the
      // top of this function — see there for the full explanation.
      $('last-bill-row').innerHTML = billRowHtml(latest, true);

      const rest = bills.slice(1);
      const toggle = $('bill-history-toggle');
      const pillGroup = document.getElementById('bh-pill-group');
      if (pillGroup) pillGroup.appendChild(toggle);
      if (rest.length) {
        $('bill-history').innerHTML = rest.map(b => billRowHtml(b, false)).join('');
        $('bill-history-toggle-label').textContent = `${rest.length} more`;
        toggle.classList.remove('hidden');
        toggle.onclick = () => {
          const open = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', String(!open));
          $('bill-history-toggle-label').textContent = open ? `${rest.length} more` : 'hide';
          $('bill-history').classList.toggle('hidden', open);
        };
      } else {
        toggle.classList.add('hidden');
      }

      // Per-row breakdown toggles, delegated across both containers since
      // rows in bill-history are rebuilt each sync.
      [$('last-bill-row'), $('bill-history')].forEach(container => {
        container.querySelectorAll('.bh-breakdown-toggle').forEach(btn => {
          btn.onclick = () => {
            const id = btn.dataset.billId;
            const itemsEl = container.querySelector(`.bh-items[data-bill-id="${id}"]`);
            const open = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', String(!open));
            btn.querySelector('span').textContent = open ? 'Show breakdown' : 'Hide breakdown';
            itemsEl.classList.toggle('hidden', open);
          };
        });
      });

      // Bill total over time, grouped by calendar month (not one bar per
      // bill) — some months genuinely have more than one bill (a tariff
      // switch mid-month, for example), and showing those as two separate
      // bars with the same month label reads as a mistake even though the
      // data's correct. Grouping gives a true "spend per month" picture.
      // Deliberately a rolling window, not a Jan–Dec calendar year — that
      // would drop any bill from before January (thrown away for no good
      // reason) and pad the second half of the year with empty
      // not-happened-yet placeholders.
      //
      // Fetches 15 bills, not 12 — a month with 2+ bills "eats" one fetch
      // slot without adding a new distinct month, so 12 bills alone can
      // undershoot a genuine 12-month picture whenever that happens (which
      // it will, on any tariff switch). 15 is a buffer, not a guarantee —
      // someone who switches tariffs several times in a year could still
      // come up short — but it covers the common case. The chart itself
      // is capped to the most recent 12 distinct months after grouping
      // (see .slice(-12) below), so it stays a consistent width regardless
      // of how many bills that took.
      try {
        // consumption.unit is usually KILOWATT_HOUR for electricity and
        // either KILOWATT_HOUR or CUBIC_METERS for gas depending on the
        // meter — same m3→kWh conversion already used in costForRange/
        // fetchYearMonthly (volume correction × calorific value ÷ 3.6),
        // applied per-item here rather than assuming a fixed unit.
        function itemToKwh(t) {
          const q = parseFloat(t.consumption?.quantity);
          if (!Number.isFinite(q)) return 0;
          const unit = t.consumption?.unit;
          if (unit === 'CUBIC_METERS' || unit === 'CUBIC_METRE') return q * 1.02264 * gasCalorificValue() / 3.6;
          return q; // already kWh (or close enough — KILOWATT_HOUR, or an unrecognized unit passed through rather than silently dropped)
        }
        const grouped = new Map(); // key 'YYYY-M' -> { year, month, gas, elec, gasKwh, elecKwh, total, bills: [{issuedDate, temporaryUrl}] }
        (txnsByBill || []).forEach(({ bill, items }) => {
          const issued = new Date(bill.issuedDate);
          const key = `${issued.getFullYear()}-${issued.getMonth()}`;
          const gasItems = (items || []).filter(t => isCharge(t) && /gas/i.test(t.title));
          const elecItems = (items || []).filter(t => isCharge(t) && /electric/i.test(t.title));
          const gas = gasItems.reduce((s, t) => s + t.amounts.gross, 0) / 100;
          const elec = elecItems.reduce((s, t) => s + t.amounts.gross, 0) / 100;
          const gasKwh = gasItems.reduce((s, t) => s + itemToKwh(t), 0);
          const elecKwh = elecItems.reduce((s, t) => s + itemToKwh(t), 0);
          if (grouped.has(key)) {
            const g = grouped.get(key);
            g.gas += gas; g.elec += elec; g.total += gas + elec;
            g.gasKwh += gasKwh; g.elecKwh += elecKwh;
            g.bills.push({ issuedDate: bill.issuedDate, temporaryUrl: bill.temporaryUrl });
          } else {
            grouped.set(key, { year: issued.getFullYear(), month: issued.getMonth(), gas, elec, gasKwh, elecKwh, total: gas + elec, bills: [{ issuedDate: bill.issuedDate, temporaryUrl: bill.temporaryUrl }] });
          }
        });
        const monthsData = Array.from(grouped.values())
          .sort((a, b) => a.year - b.year || a.month - b.month)
          .slice(-12); // most recent 12 distinct months, regardless of how many bills that took
        const spansMultipleYears = monthsData.length > 0 && monthsData[0].year !== monthsData[monthsData.length - 1].year;

        if (monthsData.length >= 2) {
          billMonthsData = monthsData;
          if (selectedBillMonth !== null && selectedBillMonth >= monthsData.length) selectedBillMonth = null;
          const max = Math.max(...monthsData.map(m => m.total), 0.01);
          const maxBarHeight = 78;
          $('bill-year-bars').innerHTML = monthsData.map((m, i) => {
            const seg = `<div class="bt-seg gas" style="height:${Math.max(1, Math.round((m.gas / max) * maxBarHeight))}px"></div><div class="bt-seg elec" style="height:${Math.max(1, Math.round((m.elec / max) * maxBarHeight))}px"></div>`;
            const label = new Date(m.year, m.month, 1).toLocaleDateString('en-GB', spansMultipleYears ? { month: 'short', year: '2-digit' } : { month: 'short' });
            const selected = i === selectedBillMonth ? ' selected' : '';
            return `<div class="bt-bar"><div class="bt-stack${selected}" data-index="${i}">${seg}</div><span class="${i === selectedBillMonth ? 'active-day' : ''}">${label}</span></div>`;
          }).join('');
          renderBillYearBreakdown(selectedBillMonth);
          $('bill-year-block').style.display = '';
        } else {
          billMonthsData = [];
          selectedBillMonth = null;
          $('bill-year-block').style.display = 'none';
        }
      } catch (err) { logIssue('Bill year chart', err); }

      anyLive = true;
    }
  } catch (err) {
    logIssue('Last bill', err);
    $('last-bill-row').innerHTML = '<div style="color:var(--text-dim);font-size:12.5px;">Last bill unavailable — check connection or Settings</div>';
    billMonthsData = [];
    selectedBillMonth = null;
    $('bill-year-block').style.display = 'none';
  }

  return anyLive;
}

async function lastNDaysCost(fuel, n) {
  const creds = store.creds;
  const isElec = fuel === 'elec';
  const mp = isElec ? creds.elecMpan : creds.gasMprn;
  const serial = isElec ? creds.elecSerial : creds.gasSerial;
  const now = new Date();
  const rangeStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
  const rangeEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const dates = Array.from({ length: n }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i)));
  try {
    if (!mp || !serial) throw new Error(`No ${fuel} meter point on file`);
    const consPath = isElec
      ? `/electricity-meter-points/${mp}/meters/${serial}/consumption/?period_from=${rangeStart.toISOString()}&period_to=${rangeEnd.toISOString()}&page_size=1500`
      : `/gas-meter-points/${mp}/meters/${serial}/consumption/?period_from=${rangeStart.toISOString()}&period_to=${rangeEnd.toISOString()}&page_size=1500`;
    const [consData, rates] = await Promise.all([
      octRest(consPath),
      isElec ? fetchElecRates(rangeStart.toISOString(), rangeEnd.toISOString()) : fetchGasRates(rangeStart.toISOString(), rangeEnd.toISOString())
    ]);
    if (!rates.length) throw new Error(`No ${fuel} rate data`);
    const buckets = bucketReadingsByDay(consData.results || [], n, now);
    return buckets.map((readings, i) => {
      let kwh = 0, costPence = 0;
      for (const r of readings) {
        let consumption = r.consumption;
        if (!isElec && readings[0]?.consumption < 50) {
          consumption = consumption * 1.02264 * gasCalorificValue() / 3.6;
        }
        const rate = rateAt(rates, +new Date(r.interval_start));
        if (rate === null) continue;
        kwh += consumption;
        costPence += consumption * rate;
      }
      return { cost: costPence / 100, kwh, hasData: readings.length > 0 && kwh > 0.001, date: dates[i] };
    });
  } catch (err) {
    logIssue(`${isElec ? 'Electricity' : 'Gas'} week breakdown`, err);
    return dates.map(date => ({ cost: 0, kwh: 0, hasData: false, date }));
  }
}

function populateDemoBilling() {
    renderBalanceFigure('balance-now', 'balance-now-pill', 42.10);
    renderBalanceFigure('balance-projected', 'balance-projected-pill', 35.70);
    $('next-dd-amount').textContent = '£95.00';
    renderBalanceFigure('balance-after-dd', 'balance-after-dd-pill', 130.70);
    $('balance-trend-pill').className = 'trend-pill up';
    $('balance-trend-pill').textContent = '↑ £95.00/mo';
    $('balance-after-dd-row').style.display = '';
    $('cost-mtd').textContent = '£58.90';
    $('cost-predicted').textContent = '£101.40';
    $('cycle-bar').style.width = '58%';
    $('cycle-day').textContent = 'Day 17 / 29 (demo data)';
    $('elec-latest-label').textContent = 'Yesterday'; $('elec-latest').textContent = '£1.90';
    $('elec-week-total').textContent = '£13.20';
    $('elec-mtd').textContent = '£35.40'; $('elec-predicted').textContent = '£61.10';
    $('elec-standing').textContent = '£0.52/day';
    $('gas-latest-label').textContent = 'Yesterday'; $('gas-latest').textContent = '£2.04';
    $('gas-week-total').textContent = '£11.30';
    $('gas-mtd').textContent = '£23.50'; $('gas-predicted').textContent = '£40.30';
    $('gas-unit-rate').textContent = '6.24p'; $('gas-standing').textContent = '£0.35/day';
    renderWeekBars('elec-week', [2.2, 1.9, 1.5, 2.4, 1.4, 1.7, 2.1], 'elec-col', fmtGBP, 58, 'elec-week-scale');
    renderWeekBars('gas-week', [1.4, 1.8, 1.2, 2.0, 1.6, 1.3, 1.5], 'gas-col', fmtGBP, 58, 'gas-week-scale');
    $('last-bill-row').innerHTML = `<div class="bh-top"><div><div class="bh-date">1 Jul 2026</div><div class="bh-period"><b>Billing period:</b> 3 Jun – 1 Jul</div></div><span class="bh-link" style="opacity:0.4">View Bill</span></div><div class="bh-total-row"><span></span><div class="bh-total">£54.20 (demo data)</div></div>`;
    $('bill-year-bars').innerHTML = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']
      .map((m, i) => `<div class="bt-bar"><div class="bt-stack"><div class="bt-seg gas" style="height:${[68,56,40,24,16,8,3,2][i]}px"></div><div class="bt-seg elec" style="height:${[22,22,20,22,22,20,17,12][i]}px"></div></div><span>${m}</span></div>`)
      .join('');
    $('bill-year-block').style.display = '';
}

function clearBillingUnavailable() {
    $('balance-now').textContent = 'Unavailable';
    $('balance-now-pill').textContent = '';
    $('balance-projected').textContent = 'Unavailable';
    $('balance-projected-pill').textContent = '';
    $('next-dd-amount').textContent = '—';
    $('balance-after-dd').textContent = '—';
    $('balance-after-dd-pill').textContent = '';
    $('balance-trend-pill').textContent = '';
    $('balance-trend-pill').className = 'trend-pill';
    $('balance-after-dd-row').style.display = 'none';
    $('cost-mtd').textContent = 'Unavailable';
    $('cost-predicted').textContent = 'Unavailable';
    $('cycle-bar').style.width = '0%';
    $('cycle-day').textContent = '—';
    $('elec-latest-label').textContent = 'Latest available'; $('elec-latest').textContent = 'Unavailable';
    $('elec-week-total').textContent = 'Unavailable';
    $('elec-mtd').textContent = 'Unavailable'; $('elec-predicted').textContent = 'Unavailable';
    $('elec-standing').textContent = '—';
    $('gas-latest-label').textContent = 'Latest available'; $('gas-latest').textContent = 'Unavailable';
    $('gas-week-total').textContent = 'Unavailable';
    $('gas-mtd').textContent = 'Unavailable'; $('gas-predicted').textContent = 'Unavailable';
    $('gas-unit-rate').textContent = '—'; $('gas-standing').textContent = '—';
    renderWeekBars('elec-week', [0, 0, 0, 0, 0, 0, 0], 'elec-col', fmtGBP, 58, 'elec-week-scale');
    renderWeekBars('gas-week', [0, 0, 0, 0, 0, 0, 0], 'gas-col', fmtGBP, 58, 'gas-week-scale');
    $('last-bill-row').innerHTML = '<div style="color:var(--text-dim);font-size:12.5px;">Loading last bill…</div>';
    document.getElementById('bill-history-toggle')?.classList.add('hidden');
    billMonthsData = [];
    selectedBillMonth = null;
    $('bill-year-block').style.display = 'none';
    $('bill-history').classList.add('hidden');
}

async function loadAll(source = 'app-start') {
  const apiKeySnapshot = store.creds?.apiKey;
  setSyncStatus('ok', 'Syncing…');
  syncIssues = [];
  debugNotes = [];
  if (meterDebugNote) debugNotes.push(`Meter selection: ${meterDebugNote}`);
  // Rates load first — EV cost estimates reuse today's off-peak rate from this call.
  const ratesResult = await loadRates().catch(() => false);
  // Live usage runs alongside the others but is excluded from the overall
  // sync-status calculation below — not having a telemetry device is a
  // normal, expected state for most accounts, not a sync failure.
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
  }, apiKeySnapshot, syncIssues);
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
async function loadFastTier() {
  const apiKeySnapshot = store.creds?.apiKey;
  clearRateCacheIfNewDay();
  syncIssues = [];
  debugNotes = [];
  if (meterDebugNote) debugNotes.push(`Meter selection: ${meterDebugNote}`);
  const ratesResult = await loadRates().catch(() => false);
  const [evSettled] = await Promise.allSettled([loadEV()]);
  const evResult = evSettled.status === 'fulfilled' ? evSettled.value : false;
  await checkRateLimitBlocked();
  logSyncAttempt('fast', { Rates: ratesResult, EV: evResult }, apiKeySnapshot, syncIssues);
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
  const apiKeySnapshot = store.creds?.apiKey;
  let billingSettled;
  try {
    billingSettled = await loadBilling();
  } catch (err) {
    logIssue('Billing (uncaught)', err);
    billingSettled = false;
  }
  logSyncAttempt('slow', { Billing: billingSettled }, apiKeySnapshot, syncIssues);
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
  const showDiagnostics = $('input-show-diagnostics').checked;
  const useDemoFallback = $('input-use-demo-fallback').checked;
  if (!apiKey || !accountNumber) { alert('API key and account number are required.'); return; }

  store.creds = { ...store.creds, apiKey, accountNumber, email, password, manualElecMpan, manualElecSerial, manualGasMprn, manualGasSerial, calorificValue, showDiagnostics, useDemoFallback };
  krakenToken = null;

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
let autoRefreshStarted = false;
function startAutoRefresh() {
  if (autoRefreshStarted) return;
  autoRefreshStarted = true;
  // Not a timer — vehicle registration never changes in normal use, so this
  // runs once per app lifetime (the function itself no-ops on every later
  // call once cached), not on any recurring schedule at all.
  loadVehicleInfoOnce().catch(() => {});
  setInterval(loadFastTier, 5 * 60 * 1000);
  // Consumption bars/MTD, bills, standing charges, balance/DD — everything
  // in loadBilling() — genuinely can't reveal new information more often
  // than this. Smart meter consumption lags 24-48h regardless of how often
  // we ask; bills land on Octopus's own roughly-monthly schedule; standing
  // charges change over weeks, not minutes. 30 minutes was needlessly
  // frequent and was very likely the main contributor to hitting Octopus's
  // documented 100-calls/hour shared rate limit.
  setInterval(loadSlowTier, 6 * 60 * 60 * 1000);
  // Live usage refreshes faster on its own — 30s, matching roughly how
  // often new telemetry actually shows up, without re-running either tier.
  setInterval(() => loadLiveUsage().catch(() => {}), 30 * 1000);
}

function init() {
  $('app-version').textContent = APP_VERSION;
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
  $('live30-toggle').addEventListener('click', () => { live30Open ? closeLive30() : openLive30(); });
  $('ev-header').addEventListener('click', () => {
    const currentlyExpanded = !$('ev-body').classList.contains('hidden');
    evManualOverride = !currentlyExpanded;
    $('ev-body').classList.toggle('hidden', !evManualOverride);
    $('ev-card').classList.toggle('ev-collapsed', !evManualOverride);
    $('ev-chevron').textContent = evManualOverride ? '▾' : '▸';
    $('ev-header').setAttribute('aria-expanded', String(evManualOverride));
  });
  $('ev-view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.unit-toggle-btn');
    if (!btn) return;
    const view = btn.dataset.view;
    $('ev-view-dispatch-btn').classList.toggle('active', view === 'dispatch');
    $('ev-view-session-btn').classList.toggle('active', view === 'session');
    $('ev-slots-dispatch').classList.toggle('hidden', view !== 'dispatch');
    $('ev-slots-session').classList.toggle('hidden', view !== 'session');
  });
  $('ev-week').addEventListener('click', (e) => {
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
  });

  // Insights — collapsed by default; data is lazy-loaded on the first
  // expand only, since it needs a full month's data (~30 calls) that
  // shouldn't be paid for on every app load if the user never opens this.
  $('insights-header').addEventListener('click', () => {
    const currentlyExpanded = !$('insights-body').classList.contains('hidden');
    const nowExpanded = !currentlyExpanded;
    $('insights-body').classList.toggle('hidden', !nowExpanded);
    $('insights-hint').classList.toggle('hidden', nowExpanded);
    $('insights-chevron').textContent = nowExpanded ? '▾' : '▸';
    $('insights-header').setAttribute('aria-expanded', String(nowExpanded));
    if (nowExpanded) loadInsights();
  });

  // £ / kWh toggle — per fuel panel, instant re-render from cached data.
  document.querySelectorAll('.unit-toggle[data-fuel] .unit-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fuel = btn.closest('.unit-toggle').dataset.fuel;
      fuelUnit[fuel] = btn.dataset.unit;
      renderFuelPanel(fuel);
    });
  });

  // Day / Week / Month / Year toggle — shared across both fuel panels.
  // Month/Year data is fetched lazily on first use rather than on every
  // sync; Day is electricity-only, but the fetch is harmless to attempt
  // unconditionally since renderFuelPanel handles gas's "not available"
  // state regardless of whether fuelData.elec.day ends up populated.
  document.querySelectorAll('.unit-toggle[data-role="period"] .unit-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      periodMode = btn.dataset.period;
      document.querySelectorAll('.unit-toggle[data-role="period"] .unit-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      selectedDay.elec = null; // reset — old index would point at a different day/month in the new array
      selectedDay.gas = null;
      selectedDaySlot.elec = null;
      if (periodMode === 'month') {
        await Promise.all([loadMonthData('elec'), loadMonthData('gas')]);
      } else if (periodMode === 'day') {
        if (!fuelData.elec) fuelData.elec = {};
        if (!fuelData.elec.day) {
          try { fuelData.elec.day = await fetchElecDayHalfHourly(); }
          catch (err) { logIssue('Day view', err); fuelData.elec.day = { date: null, slots: [] }; }
        }
      } else if (periodMode === 'year') {
        fuelData.elec = fuelData.elec || {};
        fuelData.gas = fuelData.gas || {};
        if (!fuelData.elec.year) {
          try { fuelData.elec.year = await fetchYearMonthly('elec'); }
          catch (err) { logIssue('Year view (elec)', err); fuelData.elec.year = []; }
        }
        if (!fuelData.gas.year) {
          try { fuelData.gas.year = await fetchYearMonthly('gas'); }
          catch (err) { logIssue('Year view (gas)', err); fuelData.gas.year = []; }
        }
      }
      renderFuelPanel('elec');
      renderFuelPanel('gas');
    });
  });

  // Tap a bar to see that day's (or month's) breakdown; tap the same bar
  // again to close it. Event delegation so it works regardless of how many
  // bars get re-rendered (week/month/year all reuse this).
  ['elec', 'gas'].forEach(fuel => {
    $(`${fuel}-week`).addEventListener('click', (e) => {
      const bar = e.target.closest('.col-stack');
      if (!bar) return;
      const index = parseInt(bar.dataset.index, 10);
      if (Number.isNaN(index)) return;
      selectedDay[fuel] = (selectedDay[fuel] === index) ? null : index;
      renderFuelPanel(fuel);
    });
  });

  // Same tap-to-reveal pattern for the bill-total-over-time chart — tap a
  // month's bar to see its gas/electricity split underneath (and a note +
  // link if that month combined more than one bill). Re-renders just the
  // selection/breakdown, not the whole chart, since the bar heights
  // themselves don't change on tap.
  $('bill-year-bars').addEventListener('click', (e) => {
    const bar = e.target.closest('.bt-stack');
    if (!bar) return;
    const index = parseInt(bar.dataset.index, 10);
    if (Number.isNaN(index)) return;
    selectedBillMonth = (selectedBillMonth === index) ? null : index;
    document.querySelectorAll('#bill-year-bars .bt-bar').forEach(bar => {
      const idx = parseInt(bar.querySelector('.bt-stack').dataset.index, 10);
      bar.querySelector('.bt-stack').classList.toggle('selected', idx === selectedBillMonth);
      bar.querySelector('span').classList.toggle('active-day', idx === selectedBillMonth);
    });
    renderBillYearBreakdown(selectedBillMonth);
  });

  // Same tap-to-reveal pattern for the balance runway forecast — tap a
  // cycle's bar to see that month's payment/electricity/gas composition.
  $('insights-runway-bars').addEventListener('click', (e) => {
    const bar = e.target.closest('.forecast-bar-wrap');
    if (!bar) return;
    const index = parseInt(bar.dataset.index, 10);
    if (Number.isNaN(index)) return;
    selectedForecastCycle = (selectedForecastCycle === index) ? null : index;
    document.querySelectorAll('#insights-runway-bars .forecast-bar-wrap').forEach(el => {
      const isSel = parseInt(el.dataset.index, 10) === selectedForecastCycle;
      el.querySelector('.forecast-bar').classList.toggle('selected', isSel);
    });
    document.querySelectorAll('#insights-runway-labels span').forEach((el, i) => {
      el.classList.toggle('active-day', i === selectedForecastCycle);
    });
    renderBalanceForecastBreakdown(selectedForecastCycle);
  });

  // Same tap-to-reveal pattern for the Day view's half-hourly slots.
  $('elec-day-bars').addEventListener('click', (e) => {
    const bar = e.target.closest('.fill');
    if (!bar) return;
    const index = parseInt(bar.dataset.index, 10);
    if (Number.isNaN(index)) return;
    selectedDaySlot.elec = (selectedDaySlot.elec === index) ? null : index;
    renderFuelPanel('elec');
  });


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

document.addEventListener('DOMContentLoaded', init);
