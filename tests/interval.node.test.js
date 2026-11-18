// Node tests for js/interval.js, the shared stepper: calendar day numbers (against the platform's own
// UTC calendar for 1900–2200, and for years 0–99 and before year 0), leap years, month-end
// clamping from the anchor's day, every unit (days, weeks, months, years) before and after the
// anchor, next / previous / between / inMonth / countInMonth agreeing with each other (seeded fuzz),
// far ranges by arithmetic, the result cap, the Date edge (dayOf, dateOf) in a time zone with DST,
// and bad input. Run with `npm test`. This file runs in a time zone with DST.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNITS, MONTHLY, ANNUAL, MAX_RESULTS, intervalOfCycle, isInterval, isLeapYear, daysInMonth, dayNumber, dayFromNumber,
  isDay, normalizeDay, compareDays, dayOf, dateOf, occurrence, indexOnOrAfter, nextOnOrAfter, previousBefore, between,
  inMonth, countInMonth,
} from '../js/interval.js';

const D = (year, month1, day) => ({ year, month: month1 - 1, day }); // month written 1–12 here
const iso = (d) => `${String(d.year).padStart(4, '0')}-${String(d.month + 1).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
const isoDate = (s) => { const [y, m, d] = s.split('-').map(Number); return D(y, m, d); };
const run = (anchor, interval, k0, k1) => { const out = []; for (let k = k0; k <= k1; k++) out.push(iso(occurrence(anchor, interval, k))); return out; };
const every = (n, unit) => ({ every: n, unit });

let seed = 20261119;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

test('cycles map to intervals: monthly every 1 month, annual every 12 months, once none, anything else monthly', () => {
  assert.deepEqual(UNITS, ['day', 'week', 'month', 'year']);
  assert.deepEqual(intervalOfCycle('monthly'), { every: 1, unit: 'month' });
  assert.deepEqual(intervalOfCycle('annual'), { every: 12, unit: 'month' });
  assert.equal(intervalOfCycle('once'), null);
  assert.equal(intervalOfCycle('weekly'), MONTHLY, 'what 1.19.0 does with a cycle it doesn\'t know');
  assert.equal(intervalOfCycle(undefined), MONTHLY);
  assert.ok(Object.isFrozen(MONTHLY) && Object.isFrozen(ANNUAL));
  for (const u of UNITS) assert.ok(isInterval(every(3, u)));
  for (const bad of [null, {}, every(0, 'month'), every(1.5, 'month'), every(-1, 'day'), every(1, 'fortnight'), every('1', 'day'), every(NaN, 'day')]) {
    assert.equal(isInterval(bad), false, JSON.stringify(bad));
  }
});

test('day numbers match the platform\'s UTC calendar from 1900 to 2200, day by day', () => {
  for (let t = Date.UTC(1900, 0, 1); t <= Date.UTC(2200, 11, 31); t += 86400000) {
    const u = new Date(t);
    const day = { year: u.getUTCFullYear(), month: u.getUTCMonth(), day: u.getUTCDate() };
    const n = t / 86400000;
    assert.equal(dayNumber(day), n);
    const back = dayFromNumber(n);
    if (back.year !== day.year || back.month !== day.month || back.day !== day.day) assert.fail(`${iso(day)} came back as ${iso(back)}`);
  }
});

test('years 0–99 and before year 0 are those years (no 1900 shift), and round-trip', () => {
  const utc = (y, m, d) => { const t = new Date(0); t.setUTCFullYear(y, m, d); return t.getTime() / 86400000; };
  for (const [y, m, d] of [[0, 0, 1], [0, 1, 29], [1, 0, 1], [50, 2, 1], [99, 11, 31], [100, 0, 1], [-1, 11, 31], [-400, 1, 29], [9999, 11, 31], [275000, 5, 15]]) {
    assert.equal(dayNumber({ year: y, month: m, day: d }), utc(y, m, d), `${y}-${m + 1}-${d}`);
    assert.deepEqual(dayFromNumber(utc(y, m, d)), { year: y, month: m, day: d });
  }
  assert.equal(dayNumber(D(50, 3, 1)) - dayNumber(D(1950, 3, 1)), -(1900 * 365 + 460), '1900 years apart, not 0');
  for (let n = -1_000_000; n < 4_000_000; n += 997) assert.equal(dayNumber(dayFromNumber(n)), n);
});

test('leap years and month lengths', () => {
  assert.deepEqual([0, 4, 1900, 2000, 2024, 2100, 2400, -4, 2026].map(isLeapYear), [true, true, false, true, true, false, true, true, false]);
  assert.deepEqual([...Array(12).keys()].map((m) => daysInMonth(2028, m)), [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
  assert.equal(daysInMonth(2027, 1), 28);
  assert.equal(daysInMonth(0, 1), 29, 'year 0 is a leap year');
  assert.equal(daysInMonth(2026, 12), 31, 'month 12 is January of the next year');
  assert.equal(daysInMonth(2026, -1), 31, 'month -1 is December of the year before');
});

test('days that roll over, real days, comparing', () => {
  assert.deepEqual(normalizeDay(D(2026, 2, 30)), D(2026, 3, 2));
  assert.deepEqual(normalizeDay(D(2026, 13, 5)), D(2027, 1, 5));
  assert.deepEqual(normalizeDay(D(2026, 11, 0)), D(2026, 10, 31));
  assert.ok(isDay(D(2028, 2, 29)));
  for (const bad of [D(2027, 2, 29), D(2026, 4, 31), { year: 2026, month: 12, day: 1 }, { year: 2026, month: 0, day: 0 }, { year: 2026.5, month: 0, day: 1 }, null]) assert.equal(isDay(bad), false);
  assert.ok(compareDays(D(2026, 1, 1), D(2025, 12, 31)) === 1 && compareDays(D(2026, 1, 1), D(2026, 1, 1)) === 0);
});

test('months clamp from the anchor\'s day, never from the clamped date before', () => {
  assert.deepEqual(run(D(2027, 1, 31), MONTHLY, -1, 5), ['2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31', '2027-06-30']);
  assert.deepEqual(run(D(2028, 1, 31), MONTHLY, 0, 3), ['2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30']);
  assert.deepEqual(run(D(2027, 11, 30), every(3, 'month'), 0, 4), ['2027-11-30', '2028-02-29', '2028-05-30', '2028-08-30', '2028-11-30']);
  assert.deepEqual(run(D(2027, 8, 31), every(6, 'month'), 0, 3), ['2027-08-31', '2028-02-29', '2028-08-31', '2029-02-28']);
  assert.deepEqual(run(D(2028, 2, 29), ANNUAL, -1, 4), ['2027-02-28', '2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  assert.deepEqual(run(D(2028, 2, 29), every(1, 'year'), -1, 4), run(D(2028, 2, 29), ANNUAL, -1, 4), 'a year is 12 months');
  assert.deepEqual(run(D(2028, 2, 29), every(4, 'year'), 0, 2), ['2028-02-29', '2032-02-29', '2036-02-29']);
  assert.deepEqual(run(D(2096, 2, 29), every(4, 'year'), 0, 2), ['2096-02-29', '2100-02-28', '2104-02-29'], '2100 is no leap year');
});

test('days and weeks are whole calendar days, across DST changes and leap days', () => {
  assert.deepEqual(run(D(2026, 3, 1), every(1, 'week'), 0, 2), ['2026-03-01', '2026-03-08', '2026-03-15'], 'New York changes on 8 March');
  assert.deepEqual(run(D(2027, 3, 26), every(2, 'week'), 0, 3), ['2027-03-26', '2027-04-09', '2027-04-23', '2027-05-07']);
  assert.deepEqual(run(D(2028, 2, 27), every(1, 'day'), 0, 3), ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
  assert.deepEqual(run(D(2026, 1, 1), every(10, 'day'), -2, 1), ['2025-12-12', '2025-12-22', '2026-01-01', '2026-01-11']);
});

test('next, previous, between, inMonth and countInMonth agree (seeded fuzz over every unit)', () => {
  for (let i = 0; i < 20000; i++) {
    const unit = UNITS[int(0, 3)];
    const interval = every(int(1, unit === 'day' ? 400 : unit === 'week' ? 60 : unit === 'month' ? 30 : 4), unit);
    const y = int(1, 9999); const m = int(0, 11);
    const anchor = { year: y, month: m, day: int(1, daysInMonth(y, m)) };
    const fy = Math.max(0, y + int(-300, 300)); const fm = int(0, 11);
    const from = { year: fy, month: fm, day: int(1, daysInMonth(fy, fm)) };
    const k = indexOnOrAfter(anchor, interval, from);
    const nx = nextOnOrAfter(anchor, interval, from);
    const pv = previousBefore(anchor, interval, from);
    assert.ok(compareDays(nx, from) >= 0, 'next is on or after');
    assert.ok(compareDays(pv, from) < 0, 'previous is before');
    assert.deepEqual(occurrence(anchor, interval, k - 1), pv);
    assert.ok(isDay(nx) && isDay(pv));
    if (interval.unit === 'month' || interval.unit === 'year') assert.equal(nx.day, Math.min(anchor.day, daysInMonth(nx.year, nx.month)));
    const list = inMonth(anchor, interval, nx.year, nx.month);
    assert.ok(list.some((d) => compareDays(d, nx) === 0), 'inMonth finds the next one');
    assert.equal(countInMonth(anchor, interval, nx.year, nx.month), list.length);
    assert.equal(countInMonth(anchor, interval, from.year, from.month), inMonth(anchor, interval, from.year, from.month).length);
    for (let j = 1; j < list.length; j++) assert.ok(compareDays(list[j], list[j - 1]) > 0, 'earliest first');
  }
});

test('counts per month: weekly 4 or 5, fortnightly 2 or 3, monthly 1, annual 1 in its month', () => {
  const tally = (interval, anchor) => {
    const t = {};
    for (let y = 2000; y < 2400; y++) for (let m = 0; m < 12; m++) { const n = countInMonth(anchor, interval, y, m); t[n] = (t[n] ?? 0) + 1; }
    return t;
  };
  assert.deepEqual(tally(every(1, 'week'), D(2026, 11, 19)), { 4: 3129, 5: 1671 });
  assert.deepEqual(tally(every(2, 'week'), D(2026, 11, 19)), { 2: 3964, 3: 836 });
  assert.deepEqual(tally(MONTHLY, D(2026, 1, 31)), { 1: 4800 });
  assert.deepEqual(tally(ANNUAL, D(2024, 2, 29)), { 0: 4400, 1: 400 });
});

test('far ranges are arithmetic: an anchor in year 1 asked about year 9999, fast', () => {
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) {
    nextOnOrAfter(D(1, 1, 31), MONTHLY, D(9999, 6, 15));
    countInMonth(D(1, 1, 1), every(1, 'day'), 9999, 11);
  }
  assert.ok(performance.now() - t0 < 2000, 'well under the time a walk would take');
  assert.deepEqual(nextOnOrAfter(D(1, 1, 31), MONTHLY, D(9999, 6, 15)), D(9999, 6, 30));
  assert.deepEqual(nextOnOrAfter(D(1876, 1, 15), MONTHLY, D(2026, 11, 19)), D(2026, 12, 15));
  assert.deepEqual(previousBefore(D(1876, 1, 15), MONTHLY, D(2026, 11, 19)), D(2026, 11, 15));
});

test('between: both ends included, earliest first, at most MAX_RESULTS', () => {
  assert.deepEqual(between(D(2026, 1, 31), MONTHLY, D(2026, 2, 1), D(2026, 5, 31)).map(iso), ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.deepEqual(between(D(2026, 1, 1), every(1, 'day'), D(2026, 1, 5), D(2026, 1, 5)).map(iso), ['2026-01-05']);
  assert.deepEqual(between(D(2026, 1, 1), MONTHLY, D(2026, 1, 5), D(2026, 1, 4)), []);
  assert.equal(between(D(2000, 1, 1), every(1, 'day'), D(2000, 1, 1), D(2100, 1, 1)).length, MAX_RESULTS);
  assert.equal(between(D(2000, 1, 1), every(1, 'day'), D(2000, 1, 1), D(2100, 1, 1), { limit: 10 }).length, 10);
  assert.deepEqual(inMonth(D(2024, 2, 29), ANNUAL, 2027, 1).map(iso), ['2027-02-28']);
  assert.deepEqual(inMonth(D(2024, 2, 29), ANNUAL, 2027, 2), []);
});

test('the Date edge: dayOf and dateOf, local midnight, years 0–99 kept, DST days', () => {
  const d = dateOf(D(2026, 3, 8));
  assert.equal(d.getTime(), new Date(2026, 2, 8).getTime(), 'what the app has always built');
  assert.deepEqual(dayOf(d), D(2026, 3, 8));
  assert.deepEqual(dayOf(new Date(2026, 10, 1, 1, 30)), D(2026, 11, 1));
  const y50 = dateOf(D(50, 3, 1));
  assert.deepEqual([y50.getFullYear(), y50.getMonth(), y50.getDate(), y50.getHours()], [50, 2, 1, 0]);
  assert.deepEqual(dayOf(dateOf(D(0, 2, 29))), D(0, 2, 29));
  assert.deepEqual(dayOf(dateOf(D(99, 12, 31))), D(99, 12, 31));
  for (let n = dayNumber(D(2025, 1, 1)); n <= dayNumber(D(2027, 12, 31)); n++) {
    const day = dayFromNumber(n);
    assert.deepEqual(dayOf(dateOf(day)), day, iso(day));
  }
});

test('bad input is refused, never stepped', () => {
  assert.throws(() => occurrence(D(2026, 2, 30), MONTHLY, 0), TypeError);
  assert.throws(() => occurrence(D(2026, 1, 1), every(0, 'month'), 0), TypeError);
  assert.throws(() => occurrence(D(2026, 1, 1), MONTHLY, 1.5), TypeError);
  assert.throws(() => nextOnOrAfter(D(2026, 1, 1), MONTHLY, { year: NaN, month: 0, day: 1 }), TypeError);
  assert.throws(() => between(D(2026, 1, 1), MONTHLY, D(2026, 1, 1), { year: 2026, month: NaN, day: 1 }), TypeError);
  assert.deepEqual(isoDate('2026-11-19'), D(2026, 11, 19));
});
