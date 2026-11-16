// Node tests for js/insights-calc.js: cash due per month, the breakdown by type and category, the
// month series, the Avg figure and undated plans. Run with `npm test`.
//
// Hand-worked example (TWD; months are calendar months, everything is a projection from dates):
//
//   Music      monthly    150   renews 2026-02-10   Entertainment
//   Phone      monthly    499   renews 2026-11-05   Utilities
//   Cloud      annual   1,200   renews 2024-03-15   Utilities   (stored date is in the past; the app
//                                                               rolls it forward to 15 Mar each year)
//   Domain     annual     360   renews 2026-12-01   (no category → Uncategorised)
//   Concert    once     2,400   on     2026-12-20   Entertainment
//   Repair     once       800   on     2027-01-08   Home
//   Gym        monthly    900   no renewal date      Health      → not in any month, listed as undated
//   Salary     income  50,000   monthly              → income, never an outgoing
//   Old box    monthly    300   deleted               → ignored
//
//   Month       due                                           cash due
//   Nov 2026    Music 150 + Phone 499                            649
//   Dec 2026    649 + Domain 360 + Concert 2,400               3,409
//   Jan 2027    649 + Repair 800                               1,449
//   Feb 2027    649                                              649
//   Mar 2027    649 + Cloud 1,200                              1,849
//
//   Dec 2026 by category: Entertainment 2,550 (Concert 2,400, Music 150), Utilities 499,
//   Uncategorised 360. By type: monthly 649, annual 360, once 2,400.
//
//   Year 2026, the yearly card (monthly × 12 + annual + one-offs dated 2026):
//     (150 + 499 + 900) × 12 = 18,588   + 1,200 + 360 = 1,560   + 2,400   = 22,548
//     Avg = 22,548 / 12 = 1,879 per month.
//   Without the undated Gym plan the year is 11,748 = Avg 979, which is exactly the sum of the
//   twelve 2026 cash months: Jan 649, Feb 649, Mar 1,849, Apr–Nov 8 × 649 = 5,192, Dec 3,409.
//
//   The old month card for Nov 2026 (annual ÷ 12, undated plans included) showed
//   150 + 499 + 900 + 1,200/12 + 360/12 = 1,679; the cash basis shows 649.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cashDue, breakdown, monthSeries, monthlyAverage, seriesAverage, yearTotal, undatedRecurring, dueInMonth,
} from '../js/insights-calc.js';
import { nextRenewal, amountInMonth } from '../js/util.js';

const item = (over) => ({
  id: over.name, type: 'expense', name: '', domain: '', emoji: '', plan: '', price: 0, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '', date: '', category: '', notes: '', ...over,
});

const ITEMS = [
  item({ name: 'Music', price: 150, nextRenewal: '2026-02-10', category: 'Entertainment' }),
  item({ name: 'Phone', price: 499, nextRenewal: '2026-11-05', category: 'Utilities' }),
  item({ name: 'Cloud', price: 1200, cycle: 'annual', nextRenewal: '2024-03-15', category: 'Utilities' }),
  item({ name: 'Domain', price: 360, cycle: 'annual', nextRenewal: '2026-12-01' }),
  item({ name: 'Concert', price: 2400, cycle: 'once', date: '2026-12-20', category: 'Entertainment' }),
  item({ name: 'Repair', price: 800, cycle: 'once', date: '2027-01-08', category: 'Home' }),
  item({ name: 'Gym', price: 900, category: 'Health' }),
  item({ name: 'Salary', type: 'income', price: 50000 }),
  item({ name: 'Old box', price: 300, nextRenewal: '2026-01-01', del: true }),
];

test('cash due per month matches the hand-worked example', () => {
  assert.deepEqual(monthSeries(ITEMS, 2026, 10, 5), [
    { year: 2026, month: 10, total: 649 },
    { year: 2026, month: 11, total: 3409 },
    { year: 2027, month: 0, total: 1449 },
    { year: 2027, month: 1, total: 649 },
    { year: 2027, month: 2, total: 1849 },
  ]);
  assert.equal(cashDue(ITEMS, 2026, 11), 3409);
});

test('annual plans fall in the month of their renewal date every year, past and future', () => {
  const cloud = ITEMS.find((s) => s.name === 'Cloud');
  for (const year of [2023, 2024, 2025, 2026, 2030]) {
    for (let m = 0; m < 12; m++) assert.equal(dueInMonth(cloud, year, m), m === 2 ? 1200 : 0, `${year}-${m + 1}`);
  }
});

