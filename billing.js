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

// Bill-year chart's tap-to-breakdown — reuses the same .breakdown-box /
// .breakdown-row markup as the usage breakdowns, reading from billMonthsData
// (populated whenever the chart renders) so it needs no fetch of its own.
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

// Moves the persistent #bill-history-toggle back before #bill-history if a
// previous sync parked it inside #last-bill-row. loadBilling() moves this
// element INTO last-bill-row's content on a successful render, and four
// separate paths reassign last-bill-row.innerHTML on a later call (real
// render, demo, generic-failure, per-sync reset) — any of them destroys the
// parked toggle, and the next reference to it throws before loadBilling's
// own try/catch blocks run. Called unconditionally at the top of
// loadBilling() so all four paths are covered. This was the actual root
// cause of billing intermittently failing — not the API or rate limits.
function restoreToggleToSafety() {
  const existingToggle = document.getElementById('bill-history-toggle');
  const billHistoryEl = document.getElementById('bill-history');
  if (existingToggle && billHistoryEl && existingToggle.nextSibling !== billHistoryEl) {
    billHistoryEl.parentElement.insertBefore(existingToggle, billHistoryEl);
  }
}

// --- Pure helpers, lifted out of loadBilling so the billing math can be
// tested without a DOM or a live API (see test/billing.test.js). None of
// these touch the page or module state. ---

function isCharge(t) { return (t.__typename || '').includes('Charge'); }

// Consumption quantity → kWh for the bill-year chart's per-fuel split.
// consumption.unit is KILOWATT_HOUR for electricity and either that or
// CUBIC_METERS for gas depending on the meter; m³ gets the same
// volume-correction × calorific-value ÷ 3.6 conversion used in
// costForRange / fetchYearMonthly.
function itemToKwh(t) {
  const q = parseFloat(t.consumption?.quantity);
  if (!Number.isFinite(q)) return 0;
  const unit = t.consumption?.unit;
  if (unit === 'CUBIC_METERS' || unit === 'CUBIC_METRE') return m3ToKwh(q);
  return q; // already kWh (KILOWATT_HOUR, or an unrecognised unit passed through rather than dropped)
}

// The bill's own "Total charges for bill": sums only charge-type
// transactions (electricity, gas), excluding Direct Debit payments and
// points-redeemed credits — those move the account balance, they aren't
// part of what the bill charged. Returns pounds, or null for no items.
export function billChargeTotal(items) {
  if (!items || !items.length) return null;
  return items.filter(isCharge).reduce((sum, t) => sum + t.amounts.gross, 0) / 100;
}

// Nearest usable payment for the "balance after next Direct Debit" line:
// the soonest future-dated payment whatever its status, else the most
// recent non-cancelled/failed past payment as an estimate (UK energy DDs
// stay fixed for months, and Octopus doesn't materialise the next record
// until close to collection). `todayISO` is a yyyy-mm-dd string. Returns
// { payment, futureCount } — futureCount is for the diagnostics line.
export function pickNextPayment(payments, todayISO) {
  const future = (payments || [])
    .filter(p => p.paymentDate >= todayISO)
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
  if (future[0]) return { payment: future[0], futureCount: future.length };
  const past = (payments || [])
    .filter(p => p.paymentDate < todayISO && p.status !== 'CANCELLED' && p.status !== 'FAILED')
    .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate));
  return { payment: past[0] ? { ...past[0], isEstimate: true } : null, futureCount: 0 };
}

// Bills grouped into calendar months (a mid-month tariff switch produces
// two bills for one month; two same-labelled bars read as a bug, so they
// merge). Most-recent 12 distinct months, oldest-first. `txnsByBill` is
// [{ bill, items }]; each result row carries per-fuel £ and kWh plus the
// contributing bills.
export function groupBillsByMonth(txnsByBill) {
  const grouped = new Map(); // 'YYYY-M' -> row
  (txnsByBill || []).forEach(({ bill, items }) => {
    const issued = new Date(bill.issuedDate);
    const key = `${issued.getFullYear()}-${issued.getMonth()}`;
    const gasItems = (items || []).filter(t => isCharge(t) && /gas/i.test(t.title));
    const elecItems = (items || []).filter(t => isCharge(t) && /electric/i.test(t.title));
    const gas = gasItems.reduce((s, t) => s + t.amounts.gross, 0) / 100;
    const elec = elecItems.reduce((s, t) => s + t.amounts.gross, 0) / 100;
    const gasKwh = gasItems.reduce((s, t) => s + itemToKwh(t), 0);
    const elecKwh = elecItems.reduce((s, t) => s + itemToKwh(t), 0);
    const entry = grouped.get(key);
    if (entry) {
      entry.gas += gas; entry.elec += elec; entry.total += gas + elec;
      entry.gasKwh += gasKwh; entry.elecKwh += elecKwh;
      entry.bills.push({ issuedDate: bill.issuedDate, temporaryUrl: bill.temporaryUrl });
    } else {
      grouped.set(key, { year: issued.getFullYear(), month: issued.getMonth(), gas, elec, gasKwh, elecKwh, total: gas + elec, bills: [{ issuedDate: bill.issuedDate, temporaryUrl: bill.temporaryUrl }] });
    }
  });
  return Array.from(grouped.values())
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .slice(-12);
}

