import { store, demoFallbackEnabled } from './store.js';
import { $, fmtGBP } from './format.js';
import { logIssue, logDebug } from './diagnostics.js';
import { krakenGQL } from './api.js';
import { renderWeekBars } from './charts.js';
import { rateState, fetchStandingCharge, fetchGasRates, rateAt, m3ToKwh, costForRange } from './rates.js';
import {
  fuelData, dayTotal, breakdownRow, daysElapsedInMonth, daysInMonth, isoDate,
  renderFuelPanel, lastNDaysElecSplitWithStanding, lastNDaysGasSplitWithStanding,
} from './usage.js';

// Renders a balance figure as a hero number with a small "in credit"/"owed"
// suffix, coloring coral only when genuinely in debit — the exceptional case
// worth flagging, not the normal one.
function renderBalanceFigure(valueId, pillId, pounds) {
  const el = $(valueId);
  const owed = pounds < 0;
  el.classList.toggle('owed', owed);
  el.textContent = fmtGBP(pounds);
  const pill = $(pillId);
  if (pill) {
    pill.textContent = owed ? 'DEBIT' : 'CREDIT';
    pill.className = 'status-pill ' + (owed ? 'debit' : 'credit');
  }
}

// Populated by loadBilling() with figures Insights reuses rather than
// recomputing — the balance and its trend are already fully calculated
// there, no reason to duplicate that logic. nextPaymentAmount/Date feed the
// 12-month balance forecast (each future cycle assumes this same amount
// recurs monthly — same assumption the single-cycle trend already made).
export let billingState = { balancePounds: null, trend: null, hasNextPayment: false, nextPaymentAmount: null };

// Tap-to-breakdown state for the bill-total-over-time chart. billMonthsData
// is repopulated on every loadBilling() run so the click handler always has
// the current grouped-by-month figures to hand, without needing to
// recompute or re-fetch anything.
let selectedBillMonth = null;
export let billMonthsData = [];

