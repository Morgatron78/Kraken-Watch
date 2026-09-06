import { $ } from './format.js';
import { store } from './store.js';
import { logIssue, logDebug } from './diagnostics.js';

// Grid carbon intensity from the National Grid ESO API
// (api.carbonintensity.org.uk — free, no auth, 48h regional forecast). This
// is the one external, non-Octopus feed in the app: a NESO outage or the
// user having no outward postcode on file is not an Octopus sync failure,
// so loadCarbon() is kept out of the sync-status calculation in main.js and
// just hides its card on failure.

const API = 'https://api.carbonintensity.org.uk';
const TIMEOUT_MS = 15000;

// Populated by loadCarbon(); read by the Live usage and Current rate cards
// for their own point-in-time CO₂ lines. Mutable object, same pattern as
// rateState — importers read the properties, only this module writes them.
export const carbonState = {
  currentGco2: null,   // gCO₂/kWh right now
  currentIndex: null,  // 'very low' | 'low' | 'moderate' | 'high' | 'very high'
  region: null,        // human region name, or 'Great Britain' for the national fallback
};

// The API returns a 5-level index; the card collapses it to a 3-colour ramp.
const BAND = { 'very low': 'low', low: 'low', moderate: 'moderate', high: 'high', 'very high': 'high' };
const LABEL = { 'very low': 'Very low', low: 'Low', moderate: 'Moderate', high: 'High', 'very high': 'Very high' };
const bandOf = index => BAND[index] || 'moderate';

const isoMinute = d => d.toISOString().slice(0, 16) + 'Z'; // YYYY-MM-DDThh:mmZ, the format NESO wants
const hhmm = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// One-liner for the Current rate card's "Grid" row — "Low · 38 g", or "—".
export function gridCarbonText() {
  if (carbonState.currentGco2 == null) return '—';
  const lbl = LABEL[carbonState.currentIndex] || '';
  return lbl ? `${lbl} · ${carbonState.currentGco2} g` : `${carbonState.currentGco2} g`;
}

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`carbonintensity ${path} → ${res.status}`);
  return res.json();
}

// The 48h forecast slots from the most recent fetch, kept so the EV card's
// dispatch-window tags can be banded without a second request. loadCarbon()
// and ensureCarbonForecast() (the EV panel's opportunistic warm-up) share one
// in-flight promise, so a parallel load is never two fetches.
let forecastSlots = [];
let forecastRegion = null;
let forecastAt = 0;
let forecastInFlight = null;
const FORECAST_TTL_MS = 20 * 60 * 1000;

async function fetchForecastSlots() {
  const outcode = (store.creds?.outcode || '').trim();
  // Start one half-hour back so the slot covering "now" is always included.
  const from = isoMinute(new Date(Date.now() - 30 * 60 * 1000));
  let slots, region;
  if (outcode) {
    // The regional-with-time-range response wraps its slots in an object
    // ({ data: { shortname, data: [...] } }), not an array like the docs' example.
    const j = await fetchJson(`/regional/intensity/${from}/fw48h/postcode/${encodeURIComponent(outcode)}`);
    const block = Array.isArray(j?.data) ? j.data[0] : j?.data;
    region = block?.shortname || 'Your region';
    slots = block?.data || [];
  } else {
    const j = await fetchJson(`/intensity/${from}/fw48h`);
    region = 'Great Britain';
    slots = j?.data || [];
  }
  forecastSlots = slots;
  forecastRegion = region;
  forecastAt = Date.now();
  return { slots, region };
}

function getForecast({ force = false } = {}) {
  if (!force && forecastSlots.length && Date.now() - forecastAt < FORECAST_TTL_MS) {
    return Promise.resolve({ slots: forecastSlots, region: forecastRegion });
  }
  if (!forecastInFlight) {
    forecastInFlight = fetchForecastSlots().finally(() => { forecastInFlight = null; });
  }
  return forecastInFlight;
}

// Opportunistic warm-up for the EV dispatch-window tags — safe to call
// alongside loadCarbon (they dedupe on forecastInFlight), best-effort.
export async function ensureCarbonForecast() {
  try { await getForecast(); } catch (err) { logIssue('Carbon forecast', err); }
}

// Mean forecast gCO₂/kWh + dominant band across the forecast slots
// overlapping [fromMs, toMs) — for future/active dispatch windows. null when
// no forecast slot covers the range (e.g. a window more than ~48h out).
export function carbonForecastForRange(fromMs, toMs) {
  if (!forecastSlots.length || !(toMs > fromMs)) return null;
  const hits = forecastSlots.filter(s =>
    new Date(s.to).getTime() > fromMs && new Date(s.from).getTime() < toMs);
  if (!hits.length) return null;
  const nums = hits.map(s => s.intensity?.forecast).filter(v => v != null);
  const g = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  const counts = {};
  for (const s of hits) { const i = s.intensity?.index; if (i) counts[i] = (counts[i] || 0) + 1; }
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
  return { g, index: top, band: bandOf(top) };
}

