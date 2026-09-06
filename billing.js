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
import { cacheSnapshot, readSnapshot, markStale, clearStale, setCardStamp } from './offline.js';

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

// A billing snapshot's day objects (weekBars) carry Date instances that
// JSON turns into strings — renderFuelPanel / dayTotal call Date methods on
// them, so revive before rendering a restored snapshot. The bill dates are
// already strings from the API (billRowHtml news them up), so only weekBars
// needs it.
function reviveBillingSnapshot(d) {
  for (const arr of [d.weekBars?.elecWeek, d.weekBars?.gasWeek]) {
    if (Array.isArray(arr)) arr.forEach(day => { if (day && day.date) day.date = new Date(day.date); });
  }
}

// A snapshot is worth keeping only if the sync was complete — a partial one
// (say balance loaded but the rate-limited bill fetch didn't) shouldn't
// overwrite a fuller earlier snapshot.
const billingComplete = d => !!(d.balance && d.mtd && d.bills && !d.bills.error);
const billingGotAnything = d => !!(d.balance || d.mtd || (d.bills && !d.bills.error));

export async function loadBilling() {
  restoreToggleToSafety();
  if (demoFallbackEnabled()) populateDemoBilling();
  else clearBillingUnavailable();
  if (store.creds?.accountNumber) $('billing-account-number').textContent = store.creds.accountNumber;

  const data = await fetchBillingData();

  // Nothing loaded — repaint the last good snapshot (stamped on both the
  // Billing card and the Usage card, whose Week view renderBilling also
  // repaints) rather than dropping the whole card to Unavailable.
  if (!billingGotAnything(data)) {
    const snap = readSnapshot('billing');
    if (snap?.data) {
      reviveBillingSnapshot(snap.data);
      renderBilling(snap.data);
      markStale('billing', snap.t, 'billing-stamp');
      setCardStamp('usage-stamp', snap.t);
      return 'stale';
    }
  }

  const anyLive = renderBilling(data);
  clearStale('billing', 'billing-stamp');
  setCardStamp('usage-stamp', null);
  if (billingComplete(data)) cacheSnapshot('billing', data);
  return anyLive;
}

/* ------------------------------ Fetch ---------------------------------- */
// Every network call + derivation, no DOM. Each sub-fetch owns its
// try/catch and returns data-or-null, so one section failing doesn't sink
// the others (the isolation the old try-per-section had). The three
// account queries fire concurrently and the REST-heavy MTD / 7-day-bar
// fetches run alongside them.

