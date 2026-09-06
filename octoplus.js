import { $ } from './format.js';
import { store } from './store.js';
import { krakenGQL, krakenBackendGQL } from './api.js';
import { logIssue, logDebug } from './diagnostics.js';

// Octoplus — points balance and upcoming Saving Sessions / Free Electricity
// events. An earlier Octopoints attempt (octopoints-archive.js) hit a hard
// "Unauthorized" on loyaltyPointsBalance; this uses the field set the mature
// Home Assistant integration relies on.
//
// Gated on a live octoplusAccountInfo probe: if that errors or the account
// isn't ENROLLED, the whole card stays hidden. Points comes from the main
// GraphQL host; Saving Sessions only exist on the backend host
// (krakenBackendGQL) — each is its own query so one failure doesn't sink
// the other. Best-effort side feed, kept out of the sync-status calc in
// main.js (like carbon).

const hhmm = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = iso => {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

export async function loadOctoplus() {
  const acct = store.creds?.accountNumber;
  if (!acct) { $('octoplus-card').classList.add('hidden'); return false; }

  // Cheapest possible check that the account is on Octoplus and the field
  // set is reachable on this token.
  let enrolled = false;
  try {
    const j = await krakenGQL(
      `query OctoplusEnrolled($accountNumber: String!) {
        octoplusAccountInfo(accountNumber: $accountNumber) { enrollmentStatus }
      }`, { accountNumber: acct });
    const status = j?.octoplusAccountInfo?.enrollmentStatus ?? null;
    enrolled = status === 'ENROLLED';
    logDebug('Octoplus', `enrollmentStatus = ${status ?? 'null'}`);
  } catch (err) {
    logIssue('Octoplus', err);
    $('octoplus-card').classList.add('hidden');
    return false;
  }
  if (!enrolled) { $('octoplus-card').classList.add('hidden'); return false; }

  const [points, sessions] = await Promise.allSettled([
    fetchPoints(), fetchSavingSessions(acct),
  ]);

  const sess = sessions.status === 'fulfilled' ? sessions.value : null;
  $('octoplus-card').classList.remove('hidden');
  renderPoints(points.status === 'fulfilled' ? points.value : null);
  renderSessions(sess);
  renderResults(sess);
  return true;
}

async function fetchPoints() {
  // The direct loyaltyPointsBalance query stays Unauthorized (KT-CT-1111)
  // on this account, so the balance is read off the ledger: the newest
  // entry's balanceCarriedForward is the running total. It comes back as a
  // numeric *string* ("100"), so it has to be coerced.
  try {
    const j = await krakenGQL(
      `query OctoplusLedgers { loyaltyPointLedgers { balanceCarriedForward postedAt } }`, {});
    const ledgers = (j?.loyaltyPointLedgers || []).slice()
      .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));
    const bal = ledgers
      .map(l => l?.balanceCarriedForward)
      .filter(v => v != null && v !== '')
      .map(Number)
      .find(Number.isFinite);
    logDebug('Octoplus points', `${ledgers.length} ledger(s), newest balance ${bal ?? 'none'}`);
    return Number.isFinite(bal) ? bal : null;
  } catch (err) {
    logIssue('Octoplus points', err);
    return null;
  }
}

async function fetchSavingSessions(acct) {
  try {
    const j = await krakenBackendGQL(
      `query OctoplusSavingSessions($accountNumber: String!) {
        savingSessions {
          events(includeDev: false) {
            id code rewardPerKwhInOctoPoints startAt endAt eventType devEvent
            targetRegion { regionId }
          }
          account(accountNumber: $accountNumber) {
            hasJoinedCampaign
            signedUpMeterPoint { regionId }
            joinedEvents { eventId startAt endAt eventType rewardGivenInOctoPoints }
          }
        }
      }`, { accountNumber: acct });
    const ss = j?.savingSessions;
    if (!ss) return null;
    const myRegion = ss.account?.signedUpMeterPoint?.regionId ?? null;
    // Filter the (often long, all-region, history-inclusive) event list down
    // to real events that could apply to this account: not a dev event, and
    // either national or targeted at this account's grid region.
    const events = (ss.events || []).filter(e =>
      !e.devEvent && (!e.targetRegion || e.targetRegion.regionId == null || e.targetRegion.regionId === myRegion));
    const joinedEvents = ss.account?.joinedEvents || [];
    const now = Date.now();
    const future = events.filter(e => new Date(e.endAt).getTime() > now);
    logDebug('Octoplus saving sessions',
      `${(ss.events || []).length} raw / ${events.length} filtered / ${future.length} upcoming, ${joinedEvents.length} joined; ` +
      `next: ${future.slice(0, 3).map(e => `[${e.eventType || '?'}] ${new Date(e.startAt).toLocaleString('en-GB')}`).join('  ·  ') || '—'}`);
    return {
      events,
      joinedEvents,
      hasJoinedCampaign: !!ss.account?.hasJoinedCampaign,
      joinedIds: new Set(joinedEvents.map(e => String(e.eventId))),
    };
  } catch (err) {
    logIssue('Octoplus saving sessions', err);
    return null;
  }
}

