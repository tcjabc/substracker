// Node tests for js/due-soon.js, the due-soon chip's calculation: the window's edges, month and
// year rollover, the leap day, annual and one-off items, income on and off, undated items, other
// currencies, the order, local calendar days across a DST change, and the settings.
// Run with `npm test`. This file runs in a time zone with DST (each test file is its own process).
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueSoon, daysBetween, windowFrom, chipOnFrom, includeIncomeFrom, WINDOWS } from '../js/due-soon.js';

const base = { type: 'expense', currency: 'TWD', category: '', plan: '', date: '', nextRenewal: '' };
const item = (id, o) => ({ ...base, id, name: id, price: 100, cycle: 'monthly', ...o });
const at = (y, m, d, h = 10, min = 0) => new Date(y, m - 1, d, h, min); // local time, months 1–12
const names = (res) => res.rows.map((r) => r.item.name);
const days = (res) => res.rows.map((r) => r.days);

test('the time zone has DST, so the DST tests mean something', () => {
  assert.notEqual(at(2026, 1, 15).getTimezoneOffset(), at(2026, 7, 15).getTimezoneOffset());
});

test('window edges: day 0 and day N are in, day N+1 is out', () => {
  const now = at(2026, 11, 18);
  const items = [
    item('d0', { nextRenewal: '2026-11-18' }), item('d7', { nextRenewal: '2026-11-25' }), item('d8', { nextRenewal: '2026-11-26' }),
    item('d3', { nextRenewal: '2026-11-21' }), item('d14', { nextRenewal: '2026-12-02' }), item('d15', { nextRenewal: '2026-12-03' }),
  ];
  assert.deepEqual(names(dueSoon(items, now, { windowDays: 7 })), ['d0', 'd3', 'd7']);
  assert.deepEqual(names(dueSoon(items, now, { windowDays: 3 })), ['d0', 'd3']);
  assert.deepEqual(names(dueSoon(items, now, { windowDays: 14 })), ['d0', 'd3', 'd7', 'd8', 'd14']);
  assert.deepEqual(days(dueSoon(items, now, { windowDays: 14 })), [0, 3, 7, 8, 14]);
  // Late in the evening it's still the same day.
  assert.deepEqual(names(dueSoon(items, at(2026, 11, 18, 23, 59), { windowDays: 7 })), ['d0', 'd3', 'd7']);
});

test('a past stored date rolls forward for display; the stored item is never changed', () => {
  const now = at(2026, 11, 18);
  const monthly = item('old', { nextRenewal: '2025-03-20' });
  const copy = structuredClone(monthly);
  const res = dueSoon([monthly], now);
  assert.equal(res.rows[0].date.getMonth(), 10);
  assert.equal(res.rows[0].date.getDate(), 20);
  assert.equal(res.rows[0].days, 2);
  assert.deepEqual(monthly, copy, 'nothing written back');
});

test('month rollover and short months: a day 31 item falls on the 30th in November', () => {
  const now = at(2026, 11, 28);
  const res = dueSoon([item('eom', { nextRenewal: '2026-01-31' }), item('d30', { nextRenewal: '2026-10-30' })], now);
  assert.deepEqual(res.rows.map((r) => [r.item.name, r.date.getDate(), r.days]), [['d30', 30, 2], ['eom', 30, 2]]);
  // And back on the 31st in December, across the month end.
  const dec = dueSoon([item('eom', { nextRenewal: '2026-01-31' })], at(2026, 12, 27));
  assert.deepEqual(dec.rows.map((r) => [r.date.getMonth(), r.date.getDate(), r.days]), [[11, 31, 4]]);
  // February: the 28th (2027 isn't a leap year).
  const feb = dueSoon([item('eom', { nextRenewal: '2026-01-31' })], at(2027, 2, 25));
  assert.deepEqual(feb.rows.map((r) => [r.date.getMonth(), r.date.getDate(), r.days]), [[1, 28, 3]]);
});

