import { $ } from './format.js';

// v2.251: compact power meter, replacing the old This Session/Power/
// Sessions today/Cost mini boxes (see styles.css comment for the reasoning).
// No Settings field for max charger output yet — unlike the WLTP range/
// battery kWh pair (still in app.js), this hasn't been asked for, so it's a
// plain fallback constant for now, same pattern as those before Settings
// support was added. Set to 7.1kW (7.1kW home wallbox), not the current
// ~2.3kW granny-charger figure — the meter is meant to read "how full is
// the pipe", which should stay meaningful once the faster charger arrives
// rather than needing a code change at that point too.
const EV_CHARGER_MAX_KW_FALLBACK = 7.1;
const EV_PMETER_SEGMENTS = 7;
export function renderPowerMeter(kw) {
  const maxKw = EV_CHARGER_MAX_KW_FALLBACK;
  $('ev-pmeter-value').textContent = `${kw.toFixed(1)} kW`;
  const onCount = Math.max(0, Math.min(EV_PMETER_SEGMENTS, Math.round((kw / maxKw) * EV_PMETER_SEGMENTS)));
  const bar = $('ev-pmeter-bar');
  bar.innerHTML = Array.from({ length: EV_PMETER_SEGMENTS }, (_, i) =>
    `<div class="pmeter-seg${i < onCount ? ' on' : ''}"></div>`
  ).join('');
}

export function renderChartScale(scaleId, max, formatter) {
  if (!scaleId) return;
  const el = document.getElementById(scaleId);
  if (!el) return;
  const fmtVal = formatter || (v => v.toFixed(1));
  el.innerHTML = `<span>${fmtVal(max)}</span><span>${fmtVal(max / 2)}</span><span>${fmtVal(0)}</span>`;
}

// Shared by every bar chart in the app (renderWeekBars, renderStackedBars,
// renderEVHistoryBars) — each computed this identically (a magnitude with a
// floor so an all-zero dataset doesn't divide by zero) but as its own
// inline expression.
export function chartMax(values) {
  return Math.max(...values, 0.01);
}

// A label per bar works fine up to about 10 bars; a month view (~28-31
// bars) crams that many onto a mobile-width chart and overflows (confirmed
// live) — past the threshold, only every 5th bar gets a label.
const CHART_DENSE_THRESHOLD = 10;
const CHART_DENSE_LABEL_EVERY = 5;
export function isChartDense(length, threshold = CHART_DENSE_THRESHOLD) {
  return length > threshold;
}
// A skipped label renders '&nbsp;', never an empty string or no <span> at
// all — a genuinely empty string can still collapse an inline element's
// line-height in some browsers despite font-size being set, and omitting
// the <span> entirely shifts bars that DO have a label down relative to
// ones that don't, since columns bottom-align via flex (confirmed live —
// a few px lower). Every bar needs the same DOM shape regardless of
// whether its label is shown.
export function chartLabelOrBlank(text, index, isDense, everyNth = CHART_DENSE_LABEL_EVERY) {
  return (!isDense || index % everyNth === 0) ? text : '&nbsp;';
}

export function renderWeekBars(containerId, values, colorClass, formatter, maxBarHeight = 44, scaleId = null) {
  const el = $(containerId);
  // Bar height is driven by magnitude, not the raw signed value — EV
  // dispatch kWh can come back negative for short sessions (a real Octopus
  // measurement quirk, kept visible as-is in the signed text/tooltip below),
  // and a negative value divided against a near-zero max would otherwise
  // clamp every bar to the height floor regardless of actual size.
  const max = chartMax(values.map(Math.abs));
  renderChartScale(scaleId, max, formatter);
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = new Date().getDay();
  const isDense = isChartDense(values.length);
  el.classList.toggle('dense', isDense);
  el.innerHTML = values.map((v, i) => {
    const isToday = i === values.length - 1;
    const h = Math.max(2, Math.round((Math.abs(v) / max) * maxBarHeight));
    const labelText = labels[(today - (values.length - 1 - i) + 7) % 7];
    const label = `<span>${chartLabelOrBlank(labelText, i, isDense)}</span>`;
    return `<div class="week-bar"><div class="col ${colorClass}${isToday ? ' today' : ''}" style="height:${h}px" title="${formatter ? formatter(v) : v}"></div>${label}</div>`;
  }).join('');
}

// Stacked variant: each day is [{value, cssClass}, ...] segments stacked
// bottom-to-top (e.g. standing charge, then off-peak, then peak). Segment
// order in the array is bottom-to-top.
export function renderStackedBars(containerId, dayStacks, formatter, maxBarHeight = 44, scaleId = null, selectedIndex = null, isMonthMode = false, suppressToday = false, weekdayAnchor = null) {
  const el = $(containerId);
  const totals = dayStacks.map(day => day.reduce((s, seg) => s + seg.value, 0));
  const max = chartMax(totals);
  renderChartScale(scaleId, max, formatter);
  const labels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const today = (weekdayAnchor || new Date()).getDay();
  const isDense = isChartDense(dayStacks.length);
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
    const label = `<span class="${isSelected ? 'active-day' : ''}">${chartLabelOrBlank(labelText, i, isDense)}</span>`;
    return `<div class="week-bar"><div class="col-stack${isSelected ? ' selected' : ''}" data-index="${i}">${segHtml}</div>${label}</div>`;
  }).join('');
}
