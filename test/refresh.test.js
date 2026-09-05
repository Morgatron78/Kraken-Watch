import { describe, it, expect } from 'vitest';
import { shouldRunSlowTier } from '../main.js';

describe('shouldRunSlowTier', () => {
  const THIRTY_MIN = 30 * 60 * 1000;

  it('runs immediately when the slow tier has never run (lastAt is null)', () => {
    expect(shouldRunSlowTier(null, Date.now())).toBe(true);
  });

  it('does not run again just under the minimum interval', () => {
    const now = Date.now();
    expect(shouldRunSlowTier(now - (THIRTY_MIN - 1000), now)).toBe(false);
  });

  it('runs again exactly at the minimum interval', () => {
    const now = Date.now();
    expect(shouldRunSlowTier(now - THIRTY_MIN, now)).toBe(true);
  });

  it('runs again well past the minimum interval', () => {
    const now = Date.now();
    expect(shouldRunSlowTier(now - THIRTY_MIN * 5, now)).toBe(true);
  });
});
