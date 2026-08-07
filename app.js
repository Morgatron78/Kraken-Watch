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
const APP_VERSION = 'v58';
// Public half of a VAPID key pair generated for this deployment — safe to be
// public, it's how the browser verifies a push actually came from our EV
// checker. The private half lives only in a GitHub Actions secret, never here.
const VAPID_PUBLIC_KEY = 'BHGWakjQv2_jirzApA8FrA1S1Zp6PVXB29Qy1KHtbVPwKYH1Hzh5oFqiuxIDByEFIQpiJvTVrb7s0Y1_vUs-yt8';

const store = {
  get creds() {
    try { return JSON.parse(localStorage.getItem('kw_creds') || 'null'); }
    catch { return null; }
  },
  set creds(v) { localStorage.setItem('kw_creds', JSON.stringify(v)); },
  clear() { localStorage.removeItem('kw_creds'); }
};

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

async function octRest(path) {
  const { apiKey } = store.creds || {};
  const res = await fetch(`${REST_BASE}${path}`, {
    headers: { Authorization: 'Basic ' + btoa(`${apiKey}:`) }
  });
  if (!res.ok) throw new Error(`REST ${path} → ${res.status}`);
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

/* ------------------------- Rates & cost calculation ----------------------- */
// Shared helpers so the rate curve, billing, EV and consumption cards all use
// the same underlying rate/consumption data instead of each re-fetching it.

const rateCache = {}; // key: `${tariffCode}_${fromISO}_${toISO}` -> [{from,to,rate}]
let cachedOffPeakRateP = null; // cheapest electricity rate seen today — used as the EV dispatch rate approximation
let cachedCurrentRateP = null; // right-now electricity rate — used for the live-usage £/hr estimate
let cachedElecStandingP = null;
let cachedGasStandingP = null;

async function fetchElecRates(fromISO, toISO) {
  const { elecProductCode, elecTariffCode } = store.creds;
  const key = `elec_${elecTariffCode}_${fromISO}_${toISO}`;
  if (rateCache[key]) return rateCache[key];
  const data = await octRest(`/products/${elecProductCode}/electricity-tariffs/${elecTariffCode}/standard-unit-rates/?period_from=${fromISO}&period_to=${toISO}&page_size=1500`);
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
  const data = await octRest(`/products/${gasProductCode}/gas-tariffs/${gasTariffCode}/standard-unit-rates/?period_from=${fromISO}&period_to=${toISO}&page_size=1500`);
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
  } catch { return null; }
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
      consumption = consumption * 1.02264 * 39.5 / 3.6;
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
  // hasData distinguishes "genuinely used 0 kWh" from "no readings back yet" —
  // smart meter consumption data usually lags 24-48h behind real time, so
  // very recent windows (today, sometimes yesterday) often have no rows at all.
  const hasData = (consData.results || []).length > 0;
  return { kwh, cost: costPence / 100, hasData };
}

function daysElapsedInMonth(now = new Date()) {
  return now.getDate();
}
function daysInMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}
function isoDate(d) { return d.toISOString().slice(0, 10); }

// Electricity-only: splits a range's cost/kWh into off-peak vs standard/peak,
// using the same "near the day's cheapest rate" threshold the rate curve
// uses elsewhere. Gas doesn't need this — Flexible Octopus is a flat rate
// all day, so there's nothing to split there.
async function elecCostSplit(fromISO, toISO) {
  const { elecMpan, elecSerial } = store.creds;
  if (!elecMpan || !elecSerial) throw new Error('No elec meter point on file');
  const consPath = `/electricity-meter-points/${elecMpan}/meters/${elecSerial}/consumption/?period_from=${fromISO}&period_to=${toISO}&page_size=1500`;
  const [consData, rates] = await Promise.all([octRest(consPath), fetchElecRates(fromISO, toISO)]);
  if (!rates.length) throw new Error('No elec rate data');

  const threshold = Math.min(...rates.map(r => r.rate)) + 1;
  let offPeakKwh = 0, offPeakCostP = 0, peakKwh = 0, peakCostP = 0;
  for (const r of (consData.results || [])) {
    const rate = rateAt(rates, +new Date(r.interval_start));
    if (rate === null) continue;
    if (rate <= threshold) { offPeakKwh += r.consumption; offPeakCostP += r.consumption * rate; }
    else { peakKwh += r.consumption; peakCostP += r.consumption * rate; }
  }
  return {
    offPeakKwh, peakKwh,
    offPeakCost: offPeakCostP / 100, peakCost: peakCostP / 100,
    hasData: (consData.results || []).length > 0
  };
}

