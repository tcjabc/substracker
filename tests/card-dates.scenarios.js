// Card dates (js/card-dates.js, 1.29.0): the day maths in short months and leap years, one date of
// each kind per card a month, the due-soon window, the calendar marker, and the isolation test: over
// 24 and 48 months every money figure (the calendar's, Insights', the Money strip's, the Wallet's and
// due soon's) is the same with cards and `pay` fields as without them. Imported by
// tests/card-dates.node.test.js (this device's zone) and tests/card-dates-tz.node.test.js
// (America/New_York, which has DST).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardKinds, cardDays, cardDatesInMonth, cardDatesSoon, cardMarker, CARD_DATE_KINDS } from '../js/card-dates.js';
import { listCards } from '../js/cards.js';
import { occurrences, addMonths } from '../js/calendar-math.js';
import { cashDue, incomeDue, dueInMonth, incomeInMonth, stripSummary, monthSeries, yearSummary, breakdown, undatedItems } from '../js/insights-calc.js';
import { walletGroups } from '../js/wallet-math.js';
import { dueSoon, WINDOWS } from '../js/due-soon.js';

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const card = (id, o = {}) => ({ id, name: id, colour: 'c1', cut: null, due: null, ...o });
const record = (fields) => ({ id: 'settings', fields, ts: {} });

test(`card dates: day maths (zone ${zone})`, () => {
  // Day 31: the 30th in 30-day months, 28 or 29 February, the 31st again after.
  const c31 = card('a', { due: 31 });
  assert.deepEqual(cardDays(c31, 2026, 3), [{ kind: 'due', day: 30 }], 'April 2026');
  assert.deepEqual(cardDays(c31, 2027, 1), [{ kind: 'due', day: 28 }], 'February 2027');
  assert.deepEqual(cardDays(c31, 2028, 1), [{ kind: 'due', day: 29 }], 'February 2028 (leap)');
  assert.deepEqual(cardDays(c31, 2100, 1), [{ kind: 'due', day: 28 }], 'February 2100 (not leap)');
  assert.deepEqual(cardDays(c31, 2000, 1), [{ kind: 'due', day: 29 }], 'February 2000 (leap)');
  assert.deepEqual(cardDays(c31, 2026, 4), [{ kind: 'due', day: 31 }], 'May 2026');
  // Day 30 and day 29 in February.
  assert.deepEqual(cardDays(card('b', { cut: 30 }), 2027, 1), [{ kind: 'cut', day: 28 }]);
  assert.deepEqual(cardDays(card('b', { cut: 29 }), 2027, 1), [{ kind: 'cut', day: 28 }]);
  assert.deepEqual(cardDays(card('b', { cut: 29 }), 2028, 1), [{ kind: 'cut', day: 29 }]);
  // Both clamped onto the same day: both dates, the payment due first.
  assert.deepEqual(cardDays(card('c', { cut: 30, due: 31 }), 2027, 1), [{ kind: 'due', day: 28 }, { kind: 'cut', day: 28 }]);
  // Independent days: the cut-off after the due day in the month is fine.
  assert.deepEqual(cardDays(card('d', { cut: 25, due: 10 }), 2026, 10), [{ kind: 'due', day: 10 }, { kind: 'cut', day: 25 }]);
});

test('card dates: at most one of each kind a month, one date for one day set, none for none', () => {
  const both = card('both', { cut: 31, due: 29 });
  const one = card('one', { due: 15 });
  const cutOnly = card('cutOnly', { cut: 1 });
  const none = card('none');
  for (let i = 0; i < 600; i++) {
    const { year, month } = addMonths(2020, 0, i);
    const d = cardDays(both, year, month);
    assert.deepEqual(d.map((x) => x.kind).sort(), ['cut', 'due'], `${year}-${month + 1}`);
    assert.equal(cardDays(one, year, month).length, 1);
    assert.equal(cardDays(cutOnly, year, month)[0].day, 1);
    assert.deepEqual(cardDays(none, year, month), []);
  }
  assert.deepEqual(cardKinds(one), [{ kind: 'due', day: 15 }]);
  assert.deepEqual(cardKinds(none), []);
  assert.deepEqual(CARD_DATE_KINDS, ['due', 'cut']);
});

