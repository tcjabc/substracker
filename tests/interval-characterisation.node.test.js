// Characterisation of how the app steps through item dates, recorded on 1.19.0's code before the
// shared stepper (js/interval.js) replaced it. It runs today's functions over a dense grid and
// compares the results with fingerprints frozen from 1.19.0, so any change in what the app shows
// fails here:
//   util.nextRenewal(sub, now)          the next date shown, for many anchors and "today"s
//   calendar-math.stepDays(s, y, m)     the days an item falls on in a month (and occurrences())
//   insights-calc dueInMonth / incomeInMonth, cashDue, incomeDue, breakdown, monthSeries,
//     yearSummary, yearTotal, monthlyAverage, stripSummary    the cash basis
//   due-soon.dueSoon(items, now, …)     the banner's rows, days and totals
// Anchors: month ends (29, 30, 31 January; 29 February in leap and other years; 31 March, May,
// August, October, December), year ends, DST-change days (here, in London, Auckland, São Paulo),
// dates the parser rolls over (30 February, month 13, month 00), past and future anchors. Cycles:
// monthly, annual, once and one this version doesn't know (read as monthly), expense and income.
// "Today"s: across 2024–2030, month ends, the leap day, DST days, at midnight, noon and 23:59.
//
// The two known bugs (docs/plan-intervals-groups.md) are pinned on their own as literals, so the
// commits that fix them change exactly those lines: years 0–99 read as 1900–1999, and
// nextRenewal() giving up after 1200 steps and returning a date in the past.
// Run with `npm test`. This file runs in a time zone with DST.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nextRenewal, parseDate } from '../js/util.js';
import { stepDays, occurrences } from '../js/calendar-math.js';
import {
  dueInMonth, incomeInMonth, cashDue, incomeDue, breakdown, monthSeries, yearSummary, yearTotal, monthlyAverage, stripSummary,
} from '../js/insights-calc.js';
import { dueSoon } from '../js/due-soon.js';