async function lastNDaysElecSplit(n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    try {
      out.push(await elecCostSplit(dayStart.toISOString(), dayEnd.toISOString()));
    } catch { out.push({ offPeakKwh: 0, peakKwh: 0, offPeakCost: 0, peakCost: 0, hasData: false }); }
  }
  return out;
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
let fuelUnit = { elec: 'cost', gas: 'cost' };
function logDebug(label, msg) {
  console.info(`${label} debug:`, msg);
  debugNotes.push(`${label}: ${msg}`);
}
const demoFallbackEnabled = () => store.creds?.useDemoFallback === true;

function renderDiagnostics() {
  const card = $('diagnostics-card');
  const showDiagnostics = store.creds?.showDiagnostics !== false; // default on
  if (!showDiagnostics || (!syncIssues.length && !debugNotes.length)) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  $('diagnostics-title').textContent = syncIssues.length ? '⚠ Diagnostics' : 'ℹ Diagnostics (debug info)';
  $('diagnostics-title').style.color = syncIssues.length ? 'var(--coral)' : 'var(--text-dim)';
  const lines = [
    ...syncIssues.map(m => `⚠ ${m}`),
    ...debugNotes.map(m => `ℹ ${m}`)
  ];
  $('diagnostics-list').innerHTML = lines.join('<br>');
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
  const max = Math.max(...values, 0.01);
  renderChartScale(scaleId, max, formatter);
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = new Date().getDay();
  const showLabels = values.length <= 10; // month view (~28-31 bars) would overlap if labelled per-bar
  el.classList.toggle('dense', !showLabels);
  el.innerHTML = values.map((v, i) => {
    const isToday = i === values.length - 1;
    const h = Math.max(2, Math.round((v / max) * maxBarHeight));
    const label = showLabels ? `<span>${labels[(today - (values.length - 1 - i) + 7) % 7]}</span>` : '';
    return `<div class="week-bar"><div class="col ${colorClass}${isToday ? ' today' : ''}" style="height:${h}px" title="${formatter ? formatter(v) : v}"></div>${label}</div>`;
  }).join('');
}

const fmtKwh = (v) => `${v.toFixed(1)} kWh`;

// Stacked variant: each day is [{value, cssClass}, ...] segments stacked
// bottom-to-top (e.g. standing charge, then off-peak, then peak). Segment
// order in the array is bottom-to-top.
function renderStackedBars(containerId, dayStacks, formatter, maxBarHeight = 44, scaleId = null, selectedIndex = null) {
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
    const label = showLabels ? `<span class="${isSelected ? 'active-day' : ''}">${labels[(today - (dayStacks.length - 1 - i) + 7) % 7]}</span>` : '';
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
    renderStackedBars(`${fuel}-week`, dayStacks, fmt, 58, `${fuel}-week-scale`, selectedDay[fuel]);
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
  const barColor = fuel === 'elec' ? 'var(--violet)' : 'var(--amber)';
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
    if (!isElec && results[0]?.consumption < 500) kwh = kwh * 1.02264 * 39.5 / 3.6; // m3 → kWh, same heuristic as costForRange
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
    $('rate-value').style.color = isCheap ? 'var(--mint)' : 'var(--amber)';
    $('rate-pill').className = 'card-tag ' + (isCheap ? 'tag-mint' : 'tag-amber');
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
    return false;
  }
  $('live-unavailable').classList.add('hidden');
  $('live-body').style.display = '';

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
  $('ev-chevron').textContent = expanded ? '▾' : '▸';
  $('ev-header').setAttribute('aria-expanded', String(expanded));
}

