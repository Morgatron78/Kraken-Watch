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
const APP_VERSION = 'v2.196';

// v2.191: this was the app's single biggest "only works for one specific
// account" hardcode — replaced with a Settings-configurable pair (WLTP
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
let krakenAccountUserId = null;
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
  // The token's own `sub` claim is formatted `kraken|account-user:<id>` —
  // confirmed by decoding a real token during development — so the id
  // needed for loyaltyPointLedgers is available for free from a token
  // already fetched on every sync, no separate lookup query required.
  // Only the one claim is read, never logged, never stored beyond memory.
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const match = /^kraken\|account-user:(\d+)$/.exec(payload.sub || '');
    krakenAccountUserId = match ? match[1] : null;
  } catch { krakenAccountUserId = null; }
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
  if (json.errors) {
    // GraphQL errors often carry a specific machine code in `extensions`
    // (e.g. KT-CT-1111 vs KT-CT-9216 — both surface as the same bare
    // "Unauthorized" message, but mean different things) — previously
    // discarded, keeping only the generic message. Appending the code
    // when present means the next failure is actually diagnosable from
    // the diagnostics panel alone, not just "something's unauthorized."
    const err = json.errors[0];
    const code = err?.extensions?.errorCode || err?.extensions?.code;
    const message = err?.message || 'GraphQL error';
    throw new Error(code ? `${message} (${code})` : message);
  }
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
let cachedOffPeakRateP = null; // cheapest electricity rate seen today — fallback rate for Live Usage's £/hr estimate when the current rate hasn't loaded yet
let cachedCurrentRateP = null; // right-now electricity rate — used for the live-usage £/hr estimate
let cachedStandardRateP = null; // most expensive electricity rate seen today — v2.154: used to estimate Boost-session charging cost, since Boost charges happen outside the smart dispatch schedule and so are assumed to land at standard rate, not off-peak
let cachedElecStandingP = null;
let cachedGasStandingP = null;

// v2.192: shared cost-estimate helper — same type-based assumption as the
// existing "This session" mini-box (v2.154), now reused for the Sessions
// tab and Charge History too, rather than duplicating the logic three
// times. Uses TODAY's off-peak/standard rate for every session regardless
// of how old it is, a deliberate simplification confirmed reasonable with
// the user: their electricity tariff is fixed for 12-month periods and
// rarely changes, so a genuine per-session historical-rate fetch (which
// this app doesn't otherwise do) would add real complexity for a
// difference that would only actually matter right at a tariff renewal
// boundary. Returns null (not a guess) if today's rates haven't loaded.
function estimateSessionCostP(session) {
  if (cachedOffPeakRateP == null || cachedStandardRateP == null) return null;
  const kwh = Math.abs(session.energyAdded?.value || 0);
  const rateP = session.type === 'BOOST' ? cachedStandardRateP : cachedOffPeakRateP;
  return kwh * rateP;
}

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

async function lastNDaysElecSplit(n, anchor = new Date()) {
  const { elecMpan, elecSerial } = store.creds;
  const now = anchor;
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
      // Kept alongside the day totals below (not discarded) so the Week/Month
      // breakdown box can render a mini half-hourly bar chart with zero extra
      // fetch — this same wide-range call already pulled every slot.
      const slots = [];
      for (const r of readings) {
        const rate = rateAt(rates, +new Date(r.interval_start));
        if (rate === null) continue;
        const cost = r.consumption * rate / 100;
        const offpeak = rate <= threshold;
        if (offpeak) { offPeakKwh += r.consumption; offPeakCostP += r.consumption * rate; }
        else { peakKwh += r.consumption; peakCostP += r.consumption * rate; }
        slots.push({ start: r.interval_start, kwh: r.consumption, rate, cost, isOffpeak: offpeak });
      }
      slots.sort((a, b) => +new Date(a.start) - +new Date(b.start));
      return {
        offPeakKwh, peakKwh, offPeakCost: offPeakCostP / 100, peakCost: peakCostP / 100,
        // Same reasoning as before: a placeholder reading-period with rows
        // present but kwh totalling zero is treated as not-yet-settled
        // rather than a genuine zero-usage day.
        hasData: readings.length > 0 && (offPeakKwh + peakKwh) > 0.001,
        date: dates[i], slots
      };
    });
  } catch (err) {
    logIssue('Electricity week breakdown', err);
    return dates.map(date => ({ offPeakKwh: 0, peakKwh: 0, offPeakCost: 0, peakCost: 0, hasData: false, date, slots: [] }));
  }
}

