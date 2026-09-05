import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanityCheck } from '../app.js';

describe('sanityCheck', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes an in-band value through unchanged and logs nothing', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(sanityCheck(1500, { min: 0, max: 30000, label: 'Live demand', expected: 'W' })).toBe(1500);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still returns an out-of-band value unchanged — never clamps or corrects', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(sanityCheck(50000, { min: 0, max: 30000, label: 'Live demand', expected: 'W' })).toBe(50000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('logs a below-minimum value too, not just above-maximum', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(sanityCheck(-5, { min: 0, max: 100, label: 'chargePointPowerOutput', expected: 'kW' })).toBe(-5);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('skips the check entirely for null, undefined, or NaN', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(sanityCheck(null, { min: 0, max: 100, label: 'x', expected: 'kW' })).toBeNull();
    expect(sanityCheck(undefined, { min: 0, max: 100, label: 'x', expected: 'kW' })).toBeUndefined();
    expect(sanityCheck(NaN, { min: 0, max: 100, label: 'x', expected: 'kW' })).toBeNaN();
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats the band boundaries themselves as in-band', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(sanityCheck(0, { min: 0, max: 100, label: 'x', expected: 'kW' })).toBe(0);
    expect(sanityCheck(100, { min: 0, max: 100, label: 'x', expected: 'kW' })).toBe(100);
    expect(spy).not.toHaveBeenCalled();
  });
});
