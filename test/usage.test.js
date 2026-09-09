import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { hasUsableDays, loadMonthData, loadYearData, fuelData } from '../usage.js';
import { store } from '../store.js';
import { resetDiagnostics } from '../diagnostics.js';

function fakeResponse({ ok = true, status = 200, json = {} } = {}) {
  return { ok, status, json: async () => json, text: async () => '', headers: { get: () => null } };
}

// A consumption reading dated to the start of *today* (local) always lands in
// the last day-bucket whatever the month length, and a non-trivial value marks
// that day hasData:true even before settlement — so these tests don't depend
// on which day of the month they run.
function readingToday(consumption) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { interval_start: start.toISOString(), interval_end: start.toISOString(), consumption };
}

const RATE_ROW = { valid_from: '2000-01-01T00:00:00Z', valid_to: null, value_inc_vat: 7 };

beforeEach(() => {
  localStorage.clear();
  resetDiagnostics();
  fuelData.elec = null;
  fuelData.gas = null;
  store.creds = {
    apiKey: 'test_key',
    gasMprn: 'g-mprn', gasSerial: 'g-serial',
    gasProductCode: 'GAS-PROD', gasTariffCode: 'G-1R-TARIFF',
  };
});
afterEach(() => vi.unstubAllGlobals());

describe('hasUsableDays', () => {
  it('is false for a missing / non-array value', () => {
    expect(hasUsableDays(undefined)).toBe(false);
    expect(hasUsableDays(null)).toBe(false);
  });

  it('is false for an all-empty array — a failed fetch, or an early-month load before any day settled', () => {
    expect(hasUsableDays([{ hasData: false }, { hasData: false }])).toBe(false);
    expect(hasUsableDays([])).toBe(false);
  });

  it('is true as soon as one day carries real data', () => {
    expect(hasUsableDays([{ hasData: false }, { hasData: true }])).toBe(true);
  });

  it('is true for a year-style array (every month hasData:true)', () => {
    expect(hasUsableDays([{ month: 0, kwh: 100, hasData: true }])).toBe(true);
  });
});

describe('loadMonthData — a failed lazy fetch does not stick', () => {
  it('retries on the next call after the consumption fetch fails', async () => {
    // First attempt: the consumption call fails; lastNDaysCost swallows it and
    // returns an all-empty array, which must NOT be cached as final.
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url).includes('/gas-tariffs/')) return Promise.resolve(fakeResponse({ json: { results: [RATE_ROW] } }));
      return Promise.reject(new TypeError('Failed to fetch'));
    }));
    await loadMonthData('gas');
    expect(hasUsableDays(fuelData.gas.month)).toBe(false);

    // Second attempt: consumption succeeds — the earlier empty result must not
    // have latched, so this call actually re-fetches and fills the chart data.
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url).includes('/gas-tariffs/')) return Promise.resolve(fakeResponse({ json: { results: [RATE_ROW] } }));
      return Promise.resolve(fakeResponse({ json: { results: [readingToday(3)] } }));
    }));
    await loadMonthData('gas');
    expect(hasUsableDays(fuelData.gas.month)).toBe(true);
  });

  it('does not re-fetch once usable data is cached', async () => {
    const okFetch = vi.fn((url) => {
      if (String(url).includes('/gas-tariffs/')) return Promise.resolve(fakeResponse({ json: { results: [RATE_ROW] } }));
      return Promise.resolve(fakeResponse({ json: { results: [readingToday(3)] } }));
    });
    vi.stubGlobal('fetch', okFetch);
    await loadMonthData('gas');
    expect(hasUsableDays(fuelData.gas.month)).toBe(true);

    const callsAfterFirst = okFetch.mock.calls.length;
    await loadMonthData('gas');
    expect(okFetch.mock.calls.length).toBe(callsAfterFirst); // early-returned, no second fetch
  });
});

describe('loadYearData — a failed lazy fetch does not stick', () => {
  it('leaves the year retryable after a failure, then fills it on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await loadYearData('gas');
    expect(hasUsableDays(fuelData.gas.year)).toBe(false); // stored as [], not latched

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fakeResponse({ json: { results: [{ interval_start: '2026-01-01T00:00:00Z', consumption: 900 }] } })
    ));
    await loadYearData('gas');
    expect(hasUsableDays(fuelData.gas.year)).toBe(true);
  });

  it('does not re-fetch once the year has loaded', async () => {
    const okFetch = vi.fn().mockResolvedValue(
      fakeResponse({ json: { results: [{ interval_start: '2026-01-01T00:00:00Z', consumption: 900 }] } })
    );
    vi.stubGlobal('fetch', okFetch);
    await loadYearData('gas');
    const callCount = okFetch.mock.calls.length;
    await loadYearData('gas');
    expect(okFetch.mock.calls.length).toBe(callCount);
  });
});
