// Node tests for js/calendar-math.js, the Money tab's calendar: the month grid (Monday and Sunday
// starts, 28 to 31-day months, months starting on each weekday, 4, 5 and 6-week months), the week
// start setting, which items fall on which day (monthly, annual, one-off, income, month-end
// clamping, 29 February, undated, other currencies), the keyboard moves, and the consistency test:
// over 24 months (and 48 more) the calendar's day totals add up to Insights' cashDue and incomeDue
// and to the Money strip. Run with `npm test`. This file runs in a time zone with DST.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthGrid, daysInMonth, addMonths, occurrences, stepDays, dayDots, moveDay,
  weekStartFrom, resolveWeekStart, localeWeekStart, WEEK_STARTS,
} from '../js/calendar-math.js';
import { cashDue, incomeDue, stripSummary, undatedItems } from '../js/insights-calc.js';
import { nextRenewal } from '../js/util.js';

const base = { type: 'expense', currency: 'TWD', category: '', plan: '', date: '', nextRenewal: '', domain: '', emoji: '', notes: '' };
const item = (id, o) => ({ ...base, id, name: id, price: 100, cycle: 'monthly', ...o });
const days = (occ) => occ.days.filter((d) => d.rows.length).map((d) => [d.day, d.rows.map((r) => r.item.id)]);
const dayOf = (occ, id) => occ.days.find((d) => d.rows.some((r) => r.item.id === id))?.day ?? null;

/* Grid ------------------------------------------------------------------------------------------ */

test('the time zone has DST, so the DST tests mean something', () => {
  assert.notEqual(new Date(2026, 0, 15).getTimezoneOffset(), new Date(2026, 6, 15).getTimezoneOffset());
});

