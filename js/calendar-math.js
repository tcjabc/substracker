// The Money tab's calendar view: the month grid and what falls on each day. Pure (no DOM, no
// storage), shared by the app and tests/calendar-math.node.test.js.
//
// Which items, and in which month, are exactly Insights' cash basis (js/insights-calc.js): a
// monthly item every month, an annual item in the month of its stored date every year, a one-off
// only in the month of its date. Past and future months are projections from the item dates.
// Every amount here comes from insights-calc's dueInMonth() and incomeInMonth(), so the day totals
// of a month add up to cashDue() (and the income to incomeDue()) for that month: there is no other
// money calculation. Income is kept apart from expenses, and amounts in different currencies are
// never added: only the default currency is totalled, the others are counted ("+1 in USD").
//
// Which day: the item's day of the month, clamped to the last day of a shorter month, the rule
// util.nextRenewal() uses when it rolls a date forward. A monthly item on the 31st falls on the
// 30th in April and the 28th (29th) in February, and on the 31st again in May. An annual item
// stored on 29 February falls on 28 February in other years and on the 29th in leap years. From
// the stored date's month on, the day is nextRenewal()'s own date for that month; before it (a
// projection backwards, which nextRenewal() doesn't do), the same clamp. All of it is local
// calendar dates (year, month, day), never milliseconds, so a DST change can't move an item.
//
// Undated recurring items appear on no day; undatedItems() lists them for the "N items need a
// date" line. Custom intervals (later) replace stepDays() only: it's the one place that decides on
// which days of a month an item falls.

import { isIncome, isOnce, parseDate, nextRenewal } from './util.js';
import { dueInMonth, incomeInMonth, undatedItems, groupOf } from './insights-calc.js';

/* Week start ------------------------------------------------------------------------------------ */
/** The "Week starts on" setting: 'auto' (the default), 'mon' or 'sun'. Per device, never synced. */
export const WEEK_STARTS = Object.freeze(['auto', 'mon', 'sun']);
export const weekStartFrom = (pref) => (pref === 'mon' || pref === 'sun' ? pref : 'auto');

// Regions whose weeks start on Sunday, for engines without Intl.Locale weekInfo. A short list on
// purpose: the rest of the world (and en-GB) starts on Monday.
const SUNDAY_REGIONS = new Set(['TW', 'US', 'CA', 'JP', 'KR', 'HK', 'MO', 'IL', 'BR', 'MX', 'PH']);

/** The first day of the week (0 Sunday … 6 Saturday) in `locale`: Intl weekInfo, else the list. */
export function localeWeekStart(locale, { useIntl = true } = {}) {
  let loc = null;
  try { loc = new Intl.Locale(locale); } catch { return 1; }
  if (useIntl) {
    try {
      const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
      // Intl counts 1 Monday … 7 Sunday.
      if (info && Number.isInteger(info.firstDay) && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
    } catch { /* weekInfo unsupported */ }
  }
  let region = loc.region;
  try { region ??= loc.maximize().region; } catch { /* no likely subtags */ }
  return SUNDAY_REGIONS.has(region) ? 0 : 1;
}

/** The week's first day (0 Sunday, 1 Monday) for a setting, Auto following `locale`. */
export function resolveWeekStart(pref, locale) {
  const p = weekStartFrom(pref);
  return p === 'mon' ? 1 : p === 'sun' ? 0 : localeWeekStart(locale);
}

/* Grid ------------------------------------------------------------------------------------------ */
/** Days in `month` (0-based) of `year`. */
export const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

/** The month before or after: { year, month } `delta` months from `month` of `year`. */
export function addMonths(year, month, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/**
 * The month as whole weeks starting on `weekStart` (0 Sunday … 6 Saturday). Returns
 * { year, month, weekStart, weekdays: [7 weekday numbers in column order], weeks: [[7 cells]] },
 * each cell { year, month, day, weekday, inMonth }. Leading and trailing cells are the days of the
 * months either side, so every week is full; a month is 4, 5 or 6 weeks.
 */
export function monthGrid(year, month, weekStart = 1) {
  const ws = ((Number(weekStart) % 7) + 7) % 7;
  const lead = (new Date(year, month, 1).getDay() - ws + 7) % 7;
  const count = Math.ceil((lead + daysInMonth(year, month)) / 7) * 7;
  const weeks = [];
  for (let i = 0; i < count; i++) {
    // Built from parts (the 1st minus `lead`, plus i days), so no hour of a DST change matters.
    const d = new Date(year, month, 1 - lead + i);
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1].push({ year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), weekday: d.getDay(), inMonth: d.getMonth() === month });
  }
  return { year, month, weekStart: ws, weekdays: [0, 1, 2, 3, 4, 5, 6].map((i) => (ws + i) % 7), weeks };
}

