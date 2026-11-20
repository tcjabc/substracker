// 1.19.0's date rules, kept for one purpose: format 5's first-launch check (js/format-migration.js)
// compares them with the shared stepper (js/interval.js) on this device's own items before the step
// switches anything. Copied from 1.19.0 (commit 08bcdc4): util.js parseDate, addCycle, nextRenewal and
// amountInYear, calendar-math.js stepDays and daysInMonth, insights-calc.js cashInMonth. Pure (no DOM,
// no storage), and used by nothing else: never call these for what the app shows.
// tests/format-migration.node.test.js checks them against the frozen 1.19.0 modules in tests/.
// Release 2 (custom intervals) removes this file with the check.

const isIncome = (s) => s.type === 'income';
const isOnce = (s) => s.cycle === 'once';
const isLive = (s) => s && s.del !== true && s.deleted !== true;
const price = (s) => (Number.isFinite(s.price) ? s.price : 0);

/** 1.19.0's parseDate: a local Date (the Date constructor, so years 0–99 become 1900–1999). */
export function parseDate(str) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

function addCycle(date, cycle, originalDay) {
  const months = cycle === 'annual' ? 12 : 1;
  const y = date.getFullYear();
  const m = date.getMonth() + months;
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(originalDay, last));
}

/** 1.19.0's step limit in nextRenewal: an anchor further back than this many steps isn't rolled to today. */
export const LEGACY_GUARD = 1200;

/** 1.19.0's nextRenewal: the next date on or after `now`, by a walk of at most 1200 steps. */
export function nextRenewal(sub, now = new Date()) {
  if (isOnce(sub)) return null;
  const start = parseDate(sub.nextRenewal);
  if (!start) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let d = start;
  let guard = 0;
  while (d < today && guard++ < LEGACY_GUARD) d = addCycle(d, sub.cycle, start.getDate());
  return d;
}

/** 1.19.0's calendar stepDays: [] or [day] in `month` (0-based) of `year`. */
export function stepDays(s, year, month) {
  if (isOnce(s)) {
    const d = parseDate(s.date);
    return d && d.getFullYear() === year && d.getMonth() === month ? [d.getDate()] : [];
  }
  const start = parseDate(s.nextRenewal);
  if (!start) return [];
  if (s.cycle === 'annual' && start.getMonth() !== month) return [];
  const first = new Date(year, month, 1);
  if (first >= new Date(start.getFullYear(), start.getMonth(), 1)) {
    const d = nextRenewal(s, first);
    if (d && d.getFullYear() === year && d.getMonth() === month) return [d.getDate()];
  }
  return [Math.min(start.getDate(), daysInMonth(year, month))];
}

function cashInMonth(s, year, month) {
  if (isOnce(s)) {
    const d = parseDate(s.date);
    return d && d.getFullYear() === year && d.getMonth() === month ? price(s) : 0;
  }
  const d = parseDate(s.nextRenewal);
  if (!d) return 0;
  if (s.cycle === 'annual') return d.getMonth() === month ? price(s) : 0;
  return price(s);
}

/** 1.19.0's insights-calc dueInMonth. */
export const dueInMonth = (s, year, month) => (isLive(s) && !isIncome(s) ? cashInMonth(s, year, month) : 0);

/** 1.19.0's insights-calc incomeInMonth. */
export const incomeInMonth = (s, year, month) => (isLive(s) && isIncome(s) ? cashInMonth(s, year, month) : 0);

/** 1.19.0's util amountInYear (the yearly card adds it up over the outgoings). */
export function amountInYear(s, year) {
  if (!isOnce(s)) return s.cycle === 'annual' ? s.price : s.price * 12;
  const d = parseDate(s.date);
  return d && d.getFullYear() === year ? s.price : 0;
}
