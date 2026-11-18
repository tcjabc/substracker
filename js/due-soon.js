// The due-soon banner on the Money tab: which dated items come due in the next N days. Pure (no
// DOM, no storage), shared by the app and tests/due-soon.node.test.js.
//
// - Recurring items use the display-time next date (util.nextRenewal): a stored date that has
//   passed rolls forward for display only, so nothing is rewritten and no sync op is made.
// - A one-off counts when its date is today or later and inside the window.
// - The window is day 0 (today) to day N, both included, counted in the device's local calendar
//   days (local midnights compared as calendar dates, so a DST change can't move "Tomorrow").
// - Expenses always; recurring income (its "Next payment") only when includeIncome is on.
// - Undated recurring items are never in the window; they're counted for the "need a date" line.
// - The total is the default currency's listed expenses, summed from the rows' own amounts.
//   Income in the window has its own figure; other currencies are only counted ("+1 in USD").
//   Amounts in different currencies, or income and expenses, are never added together.

import { isIncome, isOnce, parseDate, nextRenewal, dayStamp } from './util.js';
import { undatedRecurring, undatedIncome } from './insights-calc.js';

/** The windows Settings offers, in days; 7 is the default. */
export const WINDOWS = Object.freeze([3, 7, 14]);
export const DEFAULT_WINDOW = 7;
/** The window from the saved preference ('3', '7' or '14'), else 7. */
export const windowFrom = (pref) => (WINDOWS.includes(Number(pref)) ? Number(pref) : DEFAULT_WINDOW);
/** Show the banner unless it was turned off ('off'); include income only when turned on ('on'). */
export const bannerOnFrom = (pref) => pref !== 'off';
export const includeIncomeFrom = (pref) => pref === 'on';

/** A date's local calendar day as a whole number, so two days subtract exactly (no DST hours). */
const dayNumber = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
/** Whole local calendar days from `from` to `to` (0 the same day, 1 the next, -1 the day before). */
export const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

const isLive = (s) => s && s.del !== true && s.deleted !== true;
const byDateThenName = (a, b) => a.days - b.days
  || String(a.item.name ?? '').localeCompare(String(b.item.name ?? ''), undefined, { sensitivity: 'base' });

/** The item's next date on or after today (display time), or null when it has none. */
function nextDate(s, now) {
  if (isOnce(s)) {
    const d = parseDate(s.date);
    return d && daysBetween(now, d) >= 0 ? d : null;
  }
  return nextRenewal(s, now);
}

/**
 * What comes due from today to `windowDays` days ahead.
 * Returns {
 *   rows: [{ item, date, days, amount, currency, income }]  sorted by date, then name (today first),
 *   total:        the default currency's expenses in rows (0 when none),
 *   incomeTotal:  the default currency's income in rows (only with includeIncome),
 *   count:        rows.length,
 *   others:       [{ currency, count }] rows in other currencies, most first (not in any total),
 *   undated:      undated recurring items (expenses; income too with includeIncome), A–Z,
 *   windowDays,
 * }
 */
export function dueSoon(items, now = new Date(), { windowDays = DEFAULT_WINDOW, includeIncome = false, currency = 'TWD' } = {}) {
  const days = windowFrom(windowDays);
  const live = (items ?? []).filter(isLive);
  const rows = [];
  for (const s of live) {
    if (isIncome(s) && (!includeIncome || isOnce(s))) continue; // income: recurring only, and only when asked
    const date = nextDate(s, now);
    if (!date) continue;
    const n = daysBetween(now, date);
    if (n < 0 || n > days) continue;
    rows.push({ item: s, date, days: n, amount: Number.isFinite(s.price) ? s.price : 0, currency: s.currency, income: isIncome(s) });
  }
  rows.sort(byDateThenName);
  const mine = rows.filter((r) => r.currency === currency);
  const sum = (list) => list.reduce((a, r) => a + r.amount, 0);
  const counts = new Map();
  for (const r of rows) if (r.currency !== currency) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  const undated = [...undatedRecurring(live), ...(includeIncome ? undatedIncome(live) : [])];
  return {
    rows,
    count: rows.length,
    total: sum(mine.filter((r) => !r.income)),
    incomeTotal: sum(mine.filter((r) => r.income)),
    hasIncome: mine.some((r) => r.income),
    others: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([cur, count]) => ({ currency: cur, count })),
    undated,
    windowDays: days,
  };
}

/** The value saved when the banner is closed: today's local date (YYYY-MM-DD). */
export const dismissKey = (now = new Date()) => dayStamp(now);
/** Whether a saved dismissal still hides the banner: only on the same local day. */
export const isDismissed = (saved, now = new Date()) => !!saved && saved === dismissKey(now);
