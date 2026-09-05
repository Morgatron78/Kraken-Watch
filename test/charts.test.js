import { describe, it, expect } from 'vitest';
import { chartMax, isChartDense, chartLabelOrBlank } from '../app.js';

describe('chartMax', () => {
  it('returns the largest value in the array', () => {
    expect(chartMax([2, 8, 3])).toBe(8);
  });

  it('floors at 0.01 for an all-zero dataset, avoiding a divide-by-zero downstream', () => {
    expect(chartMax([0, 0, 0])).toBe(0.01);
  });

  it('floors at 0.01 for an empty array too', () => {
    expect(chartMax([])).toBe(0.01);
  });
});

describe('isChartDense', () => {
  it('is not dense at or under the default threshold (10)', () => {
    expect(isChartDense(7)).toBe(false);
    expect(isChartDense(10)).toBe(false);
  });

  it('is dense just past the default threshold', () => {
    expect(isChartDense(11)).toBe(true);
  });

  it('is dense for a real month-length bar count', () => {
    expect(isChartDense(31)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(isChartDense(5, 3)).toBe(true);
    expect(isChartDense(3, 3)).toBe(false);
  });
});

describe('chartLabelOrBlank', () => {
  it('always shows the real label when not dense', () => {
    for (let i = 0; i < 7; i++) {
      expect(chartLabelOrBlank('Mon', i, false)).toBe('Mon');
    }
  });

  it('shows every 5th label (by index) when dense, &nbsp; otherwise', () => {
    expect(chartLabelOrBlank('15', 0, true)).toBe('15');
    expect(chartLabelOrBlank('15', 5, true)).toBe('15');
    expect(chartLabelOrBlank('15', 1, true)).toBe('&nbsp;');
    expect(chartLabelOrBlank('15', 4, true)).toBe('&nbsp;');
  });

  it('respects a custom everyNth', () => {
    expect(chartLabelOrBlank('x', 3, true, 3)).toBe('x');
    expect(chartLabelOrBlank('x', 2, true, 3)).toBe('&nbsp;');
  });
});