test('grid: Monday and Sunday starts put the 1st in the right column', () => {
  // 1 November 2026 is a Sunday.
  const mon = monthGrid(2026, 10, 1);
  const sun = monthGrid(2026, 10, 0);
  assert.deepEqual(mon.weekdays, [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(sun.weekdays, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(mon.weeks[0].map((c) => c.day), [26, 27, 28, 29, 30, 31, 1]);
  assert.deepEqual(mon.weeks[0].map((c) => c.inMonth), [false, false, false, false, false, false, true]);
  assert.deepEqual(sun.weeks[0].map((c) => c.day), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(mon.weeks[0][0].month, 9, 'leading days are October');
  assert.equal(mon.weeks.length, 6);
  assert.equal(sun.weeks.length, 5);
  const last = sun.weeks.at(-1);
  assert.deepEqual(last.map((c) => [c.month, c.day]), [[10, 29], [10, 30], [11, 1], [11, 2], [11, 3], [11, 4], [11, 5]], 'trailing days are December');
});

test('grid: months starting on each weekday, both starts: the right lead, consecutive days, whole weeks', () => {
  const seen = { 1: new Set(), 0: new Set() };
  for (let i = 0; i < 24; i++) {
    const { year, month } = addMonths(2026, 0, i);
    for (const ws of [1, 0]) {
      const g = monthGrid(year, month, ws);
      const firstDay = new Date(year, month, 1).getDay();
      seen[ws].add(firstDay);
      const cells = g.weeks.flat();
      const lead = cells.findIndex((c) => c.inMonth);
      assert.equal(lead, (firstDay - ws + 7) % 7, `${year}-${month + 1} start ${ws}: lead`);
      assert.equal(cells.length % 7, 0);
      assert.equal(cells.filter((c) => c.inMonth).length, daysInMonth(year, month));
      assert.ok(lead < 7 && cells.length - lead - daysInMonth(year, month) < 7, 'never a whole week outside the month');
      for (const [j, c] of cells.entries()) {
        assert.equal(c.weekday, g.weekdays[j % 7], 'each column is one weekday');
        if (j) {
          const prev = cells[j - 1];
          assert.equal(new Date(c.year, c.month, c.day - 1).getDate(), prev.day, `${year}-${month + 1}: consecutive days`);
        }
      }
    }
  }
  assert.equal(seen[1].size, 7, 'every weekday starts a month in two years');
  assert.equal(seen[0].size, 7);
});

test('grid: 28, 29, 30 and 31-day months; 4, 5 and 6-week months', () => {
  assert.equal(daysInMonth(2026, 1), 28);
  assert.equal(daysInMonth(2028, 1), 29);
  assert.equal(daysInMonth(2026, 3), 30);
  assert.equal(daysInMonth(2026, 0), 31);
  // February 2026 starts on a Sunday: exactly 4 weeks from Sunday, 5 from Monday.
  assert.equal(monthGrid(2026, 1, 0).weeks.length, 4);
  assert.equal(monthGrid(2026, 1, 1).weeks.length, 5);
  // February 2027 starts on a Monday: 4 weeks from Monday.
  assert.equal(monthGrid(2027, 1, 1).weeks.length, 4);
  // February 2028 (29 days) starts on a Tuesday.
  assert.equal(monthGrid(2028, 1, 1).weeks.flat().filter((c) => c.inMonth).length, 29);
  // August 2026 starts on a Saturday: 6 weeks either way.
  assert.equal(monthGrid(2026, 7, 0).weeks.length, 6);
  assert.equal(monthGrid(2026, 7, 1).weeks.length, 6);
  // May 2026 (Friday the 1st, 31 days): 5 weeks from Monday.
  assert.equal(monthGrid(2026, 4, 1).weeks.length, 5);
  // A 30-day month from Sunday the 1st (November 2026): 5 weeks.
  assert.equal(monthGrid(2026, 10, 0).weeks.length, 5);
});

test('grid: across the DST changes (March and November 2026 in New York) every day is there once', () => {
  for (const [y, m] of [[2026, 2], [2026, 10], [2027, 2], [2027, 10]]) {
    const inMonth = monthGrid(y, m, 1).weeks.flat().filter((c) => c.inMonth).map((c) => c.day);
    assert.deepEqual(inMonth, Array.from({ length: daysInMonth(y, m) }, (_, i) => i + 1));
  }
});

test('addMonths crosses year ends both ways', () => {
  assert.deepEqual(addMonths(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(addMonths(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(addMonths(2026, 10, 14), { year: 2028, month: 0 });
});

/* Week start ------------------------------------------------------------------------------------ */

test('week start: Auto by default; Monday and Sunday when chosen; Auto follows the locale', () => {
  assert.deepEqual(WEEK_STARTS, ['auto', 'mon', 'sun']);
  assert.equal(weekStartFrom(null), 'auto');
  assert.equal(weekStartFrom('bogus'), 'auto');
  assert.equal(weekStartFrom('mon'), 'mon');
  assert.equal(resolveWeekStart('mon', 'zh-TW'), 1);
  assert.equal(resolveWeekStart('sun', 'en-GB'), 0);
  assert.equal(resolveWeekStart(null, 'en-GB'), 1);
  assert.equal(resolveWeekStart('auto', 'zh-TW'), 0);
  assert.equal(resolveWeekStart('auto', 'en-US'), 0);
});

test('week start without Intl weekInfo: Monday for en-GB, Sunday for zh-TW (also zh-Hant), Monday otherwise', () => {
  const plain = (l) => localeWeekStart(l, { useIntl: false });
  assert.equal(plain('en-GB'), 1);
  assert.equal(plain('zh-TW'), 0);
  assert.equal(plain('zh-Hant'), 0);
  assert.equal(plain('en-US'), 0);
  assert.equal(plain('de-DE'), 1);
  assert.equal(plain('fr'), 1);
  assert.equal(plain('not a locale!'), 1);
});

/* Occurrences ----------------------------------------------------------------------------------- */

test('monthly: every month on its day, also before the stored date (a projection)', () => {
  const s = item('m', { nextRenewal: '2026-11-18', price: 390 });
  for (let i = -6; i < 18; i++) {
    const { year, month } = addMonths(2026, 10, i);
    assert.equal(dayOf(occurrences([s], year, month), 'm'), 18, `${year}-${month + 1}`);
  }
});

test('monthly on the 31st: the 30th in 30-day months, the 28th or 29th in February, the 31st again after', () => {
  const s = item('end', { nextRenewal: '2026-01-31' });
  assert.equal(dayOf(occurrences([s], 2026, 0), 'end'), 31);
  assert.equal(dayOf(occurrences([s], 2026, 1), 'end'), 28);
  assert.equal(dayOf(occurrences([s], 2026, 2), 'end'), 31);
  assert.equal(dayOf(occurrences([s], 2026, 3), 'end'), 30);
  assert.equal(dayOf(occurrences([s], 2028, 1), 'end'), 29);
  // Before the stored date too.
  assert.equal(dayOf(occurrences([s], 2025, 10), 'end'), 30);
  assert.equal(dayOf(occurrences([s], 2024, 1), 'end'), 29);
  const s30 = item('d30', { nextRenewal: '2026-04-30' });
  assert.equal(dayOf(occurrences([s30], 2027, 1), 'd30'), 28);
  assert.equal(dayOf(occurrences([s30], 2027, 2), 'd30'), 30);
});

test("the day is nextRenewal()'s from the stored date on: for every month over four years", () => {
  const list = [
    item('a', { nextRenewal: '2026-01-31' }), item('b', { nextRenewal: '2026-03-30' }), item('c', { nextRenewal: '2026-11-18' }),
    item('d', { cycle: 'annual', nextRenewal: '2028-02-29' }), item('e', { cycle: 'annual', nextRenewal: '2026-08-31' }),
    item('f', { nextRenewal: '2027-02-28' }),
  ];
  for (const s of list) {
    const start = new Date(...s.nextRenewal.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0)));
    for (let i = 0; i < 48; i++) {
      const { year, month } = addMonths(start.getFullYear(), start.getMonth(), i);
      const want = nextRenewal(s, new Date(year, month, 1));
      const got = stepDays(s, year, month);
      if (want.getFullYear() === year && want.getMonth() === month) assert.deepEqual(got, [want.getDate()], `${s.id} ${year}-${month + 1}`);
      else assert.deepEqual(got, [], `${s.id} ${year}-${month + 1}: not this month`);
    }
  }
});

test('annual: only in the stored month, every year (before the stored date too)', () => {
  const s = item('y', { cycle: 'annual', nextRenewal: '2027-03-15', price: 1200 });
  for (let i = 0; i < 36; i++) {
    const { year, month } = addMonths(2025, 0, i);
    assert.equal(dayOf(occurrences([s], year, month), 'y'), month === 2 ? 15 : null, `${year}-${month + 1}`);
  }
});

test('29 February: the 28th in other years, the 29th in leap years, as nextRenewal() rolls it', () => {
  const s = item('leap', { cycle: 'annual', nextRenewal: '2028-02-29' });
  assert.equal(dayOf(occurrences([s], 2028, 1), 'leap'), 29);
  assert.equal(dayOf(occurrences([s], 2029, 1), 'leap'), 28);
  assert.equal(dayOf(occurrences([s], 2031, 1), 'leap'), 28);
  assert.equal(dayOf(occurrences([s], 2032, 1), 'leap'), 29);
  assert.equal(dayOf(occurrences([s], 2027, 1), 'leap'), 28, 'a year before: the same clamp');
  assert.equal(nextRenewal(s, new Date(2029, 0, 1)).getDate(), 28, "nextRenewal's own rule");
  assert.equal(nextRenewal(s, new Date(2032, 0, 1)).getDate(), 29);
  const m = item('m29', { nextRenewal: '2028-02-29' });
  assert.equal(dayOf(occurrences([m], 2029, 1), 'm29'), 28, 'a monthly item on the 29th in a short February');
  assert.equal(dayOf(occurrences([m], 2029, 2), 'm29'), 29, 'and the 29th again in March');
});

test('one-offs: only in the month of their date, expenses and income', () => {
  const s = item('once', { cycle: 'once', date: '2026-11-28', price: 1500 });
  const inc = item('gift', { type: 'income', cycle: 'once', date: '2026-12-10', price: 5000 });
  assert.deepEqual(days(occurrences([s, inc], 2026, 10)), [[28, ['once']]]);
  assert.deepEqual(days(occurrences([s, inc], 2026, 11)), [[10, ['gift']]]);
  assert.deepEqual(days(occurrences([s, inc], 2027, 10)), [], 'not a year later');
  assert.deepEqual(days(occurrences([s, inc], 2025, 10)), [], 'not a year before');
});

test('income: on its day, marked as income, in its own total, never in the expenses', () => {
  const list = [
    item('salary', { type: 'income', price: 40000, nextRenewal: '2026-11-25' }),
    item('rent', { price: 30000, nextRenewal: '2026-12-25' }),
    item('bonus', { type: 'income', cycle: 'annual', price: 12000, nextRenewal: '2027-01-10' }),
  ];
  const nov = occurrences(list, 2026, 10);
  const d25 = nov.days[24];
  assert.deepEqual(d25.rows.map((r) => [r.item.id, r.income]), [['rent', false], ['salary', true]], 'expenses first, then income');
  assert.equal(d25.total, 30000);
  assert.equal(d25.income, 40000);
  assert.equal(nov.total, 30000);
  assert.equal(nov.income, 40000);
  assert.equal(d25.rows[1].group, null, 'income has no group');
  const jan = occurrences(list, 2027, 0);
  assert.equal(jan.days[9].income, 12000);
  assert.equal(jan.income, 52000);
});

test('other currencies: on their day, counted, never in a total', () => {
  const list = [
    item('rent', { price: 30000, nextRenewal: '2026-11-05' }),
    item('tool', { currency: 'USD', price: 10, nextRenewal: '2026-11-05' }),
    item('host', { currency: 'USD', price: 5, nextRenewal: '2026-11-09' }),
    item('euro', { currency: 'EUR', price: 7, nextRenewal: '2026-11-09' }),
  ];
  const occ = occurrences(list, 2026, 10, { currency: 'TWD' });
  assert.equal(occ.days[4].total, 30000);
  assert.deepEqual(occ.days[4].others, [{ currency: 'USD', count: 1 }]);
  assert.equal(occ.days[8].total, 0);
  assert.deepEqual(occ.days[8].others, [{ currency: 'EUR', count: 1 }, { currency: 'USD', count: 1 }]);
  assert.equal(occ.total, 30000);
  assert.deepEqual(occ.others, [{ currency: 'USD', count: 2 }, { currency: 'EUR', count: 1 }]);
  assert.equal(occ.count, 4);
  const usd = occurrences(list, 2026, 10, { currency: 'USD' });
  assert.equal(usd.total, 15, 'another default currency totals its own');
});

test('undated items: on no day, listed for the need-a-date line (plans, then income); deleted items nowhere', () => {
  const list = [
    item('gym', { nextRenewal: '', price: 900 }),
    item('allowance', { type: 'income', nextRenewal: '' }),
    item('apps', { nextRenewal: '' }),
    item('gone', { nextRenewal: '2026-11-05', del: true }),
    item('bad', { nextRenewal: '18/11/2026' }),
  ];
  const occ = occurrences(list, 2026, 10);
  assert.equal(occ.count, 0);
  assert.deepEqual(occ.undated.map((s) => s.id), ['apps', 'bad', 'gym', 'allowance']);
  assert.deepEqual(occ.undated.map((s) => s.id), undatedItems(list.filter((s) => !s.del)).map((s) => s.id), "insights-calc's list");
});

test('days: one entry per day of the month; rows A to Z; dots: up to 3, then +N', () => {
  const list = ['delta', 'alpha', 'Charlie', 'bravo', 'echo'].map((n) => item(n, { nextRenewal: '2026-02-14' }));
  const occ = occurrences(list, 2026, 1);
  assert.equal(occ.days.length, 28);
  assert.deepEqual(occ.days[13].rows.map((r) => r.item.id), ['alpha', 'bravo', 'Charlie', 'delta', 'echo']);
  const { dots, more } = dayDots(occ.days[13].rows);
  assert.equal(dots.length, 3);
  assert.equal(more, 2);
  assert.deepEqual(dayDots(occ.days[0].rows), { dots: [], more: 0 });
  assert.equal(occ.days[13].rows[0].group, 'Uncategorised');
});

test('DST: an item on the day the clocks change stays on that day', () => {
  // New York: 8 March 2026 (spring forward) and 1 November 2026 (fall back).
  const list = [item('spring', { nextRenewal: '2026-03-08' }), item('fall', { nextRenewal: '2026-11-01' }), item('after', { nextRenewal: '2026-03-09' })];
  assert.deepEqual(days(occurrences(list, 2026, 2)), [[1, ['fall']], [8, ['spring']], [9, ['after']]]);
  assert.deepEqual(days(occurrences(list, 2026, 10)), [[1, ['fall']], [8, ['spring']], [9, ['after']]]);
});

test('nothing is changed: the items passed in stay as they were', () => {
  const list = [item('a', { nextRenewal: '2025-01-31' }), item('b', { cycle: 'annual', nextRenewal: '2028-02-29' })];
  const copy = structuredClone(list);
  for (let i = 0; i < 24; i++) occurrences(list, 2026, i % 12);
  assert.deepEqual(list, copy);
});

/* Consistency: the calendar against Insights and the Money strip -------------------------------- */

// A rich household: monthly, annual and one-off expenses and income, month-end days, 29 February,
// a past and a future stored date, other currencies, undated plans and income, a deleted item.
const RICH = [
  item('rent', { price: 30000, nextRenewal: '2026-12-01', category: 'House' }),
  item('phone', { price: 499, nextRenewal: '2026-11-20', category: 'Utilities' }),
  item('old', { price: 100, nextRenewal: '2025-06-21', category: 'Utilities' }),
  item('stream', { price: 390, nextRenewal: '2026-11-18', category: 'Entertainment' }),
  item('end31', { price: 250, nextRenewal: '2026-01-31', category: 'Entertainment' }),
  item('end30', { price: 75, nextRenewal: '2027-04-30' }),
  item('d29', { price: 60, nextRenewal: '2026-03-29', category: 'Books' }),
  item('cloud', { price: 1200, cycle: 'annual', nextRenewal: '2027-03-15', category: 'Utilities' }),
  item('leap', { price: 2900, cycle: 'annual', nextRenewal: '2028-02-29', category: 'Insurance' }),
  item('jan31', { price: 3100, cycle: 'annual', nextRenewal: '2026-01-31', category: 'Insurance' }),
  item('concert', { price: 1500, cycle: 'once', date: '2026-11-28', category: 'Entertainment' }),
  item('trip', { price: 18000, cycle: 'once', date: '2027-07-31', category: 'Travel' }),
  item('dinner', { price: 800, cycle: 'once', date: '2026-11-17' }),
  item('gym', { price: 900, nextRenewal: '', category: 'Health' }),
  item('tool', { currency: 'USD', price: 10, nextRenewal: '2026-11-22', category: 'Utilities' }),
  item('domain', { currency: 'USD', price: 12, cycle: 'annual', nextRenewal: '2027-05-31', category: 'Utilities' }),
  item('gone', { price: 999, nextRenewal: '2026-11-03', del: true, category: 'House' }),
  item('salary', { type: 'income', price: 40000, nextRenewal: '2026-11-25' }),
  item('side', { type: 'income', price: 3000, nextRenewal: '2026-10-31' }),
  item('bonus', { type: 'income', price: 12000, cycle: 'annual', nextRenewal: '2027-01-10' }),
  item('gift', { type: 'income', price: 5000, cycle: 'once', date: '2027-02-28' }),
  item('allowance', { type: 'income', price: 700, nextRenewal: '' }),
  item('usdIncome', { type: 'income', currency: 'USD', price: 100, nextRenewal: '2026-11-15' }),
];

test('consistency: over 24 months the day totals add up to cashDue and the income to incomeDue', () => {
  const inCur = RICH.filter((s) => s.currency === 'TWD' && !s.del);
  for (let i = 0; i < 24; i++) {
    const { year, month } = addMonths(2027, 0, i); // January 2027 to December 2028 (a leap February)
    const occ = occurrences(RICH, year, month, { currency: 'TWD' });
    const dayTotal = occ.days.reduce((t, d) => t + d.total, 0);
    const dayIncome = occ.days.reduce((t, d) => t + d.income, 0);
    assert.equal(dayTotal, cashDue(inCur, year, month), `${year}-${month + 1}: expenses`);
    assert.equal(dayIncome, incomeDue(inCur, year, month), `${year}-${month + 1}: income`);
    assert.equal(occ.total, dayTotal);
    assert.equal(occ.income, dayIncome);
    // Every item Insights counts in the month is on exactly one day of it.
    const counted = RICH.filter((s) => !s.del && (cashDue([s], year, month) > 0 || incomeDue([s], year, month) > 0)).map((s) => s.id).sort();
    assert.deepEqual(occ.days.flatMap((d) => d.rows.map((r) => r.item.id)).sort(), counted, `${year}-${month + 1}: the same items`);
    // And the USD figures, had USD been the default currency.
    const usd = occurrences(RICH, year, month, { currency: 'USD' });
    assert.equal(usd.total, cashDue(RICH.filter((s) => s.currency === 'USD'), year, month));
  }
});

test('consistency: 48 more months (2025 to 2026 and 2029 to 2030) and the Money strip for each month', () => {
  const inCur = RICH.filter((s) => s.currency === 'TWD');
  for (const start of [[2025, 0], [2029, 0]]) {
    for (let i = 0; i < 24; i++) {
      const { year, month } = addMonths(start[0], start[1], i);
      const occ = occurrences(RICH, year, month, { currency: 'TWD' });
      const strip = stripSummary(inCur, 'monthly', year, month);
      assert.equal(occ.total, strip.outgoings, `${year}-${month + 1}: the strip's Outgoings`);
      assert.equal(occ.income, strip.income, `${year}-${month + 1}: the strip's Income`);
    }
  }
});

test('consistency: the month summary matches the Money strip for the current month (November 2026)', () => {
  const now = new Date(2026, 10, 18, 10);
  const inCur = RICH.filter((s) => s.currency === 'TWD');
  const strip = stripSummary(inCur, 'monthly', now.getFullYear(), now.getMonth());
  const occ = occurrences(RICH, now.getFullYear(), now.getMonth(), { currency: 'TWD' });
  assert.equal(occ.total, strip.outgoings);
  assert.equal(occ.income, strip.income);
  // Worked by hand: rent 30,000 (a projection: its stored date is in December) + phone 499 + old
  // 100 + stream 390 + end31 250 (the 30th) + end30 75 + d29 60 + concert 1,500 + dinner 800 =
  // 33,674 TWD; income salary 40,000 + side 3,000 (on the 30th).
  assert.equal(occ.total, 33674);
  assert.equal(occ.income, 43000);
  assert.equal(dayOf(occ, 'end31'), 30);
  assert.equal(dayOf(occ, 'side'), 30);
  assert.deepEqual(occ.others, [{ currency: 'USD', count: 2 }]);
  assert.deepEqual(occ.undated.map((s) => s.id), ['gym', 'allowance']);
});

/* Keyboard -------------------------------------------------------------------------------------- */

test('keys: arrows by a day and a week, Home and End by the week, Page Up and Page Down by a month', () => {
  const at = { year: 2026, month: 10, day: 18 }; // a Wednesday
  assert.deepEqual(moveDay(at, 'ArrowLeft'), { year: 2026, month: 10, day: 17 });
  assert.deepEqual(moveDay(at, 'ArrowRight'), { year: 2026, month: 10, day: 19 });
  assert.deepEqual(moveDay(at, 'ArrowUp'), { year: 2026, month: 10, day: 11 });
  assert.deepEqual(moveDay(at, 'ArrowDown'), { year: 2026, month: 10, day: 25 });
  assert.deepEqual(moveDay(at, 'Home', 1), { year: 2026, month: 10, day: 16 }, 'Monday');
  assert.deepEqual(moveDay(at, 'End', 1), { year: 2026, month: 10, day: 22 }, 'Sunday');
  assert.deepEqual(moveDay(at, 'Home', 0), { year: 2026, month: 10, day: 15 }, 'Sunday');
  assert.deepEqual(moveDay(at, 'End', 0), { year: 2026, month: 10, day: 21 }, 'Saturday');
  assert.deepEqual(moveDay(at, 'PageUp'), { year: 2026, month: 9, day: 18 });
  assert.deepEqual(moveDay(at, 'PageDown'), { year: 2026, month: 11, day: 18 });
  assert.deepEqual(moveDay({ year: 2026, month: 0, day: 31 }, 'PageDown'), { year: 2026, month: 1, day: 28 }, 'clamped');
  assert.deepEqual(moveDay({ year: 2026, month: 11, day: 31 }, 'ArrowRight'), { year: 2027, month: 0, day: 1 }, 'into the next year');
  assert.deepEqual(moveDay({ year: 2026, month: 2, day: 8 }, 'ArrowDown'), { year: 2026, month: 2, day: 15 }, 'across DST');
  assert.equal(moveDay(at, 'Enter'), null);
});
