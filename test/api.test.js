import { describe, it, expect } from 'vitest';
import { isTimeoutError, extractGqlOperationName } from '../app.js';

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
