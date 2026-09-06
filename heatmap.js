import { $ } from './format.js';
import { store } from './store.js';
import { octRest } from './api.js';
import { logIssue, logDebug } from './diagnostics.js';

// Time-of-day usage pattern — a weekday × hour grid of average electricity
// use, surfacing habitual rhythms the Day/Week/Month bars don't ("6pm spike
// every weekday"). Its own REST call (28 days of half-hourly readings), made
// once on first expand — a 4-week rolling mean barely moves hour to hour, so
// there's no reason to refetch on every sync. Electricity only: gas reads
// once a day, so it has no intra-day shape to plot.

const DAYS = 28;
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Load-once, like Insights — a 28-day mean doesn't change materially within
// a session, so it isn't reset on sync.
let loaded = false;

export function handleHeatmapToggle() {
  const body = $('heatmap-body');
  const open = !body.classList.contains('hidden');
  body.classList.toggle('hidden', open);
  $('heatmap-chevron').textContent = open ? '▸' : '▾';
  $('heatmap-toggle').setAttribute('aria-expanded', String(!open));
  if (!open) loadHeatmap();
}

// Mon=0 … Sun=6 (Date.getDay() is Sun=0), so the grid reads Monday-first.
const isoDow = d => (d.getDay() + 6) % 7;

export async function loadHeatmap() {
  if (loaded) return;
  loaded = true;

  const mpan = store.creds?.elecMpan;
  const serial = store.creds?.elecSerial;
  if (!mpan || !serial) {
    $('heatmap-note').textContent = 'No electricity meter on file yet.';
    return;
  }

  try {
    const to = new Date();
    const from = new Date(to.getTime() - DAYS * 24 * 60 * 60 * 1000);
    // 28 days × 48 half-hours = 1344 readings, comfortably under one page.
    const data = await octRest(
      `/electricity-meter-points/${mpan}/meters/${serial}/consumption/` +
      `?period_from=${from.toISOString()}&period_to=${to.toISOString()}&page_size=1500`
    );
    const readings = data.results || [];
    if (!readings.length) throw new Error('no consumption readings in the last 28 days');

    // cells[dow][hour] = { sum kWh, n half-hour slots } → mean per slot.
    const cells = Array.from({ length: 7 }, () =>
      Array.from({ length: 24 }, () => ({ sum: 0, n: 0 })));
    for (const r of readings) {
      const d = new Date(r.interval_start);
      const c = cells[isoDow(d)][d.getHours()];
      c.sum += r.consumption;
      c.n += 1;
    }
    const mean = (dow, hr) => (cells[dow][hr].n ? cells[dow][hr].sum / cells[dow][hr].n : null);

    let max = 0, peak = null;
    for (let dow = 0; dow < 7; dow++) {
      for (let hr = 0; hr < 24; hr++) {
        const m = mean(dow, hr);
        if (m != null && m > max) { max = m; peak = { dow, hr, m }; }
      }
    }
    if (!max) throw new Error('all buckets empty');

    renderHeatmap(mean, max, peak);
    logDebug('Usage heat map', `${readings.length} reading(s), peak ${peak.m.toFixed(3)} kWh/½h at ${DAY_LABELS[peak.dow]} ${String(peak.hr).padStart(2, '0')}:00`);
  } catch (err) {
    logIssue('Usage heat map', err);
    $('heatmap-grid').innerHTML = '';
    $('heatmap-note').textContent = 'Not available right now.';
  }
}

function renderHeatmap(mean, max, peak) {
  $('heatmap-note').textContent = `Average electricity use by hour and weekday, last ${DAYS} days.`;

  // Header row: a spacer for the hour-label column, then the seven days.
  let html = '<span class="hm-corner"></span>' +
    DAY_LABELS.map(l => `<span class="hm-day">${l[0]}</span>`).join('');

  for (let hr = 0; hr < 24; hr++) {
    // Label every third hour to keep the column legible on a phone.
    html += `<span class="hm-hour">${hr % 3 === 0 ? String(hr).padStart(2, '0') : ''}</span>`;
    for (let dow = 0; dow < 7; dow++) {
      const m = mean(dow, hr);
      if (m == null) {
        html += '<span class="hm-cell hm-cell-empty"></span>';
        continue;
      }
      // Gamma > 1 so low cells stay faint and the genuine peaks carry the
      // colour — a flat linear ramp washed the whole grid pink. Small floor
      // keeps a used-but-low slot distinct from a no-data one.
      const a = (0.04 + 0.96 * Math.pow(m / max, 1.5)).toFixed(3);
      const isPeak = peak && dow === peak.dow && hr === peak.hr;
      html += `<span class="hm-cell${isPeak ? ' hm-cell-peak' : ''}" style="background:rgba(255,79,163,${a})" title="${DAY_LABELS[dow]} ${String(hr).padStart(2, '0')}:00 · ${m.toFixed(2)} kWh/½h"></span>`;
    }
  }
  $('heatmap-grid').innerHTML = html;

  const h = String(peak.hr).padStart(2, '0');
  const band = peak.hr < 6 ? 'overnight' : peak.hr < 12 ? 'morning' : peak.hr < 18 ? 'afternoon' : 'evening';
  const when = peak.dow <= 4 ? `weekday ${band}s` : `weekend ${band}s`;
  $('heatmap-insight').innerHTML =
    `Heaviest average draw: <b>${DAY_LABELS[peak.dow]} ${h}:00</b> — a ${when} pattern ` +
    `(~${peak.m.toFixed(2)} kWh per half-hour)`;
}
