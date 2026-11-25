// Insights "Paid with" (js/paid-with.js, 1.29.0): the slices add up to By category's month total for
// every month over 24 and 48 months (in each currency), income and other currencies stay out, a stale,
// deleted or unknown `pay` is Not set, and only small cards pool into "Other cards". Imported by
// tests/paid-with.node.test.js (this device's zone) and tests/paid-with-tz.node.test.js (America/New_York).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paidWith, paidWithSlices, offersPaidWith, PAY_KEY_CASH, PAY_KEY_NONE, PAY_KEY_OTHER, payCardKey } from '../js/paid-with.js';
import { listCards } from '../js/cards.js';
import { breakdown } from '../js/insights-calc.js';
import { addMonths } from '../js/calendar-math.js';

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const base = { type: 'expense', currency: 'TWD', category: '', plan: '', date: '', nextRenewal: '', domain: '', emoji: '', notes: '' };
const item = (id, o) => ({ ...base, id, name: id, price: 100, cycle: 'monthly', ...o });
const CARDS = listCards({ id: 'settings', ts: {}, fields: {
  card_visa: { name: 'Visa', colour: 'c1', cut: 31, due: 15 },
  card_master: { name: 'Master', colour: 'c6' },
  card_amex: { name: 'Amex', colour: 'c99' },
  card_old: { name: 'Old', colour: 'c2', gone: true },
} });
const ITEMS = [
  item('rent', { price: 30000, nextRenewal: '2026-12-01', category: 'House', pay: '' }),
  item('phone', { price: 499, nextRenewal: '2026-11-20', category: 'Utilities', pay: 'visa' }),
  item('stream', { price: 390, nextRenewal: '2026-11-18', category: 'Entertainment', pay: 'master' }),
  item('end31', { price: 250, nextRenewal: '2026-01-31', category: 'Entertainment', pay: 'cash' }),
  item('end30', { price: 75, nextRenewal: '2027-04-30', pay: 'old' }),
  item('d29', { price: 60, nextRenewal: '2026-03-29', category: 'Books', pay: 'unseen' }),
  item('cloud', { price: 1200, cycle: 'annual', nextRenewal: '2027-03-15', category: 'Utilities', pay: 'amex' }),
  item('leap', { price: 2900, cycle: 'annual', nextRenewal: '2028-02-29', category: 'Insurance', pay: 'visa' }),
  item('concert', { price: 1500, cycle: 'once', date: '2026-11-28', category: 'Entertainment', pay: 'cash' }),
  item('trip', { price: 18000, cycle: 'once', date: '2027-07-31', category: 'Travel', pay: 'x-later' }),
  item('food', { price: 6000, nextRenewal: '2026-11-02', category: 'Food', pay: 42 }),
  item('gym', { price: 900, nextRenewal: '', category: 'Health', pay: 'visa' }),
  item('tool', { currency: 'USD', price: 10, nextRenewal: '2026-11-22', category: 'Utilities', pay: 'visa' }),
  item('domain', { currency: 'USD', price: 12, cycle: 'annual', nextRenewal: '2027-05-31', category: 'Utilities' }),
  item('salary', { type: 'income', price: 40000, nextRenewal: '2026-11-25', pay: 'visa' }),
  item('bonus', { type: 'income', price: 12000, cycle: 'annual', nextRenewal: '2027-01-10', pay: 'cash' }),
];

/** By category's rows for a month and currency, as js/app.js renderInsights gets them. */
function month(currency, year, m, items = ITEMS) {
  const subs = items.filter((s) => s.currency === currency && s.type !== 'income');
  const b = breakdown(subs, year, m);
  return { b, rows: b.byCategory.flatMap((c) => c.items) };
}

function sums(start, count) {
  for (let i = 0; i < count; i++) {
    const { year, month: m } = addMonths(start[0], start[1], i);
    for (const cur of ['TWD', 'USD']) {
      const { b, rows } = month(cur, year, m);
      const groups = paidWith(rows, CARDS);
      const at = `${cur} ${year}-${m + 1}`;
      assert.equal(groups.reduce((t, g) => t + g.total, 0), b.total, `${at}: the groups add up to By category's total`);
      assert.equal(groups.reduce((t, g) => t + g.count, 0), rows.length, `${at}: every row once`);
      const slices = paidWithSlices(groups, b.total);
      assert.equal(slices.reduce((t, s) => t + s.total, 0), b.total, `${at}: the slices too`);
      // And with every card pooled away (a tiny threshold the other way round): still the same total.
      assert.equal(paidWithSlices(groups, b.total, { small: 1.01 }).reduce((t, s) => t + s.total, 0), b.total);
      // Income is never in it: the income items' ids never appear.
      assert.ok(groups.every((g) => g.items.every((r) => r.type !== 'income')), `${at}: no income`);
      assert.ok(groups.every((g) => g.items.every((r) => r.currency === cur)), `${at}: one currency`);
    }
  }
}

