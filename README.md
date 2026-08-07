# Kraken Watch

A personal installable PWA dashboard for Octopus Energy — current rate, live
usage, Intelligent Octopus Go EV charging, consumption, and billing, all on
one screen, with your own API credentials stored only on your device.

## Current status

| Panel | What it shows | Status |
|---|---|---|
| Current rate | Now/standard/off-peak rates, next change | **Live** |
| Live usage | Current draw (W), £/hr estimate, color-coded by level | **Live** — needs an Octopus Home Mini (or similar registered device); shows a plain "not available" message if you don't have one |
| EV charging | Dispatch windows, session kWh/cost, this week — auto-collapses when idle with nothing scheduled | **Live**, via Kraken GraphQL |
| Consumption (electricity + gas) | Latest available day, last 7 days, month to date, predicted month, stacked Week/Month chart (standing charge / off-peak / peak) — tap any bar for that day's full breakdown | **Live** |
| Billing | Account balance and projected balance as two side-by-side boxes with a CREDIT/DEBIT pill, Direct Debit (estimated) with a trend indicator, month-to-date/predicted both fuels, last bill link | **Live**, Direct Debit is an estimate (see below) |

If a live call fails, that section shows "Unavailable" rather than a fake
number. Demo data is available for testing but is **off by default** —
turn it on in Settings ("Show demo data when something fails to load") if
you want to see placeholder values instead.

## Approximations worth knowing about

- **Billing cycle assumes a calendar month** (1st to end-of-month), since
  Octopus's API doesn't expose your actual billing/Direct Debit date.
- **Direct Debit amount is estimated from your last actual payment**, since
  Octopus doesn't appear to create the next payment's record until close to
  the collection date. Labeled "Direct Debit (est.)" so it's clear it's an
  assumption, not a confirmed upcoming transaction — reasonable since UK
  energy Direct Debits are periodically reviewed but typically stay fixed
  for months.
- **"Latest available day" instead of "Today"** — both electricity and gas
  smart meter data typically lag into the following day via Octopus's REST
  API, so there's rarely a same-day figure to show. The app shows whichever
  day actually has data, labeled with its real date.
- **Gas m³→kWh conversion** uses the standard industry approximation
  (×1.02264 correction factor, calorific value 39.5) — close, but your bill
  may use a slightly different value for your region/day.
- **EV dispatch rate** is approximated as today's cheapest electricity rate,
  since dispatches report kWh added but not the exact rate live at that
  moment. Usually accurate since IOG dispatches land in the off-peak window.
- **Predicted monthly cost** is a simple linear projection (today's average
  daily cost carried across the rest of the month) — won't anticipate
  seasonal changes in usage.
- **Standing charge in the consumption charts** is a flat daily estimate
  from the last fetched rate, not re-checked per day.
- **Last bill** shows the issue date and a PDF link only, not the billed
  amount — Octopus's documented `BillInterface` fields don't include a
  total directly.
- **Kraken GraphQL schema is unofficial.** EV dispatch field names are based
  on community reverse-engineering (the
  [Home Assistant Octopus Energy integration](https://github.com/BottlecapDave/HomeAssistant-OctopusEnergy)
  is the best reference), not published docs, since Octopus doesn't
  officially document this API.
- **Battery %, live charge rate, and smart-charging on/off aren't shown** —
  Octopus's dispatch data genuinely doesn't expose vehicle/charger state,
  only dispatch windows (start/end/kWh).

If numbers look wrong, check **Settings → Show diagnostics panel** — every
sync logs reading counts, rate ranges, and totals, which is usually enough
to spot the actual cause rather than guessing.

## Considered and decided against

- **Octopus Saving Sessions / Octoplus points** — the relevant GraphQL
  fields (`savingSessions`, `joinSavingSessionsCampaign`) are deprecated on
  Octopus's side as of early 2026, with no confirmed working replacement.
  Not built.
- **Native app wrapper with Lock Screen/Watch widgets** — technically
  possible via Capacitor, but genuine widgets need a separate native
  Swift/WidgetKit codebase and a paid ($99/year) Apple Developer account for
  the required App Group entitlement. Decided the cost/complexity wasn't
  worth it versus the PWA's current workflow.

## Setup

1. Get your **API key**: Octopus dashboard → Personal details → API access.
2. Get your **account number**: it's on your dashboard, format `A-AAAA1111`.
3. Host the folder somewhere with HTTPS (see below).
4. Open the app, tap the ⚙ icon, enter your API key, account number, and —
   for EV dispatch data — your Octopus account **email and password** (this
   is separate from the API key because Intelligent Go data comes from the
   same API the Octopus app itself uses, which authenticates by login
   rather than API key).

Your credentials are stored only in the browser's `localStorage` on your
device — nothing is sent anywhere except directly to Octopus's own API.

## Hosting it

Currently hosted on **GitHub Pages** (free, no deploy-credit limits worth
worrying about for personal use). Push this folder to a repo (**public**,
so GitHub Actions minutes are unlimited if you set up notifications later),
enable Pages in repo settings (`main` branch, `/root`).

Other free options if needed: Netlify Drop, Vercel — but GitHub Pages is
what this project actually uses day to day.

## Installing on iPhone

1. Open your hosted URL in **Safari** (must be Safari, not Chrome).
2. Tap the **Share** icon → **Add to Home Screen**.
3. It'll appear as a normal app icon and open full-screen.

## Updating after a change

The footer shows the app version (e.g. "v50") — check it after a deploy to
confirm the new build actually landed. On every release, bump **four**
things together, all to the same number:

1. `APP_VERSION` in `app.js`
2. `CACHE` in `sw.js`
3. The `?v=NN` query string on `styles.css` and `app.js` in **both**
   `index.html` (the `<link>`/`<script>` tags) and `sw.js` (the `SHELL`
   array) — these must match exactly, or the service worker will try to
   cache a URL that doesn't exist in the page and silently fail to update
   the shell.

**Why the query strings exist:** GitHub Pages sits behind a CDN with its
own cache timing that `updateViaCache: 'none'` can't override — that
setting only controls the *browser's* local cache, not GitHub's edge
cache. Without a version-tagged URL, a new service worker could install
successfully but still pull `styles.css`/`app.js` from a stale CDN edge
cache using the old URL, baking outdated code into an otherwise "fresh"
install. Bumping the query string on every release makes each version a
guaranteed cache miss everywhere, browser and CDN both.

This doesn't fully solve staleness for `index.html` itself, since the page
URL can't be query-string-versioned the same way (it's what people
actually navigate to) — if the page itself seems stale right after a
deploy, that's GitHub's CDN propagation delay, typically resolving within
a few minutes on its own.

