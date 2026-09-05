/* ==========================================================================
   Kraken Watch — first build
   -------------------------------------------------------------------------
   - Octopus REST API (consumption, tariffs, account/balance): documented,
     stable, uses your API key over HTTP Basic Auth.
   - Kraken GraphQL API (Intelligent Octopus Go dispatches): this is the
     same API the official Octopus app uses, but it isn't officially
     published — field names here are based on community reverse-engineering
     (see the Home Assistant Octopus Energy integration on GitHub) and may
     need adjusting if Octopus changes their schema. If a GraphQL call
     fails, the EV card falls back to demo data and flags itself as such
     rather than breaking the page.
   ========================================================================== */

import { store, logSyncAttempt, getSyncLog, demoFallbackEnabled } from './store.js';
import { $, fmtGBP, fmtP, fmtKwh, fmtT, formatElapsed, APP_VERSION } from './format.js';
import { resetDiagnostics, logIssue, logDebug, logRawDebug, getSyncIssues, renderDiagnostics, sanityCheck } from './diagnostics.js';
import { octRest, krakenGQL, resetKrakenToken, checkRateLimitBlocked } from './api.js';
import { renderPowerMeter, renderChartScale, chartMax, isChartDense, chartLabelOrBlank, renderWeekBars, renderStackedBars } from './charts.js';
import {
  clearRateCacheIfNewDay, rateState, estimateSessionCostP, fetchElecRates, fetchGasRates, fetchStandingCharge,
  rateAt, m3ToKwh, detectGasUnit, GAS_M3_THRESHOLD_DAILY, GAS_M3_THRESHOLD_MONTHLY, costForRange, bucketReadingsByDay,
} from './rates.js';
import {
  loadLiveUsage, loadLive30, closeLive30, openLive30, isLive30Open, pauseLive30Polling, resumeLive30PollingIfOpen,
} from './live-usage.js';
import {
  loadEV, loadVehicleInfoOnce,
  handleEvHeaderClick, handleEvViewToggleClick, handleEvWeekClick, handleEvHistoryPeriodToggleClick,
} from './ev.js';
import {
  fuelData, dayTotal, breakdownRow, daysElapsedInMonth, daysInMonth, isoDate,
  renderFuelPanel, loadMonthData, loadPickedPeriodData,
  lastNDaysElecSplitWithStanding, lastNDaysGasSplitWithStanding, fetchYearMonthly,
  handleUnitToggleClick, handlePeriodToggleClick, handleDatePickerBtnClick,
  handlePickerPrevMonthClick, handlePickerNextMonthClick, handlePickerGridClick,
  handleResetToTodayClick, handleFuelWeekBarClick, handleElecDayBarClick,
} from './usage.js';
import { billingState, billMonthsData, loadBilling, handleBillYearBarClick } from './billing.js';

/* ------------------------------ Rendering -------------------------------- */

function setSyncStatus(state, label) {
  const dot = $('sync-dot');
  dot.className = 'dot' + (state === 'stale' ? ' stale' : state === 'error' ? ' error' : '');
  $('sync-text').textContent = label;
}

let meterDebugNote = null;

// --- Insights (collapsed by default; data lazy-loaded on first expand) ---

let insightsLoaded = false;

async function loadInsights() {
  if (insightsLoaded) return;
  insightsLoaded = true;
  try {
    fuelData.elec = fuelData.elec || {};
    fuelData.gas = fuelData.gas || {};
    const tasks = [];
    if (!fuelData.elec.month) tasks.push(loadMonthData('elec'));
    if (!fuelData.gas.month) tasks.push(loadMonthData('gas'));
    if (!fuelData.gas.year) tasks.push(fetchYearMonthly('gas').then(y => { fuelData.gas.year = y; }));
    await Promise.all(tasks);
    if (fuelData.elec.month) {
      logDebug('Insights elec month', fuelData.elec.month.map((d, i) => `[${i}] £${dayTotal('elec', d, 'cost').toFixed(2)} (hasData:${d.hasData})`).join(' '));
    }
    if (fuelData.gas.month) {
      logDebug('Insights gas month', fuelData.gas.month.map((d, i) => `[${i}] £${dayTotal('gas', d, 'cost').toFixed(2)} (hasData:${d.hasData})`).join(' '));
    }
  } catch (err) {
    logIssue('Insights', err);
  }
  renderInsightsElec();
  renderInsightsGas();
  renderInsightsBilling();
  renderInsightsStanding();
}

// A month-array index maps directly to a calendar date (index 0 = the 1st).
// Deliberately independent of the shared `periodMode`/`dateForPeriodIndex`
// used by the Usage panel — Insights can load while that panel is
// showing Week, Day, or Year, so it needs its own fixed month-index mapping.
function insightsMonthDate(index) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), index + 1);
}

// Extracted from the (previously duplicated, elec+gas) "today vs 7-day
// average" trend pill. Arrow/text follow the raw numeric direction, but the
// colour needs to be inverted from it: spending MORE than average is bad
// news (coral), spending LESS is good news (mint) — the opposite of the
// balance-trend pill elsewhere, where "up" (a bigger incoming payment than
// predicted cost) is the good outcome. Getting this backwards is the exact
// bug the README documents as having shipped twice, caught by the user
// rather than review both times — pulled into one tested function so a
// third slip shows up as a failing test instead.
export function trendVsAverage(value, avg) {
  const diffPct = avg > 0 ? ((value - avg) / avg) * 100 : 0;
  const goodNews = diffPct <= 0;
  return {
    diffPct,
    cssClass: goodNews ? 'up' : 'down',
    text: `${goodNews ? '↓' : '↑'} ${Math.abs(diffPct).toFixed(0)}% ${goodNews ? 'below' : 'above'} your 7-day average`,
  };
}

