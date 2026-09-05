import { describe, it, expect, vi, afterEach } from 'vitest';
import { $, fmtGBP, fmtP, fmtKwh, fmtT } from '../format.js';

describe('fmtGBP', () => {
  it('formats a positive amount with two decimal places', () => {
    expect(fmtGBP(42.5)).toBe('£42.50');
  });

  it('takes the absolute value — sign is conveyed elsewhere (e.g. a DEBIT/CREDIT pill), not by a minus sign', () => {
    expect(fmtGBP(-42.5)).toBe('£42.50');
  });
});

describe('fmtP', () => {
  it('formats pence to two decimal places with a trailing p', () => {
    expect(fmtP(7.5)).toBe('7.50p');
  });
});

describe('fmtKwh', () => {
  it('formats kWh to one decimal place', () => {
    expect(fmtKwh(3.456)).toBe('3.5 kWh');
  });
});

describe('fmtT', () => {
  it('formats a timestamp as a HH:MM time', () => {
    // en-GB locale hour/minute formatting — exact separator/AM-PM presentation
    // is locale-dependent, so just check the digits are right rather than
    // asserting an exact string that could vary by test environment locale.
    const result = fmtT('2026-01-10T14:05:00Z');
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('$ (dev-mode element lookup)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the element when it exists', () => {
    document.body.innerHTML = '<div id="real"></div>';
    expect($('real')).not.toBeNull();
  });

  it('returns null for a missing element rather than throwing', () => {
    expect($('does-not-exist')).toBeNull();
  });

  it('warns on a missing element in dev mode (Vitest runs with import.meta.env.DEV = true)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    $('also-missing');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('also-missing'));
  });

  it('does not warn when the element is found', () => {
    document.body.innerHTML = '<div id="present"></div>';
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    $('present');
    expect(spy).not.toHaveBeenCalled();
  });
});
