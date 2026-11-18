// Worker for tests/interval-differential.node.test.js: runs in one time zone (the TZ it was
// started with), compares 1.19.0's date stepping with the current code over a large grid, and
// prints one JSON line: { tz, resolved, offsets, compared, sections, diffs: { a, b, unexpected } },
// each diffs entry { count, sample } (every known-bug difference, the first 50 unexpected ones).
//
// 1.19.0: tests/legacy-1.19.0/util.js (nextRenewal, parseDate) and insights-calc.js (dueInMonth,
// incomeInMonth), plus the frozen copies of calendar-math.js stepDays and due-soon.js dueSoon
// below (from 08bcdc4, unchanged apart from taking 1.19.0's own util functions).
// Current: js/util.js, js/calendar-math.js, js/insights-calc.js, js/due-soon.js.
//
// Every difference is sorted into a known bug or "unexpected":
//   a  a year 0–99 is involved (the stored date's year, or the month asked about)
//   b  1.19.0's nextRenewal gave up after 1200 steps: its date is before "today"
// Arguments: none. Environment: TZ.

import * as oldUtil from '../legacy-1.19.0/util.js';
import * as oldCalc from '../legacy-1.19.0/insights-calc.js';
import * as newUtil from '../../js/util.js';
import * as newCalc from '../../js/insights-calc.js';
import { stepDays as newStepDays } from '../../js/calendar-math.js';
import { dueSoon as newDueSoon } from '../../js/due-soon.js';

/* ---------------------------------------------------------------- 1.19.0, frozen copies */

// js/calendar-math.js at 08bcdc4: daysInMonth and stepDays.
const oldDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
function oldStepDays(s, year, month) {
  if (oldUtil.isOnce(s)) {
    const d = oldUtil.parseDate(s.date);
    return d && d.getFullYear() === year && d.getMonth() === month ? [d.getDate()] : [];
  }
  const start = oldUtil.parseDate(s.nextRenewal);
  if (!start) return []; // undated: see undatedItems()
  if (s.cycle === 'annual' && start.getMonth() !== month) return [];
  const first = new Date(year, month, 1);
  if (first >= new Date(start.getFullYear(), start.getMonth(), 1)) {
    const d = oldUtil.nextRenewal(s, first);
    if (d && d.getFullYear() === year && d.getMonth() === month) return [d.getDate()];
  }
  return [Math.min(start.getDate(), oldDaysInMonth(year, month))];
}

// js/due-soon.js at 08bcdc4: the parts that work out dates (the totals use the rows as they are).
const oldDayNumber = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
const oldDaysBetween = (from, to) => oldDayNumber(to) - oldDayNumber(from);
function oldNextDate(s, now) {
  if (oldUtil.isOnce(s)) {
    const d = oldUtil.parseDate(s.date);
    return d && oldDaysBetween(now, d) >= 0 ? d : null;
  }
  return oldUtil.nextRenewal(s, now);
}
function oldDueRows(items, now, days, includeIncome) {
  const rows = [];
  for (const s of items) {
    if (oldUtil.isIncome(s) && (!includeIncome || oldUtil.isOnce(s))) continue;
    const date = oldNextDate(s, now);
    if (!date) continue;
    const n = oldDaysBetween(now, date);
    if (n < 0 || n > days) continue;
    rows.push({ id: s.id, date: ser(date), days: n });
  }
  return rows.sort((a, b) => a.days - b.days || a.id.localeCompare(b.id));
}

/* ---------------------------------------------------------------- Grid */

