import { describe, it, expect, beforeEach } from 'vitest';
import { pickNextPayment, billChargeTotal, groupBillsByMonth } from '../billing.js';

// --- pickNextPayment -------------------------------------------------------

describe('pickNextPayment', () => {
  const pay = (paymentDate, status = 'SCHEDULED', amount = 9500) => ({ paymentDate, status, amount });

  it('takes the soonest future-dated payment, whatever its status', () => {
    const payments = [
      pay('2026-12-01', 'PENDING'),
      pay('2026-09-28', 'REQUESTED'),
      pay('2026-10-28', 'SCHEDULED'),
    ];
    const { payment, futureCount } = pickNextPayment(payments, '2026-09-06');
    expect(payment.paymentDate).toBe('2026-09-28');
    expect(payment.isEstimate).toBeUndefined();
    expect(futureCount).toBe(3);
  });

  it('counts a payment dated exactly today as future', () => {
    const { payment } = pickNextPayment([pay('2026-09-06')], '2026-09-06');
    expect(payment.paymentDate).toBe('2026-09-06');
  });

  it('falls back to the most recent past payment, flagged as an estimate', () => {
    const payments = [
      pay('2026-06-28', 'PAID'),
      pay('2026-08-28', 'PAID'),
      pay('2026-07-28', 'PAID'),
    ];
    const { payment, futureCount } = pickNextPayment(payments, '2026-09-06');
    expect(payment.paymentDate).toBe('2026-08-28');
    expect(payment.isEstimate).toBe(true);
    expect(futureCount).toBe(0);
  });

  it('ignores CANCELLED / FAILED payments in the past fallback', () => {
    const payments = [
      pay('2026-08-28', 'FAILED'),
      pay('2026-08-20', 'CANCELLED'),
      pay('2026-07-28', 'PAID'),
    ];
    const { payment } = pickNextPayment(payments, '2026-09-06');
    expect(payment.paymentDate).toBe('2026-07-28');
    expect(payment.isEstimate).toBe(true);
  });

  it('returns { payment: null, futureCount: 0 } for empty or nullish input', () => {
    expect(pickNextPayment([], '2026-09-06')).toEqual({ payment: null, futureCount: 0 });
    expect(pickNextPayment(null, '2026-09-06')).toEqual({ payment: null, futureCount: 0 });
  });
});

// --- billChargeTotal -----------------------------------------------------

describe('billChargeTotal', () => {
  it('sums only Charge-typed items and returns pounds, excluding payments/credits', () => {
    const items = [
      { __typename: 'Charge', amounts: { gross: 3200 } },
      { __typename: 'Charge', amounts: { gross: 1800 } },
      { __typename: 'Payment', amounts: { gross: 9500 } },       // ignored
      { __typename: 'Credit', amounts: { gross: 250 } },          // ignored
    ];
    expect(billChargeTotal(items)).toBeCloseTo(50, 6);
  });

  it('returns null for an empty or absent item list', () => {
    expect(billChargeTotal([])).toBeNull();
    expect(billChargeTotal(null)).toBeNull();
    expect(billChargeTotal(undefined)).toBeNull();
  });
});

// --- groupBillsByMonth --------------------------------------------------

describe('groupBillsByMonth', () => {
  beforeEach(() => localStorage.clear());

  const charge = (title, grossPence, consumption) => ({
    __typename: 'Charge', title, amounts: { gross: grossPence }, consumption,
  });
  const bill = (id, issuedDate, items, temporaryUrl = `http://bill/${id}`) => ({
    bill: { id, issuedDate, temporaryUrl }, items,
  });

  it('splits a bill into per-fuel £ and kWh by transaction title', () => {
    const [row] = groupBillsByMonth([
      bill('b1', '2026-08-15', [
        charge('Electricity charges', 3200, { quantity: '210', unit: 'KILOWATT_HOUR' }),
        charge('Gas charges', 1800, { quantity: '90', unit: 'KILOWATT_HOUR' }),
      ]),
    ]);
    expect(row).toMatchObject({ year: 2026, month: 7, elec: 32, gas: 18, elecKwh: 210, gasKwh: 90 });
    expect(row.total).toBeCloseTo(50, 6);
    expect(row.bills).toHaveLength(1);
  });

  it('merges two bills issued in the same calendar month', () => {
    const rows = groupBillsByMonth([
      bill('b1', '2026-08-03', [charge('Electricity', 1000, { quantity: '50', unit: 'KILOWATT_HOUR' })]),
      bill('b2', '2026-08-27', [charge('Electricity', 1500, { quantity: '80', unit: 'KILOWATT_HOUR' })]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].elec).toBeCloseTo(25, 6);
    expect(rows[0].elecKwh).toBe(130);
    expect(rows[0].bills.map(b => b.issuedDate)).toEqual(['2026-08-03', '2026-08-27']);
  });

  it('sorts oldest-first and keeps only the most recent 12 distinct months', () => {
    // 14 consecutive months, 2025-06 .. 2026-07, spanning a year boundary.
    const bills = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(2025, 5 + i, 15);
      bills.push(bill(`b${i}`, d.toISOString().slice(0, 10), [charge('Electricity', 1000, null)]));
    }
    const rows = groupBillsByMonth(bills);
    expect(rows).toHaveLength(12);                       // oldest 2 dropped
    expect(rows[0]).toMatchObject({ year: 2025, month: 7 });   // Aug 2025 (Jun+Jul dropped)
    expect(rows[11]).toMatchObject({ year: 2026, month: 6 });  // Jul 2026
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      expect(b.year * 12 + b.month).toBeGreaterThan(a.year * 12 + a.month);
    }
  });

  it('converts a m³ consumption quantity to kWh rather than using it raw', () => {
    const [row] = groupBillsByMonth([
      bill('b1', '2026-08-15', [charge('Gas', 1800, { quantity: '10', unit: 'CUBIC_METERS' })]),
    ]);
    // 10 m3 at the default 40.0 calorific value ≈ 113.6 kWh, not 10
    expect(row.gasKwh).toBeCloseTo((10 * 1.02264 * 40) / 3.6, 4);
    expect(row.gasKwh).toBeGreaterThan(100);
  });

  it('returns [] for empty or nullish input', () => {
    expect(groupBillsByMonth([])).toEqual([]);
    expect(groupBillsByMonth(null)).toEqual([]);
  });
});
