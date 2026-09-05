import { $, fmtGBP } from './format.js';
import { logIssue, logDebug } from './diagnostics.js';
import { rateState } from './rates.js';
import { fuelData, dayTotal, daysInMonth, loadMonthData, fetchYearMonthly } from './usage.js';
import { billingState, billMonthsData } from './billing.js';
import { ensureHistIntensity, intensityForRange } from './carbon.js';

// --- Insights (collapsed by default; data lazy-loaded on first expand) ---

let insightsLoaded = false;

export async function loadInsights() {
  if (insightsLoaded) return;
  insightsLoaded = true;
  try {
    fuelData.elec = fuelData.elec || {};
    fuelData.gas = fuelData.gas || {};
    const tasks = [];
    if (!fuelData.elec.month) tasks.push(loadMonthData('elec'));
    if (!fuelData.gas.month) tasks.push(loadMonthData('gas'));
    if (!fuelData.gas.year) tasks.push(fetchYearMonthly('gas').then(y => { fuelData.gas.year = y; }));
    // Grid-intensity history for the weekly-carbon block — 8 days back covers
    // "the last 7 completed days". Best-effort inside; a failure just hides
    // that one block.
    tasks.push(ensureHistIntensity(Date.now() - 8 * 24 * 60 * 60 * 1000));
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

// Insights — collapsed by default; data is lazy-loaded on the first
// expand only, since it needs a full month's data (~30 calls) that
// shouldn't be paid for on every app load if the user never opens this.
export function handleInsightsHeaderClick() {
  const currentlyExpanded = !$('insights-body').classList.contains('hidden');
  const nowExpanded = !currentlyExpanded;
  $('insights-body').classList.toggle('hidden', !nowExpanded);
  $('insights-hint').classList.toggle('hidden', nowExpanded);
  $('insights-chevron').textContent = nowExpanded ? '▾' : '▸';
  $('insights-header').setAttribute('aria-expanded', String(nowExpanded));
  if (nowExpanded) loadInsights();
}

// A month-array index maps directly to a calendar date (index 0 = the 1st).
// Deliberately independent of the shared `periodMode`/`dateForPeriodIndex`
// used by the Usage panel — Insights can load while that panel is
// showing Week, Day, or Year, so it needs its own fixed month-index mapping.
function insightsMonthDate(index) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), index + 1);
}

// The "today vs 7-day average" trend pill. Arrow/text follow the raw
// direction, but the colour is inverted from it: spending MORE than average
// is bad (coral), LESS is good (mint) — the opposite of the balance-trend
// pill, where a bigger incoming payment is the good outcome. This has
// shipped inverted before, hence a tested function.
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

  // Trend vs 7-day average. Starts from YESTERDAY, not today — today's REST
  // data is essentially always partial (settlement lag), so hasData:true for
  // today means "something exists", not "this day is complete", and a
  // barely-started day reads as a false low point.
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

    // Weekly electricity carbon — the retained half-hourly slots weighted by
    // the grid intensity at the time each was used (carbon.js history cache,
    // warmed in loadInsights). "This week" = the last up-to-7 elapsed days
    // with data. Greenest/dirtiest compare *intensity* (gCO₂/kWh), not total
    // kg, so a low-usage day isn't automatically "greenest".
    const carbonDays = month
      .map((d, i) => ({ d, date: insightsMonthDate(i) }))
      .filter(x => x.d.hasData !== false && x.date < todayMidnight && Array.isArray(x.d.slots) && x.d.slots.length)
      .slice(-7);
    let weekKwh = 0, weekCo2g = 0;
    const dayG = [];
    for (const { d, date } of carbonDays) {
      let dk = 0, dc = 0;
      for (const sl of d.slots) {
        const t = new Date(sl.start).getTime();
        const g = intensityForRange(t, t + 30 * 60 * 1000);
        if (g == null) continue;
        dk += sl.kwh; dc += sl.kwh * g;
      }
      if (dk > 0) { weekKwh += dk; weekCo2g += dc; dayG.push({ date, g: dc / dk }); }
    }
    if (weekKwh > 0 && dayG.length >= 2) {
      const avgG = weekCo2g / weekKwh;
      const fmtDay = dt => dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const greenest = dayG.reduce((a, b) => (b.g < a.g ? b : a));
      const dirtiest = dayG.reduce((a, b) => (b.g > a.g ? b : a));
      $('insights-elec-carbon-value').textContent = `${(weekCo2g / 1000).toFixed(1)} kg CO₂`;
      $('insights-elec-carbon-caption').textContent = `${weekKwh.toFixed(0)} kWh over ${dayG.length} days · avg ${Math.round(avgG)} g/kWh`;
      $('insights-elec-carbon-greenest').textContent = `${Math.round(greenest.g)} g/kWh`;
      $('insights-elec-carbon-greenest-date').textContent = fmtDay(greenest.date);
      $('insights-elec-carbon-dirtiest').textContent = `${Math.round(dirtiest.g)} g/kWh`;
      $('insights-elec-carbon-dirtiest-date').textContent = fmtDay(dirtiest.date);
      $('insights-elec-carbon-block').classList.remove('hidden');
    } else {
      $('insights-elec-carbon-block').classList.add('hidden');
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

    // Weekday/weekend and trajectory — gas equivalents of the two elec-only
    // Insights features, mirrored exactly (same thresholds, wording,
    // conventions) so the two fuels read consistently.
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
  // MTD-blended rate first — it reflects the account's actual off-peak/
  // standard mix, where a flat 50/50 average of today's two rates would
  // systematically overstate electricity cost for an off-peak-skewed (IOG)
  // household. The flat average is only a fallback for when MTD data isn't
  // available at all.
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
      // No matching month last year — flat repeat of this month's predicted cost.
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
  // No debit cycle at all (common, e.g. a well-sized DD) — bars grow from a
  // true bottom baseline rather than reserving space for a negative region
  // that doesn't exist and colliding the £0 and bottom labels.
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

  // The breakdown opens only on an actual tap — selectedForecastCycle stays
  // null until then, so renderBalanceForecastBreakdown(null) keeps the box
  // hidden. (It used to auto-select the lowest-balance month on load.)

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
  // Per-fuel boxes; the total line below still sums both.
  $('insights-standing-elec-ytd').textContent = fmtGBP((rateState.elecStandingP || 0) * daysElapsed / 100);
  $('insights-standing-elec-full').textContent = fmtGBP((rateState.elecStandingP || 0) * daysInYear / 100);
  $('insights-standing-gas-ytd').textContent = fmtGBP((rateState.gasStandingP || 0) * daysElapsed / 100);
  $('insights-standing-gas-full').textContent = fmtGBP((rateState.gasStandingP || 0) * daysInYear / 100);
  const dailyRateP = (rateState.elecStandingP || 0) + (rateState.gasStandingP || 0);
  $('insights-standing-ytd').textContent = fmtGBP((dailyRateP * daysElapsed) / 100);
  $('insights-standing-full-year').textContent = fmtGBP((dailyRateP * daysInYear) / 100);
}

// Same tap-to-reveal pattern for the balance runway forecast — tap a
// cycle's bar to see that month's payment/electricity/gas composition.
export function handleInsightsRunwayBarClick(e) {
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
}
