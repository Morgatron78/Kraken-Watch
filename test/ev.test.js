import { describe, it, expect, beforeEach } from 'vitest';
import { formatVehicleName, realProblemLabel, buildEVWeekBuckets, buildEVMonthBuckets } from '../ev.js';
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

describe('realProblemLabel', () => {
  it('returns a friendly label for a genuine (non-benign) cause', () => {
    expect(realProblemLabel({ problems: [{ cause: 'COMMUNICATION_ERROR' }] })).toBe('Comms error');
  });

  it('returns the raw enum for a real but unmapped cause', () => {
    expect(realProblemLabel({ problems: [{ cause: 'SOME_NEW_ERROR' }] })).toBe('SOME_NEW_ERROR');
  });

  it('ignores benign outcomes (target/full/no-charge/boost/tapering)', () => {
    expect(realProblemLabel({ problems: [{ cause: 'SOC_LIMIT_REACHED' }] })).toBeNull();
    expect(realProblemLabel({ problems: [{ cause: 'FULL_CHARGE' }] })).toBeNull();
    expect(realProblemLabel({ problems: [{ cause: 'BOOST_CHARGING' }] })).toBeNull();
  });

  it('reads a truncationCause the same way as a cause', () => {
    expect(realProblemLabel({ problems: [{ truncationCause: 'DISCONNECTED' }] })).toBe('Disconnected early');
    expect(realProblemLabel({ problems: [{ truncationCause: 'UNKNOWN_TRUNCATION_CAUSE' }] })).toBe('Charge cut short');
  });

  it('returns the first real problem, skipping a leading benign one', () => {
    expect(realProblemLabel({ problems: [
      { cause: 'FULL_CHARGE' },
      { cause: 'POWER_DISCREPANCY' },
    ] })).toBe('Power discrepancy');
  });

  it('returns null for a session with no problems', () => {
    expect(realProblemLabel({ problems: [] })).toBeNull();
    expect(realProblemLabel({})).toBeNull();
  });
});

describe('buildEVWeekBuckets', () => {
  // Sat 10 Jan 2026; the 7-day window is Sun 4 Jan .. Sat 10 Jan.
  const now = new Date(2026, 0, 10, 9, 0);

  it('produces 7 day buckets with single-letter weekday labels', () => {
    const { buckets, labels, dateFormat } = buildEVWeekBuckets([], now);
    expect(buckets).toHaveLength(7);
    expect(labels).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(dateFormat).toBe('weekday');
  });

  it('files a session under its day and splits SMART vs BOOST kWh', () => {
    const sessions = [
      { start: new Date(2026, 0, 7, 2, 0).toISOString(), type: 'SMART', energyAdded: { value: 8 } },   // Wed -> idx 3
      { start: new Date(2026, 0, 7, 20, 0).toISOString(), type: 'BOOST', energyAdded: { value: 3 } },   // Wed -> idx 3
      { start: new Date(2026, 0, 10, 1, 0).toISOString(), type: 'SMART', energyAdded: { value: -5 } },  // Sat -> idx 6, abs
    ];
    const { buckets } = buildEVWeekBuckets(sessions, now);
    expect(buckets[3]).toMatchObject({ smart: 8, boost: 3 });
    expect(buckets[3].sessions).toHaveLength(2);
    expect(buckets[6].smart).toBe(5);
  });

  it('ignores sessions outside the 7-day window', () => {
    const sessions = [
      { start: new Date(2026, 0, 1, 12, 0).toISOString(), type: 'SMART', energyAdded: { value: 9 } },  // before window
      { start: new Date(2026, 0, 20, 12, 0).toISOString(), type: 'SMART', energyAdded: { value: 9 } }, // after window
    ];
    const { buckets } = buildEVWeekBuckets(sessions, now);
    expect(buckets.reduce((s, b) => s + b.smart + b.boost, 0)).toBe(0);
  });

  it('treats a missing energyAdded as zero kWh, not NaN', () => {
    const sessions = [{ start: new Date(2026, 0, 8, 3, 0).toISOString(), type: 'SMART' }];
    const { buckets } = buildEVWeekBuckets(sessions, now);
    expect(buckets[4].smart).toBe(0);
    expect(buckets[4].sessions).toHaveLength(1);
  });
});

describe('buildEVMonthBuckets', () => {
  // 10 Jan 2026 -> daysElapsedInMonth = 10, so 10 buckets (days 1..10).
  const now = new Date(2026, 0, 10, 9, 0);

  it('produces one bucket per elapsed day, labelled by day number', () => {
    const { buckets, labels, dateFormat } = buildEVMonthBuckets([], now);
    expect(buckets).toHaveLength(10);
    expect(labels).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(dateFormat).toBe('dayOfMonth');
  });

  it('files a session under its day-of-month bucket', () => {
    const sessions = [
      { start: new Date(2026, 0, 7, 2, 0).toISOString(), type: 'SMART', energyAdded: { value: 6 } },
      { start: new Date(2026, 0, 7, 22, 0).toISOString(), type: 'BOOST', energyAdded: { value: 2 } },
    ];
    const { buckets } = buildEVMonthBuckets(sessions, now);
    expect(buckets[6]).toMatchObject({ smart: 6, boost: 2 });
    expect(buckets[6].sessions).toHaveLength(2);
  });

  it('ignores a session dated after the elapsed days', () => {
    const sessions = [{ start: new Date(2026, 0, 15, 12, 0).toISOString(), type: 'SMART', energyAdded: { value: 5 } }];
    const { buckets } = buildEVMonthBuckets(sessions, now);
    expect(buckets.reduce((s, b) => s + b.smart, 0)).toBe(0);
  });
});