test(`paid with: the slices add up to By category's month total over 24 months (zone ${zone})`, () => {
  sums([2026, 10], 24);
});

test('paid with: 48 more months (2025 to 2026 and 2029 to 2030)', () => {
  sums([2025, 0], 24);
  sums([2029, 0], 24);
});

test('paid with: each live card, Cash and Not set; deleted, unseen and unusable pay is Not set', () => {
  const { b, rows } = month('TWD', 2027, 6); // July 2027: the trip (x-later) and the monthly plans
  const groups = paidWith(rows, CARDS);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  assert.deepEqual(Object.keys(byKey).sort(), [PAY_KEY_CASH, PAY_KEY_NONE, payCardKey('master'), payCardKey('visa')].sort());
  assert.deepEqual(byKey[PAY_KEY_NONE].items.map((r) => r.id).sort(), ['d29', 'end30', 'food', 'rent', 'trip'], "'' , deleted, unseen, a later version's value, a number");
  assert.equal(byKey[PAY_KEY_NONE].total, 30000 + 60 + 75 + 18000 + 6000);
  assert.equal(byKey[payCardKey('visa')].card.name, 'Visa');
  assert.equal(byKey[PAY_KEY_CASH].items.map((r) => r.id).join(), 'end31');
  assert.equal(groups.at(-1).key, PAY_KEY_NONE, 'Not set is last, however large');
  assert.equal(groups.reduce((t, g) => t + g.total, 0), b.total);
  // Largest first among the rest.
  const rest = groups.slice(0, -1).map((g) => g.total);
  assert.deepEqual(rest, [...rest].sort((x, y) => y - x));
  // A card with no items this month has no slice; a card that isn't live is never one.
  assert.ok(!groups.some((g) => g.key === payCardKey('amex') || g.key === payCardKey('old')));
});

test('paid with: ties are cards A-Z, then Cash; rows without an amount are left out', () => {
  const rows = [
    { id: 'a', due: 100, pay: 'cash' }, { id: 'b', due: 100, pay: 'visa' }, { id: 'c', due: 100, pay: 'amex' },
  ];
  assert.deepEqual(paidWith(rows, CARDS).map((g) => g.key), [payCardKey('amex'), payCardKey('visa'), PAY_KEY_CASH]);
  // Rows without an amount are left out.
  assert.deepEqual(paidWith([{ id: 'z', due: 0, pay: 'cash' }, { id: 'y', pay: 'cash' }], CARDS), []);
  assert.deepEqual(paidWith(null, null), []);
});

test('paid with: only cards under 3% pool into Other cards, two or more of them; Cash and Not set never', () => {
  const cards = listCards({ fields: Object.fromEntries('abcdef'.split('').map((k) => [`card_${k}`, { name: k.toUpperCase(), colour: 'c1' }])) });
  const rows = [
    { id: 1, due: 9000, pay: 'a' }, { id: 2, due: 200, pay: 'b' }, { id: 3, due: 100, pay: 'c' },
    { id: 4, due: 50, pay: 'cash' }, { id: 5, due: 40, pay: '' }, { id: 6, due: 610, pay: 'd' },
  ];
  const total = rows.reduce((t, r) => t + r.due, 0); // 10000: b 2%, c 1%, cash 0.5%, Not set 0.4%
  const slices = paidWithSlices(paidWith(rows, cards), total);
  assert.deepEqual(slices.map((s) => s.key), [payCardKey('a'), payCardKey('d'), PAY_KEY_CASH, PAY_KEY_OTHER, PAY_KEY_NONE]);
  const other = slices.find((s) => s.key === PAY_KEY_OTHER);
  assert.deepEqual(other.cards.map((c) => c.name), ['B', 'C']);
  assert.equal(other.total, 300);
  assert.equal(other.count, 2);
  // One small card stays its own slice (pooling it would only hide its name).
  const one = paidWithSlices(paidWith(rows.filter((r) => r.pay !== 'c'), cards), total - 100);
  assert.ok(one.some((s) => s.key === payCardKey('b')) && !one.some((s) => s.key === PAY_KEY_OTHER));
});

test('paid with: offered when there is a live card or an expense with Cash or a card', () => {
  assert.equal(offersPaidWith([], []), false);
  assert.equal(offersPaidWith(null, [{ pay: '' }, {}]), false);
  assert.equal(offersPaidWith(CARDS, []), true);
  assert.equal(offersPaidWith([], [{ pay: 'cash' }]), true);
  assert.equal(offersPaidWith([], [{ pay: 'unseen' }]), true, 'a card id this device has not received yet');
  assert.equal(offersPaidWith([], [{ pay: 'x-later' }]), false, 'a value this version cannot read');
});

test('paid with: the rows passed in stay as they were', () => {
  const { rows } = month('TWD', 2026, 10);
  const before = JSON.stringify(rows);
  paidWithSlices(paidWith(rows, CARDS), 1);
  assert.equal(JSON.stringify(rows), before);
});