test('card dates: deleted cards, unusable days and unknown colours, as js/cards.js reads them', () => {
  const rec = record({
    card_live: { name: 'Visa', colour: 'c3', cut: 5, due: 25 },
    card_gone: { name: 'Old', colour: 'c2', cut: 5, due: 25, gone: true },
    card_bad: { name: 'Bad days', colour: 'c4', cut: 0, due: 32 },
    card_odd: { name: 'Odd', colour: 'c99', due: 12.5, cut: '7' },
    card_new: { name: 'Later', colour: 'x-new', due: 12, extra: { kept: true } },
  });
  const cards = listCards(rec);
  assert.deepEqual(cards.map((c) => c.id).sort(), ['bad', 'live', 'new', 'odd']);
  const nov = cardDatesInMonth(cards, 2026, 10);
  assert.equal(nov.length, 30);
  const all = nov.flatMap((l, i) => l.map((e) => [i + 1, e.card.id, e.kind]));
  assert.deepEqual(all, [[5, 'live', 'cut'], [12, 'new', 'due'], [25, 'live', 'due']]);
  // A gone card passed in by mistake still gives nothing.
  assert.deepEqual(cardKinds({ id: 'x', name: 'x', due: 3, gone: true }), []);
  // Unknown colour: the neutral marker.
  assert.deepEqual(cardMarker(nov[11]), { colour: '' });
  assert.deepEqual(cardMarker(nov[4]), { colour: 'c3' });
  assert.equal(cardMarker([]), null);
  assert.equal(cardMarker(nov[0]), null);
  // Two cards on one day: one neutral marker; the day lists both, due first, then A-Z.
  const two = cardDatesInMonth([card('z', { name: 'Zeta', colour: 'c5', cut: 9 }), card('a', { name: 'Alpha', colour: 'c5', due: 9 }), card('m', { name: 'Mid', colour: 'c6', cut: 9 })], 2026, 10)[8];
  assert.deepEqual(two.map((e) => [e.card.name, e.kind]), [['Alpha', 'due'], ['Mid', 'cut'], ['Zeta', 'cut']]);
  assert.deepEqual(cardMarker(two), { colour: '' });
  // One card with both dates on one day keeps its colour.
  assert.deepEqual(cardMarker(cardDatesInMonth([card('k', { colour: 'c7', cut: 3, due: 3 })], 2026, 10)[2]), { colour: 'c7' });
  // Not a real month: nothing, never a throw.
  assert.deepEqual(cardDatesInMonth(cards, 2026, 12), []);
  assert.deepEqual(cardDatesInMonth(null, 2026, 10).flat(), []);
});

test('card dates soon: today to N days ahead, both included, at most one of each kind per card', () => {
  const cards = [card('v', { name: 'Visa', cut: 20, due: 5 }), card('m', { name: 'Master', due: 17 }), card('e', { name: 'End', cut: 31 })];
  const now = new Date(2026, 10, 17, 23, 30); // late on 17 November 2026
  const soon = (days) => cardDatesSoon(cards, now, { windowDays: days }).map((r) => [r.card.id, r.kind, r.days, r.date.getDate(), r.date.getMonth()]);
  assert.deepEqual(soon(3), [['m', 'due', 0, 17, 10], ['v', 'cut', 3, 20, 10]]);
  assert.deepEqual(soon(7), soon(3), 'nothing else in a week');
  assert.deepEqual(soon(14), [['m', 'due', 0, 17, 10], ['v', 'cut', 3, 20, 10], ['e', 'cut', 13, 30, 10]]);
  // Across a month end: 31 is the 31st in December; 5 December.
  const dec = cardDatesSoon(cards, new Date(2026, 10, 28), { windowDays: 14 }).map((r) => [r.card.id, r.kind, r.days]);
  assert.deepEqual(dec, [['e', 'cut', 2], ['v', 'due', 7]]);
  for (const w of WINDOWS) {
    for (let i = 0; i < 400; i++) {
      const day = new Date(2026, 0, 1 + i, 12);
      const rows = cardDatesSoon(cards, day, { windowDays: w });
      const keys = rows.map((r) => `${r.card.id}:${r.kind}`);
      assert.equal(new Set(keys).size, keys.length, `${day.toDateString()} window ${w}: once each`);
      assert.ok(rows.every((r) => r.days >= 0 && r.days <= w));
      assert.ok(rows.every((r) => !('amount' in r)), 'no amounts');
    }
  }
  assert.deepEqual(cardDatesSoon(cards, now, { windowDays: 'x' }).map((r) => r.days), [0, 3], 'a bad window reads as 7');
});

