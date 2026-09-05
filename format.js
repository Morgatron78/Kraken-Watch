// Small formatting/DOM-lookup primitives shared across the whole app — no
// dependencies of their own, so every other module can import from here
// safely.

// __APP_VERSION__ / __BUILD_SHA__ are injected by Vite at build time (see
// vite.config.js). The SHA half is what confirms a given deploy landed — it
// changes on every commit, unlike the manually-bumped semver half. sw.js's
// cache name is versioned independently, from the precache manifest content
// (see the comment at the top of sw.js). Lives in this shared leaf because
// both the footer and diagnostics.js's "App version: ..." line need the
// same formatted string.
export const APP_VERSION = `v${__APP_VERSION__} (${__BUILD_SHA__})`;

// Dev-only warning on a missing id — surfaces HTML/JS drift (a renamed or
// removed element an existing $() call still expects) as a console message
// pointing at the exact id, rather than as a downstream "null is not an
// object" wherever the caller next tried to use it. See scripts/check-ids.mjs
// for the build-time version of this same check. import.meta.env.DEV is
// false in a production build, so this adds nothing to what ships.
export const $ = import.meta.env.DEV
  ? (id) => {
      const el = document.getElementById(id);
      if (!el) console.warn(`[kw] missing #${id}`);
      return el;
    }
  : (id) => document.getElementById(id);

export const fmtGBP = (n) => `£${Math.abs(n).toFixed(2)}`;
export const fmtP = (n) => `${n.toFixed(2)}p`;
export const fmtKwh = (v) => `${v.toFixed(1)} kWh`;
export const fmtT = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Elapsed-time formatter for the EV session row — Octopus's own app shows
// this next to the time range.
export function formatElapsed(startISO, endISO) {
  const ms = new Date(endISO) - new Date(startISO);
  if (!(ms > 0)) return '';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
