// The shared stepper: the one place that works out on which days an item falls. Pure (no DOM, no
// storage), shared by the app and the Node tests.
//
// An interval is { every, unit }: every N days, weeks, months or years (unit 'day', 'week',
// 'month', 'year'), from an anchor day. The cycles items have today map to it with
// intervalOfCycle(): monthly is every 1 month, annual every 12 months, once has none. Nothing in
// the app makes the other units yet (custom intervals, docs/plan-intervals-groups.md).
//
// Rules:
// - Occurrences are anchor + k × interval for every whole k, before the anchor as well as after:
//   the anchor fixes the phase, it isn't a start.
// - Months and years clamp to the last day of a shorter month, always from the ANCHOR's day, so a
//   date on the 31st falls on 28 or 29 February and on the 31st again in March. A year is 12 months,
//   so 29 February falls on 28 February in other years. Days and weeks are whole calendar days
//   (a week is 7).
// - Days are plain { year, month, day }: month 0–11 as in JS dates, any year (years 0–99 are
//   those years, not 1900–1999). All arithmetic is on whole day numbers from the calendar fields,
//   never milliseconds or the Date constructor, so neither DST nor the time zone can move a day.
//   dayOf() and dateOf() convert from and to local Dates at the edge.
// - Stepping far is direct arithmetic, never a walk: an anchor a thousand years away costs the same
//   as one last month.

export const UNITS = Object.freeze(['day', 'week', 'month', 'year']);
export const MONTHLY = Object.freeze({ every: 1, unit: 'month' });
export const ANNUAL = Object.freeze({ every: 12, unit: 'month' });
/** The most occurrences between() returns, so a huge range can't build a huge list. */
export const MAX_RESULTS = 400;

/** The interval of an item's cycle: annual every 12 months, once none (null), anything else monthly. */
export const intervalOfCycle = (cycle) => (cycle === 'once' ? null : cycle === 'annual' ? ANNUAL : MONTHLY);

/** True for { every: a whole number of 1 or more, unit: one of UNITS }. */
export const isInterval = (v) => v !== null && typeof v === 'object'
  && Number.isSafeInteger(v.every) && v.every >= 1 && UNITS.includes(v.unit);

/* -------------------------------------------------------------------------- Calendar days */

const floorDiv = (a, b) => Math.floor(a / b);
const mod = (a, b) => a - b * Math.floor(a / b);

export const isLeapYear = (year) => (mod(year, 4) === 0 && mod(year, 100) !== 0) || mod(year, 400) === 0;

/** Days in `month` (0–11; others roll into the years either side) of `year`. */
export function daysInMonth(year, month) {
  const y = year + floorDiv(month, 12);
  const m = mod(month, 12);
  return m === 1 ? (isLeapYear(y) ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m];
}

/**
 * The day's number: 0 is 1 January 1970, and consecutive days differ by 1 (proleptic Gregorian
 * calendar, any year). A month or day out of range rolls over as the Date constructor would.
 */