test('DST: a card date on the day the clocks change stays on that day (8 March and 1 November 2026)', () => {
  const cards = [card('s', { due: 8 }), card('f', { cut: 1 })];
  assert.deepEqual(cardDatesInMonth(cards, 2026, 2)[7].map((e) => e.card.id), ['s']);
  assert.deepEqual(cardDatesInMonth(cards, 2026, 10)[0].map((e) => e.card.id), ['f']);
  const r = cardDatesSoon(cards, new Date(2026, 2, 7, 23, 59), { windowDays: 3 });
  assert.deepEqual(r.map((x) => [x.card.id, x.days, x.date.getDate()]), [['s', 1, 8]]);
  const q = cardDatesSoon(cards, new Date(2026, 9, 31, 0, 1), { windowDays: 3 });
  assert.deepEqual(q.map((x) => [x.card.id, x.days, x.date.getDate()]), [['f', 1, 1]]);
});

/* Isolation ------------------------------------------------------------------------------------- */
const base = { type: 'expense', currency: 'TWD', category: '', plan: '', date: '', nextRenewal: '', domain: '', emoji: '', notes: '' };
const item = (id, o) => ({ ...base, id, name: id, price: 100, cycle: 'monthly', ...o });
const RICH = [
  item('rent', { price: 30000, nextRenewal: '2026-12-01', category: 'House' }),
  item('phone', { price: 499, nextRenewal: '2026-11-20', category: 'Utilities' }),
  item('stream', { price: 390, nextRenewal: '2026-11-18', category: 'Entertainment' }),
  item('end31', { price: 250, nextRenewal: '2026-01-31', category: 'Entertainment' }),
  item('end30', { price: 75, nextRenewal: '2027-04-30' }),
  item('d29', { price: 60, nextRenewal: '2026-03-29', category: 'Books' }),
  item('cloud', { price: 1200, cycle: 'annual', nextRenewal: '2027-03-15', category: 'Utilities' }),
  item('leap', { price: 2900, cycle: 'annual', nextRenewal: '2028-02-29', category: 'Insurance' }),
  item('concert', { price: 1500, cycle: 'once', date: '2026-11-28', category: 'Entertainment' }),
  item('trip', { price: 18000, cycle: 'once', date: '2027-07-31', category: 'Travel' }),
  item('gym', { price: 900, nextRenewal: '', category: 'Health' }),
  item('tool', { currency: 'USD', price: 10, nextRenewal: '2026-11-22', category: 'Utilities' }),
  item('gone', { price: 999, nextRenewal: '2026-11-03', del: true, category: 'House' }),
  item('salary', { type: 'income', price: 40000, nextRenewal: '2026-11-25' }),
  item('bonus', { type: 'income', price: 12000, cycle: 'annual', nextRenewal: '2027-01-10' }),
  item('allowance', { type: 'income', price: 700, nextRenewal: '' }),
];
// The same household with payment cards: `pay` on the items (a live card, Cash, a deleted card, a
// card this device hasn't seen, a value a later version wrote, on income too) and a settings record.
const PAYS = ['visa', 'cash', 'master', '', 'oldcard', 'unseen', 'visa', 'cash', 'master', 'visa', 'cash', 'visa', 'visa', 'visa', 'cash', 'x-later'];
const WITH_PAY = RICH.map((s, i) => ({ ...s, pay: PAYS[i % PAYS.length] }));
const CARDS = listCards(record({
  card_visa: { name: 'Visa', colour: 'c1', cut: 31, due: 15 },
  card_master: { name: 'Master', colour: 'c6', cut: 29 },
  card_amex: { name: 'Amex', colour: 'c9', due: 1 },
  card_oldcard: { name: 'Old', colour: 'c2', cut: 3, due: 3, gone: true },
}));