async function loadEV() {
  try {
    const data = await krakenGQL(`
      query IOGStatus($accountNumber: String!) {
        completedDispatches(accountNumber: $accountNumber) { start end delta }
        plannedDispatches(accountNumber: $accountNumber) { start end delta }
      }`, { accountNumber: store.creds.accountNumber });

    const planned = data.plannedDispatches || [];
    const completed = data.completedDispatches || [];
    const now = new Date();
    // "Charging" means a dispatch window is actually in progress right now —
    // not just that one exists somewhere in the planned list. A window hours
    // in the future is upcoming, not active.
    const activeDispatch = planned.find(d => now >= new Date(d.start) && now < new Date(d.end));
    $('ev-tag').textContent = activeDispatch ? 'CHARGING' : (planned.length ? 'SCHEDULED' : 'IDLE');
    if (activeDispatch) $('ev-tag').className = 'card-tag tag-mint';
    else if (planned.length) $('ev-tag').className = 'card-tag tag-amber';
    else $('ev-tag').className = 'card-tag tag-dim';

    applyEvCollapse(!!activeDispatch || planned.length > 0);

    // "Next dispatch window" is the start–end of the next scheduled off-peak
    // charge slot Octopus has planned — not a "ready by" estimate, since the
    // API doesn't expose vehicle state of charge or a true completion time.
    if (planned[0]) {
      const s = new Date(planned[0].start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const e = new Date(planned[0].end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('ev-ready').textContent = `${s} – ${e}`;
    } else {
      $('ev-ready').textContent = 'None scheduled';
    }

    const slots = $('ev-slots');
    slots.innerHTML = '';
    completed.slice(0, 2).forEach(d => {
      slots.insertAdjacentHTML('beforeend', `<div class="slot done"><span>✓ ${new Date(d.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(d.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><b>Completed · ${(+d.delta).toFixed(1)} kWh</b></div>`);
    });
    planned.slice(0, 2).forEach(d => {
      const isActive = now >= new Date(d.start) && now < new Date(d.end);
      const label = isActive ? '● Dispatching now' : 'Planned';
      const cls = isActive ? ' active' : ' scheduled';
      slots.insertAdjacentHTML('beforeend', `<div class="slot${cls}"><span>${new Date(d.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(d.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><b>${label}</b></div>`);
    });
    if (!slots.children.length) slots.innerHTML = '<div class="slot">No dispatch windows scheduled</div>';

    // Session/weekly totals: dispatches already report kWh added (delta) — the
    // rate applied is approximated as today's cheapest electricity rate, since
    // IOG dispatches always land in the off-peak window. It's an approximation,
    // not the exact rate that was live at each dispatch's own start time.
    // Delta is shown exactly as Octopus returns it, including if it's
    // occasionally negative for a short dispatch — that's real data from their
    // API, not a display error, so it isn't clamped or hidden here.
    const rateP = cachedOffPeakRateP ?? 7.5;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todaysCompleted = completed.filter(d => new Date(d.start) >= startOfToday);
    const sessionKwh = todaysCompleted.reduce((s, d) => s + (+d.delta), 0);
    $('ev-added').textContent = `${sessionKwh.toFixed(1)} kWh`;
    $('ev-cost').textContent = fmtGBP(sessionKwh * rateP / 100);
    $('ev-avg-rate').textContent = `${rateP.toFixed(1)}p/kWh`;

    const dayTotals = Array(7).fill(0);
    const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - 6);
    completed.forEach(d => {
      const dayIdx = Math.floor((new Date(d.start) - startOfWeek) / 86400000);
      if (dayIdx >= 0 && dayIdx < 7) dayTotals[dayIdx] += (+d.delta);
    });
    renderWeekBars('ev-week', dayTotals, '', v => `${v.toFixed(1)} kWh`);
    const weekKwh = dayTotals.reduce((a, b) => a + b, 0);
    $('ev-week-totals').innerHTML = `<span>${weekKwh.toFixed(1)} kWh added</span><span>${fmtGBP(weekKwh * rateP / 100)} total</span><span>${rateP.toFixed(1)}p avg</span>`;

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
      $('ev-slots').innerHTML = '<div class="slot">Unavailable right now</div>';
      renderWeekBars('ev-week', [0, 0, 0, 0, 0, 0, 0], '');
      $('ev-week-totals').innerHTML = '<span>—</span><span>—</span><span>—</span>';
    }
    return false;
  }
}