function renderPoints(balance) {
  $('octoplus-points').innerHTML = balance == null
    ? '—<span>pts</span>'
    : `${balance.toLocaleString('en-GB')}<span>pts</span>`;
}

const MAX_SESSIONS = 4;

// The savingSessions feed mixes event types. Octopus's own names, tidied.
const KIND = {
  SAVING_SESSION: 'Saving Session',
  WEEKEND_HAPPY_HOUR: 'Weekend Happy Hour',
  FREE_ELECTRICITY: 'Free electricity',
  POWER_UP: 'Free electricity',
};
const kindLabel = t => KIND[t]
  || (t || '').replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase())
  || 'Event';

// Promos like Weekend Happy Hour arrive as a run of back-to-back hourly
// events; collapse a contiguous run of the same type into one block.
// `events` carry a pre-normalised `.reward`; `combine` merges it across a
// run — max for an upcoming pts/kWh rate, sum for points actually earned.
function groupSessions(events, combine = Math.max) {
  const sorted = [...events].sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const groups = [];
  for (const e of sorted) {
    const r = Number(e.reward) || 0;
    const last = groups[groups.length - 1];
    if (last && last.eventType === e.eventType
        && new Date(last.endAt).getTime() === new Date(e.startAt).getTime()) {
      last.endAt = e.endAt;
      last.reward = combine(last.reward, r);
    } else {
      groups.push({ eventType: e.eventType, startAt: e.startAt, endAt: e.endAt, ids: [], reward: r });
    }
    groups[groups.length - 1].ids.push(String(e.id ?? e.eventId));
  }
  return groups;
}
const sum = (a, b) => a + b;

function renderSessions(data) {
  const el = $('octoplus-sessions');
  if (!data) { el.innerHTML = ''; return; }
  const now = Date.now();
  const groups = groupSessions((data.events || [])
    .filter(e => new Date(e.endAt).getTime() > now)
    .map(e => ({ ...e, reward: e.rewardPerKwhInOctoPoints })));
  const upcoming = groups.slice(0, MAX_SESSIONS);
  const more = groups.length - upcoming.length;

  let html = '<div class="octoplus-label">Upcoming events</div>';
  if (!upcoming.length) {
    html += `<div class="octoplus-empty">${data.hasJoinedCampaign ? 'Signed up — nothing scheduled right now.' : 'Nothing scheduled right now.'}</div>`;
  } else {
    html += upcoming.map(g => {
      const joined = g.ids.some(id => data.joinedIds.has(id));
      const reward = g.reward ? `${g.reward} pts/kWh` : '';
      return `<div class="octoplus-session">
        <div class="octoplus-session-when"><b>${dayLabel(g.startAt)}</b> ${hhmm(g.startAt)}–${hhmm(g.endAt)}</div>
        <div class="octoplus-session-meta">${kindLabel(g.eventType)}${reward ? ` · ${reward}` : ''}${joined ? ' · <span class="octoplus-joined">Joined</span>' : ''}</div>
      </div>`;
    }).join('');
    if (more > 0) html += `<div class="octoplus-empty">+${more} more</div>`;
  }
  el.innerHTML = html;
}

// Sessions/happy-hours the account actually took part in that have finished,
// with the points they earned. joinedEvents only covers the current
// campaign, so this is "so far this season", not lifetime.
function renderResults(data) {
  const el = $('octoplus-results');
  if (!data) { el.innerHTML = ''; return; }
  const now = Date.now();
  const done = groupSessions((data.joinedEvents || [])
    .filter(e => e.endAt && new Date(e.endAt).getTime() <= now)
    .map(e => ({ ...e, id: e.eventId, reward: e.rewardGivenInOctoPoints })), sum)
    .sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
  if (!done.length) { el.innerHTML = ''; return; }

  const total = done.reduce((s, g) => s + g.reward, 0);
  let html = '<div class="octoplus-label">Your results</div>';
  html += done.slice(0, MAX_SESSIONS).map(g => `<div class="octoplus-session">
    <div class="octoplus-session-when"><b>${dayLabel(g.startAt)}</b> ${hhmm(g.startAt)}–${hhmm(g.endAt)}</div>
    <div class="octoplus-session-meta">${kindLabel(g.eventType)}${g.reward ? ` · earned <span class="octoplus-earned">${Math.round(g.reward).toLocaleString('en-GB')} pts</span>` : ''}</div>
  </div>`).join('');
  if (total > 0) html += `<div class="octoplus-empty">${done.length} taken part in · ${Math.round(total).toLocaleString('en-GB')} pts earned this campaign</div>`;
  el.innerHTML = html;
}