/** Every money figure for a month, from the items alone (as the app computes them). */
function figures(items, year, month, now) {
  const tw = items.filter((s) => s.currency === 'TWD');
  const occ = occurrences(items, year, month, { currency: 'TWD' });
  const subs = tw.filter((s) => s.type !== 'income');
  const b = breakdown(subs, year, month);
  const strip = (p) => stripSummary(tw, p, year, month);
  const ds = WINDOWS.flatMap((w) => [false, true].map((inc) => dueSoon(items, now, { windowDays: w, includeIncome: inc, currency: 'TWD' })));
  return {
    occ: { total: occ.total, income: occ.income, count: occ.count, others: occ.others, days: occ.days.map((d) => [d.total, d.income, d.count, d.rows.map((r) => r.item.id)]), undated: occ.undated.map((s) => s.id) },
    cash: cashDue(tw, year, month), income: incomeDue(tw, year, month),
    each: items.map((s) => [dueInMonth(s, year, month), incomeInMonth(s, year, month)]),
    strip: [strip('monthly'), strip('annual')],
    series: monthSeries(tw, year, month, 12, { income: true }),
    year: yearSummary(tw, year),
    breakdown: { total: b.total, byType: b.byType, byCategory: b.byCategory.map((c) => [c.group, c.amount, c.items.map((x) => [x.id, x.due])]) },
    wallet: ['monthly', 'annual'].map((period) => walletGroups(items, { currency: 'TWD', period, year, month }).map((g) => [g.key, g.name, g.total, g.items.map((s) => s.id)])),
    dueSoon: ds.map((r) => [r.count, r.total, r.incomeTotal, r.others, r.rows.map((x) => [x.item.id, x.days, x.amount]), r.undated.map((s) => s.id)]),
    undated: undatedItems(tw).map((s) => s.id),
  };
}

function isolation(start, months) {
  let cardDays = 0;
  for (let i = 0; i < months; i++) {
    const { year, month } = addMonths(start[0], start[1], i);
    const now = new Date(year, month, 1 + (i % 28), 9);
    const without = figures(RICH, year, month, now);
    // With cards: the items carry `pay`, and the card dates of the month and the window are worked
    // out beside them, as the Calendar and the due-soon sheet do.
    const dates = cardDatesInMonth(CARDS, year, month);
    const soon = WINDOWS.map((w) => cardDatesSoon(CARDS, now, { windowDays: w }));
    const withCards = figures(WITH_PAY, year, month, now);
    assert.deepEqual(withCards, without, `${year}-${month + 1}: every figure is the same with cards`);
    // The card dates are there (so the test means something), and none of them has an amount.
    cardDays += dates.flat().length;
    assert.ok(dates.flat().every((e) => !('amount' in e) && !('price' in e) && CARDS.includes(e.card)));
    assert.ok(soon.flat().every((r) => !('amount' in r) && CARDS.includes(r.card)));
    // Visa (cut 31, due 15), Master (cut 29) and Amex (due 1): four a month; the deleted card none.
    assert.equal(dates.flat().length, 4, `${year}-${month + 1}: four card dates`);
  }
  assert.equal(cardDays, months * 4);
}

test('isolation: over 24 months every money figure is the same with and without cards', () => {
  isolation([2027, 0], 24); // January 2027 to December 2028 (a leap February)
});

test('isolation: 48 more months (2025 to 2026 and 2029 to 2030)', () => {
  isolation([2025, 0], 24);
  isolation([2029, 0], 24);
});

test('isolation: the items and the cards passed in stay as they were', () => {
  const items = JSON.stringify(WITH_PAY);
  const cards = JSON.stringify(CARDS);
  for (let i = 0; i < 24; i++) {
    cardDatesInMonth(CARDS, 2026, i % 12);
    cardDatesSoon(CARDS, new Date(2026, i % 12, 3), { windowDays: 14 });
  }
  assert.equal(JSON.stringify(WITH_PAY), items);
  assert.equal(JSON.stringify(CARDS), cards);
});

test('isolation: js/card-dates.js imports only the stepper and the card rules (no money code)', () => {
  const src = readFileSync(new URL('../js/card-dates.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./cards.js', './interval.js']);
});
