import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isTimeoutError, extractGqlOperationName, octRest, getKrakenToken, krakenGQL, resetKrakenToken, checkRateLimitBlocked } from '../api.js';
import { store } from '../store.js';
import { getSyncIssues, resetDiagnostics } from '../diagnostics.js';

function fakeResponse({ ok = true, status = 200, json = {}, text = '', headers = {} } = {}) {
  return {
    ok, status,
    json: async () => json,
    text: async () => text,
    headers: { get: (h) => headers[h] ?? null },
  };
}

beforeEach(() => {
  localStorage.clear();
  resetDiagnostics();
  resetKrakenToken();
  store.creds = { apiKey: 'test_key', email: 'a@b.com', password: 'pw' };
});
afterEach(() => vi.unstubAllGlobals());

describe('isTimeoutError', () => {
  it('recognises the modern AbortSignal.timeout() error name', () => {
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(true);
  });

  it('recognises a plain AbortError as a timeout too', () => {
    expect(isTimeoutError({ name: 'AbortError' })).toBe(true);
  });

  it('does not misclassify an ordinary network error', () => {
    expect(isTimeoutError(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('handles a nullish error without throwing', () => {
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

describe('extractGqlOperationName', () => {
  it('extracts a named query operation', () => {
    const query = `
      query AccountBalance($accountNumber: String!) {
        account(accountNumber: $accountNumber) { balance }
      }`;
    expect(extractGqlOperationName(query)).toBe('AccountBalance');
  });

  it('extracts a named mutation operation', () => {
    const query = `mutation krakenTokenAuthentication($email: String!, $password: String!) {
      obtainKrakenToken(input: {email: $email, password: $password}) { token }
    }`;
    expect(extractGqlOperationName(query)).toBe('krakenTokenAuthentication');
  });

  it('falls back to a generic label for an anonymous operation', () => {
    expect(extractGqlOperationName('{ viewer { id } }')).toBe('GraphQL');
  });
});

describe('octRest', () => {
  it('sends the API key as HTTP Basic auth and returns the parsed JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse({ json: { results: [1, 2] } }));
    vi.stubGlobal('fetch', fetchMock);
    const data = await octRest('/some-path');
    expect(data).toEqual({ results: [1, 2] });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/some-path');
    expect(opts.headers.Authorization).toBe('Basic ' + btoa('test_key:'));
  });

  it('throws an error including the status, body, and rest-call count on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fakeResponse({ ok: false, status: 401, text: '{"detail":"Invalid API key."}' })
    ));
    await expect(octRest('/bad')).rejects.toThrow(/401.*Invalid API key/s);
  });

  it('turns a timeout abort into a clear, path-specific error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    await expect(octRest('/slow')).rejects.toThrow(/\/slow.*timed out after 15s/);
  });

  it('propagates a non-timeout network error unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(octRest('/x')).rejects.toThrow('Failed to fetch');
  });
});

describe('getKrakenToken', () => {
  function jwtWithSub(sub) {
    const payload = btoa(JSON.stringify({ sub }));
    return `header.${payload}.sig`;
  }

  it('returns the token from a successful auth call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      fakeResponse({ json: { data: { obtainKrakenToken: { token: jwtWithSub('kraken|account-user:12345') } } } })
    ));
    const token = await getKrakenToken();
    expect(token).toBe(jwtWithSub('kraken|account-user:12345'));
  });

  it('caches the token — a second call does not fetch again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ json: { data: { obtainKrakenToken: { token: jwtWithSub('kraken|account-user:1') } } } })
    );
    vi.stubGlobal('fetch', fetchMock);
    await getKrakenToken();
    await getKrakenToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resetKrakenToken() forces the next call to fetch again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      fakeResponse({ json: { data: { obtainKrakenToken: { token: jwtWithSub('kraken|account-user:1') } } } })
    );
    vi.stubGlobal('fetch', fetchMock);
    await getKrakenToken();
    resetKrakenToken();
    await getKrakenToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a clear error when the auth call succeeds but returns no token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeResponse({ json: { data: {} } })));
    await expect(getKrakenToken()).rejects.toThrow('Kraken auth failed');
  });
});

describe('krakenGQL', () => {
  function tokenFetch() {
    return fakeResponse({ json: { data: { obtainKrakenToken: { token: 'header.' + btoa(JSON.stringify({ sub: 'kraken|account-user:1' })) + '.sig' } } } });
  }

  it('returns data on a clean response', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenFetch())
      .mockResolvedValueOnce(fakeResponse({ json: { data: { account: { balance: 100 } } } })));
    const data = await krakenGQL('query X { viewer { id } }', {});
    expect(data).toEqual({ account: { balance: 100 } });
  });

  it('appends the error code when present, for a non-expired-token error', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenFetch())
      .mockResolvedValueOnce(fakeResponse({ json: { errors: [{ message: 'Unauthorized', extensions: { errorCode: 'KT-CT-9216' } }] } })));
    await expect(krakenGQL('query X { a }', {})).rejects.toThrow('Unauthorized (KT-CT-9216)');
  });

  it('self-heals on an expired-token error (KT-CT-1124): clears the token and retries once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenFetch()) // initial token fetch
      .mockResolvedValueOnce(fakeResponse({ json: { errors: [{ message: 'Signature of the JWT has expired', extensions: { errorCode: 'KT-CT-1124' } }] } })) // first attempt: expired
      .mockResolvedValueOnce(tokenFetch()) // re-fetch token after reset
      .mockResolvedValueOnce(fakeResponse({ json: { data: { ok: true } } })); // retry succeeds
    vi.stubGlobal('fetch', fetchMock);
    const data = await krakenGQL('query X { a }', {});
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('turns a timeout into an error naming the actual GraphQL operation, not a generic label', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenFetch())
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    await expect(krakenGQL('query AccountBalance { a }', {})).rejects.toThrow(/AccountBalance.*timed out after 15s/);
  });
});

describe('checkRateLimitBlocked', () => {
  function tokenFetch() {
    return fakeResponse({ json: { data: { obtainKrakenToken: { token: 'header.' + btoa(JSON.stringify({ sub: 'kraken|account-user:1' })) + '.sig' } } } });
  }

  it('logs an issue (with reset time) when the account is blocked', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenFetch())
      .mockResolvedValueOnce(fakeResponse({ json: { data: { rateLimitInfo: { pointsAllowanceRateLimit: { isBlocked: true, ttl: Math.floor(Date.now() / 1000) + 600 } } } } })));
    await checkRateLimitBlocked();
    const issues = getSyncIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('blocked');
    expect(issues[0]).toContain('resets in ~');
  });

  it('does nothing when not blocked', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(tokenFetch())
      .mockResolvedValueOnce(fakeResponse({ json: { data: { rateLimitInfo: { pointsAllowanceRateLimit: { isBlocked: false } } } } })));
    await checkRateLimitBlocked();
    expect(getSyncIssues()).toEqual([]);
  });

  it('is best-effort — swallows a failure rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    await expect(checkRateLimitBlocked()).resolves.toBeUndefined();
  });
});
