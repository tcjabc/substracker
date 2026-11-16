// Insights figures on a cash basis: what falls due (outgoings) or is paid in (income) in a given
// month. Pure functions (no DOM, no storage), shared by the app and the Node tests.
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
// Income follows the same rules, with its date in the same stored field (nextRenewal, shown as
// "Next payment"; a one-off's in `date`): incomeDue() and undatedIncome(). Income and outgoings
// are always kept apart; nothing here adds one to the other.
//
// Only live items count. Callers pass the items of one currency, as the Insights screen does:
// amounts are never converted between currencies.

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
const isIncoming = (s) => isLive(s) && isIncome(s);
const typeOf = (s) => (isOnce(s) ? 'once' : s.cycle === 'annual' ? 'annual' : 'monthly');
const price = (s) => (Number.isFinite(s.price) ? s.price : 0);

/** A recurring item with no usable date (not counted in month totals). */
const noDate = (s) => !isOnce(s) && !parseDate(s.nextRenewal);
const isUndated = (s) => isOutgoing(s) && noDate(s);

/** The cash an item moves in `month` (0-based) of `year`, whatever its type; 0 when none. */
function cashInMonth(s, year, month) {
  if (isOnce(s)) {
    const d = parseDate(s.date);
    return d && d.getFullYear() === year && d.getMonth() === month ? price(s) : 0;
  }
  const d = parseDate(s.nextRenewal);
  if (!d) return 0; // undated: see undatedRecurring() / undatedIncome()
  if (s.cycle === 'annual') return d.getMonth() === month ? price(s) : 0;
  return price(s);
}

/** What `s` costs in `month` (0-based) of `year` on a cash basis; 0 when nothing is due or it's income. */
export function dueInMonth(s, year, month) {
  return isOutgoing(s) ? cashInMonth(s, year, month) : 0;
}

/** What income item `s` pays in `month` (0-based) of `year`; 0 when nothing or it's an outgoing. */
export function incomeInMonth(s, year, month) {
  return isIncoming(s) ? cashInMonth(s, year, month) : 0;
}

/** Total income paid in `month` (0-based) of `year`, same rules as cashDue. */
export function incomeDue(items, year, month) {
  return items.reduce((t, s) => t + incomeInMonth(s, year, month), 0);
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

/**
 * `count` consecutive months from startMonth (0-based) of startYear: [{ year, month, total }],
 * `total` being the cash due. With `{ income: true }` each month also has `income` (incomeDue).
 */
export function monthSeries(items, startYear, startMonth, count, { income = false } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(startYear, startMonth + i, 1);
    const [y, m] = [d.getFullYear(), d.getMonth()];
    out.push(income ? { year: y, month: m, total: cashDue(items, y, m), income: incomeDue(items, y, m) }
      : { year: y, month: m, total: cashDue(items, y, m) });
  }
  return out;
}

/** Income for calendar `year`: the sum of its twelve cash months (undated income isn't in it). */
export function yearIncome(items, year) {
  let t = 0;
  for (let m = 0; m < 12; m++) t += incomeDue(items, year, m);
  return t;
}

/**
 * Calendar `year` from its twelve cash months: { income, outgoings, leftOver, monthsOver }.
 * income is yearIncome(), outgoings the sum of the months' cash due (equal to yearTotal() when
 * every plan has a date), leftOver income − outgoings, and monthsOver the number of months whose
 * cash due is more than that month's income. Undated items are in none of these.
 */
export function yearSummary(items, year) {
  let income = 0;
  let outgoings = 0;
  let monthsOver = 0;
  for (let m = 0; m < 12; m++) {
    const i = incomeDue(items, year, m);
    const o = cashDue(items, year, m);
    income += i;
    outgoings += o;
    if (o > i) monthsOver++;
  }
  return { income, outgoings, leftOver: income - outgoings, monthsOver };
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

const byItemName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Recurring outgoings with no renewal date: not in any month total. Sorted A–Z by name. */
export function undatedRecurring(items) {
  return items.filter(isUndated).sort(byItemName);
}

/** Recurring income with no payment date: not in any month's income. Sorted A–Z by name. */
export function undatedIncome(items) {
  return items.filter((s) => isIncoming(s) && noDate(s)).sort(byItemName);
}

/** Every recurring item without a date: the undated plans (A–Z), then the undated income (A–Z). */
export function undatedItems(items) {
  return [...undatedRecurring(items), ...undatedIncome(items)];
}

/**
 * The Money tab summary strip, on the same cash basis as Insights. 'monthly': the income paid and
 * cash due in `month` (0-based) of `year`, their difference, and `average`, the Avg figure
 * (monthlyAverage: the yearly total ÷ 12). 'annual': yearSummary() for `year` (no average).
 * Undated items are in none of the figures; see undatedItems().
 */
export function stripSummary(items, period, year, month) {
  if (period === 'annual') {
    const { income, outgoings, leftOver } = yearSummary(items, year);
    return { income, outgoings, leftOver };
  }
  const income = incomeDue(items, year, month);
  const outgoings = cashDue(items, year, month);
  return { income, outgoings, leftOver: income - outgoings, average: monthlyAverage(items, year) };
}