const pad = (n, w = 2) => String(n).padStart(w, '0');
const iso = (y, m, d) => `${pad(y, 4)}-${pad(m + 1)}-${pad(d)}`;
const ser = (d) => (d instanceof Date ? (Number.isNaN(d.getTime()) ? 'Invalid' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`) : String(d));
const item = (anchor, cycle, type = 'expense') => ({
  id: `${cycle}:${anchor}:${type}`, type, name: anchor, price: 100, currency: 'TWD', cycle,
  nextRenewal: cycle === 'once' ? '' : anchor, date: cycle === 'once' ? anchor : '',
});
const yearOf = (anchor) => Number(String(anchor).slice(0, 4));

let compared = 0;
const sections = {};
const diffs = { a: [], b: [], unexpected: [] };
function check(section, label, oldV, newV, ctx) {
  compared++;
  sections[section] = (sections[section] ?? 0) + 1;
  const o = JSON.stringify(oldV);
  const n = JSON.stringify(newV);
  if (o === n) return;
  const entry = `${section} ${label}: 1.19.0 ${o}, now ${n}`;
  if (ctx.year0to99) diffs.a.push(entry);
  else if (ctx.stale) diffs.b.push(entry);
  else diffs.unexpected.push(entry);
}

function eachDay(y0, m0, d0, y1, m1, d1, fn) {
  for (let t = Date.UTC(y0, m0, d0); t <= Date.UTC(y1, m1, d1); t += 86400000) {
    const u = new Date(t);
    fn(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
  }
}

const CYCLES = ['monthly', 'annual', 'weekly'];
const OFFSETS = [-400, -40, -1, 0, 1, 29, 31, 365, 800];

/** The plan's grid: every anchor day in a span × 3 cycles × (each month's days and cash, and next from 9 offsets). */
function denseGrid(span, months) {
  eachDay(...span, (y, m, d) => {
    const anchor = iso(y, m, d);
    for (const cycle of CYCLES) {
      const s = item(anchor, cycle);
      for (const [qy, qm] of months) {
        check('stepDays', `${anchor} ${cycle} ${qy}-${qm + 1}`, oldStepDays(s, qy, qm), newStepDays(s, qy, qm), {});
        check('dueInMonth', `${anchor} ${cycle} ${qy}-${qm + 1}`, oldCalc.dueInMonth(s, qy, qm), newCalc.dueInMonth(s, qy, qm), {});
      }
      for (const off of OFFSETS) {
        const now = new Date(y, m, d + off, 12);
        check('nextRenewal', `${anchor} ${cycle} from ${ser(now)}`, ser(oldUtil.nextRenewal(s, now)), ser(newUtil.nextRenewal(s, now)), {});
      }
    }
    if (d % 7 === 0) {
      const inc = item(anchor, 'monthly', 'income');
      const ann = item(anchor, 'annual', 'income');
      for (const [qy, qm] of months) {
        check('incomeInMonth', `${anchor} ${qy}-${qm + 1}`, oldCalc.incomeInMonth(inc, qy, qm), newCalc.incomeInMonth(inc, qy, qm), {});
        check('incomeInMonth', `${anchor} annual ${qy}-${qm + 1}`, oldCalc.incomeInMonth(ann, qy, qm), newCalc.incomeInMonth(ann, qy, qm), {});
      }
    }
  });
}

const monthsOf = (y0, y1) => { const out = []; for (let y = y0; y <= y1; y++) for (let m = 0; m < 12; m++) out.push([y, m]); return out; };

// 1. The plan's grid (its 618,003 comparisons: every anchor day of 2023–2026 × 3 cycles × the
// calendar days of 132 months and the next date from 9 offsets), plus the cash for the same months.
denseGrid([2023, 0, 1, 2026, 11, 31], monthsOf(2020, 2030));
// 2. Anchors from São Paulo's last years with DST (its clocks changed at midnight until 2019).
denseGrid([2016, 9, 1, 2019, 2, 31], monthsOf(2016, 2020));

// 3. One-offs: every day 2023–2026, the months around it.
eachDay(2023, 0, 1, 2026, 11, 31, (y, m, d) => {
  const s = item(iso(y, m, d), 'once');
  for (let k = -1; k <= 1; k++) {
    const q = new Date(y, m + k, 1);
    const [qy, qm] = [q.getFullYear(), q.getMonth()];
    check('stepDays', `${s.date} once ${qy}-${qm + 1}`, oldStepDays(s, qy, qm), newStepDays(s, qy, qm), {});
    check('dueInMonth', `${s.date} once ${qy}-${qm + 1}`, oldCalc.dueInMonth(s, qy, qm), newCalc.dueInMonth(s, qy, qm), {});
  }
});

// 4. The due-soon banner's rows (dates and days), every "today" 2023–2026 at the day's first and last
// minute, three windows, with income, over a portfolio sampled every 61st day of 2022–2027.
{
  const portfolio = [];
  eachDay(2022, 0, 3, 2027, 11, 31, (y, m, d) => {
    if ((y * 372 + m * 31 + d) % 61) return; // a deterministic sample: about 30 anchors × 5 kinds
    const a = iso(y, m, d);
    portfolio.push(item(a, 'monthly'), item(a, 'annual'), item(a, 'once'), item(a, 'monthly', 'income'), item(a, 'weekly'));
  });
  eachDay(2023, 0, 1, 2026, 11, 31, (y, m, d) => {
    for (const [hour, min] of [[0, 0], [23, 59]]) {
      const now = new Date(y, m, d, hour, min);
      for (const days of [3, 7, 14]) {
        const got = newDueSoon(portfolio, now, { windowDays: days, includeIncome: true, currency: 'TWD' }).rows
          .map((r) => ({ id: r.item.id, date: ser(r.date), days: r.days })).sort((a, b) => a.days - b.days || a.id.localeCompare(b.id));
        check('dueSoon', `${ser(now)} ${days}`, oldDueRows(portfolio, now, days, true), got, {});
      }
    }
  });
}

// 5. Outside real data: years 0–99, and stored dates so old that 1.19.0 gave up after 1200 steps.
{
  const anchors = [];
  for (const y of [0, 1, 4, 50, 99]) for (const md of ['01-01', '01-31', '02-28', '02-29', '06-15', '12-31']) anchors.push(`${pad(y, 4)}-${md}`);
  anchors.push('0100-01-15', '0500-06-15', '1000-02-29', '1800-01-31', '1876-01-15', '1876-11-20', '1900-02-28',
    '1925-03-31', '1926-11-18', '1926-11-19', '1926-11-20', '1950-03-01', '1999-01-31');
  const todays = [new Date(2024, 0, 1, 12), new Date(2026, 10, 19, 12), new Date(2026, 10, 19, 0), new Date(2030, 5, 30, 12)];
  const months = [...monthsOf(2026, 2026), ...monthsOf(1950, 1950), ...monthsOf(50, 50), [0, 1], [0, 2], [1900, 1], [1900, 2]];
  for (const anchor of anchors) {
    const y0to99 = yearOf(anchor) < 100;
    for (const cycle of ['monthly', 'annual', 'once', 'weekly']) {
      const s = item(anchor, cycle);
      for (const now of todays) {
        const o = oldUtil.nextRenewal(s, now);
        const today = new Date(now); today.setHours(0, 0, 0, 0);
        check('nextRenewal', `${anchor} ${cycle} from ${ser(now)}`, ser(o), ser(newUtil.nextRenewal(s, now)), { year0to99: y0to99, stale: o !== null && o < today });
        const rowsOld = oldDueRows([s], now, 14, false);
        const rowsNew = newDueSoon([s], now, { windowDays: 14, currency: 'TWD' }).rows.map((r) => ({ id: r.item.id, date: ser(r.date), days: r.days }));
        check('dueSoon', `${anchor} ${cycle} from ${ser(now)}`, rowsOld, rowsNew, { year0to99: y0to99, stale: o !== null && o < today });
      }
      for (const [qy, qm] of months) {
        const ctx = { year0to99: y0to99 || qy < 100 };
        check('stepDays', `${anchor} ${cycle} ${qy}-${qm + 1}`, oldStepDays(s, qy, qm), newStepDays(s, qy, qm), ctx);
        check('dueInMonth', `${anchor} ${cycle} ${qy}-${qm + 1}`, oldCalc.dueInMonth(s, qy, qm), newCalc.dueInMonth(s, qy, qm), ctx);
      }
    }
    check('parseDate', anchor, ser(oldUtil.parseDate(anchor)), ser(newUtil.parseDate(anchor)), { year0to99: y0to99 });
  }
}

// 6. Outside the callers' domain, kept apart from the grid and its counts: a year or month that is
// not a whole number of type number, or a month outside 0–11. Nothing in the app asks for these;
// the current code answers [] and 0 on purpose (js/interval.js isYearMonth). Reported for every
// case, with 1.19.0's answer beside it.
const outside = [];
for (const [cycle, anchor] of [['monthly', '2026-01-31'], ['annual', '2026-01-15'], ['annual', '2026-12-15'], ['once', '2027-01-10']]) {
  const s = item(anchor, cycle);
  for (const [qy, qm] of [[2026, 12], [2027, -1], [2026, 13], [2026, NaN], [NaN, 0], [2026, 1.5], [2026, '1']]) {
    const old = { stepDays: oldStepDays(s, qy, qm), due: oldCalc.dueInMonth(s, qy, qm) };
    const now = { stepDays: newStepDays(s, qy, qm), due: newCalc.dueInMonth(s, qy, qm) };
    outside.push({ label: `${cycle} ${anchor} (${String(qy)}, ${typeof qm === 'string' ? `'${qm}'` : String(qm)})`, old: JSON.parse(JSON.stringify(old)), now });
  }
}

const offsets = [new Date(2026, 0, 15, 12), new Date(2026, 6, 15, 12)].map((d) => d.getTimezoneOffset());
const cap = (list, n = Infinity) => ({ count: list.length, sample: list.slice(0, n) });
process.stdout.write(`${JSON.stringify({
  tz: process.env.TZ, resolved: Intl.DateTimeFormat().resolvedOptions().timeZone, offsets, compared, sections,
  diffs: { a: cap(diffs.a), b: cap(diffs.b), unexpected: cap(diffs.unexpected, 50) }, outside,
})}\n`);
