// Insights figures on a cash basis: what falls due in a given month. Pure functions (no DOM, no
// storage), shared by the app and the Node tests.
//
// The app doesn't record what was actually paid, so every month, past or future, is a projection
// from the plan dates:
// - a monthly plan is due every month;
// - an annual plan is due once a year, in the month of its renewal date. The stored date is the
//   date someone typed; the app rolls it forward for display (util.nextRenewal), and rolling an
//   annual date forward never changes its month, so the stored month is the renewal month;
// - a one-off is due only in the month of its date.
// Recurring plans without a renewal date can't be placed in a month: they're left out of these
// totals and listed by undatedRecurring() instead.
//
// Only outgoings count (income is left out), and only live items. Callers pass the items of one
// currency, as the Insights screen does: amounts are never converted between currencies.

import { isIncome, isOnce, parseDate, amountInYear } from './util.js';

export const UNCATEGORISED = 'Uncategorised';
export const TYPE_ORDER = ['monthly', 'annual', 'once'];

/** The group an expense is shown under: its category, or "Uncategorised". */
export const groupOf = (s) => s.category?.trim() || UNCATEGORISED;

/** Group display order: A–Z, with Uncategorised last. */
export const byGroupName = (a, b) =>
  (a === UNCATEGORISED) - (b === UNCATEGORISED) || a.localeCompare(b, undefined, { sensitivity: 'base' });

// A deleted record never reaches the app as an item (storage.getAll drops tombstones); this also
// skips any copy that still carries the deleted flag.
const isLive = (s) => s && s.del !== true && s.deleted !== true;
const isOutgoing = (s) => isLive(s) && !isIncome(s);
const typeOf = (s) => (isOnce(s) ? 'once' : s.cycle === 'annual' ? 'annual' : 'monthly');
const price = (s) => (Number.isFinite(s.price) ? s.price : 0);

/** A recurring outgoing with no usable renewal date (not counted in month totals). */
const isUndated = (s) => isOutgoing(s) && !isOnce(s) && !parseDate(s.nextRenewal);

/** What `s` costs in `month` (0-based) of `year` on a cash basis; 0 when nothing is due. */
export function dueInMonth(s, year, month) {
  if (!isOutgoing(s)) return 0;
  if (isOnce(s)) {
    const d = parseDate(s.date);
    return d && d.getFullYear() === year && d.getMonth() === month ? price(s) : 0;
  }
  const d = parseDate(s.nextRenewal);
  if (!d) return 0; // undated: see undatedRecurring()
  if (s.cycle === 'annual') return d.getMonth() === month ? price(s) : 0;
  return price(s);
}

/** Total cash due in `month` (0-based) of `year`. */
export function cashDue(items, year, month) {
  return items.reduce((t, s) => t + dueInMonth(s, year, month), 0);
}

/**
 * The month's total, split by plan type and by category. Only non-zero rows are returned.
 * byType is in the order monthly, annual, once; names are A–Z. byCategory is largest first, ties
 * in group order (A–Z, Uncategorised last); its items are largest first, ties A–Z by name.
 */
export function breakdown(items, year, month) {
  const due = items.map((s) => ({ s, amount: dueInMonth(s, year, month) })).filter((d) => d.amount > 0);
  const byName = (a, b) => a.s.name.localeCompare(b.s.name, undefined, { sensitivity: 'base' });

  const byType = TYPE_ORDER.map((key) => {
    const rows = due.filter((d) => typeOf(d.s) === key).sort(byName);
    return { key, amount: rows.reduce((t, d) => t + d.amount, 0), names: rows.map((d) => d.s.name) };
  }).filter((t) => t.amount > 0);

  const groups = new Map();
  for (const d of due) {
    const g = groupOf(d.s);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(d);
  }
  const byCategory = [...groups].map(([group, rows]) => ({
    group,
    amount: rows.reduce((t, d) => t + d.amount, 0),
    items: rows.sort((a, b) => b.amount - a.amount || byName(a, b)).map((d) => ({ ...d.s, due: d.amount })),
  })).sort((a, b) => b.amount - a.amount || byGroupName(a.group, b.group));

  return { total: due.reduce((t, d) => t + d.amount, 0), byType, byCategory };
}

/** `count` consecutive months from startMonth (0-based) of startYear: [{ year, month, total }]. */
export function monthSeries(items, startYear, startMonth, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(startYear, startMonth + i, 1);
    out.push({ year: d.getFullYear(), month: d.getMonth(), total: cashDue(items, d.getFullYear(), d.getMonth()) });
  }
  return out;
}

/** The yearly card's figure: monthly × 12 + annual + one-offs dated in `year` (outgoings only). */
export function yearTotal(items, year) {
  return items.filter(isOutgoing).reduce((t, s) => t + amountInYear(s, year), 0);
}

/**
 * The "Avg" per-month figure: the yearly card's total for `year` ÷ 12, so the month and year
 * figures agree. When every recurring plan has a date, it equals the mean of the twelve cashDue
 * months of that year. Undated plans are in the yearly total but in no month, so then it's higher.
 */
export function monthlyAverage(items, year) {
  return yearTotal(items, year) / 12;
}

/** Mean of a monthSeries() result (0 for an empty series). */
export function seriesAverage(series) {
  return series.length ? series.reduce((t, m) => t + m.total, 0) / series.length : 0;
}

/** Recurring outgoings with no renewal date: not in any month total. Sorted A–Z by name. */
export function undatedRecurring(items) {
  return items.filter(isUndated).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