function populateDemoEV() {
    applyEvCollapse(true);
    $('ev-tag').textContent = 'DEMO DATA';
    $('ev-ready').textContent = '23:30 – 05:30';
    $('ev-added').textContent = '9.6 kWh';
    $('ev-cost').textContent = '£0.72';
    $('ev-avg-rate').textContent = '7.5p/kWh';
    $('ev-slots').innerHTML = `
      <div class="slot done"><span>✓ 00:30 – 04:00</span><b>Completed · 22.1 kWh</b></div>
      <div class="slot active"><span>● 04:00 – 05:30</span><b>Dispatching now · 7.4kW</b></div>
      <div class="slot"><span>Planned tonight</span><b>23:30 – 05:30</b></div>`;
    renderWeekBars('ev-week', [3.0, 2.2, 4.8, 0.1, 3.6, 2.6, 4.4], '');
    $('ev-week-totals').innerHTML = `<span>62.4 kWh added</span><span>£4.68 total</span><span>7.5p avg</span>`;
}

async function loadBilling() {
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
    fuelData.elec.mtd = { cost: elecMTD, kwh: elec.kwh };
    fuelData.elec.predicted = { cost: elecPredictedCost, kwh: elecPredictedKwh };
    if (elecStanding) $('elec-standing').textContent = `£${(elecStanding / 100).toFixed(2)}/day`;

    if (gasMTD !== null) {
      fuelData.gas = fuelData.gas || {};
      fuelData.gas.mtd = { cost: gasMTD, kwh: gas.kwh };
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
        const dateStr = new Date(nextPayment.paymentDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        $('next-dd-amount').textContent = fmtGBP(nextPayment.amount / 100);
        $('next-dd-due').textContent = nextPayment.isEstimate
          ? `Est. from last payment (${dateStr})`
          : `Due ${dateStr}`;
        $('next-dd-label').textContent = nextPayment.isEstimate ? 'Direct Debit (est.)' : 'Next Direct Debit';
        renderBalanceFigure('balance-after-dd', 'balance-after-dd-pill', afterDD);

        // Trend: is the incoming payment bigger or smaller than what this
        // month's predicted to cost? Positive = balance building (summer),
        // negative = balance drawing down (winter).
        const trend = (nextPayment.amount / 100) - predictedTotal;
        const pill = $('balance-trend-pill');
        pill.className = 'trend-pill ' + (trend >= 0 ? 'up' : 'down');
        pill.textContent = `${trend >= 0 ? '↑' : '↓'} ${fmtGBP(trend)}/mo`;

        $('balance-after-dd-row').style.display = '';
      } else {
        $('balance-after-dd-row').style.display = 'none';
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
      renderFuelPanel('gas');
    } catch (err) { logIssue('Gas daily cost', err); }

    anyLive = true;
  } catch (err) {
    logIssue('Daily cost', err);
  }

  // Last bill: real, via Octopus's documented GraphQL schema (account.bills).
  // The exact billed amount isn't in the publicly documented fields, so this
  // shows the issue date and a link to the PDF instead — still genuinely useful
  // for "when was I last billed" and lets you open the real statement.
  try {
    const data = await krakenGQL(`
      query LastBill($accountNumber: String!) {
        account(accountNumber: $accountNumber) {
          bills(first: 5) {
            edges { node { id issuedDate fromDate toDate temporaryUrl } }
          }
        }
      }`, { accountNumber: store.creds.accountNumber });

    const bills = (data?.account?.bills?.edges || []).map(e => e.node).filter(b => b.issuedDate);
    bills.sort((a, b) => new Date(b.issuedDate) - new Date(a.issuedDate));
    const latest = bills[0];
    if (latest) {
      const issued = new Date(latest.issuedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const link = latest.temporaryUrl ? `<a href="${latest.temporaryUrl}" target="_blank" style="color:var(--mint)">view PDF</a>` : '';
      $('last-bill').innerHTML = `<b>Statement</b> <small>issued ${issued}${link ? ' · ' + link : ''}</small>`;
      anyLive = true;
    }
  } catch (err) {
    logIssue('Last bill', err);
  }

  return anyLive;
}

async function lastNDaysCost(fuel, n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    try {
      const { cost, kwh, hasData } = await costForRange(fuel, dayStart.toISOString(), dayEnd.toISOString());
      out.push({ cost, kwh, hasData });
    } catch { out.push({ cost: 0, kwh: 0, hasData: false }); }
  }
  return out;
}