test('year rollover: monthly and annual items into January', () => {
  const now = at(2026, 12, 28);
  const res = dueSoon([
    item('monthly', { nextRenewal: '2026-12-05' }),
    item('annual', { cycle: 'annual', nextRenewal: '2025-01-02' }),
    item('annualLater', { cycle: 'annual', nextRenewal: '2025-03-02' }),
  ], now, { windowDays: 14 });
  assert.deepEqual(res.rows.map((r) => [r.item.name, r.date.getFullYear(), r.date.getMonth(), r.date.getDate(), r.days]),
    [['annual', 2027, 0, 2, 5], ['monthly', 2027, 0, 5, 8]]);
});

test('leap day: an annual 29 February is due on the 28th, and on the 29th in a leap year', () => {
  const leap = item('leap', { cycle: 'annual', nextRenewal: '2024-02-29' });
  assert.deepEqual(dueSoon([leap], at(2027, 2, 25)).rows.map((r) => [r.date.getMonth(), r.date.getDate(), r.days]), [[1, 28, 3]]);
  assert.deepEqual(dueSoon([leap], at(2028, 2, 25)).rows.map((r) => [r.date.getMonth(), r.date.getDate(), r.days]), [[1, 29, 4]]);
  assert.deepEqual(dueSoon([leap], at(2028, 3, 1)).rows, [], 'just past: next year');
});

test('one-offs: today counts, yesterday and past the window don\'t', () => {
  const now = at(2026, 11, 18);
  const res = dueSoon([
    item('today', { cycle: 'once', date: '2026-11-18' }), item('yesterday', { cycle: 'once', date: '2026-11-17' }),
    item('inWindow', { cycle: 'once', date: '2026-11-24' }), item('after', { cycle: 'once', date: '2026-11-26' }),
    item('noDate', { cycle: 'once', date: '' }), item('stray', { cycle: 'once', date: '', nextRenewal: '2026-11-19' }),
  ], now);
  assert.deepEqual(names(res), ['today', 'inWindow']);
  assert.deepEqual(res.undated, [], 'a one-off without a date isn\'t an undated plan');
});

test('income: left out by default; with includeIncome, recurring income only, totalled on its own', () => {
  const now = at(2026, 11, 18);
  const items = [
    item('rent', { price: 30000, nextRenewal: '2026-11-20' }),
    item('salary', { type: 'income', price: 40000, nextRenewal: '2026-11-19' }),
    item('bonus', { type: 'income', price: 5000, cycle: 'once', date: '2026-11-21' }),
    item('noPayDate', { type: 'income', price: 1, nextRenewal: '' }),
  ];
  const off = dueSoon(items, now, { currency: 'TWD' });
  assert.deepEqual(names(off), ['rent']);
  assert.equal(off.total, 30000);
  assert.equal(off.incomeTotal, 0);
  assert.equal(off.hasIncome, false);
  assert.deepEqual(off.undated, [], 'undated income only counts with income on');
  const on = dueSoon(items, now, { currency: 'TWD', includeIncome: true });
  assert.deepEqual(names(on), ['salary', 'rent']);
  assert.deepEqual(on.rows.map((r) => r.income), [true, false]);
  assert.equal(on.total, 30000, 'income is never added to the expenses');
  assert.equal(on.incomeTotal, 40000);
  assert.equal(on.hasIncome, true);
  assert.deepEqual(on.undated.map((s) => s.id), ['noPayDate']);
});

test('undated recurring items are counted, never in the window', () => {
  const res = dueSoon([
    item('gym', { nextRenewal: '' }), item('apps', { cycle: 'annual', nextRenewal: '' }),
    item('phone', { nextRenewal: '2026-11-20' }), item('usdUndated', { currency: 'USD', nextRenewal: '' }),
  ], at(2026, 11, 18));
  assert.deepEqual(names(res), ['phone']);
  assert.deepEqual(res.undated.map((s) => s.id), ['apps', 'gym', 'usdUndated'], 'A–Z, any currency');
});

