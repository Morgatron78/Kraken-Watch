import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  cacheSnapshot, readSnapshot, markStale, clearStale, staleInfo, fmtStamp,
} from '../offline.js';

beforeEach(() => localStorage.clear());

describe('cacheSnapshot / readSnapshot', () => {
  it('round-trips a value with a timestamp', () => {
    cacheSnapshot('rates', [{ from: 1, rate: 7.5 }]);
    const snap = readSnapshot('rates');
    expect(snap.data).toEqual([{ from: 1, rate: 7.5 }]);
    expect(typeof snap.t).toBe('number');
    expect(Math.abs(snap.t - Date.now())).toBeLessThan(1000);
  });

  it('returns null for a key that was never written', () => {
    expect(readSnapshot('nope')).toBeNull();
  });

  it('returns null for corrupt stored JSON rather than throwing', () => {
    localStorage.setItem('kw_cache_bad', '{not json');
    expect(readSnapshot('bad')).toBeNull();
  });

  it('returns null for a stored object missing a numeric timestamp', () => {
    localStorage.setItem('kw_cache_weird', JSON.stringify({ data: 1 }));
    expect(readSnapshot('weird')).toBeNull();
  });

  it('rejects a snapshot older than maxAgeMs, keeps a fresh one', () => {
    localStorage.setItem('kw_cache_old', JSON.stringify({ t: Date.now() - 60_000, data: 'x' }));
    expect(readSnapshot('old', 30_000)).toBeNull();       // 60s old, 30s cap
    expect(readSnapshot('old', 120_000).data).toBe('x');  // within a 2min cap
    expect(readSnapshot('old').data).toBe('x');            // no cap = any age
  });

  it('does not throw when localStorage.setItem throws (quota/unavailable)', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    try {
      expect(() => cacheSnapshot('rates', { a: 1 })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('stale registry', () => {
  it('tracks marked keys and reports the earliest timestamp', () => {
    expect(staleInfo()).toEqual({ keys: [], earliest: null });
    markStale('ev', 3000);
    markStale('rates', 1000);
    const info = staleInfo();
    expect(info.keys.sort()).toEqual(['ev', 'rates']);
    expect(info.earliest).toBe(1000);
  });

  it('clearStale removes a key; earliest recomputes from what remains', () => {
    markStale('ev', 3000);
    markStale('rates', 1000);
    clearStale('rates');
    expect(staleInfo()).toEqual({ keys: ['ev'], earliest: 3000 });
    clearStale('ev');
    expect(staleInfo()).toEqual({ keys: [], earliest: null });
  });
});

describe('fmtStamp', () => {
  it('shows just HH:MM for a timestamp earlier today', () => {
    const d = new Date();
    d.setHours(8, 5, 0, 0);
    expect(fmtStamp(d.getTime())).toMatch(/^\d{2}:\d{2}$/);
  });

  it('prefixes "yesterday" for a timestamp on the previous calendar day', () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(8, 5, 0, 0);
    expect(fmtStamp(d.getTime())).toMatch(/^yesterday \d{2}:\d{2}$/);
  });

  it('shows a day/month for anything older', () => {
    const d = new Date();
    d.setDate(d.getDate() - 5);
    d.setHours(8, 5, 0, 0);
    expect(fmtStamp(d.getTime())).toMatch(/^\d{1,2} [A-Za-z]{3,5} \d{2}:\d{2}$/);
  });
});
