import { $ } from './format.js';
import { store } from './store.js';
import { krakenGQL } from './api.js';
import { logIssue, logDebug } from './diagnostics.js';

// Octoplus — points balance, Saving Sessions, and any unused Wheel of
// Fortune spins. An earlier Octopoints attempt (octopoints-archive.js) hit
// a hard "Unauthorized" on loyaltyPointsBalance; this uses the newer field
// set the mature Home Assistant integration relies on
// (octoplusAccountInfo / savingSessions / wheelOfFortuneSpinsAllowed), and
// fires each part as its own query so one 401 doesn't sink the rest.
//
// Gated on a live octoplusAccountInfo probe: if that errors or the account
// isn't ENROLLED, the whole card stays hidden — no point spending calls on
// a feature the account can't use. Best-effort side feed, kept out of the
// sync-status calc in main.js (like carbon).

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

  // Probe first — cheapest possible check that the account is on Octoplus
  // and the field set is reachable on this token.
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

  const [points, sessions, spins] = await Promise.allSettled([
    fetchPoints(), fetchSavingSessions(acct), fetchSpins(acct),
  ]);

  $('octoplus-card').classList.remove('hidden');
  renderPoints(points.status === 'fulfilled' ? points.value : null);
  renderSessions(sessions.status === 'fulfilled' ? sessions.value : null);
  renderSpins(spins.status === 'fulfilled' ? spins.value : null);
  return true;
}

async function fetchPoints() {
  try {
    const j = await krakenGQL(
      `query OctoplusPoints { loyaltyPointLedgers { balanceCarriedForward } }`, {});
    const bal = (j?.loyaltyPointLedgers || [])[0]?.balanceCarriedForward;
    return typeof bal === 'number' ? bal : null;
  } catch (err) {
    logIssue('Octoplus points', err);
    return null;
  }
}

async function fetchSavingSessions(acct) {
  try {
    const j = await krakenGQL(
      `query OctoplusSavingSessions($accountNumber: String!) {
        savingSessions {
          events(includeDev: false) { id code rewardPerKwhInOctoPoints startAt endAt eventType }
          account(accountNumber: $accountNumber) {
            hasJoinedCampaign
            joinedEvents { eventId startAt endAt rewardGivenInOctoPoints eventType }
          }
        }
      }`, { accountNumber: acct });
    const ss = j?.savingSessions;
    return ss ? {
      events: ss.events || [],
      hasJoinedCampaign: !!ss.account?.hasJoinedCampaign,
      joinedIds: new Set((ss.account?.joinedEvents || []).map(e => String(e.eventId))),
    } : null;
  } catch (err) {
    logIssue('Octoplus saving sessions', err);
    return null;
  }
}

async function fetchSpins(acct) {
  try {
    const j = await krakenGQL(
      `query OctoplusSpins($accountNumber: String!) {
        electricity: wheelOfFortuneSpinsAllowed(fuelType: ELECTRICITY, accountNumber: $accountNumber) { spinsAllowed }
        gas: wheelOfFortuneSpinsAllowed(fuelType: GAS, accountNumber: $accountNumber) { spinsAllowed }
      }`, { accountNumber: acct });
    const e = Number(j?.electricity?.spinsAllowed) || 0;
    const g = Number(j?.gas?.spinsAllowed) || 0;
    return e + g;
  } catch (err) {
    logIssue('Octoplus spins', err);
    return null;
  }
}

function renderPoints(balance) {
  if (balance == null) {
    $('octoplus-points').innerHTML = '—<span>pts</span>';
    $('octoplus-points-tag').textContent = '—';
    return;
  }
  const fmt = balance.toLocaleString('en-GB');
  $('octoplus-points').innerHTML = `${fmt}<span>pts</span>`;
  $('octoplus-points-tag').textContent = `${fmt} pts`;
}

function renderSessions(data) {
  const el = $('octoplus-sessions');
  if (!data) { el.innerHTML = ''; return; }
  const now = Date.now();
  const upcoming = (data.events || [])
    .filter(e => new Date(e.endAt).getTime() > now)
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt));

  let html = '<div class="octoplus-label">Saving Sessions</div>';
  if (!upcoming.length) {
    html += `<div class="octoplus-empty">${data.hasJoinedCampaign ? 'Signed up — no sessions scheduled right now.' : 'None scheduled right now.'}</div>`;
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
  }
  el.innerHTML = html;
}

function renderSpins(count) {
  const el = $('octoplus-spins');
  if (!count) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="octoplus-spins-line">${wheelSvg}You have <b>${count}</b> unused Wheel of Fortune spin${count === 1 ? '' : 's'}</div>`;
}

const wheelSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px;color:var(--amber);"><circle cx="12" cy="12" r="10"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/><line x1="19.1" y1="4.9" x2="4.9" y2="19.1"/></svg>';
