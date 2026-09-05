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


function daysElapsedInMonth(now = new Date()) {
  return now.getDate();
}
function daysInMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}
function isoDate(d) { return d.toISOString().slice(0, 10); }


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
      // v2.260 fix: v2.258's tightening (both categories must be nonzero)
      // inherited a known, previously-safe limitation from costForRange's
      // own hasData (see its comment) without checking whether the
      // tradeoff still held here — it doesn't. That function's false
      // positive (a genuine zero-usage day briefly reading as "pending")
      // was harmless because it only affected which day got picked as
      // "latest", and self-corrected once a later real day superseded it.
      // Once v2.259 started greying out chart bars for any hasData:false
      // day, the same false positive became permanent for a day sitting
      // further back in the week/month — confirmed live: a genuine
      // zero-usage day (away from home) stayed grey forever, never
      // superseded by anything. Fixed by trusting readings.length alone
      // once a day is old enough that Octopus's documented 24-48h
      // settlement lag can't explain a still-empty category — 3 days
      // gives a safety margin beyond that. Recent days keep the stricter
      // both-categories check, since the placeholder-zero risk is real
      // there.
      const daysOld = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - dates[i]) / 86400000);
      const settled = daysOld >= 3;
      return {
        offPeakKwh, peakKwh, offPeakCost: offPeakCostP / 100, peakCost: peakCostP / 100,
        hasData: readings.length > 0 && (settled || (offPeakKwh > 0.001 && peakKwh > 0.001)),
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

let meterDebugNote = null;
let fuelData = { elec: null, gas: null };

// Populated by loadBilling() with figures Insights reuses rather than
// recomputing — the balance and its trend are already fully calculated
// there, no reason to duplicate that logic. nextPaymentAmount/Date feed the
// 12-month balance forecast (each future cycle assumes this same amount
// recurs monthly — same assumption the single-cycle trend already made).
let billingState = { balancePounds: null, trend: null, hasNextPayment: false, nextPaymentAmount: null };
let fuelUnit = { elec: 'cost', gas: 'cost' };

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
  // v2.261: replaces the v2.258/v2.259 grey-segment treatment. Standing
  // charge is a known, fixed daily rate — true regardless of whether
  // consumption has settled — so it always renders normally, full
  // strength, no matter how incomplete the day's readings are; greying
  // it (as the two prior versions did) implied it was uncertain too,
  // which it never was. Off-peak/peak (or gas usage) are the genuinely
  // uncertain part — rather than showing them in a muted grey (still
  // implies "here's a real, if partial, reading"), an incomplete day's
  // consumption is zeroed out entirely, so nothing renders for it at
  // all. A confirmed complete day (hasData: true) is unaffected either
  // way, and a genuinely-zero-but-settled day (see lastNDaysElecSplit's
  // age-based hasData fix) correctly still shows its real zero.
  const incomplete = day.hasData === false;
  if (fuel === 'elec') {
    const segs = [];
    if (unit === 'cost') segs.push({ value: day.standing || 0, cssClass: 'seg-standing' });
    segs.push({ value: incomplete ? 0 : (unit === 'cost' ? day.offPeakCost : day.offPeakKwh), cssClass: 'seg-offpeak' });
    segs.push({ value: incomplete ? 0 : (unit === 'cost' ? day.peakCost : day.peakKwh), cssClass: 'seg-peak' });
    return segs;
  }
  const segs = [];
  if (unit === 'cost') segs.push({ value: day.standing || 0, cssClass: 'seg-gas-standing' });
  segs.push({ value: incomplete ? 0 : (unit === 'cost' ? day.cost : day.kwh), cssClass: 'seg-gas-usage' });
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

// Extracted from the (previously duplicated, elec+gas) "today vs 7-day
// average" trend pill. Arrow/text follow the raw numeric direction, but the
// colour needs to be inverted from it: spending MORE than average is bad
// news (coral), spending LESS is good news (mint) — the opposite of the
// balance-trend pill elsewhere, where "up" (a bigger incoming payment than
// predicted cost) is the good outcome. Getting this backwards is the exact
// bug the README documents as having shipped twice, caught by the user
// rather than review both times — pulled into one tested function so a
// third slip shows up as a failing test instead.
export function trendVsAverage(value, avg) {
  const diffPct = avg > 0 ? ((value - avg) / avg) * 100 : 0;
  const goodNews = diffPct <= 0;
  return {
    diffPct,
    cssClass: goodNews ? 'up' : 'down',
    text: `${goodNews ? '↓' : '↑'} ${Math.abs(diffPct).toFixed(0)}% ${goodNews ? 'below' : 'above'} your 7-day average`,
  };
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
      const pill = $('insights-elec-trend-pill');
      const trend = trendVsAverage(val, avg);
      pill.className = 'trend-pill ' + trend.cssClass;
      pill.textContent = trend.text;
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
      const pill = $('insights-gas-trend-pill');
      const trend = trendVsAverage(val, avg);
      pill.className = 'trend-pill ' + trend.cssClass;
      pill.textContent = trend.text;
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
  // v2.218 got the priority order backwards: it made the flat average of
  // today's off-peak/standard rates the primary source, with MTD-blended
  // demoted to a fallback. That fixed the sync-time volatility, but
  // introduced a real accuracy problem — the blended MTD rate reflects
  // this account's *actual* mix of off-peak vs standard usage, while a
  // flat 50/50 average doesn't, and would systematically overstate
  // electricity cost for any household whose usage skews off-peak (as
  // an IOG household's typically does). v2.219: flipped back — MTD-
  // blended first (accurate to real usage mix), the stable-but-cruder
  // average only as fallback when MTD genuinely isn't available (the
  // original v2.217 crash case), rather than the reverse.
  const elecRateP = todayBlendedRateP('elec') ?? (
    (rateState.offPeakRateP != null && rateState.standardRateP != null)
      ? (rateState.offPeakRateP + rateState.standardRateP) / 2
      : null
  );
  const gasRateP = todayBlendedRateP('gas') ?? rateState.gasRateP;
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
      elecCost = (histMonth.elecKwh * elecRateP / 100) + ((rateState.elecStandingP || 0) / 100 * days);
      gasCost = gasRateP !== null ? (histMonth.gasKwh * gasRateP / 100) + ((rateState.gasStandingP || 0) / 100 * days) : 0;
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
  if (!rateState.elecStandingP && !rateState.gasStandingP) return;
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const daysElapsed = Math.max(1, Math.round((now - startOfYear) / 86400000));
  const daysInYear = (now.getFullYear() % 4 === 0 && (now.getFullYear() % 100 !== 0 || now.getFullYear() % 400 === 0)) ? 366 : 365;
  // v2.212: broken out per-fuel (each fuel its own box) instead of only
  // ever showing the combined total — the total line below still sums
  // both, just no longer as its own separate box (see CSS notes).
  $('insights-standing-elec-ytd').textContent = fmtGBP((rateState.elecStandingP || 0) * daysElapsed / 100);
  $('insights-standing-elec-full').textContent = fmtGBP((rateState.elecStandingP || 0) * daysInYear / 100);
  $('insights-standing-gas-ytd').textContent = fmtGBP((rateState.gasStandingP || 0) * daysElapsed / 100);
  $('insights-standing-gas-full').textContent = fmtGBP((rateState.gasStandingP || 0) * daysInYear / 100);
  const dailyRateP = (rateState.elecStandingP || 0) + (rateState.gasStandingP || 0);
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
      const standing = rateState.elecStandingP ? rateState.elecStandingP / 100 : 0;
      fuelData.elec.pickedWeek = days.map(d => ({ ...d, standing }));
      fuelData.elec.pickedWeekFor = key;
    }
    if (fuelData.gas?.pickedWeekFor !== key) {
      fuelData.gas = fuelData.gas || {};
      const days = await lastNDaysCost('gas', 7, weekEnd);
      const standing = rateState.gasStandingP ? rateState.gasStandingP / 100 : 0;
      fuelData.gas.pickedWeek = days.map(d => ({ ...d, standing }));
      fuelData.gas.pickedWeekFor = key;
    }
  } else if (periodMode === 'month') {
    const key = `${pickedDate.getFullYear()}-${pickedDate.getMonth()}`;
    if (fuelData.elec?.pickedMonthFor !== key) {
      fuelData.elec = fuelData.elec || {};
      const days = await monthElecSplit(pickedDate);
      const standing = rateState.elecStandingP ? rateState.elecStandingP / 100 : 0;
      fuelData.elec.pickedMonth = days.map(d => ({ ...d, standing }));
      fuelData.elec.pickedMonthFor = key;
    }
    if (fuelData.gas?.pickedMonthFor !== key) {
      fuelData.gas = fuelData.gas || {};
      const days = await monthFuelSplit('gas', pickedDate);
      const standing = rateState.gasStandingP ? rateState.gasStandingP / 100 : 0;
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
  const standing = rateState.elecStandingP ? rateState.elecStandingP / 100 : 0;
  return days.map(d => ({ ...d, standing }));
}
async function lastNDaysGasSplitWithStanding(n) {
  const days = await lastNDaysCost('gas', n);
  const standing = rateState.gasStandingP ? rateState.gasStandingP / 100 : 0;
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
// v2.214: accepts an optional yearsAgo offset (default 0 = current year) —
// added to probe whether a prior year's group_by=month request retains
// data past the ~2-month floor already confirmed for finer daily/half-
// hourly queries (that floor was only ever tested at that finer
// granularity, never for this coarser monthly aggregation, which many
// billing systems retain much longer than raw interval data).
async function fetchYearMonthly(fuel, yearsAgo = 0) {
  const creds = store.creds;
  const isElec = fuel === 'elec';
  const mp = isElec ? creds.elecMpan : creds.gasMprn;
  const serial = isElec ? creds.elecSerial : creds.gasSerial;
  if (!mp || !serial) throw new Error(`No ${fuel} meter point on file`);
  const now = new Date();
  const targetYear = now.getFullYear() - yearsAgo;
  const yearStart = new Date(targetYear, 0, 1).toISOString();
  const yearEnd = (yearsAgo === 0 ? now : new Date(targetYear, 11, 31, 23, 59, 59)).toISOString();
  const path = isElec
    ? `/electricity-meter-points/${mp}/meters/${serial}/consumption/?period_from=${yearStart}&period_to=${yearEnd}&group_by=month&page_size=100`
    : `/gas-meter-points/${mp}/meters/${serial}/consumption/?period_from=${yearStart}&period_to=${yearEnd}&group_by=month&page_size=100`;
  const data = await octRest(path);
  const results = (data.results || []).sort((a, b) => +new Date(a.interval_start) - +new Date(b.interval_start));
  // Monthly aggregates, not half-hourly/daily readings — GAS_M3_THRESHOLD_MONTHLY,
  // not _SUBDAILY, since a whole month's m3 total is a different scale entirely.
  const gasUnit = !isElec ? detectGasUnit(results.map(r => r.consumption), GAS_M3_THRESHOLD_MONTHLY) : null;
  return results.map(r => {
    let kwh = r.consumption;
    if (gasUnit === 'CUBIC_METERS') kwh = m3ToKwh(kwh);
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
    if (elecStanding) rateState.elecStandingP = elecStanding;
    if (gasStanding) rateState.gasStandingP = gasStanding;
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
        if (currentGasRate !== null) { $('gas-unit-rate').textContent = `${currentGasRate.toFixed(2)}p`; rateState.gasRateP = currentGasRate; }
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
          if (unit === 'CUBIC_METERS' || unit === 'CUBIC_METRE') return m3ToKwh(q);
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
    // Decided once across every reading in the whole fetched range, not
    // per day-bucket — the meter's reporting unit doesn't change day to
    // day within one fetch, so there's no reason to re-guess it per bucket
    // (and every reason not to: a bucket that happens to start with an
    // atypical reading previously risked flipping just that one day).
    const gasUnit = !isElec ? detectGasUnit((consData.results || []).map(r => r.consumption), GAS_M3_THRESHOLD_DAILY) : null;
    const buckets = bucketReadingsByDay(consData.results || [], n, now);
    return buckets.map((readings, i) => {
      let kwh = 0, costPence = 0;
      for (const r of readings) {
        let consumption = r.consumption;
        if (gasUnit === 'CUBIC_METERS') consumption = m3ToKwh(consumption);
        const rate = rateAt(rates, +new Date(r.interval_start));
        if (rate === null) continue;
        kwh += consumption;
        costPence += consumption * rate;
      }
      return {
        cost: costPence / 100, kwh,
        // v2.260 fix: same reasoning as lastNDaysElecSplit's own comment —
        // trust readings.length alone once a day is old enough that
        // Octopus's settlement lag can't explain a still-zero kWh total,
        // rather than permanently treating a genuine zero-usage day
        // (holiday, meter genuinely reads ~0) as "no data" in the chart.
        hasData: readings.length > 0 && (Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - dates[i]) / 86400000) >= 3 || kwh > 0.001),
        date: dates[i]
      };
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
        // TEMPORARY diagnostic — probing whether electricity's group_by=month
        // aggregation retains data beyond the ~2-month floor already
        // confirmed for finer-grained queries (see fetchYearMonthly comment
        // above). Does not affect the visible Year view at all — separate
        // fetch, logged only, not wired into fuelData or any chart. Remove
        // this whole block once the question is answered either way.
        try {
          const priorYearElec = await fetchYearMonthly('elec', 1);
          const withData = priorYearElec.filter(m => m.kwh > 0).length;
          logDebug('Prior-year elec probe', `${priorYearElec.length} month(s) returned, ${withData} with non-zero kWh — ${priorYearElec.map(m => `${m.month}:${m.kwh.toFixed(0)}kWh`).join(' ')}`);
        } catch (err) {
          logDebug('Prior-year elec probe', `request failed — ${err.message}`);
        }
        renderDiagnostics(); // logDebug() alone doesn't redraw the panel — same lesson as the v2.196 comment above, missed here on first pass
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