// Whole calendar month containing monthAnchor, capped at today if it's the
// current month (or returning nothing for a month entirely in the future).
// Deliberately just computes the right (n, anchor) pair and delegates to
// the already-anchor-generalized lastNDaysElecSplit above, rather than
// duplicating its fetch/bucket/slot logic — effectiveLastDay minus n days
// always equals monthStart by construction, so this is exact, not an
// approximation.
async function monthElecSplit(monthAnchor) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monthStart = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1);
  if (monthStart > today) return [];
  const lastDayOfMonth = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0);
  const isCurrentMonth = monthAnchor.getFullYear() === today.getFullYear() && monthAnchor.getMonth() === today.getMonth();
  const effectiveLastDay = isCurrentMonth ? today : (lastDayOfMonth > today ? today : lastDayOfMonth);
  const n = Math.round((+effectiveLastDay - +monthStart) / 86400000) + 1;
  return lastNDaysElecSplit(n, effectiveLastDay);
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
function renderStackedBars(containerId, dayStacks, formatter, maxBarHeight = 44, scaleId = null, selectedIndex = null, isMonthMode = false, suppressToday = false, weekdayAnchor = null) {
  const el = $(containerId);
  const totals = dayStacks.map(day => day.reduce((s, seg) => s + seg.value, 0));
  const max = Math.max(...totals, 0.01);
  renderChartScale(scaleId, max, formatter);
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = (weekdayAnchor || new Date()).getDay();
  const isDense = dayStacks.length > 10;
  el.classList.toggle('dense', isDense);
  el.innerHTML = dayStacks.map((segs, i) => {
    const isToday = !suppressToday && i === dayStacks.length - 1;
    const isSelected = i === selectedIndex;
    const segHtml = segs.map(seg => {
      const h = Math.max(seg.value > 0 ? 1 : 0, Math.round((seg.value / max) * maxBarHeight));
      return `<div class="col-seg ${seg.cssClass}${isToday ? ' today' : ''}" style="height:${h}px"></div>`;
    }).join('');
    // Month view: real day-of-month number (index+1, matching
    // dateForPeriodIndex's own month-mode logic) — the day-of-week formula
    // below only correctly handles up to a 7-bar span (a single +7
    // wraparound correction), so a longer month array pushed it negative
    // and printed literal "undefined".
    // v2.151 fix: a picked week (weekdayAnchor set) is always fetched as an
    // exact snapped Sun–Sat span (see loadPickedPeriodData) — index i IS
    // the weekday directly, no rotation needed. The rotation formula below
    // is only correct for the default *rolling* 7-day window (last bar =
    // today, wrapping backward from whatever weekday today happens to be);
    // applying it to a picked week used the raw tapped day as if it were
    // the array's last entry, mislabeling every bar whenever the tapped
    // day wasn't a Saturday — same root cause as the v2.143/v2.144 fetch
    // and breakdown-date bugs, just in the axis labels this time.
    const labelText = isMonthMode ? String(i + 1)
      : weekdayAnchor ? labels[i]
      : labels[(today - (dayStacks.length - 1 - i) + 7) % 7];
    // Showing every one of ~28-31 month labels overflows a mobile-width
    // chart (confirmed live) — every label stays legible alone, but that
    // many crammed together doesn't fit. Every 5th only once dense.
    // The <span> itself must always render even when empty — omitting the
    // element entirely (rather than just its text) made unlabeled columns
    // one child shorter than labeled ones, and since columns bottom-align
    // via flex, that shifted their bars down relative to labeled columns
    // by roughly the label's own height (confirmed live — a few px lower).
    const showThisLabel = !isDense || i % 5 === 0;
    // A genuinely empty string (not even whitespace) can still collapse an
    // inline element's line-height in some browsers despite font-size
    // being set — a non-breaking space guarantees real content, so height
    // stays consistent regardless of any browser-specific quirk there.
    const label = `<span class="${isSelected ? 'active-day' : ''}">${showThisLabel ? labelText : '&nbsp;'}</span>`;
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

// Date-picker state — a single shared anchor date (or null for "current
// period, anchored to today", the existing default behavior everywhere
// else). Applies across Day/Week/Month, matching how Octopus's own picker
// works: one date field + one period field, not three independent picks.
// Not persisted across reloads, same as periodMode/selectedDay — ephemeral
// UI state, reset on refresh.
let pickedDate = null;
let pickerOpen = false;
let pickerViewMonth = new Date(); // which month the calendar grid shows
let billMonthsData = [];

// Maps an index in the current period array back to a real calendar date —
// week view counts backward from today, month view counts forward from the
// 1st of the current month.
function dateForPeriodIndex(index, arrayLength) {
  const anchor = pickedDate || new Date();
  if (periodMode === 'month') return new Date(anchor.getFullYear(), anchor.getMonth(), index + 1);
  if (periodMode === 'week' && pickedDate) {
    // The fetch itself snaps to the Sun–Sat week around whatever day was
    // tapped (see loadPickedPeriodData) — pickedDate is that tapped day,
    // not necessarily the week's last day, so labeling must snap the same
    // way or every bar gets labeled with the wrong real date.
    const wd = pickedDate.getDay();
    const weekEnd = new Date(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate() + (6 - wd));
    return new Date(weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate() - (arrayLength - 1 - index));
  }
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - (arrayLength - 1 - index));
}

// --- Date picker (Usage card: Day/Week/Month only, matching
// Octopus's own picker — Year has no single date to anchor to) ---

function openDatePicker() {
  pickerOpen = true;
  $('date-picker-panel').classList.remove('hidden');
  $('date-picker-btn').classList.add('active');
  pickerViewMonth = pickedDate
    ? new Date(pickedDate.getFullYear(), pickedDate.getMonth(), 1)
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  renderPickerCalendar();
}

function closeDatePicker() {
  pickerOpen = false;
  $('date-picker-panel').classList.add('hidden');
  $('date-picker-btn').classList.remove('active');
}

// Shows/hides the calendar button and the "showing X" pill, and keeps the
// pill's text in sync with whichever period is active — called after every
// period-mode switch and every pick, not just on open.
function updateDatePickerUI() {
  const isYear = periodMode === 'year';
  $('date-picker-btn').classList.toggle('hidden', isYear);
  const pill = $('date-picker-pill');
  if (!pickedDate || isYear) { pill.classList.add('hidden'); return; }
  pill.classList.remove('hidden');
  let text;
  if (periodMode === 'week') {
    const wd = pickedDate.getDay();
    const ws = new Date(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate() - wd);
    const we = new Date(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate() + (6 - wd));
    const sameMonth = ws.getMonth() === we.getMonth();
    text = sameMonth
      ? `week of ${ws.getDate()}–${we.getDate()} ${we.toLocaleDateString('en-GB', { month: 'long' })}`
      : `week of ${ws.getDate()} ${ws.toLocaleDateString('en-GB', { month: 'short' })} – ${we.getDate()} ${we.toLocaleDateString('en-GB', { month: 'short' })}`;
  } else if (periodMode === 'month') {
    text = pickedDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  } else {
    text = pickedDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  $('date-picker-pill-text').textContent = text;
}

function renderPickerCalendar() {
  const year = pickerViewMonth.getFullYear(), month = pickerViewMonth.getMonth();
  $('picker-month-label').textContent = pickerViewMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonthCount = new Date(year, month + 1, 0).getDate();
  const firstWeekday = firstOfMonth.getDay();

  const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  let html = dow.map(d => `<div class="picker-dow">${d}</div>`).join('');
  for (let i = 0; i < firstWeekday; i++) html += `<div class="picker-day dim"></div>`;

  // Week mode: highlight the Sun–Sat week around whichever date is
  // relevant (the pick if one exists, otherwise today) so the picker shows
  // what's currently on screen, not just a blank grid.
  let weekStart = null, weekEnd = null;
  if (periodMode === 'week') {
    const anchor = pickedDate || today;
    const wd = anchor.getDay();
    weekStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - wd);
    weekEnd = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + (6 - wd));
  }

  for (let d = 1; d <= daysInMonthCount; d++) {
    const cellDate = new Date(year, month, d);
    let cls = 'picker-day';
    const isFuture = cellDate > today;
    if (isFuture) cls += ' future';
    if (+cellDate === +today) cls += ' today';
    if (periodMode === 'week' && weekStart && cellDate >= weekStart && cellDate <= weekEnd) {
      cls += ' in-week';
      if (+cellDate === +weekStart) cls += ' week-start';
      if (+cellDate === +weekEnd) cls += ' week-end';
    }
    if (pickedDate && +cellDate === +new Date(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate())) {
      cls += ' selected';
    }
    html += `<div class="${cls}" data-date="${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}">${d}</div>`;
  }
  $('picker-grid').innerHTML = html;

  $('picker-legend-text').textContent = periodMode === 'week' ? 'selected week' : periodMode === 'month' ? 'selected month' : 'selected day';
  const isCurrentMonth = year === today.getFullYear() && month === today.getMonth();
  $('picker-next-month').classList.toggle('disabled', isCurrentMonth);
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

// Mini half-hourly bar chart inside the Week/Month breakdown box —
// electricity only. Reuses renderChartScale (same 3-label max/half/zero
// y-axis every other chart uses) and the existing seg-offpeak/seg-peak
// color classes, so this doesn't introduce any new visual language.
function renderMiniDayChart(fuel, slots, unit) {
  const barsEl = $(`${fuel}-breakdown-bars`);
  if (!barsEl) return;
  const values = slots.map(s => unit === 'cost' ? s.cost : s.kwh);
  const max = Math.max(...values, 0.001);
  renderChartScale(`${fuel}-breakdown-scale`, max, unit === 'cost' ? fmtGBP : fmtKwh);
  barsEl.innerHTML = slots.map((s, i) => {
    const h = Math.max(2, Math.round((values[i] / max) * 40));
    return `<div class="mini-bar ${s.isOffpeak ? 'seg-offpeak' : 'seg-peak'}" style="height:${h}px"></div>`;
  }).join('');
}

function renderBreakdown(fuel, periodData, index, unit) {
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

  const isCost = (unit || 'cost') === 'cost';
  let rows;
  if (fuel === 'elec') {
    rows = (isCost ? breakdownRow('Standing charge', 'seg-standing', fmtGBP(day.standing || 0), null) : '')
      + (isCost
        ? breakdownRow('Off-peak', 'seg-offpeak', fmtGBP(day.offPeakCost || 0), fmtKwh(day.offPeakKwh || 0))
          + breakdownRow('Peak', 'seg-peak', fmtGBP(day.peakCost || 0), fmtKwh(day.peakKwh || 0))
        : breakdownRow('Off-peak', 'seg-offpeak', fmtKwh(day.offPeakKwh || 0), null)
          + breakdownRow('Peak', 'seg-peak', fmtKwh(day.peakKwh || 0), null));
  } else {
    rows = (isCost ? breakdownRow('Standing charge', 'seg-gas-standing', fmtGBP(day.standing || 0), null) : '')
      + (isCost
        ? breakdownRow('Usage', 'seg-gas-usage', fmtGBP(day.cost || 0), fmtKwh(day.kwh || 0))
        : breakdownRow('Usage', 'seg-gas-usage', fmtKwh(day.kwh || 0), null));
  }
  const total = dayTotal(fuel, day, isCost ? 'cost' : 'kwh');
  const totalStr = isCost ? fmtGBP(total) : fmtKwh(total);

  // Electricity only, and only once real half-hourly slots came back for
  // this particular day — a settlement-lag day or a fetch failure both
  // leave slots empty, and an empty chart would be more confusing than no
  // chart at all.
  const hasSlots = fuel === 'elec' && Array.isArray(day.slots) && day.slots.length > 0;
  const miniChartHtml = hasSlots
    ? `<div class="chart-row mini-chart">
         <div class="chart-scale mini-chart-scale" id="${fuel}-breakdown-scale"></div>
         <div class="mini-chart-main">
           <div class="mini-bars" id="${fuel}-breakdown-bars"></div>
           <div class="mini-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
         </div>
       </div>`
    : '';

  box.innerHTML = `<div class="breakdown-date">${dateLabel}</div>${miniChartHtml}${rows}<div class="breakdown-total"><span>Total</span><span>${totalStr}</span></div>`;

  if (hasSlots) renderMiniDayChart(fuel, day.slots, unit || 'cost');
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

  const periodData = pickedDate
    ? (periodMode === 'month' ? d.pickedMonth : d.pickedWeek)
    : (periodMode === 'month' ? d.month : d.week);
  if (periodData) {
    const dayStacks = periodData.map(day => buildDaySegments(fuel, day, unit));
    renderStackedBars(`${fuel}-week`, dayStacks, fmt, 58, `${fuel}-week-scale`, selectedDay[fuel], periodMode === 'month', !!pickedDate, pickedDate);
    renderBreakdown(fuel, periodData, selectedDay[fuel], unit);
    // Only for a picked (historical) period, not the default current
    // week/month — that already handles lag gracefully via the
    // "hasData"-scanning logic elsewhere, and showing this for an
    // in-progress current period would be alarming rather than honest.
    const isPickedEmpty = !!pickedDate && periodData.every(day => day.hasData === false);
    $(`${fuel}-period-nodata`).classList.toggle('hidden', !isPickedEmpty);
  }
}

// --- Day view (electricity only) ---

let selectedDaySlot = { elec: null };

function renderElecDayView() {
  const day = pickedDate ? fuelData.elec?.pickedDay : fuelData.elec?.day;
  const unit = fuelUnit.elec;
  const fmt = unit === 'cost' ? fmtGBP : fmtKwh;

  if (!day || !day.slots || !day.slots.length) {
    // A picked date with no data is a different message from the default
    // "still waiting for today's readings to settle" — the user asked for
    // this specific date, so say so rather than implying it's pending.
    $('elec-day-label').textContent = pickedDate
      ? pickedDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      : 'Latest available day';
    $('elec-day-total').textContent = pickedDate ? 'No data available' : 'No data yet';
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
  const day = pickedDate ? fuelData.elec?.pickedDay : fuelData.elec?.day;
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
// used by the Usage panel — Insights can load while that panel is
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
      const trendUpSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
      const trendDownSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>';
      $('insights-elec-trajectory-icon').innerHTML = diffPct >= 0 ? trendUpSvg : trendDownSvg;
      $('insights-elec-trajectory-icon').style.color = diffPct >= 0 ? 'var(--coral)' : 'var(--mint)';
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
    let weekdayTotal = 0, weekdayCount = 0, weekendTotal = 0, weekendCount = 0;
    month.forEach((d, i) => {
      const date = insightsMonthDate(i);
      if (date >= todayMidnight1 || d.hasData === false) return;
      standing += d.standing || 0; usage += d.cost || 0;
      const total = dayTotal('gas', d, 'cost');
      if (!high || total > high.total) high = { total, date };
      if (!low || total < low.total) low = { total, date };
      const dow = date.getDay();
      if (dow === 0 || dow === 6) { weekendTotal += total; weekendCount++; }
      else { weekdayTotal += total; weekdayCount++; }
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

    // v2.164: weekday/weekend and trajectory — gas equivalents of the two
    // elec-only Insights features, mirrored exactly (same thresholds, same
    // wording, same fmtGBP/trend-pill conventions) so the two fuels read
    // consistently. These were never carried over when gas's Insights
    // panel was originally built; no reason found for the gap on review.
    if (weekdayCount > 0 && weekendCount > 0) {
      const weekdayAvg = weekdayTotal / weekdayCount, weekendAvg = weekendTotal / weekendCount;
      const totalAvg = weekdayAvg + weekendAvg || 1;
      const weekdayPct = Math.min(88, Math.max(12, Math.round((weekdayAvg / totalAvg) * 100)));
      $('insights-gas-weekday-value').textContent = fmtGBP(weekdayAvg);
      $('insights-gas-weekend-value').textContent = fmtGBP(weekendAvg);
      $('insights-gas-weekday-bar').style.width = weekdayPct + '%';
      $('insights-gas-weekend-bar').style.width = (100 - weekdayPct) + '%';
      const diffPct = weekdayAvg > 0 ? ((weekendAvg - weekdayAvg) / weekdayAvg) * 100 : 0;
      const pill = $('insights-gas-pattern-headline');
      if (Math.abs(diffPct) < 5) {
        pill.className = 'trend-pill up';
        pill.textContent = '≈ No significant weekday/weekend difference';
      } else {
        const pricier = diffPct > 0 ? 'Weekends' : 'Weekdays';
        pill.className = 'trend-pill down';
        pill.textContent = `↑ ${pricier} cost ${Math.abs(diffPct).toFixed(0)}% more on average`;
      }
      $('insights-gas-weekday-block').classList.remove('hidden');
    } else {
      $('insights-gas-weekday-block').classList.add('hidden'); // not enough of both kinds yet this month
    }

    const validDays = month.filter((d, i) => d.hasData !== false && insightsMonthDate(i) < todayMidnight1);
    if (validDays.length >= 6) {
      const mid = Math.floor(validDays.length / 2);
      const firstHalf = validDays.slice(0, mid), secondHalf = validDays.slice(mid);
      const firstAvg = firstHalf.reduce((s, d) => s + dayTotal('gas', d, 'cost'), 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, d) => s + dayTotal('gas', d, 'cost'), 0) / secondHalf.length;
      const diffPct = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;
      const trendUpSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
      const trendDownSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>';
      $('insights-gas-trajectory-icon').innerHTML = diffPct >= 0 ? trendUpSvg : trendDownSvg;
      $('insights-gas-trajectory-icon').style.color = diffPct >= 0 ? 'var(--coral)' : 'var(--mint)';
      $('insights-gas-trajectory-text').innerHTML = Math.abs(diffPct) < 5
        ? 'Fairly steady so far this month — no clear upward or downward trend'
        : `More recent days running <b>${Math.abs(diffPct).toFixed(0)}% ${diffPct >= 0 ? 'higher' : 'lower'}</b> than earlier this month`;
      $('insights-gas-trajectory-block').classList.remove('hidden');
    } else {
      $('insights-gas-trajectory-block').classList.add('hidden'); // too early in the month for this to mean much
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
    const carriedForward = running;
    running += payment - elecCost - gasCost;
    cycles.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      full: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      fallback,
      carriedForward,
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
    + `<div class="carried-row"><span class="l">Balance carried forward</span><span class="v">${fmtGBP(d.carriedForward)}</span></div>`
    + `<div class="bh-item"><span class="l">Electricity</span><span class="v">${d.elec < 0 ? '−' : '+'}${fmtGBP(d.elec)}</span></div>`
    + `<div class="bh-item"><span class="l">Gas</span><span class="v">${d.gas < 0 ? '−' : '+'}${fmtGBP(d.gas)}</span></div>`
    + `<div class="energy-subtotal"><span class="l">Total energy costs</span><span class="v">−${fmtGBP(Math.abs(d.elec) + Math.abs(d.gas))}</span></div>`
    + `<div class="bh-item" style="margin-top:10px;"><span class="l">Payment</span><span class="v credit">+${fmtGBP(d.payment)}</span></div>`
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

  // v2.166: no longer auto-selects the lowest-balance month on load. Was
  // previously deliberate ("so tapping isn't required to see what 'lowest
  // point' means"), but the user found it more useful for the breakdown to
  // only ever open on an actual tap — especially now that it's a richer
  // ledger (ledger structure below) rather than a 3-line summary, auto-
  // opening one felt like more content appearing than was asked for.
  // selectedForecastCycle now stays null until a bar is tapped, so
  // renderBalanceForecastBreakdown(null) just keeps the box hidden.

  const allPositive = balanceForecastData.every(c => c.cumulative >= 0);
  if (allPositive) {
    const lastMonth = balanceForecastData[balanceForecastData.length - 1];
    icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
    icon.style.color = 'var(--mint)';
    headline.className = 'runway-headline ok';
    headline.textContent = 'Payments look sufficient';
    detail.textContent = `Projected to stay in credit through ${lastMonth.label}`;
  } else {
    const dipIdx = balanceForecastData.findIndex(c => c.cumulative < 0);
    const recoverIdx = balanceForecastData.findIndex((c, i) => i > dipIdx && c.cumulative >= 0);
    let lowIdx = 0;
    balanceForecastData.forEach((c, i) => { if (c.cumulative < balanceForecastData[lowIdx].cumulative) lowIdx = i; });
    icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    icon.style.color = 'var(--coral)';
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

// Fetches whichever period (Day/Week/Month) is currently active, anchored
// to pickedDate instead of today — called only when a pick is active. Each
// result is cached against the exact date/month it was fetched for
// (pickedWeekFor / pickedMonthFor / pickedDayFor) so re-rendering the same
// pick, or switching periodMode back and forth across it, never refetches;
// only picking a genuinely different date does.
async function loadPickedPeriodData() {
  if (!pickedDate) return;
  if (periodMode === 'week') {
    // The pill/calendar both snap to the Sun–Sat week around pickedDate for
    // display — this fetch needs the exact same snap, or tapping any day
    // that isn't a Saturday fetches the wrong week entirely (whatever 7
    // days end at the tapped day, not the displayed Sun–Sat range).
    const wd = pickedDate.getDay();
    const weekStart = new Date(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate() - wd);
    const weekEnd = new Date(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate() + (6 - wd));
    // Keyed by the week's Sunday, not the exact tapped day, so tapping any
    // day within the same week reuses the same cached fetch.
    const key = weekStart.toISOString().slice(0, 10);
    if (fuelData.elec?.pickedWeekFor !== key) {
      fuelData.elec = fuelData.elec || {};
      const days = await lastNDaysElecSplit(7, weekEnd);
      const standing = cachedElecStandingP ? cachedElecStandingP / 100 : 0;
      fuelData.elec.pickedWeek = days.map(d => ({ ...d, standing }));
      fuelData.elec.pickedWeekFor = key;
    }
    if (fuelData.gas?.pickedWeekFor !== key) {
      fuelData.gas = fuelData.gas || {};
      const days = await lastNDaysCost('gas', 7, weekEnd);
      const standing = cachedGasStandingP ? cachedGasStandingP / 100 : 0;
      fuelData.gas.pickedWeek = days.map(d => ({ ...d, standing }));
      fuelData.gas.pickedWeekFor = key;
    }
  } else if (periodMode === 'month') {
    const key = `${pickedDate.getFullYear()}-${pickedDate.getMonth()}`;
    if (fuelData.elec?.pickedMonthFor !== key) {
      fuelData.elec = fuelData.elec || {};
      const days = await monthElecSplit(pickedDate);
      const standing = cachedElecStandingP ? cachedElecStandingP / 100 : 0;
      fuelData.elec.pickedMonth = days.map(d => ({ ...d, standing }));
      fuelData.elec.pickedMonthFor = key;
    }
    if (fuelData.gas?.pickedMonthFor !== key) {
      fuelData.gas = fuelData.gas || {};
      const days = await monthFuelSplit('gas', pickedDate);
      const standing = cachedGasStandingP ? cachedGasStandingP / 100 : 0;
      fuelData.gas.pickedMonth = days.map(d => ({ ...d, standing }));
      fuelData.gas.pickedMonthFor = key;
    }
  } else if (periodMode === 'day') {
    const key = pickedDate.toISOString().slice(0, 10);
    if (fuelData.elec?.pickedDayFor !== key) {
      fuelData.elec = fuelData.elec || {};
      try {
        fuelData.elec.pickedDay = await fetchElecDayHalfHourly(pickedDate);
      } catch (err) {
        logIssue('Picked day view', err);
        fuelData.elec.pickedDay = { date: pickedDate, slots: [] };
      }
      fuelData.elec.pickedDayFor = key;
    }
  }
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
async function fetchElecDayHalfHourly(anchor = null) {
  const { elecMpan, elecSerial } = store.creds;
  if (!elecMpan || !elecSerial) throw new Error('No elec meter point on file');
  // A full day is 48 half-hour slots (46/47 on a DST-change day) — require
  // most of that before accepting a day as "available". A handful of early
  // readings trickling in for today passed the old "any data at all" check,
  // producing a near-empty 2-bar chart that looked broken rather than
  // genuinely incomplete.
  const MIN_SLOTS_FOR_COMPLETE_DAY = 40;
  // A specific picked date: fetch exactly that day, no stepping back to an
  // earlier one — the user asked for that date specifically, so an honest
  // "incomplete" answer for it beats silently substituting a different day
  // they didn't ask for. The default (no anchor) keeps the old behavior:
  // step back from today to find the latest complete day, since there's no
  // single date the caller is expecting in that case.
  const daysToTry = anchor ? [0] : [0, 1, 2, 3];
  const baseDate = anchor || new Date();
  for (const daysAgo of daysToTry) {
    const now = baseDate;
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
  return { date: anchor || null, slots: [] }; // genuinely no complete day available
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

    cachedOffPeakRateP = Math.min(...points);
    cachedCurrentRateP = current;
    cachedStandardRateP = Math.max(...points);

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
      cachedStandardRateP = 28.9;
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
// (start/end/delta) but returned genuinely empty for this account —
// likely a different Octopus smart-device program (battery/solar
// dispatches) sharing the naming convention, not functionally connected
// to EV charging. The other real lead, `account.transactions(fromDate,
// toDate)` — already proven, working code, used by the Billing panel
// above — does return real settled Charge transactions with a
// `consumption { startDate endDate }` window, but only at *billed-period*
// granularity: one lump-sum electricity charge covering several days,
// one for the whole month for gas. No per-dispatch or per-half-hour
// resolution exists at that level either. Both realistic GraphQL avenues
// are now genuinely tested and exhausted, not just assumed — reinforcing
// the original conclusion via a completely different path. EV cost stays
// an estimate; nothing found changes that.

async function loadEV() {
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
    $('ev-ready').textContent = '—';
    $('ev-added').textContent = '—';
    $('ev-battery-row').classList.add('hidden');
    $('ev-schedule-preview').classList.add('hidden');
    $('ev-warnings').classList.add('hidden');
    $('ev-power-box').classList.add('hidden');
    $('ev-sessions-box').classList.add('hidden');
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
// SmartFlexDispatch.dispatches inside each session gives per-window
// detail (start/end/type/kWh), so the dispatch-window view is derived
// from the same one query rather than needing completedDispatches at all
// — only plannedDispatches stays as its own call, since chargingSessions
// is explicitly historical.
const fmtT = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

// v2.191: elapsed-time formatter for the session row — Octopus's own app
// shows this next to the time range; this app was leaving the user to
// work it out from start/end manually.
function formatElapsed(startISO, endISO) {
  const ms = new Date(endISO) - new Date(startISO);
  if (!(ms > 0)) return '';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

let expandedProblemSessions = new Set(); // keys = session start ISO strings, survives re-renders
let lastRenderedSessions = null, lastRenderedNow = null; // so the click handler can re-render without needing to know which list (8-day/expanded) is currently showing

// v2.189: Sessions-tab renderer, factored out so it can run against either
// the default 8-day `sessions` array or a wider on-demand fetch (see
// showMoreEVSessions) without duplicating the markup logic.
function renderEVSessionSlots(sessions, now) {
  lastRenderedSessions = sessions; lastRenderedNow = now;
  sessions.forEach((s, i) => { s._startSoc = i > 0 ? sessions[i - 1].stateOfChargeFinal : null; });
  const sessionSlots = $('ev-slots-session');
  sessionSlots.innerHTML = [...sessions].reverse().map(s => {
    const kwh = s.energyAdded?.value;
    const startD = new Date(s.start);
    const dayLabel = startD.toDateString() === now.toDateString() ? 'Today'
      : startD.toDateString() === new Date(now - 86400000).toDateString() ? 'Yesterday'
      : startD.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const elapsed = formatElapsed(s.start, s.end);
    let socText = '';
    if (s.stateOfChargeFinal != null) {
      if (s._startSoc != null) {
        const gain = Math.round(s.stateOfChargeFinal - s._startSoc);
        socText = `<span class="slot-soc">${Math.round(s._startSoc)}% → ${Math.round(s.stateOfChargeFinal)}%</span> <span class="slot-soc-gain">(${gain >= 0 ? '+' : ''}${gain}%)</span>`;
      } else {
        // v2.189: was just "→ X%" — this is always the oldest session in
        // whatever window is loaded (no prior session to derive a start
        // % from), so it's expected, not an error. An em-dash placeholder
        // keeps the same basic shape as a full row instead of silently
        // shrinking to a shorter one.
        socText = `<span class="slot-soc">— → ${Math.round(s.stateOfChargeFinal)}%</span>`;
      }
    }
    // v2.191: estimated range added, using getEvRangeMiPerKwh() (Settings-
    // configurable per vehicle, was a single hardcoded Polestar 2 constant)
    const milesText = kwh != null ? ` <span class="slot-soc-gain">≈${Math.round(Math.abs(kwh) * getEvRangeMiPerKwh())}mi</span>` : '';
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
      ? `<span class="problem-col"><button type="button" class="badge-problem-mini" data-problem-key="${problemKey}" aria-expanded="${isExpanded}">${warnTriangleSvgSm}</button></span>`
      : '<span class="problem-col"></span>';
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
      <div class="slot-row"><span>${dayLabel}, ${fmtT(s.start)} – ${fmtT(s.end)}${elapsed ? ` (${elapsed})` : ''}</span>${badgeHtml(s.type)}</div>
      <div class="slot-row-inline"><span class="left-group"><b>${kwh != null ? Math.abs(kwh).toFixed(1) + ' kWh' : '—'}</b>${costText}</span><span class="soc-col">${socText}${milesText}</span>${miniPillHtml}</div>
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
async function fetchEVSessionsWindow(days) {
  const data = await krakenGQL(`
    query EVSessionsWindow($accountNumber: String!, $after: DateTime!) {
      devices(accountNumber: $accountNumber) {
        ... on SmartFlexVehicle {
          chargingSessions(after: $after, first: 200) {
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
  return (vehicle?.chargingSessions?.edges || []).map(e => e.node).filter(Boolean);
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
    // TEMPORARY diagnostic — "Show more" reported as not working, but
    // "nothing in diagnostics" turned out to be a bug in this diagnostic
    // itself, not evidence the click wasn't registering: logDebug() only
    // pushes to the debugNotes array, it doesn't redraw the visible
    // Diagnostics panel — same documented pattern already known elsewhere
    // in this codebase (see the on-demand-action comment near
    // renderDiagnostics() calls). Without an explicit renderDiagnostics()
    // call here, this log was very likely firing correctly the whole
    // time and just invisible until the next scheduled sync happened to
    // redraw the panel minutes later. Added here so the click's own
    // result shows immediately. Remove this whole diagnostic once
    // resolved.
    logDebug('EV show-more diagnostic', `nextDays=${nextDays}, sessions returned=${sessions.length}`);
    renderDiagnostics();
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
                  dispatches { start end type energyAddedKwh }
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

    // Limit marker — only shown when Octopus reports a real upper bound.
    // The striped "restricted" zone beyond it naturally disappears once
    // the fill genuinely exceeds the limit, since you're now visibly past
    // the boundary — the warning line above explains why, this just shows
    // where the line was.
    const limit = vehicle.status?.stateOfChargeLimit?.upperSocLimit;
    if (limit != null) {
      const limitPct = Math.min(100, Math.max(0, limit));
      $('ev-battery-limit').classList.remove('hidden');
      $('ev-battery-limit').style.left = `${limitPct}%`;
      if (limitPct > pct) {
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

  // Target SoC/time — actual model is a list of per-day schedule entries
  // (SmartFlexDeviceSchedule: dayOfWeek/time/max/min/upperLimit), not the
  // flat weekday/weekend pair originally assumed from an unrelated,
  // deprecated type. Matches today's day-of-week against the list; DayOfWeek
  // enum values are assumed to be standard uppercase day names (unconfirmed
  // directly, but this is client-side matching after a successful fetch —
  // a wrong guess here just shows no target text, it can't break the query
  // the way a wrong GraphQL field/fragment guess would).
  const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const schedules = vehicle.preferences?.schedules || [];

  const todaySchedule = schedules.find(s => s.dayOfWeek === dayNames[now.getDay()]);
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
    const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), th, tm);
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

  // Dispatch-window view — derived from each session's nested dispatches,
  // flattened and sorted oldest-first (same chronological-timeline
  // convention as before), now with a real SMART/BOOST badge per window.
  const allDispatches = [];
  sessions.forEach(s => (s.dispatches || []).forEach(d => allDispatches.push(d)));
  allDispatches.sort((a, b) => new Date(a.start) - new Date(b.start));

  const dispatchSlots = $('ev-slots-dispatch');
  dispatchSlots.classList.remove('hidden'); // rebuilt below, visibility corrected against evViewMode after render
  dispatchSlots.innerHTML = allDispatches.map(d =>
    `<div class="slot done"><span>✓ ${fmtT(d.start)} – ${fmtT(d.end)}${badgeHtml(d.type)}</span><b>Completed · ${Math.abs(d.energyAddedKwh || 0).toFixed(1)} kWh</b></div>`
  ).join('');
  planned.forEach(d => {
    const isActive = now >= new Date(d.start) && now < new Date(d.end);
    // v2.150: swapped the static "●" character for the same pulsating dot
    // already used in the live usage view, in pink to match this panel's
    // electricity-adjacent identity.
    const label = isActive ? '<span class="live-dot pink"></span>Dispatching now' : 'Planned';
    const cls = isActive ? ' active' : ' scheduled';
    dispatchSlots.insertAdjacentHTML('beforeend', `<div class="slot${cls}"><span>${fmtT(d.start)} – ${fmtT(d.end)}</span><b>${label}</b></div>`);
  });
  if (!dispatchSlots.children.length) dispatchSlots.innerHTML = '<div class="slot">No dispatch windows scheduled</div>';

  // Session view — whole charging sessions, oldest-first to match, each
  // with its own real kWh and battery % reached, plus type badge. Battery
  // gained per session chains consecutive sessions (this session's start %
  // ≈ the previous session's end %) — an assumption that only breaks if
  // charging happened elsewhere in between (e.g. a public charger), in
  // which case the delta is just slightly off, not broken.
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
    lessBtn.innerHTML = '<span>Show less</span>';
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

  // This session — real per-session kWh. Cost was removed: Octopus's
  // SmartFlex API confirmed via diagnostics to return cost:null for every
  // session tested (not zero, not a query mistake), so showing "£0.00"
  // would misleadingly read as free rather than "unavailable". Matches
  // the original EV panel's decision from early in the project, made for
  // the same reason via the older dispatch API.
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todaysSessions = sessions.filter(s => new Date(s.start) >= startOfToday);
  const sessionKwh = todaysSessions.reduce((sum, s) => sum + Math.abs(s.energyAdded?.value || 0), 0);
  $('ev-added').textContent = `${sessionKwh.toFixed(1)} kWh`;

  // v2.154: estimated range added, inline with the kWh figure. Real cost
  // was ruled out (see above), but range is a straightforward unit
  // conversion using getEvRangeMiPerKwh() (v2.191: Settings-configurable
  // per vehicle, was a single hardcoded Polestar 2 constant) — no
  // rate-matching involved, so none of the reasons cost was dropped apply
  // here. Only shown once there's something to show; kept out of the DOM
  // rather than showing "0 mi" for a genuinely empty day.
  const rangeEl = $('ev-added-range');
  if (rangeEl) {
    rangeEl.textContent = sessionKwh > 0 ? `≈ ${Math.round(sessionKwh * getEvRangeMiPerKwh())} mi (est.)` : '';
  }

  // v2.154: estimated cost, third mini box. Real per-dispatch rate can't
  // be matched (confirmed dead end — see EV cost investigation notes), so
  // this uses a simple type-based assumption instead: Smart sessions are
  // priced at today's known off-peak rate, Boost sessions at today's known
  // standard rate, since Boost charging happens outside the smart dispatch
  // schedule. Deliberately approximate and labeled as such — same honesty
  // convention as every other estimate in this app. Hidden entirely if
  // today's rates haven't loaded yet, rather than guessing with stale or
  // absent figures.
  const costBox = $('ev-cost-box');
  if (costBox) {
    if (todaysSessions.length && cachedOffPeakRateP != null && cachedStandardRateP != null) {
      const estCostP = todaysSessions.reduce((sum, s) => {
        const kwh = Math.abs(s.energyAdded?.value || 0);
        const rateP = s.type === 'BOOST' ? cachedStandardRateP : cachedOffPeakRateP;
        return sum + kwh * rateP;
      }, 0);
      costBox.classList.remove('hidden');
      $('ev-cost').textContent = fmtGBP(estCostP / 100);
    } else {
      costBox.classList.add('hidden');
    }
  }

  // Second box: charging power while actually charging (immediately useful
  // in that moment), sessions-today count otherwise (a plain, always-
  // reliable metric — unlike cost, which turned out to be consistently
  // null — that also tells you something real: one long overnight charge
  // vs several short top-ups).
  const power = vehicle.chargePointPowerOutput;
  if (activeDispatch && power != null) {
    $('ev-power-box').classList.remove('hidden');
    $('ev-sessions-box').classList.add('hidden');
    $('ev-power').textContent = `${(+power).toFixed(1)} kW`;
  } else {
    $('ev-power-box').classList.add('hidden');
    $('ev-sessions-box').classList.remove('hidden');
    $('ev-sessions-count').textContent = `${todaysSessions.length}`;
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
  const max = Math.max(...buckets.map(b => b.smart + b.boost), 0.01);
  const maxBarHeight = 44;
  const isDense = buckets.length > 10; // affects bar spacing AND label frequency once dense — Month's ~28-31 bars overflow a mobile-width chart if every label shows (confirmed live), so only every 5th is shown once dense
  $('ev-week').classList.toggle('dense', isDense);
  $('ev-week').innerHTML = buckets.map((b, i) => {
    const total = b.smart + b.boost;
    const h = Math.max(2, Math.round((total / max) * maxBarHeight));
    const smartH = total > 0 ? Math.round((b.smart / total) * h) : 0;
    const boostH = total > 0 ? h - smartH : 0;
    const neutralH = total > 0 ? 0 : h; // no sessions at all in this bucket — a plain neutral floor, not a false Boost claim
    // Same fix as Usage's own Month view (same root cause, same day)
    // — the <span> must always render even when empty. Omitting the
    // element entirely for unlabeled bars made those columns one child
    // shorter, and since columns bottom-align via flex, that pushed their
    // bars down relative to labeled columns by roughly the label's height.
    const showThisLabel = !isDense || i % 5 === 0;
    return `<div class="ev-week-col">
      <div class="ev-week-stack" data-i="${i}" style="height:${h}px">
        ${boostH ? `<div class="ev-week-seg boost" style="height:${boostH}px"></div>` : ''}
        ${smartH ? `<div class="ev-week-seg smart" style="height:${smartH}px"></div>` : ''}
        ${neutralH ? `<div class="ev-week-seg neutral" style="height:${neutralH}px"></div>` : ''}
      </div>
      <span data-i="${i}">${showThisLabel ? labels[i] : '&nbsp;'}</span>
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
}

// Day — hourly buckets, built from sessions directly (same source Week
// uses via energyAdded.value), not from each session's nested dispatches
// array. v2.150 fix: the original version bucketed purely off `dispatches`,
// which is empty for Boost-type manual charges (only Smart/scheduled
// dispatches appear to generate dispatch records) — so a day charged only
// via Boost showed real data in Week (session-level) but nothing at all in
// Day (dispatch-level). Falls back to dispatches only when present, for
// slightly finer within-session detail on Smart charging days; a session
// with no dispatches is bucketed as one lump at its own start hour instead
// of silently vanishing. Reuses evLoadedSessions (the same rolling window
// already fetched for the live card) — today is always within that
// window, so no new fetch at all.
function buildEVDayBuckets(sessions, now) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday.getTime() + 86400000);
  const buckets = Array.from({ length: 24 }, () => ({ smart: 0, boost: 0, sessions: [] }));
  const dates = Array.from({ length: 24 }, (_, h) => new Date(startOfToday.getTime() + h * 3600000));
  sessions.forEach(s => {
    const todaysDispatches = (s.dispatches || []).filter(d => {
      const start = new Date(d.start);
      return start >= startOfToday && start < startOfTomorrow;
    });
    if (todaysDispatches.length) {
      todaysDispatches.forEach(d => {
        const hour = new Date(d.start).getHours();
        const kwh = Math.abs(d.energyAddedKwh || 0);
        if (d.type === 'BOOST') buckets[hour].boost += kwh; else buckets[hour].smart += kwh;
        buckets[hour].sessions.push(s);
      });
      return;
    }
    // No dispatch records for this session (Boost charges typically have
    // none) — fall back to the session itself, bucketed at its start hour
    // using its own total kWh, same as Week/Month already do.
    const sessionStart = new Date(s.start);
    if (sessionStart < startOfToday || sessionStart >= startOfTomorrow) return;
    const hour = sessionStart.getHours();
    const kwh = Math.abs(s.energyAdded?.value || 0);
    if (s.type === 'BOOST') buckets[hour].boost += kwh; else buckets[hour].smart += kwh;
    buckets[hour].sessions.push(s);
  });
  const labels = dates.map(d => `${d.getHours()}`);
  return { buckets, labels, dates, dateFormat: 'hour' };
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
  } else if (period === 'day') {
    $('ev-history-period-label').textContent = 'Today';
    result = buildEVDayBuckets(evLoadedSessions || [], now);
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
    $('ev-ready').textContent = '23:30 – 05:30';
    $('ev-added').textContent = '9.6 kWh';
    $('ev-battery-row').classList.add('hidden');
    $('ev-schedule-preview').classList.add('hidden');
    $('ev-warnings').classList.add('hidden');
    $('ev-power-box').classList.add('hidden');
    $('ev-sessions-box').classList.remove('hidden');
    $('ev-sessions-count').textContent = '2';
    $('ev-view-toggle').classList.add('hidden');
    $('ev-week-legend').classList.remove('hidden');
    $('ev-slots-dispatch').classList.remove('hidden');
    $('ev-slots-dispatch').innerHTML = `
      <div class="slot done"><span>✓ 00:30 – 04:00</span><b>Completed · 22.1 kWh</b></div>
      <div class="slot active"><span>● 04:00 – 05:30</span><b>Dispatching now · 7.4kW</b></div>
      <div class="slot"><span>Planned tonight</span><b>23:30 – 05:30</b></div>`;
    renderWeekBars('ev-week', [3.0, 2.2, 4.8, 0.1, 3.6, 2.6, 4.4], '', v => `${v.toFixed(1)} kWh`, 44, 'ev-week-scale');
    $('ev-history-period-label').textContent = 'This week';
    $('ev-week-kwh-total').textContent = '62.4 kWh';
    $('ev-week-session-count').textContent = '9';
    $('insights-ev-panel').classList.add('hidden');
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
        // v2.167: same UTC-vs-local date-boundary bug as loadRates() above
        // (see that fix's comment for the full explanation) — was using
        // isoDate(now) with a literal Z, which silently resolves to
        // yesterday's date for roughly an hour each night during BST.
        const dayStart1 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dayEnd1 = new Date(+dayStart1 + 24 * 60 * 60 * 1000 - 60000);
        const gasRatesToday = await fetchGasRates(dayStart1.toISOString(), dayEnd1.toISOString());
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

        // Usage (kWh + sub-period) fetched separately, on its own risk.
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

  // --- Octopoints: archived v2.150, deactivated pending Octopus forum ---
  // Live testing returned Unauthorized (KT-CT-1111) — most likely an
  // account reader-permission gap rather than a code bug (a lead worth
  // checking: the JWT may carry the account's permission scopes directly).
  // Deactivated here to stop spending API calls on a feature that isn't
  // working, without deleting it — the full working implementation
  // (queries, ledger rendering, capping/sorting) is preserved in full in
  // octopoints-archive.js, a new file alongside this release, kept
  // separate from the pre-existing ev-legacy-archive.js since it's an
  // unrelated feature. Reinstate by moving this block back in and
  // un-hiding #octo-block once permissions are confirmed.
  $('octo-block').classList.add('hidden');

  return anyLive;
}

async function lastNDaysCost(fuel, n, anchor = new Date()) {
  const creds = store.creds;
  const isElec = fuel === 'elec';
  const mp = isElec ? creds.elecMpan : creds.gasMprn;
  const serial = isElec ? creds.elecSerial : creds.gasSerial;
  const now = anchor;
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

// Same trick as monthElecSplit above — compute the (n, anchor) pair for the
// whole calendar month containing monthAnchor (capped at today for the
// current month), delegate to the already-anchor-generalized lastNDaysCost.
async function monthFuelSplit(fuel, monthAnchor) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monthStart = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1);
  if (monthStart > today) return [];
  const lastDayOfMonth = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0);
  const isCurrentMonth = monthAnchor.getFullYear() === today.getFullYear() && monthAnchor.getMonth() === today.getMonth();
  const effectiveLastDay = isCurrentMonth ? today : (lastDayOfMonth > today ? today : lastDayOfMonth);
  const n = Math.round((+effectiveLastDay - +monthStart) / 86400000) + 1;
  return lastNDaysCost(fuel, n, effectiveLastDay);
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
  const evModelInput = $('input-ev-model').value.trim().slice(0, 30);
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
  krakenToken = null;
  krakenAccountUserId = null;

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
  // Usage bars/MTD, bills, standing charges, balance/DD — everything
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
  $('ev-history-period-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.unit-toggle-btn');
    if (!btn || btn.dataset.period === evHistoryPeriod) return;
    setEVHistoryPeriod(btn.dataset.period);
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
      closeDatePicker();
      if (pickedDate && periodMode !== 'year') {
        await loadPickedPeriodData();
      } else if (periodMode === 'month') {
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
      updateDatePickerUI();
      renderFuelPanel('elec');
      renderFuelPanel('gas');
    });
  });

  // Date picker: calendar button opens/closes the panel; month nav browses
  // without changing the pick; tapping a day picks it and closes the panel;
  // reset/jump-to-today both clear the pick and fall back to the normal
  // today-anchored view everywhere else in the app already uses.
  $('date-picker-btn').addEventListener('click', () => {
    if (pickerOpen) closeDatePicker(); else openDatePicker();
  });

  $('picker-prev-month').addEventListener('click', () => {
    pickerViewMonth = new Date(pickerViewMonth.getFullYear(), pickerViewMonth.getMonth() - 1, 1);
    renderPickerCalendar();
  });
  $('picker-next-month').addEventListener('click', () => {
    if ($('picker-next-month').classList.contains('disabled')) return;
    pickerViewMonth = new Date(pickerViewMonth.getFullYear(), pickerViewMonth.getMonth() + 1, 1);
    renderPickerCalendar();
  });

  $('picker-grid').addEventListener('click', async (e) => {
    const cell = e.target.closest('.picker-day[data-date]');
    if (!cell || cell.classList.contains('future')) return;
    const [y, m, d] = cell.dataset.date.split('-').map(Number);
    pickedDate = new Date(y, m - 1, d);
    selectedDay.elec = null;
    selectedDay.gas = null;
    selectedDaySlot.elec = null;
    closeDatePicker();
    updateDatePickerUI();
    await loadPickedPeriodData();
    renderFuelPanel('elec');
    renderFuelPanel('gas');
  });

  async function resetToToday() {
    pickedDate = null;
    selectedDay.elec = null;
    selectedDay.gas = null;
    selectedDaySlot.elec = null;
    closeDatePicker();
    updateDatePickerUI();
    renderFuelPanel('elec');
    renderFuelPanel('gas');
  }
  $('date-picker-reset').addEventListener('click', resetToToday);
  $('picker-jump-today').addEventListener('click', resetToToday);

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
