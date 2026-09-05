import { describe, it, expect } from 'vitest';
import { trendVsAverage } from '../insights.js';

// This is the exact logic the README documents as having shipped inverted
// twice: colour/arrow must follow whether spending MORE or LESS than
// average is the good outcome (less is good), not the raw arithmetic sign
// convention used elsewhere (the balance-trend pill, where "up" is good).
describe('trendVsAverage', () => {
  it('treats spending below average as good news (up/mint, down arrow)', () => {
    const { cssClass, text } = trendVsAverage(8, 10); // 20% below average
    expect(cssClass).toBe('up');
    expect(text).toContain('↓');
    expect(text).toContain('below');
  });

  it('treats spending above average as bad news (down/coral, up arrow)', () => {
    const { cssClass, text } = trendVsAverage(12, 10); // 20% above average
    expect(cssClass).toBe('down');
    expect(text).toContain('↑');
    expect(text).toContain('above');
  });

  it('treats exactly-average spending as good news, not bad', () => {
    const { cssClass } = trendVsAverage(10, 10);
    expect(cssClass).toBe('up');
  });

  it('does not divide by zero when the average is zero', () => {
    const { diffPct, cssClass } = trendVsAverage(5, 0);
    expect(diffPct).toBe(0);
    expect(cssClass).toBe('up');
  });
});
