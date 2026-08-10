// ============================================================================
// ARCHIVED: EV panel — legacy dispatch-only path (loadEVLegacy)
// Retired: v2.9x, during the SmartFlex EV rewrite
// ============================================================================
//
// This was the ORIGINAL loadEV() implementation, used from the EV panel's
// very first version through the SmartFlex rewrite. It queried only
// completedDispatches/plannedDispatches (no battery %, no real session
// cost, no SMART/BOOST distinction), and approximated kWh cost as
// today's off-peak rate rather than a real per-session figure.
//
// It was kept as a defensive fallback during the SmartFlex rewrite (if the
// new devices→chargingSessions query failed, this ran instead), but was
// removed once the decision was made to show a genuine "Unavailable" state
// on failure rather than silently substituting different, older data.
//
// Kept here for reference — if the SmartFlex path ever needs reverting
// (e.g. Octopus deprecates/breaks the newer schema), this is the last
// known-working version of the old approach. The extractElementIds used
// here (ev-slots-dispatch, ev-battery-row, ev-view-toggle, ev-week-legend,
// ev-slots-session) still exist in the current index.html, so this should
// still work as-is if reinstated, provided the element structure hasn't
// changed further since this was archived.
//
// To reinstate: paste this function back into app.js, and in loadEV(),
// change the catch/failure branch to call loadEVLegacy() instead of
// showing the Unavailable state directly.
// ============================================================================

async function loadEVLegacy() {
  try {
    const data = await krakenGQL(`
      query IOGStatus($accountNumber: String!) {
        completedDispatches(accountNumber: $accountNumber) { start end delta }
        plannedDispatches(accountNumber: $accountNumber) { start end delta }
      }`, { accountNumber: store.creds.accountNumber });

    const planned = data.plannedDispatches || [];
    const completed = data.completedDispatches || [];

    const now = new Date();
    const activeDispatch = planned.find(d => now >= new Date(d.start) && now < new Date(d.end));
    $('ev-tag').textContent = activeDispatch ? 'CHARGING' : (planned.length ? 'SCHEDULED' : 'IDLE');
    if (activeDispatch) $('ev-tag').className = 'card-tag tag-pink';
    else if (planned.length) $('ev-tag').className = 'card-tag tag-amber';
    else $('ev-tag').className = 'card-tag tag-dim';

    applyEvCollapse(!!activeDispatch || planned.length > 0);

    if (planned[0]) {
      const s = new Date(planned[0].start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const e = new Date(planned[0].end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('ev-ready').textContent = `${s} – ${e}`;
    } else {
      $('ev-ready').textContent = 'None scheduled';
    }

    $('ev-battery-row').classList.add('hidden');
    $('ev-view-toggle').classList.add('hidden');
    $('ev-week-legend').classList.add('hidden');
    $('ev-slots-session').classList.add('hidden');
    $('ev-slots-dispatch').classList.remove('hidden');

    const slots = $('ev-slots-dispatch');
    slots.innerHTML = '';
    [...completed].reverse().forEach(d => {
      slots.insertAdjacentHTML('beforeend', `<div class="slot done"><span>✓ ${new Date(d.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(d.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><b>Completed · ${Math.abs(+d.delta).toFixed(1)} kWh</b></div>`);
    });
    planned.forEach(d => {
      const isActive = now >= new Date(d.start) && now < new Date(d.end);
      const label = isActive ? '● Dispatching now' : 'Planned';
      const cls = isActive ? ' active' : ' scheduled';
      slots.insertAdjacentHTML('beforeend', `<div class="slot${cls}"><span>${new Date(d.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(d.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><b>${label}</b></div>`);
    });
    if (!slots.children.length) slots.innerHTML = '<div class="slot">No dispatch windows scheduled</div>';

    const rateP = cachedOffPeakRateP ?? 7.5;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todaysCompleted = completed.filter(d => new Date(d.start) >= startOfToday);
    const sessionKwh = todaysCompleted.reduce((s, d) => s + (+d.delta), 0);
    $('ev-added').textContent = `${Math.abs(sessionKwh).toFixed(1)} kWh`;
    $('ev-cost').textContent = fmtGBP(sessionKwh * rateP / 100);
    $('ev-avg-rate').textContent = `${rateP.toFixed(1)}p/kWh`;

    const dayTotals = Array(7).fill(0);
    const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - 6);
    completed.forEach(d => {
      const dayIdx = Math.floor((new Date(d.start) - startOfWeek) / 86400000);
      if (dayIdx >= 0 && dayIdx < 7) dayTotals[dayIdx] += (+d.delta);
    });
    renderWeekBars('ev-week', dayTotals, '', v => `${Math.abs(v).toFixed(1)} kWh`);
    const weekKwh = dayTotals.reduce((a, b) => a + b, 0);
    $('ev-week-totals').innerHTML = `<span><b>${Math.abs(weekKwh).toFixed(1)} kWh</b> added</span><span><b>${fmtGBP(weekKwh * rateP / 100)}</b> total</span><span><b>${rateP.toFixed(1)}p</b> avg</span>`;

    return true;
  } catch (err) {
    logIssue('EV dispatch', err);
    if (demoFallbackEnabled()) {
      populateDemoEV();
    } else {
      $('ev-tag').textContent = 'Unavailable';
      $('ev-tag').className = 'card-tag tag-dim';
      $('ev-ready').textContent = '—';
      $('ev-added').textContent = '—';
      $('ev-cost').textContent = '—';
      $('ev-avg-rate').textContent = '—';
      $('ev-battery-row').classList.add('hidden');
      $('ev-view-toggle').classList.add('hidden');
      $('ev-week-legend').classList.add('hidden');
      $('ev-slots-dispatch').innerHTML = '<div class="slot">Unavailable right now</div>';
      renderWeekBars('ev-week', [0, 0, 0, 0, 0, 0, 0], '');
      $('ev-week-totals').innerHTML = '<span>—</span><span>—</span><span>—</span>';
    }
    return false;
  }
}
