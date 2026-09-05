import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store, obfuscateApiKey, logSyncAttempt, getSyncLog } from '../store.js';

beforeEach(() => localStorage.clear());

describe('obfuscateApiKey', () => {
  it('shows the first 12 characters plus an ellipsis for anything longer', () => {
    expect(obfuscateApiKey('sk_live_1234567890')).toBe('sk_live_1234…');
  });

  it('shows a short key in full', () => {
    expect(obfuscateApiKey('short')).toBe('short');
  });

  it('shows a placeholder for a missing key rather than an empty string', () => {
    expect(obfuscateApiKey('')).toBe('(none)');
    expect(obfuscateApiKey(null)).toBe('(none)');
    expect(obfuscateApiKey(undefined)).toBe('(none)');
  });
});

describe('store.creds', () => {
  it('returns null when nothing is saved', () => {
    expect(store.creds).toBeNull();
  });

  it('round-trips whatever is saved', () => {
    store.creds = { apiKey: 'x', accountNumber: 'A-TEST0001' };
    expect(store.creds).toEqual({ apiKey: 'x', accountNumber: 'A-TEST0001' });
  });

  it('clear() removes it', () => {
    store.creds = { apiKey: 'x' };
    store.clear();
    expect(store.creds).toBeNull();
  });

  it('returns null rather than throwing on corrupted stored JSON', () => {
    localStorage.setItem('kw_creds', '{not valid json');
    expect(store.creds).toBeNull();
  });
});

describe('logSyncAttempt / getSyncLog', () => {
  it('starts empty', () => {
    expect(getSyncLog()).toEqual([]);
  });

  it('records an entry with an obfuscated key, not the real one', () => {
    logSyncAttempt('fast', { Rates: true }, 'sk_live_1234567890', []);
    const log = getSyncLog();
    expect(log).toHaveLength(1);
    expect(log[0].tier).toBe('fast');
    expect(log[0].k).toBe('sk_live_1234…');
    expect(log[0].k).not.toContain('567890');
  });

  it('caps detail line length at 300 characters', () => {
    logSyncAttempt('slow', { Billing: false }, 'key', ['x'.repeat(1000)]);
    expect(getSyncLog()[0].d[0]).toHaveLength(300);
  });

  it('caps the log at 60 entries, dropping the oldest first', () => {
    for (let i = 0; i < 65; i++) logSyncAttempt('fast', { Rates: true }, 'key', []);
    const log = getSyncLog();
    expect(log).toHaveLength(60);
  });
});

// recordRestCall/restCallsInLastHour keep an in-memory copy of the log
// (loaded once at module-init time) alongside the localStorage copy —
// unlike everything else in this module, which reads localStorage fresh on
// every call. That in-memory copy would otherwise leak between tests in
// this file despite clearing localStorage in beforeEach (they all share
// the one module instance the static import above resolved), so each test
// here resets the module registry and re-imports fresh instead.
describe('recordRestCall / restCallsInLastHour', () => {
  afterEach(() => vi.restoreAllMocks());

  async function freshStoreModule() {
    vi.resetModules();
    return import('../store.js');
  }

  it('starts at zero', async () => {
    const { restCallsInLastHour } = await freshStoreModule();
    expect(restCallsInLastHour()).toBe(0);
  });

  it('counts calls made within the last hour', async () => {
    const { recordRestCall, restCallsInLastHour } = await freshStoreModule();
    recordRestCall();
    recordRestCall();
    expect(restCallsInLastHour()).toBe(2);
  });

  it('excludes calls older than an hour', async () => {
    const { recordRestCall, restCallsInLastHour } = await freshStoreModule();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now - 2 * 60 * 60 * 1000);
    recordRestCall();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(restCallsInLastHour()).toBe(0);
  });
});