function populateDemoBilling() {
    renderBalanceFigure('balance-now', 'balance-now-pill', 42.10);
    renderBalanceFigure('balance-projected', 'balance-projected-pill', 35.70);
    $('next-dd-amount').textContent = '£95.00';
    $('next-dd-due').textContent = 'Due 1 Sep (demo)';
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
    $('last-bill').innerHTML = `<b>Statement</b> <small>issued 1 Jul (demo data)</small>`;
}

function clearBillingUnavailable() {
    $('balance-now').textContent = 'Unavailable';
    $('balance-now-pill').textContent = '';
    $('balance-projected').textContent = 'Unavailable';
    $('balance-projected-pill').textContent = '';
    $('next-dd-amount').textContent = '—';
    $('next-dd-due').textContent = '—';
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
    $('last-bill').textContent = 'Unavailable';
}

async function loadAll() {
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
  const allReal = allResults.every(v => v === true);
  const anyReal = allResults.some(v => v === true);
  if (allReal) setSyncStatus('ok', `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  else if (anyReal) setSyncStatus('stale', demoFallbackEnabled() ? 'Partially synced — some demo data' : 'Partially synced — some data unavailable');
  else setSyncStatus('error', demoFallbackEnabled() ? 'Using demo data — check settings' : 'Data unavailable — check settings');
  renderDiagnostics();
}

/* ------------------------------ Settings UI ------------------------------- */

function openSettings() {
  const c = store.creds || {};
  $('input-api-key').value = c.apiKey || '';
  $('input-account').value = c.accountNumber || '';
  $('input-email').value = c.email || '';
  $('input-password').value = c.password || '';
  $('input-elec-mpan').value = c.manualElecMpan || '';
  $('input-elec-serial').value = c.manualElecSerial || '';
  $('input-gas-mprn').value = c.manualGasMprn || '';
  $('input-gas-serial').value = c.manualGasSerial || '';
  if (c.manualElecMpan || c.manualGasMprn) $('advanced-fields').classList.remove('hidden');
  $('input-show-diagnostics').checked = c.showDiagnostics !== false;
  $('input-use-demo-fallback').checked = c.useDemoFallback === true;
  refreshEvPushStatus();
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

/* --------------------------- EV push notifications ------------------------ */

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// State now lives on a separate "state" branch (see ev-notify.yml), not
// main, so Pages never rebuilds from the checker's automated commits.
// Derives the raw-content URL from the page's own GitHub Pages address
// (https://{owner}.github.io/{repo}/) rather than hardcoding a repo name,
// since this project has already been recreated under a new repo once.
function stateFileUrl() {
  try {
    const owner = location.hostname.split('.')[0];
    const repo = location.pathname.split('/').filter(Boolean)[0];
    if (owner && repo) return `https://raw.githubusercontent.com/${owner}/${repo}/state/state/ev-status.json`;
  } catch { /* fall through to relative path below */ }
  return './state/ev-status.json'; // unlikely to have fresh data, but won't crash
}

