import { $ } from './format.js';

// Offline data cache — a last-known-good snapshot per card in localStorage,
// so a cold open with no signal shows real (stamped) figures instead of
// empty/"Unavailable" cards. Fallback-only: a snapshot is written on every
// successful render and only *read back* when a live fetch fails. Live
// usage, Carbon and Octoplus opt out (real-time / hide-on-fail by design).
//
// `stale` is the in-memory registry of which cards are currently showing a
// snapshot rather than fresh data, with the snapshot's timestamp — read by
// main.js for the sync-status line and the offline banner.

const PREFIX = 'kw_cache_';
const stale = new Map(); // cache key -> snapshot timestamp (ms)

export function cacheSnapshot(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), data }));
  } catch { /* storage full / unavailable — non-critical, skip */ }
}

// Returns { t, data } or null. `maxAgeMs`, when given, rejects a snapshot
// older than that (used for rates, where a stale schedule could actively
// mislead — a day-old EV battery % just reads as "saved").
export function readSnapshot(key, maxAgeMs) {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFIX + key) || 'null');
    if (!raw || typeof raw.t !== 'number') return null;
    if (maxAgeMs && Date.now() - raw.t > maxAgeMs) return null;
    return raw;
  } catch { return null; }
}

// Mark a card as showing a snapshot. `stampElId`, when given, is a small
// per-card "saved HH:MM" element that gets shown; clearStale hides it.
export function markStale(key, ts, stampElId) {
  stale.set(key, ts);
  if (stampElId) setStamp(stampElId, ts);
}
export function clearStale(key, stampElId) {
  stale.delete(key);
  if (stampElId) setStamp(stampElId, null);
}

export function staleInfo() {
  const times = [...stale.values()];
  return { keys: [...stale.keys()], earliest: times.length ? Math.min(...times) : null };
}

// "14:32" today, "yesterday 14:32", "3 Sep 14:32" older.
export function fmtStamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hhmm;
  if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return `yesterday ${hhmm}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hhmm}`;
}

function setStamp(elId, ts) {
  const el = $(elId);
  if (!el) return;
  el.textContent = ts == null ? '' : `saved ${fmtStamp(ts)}`;
  el.classList.toggle('hidden', ts == null);
}