function renderInsightsElec() {
  const week = fuelData.elec?.week;
  const month = fuelData.elec?.month;

  // Trend vs 7-day average. Deliberately starts from YESTERDAY, not today —
  // today's REST data is essentially always partial (the well-established
  // settlement lag means only a handful of early readings exist for most of
  // the day), so hasData:true for today means "something exists", not "this
  // day is actually complete". Treating a barely-started day as a genuine
  // low point was a real bug, not just an edge case.
  if (week) {
    let found = null, daysAgo = -1;
    for (let i = week.length - 2; i >= 0; i--) {
      if (week[i].hasData !== false) { found = week[i]; daysAgo = week.length - 1 - i; break; }
    }
    const avg = week.reduce((s, d) => s + dayTotal('elec', d, 'cost'), 0) / week.length;
    if (found) {
      const val = dayTotal('elec', found, 'cost');
      const dateStr = found.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const label = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `Latest available day (${dateStr})`;
      $('insights-elec-trend-label').textContent = label;
      $('insights-elec-trend-value').textContent = fmtGBP(val);
      const pill = $('insights-elec-trend-pill');
      const trend = trendVsAverage(val, avg);
      pill.className = 'trend-pill ' + trend.cssClass;
      pill.textContent = trend.text;
      $('insights-elec-trend-caption').textContent = `Your average: ${fmtGBP(avg)}/day`;
    }
  }

  if (month) {
    // Off-peak vs standard split, by cost, across the month so far.
    // Excludes today specifically (not just future dates) — same reasoning
    // as the trend calculation above: today's data is essentially always
    // partial, so including it would understate the split and skew averages
    // toward whatever fraction of today happens to have settled so far.
    const now0 = new Date();
    const todayMidnight = new Date(now0.getFullYear(), now0.getMonth(), now0.getDate());
    let offPeak = 0, standard = 0, offPeakKwh = 0, standardKwh = 0;
    let weekdayTotal = 0, weekdayCount = 0, weekendTotal = 0, weekendCount = 0;
    let high = null, low = null;
    const validDays = month.filter((d, i) => d.hasData !== false && insightsMonthDate(i) < todayMidnight);
    validDays.forEach((d) => {
      offPeak += d.offPeakCost || 0; standard += d.peakCost || 0;
      offPeakKwh += d.offPeakKwh || 0; standardKwh += d.peakKwh || 0;
    });
    const totalCost = offPeak + standard;
    const totalKwh = offPeakKwh + standardKwh;
    if (totalCost > 0) {
      const offPeakPct = (offPeak / totalCost) * 100, standardPct = 100 - offPeakPct;
      $('insights-elec-split-offpeak').style.width = offPeakPct + '%';
      $('insights-elec-split-standard').style.width = standardPct + '%';
      $('insights-elec-split-offpeak-pct').textContent = offPeakPct.toFixed(0) + '%';
      $('insights-elec-split-standard-pct').textContent = standardPct.toFixed(0) + '%';
      const kwhOffPeakPct = totalKwh > 0 ? (offPeakKwh / totalKwh) * 100 : offPeakPct;
      $('insights-elec-split-note').textContent =
        `By energy used, it's closer to ${kwhOffPeakPct.toFixed(0)}/${(100 - kwhOffPeakPct).toFixed(0)} — but Standard rate costs about 4x as much per kWh, so it dominates your bill more than usage alone would suggest.`;
    }

    // Weekday vs weekend, and best/worst day — same pass over the month.
    month.forEach((d, i) => {
      const date = insightsMonthDate(i);
      if (date >= todayMidnight || d.hasData === false) return;
      const total = dayTotal('elec', d, 'cost');
      const dow = date.getDay();
      if (dow === 0 || dow === 6) { weekendTotal += total; weekendCount++; }
      else { weekdayTotal += total; weekdayCount++; }
      if (!high || total > high.total) high = { total, date };
      if (!low || total < low.total) low = { total, date };
    });

    if (weekdayCount > 0 && weekendCount > 0) {
      const weekdayAvg = weekdayTotal / weekdayCount, weekendAvg = weekendTotal / weekendCount;
      const total = weekdayAvg + weekendAvg || 1;
      const weekdayPct = Math.min(88, Math.max(12, Math.round((weekdayAvg / total) * 100)));
      $('insights-elec-weekday-value').textContent = fmtGBP(weekdayAvg);
      $('insights-elec-weekend-value').textContent = fmtGBP(weekendAvg);
      $('insights-elec-weekday-bar').style.width = weekdayPct + '%';
      $('insights-elec-weekend-bar').style.width = (100 - weekdayPct) + '%';
      const diffPct = weekdayAvg > 0 ? ((weekendAvg - weekdayAvg) / weekdayAvg) * 100 : 0;
      const pill = $('insights-elec-pattern-headline');
      if (Math.abs(diffPct) < 5) {
        pill.className = 'trend-pill up';
        pill.textContent = '≈ No significant weekday/weekend difference';
      } else {
        const pricier = diffPct > 0 ? 'Weekends' : 'Weekdays';
        pill.className = 'trend-pill down';
        pill.textContent = `↑ ${pricier} cost ${Math.abs(diffPct).toFixed(0)}% more on average`;
      }
      $('insights-elec-weekday-block').classList.remove('hidden');
    } else {
      $('insights-elec-weekday-block').classList.add('hidden'); // not enough of both kinds yet this month
    }

    if (high && low) {
      $('insights-elec-high-value').textContent = fmtGBP(high.total);
      $('insights-elec-high-date').textContent = high.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('insights-elec-low-value').textContent = fmtGBP(low.total);
      $('insights-elec-low-date').textContent = low.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('insights-elec-extremes-block').classList.remove('hidden');
    } else {
      $('insights-elec-extremes-block').classList.add('hidden');
    }

    // Trajectory: first half of the elapsed month-to-date vs second half.
    if (validDays.length >= 6) {
      const mid = Math.floor(validDays.length / 2);
      const firstHalf = validDays.slice(0, mid), secondHalf = validDays.slice(mid);
      const firstAvg = firstHalf.reduce((s, d) => s + dayTotal('elec', d, 'cost'), 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, d) => s + dayTotal('elec', d, 'cost'), 0) / secondHalf.length;
      const diffPct = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;
      const trendUpSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
      const trendDownSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>';
      $('insights-elec-trajectory-icon').innerHTML = diffPct >= 0 ? trendUpSvg : trendDownSvg;
      $('insights-elec-trajectory-icon').style.color = diffPct >= 0 ? 'var(--coral)' : 'var(--mint)';
      $('insights-elec-trajectory-text').innerHTML = Math.abs(diffPct) < 5
        ? 'Fairly steady so far this month — no clear upward or downward trend'
        : `More recent days running <b>${Math.abs(diffPct).toFixed(0)}% ${diffPct >= 0 ? 'higher' : 'lower'}</b> than earlier this month`;
      $('insights-elec-trajectory-block').classList.remove('hidden');
    } else {
      $('insights-elec-trajectory-block').classList.add('hidden'); // too early in the month for this to mean much
    }
  }
}

