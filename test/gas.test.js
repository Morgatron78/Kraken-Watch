import { describe, it, expect, beforeEach } from 'vitest';
import { m3ToKwh, detectGasUnit } from '../app.js';

describe('m3ToKwh', () => {
  beforeEach(() => localStorage.clear());

  it('applies the standard volume-correction × calorific-value ÷ 3.6 formula', () => {
    // 1 m3 at the default 40.0 calorific value (no Settings override saved)
    expect(m3ToKwh(1)).toBeCloseTo((1 * 1.02264 * 40) / 3.6, 6);
  });

  it('respects a Settings-configured calorific value over the 40.0 default', () => {
    localStorage.setItem('kw_creds', JSON.stringify({ calorificValue: 39.5 }));
    expect(m3ToKwh(1)).toBeCloseTo(1 * 1.02264 * 39.5 / 3.6, 6);
  });

  it('scales linearly with the input volume', () => {
    expect(m3ToKwh(10)).toBeCloseTo(m3ToKwh(1) * 10, 6);
  });
});

describe('detectGasUnit', () => {
  // Both threshold values match what costForRange/lastNDaysCost (DAILY) and
  // fetchYearMonthly (MONTHLY) already used before this was unified — see
  // the comment above GAS_M3_THRESHOLD_DAILY in app.js for why the numbers
  // themselves were kept rather than re-tuned.
  const DAILY = 50;
  const MONTHLY = 500;

  it('detects m3 for realistic daily gas readings (a few m3 at most)', () => {
    expect(detectGasUnit([0.5, 1.8, 0.3, 2.1], DAILY)).toBe('CUBIC_METERS');
  });

  it('detects kWh for realistic daily kWh totals on cold days', () => {
    expect(detectGasUnit([15, 65, 40, 90], DAILY)).toBe('KILOWATT_HOUR');
  });

  it('detects m3 for a genuine winter month total, at the monthly threshold', () => {
    // ~150 m3 for a large house in a cold month is real gas usage, and
    // would be wrongly read as kWh under the daily threshold — this is
    // exactly why the two thresholds must stay separate.
    expect(detectGasUnit([150, 180, 120], MONTHLY)).toBe('CUBIC_METERS');
  });

  it('detects kWh for realistic monthly kWh totals', () => {
    expect(detectGasUnit([900, 1100, 1200], MONTHLY)).toBe('KILOWATT_HOUR');
  });

  it('decides from the maximum across the whole batch, not the first value', () => {
    // Pathological on purpose (a real meter wouldn't mix scales like this)
    // — this is specifically testing that a small first reading can't lock
    // in the wrong verdict, which is exactly the bug being fixed: the old
    // per-site checks read only `results[0]` (or a bucket's own first
    // reading), so this exact shape — tiny first value, one later value
    // that's clearly kWh-scale — used to be misread as CUBIC_METERS and
    // would have wrongly converted every value in the batch, including the
    // one that was never m3 to begin with.
    expect(detectGasUnit([0.2, 60, 0.3, 0.1], DAILY)).toBe('KILOWATT_HOUR');
  });

  it('ignores non-finite values when deciding', () => {
    expect(detectGasUnit([NaN, undefined, 0.4], DAILY)).toBe('CUBIC_METERS');
  });

  it('defaults to kWh (no conversion) for an empty batch, rather than guessing', () => {
    expect(detectGasUnit([], DAILY)).toBe('KILOWATT_HOUR');
  });
});