test('other currencies: listed and counted, never in the total', () => {
  const res = dueSoon([
    item('phone', { price: 499, nextRenewal: '2026-11-20' }), item('stream', { price: 390, nextRenewal: '2026-11-18' }),
    item('tool', { currency: 'USD', price: 10, nextRenewal: '2026-11-22' }), item('cloud', { currency: 'USD', price: 3, nextRenewal: '2026-11-19' }),
    item('train', { currency: 'JPY', price: 1200, nextRenewal: '2026-11-21' }),
  ], at(2026, 11, 18), { currency: 'TWD' });
  assert.equal(res.count, 5);
  assert.equal(res.total, 889, 'TWD only: 499 + 390');
  assert.deepEqual(res.others, [{ currency: 'USD', count: 2 }, { currency: 'JPY', count: 1 }]);
  assert.deepEqual(res.rows.map((r) => [r.item.name, r.currency, r.amount]),
    [['stream', 'TWD', 390], ['cloud', 'USD', 3], ['phone', 'TWD', 499], ['train', 'JPY', 1200], ['tool', 'USD', 10]]);
  const usd = dueSoon(res.rows.map((r) => r.item), at(2026, 11, 18), { currency: 'USD' });
  assert.equal(usd.total, 13, 'the default currency decides which total');
});

test('order: today first, then by date, then by name (case and accents ignored)', () => {
  const res = dueSoon([
    item('Zoo', { nextRenewal: '2026-11-20' }), item('apple', { nextRenewal: '2026-11-20' }), item('Éclair', { nextRenewal: '2026-11-20' }),
    item('later', { nextRenewal: '2026-11-23' }), item('now', { cycle: 'once', date: '2026-11-18' }),
  ], at(2026, 11, 18));
  assert.deepEqual(names(res), ['now', 'apple', 'Éclair', 'Zoo', 'later']);
});

test('deleted items and nonsense are ignored', () => {
  const res = dueSoon([
    item('gone', { nextRenewal: '2026-11-19', del: true }), item('old', { nextRenewal: '2026-11-19', deleted: true }),
    item('bad', { nextRenewal: 'not a date' }), null,
  ], at(2026, 11, 18));
  assert.deepEqual(res.rows, []);
  assert.equal(dueSoon(undefined, at(2026, 11, 18)).count, 0);
});

test('local calendar days across the DST change: "Tomorrow" stays tomorrow', () => {
  // America/New_York leaves DST on Sunday 1 November 2026 (that day has 25 hours) and enters it on
  // Sunday 8 March 2026 (23 hours).
  assert.equal(at(2026, 11, 1, 12).getTimezoneOffset() - at(2026, 10, 31, 12).getTimezoneOffset(), 60);
  assert.equal(daysBetween(at(2026, 10, 31, 23, 30), at(2026, 11, 1, 0, 0)), 1);
  assert.equal(daysBetween(at(2026, 11, 1, 0, 5), at(2026, 11, 2, 0, 0)), 1, 'across the 25-hour day');
  assert.equal(daysBetween(at(2026, 3, 7, 23, 0), at(2026, 3, 9, 0, 0)), 2, 'across the 23-hour day');
  const fall = dueSoon([item('a', { nextRenewal: '2026-11-02' }), item('b', { cycle: 'once', date: '2026-11-08' })], at(2026, 11, 1, 0, 30));
  assert.deepEqual(days(fall), [1, 7]);
  const spring = dueSoon([item('a', { nextRenewal: '2026-03-09' }), item('b', { nextRenewal: '2026-03-15' })], at(2026, 3, 8, 23, 30));
  assert.deepEqual(days(spring), [1, 7]);
  assert.deepEqual(names(dueSoon([item('edge', { nextRenewal: '2026-11-08' })], at(2026, 11, 1, 23, 59))), ['edge'], 'day 7 is still in');
});

test('the settings: window 3, 7 or 14 (7 by default); the chip on and income off by default', () => {
  assert.deepEqual(WINDOWS, [3, 7, 14]);
  assert.equal(windowFrom('14'), 14);
  assert.equal(windowFrom('3'), 3);
  assert.equal(windowFrom(7), 7);
  for (const bad of [null, undefined, '', '5', 'x', '0']) assert.equal(windowFrom(bad), 7, String(bad));
  assert.equal(chipOnFrom(null), true);
  assert.equal(chipOnFrom('on'), true);
  assert.equal(chipOnFrom('off'), false);
  assert.equal(includeIncomeFrom(null), false);
  assert.equal(includeIncomeFrom('on'), true);
  assert.equal(includeIncomeFrom('off'), false);
});

test('no dismiss for the day any more: the chip has no close button, so there is no dismiss key', async () => {
  const mod = await import('../js/due-soon.js');
  assert.equal(mod.dismissKey, undefined);
  assert.equal(mod.isDismissed, undefined);
});