function renderInsightsGas() {
  const week = fuelData.gas?.week;
  const month = fuelData.gas?.month;
  const year = fuelData.gas?.year;

  if (week) {
    let found = null, daysAgo = -1;
    for (let i = week.length - 2; i >= 0; i--) {
      if (week[i].hasData !== false) { found = week[i]; daysAgo = week.length - 1 - i; break; }
    }
    const avg = week.reduce((s, d) => s + dayTotal('gas', d, 'cost'), 0) / week.length;
    if (found) {
      const val = dayTotal('gas', found, 'cost');
      const dateStr = found.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const label = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `Latest available day (${dateStr})`;
      $('insights-gas-trend-label').textContent = label;
      $('insights-gas-trend-value').textContent = fmtGBP(val);
      const pill = $('insights-gas-trend-pill');
      const trend = trendVsAverage(val, avg);
      pill.className = 'trend-pill ' + trend.cssClass;
      pill.textContent = trend.text;
      $('insights-gas-trend-caption').textContent = `Your average: ${fmtGBP(avg)}/day`;
    }
  }

  if (month) {
    const now1 = new Date();
    const todayMidnight1 = new Date(now1.getFullYear(), now1.getMonth(), now1.getDate());
    let standing = 0, usage = 0, high = null, low = null;
    let weekdayTotal = 0, weekdayCount = 0, weekendTotal = 0, weekendCount = 0;
    month.forEach((d, i) => {
      const date = insightsMonthDate(i);
      if (date >= todayMidnight1 || d.hasData === false) return;
      standing += d.standing || 0; usage += d.cost || 0;
      const total = dayTotal('gas', d, 'cost');
      if (!high || total > high.total) high = { total, date };
      if (!low || total < low.total) low = { total, date };
      const dow = date.getDay();
      if (dow === 0 || dow === 6) { weekendTotal += total; weekendCount++; }
      else { weekdayTotal += total; weekdayCount++; }
    });
    const total = standing + usage;
    if (total > 0) {
      const standingPct = (standing / total) * 100, usagePct = 100 - standingPct;
      $('insights-gas-split-standing').style.width = standingPct + '%';
      $('insights-gas-split-usage').style.width = usagePct + '%';
      $('insights-gas-split-standing-pct').textContent = standingPct.toFixed(0) + '%';
      $('insights-gas-split-usage-pct').textContent = usagePct.toFixed(0) + '%';
    }
    if (high && low) {
      $('insights-gas-high-value').textContent = fmtGBP(high.total);
      $('insights-gas-high-date').textContent = high.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('insights-gas-low-value').textContent = fmtGBP(low.total);
      $('insights-gas-low-date').textContent = low.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      $('insights-gas-extremes-block').classList.remove('hidden');
    } else {
      $('insights-gas-extremes-block').classList.add('hidden');
    }

    // v2.164: weekday/weekend and trajectory — gas equivalents of the two
    // elec-only Insights features, mirrored exactly (same thresholds, same
    // wording, same fmtGBP/trend-pill conventions) so the two fuels read
    // consistently. These were never carried over when gas's Insights
    // panel was originally built; no reason found for the gap on review.
    if (weekdayCount > 0 && weekendCount > 0) {
      const weekdayAvg = weekdayTotal / weekdayCount, weekendAvg = weekendTotal / weekendCount;
      const totalAvg = weekdayAvg + weekendAvg || 1;
      const weekdayPct = Math.min(88, Math.max(12, Math.round((weekdayAvg / totalAvg) * 100)));
      $('insights-gas-weekday-value').textContent = fmtGBP(weekdayAvg);
      $('insights-gas-weekend-value').textContent = fmtGBP(weekendAvg);
      $('insights-gas-weekday-bar').style.width = weekdayPct + '%';
      $('insights-gas-weekend-bar').style.width = (100 - weekdayPct) + '%';
      const diffPct = weekdayAvg > 0 ? ((weekendAvg - weekdayAvg) / weekdayAvg) * 100 : 0;
      const pill = $('insights-gas-pattern-headline');
      if (Math.abs(diffPct) < 5) {
        pill.className = 'trend-pill up';
        pill.textContent = '≈ No significant weekday/weekend difference';
      } else {
        const pricier = diffPct > 0 ? 'Weekends' : 'Weekdays';
        pill.className = 'trend-pill down';
        pill.textContent = `↑ ${pricier} cost ${Math.abs(diffPct).toFixed(0)}% more on average`;
      }
      $('insights-gas-weekday-block').classList.remove('hidden');
    } else {
      $('insights-gas-weekday-block').classList.add('hidden'); // not enough of both kinds yet this month
    }

    const validDays = month.filter((d, i) => d.hasData !== false && insightsMonthDate(i) < todayMidnight1);
    if (validDays.length >= 6) {
      const mid = Math.floor(validDays.length / 2);
      const firstHalf = validDays.slice(0, mid), secondHalf = validDays.slice(mid);
      const firstAvg = firstHalf.reduce((s, d) => s + dayTotal('gas', d, 'cost'), 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, d) => s + dayTotal('gas', d, 'cost'), 0) / secondHalf.length;
      const diffPct = firstAvg > 0 ? ((secondAvg - firstAvg) / firstAvg) * 100 : 0;
      const trendUpSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
      const trendDownSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>';
      $('insights-gas-trajectory-icon').innerHTML = diffPct >= 0 ? trendUpSvg : trendDownSvg;
      $('insights-gas-trajectory-icon').style.color = diffPct >= 0 ? 'var(--coral)' : 'var(--mint)';
      $('insights-gas-trajectory-text').innerHTML = Math.abs(diffPct) < 5
        ? 'Fairly steady so far this month — no clear upward or downward trend'
        : `More recent days running <b>${Math.abs(diffPct).toFixed(0)}% ${diffPct >= 0 ? 'higher' : 'lower'}</b> than earlier this month`;
      $('insights-gas-trajectory-block').classList.remove('hidden');
    } else {
      $('insights-gas-trajectory-block').classList.add('hidden'); // too early in the month for this to mean much
    }
  }

  // Seasonal narrative from Year data — kWh-based (Year view is deliberately
  // kWh-only), comparing this month's total against the highest month so far.
  if (year && year.length >= 2) {
    const now = new Date();
    const thisMonth = year.find(m => m.month === now.getMonth());
    const peakMonth = year.reduce((max, m) => (m.kwh > (max?.kwh || 0) ? m : max), null);
    if (thisMonth && peakMonth && peakMonth.kwh > 0 && thisMonth.month !== peakMonth.month) {
      const dropPct = ((peakMonth.kwh - thisMonth.kwh) / peakMonth.kwh) * 100;
      const isLowest = year.every(m => m.month === thisMonth.month || m.kwh >= thisMonth.kwh);
      if (Math.abs(dropPct) >= 10) {
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        $('insights-gas-seasonal-text').textContent =
          `${dropPct > 0 ? 'Down' : 'Up'} ${Math.abs(dropPct).toFixed(0)}% from your highest month (${monthNames[peakMonth.month]})` +
          (isLowest && dropPct > 0 ? ' — your lowest month so far this year.' : '.');
        $('insights-gas-seasonal-note').classList.remove('hidden');
      }
    }
  }
}

// Season-aware 12-month balance forecast. For each of the next 12 payment
// cycles, prices *last year's same calendar month's actual kWh* (from
// billMonthsData, already fetched for the bill-year chart — no new API
// calls) at *today's* rate, rather than repeating this month's cost flat
// twelve times. Two things are genuinely unknowable this far out and stay
// fixed at today's value throughout: the unit rate (variable tariffs will
// likely differ by the time a given month arrives) and the Direct Debit
// amount (Octopus reviews and can change it). Everything else — the exact
// day count per month, today's standing charge, last year's real usage —
// is exact, not estimated.
//
// A cycle falls back to a flat repeat of this month's predicted cost only
// when no matching month exists in the bill history (new account, or a
// gap from tariff-switch bill bunching — same limitation already
// documented for the bill-year chart's 15-bill buffer).
function todayBlendedRateP(fuel) {
  const mtd = fuelData[fuel]?.mtd;
  if (!mtd || !mtd.kwh) return null;
  return (mtd.usageCost / mtd.kwh) * 100; // pence/kWh, usage-only — standing charge is added separately per cycle in computeBalanceForecast, so mixing it in here would double-count it
}

function computeBalanceForecast() {
  if (!billingState.hasNextPayment || billingState.balancePounds === null || billingState.nextPaymentAmount === null) return null;
  // v2.218 got the priority order backwards: it made the flat average of
  // today's off-peak/standard rates the primary source, with MTD-blended
  // demoted to a fallback. That fixed the sync-time volatility, but
  // introduced a real accuracy problem — the blended MTD rate reflects
  // this account's *actual* mix of off-peak vs standard usage, while a
  // flat 50/50 average doesn't, and would systematically overstate
  // electricity cost for any household whose usage skews off-peak (as
  // an IOG household's typically does). v2.219: flipped back — MTD-
  // blended first (accurate to real usage mix), the stable-but-cruder
  // average only as fallback when MTD genuinely isn't available (the
  // original v2.217 crash case), rather than the reverse.
  const elecRateP = todayBlendedRateP('elec') ?? (
    (rateState.offPeakRateP != null && rateState.standardRateP != null)
      ? (rateState.offPeakRateP + rateState.standardRateP) / 2
      : null
  );
  const gasRateP = todayBlendedRateP('gas') ?? rateState.gasRateP;
  if (elecRateP === null && gasRateP === null) return null;

  const monthByKey = new Map(billMonthsData.map(m => [`${m.year}-${m.month}`, m]));
  const now = new Date();
  let running = billingState.balancePounds;
  const cycles = [];

  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const lastYearKey = `${d.getFullYear() - 1}-${d.getMonth()}`;
    const histMonth = monthByKey.get(lastYearKey);
    const days = daysInMonth(d);
    let elecCost, gasCost, fallback;

    if (histMonth && (histMonth.elecKwh > 0 || histMonth.gasKwh > 0) && elecRateP !== null) {
      elecCost = (histMonth.elecKwh * elecRateP / 100) + ((rateState.elecStandingP || 0) / 100 * days);
      gasCost = gasRateP !== null ? (histMonth.gasKwh * gasRateP / 100) + ((rateState.gasStandingP || 0) / 100 * days) : 0;
      fallback = false;
    } else {
      // No matching month last year — flat repeat of this month's own
      // predicted cost, same assumption the original single-cycle trend made.
      elecCost = fuelData.elec?.predicted?.cost || 0;
      gasCost = fuelData.gas?.predicted?.cost || 0;
      fallback = true;
    }

    const payment = billingState.nextPaymentAmount;
    const carriedForward = running;
    running += payment - elecCost - gasCost;
    cycles.push({
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
      full: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      fallback,
      carriedForward,
      elec: -elecCost,
      gas: -gasCost,
      payment,
      cumulative: running,
      sourceYear: histMonth ? d.getFullYear() - 1 : null,
      sourceMonthLabel: histMonth ? new Date(d.getFullYear() - 1, d.getMonth(), 1).toLocaleDateString('en-GB', { month: 'short' }) : null
    });
  }
  return cycles;
}

