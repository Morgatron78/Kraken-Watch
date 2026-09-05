import { store } from './store.js';
import { octRest } from './api.js';
import { logIssue, logDebug } from './diagnostics.js';

// Shared helpers so the rate curve, billing, EV and consumption cards all use
// the same underlying rate/consumption data instead of each re-fetching it.

const rateCache = {}; // key: `${tariffCode}_${fromISO}_${toISO}` -> [{from,to,rate}]
// Not evicted by key — the whole thing is wiped once a day
// (clearRateCacheIfNewDay, called from loadFastTier). Without that, a PWA
// left open for days accumulates ~20-30 new entries per day indefinitely.
let rateCacheDay = new Date().toDateString();
export function clearRateCacheIfNewDay() {
  const today = new Date().toDateString();
  if (today !== rateCacheDay) {
    for (const key in rateCache) delete rateCache[key];
    rateCacheDay = today;
  }
}

// Cached today's-rate figures, read and written from across the app
// (loadRates, loadLiveUsage, loadBilling, the EV/insights renderers). One
// exported object rather than individual `let`s so any importer can mutate a
// property directly without a setter per figure.
export const rateState = {
  offPeakRateP: null, // cheapest electricity rate seen today — Live Usage's £/hr fallback when the current rate hasn't loaded
  currentRateP: null, // right-now electricity rate — the live-usage £/hr estimate
  standardRateP: null, // most expensive electricity rate seen today — Boost sessions charge outside the smart schedule, so assumed at standard rate
  elecStandingP: null,
  gasStandingP: null,
  // Today's live gas unit rate, from the same fetch that fills #gas-unit-rate
  // — kept here so computeBalanceForecast can use it instead of MTD-derived
  // consumption (see the fix there for why).
  gasRateP: null,
};

// Prices a session at TODAY's off-peak/standard rate regardless of its age —
// a deliberate simplification (the user's electricity tariff is fixed for
// 12-month periods, so a real per-session historical-rate fetch would only
// matter at a renewal boundary). Returns null, not a guess, if today's rates
// haven't loaded. `rates` defaults to the cached figures; the argument
// exists so this is testable without touching the module cache.
export function estimateSessionCostP(session, rates = { offPeakP: rateState.offPeakRateP, standardP: rateState.standardRateP }) {
  const { offPeakP, standardP } = rates;
  if (offPeakP == null || standardP == null) return null;
  const kwh = Math.abs(session.energyAdded?.value || 0);
  const rateP = session.type === 'BOOST' ? standardP : offPeakP;
  return kwh * rateP;
}

// Rate queries look back further than the range being priced. A tight 24h
// window (the 7-day bars) sometimes doesn't span back to the row whose
// valid_from covers the day — gas has only a couple of rate changes a month
// — leaving every reading that day unmatched and priced at £0. Buffering
// period_from gives every query that margin without changing the priced range.
const RATE_LOOKBACK_DAYS = 45;
function bufferedRateFrom(fromISO) {
  const d = new Date(fromISO);
  d.setDate(d.getDate() - RATE_LOOKBACK_DAYS);
  return d.toISOString();
}

