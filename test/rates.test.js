import { describe, it, expect } from 'vitest';
import { rateAt, bucketReadingsByDay } from '../app.js';

describe('rateAt', () => {
  // Rows as produced by fetchElecRates/fetchGasRates: sorted ascending by
  // `from`, each { from, to, rate } with timestamps in epoch ms.
  const rows = [
    { from: 1000, to: 2000, rate: 10 },
    { from: 2000, to: 3000, rate: 20 },
    { from: 3000, to: 4000, rate: 30 },
  ];

  it('picks the most recent period that started at or before the timestamp', () => {
    expect(rateAt(rows, 2500)).toBe(20);
  });

  it('matches exactly on a period boundary (from === timestamp)', () => {
    expect(rateAt(rows, 2000)).toBe(20);
  });

  it('returns the last known rate past the final period, not null', () => {
    expect(rateAt(rows, 5000)).toBe(30);
  });

  it('returns null before every known period', () => {
    expect(rateAt(rows, 500)).toBeNull();
  });

  it('returns null for an empty rows array', () => {
    expect(rateAt([], 2000)).toBeNull();
  });
});

describe('bucketReadingsByDay', () => {
  const now = new Date(2026, 0, 10); // 10 Jan 2026, local time

  function reading(daysAgo, hour = 12) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour);
    return { interval_start: d.toISOString(), consumption: 1 };
  }

  it('places today at the last index and n-1 days ago at the first', () => {
    const results = [reading(0), reading(6)];
    const buckets = bucketReadingsByDay(results, 7, now);
    expect(buckets).toHaveLength(7);
    expect(buckets[6]).toEqual([results[0]]); // today
    expect(buckets[0]).toEqual([results[1]]); // 6 days ago = oldest of a 7-day window
  });

  it('groups multiple readings from the same local day into one bucket', () => {
    const results = [reading(0, 0), reading(0, 12), reading(0, 23)];
    const buckets = bucketReadingsByDay(results, 7, now);
    expect(buckets[6]).toHaveLength(3);
  });

  it('drops a reading that falls outside the requested window', () => {
    const results = [reading(10)]; // 10 days ago, window is only 7 days
    const buckets = bucketReadingsByDay(results, 7, now);
    expect(buckets.flat()).toHaveLength(0);
  });

  it('returns n empty buckets for no readings', () => {
    const buckets = bucketReadingsByDay([], 7, now);
    expect(buckets).toHaveLength(7);
    expect(buckets.every(b => b.length === 0)).toBe(true);
  });
});
