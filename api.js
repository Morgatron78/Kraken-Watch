import { store, recordRestCall, restCallsInLastHour } from './store.js';
import { logRawIssue } from './diagnostics.js';

const REST_BASE = 'https://api.octopus.energy/v1';
const GQL_BASE = 'https://api.octopus.energy/v1/graphql/';

// Every fetch in this app previously had no timeout at all — a hung
// request in a mobile dead zone left the app on "Syncing…" indefinitely,
// since nothing would ever settle the promise either way. AbortSignal.timeout
// is available on iOS 16+ (2022), safely within range for an installed PWA
// at this point. One shared value for every call (REST, the Kraken auth
// call, and every krakenGQL query, including the heavier billing ones) —
// 15s is generous for a single request/response round trip even on a slow
// connection; if a specific query ever needs longer, revisit per-call
// rather than raising this blanket default.
const FETCH_TIMEOUT_MS = 15000;
export function isTimeoutError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}
// Named specifically in krakenGQL's timeout error (rather than just
// "GraphQL") so a hung request is diagnosable from the diagnostics panel
// alone — this file has many differently-shaped krakenGQL calls sharing one
// function, unlike octRest where the path itself already says what was
// being fetched.
export function extractGqlOperationName(query) {
  const match = /(?:query|mutation)\s+(\w+)/.exec(query);
  return match ? match[1] : 'GraphQL';
}

export async function octRest(path) {
  const { apiKey } = store.creds || {};
  recordRestCall();
  let res;
  try {
    res = await fetch(`${REST_BASE}${path}`, {
      headers: { Authorization: 'Basic ' + btoa(`${apiKey}:`) },
      cache: 'no-store', // always hit the network — a browser-cached response for
      // an identical URL (e.g. re-checking the same past day) could otherwise
      // serve stale data even after the underlying logic is fixed elsewhere.
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    if (isTimeoutError(err)) throw new Error(`REST ${path} → timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  }
  if (!res.ok) {
    // Capture what we can rather than just the status — the body especially
    // may say something Octopus-specific ("invalid token" reads very
    // differently from anything rate-limit-shaped), and this call count is
    // ours, not theirs, but directly checkable against their documented
    // 100/hour shared limit.
    let bodyText = '';
    try { bodyText = (await res.text()).slice(0, 200); } catch { /* body unreadable, proceed without it */ }
    const rateLimitHeaders = ['x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after']
      .map(h => res.headers.get(h)).filter(Boolean).join(', ');
    throw new Error(`REST ${path} → ${res.status}${bodyText ? ` | body: ${bodyText}` : ''}${rateLimitHeaders ? ` | headers: ${rateLimitHeaders}` : ''} | ${restCallsInLastHour()} REST call(s) in last hour`);
  }
  return res.json();
}

let krakenToken = null;
let krakenAccountUserId = null;

// Called from saveSettings() when credentials change, so a stale token
// from a previous account is never reused. A bare `krakenToken = null`
// reassignment from app.js isn't possible once this state is private to
// the module — ESM import bindings can't be reassigned by the importer,
// only mutated in place — hence this small exported reset function
// (same pattern as diagnostics.js's resetDiagnostics).
export function resetKrakenToken() {
  krakenToken = null;
  krakenAccountUserId = null;
}

export async function getKrakenToken() {
  if (krakenToken) return krakenToken;
  const { email, password } = store.creds || {};
  const query = `mutation krakenTokenAuthentication($email: String!, $password: String!) {
    obtainKrakenToken(input: {email: $email, password: $password}) { token }
  }`;
  let res;
  try {
    res = await fetch(GQL_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { email, password } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    if (isTimeoutError(err)) throw new Error(`Kraken auth → timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  }
  const json = await res.json();
  const token = json?.data?.obtainKrakenToken?.token;
  if (!token) throw new Error('Kraken auth failed');
  krakenToken = token;
  // The token's own `sub` claim is formatted `kraken|account-user:<id>` —
  // confirmed by decoding a real token during development — so the id
  // needed for loyaltyPointLedgers is available for free from a token
  // already fetched on every sync, no separate lookup query required.
  // Only the one claim is read, never logged, never stored beyond memory.
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const match = /^kraken\|account-user:(\d+)$/.exec(payload.sub || '');
    krakenAccountUserId = match ? match[1] : null;
  } catch { krakenAccountUserId = null; }
  return token;
}

export async function krakenGQL(query, variables, _isRetry) {
  const token = await getKrakenToken();
  const opName = extractGqlOperationName(query);
  let res;
  try {
    res = await fetch(GQL_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (err) {
    if (isTimeoutError(err)) throw new Error(`${opName} → timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw err;
  }
  const json = await res.json();
  if (json.errors) {
    // GraphQL errors often carry a specific machine code in `extensions`
    // (e.g. KT-CT-1111 vs KT-CT-9216 — both surface as the same bare
    // "Unauthorized" message, but mean different things) — previously
    // discarded, keeping only the generic message. Appending the code
    // when present means the next failure is actually diagnosable from
    // the diagnostics panel alone, not just "something's unauthorized."
    const err = json.errors[0];
    const code = err?.extensions?.errorCode || err?.extensions?.code;
    const message = err?.message || 'GraphQL error';
    // v2.213: KT-CT-1124 ("Signature of the JWT has expired") — the token
    // from getKrakenToken() is cached in memory for the life of the page,
    // with no expiry check of its own (see krakenToken above). Previously
    // this meant every Kraken call kept failing with this exact error
    // until the app was fully closed and reopened — the only thing that
    // actually cleared the stale token, confirmed via a user's diagnostics
    // screenshot showing the same code repeating across several syncs.
    // Now self-healing: on this specific code, clear the cached token and
    // retry once with a freshly obtained one, no user action needed.
    // Guarded to a single retry so a genuinely bad credential still fails
    // cleanly rather than looping.
    if (code === 'KT-CT-1124' && !_isRetry) {
      krakenToken = null;
      return krakenGQL(query, variables, true);
    }
    throw new Error(code ? `${message} (${code})` : message);
  }
  return json.data;
}

// Kraken's GraphQL equivalent of the REST-call diagnostic, but deliberately
// narrow: the account-wide 50,000 points/hour ceiling is far beyond what
// this app's real usage could plausibly reach (rateLimitInfo itself costs
// only 1 point), so a routine "X/50,000 used" line would just be noise.
// The one thing actually worth surfacing is isBlocked — if GraphQL calls
// ever started failing en masse for no obvious reason, this rules a block
// in or out immediately rather than guessing, the same way capturing real
// response bodies (not just status codes) cracked the toggle-destruction
// bug rather than an assumption about rate limiting. Silent no-op on
// failure or when not blocked — this is a best-effort diagnostic, not
// something that should itself count as a sync failure.
export async function checkRateLimitBlocked() {
  try {
    const data = await krakenGQL(`
      query RateLimitInfo {
        rateLimitInfo {
          pointsAllowanceRateLimit { isBlocked ttl }
        }
      }`, {});
    const info = data?.rateLimitInfo?.pointsAllowanceRateLimit;
    if (info?.isBlocked) {
      const resetMins = info.ttl ? Math.max(0, Math.round((info.ttl * 1000 - Date.now()) / 60000)) : null;
      logRawIssue(`GraphQL account blocked for exceeding its points allowance${resetMins !== null ? ` — resets in ~${resetMins}m` : ''}`);
    }
  } catch (err) { /* best-effort — see comment above */ }
}