let balanceForecastData = [];
let selectedForecastCycle = null;

function renderBalanceForecastBreakdown(index) {
  const box = $('insights-runway-breakdown');
  if (!box) return;
  if (index === null || !balanceForecastData[index]) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const d = balanceForecastData[index];
  const source = d.fallback
    ? `Not enough billing history for ${d.label} yet — using this month's own predicted cost as a flat estimate.`
    : `Based on ${d.sourceMonthLabel} ${d.sourceYear} usage, priced at today's rates`;
  box.innerHTML = `<div class="breakdown-date">${d.full}</div>`
    + `<div class="breakdown-source">${source}</div>`
    + `<div class="carried-row"><span class="l">Balance carried forward</span><span class="v">${fmtGBP(d.carriedForward)}</span></div>`
    + `<div class="bh-item"><span class="l">Electricity</span><span class="v">${d.elec < 0 ? '−' : '+'}${fmtGBP(d.elec)}</span></div>`
    + `<div class="bh-item"><span class="l">Gas</span><span class="v">${d.gas < 0 ? '−' : '+'}${fmtGBP(d.gas)}</span></div>`
    + `<div class="energy-subtotal"><span class="l">Total energy costs</span><span class="v">−${fmtGBP(Math.abs(d.elec) + Math.abs(d.gas))}</span></div>`
    + `<div class="bh-item" style="margin-top:10px;"><span class="l">Payment</span><span class="v credit">+${fmtGBP(d.payment)}</span></div>`
    + `<div class="breakdown-total"><span>Projected balance</span><span style="color:${d.cumulative < 0 ? 'var(--coral)' : 'var(--mint)'}">${fmtGBP(d.cumulative)}</span></div>`;
}