export async function loadCarbon() {
  try {
    const { slots, region } = await getForecast({ force: true });
    if (!slots.length) throw new Error('no carbon-intensity slots returned');

    const now = Date.now();
    const current = slots.find(s => new Date(s.from) <= now && now < new Date(s.to)) || slots[0];
    carbonState.currentGco2 = Math.round(current.intensity.forecast);
    carbonState.currentIndex = current.intensity.index || null;
    carbonState.region = region;

    renderCarbonCard(slots, current, region);
    logDebug('Carbon intensity', `${region}: now ${carbonState.currentGco2} g (${carbonState.currentIndex}), ${slots.length} slot(s)`);
    return true;
  } catch (err) {
    logIssue('Carbon intensity', err);
    carbonState.currentGco2 = carbonState.currentIndex = carbonState.region = null;
    $('carbon-card').classList.add('hidden');
    return false;
  }
}

function renderCarbonCard(slots, current, region) {
  $('carbon-card').classList.remove('hidden');
  $('rate-carbon').textContent = gridCarbonText();
  const idx = current.intensity.index;
  const band = bandOf(idx);
  $('carbon-value').innerHTML = `${carbonState.currentGco2}<span>g CO₂/kWh</span>`;
  // Tint the headline figure by band, the way Current rate / Live usage
  // colour theirs by state — green when the grid's clean, coral when it's not.
  $('carbon-value').style.color = band === 'low' ? 'var(--mint)' : band === 'high' ? 'var(--coral)' : 'var(--amber)';
  const pill = $('carbon-tag');
  pill.textContent = LABEL[idx] || '—';
  pill.className = 'card-tag carbon-tag-' + band;
  $('carbon-region').textContent = region;

  // Forecast strip — the next few hours at the API's native half-hour
  // resolution, capped so it stays legible on a phone-width card.
  const upcoming = slots.filter(s => new Date(s.to) > Date.now()).slice(0, 32);
  const max = Math.max(...upcoming.map(s => s.intensity.forecast || 0), 1);
  $('carbon-bars').innerHTML = upcoming.map(s => {
    const v = s.intensity.forecast ?? 0;
    const h = Math.max(2, Math.round((v / max) * 46));
    return `<div class="carbon-bar ${bandOf(s.intensity.index)}" style="height:${h}px" title="${hhmm(s.from)} · ${Math.round(v)} g"></div>`;
  }).join('');
  $('carbon-axis').innerHTML = upcoming.length
    ? `<span>${hhmm(upcoming[0].from)}</span><span>${hhmm(upcoming[Math.floor(upcoming.length / 2)].from)}</span><span>${hhmm(upcoming[upcoming.length - 1].from)}</span>`
    : '';

  // Cleanest 2-hour stretch ahead (4 consecutive half-hour slots).
  let best = null;
  for (let i = 0; i + 4 <= upcoming.length; i++) {
    const win = upcoming.slice(i, i + 4);
    const avg = win.reduce((s, x) => s + (x.intensity.forecast || 0), 0) / 4;
    if (!best || avg < best.avg) best = { avg, start: win[0].from, end: win[3].to };
  }
  if (best) {
    const s = new Date(best.start);
    // IOG's standard off-peak window is 23:30–05:30; flag the overlap when
    // the greenest stretch falls inside it — the "cheap and clean align" line.
    const startHour = s.getHours() + s.getMinutes() / 60;
    const inOffPeak = startHour >= 23.5 || startHour < 5.5;
    $('carbon-insight').innerHTML = `${leafSvg}Cleanest window <b>${hhmm(best.start)}–${hhmm(best.end)}</b> &middot; avg ${Math.round(best.avg)} g`
      + (inOffPeak ? ' &middot; overlaps your Intelligent Go off-peak' : '');
  } else {
    $('carbon-insight').textContent = '';
  }
}

const leafSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>';

/* ---------------------- Historical intensity (retrospective) ----------------------
   The card above is forward-looking ("when is the grid clean?"). This block
   answers the retrospective half ("how clean was *my* charging?") for the EV
   panel: a half-hour-keyed cache of past gCO₂/kWh, filled on demand from
   NESO's historical range endpoint, plus range-average helpers.

   Best-effort throughout — a failed fetch just leaves the cache short and
   callers treat a missing slot as "no figure", exactly like a null kWh. */