async function fetchBillingData() {
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
        bills(first: 15) { edges { node { id issuedDate fromDate toDate temporaryUrl } } }
      }
    }`, { accountNumber: acct });
  balanceQ.catch(() => {}); nextPaymentQ.catch(() => {}); billsQ.catch(() => {});

  const [balance, nextPayment, mtd, weekBars, bills] = await Promise.all([
    fetchBalance(balanceQ),
    fetchNextPayment(nextPaymentQ),
    fetchMtd(),
    fetchWeekBars(),
    fetchBills(billsQ),
  ]);
  return { balance, nextPayment, mtd, weekBars, bills };
}

// account.balance — documented GraphQL field, includeAllLedgers per Octopus's
// own docs. Returns { balancePounds } or null (an anomaly is logged: every
// real account has a balance, and nothing throws when it comes back null).
async function fetchBalance(balanceQ) {
  try {
    const data = await balanceQ;
    const balancePence = data?.account?.balance;
    if (typeof balancePence === 'number') return { balancePounds: balancePence / 100 };
    logIssue('Account balance', new Error(`Query succeeded but balance was ${JSON.stringify(balancePence)} (account: ${JSON.stringify(data?.account)})`));
    return null;
  } catch (err) { logIssue('Account balance', err); return null; }
}

// Nearest usable payment for "balance after next Direct Debit". Returns the
// payment node (or null).
async function fetchNextPayment(nextPaymentQ) {
  try {
    const data = await nextPaymentQ;
    const allPayments = (data?.account?.payments?.edges || []).map(e => e.node);
    const picked = pickNextPayment(allPayments, isoDate(new Date()));
    logDebug('Next payment', `${allPayments.length} payment(s) fetched, ${picked.futureCount} future-dated${picked.payment ? `, using: ${picked.payment.paymentDate} (${picked.payment.status}${picked.payment.isEstimate ? ', estimated from last payment' : ''})` : ', none usable'}`);
    return picked.payment;
  } catch (err) { logIssue('Next payment', err); return null; }
}

// Cost so far this cycle (calendar month assumed as the cycle — Octopus's
// API doesn't expose the real billing day). Everything the balance /
// projected / after-DD / trend figures need, pre-computed. Returns null on
// failure. The linear projection carries today's daily average across the
// rest of the month — no seasonal awareness, but a fair early-month figure.
async function fetchMtd() {
  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const elapsedDays = daysElapsedInMonth(now);
    const totalDays = daysInMonth(now);
    const [elec, gas, elecStanding, gasStanding] = await Promise.all([
      costForRange('elec', monthStart.toISOString(), now.toISOString(), 'Electricity MTD'),
      costForRange('gas', monthStart.toISOString(), now.toISOString(), 'Gas MTD').catch(() => null),
      fetchStandingCharge('elec'),
      fetchStandingCharge('gas'),
    ]);
    const elecMTD = elec.cost + (elecStanding ? (elecStanding / 100) * elapsedDays : 0);
    const gasMTD = gas ? gas.cost + (gasStanding ? (gasStanding / 100) * elapsedDays : 0) : null;
    const combinedMTD = elecMTD + (gasMTD ?? 0);
    const predictedTotal = (combinedMTD / elapsedDays) * totalDays;

    // Today's gas unit rate — its own small fetch, only when there's gas.
    let gasRateP = null;
    if (gasMTD !== null) {
      try {
        // Local date components, not isoDate + a literal Z — see loadRates
        // in main.js for the BST boundary bug that avoids.
        const dayStart1 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dayEnd1 = new Date(+dayStart1 + 24 * 60 * 60 * 1000 - 60000);
        const r = rateAt(await fetchGasRates(dayStart1.toISOString(), dayEnd1.toISOString()), Date.now());
        if (r !== null) gasRateP = r;
      } catch { /* keep whatever's already showing */ }
    }

    return {
      elapsedDays, totalDays,
      elecStandingP: elecStanding || null, gasStandingP: gasStanding || null, gasRateP,
      elecMTD, gasMTD, combinedMTD, predictedTotal,
      // usageCost (excludes standing) feeds the balance forecast's blended
      // rate — the forecast adds standing per future month separately, so a
      // standing-inclusive divisor would double-count it.
      elecUsageCost: elec.cost, elecKwh: elec.kwh,
      gasUsageCost: gas ? gas.cost : null, gasKwh: gas ? gas.kwh : null,
      elecPredictedCost: (elecMTD / elapsedDays) * totalDays,
      gasPredictedCost: gasMTD !== null ? (gasMTD / elapsedDays) * totalDays : null,
      elecPredictedKwh: (elec.kwh / elapsedDays) * totalDays,
      gasPredictedKwh: gas ? (gas.kwh / elapsedDays) * totalDays : null,
    };
  } catch (err) { logIssue('MTD/predicted cost', err); return null; }
}

// 7-day per-fuel breakdown (also the source of "latest available day" —
// see renderFuelPanel). Returns { elecWeek, gasWeek } (either may be null),
// or null if neither loaded.
async function fetchWeekBars() {
  const out = { elecWeek: null, gasWeek: null };
  try {
    out.elecWeek = await lastNDaysElecSplitWithStanding(7);
    try { out.gasWeek = await lastNDaysGasSplitWithStanding(7); }
    catch (err) { logIssue('Gas daily cost', err); }
  } catch (err) { logIssue('Daily cost', err); }
  return (out.elecWeek || out.gasWeek) ? out : null;
}

// Bills + their itemised transactions + the grouped-by-month totals for the
// bill-year chart. Returns { bills, txnsByBill, monthsData }, null (no bills
// on the account), or { error: true } (the query failed).
async function fetchBills(billsQ) {
  try {
    const data = await billsQ;
    const bills = (data?.account?.bills?.edges || []).map(e => e.node).filter(b => b.issuedDate);
    bills.sort((a, b) => new Date(b.issuedDate) - new Date(a.issuedDate));
    if (!bills[0]) return null;

    // Itemised breakdown — one fetch across every listed bill's date range.
    // Best-effort: on failure each row still falls back to date + link only.
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

      // Usage (kWh + sub-period) in its own query so a failure here drops
      // only kWh, not the whole breakdown. Fragment target is `... on
      // Charge` (per the API's own error message — `BillCharge` is unrelated).
      try {
        const consData = await krakenGQL(`
          query BillChargeConsumption($accountNumber: String!, $fromDate: Date, $toDate: Date) {
            account(accountNumber: $accountNumber) {
              transactions(fromDate: $fromDate, toDate: $toDate, first: 100) {
                edges { node { ... on Charge { id consumption { quantity unit startDate endDate } } } }
              }
            }
          }`, { accountNumber: store.creds.accountNumber, fromDate: earliest, toDate: spanEnd });
        const consEdges = consData?.account?.transactions?.edges || [];
        const consByCharge = new Map(
          consEdges.map(e => e.node).filter(n => n?.id && n?.consumption).map(n => [n.id, n.consumption])
        );
        let matched = 0;
        txns.forEach(t => { if (consByCharge.has(t.id)) { t.consumption = consByCharge.get(t.id); matched++; } });
        logDebug('Bill charge consumption', `${consEdges.length} edge(s) returned, ${consByCharge.size} with id+consumption, ${matched}/${txns.length} txn(s) matched`);
      } catch (err) { logIssue('Bill charge consumption', err); }

      txnsByBill = bills.map(b => ({
        bill: b,
        items: txns.filter(t => t.postedDate >= b.fromDate && t.postedDate <= b.toDate),
      }));
    } catch (err) { logIssue('Bill transactions', err); }

    return { bills, txnsByBill, monthsData: groupBillsByMonth(txnsByBill) };
  } catch (err) {
    logIssue('Last bill', err);
    return { error: true };
  }
}