function renderBalanceForecastChart() {
  const wrap = $('insights-runway-chart-wrap');
  if (!balanceForecastData.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');

  const maxPos = Math.max(...balanceForecastData.map(c => c.cumulative), 0);
  const minCumulative = Math.min(...balanceForecastData.map(c => c.cumulative), 0);
  const hasNegative = minCumulative < 0;
  const maxNeg = hasNegative ? Math.abs(minCumulative) : 0;
  const range = (maxPos + maxNeg) || 1; // only guards true div-by-zero, never fakes a negative range
  const chartH = 100;
  // No genuine debit cycle at all (common case, e.g. a well-sized DD) —
  // bars grow from a true bottom baseline instead of reserving space for a
  // negative region that doesn't exist. Previously this fell back to a
  // fake £1 negative range just to avoid dividing by zero, which pushed
  // the £0 label to sit almost exactly on top of a fabricated bottom
  // label — a real collision, not just a rounding artifact.
  const posH = hasNegative ? (maxPos / range) * chartH : chartH;
  const negH = chartH - posH;

  $('insights-runway-zeroline').style.top = posH + 'px';
  $('insights-runway-scale').innerHTML = hasNegative
    ? `<span style="position:absolute;top:0px;right:0;transform:translateY(-50%)">${fmtGBP(Math.ceil(maxPos))}</span>`
      + `<span style="position:absolute;top:${posH}px;right:0;transform:translateY(-50%)">£0</span>`
      + `<span style="position:absolute;top:${chartH}px;right:0;transform:translateY(-50%)">${fmtGBP(-Math.ceil(maxNeg))}</span>`
    : `<span style="position:absolute;top:0px;right:0;transform:translateY(-50%)">${fmtGBP(Math.ceil(maxPos))}</span>`
      + `<span style="position:absolute;top:${chartH}px;right:0;transform:translateY(-50%)">£0</span>`;

  $('insights-runway-bars').innerHTML = balanceForecastData.map((c, i) => {
    const isNeg = c.cumulative < 0;
    const h = isNeg ? Math.max(2, Math.round((Math.abs(c.cumulative) / maxNeg) * negH))
                     : Math.max(2, Math.round((c.cumulative / maxPos) * posH));
    const pos = isNeg ? `top:${posH}px;height:${h}px` : `bottom:${negH}px;height:${h}px`;
    const cls = 'forecast-bar' + (isNeg ? ' neg' : '') + (c.fallback ? ' fallback' : '') + (i === selectedForecastCycle ? ' selected' : '');
    return `<div class="forecast-col"><div class="forecast-bar-wrap" data-index="${i}"><div class="${cls}" style="${pos}"></div></div></div>`;
  }).join('');
  $('insights-runway-labels').innerHTML = balanceForecastData.map((c, i) =>
    `<span class="${i === selectedForecastCycle ? 'active-day' : ''}">${c.label}</span>`).join('');

  renderBalanceForecastBreakdown(selectedForecastCycle);
}

function renderInsightsBilling() {
  const icon = $('insights-runway-icon'), headline = $('insights-runway-headline'), detail = $('insights-runway-detail');
  balanceForecastData = computeBalanceForecast() || [];

  if (!balanceForecastData.length) {
    icon.textContent = '—';
    headline.textContent = 'Not enough data yet';
    headline.className = 'runway-headline';
    detail.textContent = 'Needs a Direct Debit figure and at least one fuel\'s rate to project from — see the Billing card above.';
    $('insights-runway-chart-wrap').classList.add('hidden');
    return;
  }

  // v2.166: no longer auto-selects the lowest-balance month on load. Was
  // previously deliberate ("so tapping isn't required to see what 'lowest
  // point' means"), but the user found it more useful for the breakdown to
  // only ever open on an actual tap — especially now that it's a richer
  // ledger (ledger structure below) rather than a 3-line summary, auto-
  // opening one felt like more content appearing than was asked for.
  // selectedForecastCycle now stays null until a bar is tapped, so
  // renderBalanceForecastBreakdown(null) just keeps the box hidden.

  const allPositive = balanceForecastData.every(c => c.cumulative >= 0);
  if (allPositive) {
    const lastMonth = balanceForecastData[balanceForecastData.length - 1];
    icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>';
    icon.style.color = 'var(--mint)';
    headline.className = 'runway-headline ok';
    headline.textContent = 'Payments look sufficient';
    detail.textContent = `Projected to stay in credit through ${lastMonth.label}`;
  } else {
    const dipIdx = balanceForecastData.findIndex(c => c.cumulative < 0);
    const recoverIdx = balanceForecastData.findIndex((c, i) => i > dipIdx && c.cumulative >= 0);
    let lowIdx = 0;
    balanceForecastData.forEach((c, i) => { if (c.cumulative < balanceForecastData[lowIdx].cumulative) lowIdx = i; });
    icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    icon.style.color = 'var(--coral)';
    headline.className = 'runway-headline warn';
    if (recoverIdx !== -1) {
      headline.textContent = `Payments may be tight — dips into debit around ${balanceForecastData[dipIdx].label}, recovers by ${balanceForecastData[recoverIdx].label}`;
      detail.textContent = `Lowest point: ${fmtGBP(balanceForecastData[lowIdx].cumulative)} in ${balanceForecastData[lowIdx].label}`;
    } else {
      headline.textContent = `Payments look insufficient — still in debit by ${balanceForecastData[balanceForecastData.length - 1].label}`;
      detail.textContent = `Lowest point: ${fmtGBP(balanceForecastData[lowIdx].cumulative)} in ${balanceForecastData[lowIdx].label} — consider increasing your Direct Debit`;
    }
  }

  renderBalanceForecastChart();
}

function renderInsightsStanding() {
  if (!rateState.elecStandingP && !rateState.gasStandingP) return;
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const daysElapsed = Math.max(1, Math.round((now - startOfYear) / 86400000));
  const daysInYear = (now.getFullYear() % 4 === 0 && (now.getFullYear() % 100 !== 0 || now.getFullYear() % 400 === 0)) ? 366 : 365;
  // v2.212: broken out per-fuel (each fuel its own box) instead of only
  // ever showing the combined total — the total line below still sums
  // both, just no longer as its own separate box (see CSS notes).
  $('insights-standing-elec-ytd').textContent = fmtGBP((rateState.elecStandingP || 0) * daysElapsed / 100);
  $('insights-standing-elec-full').textContent = fmtGBP((rateState.elecStandingP || 0) * daysInYear / 100);
  $('insights-standing-gas-ytd').textContent = fmtGBP((rateState.gasStandingP || 0) * daysElapsed / 100);
  $('insights-standing-gas-full').textContent = fmtGBP((rateState.gasStandingP || 0) * daysInYear / 100);
  const dailyRateP = (rateState.elecStandingP || 0) + (rateState.gasStandingP || 0);
  $('insights-standing-ytd').textContent = fmtGBP((dailyRateP * daysElapsed) / 100);
  $('insights-standing-full-year').textContent = fmtGBP((dailyRateP * daysInYear) / 100);
}

/* ------------------------------ Data loaders ------------------------------ */

async function loadRates() {
  try {
    const now = new Date();
    // v2.167: was `isoDate(now)` (= now.toISOString().slice(0,10), always
    // the UTC calendar date) with a literal Z appended to both boundaries
    // — meant to mean "today, local midnight to midnight" but actually
    // meaning "today, UTC midnight to midnight". During BST (UTC+1), local
    // time crosses into a new day up to an hour before UTC does — so for
    // roughly that hour every night, todayISO silently resolved to
    // yesterday's UTC date, and the whole day's rate fetch was anchored to
    // the wrong 24-hour window: shifted roughly an hour early, and not
    // reaching far enough into what was genuinely still "later today"
    // locally. Confirmed live: at 00:21 BST, this showed Standard and
    // Off-peak as identical (the fetched window had rolled into a stretch
    // containing only off-peak rate data) and "No change today" (nothing
    // in that wrongly-scoped array was later than `now`), even though a
    // real change back to standard rate was still hours away. Fixed by
    // building the boundary from local date components (`dayStart`, which
    // this function already computed a few lines below for its own
    // half-hourly expansion — pulled up here so both uses share it) and
    // letting `.toISOString()` do the correct UTC conversion itself,
    // rather than assembling a UTC-labelled string from a UTC-derived date
    // and treating it as local.
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayEnd = new Date(+dayStart + 24 * 60 * 60 * 1000 - 60000);
    const fromISO = dayStart.toISOString();
    const toISO = dayEnd.toISOString();
    const rows = await fetchElecRates(fromISO, toISO);
    if (!rows.length) throw new Error('No rate data returned');

    // Still expand into 48 half-hourly points — not drawn as a curve anymore,
    // but used for today's average/max and the off-peak threshold check.
    const points = Array.from({ length: 48 }, (_, i) => {
      const t = +dayStart + i * 30 * 60 * 1000;
      return rateAt(rows, t) ?? rows[0].rate;
    });

    const nowIdx = Math.min(47, Math.floor((now - dayStart) / (30 * 60 * 1000)));
    const current = points[nowIdx];
    const threshold = Math.min(...points) + 1; // treat near-minimum as off-peak window

    rateState.offPeakRateP = Math.min(...points);
    rateState.currentRateP = current;
    rateState.standardRateP = Math.max(...points);

    $('rate-value').innerHTML = `${Math.round(current)}<span>p/kWh</span>`;
    $('elec-unit-rate').textContent = `${current.toFixed(1)}p`;
    const isCheap = current <= threshold;
    $('rate-value').style.color = isCheap ? 'var(--mint)' : 'var(--pink)';
    $('rate-pill').className = 'card-tag ' + (isCheap ? 'tag-mint' : 'tag-pink');
    $('rate-pill').innerHTML = isCheap ? '<span class="status-dot"></span>Off-peak' : '<span class="status-dot pink"></span>Standard';
    $('rate-standard').textContent = fmtP(Math.max(...points));
    $('rate-offpeak').textContent = fmtP(rateState.offPeakRateP);

    // Next change: look at the actual rate-change rows, not the expanded points.
    const nextRow = rows.find(r => r.from > +now);
    if (nextRow) {
      const d = new Date(nextRow.from);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      $('rate-next').textContent = `${hh}:${mm} → ${nextRow.rate.toFixed(2)}p`;
    } else {
      $('rate-next').textContent = 'No change today';
    }
    return true;
  } catch (err) {
    logIssue('Rates', err);
    if (demoFallbackEnabled()) {
      rateState.offPeakRateP = 7.5;
      rateState.currentRateP = 7.5;
      rateState.standardRateP = 28.9;
      $('rate-value').innerHTML = `8<span>p/kWh</span>`;
      $('rate-value').style.color = 'var(--mint)';
      $('elec-unit-rate').textContent = '7.5p (demo)';
      $('rate-pill').className = 'card-tag tag-mint';
      $('rate-pill').innerHTML = '<span class="status-dot"></span>Off-peak (demo)';
      $('rate-standard').textContent = '28.9p';
      $('rate-offpeak').textContent = '8.0p';
      $('rate-next').textContent = '05:30 → 28.90p';
    } else {
      $('rate-value').innerHTML = `—<span>p/kWh</span>`;
      $('rate-value').style.color = 'var(--text-dim)';
      $('elec-unit-rate').textContent = 'Unavailable';
      $('rate-pill').className = 'card-tag tag-dim';
      $('rate-pill').innerHTML = '<span class="status-dot dim"></span>Unavailable';
      $('rate-standard').textContent = '—';
      $('rate-offpeak').textContent = '—';
      $('rate-next').textContent = '—';
    }
    return false;
  }
}

async function loadAll(source = 'app-start') {
  const apiKeySnapshot = store.creds?.apiKey;
  setSyncStatus('ok', 'Syncing…');
  resetDiagnostics();
  if (meterDebugNote) logRawDebug(`Meter selection: ${meterDebugNote}`);
  // Rates load first — EV cost estimates reuse today's off-peak rate from this call.
  const ratesResult = await loadRates().catch(() => false);
  // Live usage runs alongside the others but is excluded from the overall
  // sync-status calculation below — not having a telemetry device is a
  // normal, expected state for most accounts, not a sync failure.
  lastSlowTierAt = Date.now(); // this call does the slow tier's own work (loadBilling) directly — see shouldRunSlowTier
  const [, evSettled, billingSettled] = await Promise.allSettled([loadLiveUsage(), loadEV(), loadBilling()]);
  const results = [evSettled, billingSettled];
  const allResults = [ratesResult, ...results.map(r => r.status === 'fulfilled' ? r.value : false)];
  // If either promise rejected outright, capture the real reason — this is
  // the one boundary with no logging at all until now. Every internal path
  // inside loadBilling/loadEV calls logIssue() on its own failures, but an
  // uncaught exception that somehow escapes all of those internal
  // try/catches would land here instead, and previously vanished
  // completely: we checked .status to get true/false but never touched
  // .reason, discarding the actual error.
  if (evSettled.status === 'rejected') logIssue('EV (uncaught)', evSettled.reason);
  if (billingSettled.status === 'rejected') logIssue('Billing (uncaught)', billingSettled.reason);
  await checkRateLimitBlocked();
  logSyncAttempt(source, {
    Rates: ratesResult,
    EV: evSettled.status === 'fulfilled' ? evSettled.value : false,
    Billing: billingSettled.status === 'fulfilled' ? billingSettled.value : false
  }, apiKeySnapshot, getSyncIssues());
  const allReal = allResults.every(v => v === true);
  const anyReal = allResults.some(v => v === true);
  if (allReal) setSyncStatus('ok', `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  else if (anyReal) setSyncStatus('stale', demoFallbackEnabled() ? 'Partially synced — some demo data' : 'Partially synced — some data unavailable');
  else setSyncStatus('error', demoFallbackEnabled() ? 'Using demo data — check settings' : 'Data unavailable — check settings');
  renderDiagnostics();
}

// Automatic background refresh runs in two tiers rather than one flat
// interval, since "how often does this need re-checking" varies wildly:
//
// - Fast tier (this function): rates + EV, ~2 requests total. Both are
//   genuinely time-sensitive — a tariff rate changes at a fixed boundary,
//   and EV charging can start/stop — and both are cheap, so there's no
//   real cost to checking them often.
// - Slow tier (loadSlowTier below): billing, which alone fires ~25+
//   requests every run (7-day elec/gas consumption bars, MTD, bill
//   history, itemized breakdown). None of that changes meaningfully
//   within minutes — smart meter consumption already lags 24-48h — so
//   running that whole bundle as often as the fast tier was very likely
//   tripping Octopus's rate limits intermittently, showing up as real,
//   available data occasionally flaking to "Unavailable" for no visible
//   reason.
//
// Both tiers update sync status/diagnostics independently on completion;
// the initial load and the manual refresh button still call the full
// loadAll() above, so opening the app or tapping refresh always gets
// everything at once regardless of tier timing.

// Tracks when the slow tier last actually ran (set both here and in
// loadAll(), which runs the billing-equivalent work directly) — read by
// the visibility-resume handler below to decide whether reopening the app
// warrants a fresh billing pull or would just repeat one from moments ago.
let lastSlowTierAt = null;
const SLOW_TIER_MIN_INTERVAL_MS = 30 * 60 * 1000;
export function shouldRunSlowTier(lastAt, now) {
  if (lastAt == null) return true;
  return (now - lastAt) >= SLOW_TIER_MIN_INTERVAL_MS;
}

async function loadFastTier() {
  const apiKeySnapshot = store.creds?.apiKey;
  clearRateCacheIfNewDay();
  resetDiagnostics();
  if (meterDebugNote) logRawDebug(`Meter selection: ${meterDebugNote}`);
  const ratesResult = await loadRates().catch(() => false);
  const [evSettled] = await Promise.allSettled([loadEV()]);
  const evResult = evSettled.status === 'fulfilled' ? evSettled.value : false;
  await checkRateLimitBlocked();
  logSyncAttempt('fast', { Rates: ratesResult, EV: evResult }, apiKeySnapshot, getSyncIssues());
  const allResults = [ratesResult, evResult];
  const allReal = allResults.every(v => v === true);
  const anyReal = allResults.some(v => v === true);
  if (allReal) setSyncStatus('ok', `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  else if (anyReal) setSyncStatus('stale', demoFallbackEnabled() ? 'Partially synced — some demo data' : 'Partially synced — some data unavailable');
  else setSyncStatus('error', demoFallbackEnabled() ? 'Using demo data — check settings' : 'Data unavailable — check settings');
  renderDiagnostics();
}

// Deliberately doesn't clear syncIssues/debugNotes — the fast tier does
// that (it runs more often, so it's the natural baseline-reset point). If
// this also cleared them, anything logged here would just get wiped by
// the next fast-tier run 5 minutes later, making billing issues
// effectively invisible in diagnostics.
async function loadSlowTier() {
  // Recorded before attempting, not after succeeding — a repeatedly
  // failing account shouldn't get hammered every time the tab regains
  // focus, only on the normal interval.
  lastSlowTierAt = Date.now();
  const apiKeySnapshot = store.creds?.apiKey;
  let billingSettled;
  try {
    billingSettled = await loadBilling();
  } catch (err) {
    logIssue('Billing (uncaught)', err);
    billingSettled = false;
  }
  logSyncAttempt('slow', { Billing: billingSettled }, apiKeySnapshot, getSyncIssues());
  if (billingSettled === true) setSyncStatus('ok', `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  else setSyncStatus('stale', demoFallbackEnabled() ? 'Partially synced — some demo data' : 'Partially synced — some data unavailable');
  renderDiagnostics();
}
/* ------------------------------ Settings UI ------------------------------- */

function openSettings() {
  const c = store.creds || {};
  $('input-api-key').value = c.apiKey || '';
  $('input-api-key').type = 'password';
  $('toggle-api-key-visibility').textContent = 'Show';
  $('input-account').value = c.accountNumber || '';
  $('input-email').value = c.email || '';
  $('input-password').value = c.password || '';
  $('input-elec-mpan').value = c.manualElecMpan || '';
  $('input-elec-serial').value = c.manualElecSerial || '';
  $('input-gas-mprn').value = c.manualGasMprn || '';
  $('input-gas-serial').value = c.manualGasSerial || '';
  $('input-calorific-value').value = c.calorificValue || '';
  if (c.manualElecMpan || c.manualGasMprn) $('advanced-fields').classList.remove('hidden');
  // v2.191: defaults to whatever Octopus's own device record returned
  // (c.vehicleMake/vehicleModel) unless the user has already saved a
  // genuine override (c.customVehicleMake/Model) — so the field always
  // starts pre-filled with the current real value, editable in place.
  $('input-ev-make').value = c.customVehicleMake || c.vehicleMake || '';
  $('input-ev-model').value = c.customVehicleModel || c.vehicleModel || '';
  $('input-ev-wltp-miles').value = c.wltpMiles || '';
  $('input-ev-wltp-kwh').value = c.wltpBatteryKwh || '';
  $('input-show-diagnostics').checked = c.showDiagnostics !== false;
  $('input-use-demo-fallback').checked = c.useDemoFallback === true;
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

async function saveSettings() {
  const apiKey = $('input-api-key').value.trim();
  const accountNumber = $('input-account').value.trim();
  const email = $('input-email').value.trim();
  const password = $('input-password').value;
  const manualElecMpan = $('input-elec-mpan').value.trim();
  const manualElecSerial = $('input-elec-serial').value.trim();
  const manualGasMprn = $('input-gas-mprn').value.trim();
  const manualGasSerial = $('input-gas-serial').value.trim();
  const calorificValueRaw = $('input-calorific-value').value.trim();
  const calorificValue = calorificValueRaw ? parseFloat(calorificValueRaw) : null;
  if (calorificValueRaw && (!Number.isFinite(calorificValue) || calorificValue <= 0)) {
    alert('Gas calorific value must be a positive number.'); return;
  }
  // v2.191: custom vehicle name — only actually saved as an override if it
  // genuinely differs from the current API-returned value; if the user
  // left the field exactly as pre-filled, this intentionally leaves no
  // override set, so the display keeps following Octopus's own device
  // record automatically (e.g. if the vehicle is ever swapped) rather
  // than permanently freezing to whatever happened to show the one time
  // Settings was opened and saved.
  const evMakeInput = $('input-ev-make').value.trim().slice(0, 15);
  const evModelInput = $('input-ev-model').value.trim().slice(0, 60);
  const priorCreds = store.creds || {};
  const customVehicleMake = evMakeInput && evMakeInput !== (priorCreds.vehicleMake || '') ? evMakeInput : null;
  const customVehicleModel = evModelInput && evModelInput !== (priorCreds.vehicleModel || '') ? evModelInput : null;
  const wltpMilesRaw = $('input-ev-wltp-miles').value.trim();
  const wltpKwhRaw = $('input-ev-wltp-kwh').value.trim();
  const wltpMiles = wltpMilesRaw ? parseFloat(wltpMilesRaw) : null;
  const wltpBatteryKwh = wltpKwhRaw ? parseFloat(wltpKwhRaw) : null;
  if (wltpMilesRaw && (!Number.isFinite(wltpMiles) || wltpMiles <= 0)) {
    alert('WLTP range must be a positive number.'); return;
  }
  if (wltpKwhRaw && (!Number.isFinite(wltpBatteryKwh) || wltpBatteryKwh <= 0)) {
    alert('Battery capacity must be a positive number.'); return;
  }
  const showDiagnostics = $('input-show-diagnostics').checked;
  const useDemoFallback = $('input-use-demo-fallback').checked;
  if (!apiKey || !accountNumber) { alert('API key and account number are required.'); return; }

  store.creds = { ...store.creds, apiKey, accountNumber, email, password, manualElecMpan, manualElecSerial, manualGasMprn, manualGasSerial, calorificValue, customVehicleMake, customVehicleModel, wltpMiles, wltpBatteryKwh, showDiagnostics, useDemoFallback };
  resetKrakenToken();

  // Best-effort: look up meter points + tariff codes automatically from the account.
  // Accounts can have more than one electricity/gas meter point on record (e.g.
  // after a smart meter exchange, the old meter point often stays listed) —
  // blindly taking index [0] can pick a decommissioned meter with no consumption
  // data even though its tariff/agreement info still resolves fine. This prefers
  // the currently-occupied property and the meter point with an active agreement.
  try {
    const acct = await octRest(`/accounts/${accountNumber}/`);
    const properties = acct.properties || [];
    const prop = properties.find(p => !p.moved_out_at) || properties[0];

    const now = new Date();
    const isActive = a => !a.valid_to || new Date(a.valid_to) > now;

    const elecMps = prop?.electricity_meter_points || [];
    const elecMp = elecMps.find(mp => (mp.agreements || []).some(isActive)) || elecMps[0];
    const gasMps = prop?.gas_meter_points || [];
    const gasMp = gasMps.find(mp => (mp.agreements || []).some(isActive)) || gasMps[0];

    const agreement = elecMp?.agreements?.find(isActive);
    const gasAgreement = gasMp?.agreements?.find(isActive);
    const creds = store.creds;
    creds.elecMpan = elecMp?.mpan;
    creds.elecSerial = elecMp?.meters?.[elecMp.meters.length - 1]?.serial_number;
    creds.gasMprn = gasMp?.mprn;
    creds.gasSerial = gasMp?.meters?.[gasMp.meters.length - 1]?.serial_number;
    if (agreement?.tariff_code) {
      // tariff codes look like E-1R-INTELLI-VAR-22-10-14-C — product code is the middle segment
      const parts = agreement.tariff_code.split('-');
      creds.elecTariffCode = agreement.tariff_code;
      creds.elecProductCode = parts.slice(2, -1).join('-');
    }
    if (gasAgreement?.tariff_code) {
      const parts = gasAgreement.tariff_code.split('-');
      creds.gasTariffCode = gasAgreement.tariff_code;
      creds.gasProductCode = parts.slice(2, -1).join('-');
    }
    store.creds = creds;

    meterDebugNote = `${properties.length} propert${properties.length === 1 ? 'y' : 'ies'}, ` +
      `${elecMps.length} elec meter point(s) (using MPAN ${elecMp?.mpan || '—'}, serial ${creds.elecSerial || '—'}, ${elecMp?.meters?.length || 0} meter(s) on record), ` +
      `${gasMps.length} gas meter point(s) (using MPRN ${gasMp?.mprn || '—'}, serial ${creds.gasSerial || '—'})`;
  } catch (err) {
    logIssue('Meter-point lookup', err);
  }

  // Manual overrides always win over auto-detection, if provided.
  if (manualElecMpan && manualElecSerial) {
    const creds = store.creds;
    creds.elecMpan = manualElecMpan;
    creds.elecSerial = manualElecSerial;
    store.creds = creds;
  }
  if (manualGasMprn && manualGasSerial) {
    const creds = store.creds;
    creds.gasMprn = manualGasMprn;
    creds.gasSerial = manualGasSerial;
    store.creds = creds;
  }

  closeSettings();
  $('connect-card').classList.add('hidden');
  $('app-content').classList.remove('hidden');
  loadAll();
  startAutoRefresh();
}

/* --------------------------------- Init ----------------------------------- */

// Two-tier automatic background refresh (see the comment above loadFastTier
// for the full reasoning): rates + EV are cheap and time-sensitive, so they
// keep checking every 5 minutes like before. Billing is expensive (~25+
// requests) and not time-sensitive, so it drops to every 6 hours —
// that bundle running as often as everything else was the likely cause
// of intermittent "Unavailable" flashes on data that genuinely was there.
//
// Called both from init() (a returning user who already has saved
// credentials) and from the end of saveSettings() (first-time setup) —
// those are the only two ways the app content becomes visible, and this
// needs to start regardless of which one just happened. autoRefreshStarted
// guards against ever double-starting these on the rare path where both
// could theoretically fire in the same session (e.g. saving settings again
// after an initial successful load).
// Interval IDs, tracked (previously discarded) so every recurring fetch —
// both tiers, live usage, and the Last-30-min panel's own poll if it's
// open — can be paused while the tab is hidden and cleanly restarted when
// it isn't, rather than running unattended in the background indefinitely
// and burning against Octopus's shared rate limit for a screen nobody is
// looking at.
let fastTierIntervalId = null;
let slowTierIntervalId = null;
let liveUsageIntervalId = null;

function stopAutoRefreshTimers() {
  if (fastTierIntervalId) { clearInterval(fastTierIntervalId); fastTierIntervalId = null; }
  if (slowTierIntervalId) { clearInterval(slowTierIntervalId); slowTierIntervalId = null; }
  if (liveUsageIntervalId) { clearInterval(liveUsageIntervalId); liveUsageIntervalId = null; }
  // Paused, not closed — live-usage.js's own live30Open flag is left as-is
  // (see closeLive30, which is the actual "the user closed it" path and
  // also resets that flag) so a tab that goes hidden with the panel open
  // resumes polling it, rather than silently losing the fact that it was
  // open, when the tab is visible again.
  pauseLive30Polling();
}

function startAutoRefreshTimers() {
  // Idempotent — pageshow and visibilitychange can both fire for the same
  // bfcache-restore transition, and without this guard that would double-
  // schedule every interval rather than the second call being a no-op.
  if (fastTierIntervalId) return;
  fastTierIntervalId = setInterval(loadFastTier, 5 * 60 * 1000);
  // Usage bars/MTD, bills, standing charges, balance/DD — everything
  // in loadBilling() — genuinely can't reveal new information more often
  // than this. Smart meter consumption lags 24-48h regardless of how often
  // we ask; bills land on Octopus's own roughly-monthly schedule; standing
  // charges change over weeks, not minutes. 30 minutes was needlessly
  // frequent and was very likely the main contributor to hitting Octopus's
  // documented 100-calls/hour shared rate limit.
  slowTierIntervalId = setInterval(loadSlowTier, 6 * 60 * 60 * 1000);
  // Live usage refreshes faster on its own — 30s, matching roughly how
  // often new telemetry actually shows up, without re-running either tier.
  liveUsageIntervalId = setInterval(() => loadLiveUsage().catch(() => {}), 30 * 1000);
  resumeLive30PollingIfOpen();
}

// Runs once when the tab regains focus (or returns from the bfcache) after
// having been hidden — not on every visibility event, and never
// overlapping itself if one is already in flight (e.g. a rapid tab-switch
// double-fire). Fast tier is cheap enough to always re-run; slow tier only
// if shouldRunSlowTier says genuinely enough time has passed, so reopening
// the app a minute after switching away doesn't repeat a ~25-request
// billing pull for nothing new.
let resumeRefreshInFlight = false;
async function refreshOnResume() {
  if (resumeRefreshInFlight) return;
  resumeRefreshInFlight = true;
  try {
    await loadFastTier().catch(() => {});
    if (shouldRunSlowTier(lastSlowTierAt, Date.now())) await loadSlowTier().catch(() => {});
    await loadLiveUsage().catch(() => {});
    if (isLive30Open()) await loadLive30().catch(() => {});
  } finally {
    resumeRefreshInFlight = false;
  }
}

let autoRefreshStarted = false;
function startAutoRefresh() {
  if (autoRefreshStarted) return;
  autoRefreshStarted = true;
  // Not a timer — vehicle registration never changes in normal use, so this
  // runs once per app lifetime (the function itself no-ops on every later
  // call once cached), not on any recurring schedule at all.
  loadVehicleInfoOnce().catch(() => {});
  startAutoRefreshTimers();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAutoRefreshTimers();
    else { refreshOnResume(); startAutoRefreshTimers(); }
  });
  // Covers the bfcache-restore case (e.g. an iOS Safari swipe-back into an
  // already-loaded tab) — visibilitychange alone doesn't always fire here,
  // but the page is exactly as stale as if it had been hidden the whole
  // time it sat in the cache.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) { refreshOnResume(); startAutoRefreshTimers(); }
  });
}

function init() {
  $('app-version').textContent = APP_VERSION;
  $('settings-btn').addEventListener('click', openSettings);
  $('connect-btn').addEventListener('click', openSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click', saveSettings);
  // Single static row, unlike bill-history's per-row toggles which get
  // rebuilt (and re-delegated) every sync — this one only ever needs
  // wiring once, since #octo-history itself is what gets refreshed.
  $('octo-toggle').addEventListener('click', () => {
    const open = $('octo-toggle').getAttribute('aria-expanded') === 'true';
    $('octo-toggle').setAttribute('aria-expanded', String(!open));
    $('octo-toggle').querySelector('span').textContent = open ? 'Show history' : 'Hide history';
    $('octo-history').classList.toggle('hidden', open);
  });
  $('toggle-api-key-visibility').addEventListener('click', () => {
    const field = $('input-api-key');
    const btn = $('toggle-api-key-visibility');
    const showing = field.type === 'text';
    field.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
    btn.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
  });
  $('advanced-toggle').addEventListener('click', () => $('advanced-fields').classList.toggle('hidden'));
  $('live30-toggle').addEventListener('click', () => { isLive30Open() ? closeLive30() : openLive30(); });
  $('ev-header').addEventListener('click', handleEvHeaderClick);
  $('ev-view-toggle').addEventListener('click', handleEvViewToggleClick);
  $('ev-week').addEventListener('click', handleEvWeekClick);
  $('ev-history-period-toggle').addEventListener('click', handleEvHistoryPeriodToggleClick);

  // Insights — collapsed by default; data is lazy-loaded on the first
  // expand only, since it needs a full month's data (~30 calls) that
  // shouldn't be paid for on every app load if the user never opens this.
  $('insights-header').addEventListener('click', () => {
    const currentlyExpanded = !$('insights-body').classList.contains('hidden');
    const nowExpanded = !currentlyExpanded;
    $('insights-body').classList.toggle('hidden', !nowExpanded);
    $('insights-hint').classList.toggle('hidden', nowExpanded);
    $('insights-chevron').textContent = nowExpanded ? '▾' : '▸';
    $('insights-header').setAttribute('aria-expanded', String(nowExpanded));
    if (nowExpanded) loadInsights();
  });

  // £ / kWh toggle — per fuel panel, instant re-render from cached data.
  document.querySelectorAll('.unit-toggle[data-fuel] .unit-toggle-btn').forEach(btn => {
    btn.addEventListener('click', handleUnitToggleClick);
  });

  // Day / Week / Month / Year toggle — shared across both fuel panels.
  // Month/Year data is fetched lazily on first use rather than on every
  // sync; Day is electricity-only, but the fetch is harmless to attempt
  // unconditionally since renderFuelPanel handles gas's "not available"
  // state regardless of whether fuelData.elec.day ends up populated.
  document.querySelectorAll('.unit-toggle[data-role="period"] .unit-toggle-btn').forEach(btn => {
    btn.addEventListener('click', handlePeriodToggleClick);
  });

  // Date picker: calendar button opens/closes the panel; month nav browses
  // without changing the pick; tapping a day picks it and closes the panel;
  // reset/jump-to-today both clear the pick and fall back to the normal
  // today-anchored view everywhere else in the app already uses.
  $('date-picker-btn').addEventListener('click', handleDatePickerBtnClick);
  $('picker-prev-month').addEventListener('click', handlePickerPrevMonthClick);
  $('picker-next-month').addEventListener('click', handlePickerNextMonthClick);
  $('picker-grid').addEventListener('click', handlePickerGridClick);
  $('date-picker-reset').addEventListener('click', handleResetToTodayClick);
  $('picker-jump-today').addEventListener('click', handleResetToTodayClick);

  // Tap a bar to see that day's (or month's) breakdown; tap the same bar
  // again to close it. Event delegation so it works regardless of how many
  // bars get re-rendered (week/month/year all reuse this).
  ['elec', 'gas'].forEach(fuel => {
    $(`${fuel}-week`).addEventListener('click', handleFuelWeekBarClick);
  });

  // Same tap-to-reveal pattern for the bill-total-over-time chart — tap a
  // month's bar to see its gas/electricity split underneath (and a note +
  // link if that month combined more than one bill). Re-renders just the
  // selection/breakdown, not the whole chart, since the bar heights
  // themselves don't change on tap.
  $('bill-year-bars').addEventListener('click', handleBillYearBarClick);

  // Same tap-to-reveal pattern for the balance runway forecast — tap a
  // cycle's bar to see that month's payment/electricity/gas composition.
  $('insights-runway-bars').addEventListener('click', (e) => {
    const bar = e.target.closest('.forecast-bar-wrap');
    if (!bar) return;
    const index = parseInt(bar.dataset.index, 10);
    if (Number.isNaN(index)) return;
    selectedForecastCycle = (selectedForecastCycle === index) ? null : index;
    document.querySelectorAll('#insights-runway-bars .forecast-bar-wrap').forEach(el => {
      const isSel = parseInt(el.dataset.index, 10) === selectedForecastCycle;
      el.querySelector('.forecast-bar').classList.toggle('selected', isSel);
    });
    document.querySelectorAll('#insights-runway-labels span').forEach((el, i) => {
      el.classList.toggle('active-day', i === selectedForecastCycle);
    });
    renderBalanceForecastBreakdown(selectedForecastCycle);
  });

  // Same tap-to-reveal pattern for the Day view's half-hourly slots.
  $('elec-day-bars').addEventListener('click', handleElecDayBarClick);


  $('sync-btn').addEventListener('click', async () => {
    const btn = $('sync-btn');
    btn.classList.add('spinning');
    try { await loadAll('button'); } finally { btn.classList.remove('spinning'); }
  });

  if (store.creds?.apiKey) {
    $('connect-card').classList.add('hidden');
    $('app-content').classList.remove('hidden');
    loadAll();
    startAutoRefresh();
  }

  if ('serviceWorker' in navigator) {
    // updateViaCache: 'none' forces the browser to always fetch sw.js fresh
    // over the network rather than from HTTP cache when checking for updates —
    // without this, some hosts/CDNs can keep serving a stale sw.js indefinitely,
    // which means the app never picks up new app.js/index.html versions.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}

// Only bootstrap against a document that actually has this app's markup —
// #connect-btn is present unconditionally in index.html's initial HTML, so
// its absence means this module was imported into some other document (a
// test's bare jsdom document, most likely) rather than loaded as the real
// page's own script. That's also what keeps `npm test` side-effect-free:
// every test file imports from this module, and none of them should
// trigger a real init() wiring up listeners against elements that don't
// exist.
if (document.getElementById('connect-btn')) {
  // As a module script, this file is deferred — DOMContentLoaded may
  // already have fired by the time it runs, so the event alone isn't
  // reliable.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