test('a rolled-forward annual date keeps its month, so the cash month is the renewal month', () => {
  const cloud = ITEMS.find((s) => s.name === 'Cloud');
  const next = nextRenewal(cloud); // rolled from 2024-03-15 to the next 15 March on or after today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  assert.ok(next >= today, 'rolled to today or later');
  assert.equal(next.getMonth(), 2);
  assert.equal(next.getDate(), 15);
  assert.equal(dueInMonth(cloud, next.getFullYear(), next.getMonth()), 1200);
  // A 29 February plan rolls to 28 February in other years and still counts in February.
  const leap = item({ name: 'Leap', price: 100, cycle: 'annual', nextRenewal: '2024-02-29' });
  assert.equal(nextRenewal(leap).getMonth(), 1);
  assert.equal(dueInMonth(leap, 2027, 1), 100);
  assert.equal(dueInMonth(leap, 2027, 2), 0);
});

test('one-offs count only in their own month and year', () => {
  const concert = ITEMS.find((s) => s.name === 'Concert');
  assert.equal(dueInMonth(concert, 2026, 11), 2400);
  assert.equal(dueInMonth(concert, 2025, 11), 0);
  assert.equal(dueInMonth(concert, 2026, 10), 0);
});

test('income, deleted items and undated plans are not in the totals', () => {
  for (const name of ['Salary', 'Old box', 'Gym']) {
    const s = ITEMS.find((i) => i.name === name);
    for (let m = 0; m < 12; m++) assert.equal(dueInMonth(s, 2026, m), 0, name);
  }
});

test('breakdown splits the month by type and by category, non-zero rows only, in a stable order', () => {
  const b = breakdown(ITEMS, 2026, 11);
  assert.equal(b.total, 3409);
  assert.deepEqual(b.byType, [
    { key: 'monthly', amount: 649, names: ['Music', 'Phone'] },
    { key: 'annual', amount: 360, names: ['Domain'] },
    { key: 'once', amount: 2400, names: ['Concert'] },
  ]);
  assert.deepEqual(b.byCategory.map((c) => [c.group, c.amount, c.items.map((s) => [s.name, s.due])]), [
    ['Entertainment', 2550, [['Concert', 2400], ['Music', 150]]],
    ['Utilities', 499, [['Phone', 499]]],
    ['Uncategorised', 360, [['Domain', 360]]],
  ]);
  // Totals agree with each other.
  assert.equal(b.byType.reduce((t, r) => t + r.amount, 0), b.total);
  assert.equal(b.byCategory.reduce((t, r) => t + r.amount, 0), b.total);

  // A month with no annual or one-off has only the monthly row; ties keep group order.
  const feb = breakdown(ITEMS, 2027, 1);
  assert.deepEqual(feb.byType.map((t) => t.key), ['monthly']);
  const tie = breakdown([
    item({ name: 'B', price: 10, nextRenewal: '2026-01-01' }),
    item({ name: 'A', price: 10, nextRenewal: '2026-01-01', category: 'Zebra' }),
    item({ name: 'C', price: 10, nextRenewal: '2026-01-01', category: 'apple' }),
  ], 2026, 0);
  assert.deepEqual(tie.byCategory.map((c) => c.group), ['apple', 'Zebra', 'Uncategorised']);
  assert.deepEqual(breakdown([], 2026, 0), { total: 0, byType: [], byCategory: [] });
});

test('Avg is the yearly card total ÷ 12', () => {
  assert.equal(yearTotal(ITEMS, 2026), 22548);
  assert.equal(monthlyAverage(ITEMS, 2026), 1879);
  // With every plan dated, the twelve cash months add up to the yearly total.
  const dated = ITEMS.filter((s) => s.name !== 'Gym');
  const year = monthSeries(dated, 2026, 0, 12);
  assert.equal(year.reduce((t, m) => t + m.total, 0), 11748);
  assert.equal(yearTotal(dated, 2026), 11748);
  assert.equal(monthlyAverage(dated, 2026), 979);
  assert.equal(seriesAverage(year), 979);
  assert.equal(seriesAverage([]), 0);
});

test('undated recurring plans are listed separately, one-offs and income are not', () => {
  const extra = [...ITEMS,
    item({ name: 'Annual no date', price: 1000, cycle: 'annual' }),
    item({ name: 'Bad date', price: 5, nextRenewal: '2026-13' }),
    item({ name: 'Deleted no date', price: 5, del: true }),
  ];
  assert.deepEqual(undatedRecurring(extra).map((s) => s.name), ['Annual no date', 'Bad date', 'Gym']);
  assert.deepEqual(undatedRecurring(ITEMS.filter((s) => s.name !== 'Gym')), []);
});

test('the old month figure for the same data, for comparison', () => {
  const old = ITEMS.filter((s) => s.type !== 'income' && !s.del).reduce((t, s) => t + amountInMonth(s, 2026, 10), 0);
  assert.equal(old, 1679);
  assert.equal(cashDue(ITEMS, 2026, 10), 649);
});
