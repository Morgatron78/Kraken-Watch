import { store } from './store.js';
import { $, fmtGBP, fmtKwh } from './format.js';
import { logIssue, logDebug } from './diagnostics.js';
import { octRest } from './api.js';
import { renderChartScale, renderStackedBars } from './charts.js';
import {
  rateState, fetchElecRates, fetchGasRates, rateAt, m3ToKwh, detectGasUnit,
  GAS_M3_THRESHOLD_DAILY, GAS_M3_THRESHOLD_MONTHLY, bucketReadingsByDay,
} from './rates.js';

export function daysElapsedInMonth(now = new Date()) {
  return now.getDate();
}
export function daysInMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}
export function isoDate(d) { return d.toISOString().slice(0, 10); }


export async function lastNDaysElecSplit(n, anchor = new Date()) {
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
      // Once a day is ≥3 days old, Octopus's 24-48h settlement lag can't
      // explain a still-empty category, so trust readings.length alone —
      // otherwise a genuine zero-usage day (away from home) reads as
      // "pending" forever and the chart bar stays greyed. Recent days keep
      // the stricter both-categories-nonzero check, where a placeholder
      // zero before the real figure settles is a real risk.
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

// Whole calendar month containing monthAnchor, capped at today for the
// current month (nothing for a fully-future month). Computes the (n, anchor)
// pair and delegates to lastNDaysElecSplit rather than duplicating its
// fetch/bucket logic — effectiveLastDay minus n days always equals
// monthStart by construction, so this is exact.
export async function monthElecSplit(monthAnchor) {
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

export const fuelData = { elec: null, gas: null };

// Renders a fuel panel (elec/gas) from cached data in the currently-selected
// unit (cost or kWh) — pure re-render, no refetch, so the toggle is instant.
let periodMode = 'week';

// Tap-to-see-breakdown state, per fuel. null = no manual selection yet,
// defaults to the latest-available day. Reset to null whenever the
// Week/Month period changes, since the old index would point at a
// completely different day in the new array.
let selectedDay = { elec: null, gas: null };

let fuelUnit = { elec: 'cost', gas: 'cost' };

// Date-picker state — a single shared anchor date (or null for "current
// period, anchored to today", the existing default behavior everywhere
// else). Applies across Day/Week/Month, matching how Octopus's own picker
// works: one date field + one period field, not three independent picks.
// Not persisted across reloads, same as periodMode/selectedDay — ephemeral
// UI state, reset on refresh.
let pickedDate = null;
let pickerOpen = false;
let pickerViewMonth = new Date(); // which month the calendar grid shows

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

export function breakdownRow(label, cssClass, costStr, kwhStr) {
  return `<div class="breakdown-row"><span class="label"><span class="dot ${cssClass}"></span>${label}${kwhStr ? ` (${kwhStr})` : ''}</span><span class="val">${costStr}</span></div>`;
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
  // Standing charge is a fixed daily rate, certain regardless of whether
  // consumption has settled, so it always renders full-strength. Off-peak/
  // peak (or gas usage) is the uncertain part — an incomplete day's
  // consumption is zeroed out entirely rather than shown muted. A settled
  // day (hasData true, or the age-based zero-usage case in
  // lastNDaysElecSplit) still shows its real values, including a real zero.
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
// the stacked chart; gas's are a flat {cost, kwh}. Normalizes either shape
// into one total (reading `.cost` directly is undefined on the split shape
// and produces "£NaN").
export function dayTotal(fuel, day, unit) {
  if (fuel === 'elec') {
    if (unit === 'cost') return (day.offPeakCost || 0) + (day.peakCost || 0) + (day.standing || 0);
    return (day.offPeakKwh || 0) + (day.peakKwh || 0);
  }
  if (unit === 'cost') return (day.cost || 0) + (day.standing || 0);
  return day.kwh || 0;
}

export function renderFuelPanel(fuel) {
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

  // Legend/footer swap for Year: it's a single-colour total per month, not
  // the standing/off-peak/peak split the Week/Month legend describes. The
  // unit-rate footer is hidden entirely in Year mode (no cost figures for
  // that rate to relate to) rather than relabelled.
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
    // Sync the active button state here, not at the end — Day/Year both
    // return early below, so anything after those returns never runs for them.
    toggleWrap.querySelectorAll('.unit-toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.unit === unit);
    });
  }

  if (isGasDay) return; // nothing else to render for gas in Day mode

  if (isDay && fuel === 'elec') { renderElecDayView(); return; }
  if (isYear) { renderYearView(fuel, unit, fmt); return; }

  // --- Week / Month (existing behaviour, unchanged) ---

  // "Latest available day" instead of a fixed Yesterday/Today pair — smart
  // meter data for both fuels lags into the next day or further, so neither
  // is reliably populated. Scans the week array backward for the most recent
  // day with data and labels it with its real date.
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
    const fill = isFuture ? 'var(--tint-track)' : (isCurrent ? barColor : barColor);
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
export async function loadMonthData(fuel) {
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
export async function loadPickedPeriodData() {
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
export async function lastNDaysElecSplitWithStanding(n) {
  const days = await lastNDaysElecSplit(n);
  const standing = rateState.elecStandingP ? rateState.elecStandingP / 100 : 0;
  return days.map(d => ({ ...d, standing }));
}
export async function lastNDaysGasSplitWithStanding(n) {
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
  // most of that before accepting a day as "available", so a handful of
  // early readings trickling in for today don't produce a near-empty
  // 2-bar chart that looks broken rather than genuinely incomplete.
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

// Monthly kWh totals for the calendar year so far, one API call per fuel
// via group_by=month. kWh-only, not £: a monthly total can't be costed
// accurately without knowing when within the month the energy was used
// (rates vary over time and, for electricity, by time of day). Real £ would
// need the same day-by-day rate matching the Month view does, for the whole
// year — far more calls.
//
// Current year only. A one-off probe (Nov 2026) confirmed group_by=month is
// subject to the same ~2-month retention floor as the finer queries — a
// prior-year request comes back with only the last couple of months that
// have data, not the full year — so there's no cheap route to multi-year
// monthly history and no reason to parameterise the year.
export async function fetchYearMonthly(fuel) {
  const creds = store.creds;
  const isElec = fuel === 'elec';
  const mp = isElec ? creds.elecMpan : creds.gasMprn;
  const serial = isElec ? creds.elecSerial : creds.gasSerial;
  if (!mp || !serial) throw new Error(`No ${fuel} meter point on file`);
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString();
  const yearEnd = now.toISOString();
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
    // Decided once across the whole fetched range, not per day-bucket — the
    // meter's reporting unit doesn't change day to day within one fetch, and
    // a bucket starting with an atypical reading could flip just that day.
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
        // Same age-based rule as lastNDaysElecSplit: past the settlement
        // lag, trust readings.length so a genuine zero-usage day (holiday)
        // isn't permanently treated as "no data" in the chart.
        hasData: readings.length > 0 && (Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - dates[i]) / 86400000) >= 3 || kwh > 0.001),
        date: dates[i]
      };
    });
  } catch (err) {
    logIssue(`${isElec ? 'Electricity' : 'Gas'} week breakdown`, err);
    return dates.map(date => ({ cost: 0, kwh: 0, hasData: false, date }));
  }
}

