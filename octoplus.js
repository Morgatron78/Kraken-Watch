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

  $('octoplus-card').classList.remove('hidden');
  renderPoints(points.status === 'fulfilled' ? points.value : null);
  renderSessions(sessions.status === 'fulfilled' ? sessions.value : null);
  return true;
}

async function fetchPoints() {
  try {
    const j = await krakenGQL(
      `query OctoplusPoints { loyaltyPointLedgers { balanceCarriedForward } }`, {});
    const ledgers = j?.loyaltyPointLedgers || [];
    // Take the first numeric balance rather than assuming [0] carries it.
    const bal = ledgers.map(l => l?.balanceCarriedForward).find(v => typeof v === 'number');
    logDebug('Octoplus points', `${ledgers.length} ledger(s), balance ${bal ?? 'none'}`);
    return bal ?? null;
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
            joinedEvents { eventId }
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
    logDebug('Octoplus saving sessions', `${(ss.events || []).length} raw, ${events.length} after dev/region filter, joined campaign: ${!!ss.account?.hasJoinedCampaign}`);
    return {
      events,
      hasJoinedCampaign: !!ss.account?.hasJoinedCampaign,
      joinedIds: new Set((ss.account?.joinedEvents || []).map(e => String(e.eventId))),
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

function renderSessions(data) {
  const el = $('octoplus-sessions');
  if (!data) { el.innerHTML = ''; return; }
  const now = Date.now();
  // Only sessions still to end, soonest first — then cap, since the raw
  // list can carry a whole season of events.
  const future = (data.events || [])
    .filter(e => new Date(e.endAt).getTime() > now)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const upcoming = future.slice(0, MAX_SESSIONS);
  const more = future.length - upcoming.length;

  let html = '<div class="octoplus-label">Saving Sessions</div>';
  if (!upcoming.length) {
    html += `<div class="octoplus-empty">${data.hasJoinedCampaign ? 'Signed up — none scheduled right now.' : 'None scheduled right now.'}</div>`;
  } else {
    html += upcoming.map(e => {
      const joined = data.joinedIds.has(String(e.id));
      const reward = e.rewardPerKwhInOctoPoints ? `${e.rewardPerKwhInOctoPoints} pts/kWh` : '';
      const kind = /FREE|POWER_UP/i.test(e.eventType || '') ? 'Free electricity' : 'Saving Session';
      return `<div class="octoplus-session">
        <div class="octoplus-session-when"><b>${dayLabel(e.startAt)}</b> ${hhmm(e.startAt)}–${hhmm(e.endAt)}</div>
        <div class="octoplus-session-meta">${kind}${reward ? ` · ${reward}` : ''}${joined ? ' · <span class="octoplus-joined">Joined</span>' : ''}</div>
      </div>`;
    }).join('');
    if (more > 0) html += `<div class="octoplus-empty">+${more} more scheduled</div>`;
  }
  el.innerHTML = html;
}
