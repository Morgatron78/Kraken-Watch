import { describe, it, expect, beforeEach } from 'vitest';
import { formatVehicleName } from '../ev.js';
import { formatElapsed } from '../format.js';
import { estimateSessionCostP } from '../rates.js';
import { bucketTelemetryByMinute } from '../live-usage.js';

describe('bucketTelemetryByMinute', () => {
  it('buckets a point into its minutes-ago slot, oldest first', () => {
    const now = new Date('2026-01-10T12:00:00Z');
    const points = [
      { readAt: '2026-01-10T11:31:00Z', consumptionDelta: 5 },  // 29 min ago -> idx 0 (oldest still in window)
      { readAt: '2026-01-10T12:00:00Z', consumptionDelta: 7 },  // now -> idx 29 (latest)
    ];
    const buckets = bucketTelemetryByMinute(points, now);
    expect(buckets).toHaveLength(30);
    expect(buckets[0]).toBe(5);
    expect(buckets[29]).toBe(7);
  });

  it('drops a point exactly on the 30-minute window boundary', () => {
    const now = new Date('2026-01-10T12:00:00Z');
    const points = [{ readAt: '2026-01-10T11:30:00Z', consumptionDelta: 99 }]; // exactly 30 min ago
    const buckets = bucketTelemetryByMinute(points, now);
    expect(buckets.reduce((s, v) => s + v, 0)).toBe(0);
  });

  it('sums multiple points landing in the same minute', () => {
    const now = new Date('2026-01-10T12:00:00Z');
    const points = [
      { readAt: '2026-01-10T12:00:00Z', consumptionDelta: 3 },
      { readAt: '2026-01-10T11:59:30Z', consumptionDelta: 4 }, // 30s earlier, same minutesAgo=0 bucket
    ];
    const buckets = bucketTelemetryByMinute(points, now);
    expect(buckets[29]).toBe(7);
  });

  it('drops a point outside the 30-minute window', () => {
    const now = new Date('2026-01-10T12:00:00Z');
    const points = [{ readAt: '2026-01-10T11:00:00Z', consumptionDelta: 99 }]; // 60 min ago
    const buckets = bucketTelemetryByMinute(points, now);
    expect(buckets.reduce((s, v) => s + v, 0)).toBe(0);
  });

  it('treats a missing consumptionDelta as zero rather than NaN', () => {
    const now = new Date('2026-01-10T12:00:00Z');
    const points = [{ readAt: '2026-01-10T12:00:00Z' }];
    const buckets = bucketTelemetryByMinute(points, now);
    expect(buckets[29]).toBe(0);
  });
});

describe('estimateSessionCostP', () => {
  const rates = { offPeakP: 7.5, standardP: 28.9 };

  it('prices a Smart session at the off-peak rate', () => {
    const session = { type: 'SMART', energyAdded: { value: 10 } };
    expect(estimateSessionCostP(session, rates)).toBeCloseTo(75, 5);
  });

  it('prices a Boost session at the standard rate', () => {
    const session = { type: 'BOOST', energyAdded: { value: 10 } };
    expect(estimateSessionCostP(session, rates)).toBeCloseTo(289, 5);
  });

  it('takes the absolute value of a negative energyAdded reading', () => {
    const session = { type: 'SMART', energyAdded: { value: -2 } };
    expect(estimateSessionCostP(session, rates)).toBeCloseTo(15, 5);
  });

  it('returns null when rates are not available, rather than guessing', () => {
    const session = { type: 'SMART', energyAdded: { value: 10 } };
    expect(estimateSessionCostP(session, { offPeakP: null, standardP: 28.9 })).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('formats minutes only under an hour', () => {
    expect(formatElapsed('2026-01-10T00:00:00Z', '2026-01-10T00:45:00Z')).toBe('45m');
  });

  it('formats hours and minutes over an hour', () => {
    expect(formatElapsed('2026-01-10T00:00:00Z', '2026-01-10T02:15:00Z')).toBe('2h 15m');
  });

  it('returns an empty string for a zero or negative duration', () => {
    expect(formatElapsed('2026-01-10T00:00:00Z', '2026-01-10T00:00:00Z')).toBe('');
    expect(formatElapsed('2026-01-10T01:00:00Z', '2026-01-10T00:00:00Z')).toBe('');
  });
});

describe('formatVehicleName', () => {
  beforeEach(() => localStorage.clear());

  it('returns empty title/caption when there is no make', () => {
    expect(formatVehicleName('', 'Some Model')).toEqual({ title: '', caption: '' });
  });

  it('includes the model and the fallback battery kWh when no override is saved', () => {
    const { title, caption } = formatVehicleName('Polestar', '2 Standard Range');
    expect(title).toBe(' — Polestar');
    expect(caption).toBe('2 Standard Range · 67 kWh usable');
  });

  it('omits the model but still shows the battery note when model is blank', () => {
    const { caption } = formatVehicleName('Polestar', '');
    expect(caption).toBe('67 kWh usable');
  });
});