const HALF_HOUR = 30 * 60 * 1000;
// NESO caps a regional range request at 14 days; 13 keeps clear of the edge.
const MAX_SPAN_MS = 13 * 24 * 60 * 60 * 1000;

// key = slot start as 'YYYY-MM-DDTHH:mm' (UTC, half-hour-aligned)
// value = { g: gCO₂/kWh, index: NESO 5-level band string | null }
const histCache = new Map();
let histOutcode = null;      // outcode the cache was built for
let histCoveredFromMs = null; // oldest instant the cache covers (its `to` end is always ~now)

const slotKey = ms => new Date(Math.floor(ms / HALF_HOUR) * HALF_HOUR).toISOString().slice(0, 16);

async function fetchHistWindow(fromMs, toMs, outcode) {
  const from = isoMinute(new Date(fromMs));
  const to = isoMinute(new Date(toMs));
  const path = outcode
    ? `/regional/intensity/${from}/${to}/postcode/${encodeURIComponent(outcode)}`
    : `/intensity/${from}/${to}`;
  const j = await fetchJson(path);
  // Regional wraps its slots in an object like the forecast endpoint; national
  // returns the array directly. Regional publishes forecast only for past
  // periods (no regional "actual"), so forecast ?? actual covers both.
  const block = outcode ? (Array.isArray(j?.data) ? j.data[0] : j?.data) : null;
  const slots = (outcode ? block?.data : j?.data) || [];
  for (const s of slots) {
    const v = s?.intensity?.forecast ?? s?.intensity?.actual;
    if (v != null) histCache.set(slotKey(new Date(s.from).getTime()), { g: Math.round(v), index: s?.intensity?.index || null });
  }
}

// Fill the cache back to `fromMs` (up to now). Cheap to call repeatedly: it
// only fetches the span not already covered, in <=13-day chunks. A chunk
// failure aborts the rest but keeps whatever was fetched.
export async function ensureHistIntensity(fromMs) {
  const outcode = (store.creds?.outcode || '').trim() || null;
  if (outcode !== histOutcode) { histCache.clear(); histOutcode = outcode; histCoveredFromMs = null; }
  const stop = histCoveredFromMs == null ? Date.now() : histCoveredFromMs;
  if (fromMs >= stop) return; // already covered
  for (let a = fromMs; a < stop; a += MAX_SPAN_MS) {
    const b = Math.min(a + MAX_SPAN_MS, stop);
    try {
      await fetchHistWindow(a, b, outcode);
    } catch (err) {
      logIssue('Carbon history', err);
      return; // partial cache is still usable; don't advance the covered mark
    }
  }
  histCoveredFromMs = fromMs;
}

// Mean gCO₂/kWh across cached half-hour slots overlapping [fromMs, toMs).
// null when no slot in range is cached — caller then shows no figure.
export function intensityForRange(fromMs, toMs) {
  if (!(toMs > fromMs)) return null;
  let sum = 0, n = 0;
  for (let t = Math.floor(fromMs / HALF_HOUR) * HALF_HOUR; t < toMs; t += HALF_HOUR) {
    const rec = histCache.get(slotKey(t));
    if (rec != null) { sum += rec.g; n++; }
  }
  return n ? sum / n : null;
}

// Mean gCO₂/kWh across cached slots that fall in a local-time hour band
// (e.g. 16–19 for a "peak-time charge" baseline), over [fromMs, toMs).
export function intensityMeanInHourBand(fromMs, toMs, hourFrom, hourTo) {
  let sum = 0, n = 0;
  for (let t = Math.floor(fromMs / HALF_HOUR) * HALF_HOUR; t < toMs; t += HALF_HOUR) {
    const h = new Date(t).getHours() + new Date(t).getMinutes() / 60;
    if (h < hourFrom || h >= hourTo) continue;
    const rec = histCache.get(slotKey(t));
    if (rec != null) { sum += rec.g; n++; }
  }
  return n ? sum / n : null;
}

// Dominant NESO index band ('low' | 'moderate' | 'high') across cached slots
// overlapping [fromMs, toMs) — the 5-level index collapsed the same way the
// card's colour ramp does. null when nothing in range is cached.
export function carbonBandForRange(fromMs, toMs) {
  if (!(toMs > fromMs)) return null;
  const counts = {};
  for (let t = Math.floor(fromMs / HALF_HOUR) * HALF_HOUR; t < toMs; t += HALF_HOUR) {
    const rec = histCache.get(slotKey(t));
    if (rec?.index) counts[rec.index] = (counts[rec.index] || 0) + 1;
  }
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return top ? bandOf(top) : null;
}