If a change still doesn't appear after confirming the version bump:

1. Wait a few minutes for GitHub's CDN to catch up, then reload.
2. On iPhone: fully close the app (swipe it away in the app switcher), or
   as a last resort go to **Settings → Safari → Advanced → Website Data**,
   find the site, and remove it — clears both the HTTP cache and the
   service worker registration.

## EV push notifications

Silent push notifications when EV charging starts or finishes. A GitHub
Actions workflow checks EV status every 5 minutes and pushes a notification
on real transitions (idle/scheduled → charging, and charging → not
charging) — not on idle → scheduled, since that's already passively
visible in the app.

**This can't be tested end-to-end before you set it up** — GitHub Actions
execution and actual push delivery to your phone can only be verified once
it's live.

### 1. Add the GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret name | Value |
|---|---|
| `OCTOPUS_ACCOUNT_NUMBER` | Your account number, e.g. `A-AAAA1111` |
| `KRAKEN_EMAIL` | Your Octopus account login email |
| `KRAKEN_PASSWORD` | Your Octopus account login password |
| `VAPID_PUBLIC_KEY` | `BHGWakjQv2_jirzApA8FrA1S1Zp6PVXB29Qy1KHtbVPwKYH1Hzh5oFqiuxIDByEFIQpiJvTVrb7s0Y1_vUs-yt8` |
| `VAPID_PRIVATE_KEY` | **Do not put this in the README or commit it anywhere.** Ask whoever's helping you build this for the private key value directly (never in a file that gets committed), or generate your own pair — see below. |
| `PUSH_SUBSCRIPTION` | Added in step 2 below — leave this until then |

The public VAPID key is safe to publish — that's the nature of public-key
cryptography, and it's also embedded directly in `app.js`. The private key
is a genuine secret and must **only** ever exist as a GitHub Actions
secret, never written into a file that gets committed to the repo (a
version of this README once did exactly that — if you're rotating a key
because of that mistake, generate a fresh pair rather than reusing the one
that was exposed). To generate your own pair, Node's built-in crypto can do
it with no extra packages:

```js
const crypto = require('crypto');
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const b64url = (buf) => buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
console.log('PUBLIC:', b64url(ecdh.getPublicKey()));
const priv = ecdh.getPrivateKey();
console.log('PRIVATE:', b64url(Buffer.concat([Buffer.alloc(32 - priv.length), priv])));
```

If you generate a new pair, update `VAPID_PUBLIC_KEY` in `app.js` to match
before deploying, and set the new private key as the `VAPID_PRIVATE_KEY`
secret. If you'd already run "Enable EV notifications" with an old key
pair, you'll need to do it again after switching keys — a push
subscription is cryptographically tied to the specific key pair it was
created with.

### 2. Subscribe from the app

Settings → **EV notifications** → **"Enable EV notifications"**. Copy the
resulting JSON block into the `PUSH_SUBSCRIPTION` secret. Must be done from
the installed Home Screen app, not a Safari tab.

### 3. Test it

Repo → **Actions** tab → **EV dispatch check** workflow → **Run workflow**
to trigger a manual check without waiting for the schedule. Check the run's
logs, or Settings in the app, which shows the last checker run and push
status.

### How it works

- `.github/workflows/ev-notify.yml` — runs every 5 minutes (best-effort
  timing, not exact)
- `scripts/ev-check.mjs` — logs into Kraken, checks dispatch status,
  compares against the last known state, sends a push on a real transition
- **State lives on a separate `state` branch, not `main`.** The workflow
  fetches the previous state from that branch before checking, and commits
  the new state back to it afterward — never touching `main`, so these
  automated commits never trigger a Pages rebuild. The branch is created
  automatically on the first run; nothing to set up by hand. The app reads
  it via GitHub's raw-content URL
  (`raw.githubusercontent.com/{owner}/{repo}/state/state/ev-status.json`),
  derived automatically from the page's own address rather than hardcoded.
  These commits still keep the repo "active," which prevents GitHub's
  automatic disabling of scheduled workflows after 60 days of inactivity —
  that benefit didn't go away, it just moved off `main`.
- `sw.js` has `push` and `notificationclick` handlers; notifications are
  always sent with `silent: true`

### Known rough edges

- iOS push subscriptions can silently expire (documented WebKit behavior) —
  if notifications go quiet for suspiciously long, check Settings for
  "Subscription expired" and re-enable.
- `web-push` npm package version is pinned loosely (`^3.6.7`) — if the
  Action starts failing at `npm install` after not running for a while,
  check whether a newer major version changed its API.

## App icon

Custom PNG (`icon-192.png`, `icon-512.png`, `icon-maskable.png`), used for
both the installed home-screen icon and the in-app topbar mark. Swap those
three files for different artwork if you want, keeping the same sizes.