export async function fetchElecRates(fromISO, toISO) {
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

export async function fetchGasRates(fromISO, toISO) {
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

export async function fetchStandingCharge(fuel) {
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
    // Log the real reason before falling back to null — otherwise a 401 or
    // network error is indistinguishable from the legitimate "no gas tariff
    // on file" case above, which also returns null. Callers still handle a
    // missing standing charge gracefully either way.
    logIssue(`${fuel === 'elec' ? 'Electricity' : 'Gas'} standing charge`, err);
    return null;
  }
}

export function rateAt(rows, timestamp) {
  // Most recent rate period that started at or before this timestamp (rows
  // sorted ascending by `from`). More robust than an exact `to` boundary
  // match, which silently fell back to rows[0] — often the cheapest rate —
  // whenever a boundary didn't line up, mispricing standard usage as
  // off-peak. Returns null only if the timestamp precedes every rate period.
  let match = null;
  for (const r of rows) {
    if (r.from <= timestamp) match = r;
    else break;
  }
  return match ? match.rate : null;
}

// Calorific value drifts slightly over time and Octopus states the exact
// figure used on each bill — configurable in Settings → Advanced, defaulting
// to 40.0 (a typical current UK value) rather than an older hardcoded figure.
function gasCalorificValue() {
  return store.creds?.calorificValue || 40.0;
}

// Gas smart meters usually report m3, not kWh — this applies the standard
// industry conversion (volume correction 1.02264 × calorific value ÷ 3.6).
// See detectGasUnit below for how callers decide whether a given batch of
// readings actually needs this at all.

export function m3ToKwh(m3) {
  return m3 * 1.02264 * gasCalorificValue() / 3.6;
}

// Octopus's REST consumption endpoint carries no unit field (a row is just
// {consumption, interval_start, interval_end}), so m3 vs kWh is a magnitude
// heuristic. Decided once per whole same-granularity batch — deciding it
// per-reading off the first reading let one anomalous value flip the
// conversion for the rest of the batch. The threshold values (50, 500) are
// kept as-is, validated against this account's own history.
//
// Gas readings from this meter are daily totals, not half-hourly — a day's
// gas use is a few m3 at most, while a month's aggregate (fetchYearMonthly's
// group_by=month) reaches hundreds of m3 for a large house in winter, hence
// the very different cutoffs.
export const GAS_M3_THRESHOLD_DAILY = 50;
export const GAS_M3_THRESHOLD_MONTHLY = 500;
export function detectGasUnit(values, threshold) {
  const nums = values.filter(v => Number.isFinite(v));
  if (!nums.length) return 'KILOWATT_HOUR';
  return Math.max(...nums) < threshold ? 'CUBIC_METERS' : 'KILOWATT_HOUR';
}

export async function costForRange(fuel, fromISO, toISO, debugLabel) {
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

  const gasUnit = !isElec ? detectGasUnit((consData.results || []).map(r => r.consumption), GAS_M3_THRESHOLD_DAILY) : null;
  let kwh = 0, costPence = 0, missed = 0;
  for (const r of (consData.results || [])) {
    let consumption = r.consumption;
    if (gasUnit === 'CUBIC_METERS') consumption = m3ToKwh(consumption);
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
    const unitNote = gasUnit ? `, detected ${gasUnit === 'CUBIC_METERS' ? 'm³' : 'kWh'}` : '';
    logDebug(debugLabel, `${readingCount} reading(s)${unitNote}, ${rates.length} rate period(s) (${minR}p–${maxR}p), ${kwh.toFixed(2)} kWh total, ${missed} unmatched`);
  }
  if (missed > 0) {
    logIssue(`${fuel === 'elec' ? 'Electricity' : 'Gas'} rate lookup`,
      new Error(`${missed}/${(consData.results || []).length} reading(s) had no matching rate period and were excluded from the cost total`));
  }
  // hasData distinguishes "genuinely used this much" from "no readings yet".
  // Consumption data lags 24-48h, so recent windows often have no rows; and
  // a placeholder can land with rows present but kwh exactly zero before the
  // real figure settles (seen on gas). A genuine zero-usage day (holiday) is
  // rare enough that treating 0 kWh as "not settled" is the safer default —
  // it just shows as pending briefly, self-correcting once a later day's
  // data supersedes it as "latest".
  const hasData = (consData.results || []).length > 0 && kwh > 0.001;
  return { kwh, cost: costPence / 100, hasData };
}

// Splits half-hourly readings into n local-calendar-day buckets, oldest
// first. A reading belongs to the day its interval_start falls in, in local
// time (not UTC), matching how day boundaries are computed everywhere else.
export function bucketReadingsByDay(results, n, now = new Date()) {
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
