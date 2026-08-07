// EV dispatch status checker — runs on a GitHub Actions schedule (see
// .github/workflows/ev-notify.yml). Checks Octopus's Kraken GraphQL API for
// EV dispatch status, compares against the last known state (committed to
// state/ev-status.json in this repo), and sends a silent push notification
// on genuine transitions: idle/scheduled → charging, and charging → not
// charging. It intentionally does NOT notify on idle → scheduled, since
// that's passively visible in the app already and not time-critical.
//
// Required GitHub Actions secrets (Settings → Secrets and variables → Actions):
//   OCTOPUS_ACCOUNT_NUMBER   — e.g. A-AAAA1111
//   KRAKEN_EMAIL             — your Octopus account login email
//   KRAKEN_PASSWORD          — your Octopus account login password
//   VAPID_PUBLIC_KEY         — from the app's Settings → EV notifications
//   VAPID_PRIVATE_KEY        — generated alongside the public key, never
//                              shown in the app, only ever pasted here
//   PUSH_SUBSCRIPTION        — the subscription JSON from Settings, after
//                              tapping "Enable EV notifications" in Safari
//
// If PUSH_SUBSCRIPTION is missing or invalid, this script logs that plainly
// and exits without erroring the whole workflow — so a first-time setup gap
// doesn't show up as a scary red X in the Actions tab.

import webpush from 'web-push';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const GQL_BASE = 'https://api.octopus.energy/v1/graphql/';
const STATE_PATH = 'state/ev-status.json';

const env = (name, required = true) => {
  const v = process.env[name];
  if (required && !v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

async function gql(query, variables, token) {
  const res = await fetch(GQL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
  return json.data;
}

async function getKrakenToken(email, password) {
  const data = await gql(
    `mutation krakenTokenAuthentication($email: String!, $password: String!) {
      obtainKrakenToken(input: {email: $email, password: $password}) { token }
    }`,
    { email, password }
  );
  const token = data?.obtainKrakenToken?.token;
  if (!token) throw new Error('Kraken authentication failed — check KRAKEN_EMAIL/KRAKEN_PASSWORD secrets');
  return token;
}

async function getEvStatus(accountNumber, token) {
  const data = await gql(
    `query IOGStatus($accountNumber: String!) {
      completedDispatches(accountNumber: $accountNumber) { start end delta }
      plannedDispatches(accountNumber: $accountNumber) { start end delta }
    }`,
    { accountNumber },
    token
  );
  const planned = data.plannedDispatches || [];
  const completed = data.completedDispatches || [];
  const now = new Date();
  const activeDispatch = planned.find(d => now >= new Date(d.start) && now < new Date(d.end));
  const status = activeDispatch ? 'charging' : (planned.length ? 'scheduled' : 'idle');
  return { status, activeDispatch, planned, completed };
}

async function loadState() {
  if (!existsSync(STATE_PATH)) return { status: 'idle' };
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return { status: 'idle' };
  }
}

async function saveState(state) {
  await mkdir('state', { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function sendPush(subscription, vapidPublic, vapidPrivate, payload) {
  webpush.setVapidDetails('mailto:kraken-watch@example.invalid', vapidPublic, vapidPrivate);
  await webpush.sendNotification(subscription, JSON.stringify(payload));
}

async function main() {
  const accountNumber = env('OCTOPUS_ACCOUNT_NUMBER');
  const email = env('KRAKEN_EMAIL');
  const password = env('KRAKEN_PASSWORD');
  const vapidPublic = env('VAPID_PUBLIC_KEY');
  const vapidPrivate = env('VAPID_PRIVATE_KEY');
  const subscriptionRaw = env('PUSH_SUBSCRIPTION', false);

  const prevState = await loadState();
  const token = await getKrakenToken(email, password);
  const { status, activeDispatch, completed } = await getEvStatus(accountNumber, token);

  const nowISO = new Date().toISOString();
  const newState = { status, lastChecked: nowISO };

  let subscription = null;
  let pushError = null;
  if (subscriptionRaw) {
    try { subscription = JSON.parse(subscriptionRaw); }
    catch { pushError = 'PUSH_SUBSCRIPTION secret is not valid JSON'; }
  }

  const wasCharging = prevState.status === 'charging';
  const isCharging = status === 'charging';

  let notification = null;
  if (!wasCharging && isCharging) {
    notification = { title: 'EV charging started', body: activeDispatch ? `${new Date(activeDispatch.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(activeDispatch.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Dispatch in progress' };
  } else if (wasCharging && !isCharging) {
    const justCompleted = completed.find(d => new Date(d.end) <= new Date() && new Date(d.end) > new Date(Date.now() - 15 * 60 * 1000));
    const kwh = justCompleted ? `${(+justCompleted.delta).toFixed(1)} kWh added` : 'Charging finished';
    notification = { title: 'EV charging finished', body: kwh };
  }

  if (notification && subscription) {
    try {
      await sendPush(subscription, vapidPublic, vapidPrivate, {
        title: notification.title,
        body: notification.body,
        silent: true
      });
      newState.lastPushSent = nowISO;
      newState.lastPushOk = true;
      console.log(`Push sent: ${notification.title}`);
    } catch (err) {
      newState.lastPushOk = false;
      newState.lastPushError = String(err.message || err);
      console.error('Push failed:', err.message || err);
      // A 410 Gone means the subscription has expired/been revoked on the
      // browser side — the only fix is re-subscribing from the app.
      if (err.statusCode === 410) {
        newState.pushSubscriptionExpired = true;
        console.error('Subscription appears expired (410) — re-enable notifications in the app.');
      }
    }
  } else if (notification && !subscription) {
    newState.lastPushOk = false;
    newState.lastPushError = pushError || 'No PUSH_SUBSCRIPTION secret set — notifications not enabled yet';
    console.log(`Status changed (${prevState.status} → ${status}) but no push subscription is configured.`);
  } else {
    console.log(`No notification-worthy transition (${prevState.status} → ${status}).`);
  }

  await saveState(newState);
}

main().catch(err => {
  console.error('EV check failed:', err.message || err);
  process.exitCode = 1;
});