export async function loadBilling() {
  restoreToggleToSafety();
  if (demoFallbackEnabled()) populateDemoBilling();
  else clearBillingUnavailable();
  if (store.creds?.accountNumber) $('billing-account-number').textContent = store.creds.accountNumber;
  let anyLive = false;

  // The three account-scoped queries used below — balance, next payment,
  // bills — have no ordering dependency on one another, so they're kicked
  // off together here and awaited further down where each result is
  // consumed: concurrent, instead of three serial round trips on cold load.
  // `.catch(() => {})` pre-marks each promise as handled so a rejection
  // surfacing before its `await` can't trip `unhandledrejection`; the real
  // error handling stays at each await site, so per-section isolation is
  // exactly as before.
  const acct = store.creds?.accountNumber;
  const balanceQ = krakenGQL(`
    query AccountBalance($accountNumber: String!) {
      account(accountNumber: $accountNumber) { balance(includeAllLedgers: true) }
    }`, { accountNumber: acct });
  const nextPaymentQ = krakenGQL(`
    query NextPayment($accountNumber: String!) {
      account(accountNumber: $accountNumber) {
        payments(first: 30) { edges { node { amount paymentDate status } } }
      }
    }`, { accountNumber: acct });
  const billsQ = krakenGQL(`
    query LastBill($accountNumber: String!) {
      account(accountNumber: $accountNumber) {
        bills(first: 15) {
          edges { node { id issuedDate fromDate toDate temporaryUrl } }
        }
      }
    }`, { accountNumber: acct });
  balanceQ.catch(() => {}); nextPaymentQ.catch(() => {}); billsQ.catch(() => {});

  // --- Account balance ---
  // Uses the documented GraphQL `account.balance` field (confirmed via
  // docs.octopus.energy) rather than guessing at a REST field, and passes
  // includeAllLedgers: true as Octopus's own docs recommend for accuracy.
  let balancePounds = null;
  try {
    const data = await balanceQ;
    const balancePence = data?.account?.balance;
    if (typeof balancePence === 'number') {
      balancePounds = balancePence / 100;
      renderBalanceFigure('balance-now', 'balance-now-pill', balancePounds);
      anyLive = true;
    } else {
      // Query succeeded (no GraphQL error, krakenGQL didn't throw) but the
      // balance field itself came back missing/null — every real account
      // has one, so this is a genuine anomaly, not a normal empty state.
      // Nothing throws here, so without this explicit logIssue a sync could
      // report "Billing: false" with no captured detail at all.
      logIssue('Account balance', new Error(`Query succeeded but balance was ${JSON.stringify(balancePence)} (account: ${JSON.stringify(data?.account)})`));
    }
  } catch (err) { logIssue('Account balance', err); }

  // --- Next scheduled payment (for "balance after next Direct Debit") ---
  // Uses the documented `account.payments` field. Takes the nearest
  // future-dated payment whatever its status, not just status ===
  // 'SCHEDULED' — Octopus doesn't seem to materialize the individual
  // payment record until closer to the collection date, so a strict filter
  // found nothing for some accounts.
  let nextPayment = null;
  try {
    const data = await nextPaymentQ;
    const allPayments = (data?.account?.payments?.edges || []).map(e => e.node);
    const picked = pickNextPayment(allPayments, isoDate(new Date()));
    nextPayment = picked.payment;
    logDebug('Next payment', `${allPayments.length} payment(s) fetched, ${picked.futureCount} future-dated${nextPayment ? `, using: ${nextPayment.paymentDate} (${nextPayment.status}${nextPayment.isEstimate ? ', estimated from last payment' : ''})` : ', none usable'}`);
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
        // Local date components, not isoDate(now) + a literal Z — see
        // loadRates in main.js for the BST boundary bug that avoids.
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
    const data = await billsQ;

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

        // Usage (kWh + sub-period) fetched in its own query, decoupled from
        // the main one so a failure here only drops kWh, not the whole
        // breakdown. The fragment target is `... on Charge` (confirmed by
        // the API's own error message — `BillCharge` is an unrelated type).
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
      function billPeriod(b) {
        const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `${fmt(b.fromDate)} – ${fmt(b.toDate)}`;
      }
      function billRowHtml(b, collapsible) {
        const date = new Date(b.issuedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        const items = txnsByBill ? txnsByBill.find(x => x.bill.id === b.id)?.items : null;
        const linkHtml = b.temporaryUrl ? `<a class="bh-link" href="${b.temporaryUrl}" target="_blank" aria-label="View bill">View Bill</a>` : '<span class="bh-link" style="opacity:0.4">View Bill</span>';
        const total = billChargeTotal(items);
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
          <div class="bh-total-row">${toggleHtml}<div class="bh-total">${total != null ? fmtGBP(total) : '—'}</div></div>
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
      // bill) — a tariff switch mid-month produces two bills for one month,
      // which as two same-labelled bars reads as a mistake. Grouping gives a
      // true "spend per month" picture. Rolling window, not a Jan–Dec year,
      // so bills from before January aren't dropped and the back half of the
      // year isn't padded with empty placeholders.
      //
      // Fetches 15 bills, not 12: a month with 2+ bills eats a fetch slot
      // without adding a distinct month, so 12 alone undershoots on any
      // tariff switch. The chart is capped to the most recent 12 distinct
      // months after grouping (.slice(-12)), staying a consistent width.
      try {
        const monthsData = groupBillsByMonth(txnsByBill);
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