async function refreshEvPushStatus() {
  const el = $('ev-push-last-check');
  try {
    const res = await fetch(stateFileUrl(), { cache: 'no-store' });
    if (!res.ok) throw new Error('No status file yet');
    const state = await res.json();
    const parts = [];
    if (state.lastChecked) parts.push(`Last checker run: ${new Date(state.lastChecked).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`);
    if (state.lastPushSent) parts.push(`Last push sent: ${new Date(state.lastPushSent).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`);
    if (state.lastPushOk === false) parts.push(`⚠ Last push failed: ${state.lastPushError || 'unknown error'}`);
    if (state.pushSubscriptionExpired) parts.push('⚠ Subscription expired — tap "Enable EV notifications" again');
    el.textContent = parts.length ? parts.join(' · ') : 'Checker hasn\'t run yet — see README to set up the GitHub Actions secrets.';
  } catch {
    el.textContent = 'No status yet — the GitHub Actions checker either hasn\'t run, or isn\'t set up yet (see README).';
  }
}

async function enableEvPush() {
  const statusEl = $('ev-push-status');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = 'Push notifications aren\'t supported in this browser. On iPhone, make sure the app was opened from the Home Screen icon, not a Safari tab.';
    return;
  }
  try {
    statusEl.textContent = 'Requesting permission…';
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      statusEl.textContent = 'Permission not granted — notifications can\'t work without it. You can try again any time.';
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const json = JSON.stringify(subscription.toJSON());
    $('ev-push-subscription').value = json;
    $('ev-push-subscription').classList.remove('hidden');
    statusEl.textContent = 'Subscribed! Copy the text below into a GitHub secret named PUSH_SUBSCRIPTION (repo → Settings → Secrets and variables → Actions) — see the README for the full list of secrets needed.';
  } catch (err) {
    statusEl.textContent = `Couldn't subscribe: ${err.message || err}`;
  }
}

async function saveSettings() {
  const apiKey = $('input-api-key').value.trim();
  const accountNumber = $('input-account').value.trim();
  const email = $('input-email').value.trim();
  const password = $('input-password').value;
  const manualElecMpan = $('input-elec-mpan').value.trim();
  const manualElecSerial = $('input-elec-serial').value.trim();
  const manualGasMprn = $('input-gas-mprn').value.trim();
  const manualGasSerial = $('input-gas-serial').value.trim();
  const showDiagnostics = $('input-show-diagnostics').checked;
  const useDemoFallback = $('input-use-demo-fallback').checked;
  if (!apiKey || !accountNumber) { alert('API key and account number are required.'); return; }

  store.creds = { apiKey, accountNumber, email, password, manualElecMpan, manualElecSerial, manualGasMprn, manualGasSerial, showDiagnostics, useDemoFallback };
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
}

/* --------------------------------- Init ----------------------------------- */

function init() {
  $('app-version').textContent = APP_VERSION;
  $('settings-btn').addEventListener('click', openSettings);
  $('connect-btn').addEventListener('click', openSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click', saveSettings);
  $('advanced-toggle').addEventListener('click', () => $('advanced-fields').classList.toggle('hidden'));
  $('ev-header').addEventListener('click', () => {
    const currentlyExpanded = !$('ev-body').classList.contains('hidden');
    evManualOverride = !currentlyExpanded;
    $('ev-body').classList.toggle('hidden', !evManualOverride);
    $('ev-chevron').textContent = evManualOverride ? '▾' : '▸';
    $('ev-header').setAttribute('aria-expanded', String(evManualOverride));
  });
  $('ev-push-enable').addEventListener('click', enableEvPush);

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
    try { await loadAll(); } finally { btn.classList.remove('spinning'); }
  });

  if (store.creds?.apiKey) {
    $('connect-card').classList.add('hidden');
    $('app-content').classList.remove('hidden');
    loadAll();
    // Refresh every 5 minutes while the app is open
    setInterval(loadAll, 5 * 60 * 1000);
    // Live usage refreshes faster on its own — 30s, matching roughly how
    // often new telemetry actually shows up, without re-running the full sync.
    setInterval(() => loadLiveUsage().catch(() => {}), 30 * 1000);
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
