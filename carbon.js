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

async function fetchJson(path) {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`carbonintensity ${path} → ${res.status}`);
  return res.json();
}

export async function loadCarbon() {
  const outcode = (store.creds?.outcode || '').trim();
  try {
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
  const idx = current.intensity.index;
  $('carbon-value').innerHTML = `${carbonState.currentGco2}<span>g CO₂/kWh</span>`;
  const pill = $('carbon-tag');
  pill.textContent = LABEL[idx] || '—';
  pill.className = 'card-tag carbon-tag-' + bandOf(idx);
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