const pad = (n) => String(n).padStart(2, '0');
/** A Date as the app would show it: local year-month-day, plus the time when it isn't midnight. */
const ser = (d) => {
  if (d === null || d === undefined) return String(d);
  if (!(d instanceof Date)) return JSON.stringify(d);
  if (Number.isNaN(d.getTime())) return 'Invalid Date';
  const t = d.getHours() || d.getMinutes() ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}${t}`;
};
const digest = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex');

/* ------------------------------------------------------------------ The grid */

const ANCHORS = [];
for (const y of [2024, 2025, 2026, 2027, 2028]) {
  for (const md of ['01-29', '01-30', '01-31', '02-28', '02-29', '03-31', '04-30', '05-31', '06-30', '08-31', '10-31', '11-30', '12-31', '01-01', '06-15']) ANCHORS.push(`${y}-${md}`);
}
ANCHORS.push(
  // DST-change days: New York, London, Auckland, and São Paulo when its clocks changed at midnight.
  '2026-03-08', '2026-11-01', '2026-03-29', '2026-10-25', '2026-04-05', '2026-09-27', '2018-11-04', '2019-02-16',
  // Past and future.
  '2000-01-31', '2000-02-29', '1999-12-31', '2010-06-15', '2019-08-31', '2030-02-28', '2032-02-29', '2040-12-31', '2099-12-31',
  // Rolled over by the parser.
  '2026-02-30', '2026-02-31', '2027-02-29', '2026-04-31', '2026-13-05', '2026-00-15', '2026-12-32', '2026-11-00',
  // No usable date.
  '', '2026-1-05', 'soon',
);
const CYCLES = ['monthly', 'annual', 'once', 'weekly'];
const TODAYS = [];
for (const [y, m, d] of [
  [2024, 0, 1], [2024, 1, 28], [2024, 1, 29], [2024, 2, 1], [2024, 11, 31], [2025, 0, 30], [2025, 1, 28], [2025, 5, 15],
  [2025, 11, 31], [2026, 0, 31], [2026, 1, 28], [2026, 2, 8], [2026, 2, 29], [2026, 3, 30], [2026, 9, 25], [2026, 10, 1],
  [2026, 10, 18], [2026, 10, 19], [2026, 11, 31], [2027, 0, 1], [2027, 1, 28], [2027, 2, 1], [2028, 1, 29], [2028, 11, 31],
  [2030, 5, 30],
]) {
  TODAYS.push(new Date(y, m, d, 12));
}
TODAYS.push(new Date(2026, 10, 19, 0, 0), new Date(2026, 10, 19, 23, 59), new Date(2026, 2, 8, 3, 30), new Date(2026, 10, 1, 1, 30));
const MONTHS = [];
for (let y = 2024; y <= 2030; y++) for (let m = 0; m < 12; m++) MONTHS.push([y, m]);

const itemOf = (anchor, cycle, type = 'expense', price = 100) => ({
  id: `${type}-${cycle}-${anchor}`, type, name: `${cycle} ${anchor}`, price, currency: 'TWD', cycle,
  nextRenewal: cycle === 'once' ? '' : anchor, date: cycle === 'once' ? anchor : '', category: 'Group',
});
/** A household's worth of items: a few of each kind, two currencies, undated ones. */
const PORTFOLIO = [
  itemOf('2026-01-31', 'monthly', 'expense', 390), itemOf('2024-02-29', 'annual', 'expense', 1490),
  itemOf('2026-12-24', 'once', 'expense', 2400), itemOf('2026-11-20', 'monthly', 'expense', 99),
  itemOf('2026-11-25', 'annual', 'expense', 12.5), itemOf('2026-11-01', 'monthly', 'income', 60000),
  itemOf('2027-06-30', 'annual', 'income', 30000), itemOf('2026-11-22', 'once', 'income', 5000),
  itemOf('', 'monthly', 'expense', 50), itemOf('', 'annual', 'income', 70), itemOf('2026-03-31', 'weekly', 'expense', 150),
  { ...itemOf('2026-11-21', 'monthly', 'expense', 9.99), currency: 'USD' }, itemOf('2026-02-30', 'monthly', 'expense', 1),
  itemOf('1999-12-31', 'annual', 'expense', 200), itemOf('2030-05-31', 'monthly', 'expense', 10),
];

/* ------------------------------------------------------------------ Sections */

function sectionNext() {
  const lines = [];
  for (const a of ANCHORS) for (const c of CYCLES) for (const now of TODAYS) {
    lines.push(`${a}|${c}|${ser(now)} ${ser(nextRenewal(itemOf(a, c), now))}`);
  }
  // A cycle missing altogether, and an unusable "now".
  for (const a of ANCHORS) {
    lines.push(`${a}|none ${ser(nextRenewal({ nextRenewal: a }, TODAYS[17]))}`);
    lines.push(`${a}|monthly|NaN ${ser(nextRenewal(itemOf(a, 'monthly'), new Date(NaN)))}`);
    lines.push(`${a}|monthly|number ${ser(nextRenewal(itemOf(a, 'monthly'), TODAYS[17].getTime()))}`);
  }
  return lines;
}

function sectionCalendar() {
  const lines = [];
  for (const a of ANCHORS) for (const c of CYCLES) for (const [y, m] of MONTHS) {
    const days = stepDays(itemOf(a, c), y, m);
    if (days.length) lines.push(`${a}|${c}|${y}-${m} ${days.join(',')}`);
  }
  for (const [y, m] of MONTHS) {
    const o = occurrences(PORTFOLIO, y, m, { currency: 'TWD' });
    lines.push(`${y}-${m} ${o.total} ${o.income} ${o.count} ${JSON.stringify(o.others)} ${o.undated.map((s) => s.id).join(',')} `
      + o.days.map((d) => `${d.day}:${d.rows.map((r) => `${r.item.id}=${r.amount}`).join('+')}`).filter((x) => !x.endsWith(':')).join(' '));
  }
  return lines;
}

function sectionCash() {
  const lines = [];
  for (const a of ANCHORS) for (const c of CYCLES) for (const type of ['expense', 'income']) {
    const s = itemOf(a, c, type, 100);
    lines.push(`${a}|${c}|${type} ${MONTHS.map(([y, m]) => (type === 'income' ? incomeInMonth(s, y, m) : dueInMonth(s, y, m))).join(',')}`);
  }
  const tw = PORTFOLIO.filter((s) => s.currency === 'TWD');
  for (const [y, m] of MONTHS) {
    lines.push(`${y}-${m} due ${cashDue(tw, y, m)} in ${incomeDue(tw, y, m)} ${JSON.stringify(breakdown(tw, y, m), (k, v) => (k === 'items' ? v.map((s) => `${s.id}=${s.due}`) : v))}`);
    lines.push(`${y}-${m} strip ${JSON.stringify(stripSummary(tw, 'monthly', y, m))} ${JSON.stringify(stripSummary(tw, 'annual', y, m))}`);
  }
  for (let y = 2024; y <= 2030; y++) {
    lines.push(`${y} ${JSON.stringify(yearSummary(tw, y))} ${yearTotal(tw, y)} ${monthlyAverage(tw, y)} ${JSON.stringify(monthSeries(tw, y, 6, 13, { income: true }))}`);
  }
  return lines;
}

function sectionDueSoon() {
  const lines = [];
  for (const now of TODAYS) for (const windowDays of [3, 7, 14]) for (const includeIncome of [false, true]) {
    const r = dueSoon(PORTFOLIO, now, { windowDays, includeIncome, currency: 'TWD' });
    lines.push(`${ser(now)}|${windowDays}|${includeIncome} ${r.total} ${r.incomeTotal} ${r.count} ${JSON.stringify(r.others)} `
      + `${r.rows.map((x) => `${x.item.id}@${ser(x.date)}+${x.days}`).join(' ')} | ${r.undated.map((s) => s.id).join(',')}`);
  }
  return lines;
}

// Fingerprints of each section, recorded on 1.19.0 (08bcdc4) in America/New_York. Never update them
// to make a change pass: a change here is a change in what people see.
const FROZEN = {
  next: { lines: 12257, sha256: 'e3f0083350b6798bb824a0cb02853f051515b91126be638a93dcf08d2b8f3d6d' },
  calendar: { lines: 17674, sha256: 'f4d33a10d100f2e5c4864a613d124665d5b57747c97b5292ae3ab1806b0688ab' },
  cash: { lines: 999, sha256: '1635e07bb9a992595c31a9169bc151130a6496666222540ae1de9e9317250e8a' },
  dueSoon: { lines: 174, sha256: '242461502c1d280fd4516904e52b42e779f1f9e0eefa1ad8cfe59135739061d8' },
};

for (const [name, fn] of Object.entries({ next: sectionNext, calendar: sectionCalendar, cash: sectionCash, dueSoon: sectionDueSoon })) {
  test(`characterisation, ${name}: the same results as 1.19.0 over the whole grid`, () => {
    const lines = fn();
    assert.equal(lines.length, FROZEN[name].lines, 'grid size');
    assert.equal(digest(lines), FROZEN[name].sha256, `${name}: a result differs from 1.19.0 (see the spot checks and tests/interval-differential.node.test.js)`);
  });
}

/* ------------------------------------------------------------------ Readable spot checks */

const at = (y, m, d) => new Date(y, m - 1, d, 12);
const next = (anchor, cycle, now) => ser(nextRenewal(itemOf(anchor, cycle), now));

test('spot checks: month ends clamp and come back, 29 February, rolling forward only', () => {
  assert.equal(next('2027-01-31', 'monthly', at(2027, 2, 10)), '2027-02-28');
  assert.equal(next('2027-01-31', 'monthly', at(2027, 3, 1)), '2027-03-31', 'back to the 31st');
  assert.equal(next('2028-01-31', 'monthly', at(2028, 2, 10)), '2028-02-29');
  assert.equal(next('2026-01-30', 'monthly', at(2026, 2, 27)), '2026-02-28');
  assert.equal(next('2026-01-29', 'monthly', at(2026, 2, 28)), '2026-02-28', 'the 29th clamps to 28 February, due that day');
  assert.equal(next('2024-02-29', 'annual', at(2025, 1, 1)), '2025-02-28');
  assert.equal(next('2024-02-29', 'annual', at(2027, 3, 1)), '2028-02-29');
  assert.equal(next('2026-12-31', 'monthly', at(2027, 1, 1)), '2027-01-31');
  assert.equal(next('2030-05-31', 'monthly', at(2026, 11, 19)), '2030-05-31', 'a future date is shown as it is');
  assert.equal(next('2026-11-19', 'monthly', at(2026, 11, 19)), '2026-11-19', 'due today');
  assert.equal(next('2026-11-19', 'monthly', new Date(2026, 10, 19, 23, 59)), '2026-11-19');
  assert.equal(next('2026-03-31', 'weekly', at(2026, 11, 19)), '2026-11-30', 'an unknown cycle steps monthly');
  assert.equal(next('2026-06-15', 'once', at(2026, 11, 19)), 'null');
  assert.equal(next('', 'monthly', at(2026, 11, 19)), 'null');
  assert.equal(next('2026-1-05', 'monthly', at(2026, 11, 19)), 'null', 'not YYYY-MM-DD');
});

test('spot checks: dates the parser rolls over are stepped from the rolled-over day', () => {
  assert.equal(ser(parseDate('2026-02-30')), '2026-03-02');
  assert.equal(next('2026-02-30', 'monthly', at(2026, 11, 19)), '2026-12-02');
  assert.equal(ser(parseDate('2026-13-05')), '2027-01-05');
  assert.equal(ser(parseDate('2026-00-15')), '2025-12-15');
  assert.equal(next('2026-11-00', 'annual', at(2026, 11, 19)), '2027-10-31');
});

test('spot checks: an unusable "now" leaves the stored date; a number works like a Date', () => {
  assert.equal(next('2020-01-15', 'monthly', new Date(NaN)), '2020-01-15');
  assert.equal(next('2020-01-15', 'monthly', at(2026, 11, 19).getTime()), '2026-12-15');
});

test('spot checks: the calendar and the cash basis, before and after the stored date', () => {
  const m = itemOf('2027-01-31', 'monthly');
  assert.deepEqual(stepDays(m, 2026, 1), [28], 'before the stored date: the same clamp');
  assert.deepEqual(stepDays(m, 2027, 1), [28]);
  assert.deepEqual(stepDays(m, 2027, 3), [30]);
  assert.deepEqual(stepDays(itemOf('2024-02-29', 'annual'), 2027, 1), [28]);
  assert.deepEqual(stepDays(itemOf('2024-02-29', 'annual'), 2028, 1), [29]);
  assert.deepEqual(stepDays(itemOf('2024-02-29', 'annual'), 2028, 2), []);
  assert.equal(dueInMonth(m, 2020, 4), 100, 'monthly counts in every month, even long before its date');
  assert.equal(dueInMonth(itemOf('2024-02-29', 'annual'), 2031, 1), 100);
  assert.equal(dueInMonth(itemOf('2024-02-29', 'annual'), 2031, 2), 0);
  assert.equal(incomeInMonth(itemOf('2026-11-01', 'monthly', 'income'), 2026, 10), 100);
  assert.equal(dueInMonth(itemOf('2026-11-01', 'monthly', 'income'), 2026, 10), 0, 'income is never an outgoing');
});

test('spot checks: DST-change days are ordinary days', () => {
  assert.equal(next('2026-03-08', 'monthly', new Date(2026, 2, 8, 3, 30)), '2026-03-08');
  assert.equal(next('2026-03-08', 'monthly', new Date(2026, 2, 9, 0, 0)), '2026-04-08');
  assert.equal(next('2026-11-01', 'monthly', new Date(2026, 10, 1, 1, 30)), '2026-11-01');
  const r = dueSoon([itemOf('2026-03-09', 'monthly')], new Date(2026, 2, 8, 12), { windowDays: 3 });
  assert.deepEqual(r.rows.map((x) => x.days), [1], 'tomorrow across the change');
});

/* ------------------------------------------------------------------ The two known bugs, as they are */

test('known bug a (as of 1.19.0): years 0–99 are read as 1900–1999', () => {
  assert.equal(ser(parseDate('0050-03-01')), '1950-03-01');
  assert.equal(ser(parseDate('0000-02-29')), '1900-03-01', 'year 0 is a leap year; 1900 is not');
  // Read as 1900-03-01, 1520 months back: 1.19.0 also hit bug b's 1200-step limit (2000-03-01).
  assert.equal(next('0000-02-29', 'monthly', at(2026, 11, 19)), '2026-12-01');
  assert.equal(next('0000-02-29', 'annual', at(2026, 11, 19)), '2027-03-01');
  const once = itemOf('0050-06-15', 'once');
  assert.equal(dueInMonth(once, 1950, 5), 100, 'a one-off in year 50 counts in 1950');
  assert.equal(dueInMonth(once, 50, 5), 0);
  assert.deepEqual(stepDays(once, 1950, 5), [15]);
});

// Fixed after 1.19.0: nextRenewal() stepped one interval at a time and gave up after 1200 steps,
// returning a date in the past for stored dates more than 100 years (monthly) or 1200 years
// (annual) back. It now works the date out directly. 1.19.0's results are in the messages.
test('fixed bug b: nextRenewal rolls any stored date forward, however old (1.19.0 stopped after 1200 steps)', () => {
  assert.equal(next('1876-01-15', 'monthly', at(2026, 11, 19)), '2026-12-15', '1.19.0: 1976-01-15');
  assert.equal(next('1925-03-31', 'monthly', at(2026, 11, 19)), '2026-11-30', '1.19.0: 2025-03-31');
  assert.equal(next('1926-11-19', 'monthly', at(2026, 11, 19)), '2026-11-19', '1200 steps exactly: right before and after');
  assert.equal(next('0500-06-15', 'annual', at(2026, 11, 19)), '2027-06-15', '1.19.0: 1700-06-15');
  const banner = dueSoon([itemOf('1876-11-20', 'monthly')], at(2026, 11, 19), { windowDays: 7 });
  assert.deepEqual(banner.rows.map((r) => [ser(r.date), r.days]), [['2026-11-20', 1]], '1.19.0 left it out of the banner');
  assert.deepEqual(stepDays(itemOf('1876-01-15', 'monthly'), 2026, 10), [15], 'the calendar was right before and is right now');
});