export function dayNumber({ year, month, day }) {
  let y = year + floorDiv(month, 12);
  const m = mod(month, 12) + 1; // 1–12
  if (m <= 2) y -= 1;
  const era = floorDiv(y, 400);
  const yoe = y - era * 400;
  const doy = floorDiv(153 * ((m + 9) % 12) + 2, 5) + day - 1;
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The day with number `n` (see dayNumber). */
export function dayFromNumber(n) {
  const z = n + 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
  const mp = floorDiv(5 * doy + 2, 153);
  const day = doy - floorDiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9; // 1–12
  return { year: yoe + era * 400 + (m <= 2 ? 1 : 0), month: m - 1, day };
}

/** True for a real calendar day: whole numbers, month 0–11, day within the month. */
export const isDay = (d) => d !== null && typeof d === 'object'
  && Number.isSafeInteger(d.year) && Number.isInteger(d.month) && d.month >= 0 && d.month <= 11
  && Number.isInteger(d.day) && d.day >= 1 && d.day <= daysInMonth(d.year, d.month);

/** The real day that { year, month, day } rolls over to (31 April → 1 May). */
export const normalizeDay = (d) => dayFromNumber(dayNumber(d));

/** Negative if a is earlier, positive if later, 0 for the same day. */
export const compareDays = (a, b) => dayNumber(a) - dayNumber(b);

/** A local Date's calendar day. */
export const dayOf = (date) => ({ year: date.getFullYear(), month: date.getMonth(), day: date.getDate() });

/**
 * The local Date for a day, at the start of the day: what new Date(year, month, day) gives, except
 * that years 0–99 stay those years (the constructor would make them 1900–1999).
 */
export function dateOf({ year, month, day }) {
  if (year >= 0 && year <= 99) {
    const d = new Date(2000, 0, 1);
    d.setFullYear(year, month, day);
    return d;
  }
  return new Date(year, month, day);
}

/* -------------------------------------------------------------------------- Stepping */

function stepOf(interval) {
  if (!isInterval(interval)) throw new TypeError('Not an interval');
  const n = interval.every;
  switch (interval.unit) {
    case 'day': return { days: n };
    case 'week': return { days: 7 * n };
    case 'month': return { months: n };
    default: return { months: 12 * n };
  }
}

function checkAnchor(anchor) {
  if (!isDay(anchor)) throw new TypeError('The anchor must be a real calendar day');
}

const monthIndex = (d) => d.year * 12 + d.month;

/** Occurrence number `k` (any whole number; 0 is the anchor itself). */
export function occurrence(anchor, interval, k) {
  checkAnchor(anchor);
  if (!Number.isSafeInteger(k)) throw new TypeError('k must be a whole number');
  const s = stepOf(interval);
  if (s.days) return dayFromNumber(dayNumber(anchor) + k * s.days);
  const mi = monthIndex(anchor) + k * s.months;
  const year = floorDiv(mi, 12);
  const month = mi - year * 12;
  return { year, month, day: Math.min(anchor.day, daysInMonth(year, month)) };
}

/** The number k of the first occurrence on or after day `from` (negative if that's before the anchor). */
export function indexOnOrAfter(anchor, interval, from) {
  checkAnchor(anchor);
  const s = stepOf(interval);
  const f = dayNumber(from);
  if (!Number.isFinite(f)) throw new TypeError('Not a day');
  if (s.days) return Math.ceil((f - dayNumber(anchor)) / s.days);
  // Clamping never moves an occurrence out of its month, so start from the first one in or after
  // `from`'s month and take the next if it falls before `from` in that month.
  let k = Math.ceil((monthIndex(dayFromNumber(f)) - monthIndex(anchor)) / s.months);
  if (dayNumber(occurrence(anchor, interval, k)) < f) k += 1;
  return k;
}

/** The first occurrence on or after day `from`. */
export const nextOnOrAfter = (anchor, interval, from) => occurrence(anchor, interval, indexOnOrAfter(anchor, interval, from));

/** The last occurrence before day `before` (strictly earlier). */
export const previousBefore = (anchor, interval, before) => occurrence(anchor, interval, indexOnOrAfter(anchor, interval, before) - 1);

/** The occurrences from day `from` to day `to`, both included, earliest first; at most `limit` of them. */
export function between(anchor, interval, from, to, { limit = MAX_RESULTS } = {}) {
  const out = [];
  const end = dayNumber(to);
  if (!Number.isFinite(end)) throw new TypeError('Not a day');
  for (let k = indexOnOrAfter(anchor, interval, from); out.length < limit; k++) {
    const o = occurrence(anchor, interval, k);
    if (dayNumber(o) > end) break;
    out.push(o);
  }
  return out;
}

/** The occurrences in `month` (0–11) of `year`, earliest first. */
export function inMonth(anchor, interval, year, month) {
  const first = normalizeDay({ year, month, day: 1 });
  return between(anchor, interval, first, { ...first, day: daysInMonth(first.year, first.month) });
}

/** How many occurrences fall in `month` (0–11) of `year`: worked out directly, never listed. */
export function countInMonth(anchor, interval, year, month) {
  checkAnchor(anchor);
  const s = stepOf(interval);
  const first = normalizeDay({ year, month, day: 1 });
  if (s.months) return mod(monthIndex(first) - monthIndex(anchor), s.months) === 0 ? 1 : 0;
  const a = dayNumber(anchor);
  const lo = dayNumber(first);
  const hi = lo + daysInMonth(first.year, first.month) - 1;
  return Math.floor((hi - a) / s.days) - Math.ceil((lo - a) / s.days) + 1;
}