// Same trick as monthElecSplit — compute the (n, anchor) pair for the whole
// calendar month (capped at today for the current month) and delegate to
// lastNDaysCost.
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

/* ------------------------- Click handlers (wired from main.js's init()) ------------------------- */

// £ / kWh toggle — per fuel panel, instant re-render from cached data.
export function handleUnitToggleClick(e) {
  const btn = e.currentTarget;
  const fuel = btn.closest('.unit-toggle').dataset.fuel;
  fuelUnit[fuel] = btn.dataset.unit;
  renderFuelPanel(fuel);
}

// Day / Week / Month / Year toggle, shared across both fuel panels.
// Month/Year data is fetched lazily on first use, not every sync. Day is
// electricity-only, but attempting the fetch unconditionally is harmless —
// renderFuelPanel handles gas's "not available" state either way.
export async function handlePeriodToggleClick(e) {
  const btn = e.currentTarget;
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
}

// Date picker: calendar button opens/closes the panel; month nav browses
// without changing the pick; tapping a day picks it and closes the panel;
// reset/jump-to-today both clear the pick and fall back to the normal
// today-anchored view everywhere else in the app already uses.
export function handleDatePickerBtnClick() {
  if (pickerOpen) closeDatePicker(); else openDatePicker();
}

export function handlePickerPrevMonthClick() {
  pickerViewMonth = new Date(pickerViewMonth.getFullYear(), pickerViewMonth.getMonth() - 1, 1);
  renderPickerCalendar();
}
export function handlePickerNextMonthClick() {
  if ($('picker-next-month').classList.contains('disabled')) return;
  pickerViewMonth = new Date(pickerViewMonth.getFullYear(), pickerViewMonth.getMonth() + 1, 1);
  renderPickerCalendar();
}

export async function handlePickerGridClick(e) {
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
}

export async function handleResetToTodayClick() {
  pickedDate = null;
  selectedDay.elec = null;
  selectedDay.gas = null;
  selectedDaySlot.elec = null;
  closeDatePicker();
  updateDatePickerUI();
  renderFuelPanel('elec');
  renderFuelPanel('gas');
}

// Tap a bar to see that day's (or month's) breakdown; tap the same bar
// again to close it. Event delegation so it works regardless of how many
// bars get re-rendered (week/month/year all reuse this). Bound to both
// #elec-week and #gas-week — the fuel is read off the container's own id
// rather than captured per-fuel, since one exported handler serves both.
export function handleFuelWeekBarClick(e) {
  const fuel = e.currentTarget.id.split('-')[0];
  const bar = e.target.closest('.col-stack');
  if (!bar) return;
  const index = parseInt(bar.dataset.index, 10);
  if (Number.isNaN(index)) return;
  selectedDay[fuel] = (selectedDay[fuel] === index) ? null : index;
  renderFuelPanel(fuel);
}

// Same tap-to-reveal pattern for the Day view's half-hourly slots.
export function handleElecDayBarClick(e) {
  const bar = e.target.closest('.fill');
  if (!bar) return;
  const index = parseInt(bar.dataset.index, 10);
  if (Number.isNaN(index)) return;
  selectedDaySlot.elec = (selectedDaySlot.elec === index) ? null : index;
  renderFuelPanel('elec');
}