// Bill-year chart's tap-to-breakdown — same pattern as renderBreakdown
// above, reusing the same .breakdown-box/.breakdown-row markup and CSS.
// Reads from billMonthsData (populated whenever the chart itself renders)
// rather than needing its own fetch or access to loadBilling's internals.
function renderBillYearBreakdown(index) {
  const box = $('bill-year-breakdown');
  if (!box) return;
  if (index === null || !billMonthsData[index]) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  const m = billMonthsData[index];
  const monthLabel = new Date(m.year, m.month, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const billNote = m.bills.length > 1 ? ` · ${m.bills.length} bills` : '';
  const linkHtml = m.bills.length === 1 && m.bills[0].temporaryUrl
    ? `<div style="margin-top:10px;"><a class="bh-link" href="${m.bills[0].temporaryUrl}" target="_blank" aria-label="View bill">View Bill</a></div>`
    : '';
  box.innerHTML = `<div class="breakdown-date">${monthLabel}${billNote}</div>`
    + breakdownRow('Gas', 'seg-gas-usage', fmtGBP(m.gas), null)
    + breakdownRow('Electricity', 'seg-peak', fmtGBP(m.elec), null)
    + `<div class="breakdown-total"><span>Total</span><span>${fmtGBP(m.total)}</span></div>`
    + linkHtml;
}

// Moves the persistent #bill-history-toggle button back to its safe static
// position (directly before #bill-history) if it's currently living inside
// #last-bill-row from a previous sync. This is the fully-diagnosed root
// cause of billing intermittently failing — nothing to do with the API,
// rate limits, or credentials. loadBilling() moves this same element INTO
// last-bill-row's rendered content on a successful render; FOUR separate
// places in this file reassign last-bill-row's innerHTML on a later call
// (the real render, the demo-data path, the generic-failure path, and the
// optimistic per-sync reset) — any one of them, if the toggle is currently
// parked inside, destroys it outright, and every later reference throws
// "null is not an object" (or "Argument 1 ('node') ... must be an
// instance of Node" if a stale null gets passed to appendChild) before any
// of loadBilling()'s own try/catch blocks even run. An earlier version of
// this fix only guarded the real-render path and missed the other three —
// calling this once, unconditionally, at the very top of loadBilling()
// covers all four regardless of which one runs first.
function restoreToggleToSafety() {
  const existingToggle = document.getElementById('bill-history-toggle');
  const billHistoryEl = document.getElementById('bill-history');
  if (existingToggle && billHistoryEl && existingToggle.nextSibling !== billHistoryEl) {
    billHistoryEl.parentElement.insertBefore(existingToggle, billHistoryEl);
  }
}

export async function loadBilling() {
  restoreToggleToSafety();
  if (demoFallbackEnabled()) populateDemoBilling();
  else clearBillingUnavailable();
  if (store.creds?.accountNumber) $('billing-account-number').textContent = store.creds.accountNumber;
  let anyLive = false;

  // --- Account balance ---
  // Uses the documented GraphQL `account.balance` field (confirmed via
  // docs.octopus.energy) rather than guessing at a REST field, and passes
  // includeAllLedgers: true as Octopus's own docs recommend for accuracy.
  let balancePounds = null;
  try {
    const data = await krakenGQL(`
      query AccountBalance($accountNumber: String!) {
        account(accountNumber: $accountNumber) { balance(includeAllLedgers: true) }
      }`, { accountNumber: store.creds.accountNumber });
    const balancePence = data?.account?.balance;
    if (typeof balancePence === 'number') {
      balancePounds = balancePence / 100;
      renderBalanceFigure('balance-now', 'balance-now-pill', balancePounds);
      anyLive = true;
    } else {
      // Query succeeded (no GraphQL error, krakenGQL didn't throw) but the
      // balance field itself came back missing/null — every real account
      // has one, so this is a genuine anomaly, not a normal empty state.
      // Previously this was silently skipped: no exception means no catch
      // block, which meant no logIssue() call at all — exactly the gap
      // found in testing, where a sync could report "Billing: false" with
      // zero captured detail because nothing ever technically threw.
      logIssue('Account balance', new Error(`Query succeeded but balance was ${JSON.stringify(balancePence)} (account: ${JSON.stringify(data?.account)})`));
    }
  } catch (err) { logIssue('Account balance', err); }

  // --- Next scheduled payment (for "balance after next Direct Debit") ---
  // Uses the documented `account.payments` field (confirmed field names:
  // amount, paymentDate, status — Octopus's own docs example shows
  // status: "SCHEDULED" as a real value). Originally filtered strictly to
  // status === 'SCHEDULED', which found nothing for some accounts — most
  // likely because Octopus doesn't materialize the individual payment
  // record until closer to the collection date. Relaxed to just "nearest
  // future-dated payment, whatever its status," which is more forgiving.
  let nextPayment = null;
  try {
    const data = await krakenGQL(`
      query NextPayment($accountNumber: String!) {
        account(accountNumber: $accountNumber) {
          payments(first: 30) { edges { node { amount paymentDate status } } }
        }
      }`, { accountNumber: store.creds.accountNumber });
    const today = isoDate(new Date());
    const allPayments = (data?.account?.payments?.edges || []).map(e => e.node);
    const upcoming = allPayments
      .filter(p => p.paymentDate >= today)
      .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
    if (upcoming[0]) nextPayment = upcoming[0];

    // No future-dated payment yet — fall back to the most recent PAST
    // payment as an estimate. UK energy Direct Debits are periodically
    // reviewed but typically stay fixed for months at a time, so the last
    // actual payment is a reasonable stand-in until Octopus creates the
    // real next-payment record. Flagged as an estimate so the UI can be
    // honest about it rather than presenting a guess as a confirmed fact.
    if (!nextPayment) {
      const past = allPayments
        .filter(p => p.paymentDate < today && p.status !== 'CANCELLED' && p.status !== 'FAILED')
        .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
      if (past[0]) nextPayment = { ...past[0], isEstimate: true };
    }

    logDebug('Next payment', `${allPayments.length} payment(s) fetched, ${upcoming.length} future-dated${nextPayment ? `, using: ${nextPayment.paymentDate} (${nextPayment.status}${nextPayment.isEstimate ? ', estimated from last payment' : ''})` : ', none usable'}`);
  } catch (err) { logIssue('Next payment', err); }

  // --- Cost so far this cycle (assumes calendar month as the cycle — Octopus's
  // API doesn't expose your actual billing-cycle start date, so this is an
  // approximation; swap in your real billing day here if you know it) ---
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const fromISO = monthStart.toISOString();
    const toISO = now.toISOString();
    const elapsedDays = daysElapsedInMonth(now);
    const totalDays = daysInMonth(now);

    const [elec, gas, elecStanding, gasStanding] = await Promise.all([
      costForRange('elec', fromISO, toISO, 'Electricity MTD'),
      costForRange('gas', fromISO, toISO, 'Gas MTD').catch(() => null),
      fetchStandingCharge('elec'),
      fetchStandingCharge('gas')
    ]);

    const elecStandingTotal = elecStanding ? (elecStanding / 100) * elapsedDays : 0;
    const gasStandingTotal = gasStanding ? (gasStanding / 100) * elapsedDays : 0;
    if (elecStanding) rateState.elecStandingP = elecStanding;
    if (gasStanding) rateState.gasStandingP = gasStanding;
    const elecMTD = elec.cost + elecStandingTotal;
    const gasMTD = gas ? gas.cost + gasStandingTotal : null;
    const combinedMTD = elecMTD + (gasMTD ?? 0);

    // Simple linear projection: today's daily average, carried across the rest
    // of the cycle. It won't account for seasonal swings (e.g. gas rising as
    // winter approaches) but is a reasonable early-month estimate. Applied to
    // kWh the same way, for the toggle's benefit.
    const avgDaily = combinedMTD / elapsedDays;
    const predictedTotal = avgDaily * totalDays;
    const elecPredictedCost = (elecMTD / elapsedDays) * totalDays;
    const gasPredictedCost = gasMTD !== null ? (gasMTD / elapsedDays) * totalDays : null;
    const elecPredictedKwh = (elec.kwh / elapsedDays) * totalDays;
    const gasPredictedKwh = gas ? (gas.kwh / elapsedDays) * totalDays : null;

    $('cost-mtd').textContent = fmtGBP(combinedMTD);
    $('cost-predicted').textContent = fmtGBP(predictedTotal);
    $('cycle-bar').style.width = `${Math.min(100, Math.round((elapsedDays / totalDays) * 100))}%`;
    $('cycle-day').textContent = `Day ${elapsedDays} / ${totalDays}`;

    fuelData.elec = fuelData.elec || {};
    // usageCost (excludes standing) feeds the balance forecast's blended
    // rate — mtd.cost includes standing charges (correct for the Billing
    // card's "spend so far" figure), but the forecast adds today's standing
    // charge separately per future month, so dividing by the
    // standing-inclusive cost would double-count it. Worse the smaller
    // this month's kWh is (e.g. gas in summer), since a fixed standing fee
    // gets spread over very little usage, inflating pence/kWh sharply.
    fuelData.elec.mtd = { cost: elecMTD, kwh: elec.kwh, usageCost: elec.cost };
    fuelData.elec.predicted = { cost: elecPredictedCost, kwh: elecPredictedKwh };
    if (elecStanding) $('elec-standing').textContent = `£${(elecStanding / 100).toFixed(2)}/day`;

    if (gasMTD !== null) {
      fuelData.gas = fuelData.gas || {};
      fuelData.gas.mtd = { cost: gasMTD, kwh: gas.kwh, usageCost: gas.cost };
      fuelData.gas.predicted = { cost: gasPredictedCost, kwh: gasPredictedKwh };
      if (gasStanding) $('gas-standing').textContent = `£${(gasStanding / 100).toFixed(2)}/day`;
      try {
        // v2.167: same UTC-vs-local date-boundary bug as loadRates() above
        // (see that fix's comment for the full explanation) — was using
        // isoDate(now) with a literal Z, which silently resolves to
        // yesterday's date for roughly an hour each night during BST.
        const dayStart1 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dayEnd1 = new Date(+dayStart1 + 24 * 60 * 60 * 1000 - 60000);
        const gasRatesToday = await fetchGasRates(dayStart1.toISOString(), dayEnd1.toISOString());
        const currentGasRate = rateAt(gasRatesToday, Date.now());
        if (currentGasRate !== null) { $('gas-unit-rate').textContent = `${currentGasRate.toFixed(2)}p`; rateState.gasRateP = currentGasRate; }
      } catch { /* keep whatever was already showing (demo or "—") */ }
    }

    if (balancePounds !== null) {
      // Direct Debit accounts don't have usage deducted from the balance
      // continuously — it's billed in one lump when the next statement is
      // issued. So the projection subtracts the FULL predicted month cost,
      // not just the not-yet-incurred remainder (which would double-count
      // the "already billed" assumption that doesn't hold here).
      const projected = balancePounds - predictedTotal;
      renderBalanceFigure('balance-projected', 'balance-projected-pill', projected);

      if (nextPayment) {
        const afterDD = projected + (nextPayment.amount / 100);
        $('next-dd-amount').textContent = fmtGBP(nextPayment.amount / 100);
        $('next-dd-label').textContent = nextPayment.isEstimate ? 'Direct Debit (est.)' : 'Next Direct Debit';
        renderBalanceFigure('balance-after-dd', 'balance-after-dd-pill', afterDD);

        // Trend: is the incoming payment bigger or smaller than what this
        // month's predicted to cost? Positive = balance building (summer),
        // negative = balance drawing down (winter).
        const trend = (nextPayment.amount / 100) - predictedTotal;
        const pill = $('balance-trend-pill');
        pill.className = 'trend-pill ' + (trend >= 0 ? 'up' : 'down');
        pill.textContent = `${trend >= 0 ? '↑' : '↓'} ${fmtGBP(trend)}/mo`;
        billingState = { balancePounds, trend, hasNextPayment: true, nextPaymentAmount: nextPayment.amount / 100 };

        $('balance-after-dd-row').style.display = '';
      } else {
        $('balance-after-dd-row').style.display = 'none';
        billingState = { balancePounds, trend: null, hasNextPayment: false, nextPaymentAmount: null };
      }
    }

    anyLive = true;
  } catch (err) {
    logIssue('MTD/predicted cost', err);
  }

  // --- 7-day bars, per fuel (also used to find "latest available day" —
  // see note in renderFuelPanel; same-day/next-day data lag affects both
  // fuels, not just gas, so there's no reliable "today" figure for either) ---
  try {
    fuelData.elec = fuelData.elec || {};
    fuelData.elec.week = await lastNDaysElecSplitWithStanding(7);
    logDebug('Elec week breakdown', fuelData.elec.week.map((d, i) => `[${i}] £${dayTotal('elec', d, 'cost').toFixed(2)} (hasData:${d.hasData})`).join(' '));
    renderFuelPanel('elec');

    try {
      fuelData.gas = fuelData.gas || {};
      fuelData.gas.week = await lastNDaysGasSplitWithStanding(7);
      logDebug('Gas week breakdown', fuelData.gas.week.map((d, i) => `[${i}] £${dayTotal('gas', d, 'cost').toFixed(2)} (hasData:${d.hasData})`).join(' '));
      renderFuelPanel('gas');
    } catch (err) { logIssue('Gas daily cost', err); }

    anyLive = true;
  } catch (err) {
    logIssue('Daily cost', err);
  }

  // Last bill: real, via Octopus's documented GraphQL schema (account.bills),
  // itemized using account.transactions for each bill's date range. The most
  // recent bill is always shown in full (date, billing period, total); up to
  // 4 older bills are available behind the outer toggle using the identical
  // row shape. Each row's own itemized breakdown collapses independently to
  // save vertical space, defaulting closed.
  try {
    const data = await krakenGQL(`
      query LastBill($accountNumber: String!) {
        account(accountNumber: $accountNumber) {
          bills(first: 15) {
            edges { node { id issuedDate fromDate toDate temporaryUrl } }
          }
        }
      }`, { accountNumber: store.creds.accountNumber });

    const bills = (data?.account?.bills?.edges || []).map(e => e.node).filter(b => b.issuedDate);
    bills.sort((a, b) => new Date(b.issuedDate) - new Date(a.issuedDate));
    const latest = bills[0];
    if (latest) {
      // Itemized per-transaction breakdown, one fetch covering every listed
      // bill's date range. Best-effort: if this fails for any reason, every
      // row still falls back to date + link only, never blocking that base view.
      let txnsByBill = null;
      try {
        const earliest = bills.reduce((min, b) => b.fromDate < min ? b.fromDate : min, bills[0].fromDate);
        const spanEnd = bills.reduce((max, b) => b.toDate > max ? b.toDate : max, bills[0].toDate);
        const txnData = await krakenGQL(`
          query BillTransactions($accountNumber: String!, $fromDate: Date, $toDate: Date) {
            account(accountNumber: $accountNumber) {
              transactions(fromDate: $fromDate, toDate: $toDate, first: 100) {
                edges { node { __typename id postedDate title amounts { gross } } }
              }
            }
          }`, { accountNumber: store.creds.accountNumber, fromDate: earliest, toDate: spanEnd });
        const txns = (txnData?.account?.transactions?.edges || []).map(e => e.node).filter(t => t.postedDate && t.amounts);

        // Usage (kWh + sub-period) fetched separately, on its own risk.
        // Two rounds of real API errors got us here: first confirmed
        // transactions.edges.node is a concrete TransactionType (no bare
        // `consumption` field, no inline fragment needed there); the API's
        // own error then named the correct fragment target directly —
        // `... on Charge`, not `BillCharge` (that name only existed on a
        // different, unrelated type from earlier introspection). Kept
        // decoupled from the main query either way, so a future failure
        // here only drops kWh rather than the whole breakdown again.
        try {
          const consData = await krakenGQL(`
            query BillChargeConsumption($accountNumber: String!, $fromDate: Date, $toDate: Date) {
              account(accountNumber: $accountNumber) {
                transactions(fromDate: $fromDate, toDate: $toDate, first: 100) {
                  edges {
                    node {
                      ... on Charge {
                        id
                        consumption { quantity unit startDate endDate }
                      }
                    }
                  }
                }
              }
            }`, { accountNumber: store.creds.accountNumber, fromDate: earliest, toDate: spanEnd });
          const consEdges = consData?.account?.transactions?.edges || [];
          const consByCharge = new Map(
            consEdges
              .map(e => e.node)
              .filter(n => n?.id && n?.consumption)
              .map(n => [n.id, n.consumption])
          );
          let matched = 0;
          txns.forEach(t => { if (consByCharge.has(t.id)) { t.consumption = consByCharge.get(t.id); matched++; } });
          logDebug('Bill charge consumption', `${consEdges.length} edge(s) returned, ${consByCharge.size} with id+consumption, ${matched}/${txns.length} txn(s) matched`);
        } catch (err) { logIssue('Bill charge consumption', err); }

        txnsByBill = bills.map(b => ({
          bill: b,
          items: txns.filter(t => t.postedDate >= b.fromDate && t.postedDate <= b.toDate)
        }));
      } catch (err) { logIssue('Bill transactions', err); }

      function isCharge(t) { return (t.__typename || '').includes('Charge'); }
      function itemDateRange(t) {
        if (!t.consumption?.startDate || !t.consumption?.endDate) return '';
        const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `<span class="bh-item-sub">${fmt(t.consumption.startDate)} – ${fmt(t.consumption.endDate)}</span>`;
      }
      function itemKwh(t) {
        if (!t.consumption?.quantity) return '';
        const unitMap = { KILOWATT_HOUR: 'kWh', CUBIC_METERS: 'm³', CUBIC_METRE: 'm³', CUBIC_FEET: 'ft³' };
        const unit = unitMap[t.consumption.unit] || (t.consumption.unit || '').toLowerCase().replace(/_/g, ' ');
        const qty = parseFloat(t.consumption.quantity);
        return ` · ${qty.toFixed(1)}${unit ? ' ' + unit : ''}`;
      }

      function billItemsHtml(items) {
        if (!items || !items.length) return '';
        const rows = items.map(t => {
          const charge = isCharge(t);
          const signed = (charge ? -t.amounts.gross : t.amounts.gross) / 100;
          const cls = charge ? 'v' : 'v credit';
          return `<div class="bh-item"><span class="l">${t.title}${itemKwh(t)}${itemDateRange(t)}</span><span class="${cls}">${signed < 0 ? '−' : '+'}£${Math.abs(signed).toFixed(2)}</span></div>`;
        }).join('');
        return rows;
      }
      // Total matches the bill's own "Total charges for bill" — sums only the
      // charge-type transactions (electricity, gas), excluding Direct Debit
      // payments and points-redeemed credits, which are account balance
      // movements rather than part of what the bill actually charged.
      function billTotal(items) {
        if (!items || !items.length) return null;
        const chargePence = items.filter(isCharge).reduce((sum, t) => sum + t.amounts.gross, 0);
        return (chargePence / 100).toFixed(2);
      }
      function billPeriod(b) {
        const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `${fmt(b.fromDate)} – ${fmt(b.toDate)}`;
      }
      function billRowHtml(b, collapsible) {
        const date = new Date(b.issuedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        const items = txnsByBill ? txnsByBill.find(x => x.bill.id === b.id)?.items : null;
        const linkHtml = b.temporaryUrl ? `<a class="bh-link" href="${b.temporaryUrl}" target="_blank" aria-label="View bill">View Bill</a>` : '<span class="bh-link" style="opacity:0.4">View Bill</span>';
        const total = billTotal(items);
        const itemsHtml = billItemsHtml(items);
        const toggleHtml = (itemsHtml && collapsible)
          ? `<div class="bh-pill-group" id="bh-pill-group"><button type="button" class="bh-breakdown-toggle" data-bill-id="${b.id}" aria-expanded="false"><span>Show breakdown</span><svg viewBox="0 0 10 6" fill="none" width="9" height="6"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>`
          : '<span></span>';
        const itemsClass = collapsible ? 'bh-items hidden' : 'bh-items';
        return `<div class="bh-row">
          <div class="bh-top">
            <div><div class="bh-date">${date}</div><div class="bh-period"><b>Billing period:</b> ${billPeriod(b)}</div></div>
            ${linkHtml}
          </div>
          <div class="bh-total-row">${toggleHtml}<div class="bh-total">${total !== null ? '£' + total : '—'}</div></div>
          ${itemsHtml ? `<div class="${itemsClass}" data-bill-id="${b.id}">${itemsHtml}</div>` : ''}
        </div>`;
      }

      // Toggle already guaranteed safe by restoreToggleToSafety() at the
      // top of this function — see there for the full explanation.
      $('last-bill-row').innerHTML = billRowHtml(latest, true);

      const rest = bills.slice(1);
      const toggle = $('bill-history-toggle');
      const pillGroup = document.getElementById('bh-pill-group');
      if (pillGroup) pillGroup.appendChild(toggle);
      if (rest.length) {
        $('bill-history').innerHTML = rest.map(b => billRowHtml(b, false)).join('');
        $('bill-history-toggle-label').textContent = `${rest.length} more`;
        toggle.classList.remove('hidden');
        toggle.onclick = () => {
          const open = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', String(!open));
          $('bill-history-toggle-label').textContent = open ? `${rest.length} more` : 'hide';
          $('bill-history').classList.toggle('hidden', open);
        };
      } else {
        toggle.classList.add('hidden');
      }

      // Per-row breakdown toggles, delegated across both containers since
      // rows in bill-history are rebuilt each sync.
      [$('last-bill-row'), $('bill-history')].forEach(container => {
        container.querySelectorAll('.bh-breakdown-toggle').forEach(btn => {
          btn.onclick = () => {
            const id = btn.dataset.billId;
            const itemsEl = container.querySelector(`.bh-items[data-bill-id="${id}"]`);
            const open = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', String(!open));
            btn.querySelector('span').textContent = open ? 'Show breakdown' : 'Hide breakdown';
            itemsEl.classList.toggle('hidden', open);
          };
        });
      });

      // Bill total over time, grouped by calendar month (not one bar per
      // bill) — some months genuinely have more than one bill (a tariff
      // switch mid-month, for example), and showing those as two separate
      // bars with the same month label reads as a mistake even though the
      // data's correct. Grouping gives a true "spend per month" picture.
      // Deliberately a rolling window, not a Jan–Dec calendar year — that
      // would drop any bill from before January (thrown away for no good
      // reason) and pad the second half of the year with empty
      // not-happened-yet placeholders.
      //
      // Fetches 15 bills, not 12 — a month with 2+ bills "eats" one fetch
      // slot without adding a new distinct month, so 12 bills alone can
      // undershoot a genuine 12-month picture whenever that happens (which
      // it will, on any tariff switch). 15 is a buffer, not a guarantee —
      // someone who switches tariffs several times in a year could still
      // come up short — but it covers the common case. The chart itself
      // is capped to the most recent 12 distinct months after grouping
      // (see .slice(-12) below), so it stays a consistent width regardless
      // of how many bills that took.
      try {
        // consumption.unit is usually KILOWATT_HOUR for electricity and
        // either KILOWATT_HOUR or CUBIC_METERS for gas depending on the
        // meter — same m3→kWh conversion already used in costForRange/
        // fetchYearMonthly (volume correction × calorific value ÷ 3.6),
        // applied per-item here rather than assuming a fixed unit.
        function itemToKwh(t) {
          const q = parseFloat(t.consumption?.quantity);
          if (!Number.isFinite(q)) return 0;
          const unit = t.consumption?.unit;
          if (unit === 'CUBIC_METERS' || unit === 'CUBIC_METRE') return m3ToKwh(q);
          return q; // already kWh (or close enough — KILOWATT_HOUR, or an unrecognized unit passed through rather than silently dropped)
        }
        const grouped = new Map(); // key 'YYYY-M' -> { year, month, gas, elec, gasKwh, elecKwh, total, bills: [{issuedDate, temporaryUrl}] }
        (txnsByBill || []).forEach(({ bill, items }) => {
          const issued = new Date(bill.issuedDate);
          const key = `${issued.getFullYear()}-${issued.getMonth()}`;
          const gasItems = (items || []).filter(t => isCharge(t) && /gas/i.test(t.title));
          const elecItems = (items || []).filter(t => isCharge(t) && /electric/i.test(t.title));
          const gas = gasItems.reduce((s, t) => s + t.amounts.gross, 0) / 100;
          const elec = elecItems.reduce((s, t) => s + t.amounts.gross, 0) / 100;
          const gasKwh = gasItems.reduce((s, t) => s + itemToKwh(t), 0);
          const elecKwh = elecItems.reduce((s, t) => s + itemToKwh(t), 0);
          if (grouped.has(key)) {
            const g = grouped.get(key);
            g.gas += gas; g.elec += elec; g.total += gas + elec;
            g.gasKwh += gasKwh; g.elecKwh += elecKwh;
            g.bills.push({ issuedDate: bill.issuedDate, temporaryUrl: bill.temporaryUrl });
          } else {
            grouped.set(key, { year: issued.getFullYear(), month: issued.getMonth(), gas, elec, gasKwh, elecKwh, total: gas + elec, bills: [{ issuedDate: bill.issuedDate, temporaryUrl: bill.temporaryUrl }] });
          }
        });
        const monthsData = Array.from(grouped.values())
          .sort((a, b) => a.year - b.year || a.month - b.month)
          .slice(-12); // most recent 12 distinct months, regardless of how many bills that took
        const spansMultipleYears = monthsData.length > 0 && monthsData[0].year !== monthsData[monthsData.length - 1].year;

        if (monthsData.length >= 2) {
          billMonthsData = monthsData;
          if (selectedBillMonth !== null && selectedBillMonth >= monthsData.length) selectedBillMonth = null;
          const max = Math.max(...monthsData.map(m => m.total), 0.01);
          const maxBarHeight = 78;
          $('bill-year-bars').innerHTML = monthsData.map((m, i) => {
            const seg = `<div class="bt-seg gas" style="height:${Math.max(1, Math.round((m.gas / max) * maxBarHeight))}px"></div><div class="bt-seg elec" style="height:${Math.max(1, Math.round((m.elec / max) * maxBarHeight))}px"></div>`;
            const label = new Date(m.year, m.month, 1).toLocaleDateString('en-GB', spansMultipleYears ? { month: 'short', year: '2-digit' } : { month: 'short' });
            const selected = i === selectedBillMonth ? ' selected' : '';
            return `<div class="bt-bar"><div class="bt-stack${selected}" data-index="${i}">${seg}</div><span class="${i === selectedBillMonth ? 'active-day' : ''}">${label}</span></div>`;
          }).join('');
          renderBillYearBreakdown(selectedBillMonth);
          $('bill-year-block').style.display = '';
        } else {
          billMonthsData = [];
          selectedBillMonth = null;
          $('bill-year-block').style.display = 'none';
        }
      } catch (err) { logIssue('Bill year chart', err); }

      anyLive = true;
    }
  } catch (err) {
    logIssue('Last bill', err);
    $('last-bill-row').innerHTML = '<div style="color:var(--text-dim);font-size:12.5px;">Last bill unavailable — check connection or Settings</div>';
    billMonthsData = [];
    selectedBillMonth = null;
    $('bill-year-block').style.display = 'none';
  }

  // --- Octopoints: archived v2.150, deactivated pending Octopus forum ---
  // Live testing returned Unauthorized (KT-CT-1111) — most likely an
  // account reader-permission gap rather than a code bug (a lead worth
  // checking: the JWT may carry the account's permission scopes directly).
  // Deactivated here to stop spending API calls on a feature that isn't
  // working, without deleting it — the full working implementation
  // (queries, ledger rendering, capping/sorting) is preserved in full in
  // octopoints-archive.js, a new file alongside this release, kept
  // separate from the pre-existing ev-legacy-archive.js since it's an
  // unrelated feature. Reinstate by moving this block back in and
  // un-hiding #octo-block once permissions are confirmed.
  $('octo-block').classList.add('hidden');

  return anyLive;
}

function populateDemoBilling() {
    renderBalanceFigure('balance-now', 'balance-now-pill', 42.10);
    renderBalanceFigure('balance-projected', 'balance-projected-pill', 35.70);
    $('next-dd-amount').textContent = '£95.00';
    renderBalanceFigure('balance-after-dd', 'balance-after-dd-pill', 130.70);
    $('balance-trend-pill').className = 'trend-pill up';
    $('balance-trend-pill').textContent = '↑ £95.00/mo';
    $('balance-after-dd-row').style.display = '';
    $('cost-mtd').textContent = '£58.90';
    $('cost-predicted').textContent = '£101.40';
    $('cycle-bar').style.width = '58%';
    $('cycle-day').textContent = 'Day 17 / 29 (demo data)';
    $('elec-latest-label').textContent = 'Yesterday'; $('elec-latest').textContent = '£1.90';
    $('elec-week-total').textContent = '£13.20';
    $('elec-mtd').textContent = '£35.40'; $('elec-predicted').textContent = '£61.10';
    $('elec-standing').textContent = '£0.52/day';
    $('gas-latest-label').textContent = 'Yesterday'; $('gas-latest').textContent = '£2.04';
    $('gas-week-total').textContent = '£11.30';
    $('gas-mtd').textContent = '£23.50'; $('gas-predicted').textContent = '£40.30';
    $('gas-unit-rate').textContent = '6.24p'; $('gas-standing').textContent = '£0.35/day';
    renderWeekBars('elec-week', [2.2, 1.9, 1.5, 2.4, 1.4, 1.7, 2.1], 'elec-col', fmtGBP, 58, 'elec-week-scale');
    renderWeekBars('gas-week', [1.4, 1.8, 1.2, 2.0, 1.6, 1.3, 1.5], 'gas-col', fmtGBP, 58, 'gas-week-scale');
    $('last-bill-row').innerHTML = `<div class="bh-top"><div><div class="bh-date">1 Jul 2026</div><div class="bh-period"><b>Billing period:</b> 3 Jun – 1 Jul</div></div><span class="bh-link" style="opacity:0.4">View Bill</span></div><div class="bh-total-row"><span></span><div class="bh-total">£54.20 (demo data)</div></div>`;
    $('bill-year-bars').innerHTML = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug']
      .map((m, i) => `<div class="bt-bar"><div class="bt-stack"><div class="bt-seg gas" style="height:${[68,56,40,24,16,8,3,2][i]}px"></div><div class="bt-seg elec" style="height:${[22,22,20,22,22,20,17,12][i]}px"></div></div><span>${m}</span></div>`)
      .join('');
    $('bill-year-block').style.display = '';
}

function clearBillingUnavailable() {
    $('balance-now').textContent = 'Unavailable';
    $('balance-now-pill').textContent = '';
    $('balance-projected').textContent = 'Unavailable';
    $('balance-projected-pill').textContent = '';
    $('next-dd-amount').textContent = '—';
    $('balance-after-dd').textContent = '—';
    $('balance-after-dd-pill').textContent = '';
    $('balance-trend-pill').textContent = '';
    $('balance-trend-pill').className = 'trend-pill';
    $('balance-after-dd-row').style.display = 'none';
    $('cost-mtd').textContent = 'Unavailable';
    $('cost-predicted').textContent = 'Unavailable';
    $('cycle-bar').style.width = '0%';
    $('cycle-day').textContent = '—';
    $('elec-latest-label').textContent = 'Latest available'; $('elec-latest').textContent = 'Unavailable';
    $('elec-week-total').textContent = 'Unavailable';
    $('elec-mtd').textContent = 'Unavailable'; $('elec-predicted').textContent = 'Unavailable';
    $('elec-standing').textContent = '—';
    $('gas-latest-label').textContent = 'Latest available'; $('gas-latest').textContent = 'Unavailable';
    $('gas-week-total').textContent = 'Unavailable';
    $('gas-mtd').textContent = 'Unavailable'; $('gas-predicted').textContent = 'Unavailable';
    $('gas-unit-rate').textContent = '—'; $('gas-standing').textContent = '—';
    renderWeekBars('elec-week', [0, 0, 0, 0, 0, 0, 0], 'elec-col', fmtGBP, 58, 'elec-week-scale');
    renderWeekBars('gas-week', [0, 0, 0, 0, 0, 0, 0], 'gas-col', fmtGBP, 58, 'gas-week-scale');
    $('last-bill-row').innerHTML = '<div style="color:var(--text-dim);font-size:12.5px;">Loading last bill…</div>';
    document.getElementById('bill-history-toggle')?.classList.add('hidden');
    billMonthsData = [];
    selectedBillMonth = null;
    $('bill-year-block').style.display = 'none';
    $('bill-history').classList.add('hidden');
}

// Same tap-to-reveal pattern for the bill-total-over-time chart — tap a
// month's bar to see its gas/electricity split underneath (and a note +
// link if that month combined more than one bill). Re-renders just the
// selection/breakdown, not the whole chart, since the bar heights
// themselves don't change on tap.
export function handleBillYearBarClick(e) {
  const bar = e.target.closest('.bt-stack');
  if (!bar) return;
  const index = parseInt(bar.dataset.index, 10);
  if (Number.isNaN(index)) return;
  selectedBillMonth = (selectedBillMonth === index) ? null : index;
  document.querySelectorAll('#bill-year-bars .bt-bar').forEach(bar => {
    const idx = parseInt(bar.querySelector('.bt-stack').dataset.index, 10);
    bar.querySelector('.bt-stack').classList.toggle('selected', idx === selectedBillMonth);
    bar.querySelector('span').classList.toggle('active-day', idx === selectedBillMonth);
  });
  renderBillYearBreakdown(selectedBillMonth);
}