/* ------------------------------ Render --------------------------------- */
// Every DOM write + the state-object assignments (fuelData / rateState /
// billingState / billMonthsData), from the fetchBillingData() bag — whether
// that bag was just fetched or read back from the offline cache. Returns
// whether anything real rendered.

function renderBilling(d) {
  let anyLive = false;

  const balancePounds = d.balance?.balancePounds ?? null;
  if (balancePounds !== null) {
    renderBalanceFigure('balance-now', 'balance-now-pill', balancePounds);
    anyLive = true;
  }

  if (d.mtd) {
    const m = d.mtd;
    if (m.elecStandingP) rateState.elecStandingP = m.elecStandingP;
    if (m.gasStandingP) rateState.gasStandingP = m.gasStandingP;
    if (m.gasRateP != null) rateState.gasRateP = m.gasRateP;

    $('cost-mtd').textContent = fmtGBP(m.combinedMTD);
    $('cost-predicted').textContent = fmtGBP(m.predictedTotal);
    $('cycle-bar').style.width = `${Math.min(100, Math.round((m.elapsedDays / m.totalDays) * 100))}%`;
    $('cycle-day').textContent = `Day ${m.elapsedDays} / ${m.totalDays}`;

    fuelData.elec = fuelData.elec || {};
    fuelData.elec.mtd = { cost: m.elecMTD, kwh: m.elecKwh, usageCost: m.elecUsageCost };
    fuelData.elec.predicted = { cost: m.elecPredictedCost, kwh: m.elecPredictedKwh };
    if (m.elecStandingP) $('elec-standing').textContent = `£${(m.elecStandingP / 100).toFixed(2)}/day`;

    if (m.gasMTD !== null) {
      fuelData.gas = fuelData.gas || {};
      fuelData.gas.mtd = { cost: m.gasMTD, kwh: m.gasKwh, usageCost: m.gasUsageCost };
      fuelData.gas.predicted = { cost: m.gasPredictedCost, kwh: m.gasPredictedKwh };
      if (m.gasStandingP) $('gas-standing').textContent = `£${(m.gasStandingP / 100).toFixed(2)}/day`;
      if (m.gasRateP != null) $('gas-unit-rate').textContent = `${m.gasRateP.toFixed(2)}p`;
    }

    if (balancePounds !== null) {
      // DD accounts aren't debited continuously — the month's usage is
      // billed in one lump, so the projection subtracts the FULL predicted
      // month cost, not just the remainder.
      const projected = balancePounds - m.predictedTotal;
      renderBalanceFigure('balance-projected', 'balance-projected-pill', projected);

      if (d.nextPayment) {
        const np = d.nextPayment;
        const afterDD = projected + (np.amount / 100);
        $('next-dd-amount').textContent = fmtGBP(np.amount / 100);
        $('next-dd-label').textContent = np.isEstimate ? 'Direct Debit (est.)' : 'Next Direct Debit';
        renderBalanceFigure('balance-after-dd', 'balance-after-dd-pill', afterDD);
        // Trend: incoming payment vs predicted month cost. Positive =
        // balance building (summer), negative = drawing down (winter).
        const trend = (np.amount / 100) - m.predictedTotal;
        const pill = $('balance-trend-pill');
        pill.className = 'trend-pill ' + (trend >= 0 ? 'up' : 'down');
        pill.textContent = `${trend >= 0 ? '↑' : '↓'} ${fmtGBP(trend)}/mo`;
        billingState = { balancePounds, trend, hasNextPayment: true, nextPaymentAmount: np.amount / 100 };
        $('balance-after-dd-row').style.display = '';
      } else {
        $('balance-after-dd-row').style.display = 'none';
        billingState = { balancePounds, trend: null, hasNextPayment: false, nextPaymentAmount: null };
      }
    }
    anyLive = true;
  }

  if (d.weekBars) {
    if (d.weekBars.elecWeek) {
      fuelData.elec = fuelData.elec || {};
      fuelData.elec.week = d.weekBars.elecWeek;
      logDebug('Elec week breakdown', d.weekBars.elecWeek.map((day, i) => `[${i}] £${dayTotal('elec', day, 'cost').toFixed(2)} (hasData:${day.hasData})`).join(' '));
      renderFuelPanel('elec');
    }
    if (d.weekBars.gasWeek) {
      fuelData.gas = fuelData.gas || {};
      fuelData.gas.week = d.weekBars.gasWeek;
      logDebug('Gas week breakdown', d.weekBars.gasWeek.map((day, i) => `[${i}] £${dayTotal('gas', day, 'cost').toFixed(2)} (hasData:${day.hasData})`).join(' '));
      renderFuelPanel('gas');
    }
    anyLive = true;
  }

  if (d.bills?.error) {
    $('last-bill-row').innerHTML = '<div style="color:var(--text-dim);font-size:12.5px;">Last bill unavailable — check connection or Settings</div>';
    billMonthsData = [];
    selectedBillMonth = null;
    $('bill-year-block').style.display = 'none';
  } else if (d.bills?.bills?.length) {
    renderBillHistory(d.bills.bills, d.bills.txnsByBill);
    renderBillYearChart(d.bills.monthsData);
    anyLive = true;
  }

  return anyLive;
}