/* Occurrences ----------------------------------------------------------------------------------- */
const isLive = (s) => s && s.del !== true && s.deleted !== true;

/**
 * The days of `month` (0-based) of `year` on which item `s` falls: [] or [day]. The one place that
 * steps through an item's dates (custom intervals replace this). Same months as insights-calc's
 * cash basis; the day is nextRenewal()'s from the stored date on, and its clamp before.
 */
export function stepDays(s, year, month) {
  if (isOnce(s)) {
    const d = parseDate(s.date);
    return d && d.getFullYear() === year && d.getMonth() === month ? [d.getDate()] : [];
  }
  const start = parseDate(s.nextRenewal);
  if (!start) return []; // undated: see undatedItems()
  if (s.cycle === 'annual' && start.getMonth() !== month) return [];
  const first = new Date(year, month, 1);
  if (first >= new Date(start.getFullYear(), start.getMonth(), 1)) {
    const d = nextRenewal(s, first);
    if (d && d.getFullYear() === year && d.getMonth() === month) return [d.getDate()];
  }
  return [Math.min(start.getDate(), daysInMonth(year, month))];
}

const byName = (a, b) => String(a.item.name ?? '').localeCompare(String(b.item.name ?? ''), undefined, { sensitivity: 'base' });
const countOthers = (rows, currency) => {
  const counts = new Map();
  for (const r of rows) if (r.currency !== currency) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([cur, count]) => ({ currency: cur, count }));
};

/**
 * What falls on each day of `month` (0-based) of `year`. Returns {
 *   year, month,
 *   days: [{ day, rows, total, income, others, count }] one per day of the month (index day − 1):
 *     rows    [{ item, amount, currency, income, group }] expenses A–Z, then income A–Z,
 *     total   the default currency's expenses that day, income its income (never added together),
 *     others  [{ currency, count }] rows in other currencies, most first (in no total),
 *   total, income: the month's default-currency figures (cashDue / incomeDue of those items),
 *   others:  the month's rows in other currencies, counted,
 *   count:   rows in the month, undated: undated recurring items (plans A–Z, then income A–Z),
 * }
 * `amount` is dueInMonth() for an expense and incomeInMonth() for income: insights-calc's figures.
 */
export function occurrences(items, year, month, { currency = 'TWD' } = {}) {
  const live = (items ?? []).filter(isLive);
  const n = daysInMonth(year, month);
  const lists = Array.from({ length: n }, () => []);
  for (const s of live) {
    const income = isIncome(s);
    for (const day of stepDays(s, year, month)) {
      const amount = income ? incomeInMonth(s, year, month) : dueInMonth(s, year, month);
      lists[day - 1].push({ item: s, amount, currency: s.currency, income, group: income ? null : groupOf(s) });
    }
  }
  const sum = (rows, inc) => rows.reduce((t, r) => t + (r.currency === currency && r.income === inc ? r.amount : 0), 0);
  const days = lists.map((rows, i) => {
    rows.sort((a, b) => a.income - b.income || byName(a, b));
    return { day: i + 1, rows, total: sum(rows, false), income: sum(rows, true), others: countOthers(rows, currency), count: rows.length };
  });
  const all = days.flatMap((d) => d.rows);
  return {
    year, month, days,
    total: days.reduce((t, d) => t + d.total, 0),
    income: days.reduce((t, d) => t + d.income, 0),
    others: countOthers(all, currency),
    count: all.length,
    undated: undatedItems(live),
  };
}

/** Up to `max` dots for a day, then how many more ("+N"): { dots: rows, more }. */
export function dayDots(rows, max = 3) {
  return { dots: rows.slice(0, max), more: Math.max(0, rows.length - max) };
}

/* Keyboard -------------------------------------------------------------------------------------- */
/**
 * Where a key moves the focused day: { year, month, day } or null for keys it doesn't use.
 * Arrows by a day or a week, Home / End to the week's first / last day (by `weekStart`), Page Up /
 * Page Down by a month (clamped to the shorter month's last day). Local dates throughout.
 */
export function moveDay({ year, month, day }, key, weekStart = 1) {
  const at = (d) => ({ year: d.getFullYear(), month: d.getMonth(), day: d.getDate() });
  const shift = (n) => at(new Date(year, month, day + n));
  const col = (new Date(year, month, day).getDay() - weekStart + 7) % 7;
  switch (key) {
    case 'ArrowLeft': return shift(-1);
    case 'ArrowRight': return shift(1);
    case 'ArrowUp': return shift(-7);
    case 'ArrowDown': return shift(7);
    case 'Home': return shift(-col);
    case 'End': return shift(6 - col);
    case 'PageUp':
    case 'PageDown': {
      const m = addMonths(year, month, key === 'PageUp' ? -1 : 1);
      return { ...m, day: Math.min(day, daysInMonth(m.year, m.month)) };
    }
    default: return null;
  }
}