// Last-bill row + the collapsible older-bills list, with their toggles
// re-wired (rows are rebuilt every render, so per-button `.onclick` is
// reattached each time; the outer #bill-history-toggle is the persistent
// one restoreToggleToSafety() protects).
function renderBillHistory(bills, txnsByBill) {
  const itemDateRange = t => {
    if (!t.consumption?.startDate || !t.consumption?.endDate) return '';
    const fmt = x => new Date(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `<span class="bh-item-sub">${fmt(t.consumption.startDate)} – ${fmt(t.consumption.endDate)}</span>`;
  };
  const itemKwh = t => {
    if (!t.consumption?.quantity) return '';
    const unitMap = { KILOWATT_HOUR: 'kWh', CUBIC_METERS: 'm³', CUBIC_METRE: 'm³', CUBIC_FEET: 'ft³' };
    const unit = unitMap[t.consumption.unit] || (t.consumption.unit || '').toLowerCase().replace(/_/g, ' ');
    return ` · ${parseFloat(t.consumption.quantity).toFixed(1)}${unit ? ' ' + unit : ''}`;
  };
  const billItemsHtml = items => (items || []).map(t => {
    const charge = isCharge(t);
    const signed = (charge ? -t.amounts.gross : t.amounts.gross) / 100;
    return `<div class="bh-item"><span class="l">${t.title}${itemKwh(t)}${itemDateRange(t)}</span><span class="${charge ? 'v' : 'v credit'}">${signed < 0 ? '−' : '+'}£${Math.abs(signed).toFixed(2)}</span></div>`;
  }).join('');
  const billPeriod = b => {
    const fmt = x => new Date(x).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `${fmt(b.fromDate)} – ${fmt(b.toDate)}`;
  };
  const billRowHtml = (b, collapsible) => {
    const date = new Date(b.issuedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const items = txnsByBill ? txnsByBill.find(x => x.bill.id === b.id)?.items : null;
    const linkHtml = b.temporaryUrl ? `<a class="bh-link" href="${b.temporaryUrl}" target="_blank" aria-label="View bill">View Bill</a>` : '<span class="bh-link" style="opacity:0.4">View Bill</span>';
    const total = billChargeTotal(items);
    const itemsHtml = billItemsHtml(items);
    const toggleHtml = (itemsHtml && collapsible)
      ? `<div class="bh-pill-group" id="bh-pill-group"><button type="button" class="bh-breakdown-toggle" data-bill-id="${b.id}" aria-expanded="false"><span>Show breakdown</span><svg viewBox="0 0 10 6" fill="none" width="9" height="6"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>`
      : '<span></span>';
    return `<div class="bh-row">
      <div class="bh-top">
        <div><div class="bh-date">${date}</div><div class="bh-period"><b>Billing period:</b> ${billPeriod(b)}</div></div>
        ${linkHtml}
      </div>
      <div class="bh-total-row">${toggleHtml}<div class="bh-total">${total != null ? fmtGBP(total) : '—'}</div></div>
      ${itemsHtml ? `<div class="${collapsible ? 'bh-items hidden' : 'bh-items'}" data-bill-id="${b.id}">${itemsHtml}</div>` : ''}
    </div>`;
  };

  // Toggle already guaranteed safe by restoreToggleToSafety() (see there).
  $('last-bill-row').innerHTML = billRowHtml(bills[0], true);

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

  // Per-row breakdown toggles — delegated across both containers since the
  // bill-history rows are rebuilt each render.
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
}

// Bill total over time, grouped by calendar month (a mid-month tariff
// switch produces two bills for one month; two same-labelled bars read as a
// mistake). Rolling most-recent-12 window. Needs >= 2 months to be worth
// drawing.
function renderBillYearChart(monthsData) {
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
