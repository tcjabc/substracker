// Pure maths for the Insights year chart (js/year-chart.js): the circular month carousel, the
// cosine taper, springs and fling, the y scale, the months shown and the per-month data. No DOM,
// so it runs in the Node tests. Money figures come from js/insights-calc.js only (monthSeries,
// breakdown, seriesAverage, overIncome); nothing here calculates an amount a second way.
//
// Geometry is in SVG user units of a 360 × 470 viewBox.

import { breakdown, monthSeries, seriesAverage, overIncome } from './insights-calc.js';

export const GEOM = Object.freeze({
  W: 360, H: 470, CX: 180,
  EXT: 158, WMAX: 32, WMIN: 8, GAP: 3, // the taper: half-extent, widest and narrowest bar, gap
  DRAG: 30,                              // drag distance (units) per month
  BASE: 340, BAR_H: 250,                 // carousel baseline and the height of the scale's top
  LABEL_Y: 358, YEAR_Y: 369,             // month and 'YY labels under the bars
  MINI_BASE: 432, MINI_SCALE: 0.15, MINI_LEFT: 16, MINI_SPAN: 328, MINI_LABEL_Y: 450, MINI_YEAR_Y: 461,
  FOCUS_X: 28, FOCUS_W: 100, FOCUS_BASE: 350, FOCUS_H: 240,
});

export const FLING_FRICTION = 3;  // v *= exp(-3 dt)
export const FLING_STOP = 1.1;    // months/s: below this the fling hands over to the snap spring
export const SNAP_OMEGA = 10;
export const FOCUS_OMEGA = 14;    // the selected bar's morph spring
export const REDUCED_OMEGA = 70;  // every spring under prefers-reduced-motion
export const MAX_VELOCITY = 14;

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (t) => t * t * (3 - 2 * t);

/* Carousel ---------------------------------------------------------------- */

/** Where bar `i` sits relative to the float position `pos` on a loop of `n`: in [-n/2, n/2). */
export function wrapRel(i, pos, n) {
  return ((((i - pos + n / 2) % n) + n) % n) - n / 2;
}

/** The index of the month at the centre: round(pos), wrapped into 0 … n-1. */
export function centreIndex(pos, n) {
  return ((Math.round(pos) % n) + n) % n;
}

/** The position to move to so that month `i` is centred, by the shorter way round the loop. */
export function nearestPos(pos, i, n) {
  return pos + wrapRel(i, pos, n);
}

/**
 * The taper for a loop of `n` months: width(a) = WMIN + (WMAX − WMIN)(1 + cos(π·min(a, R)/R))/2
 * with R = n/2, and x(r) its integral (plus the gap), both scaled so that x(R) = EXT and the
 * whole loop fits. `a` and `r` are distances from the centre in months.
 */
export function taper(n, g = GEOM) {
  const R = n / 2;
  const w = (a) => g.WMIN + ((g.WMAX - g.WMIN) * (1 + Math.cos((Math.PI * Math.min(Math.abs(a), R)) / R))) / 2;
  const raw = (r) => {
    const a = Math.min(Math.abs(r), R);
    const s = r < 0 ? -1 : 1;
    return s * ((g.WMIN + g.GAP) * a + ((g.WMAX - g.WMIN) / 2) * (a + (R / Math.PI) * Math.sin((Math.PI * a) / R)));
  };
  const scale = g.EXT / raw(R);
  return {
    R, scale,
    width: (a) => w(a) * scale,
    x: (r) => raw(r) * scale,
    /** Room for one month at distance a: its width plus the gap. */
    spacing: (a) => (w(a) + g.GAP) * scale,
  };
}

/** Bars fade from full opacity at the centre to 0.55 at the far edge. */
export const edgeOpacity = (a, R) => lerp(1, 0.55, clamp(a / R, 0, 1));

/** How prominent a bar is: 1 at the centre, easing to 0 one month away. */
export const prominence = (a) => smooth(clamp(1 - a, 0, 1));

/** Month label: three letters, or two when there's less than 24 units of room (carousel only). */
export function monthLabel(short, spacing, focusMix = 0) {
  return focusMix < 0.5 && spacing < 24 ? short.slice(0, 2) : short;
}

/** Label size: 7.8 at the edges to 9.5, 11.5 at the centre; 9.5 in the mini strip. */
export function labelSize(a, R, focusMix, prom) {
  const base = lerp(lerp(7.8, 9.5, 1 - clamp(a / R, 0, 1)), 9.5, focusMix);
  return lerp(base, 11.5, prom * (1 - focusMix));
}

/* Springs and fling --------------------------------------------------------- */

/** A critically damped spring { x, v, t, w }: advance it by dt seconds (in 3 sub-steps). */
export function springStep(sp, dt) {
  const h = dt / 3;
  for (let k = 0; k < 3; k++) {
    const a = sp.w * sp.w * (sp.t - sp.x) - 2 * sp.w * sp.v;
    sp.v += a * h;
    sp.x += sp.v * h;
  }
  return sp;
}

/** True (and snaps it exactly onto its target) once a spring has come to rest. */
export function springSettle(sp, eps = 5e-4) {
  if (Math.abs(sp.t - sp.x) < eps && Math.abs(sp.v) < eps * 10) {
    sp.x = sp.t;
    sp.v = 0;
    return true;
  }
  return false;
}

/** Fling velocity after dt seconds of friction. */
export const flingStep = (v, dt) => v * Math.exp(-FLING_FRICTION * dt);

/** Exponential moving average of the drag velocity, in months per second. */
export const dragVelocity = (prev, dpos, dtMs) => 0.7 * prev + 0.3 * ((dpos / Math.max(1, dtMs)) * 1000);

/** The fling speed on release: none after a pause (> 90 ms) or with reduced motion, else capped. */
export function releaseVelocity(v, idleMs, reduced = false) {
  return reduced || idleMs > 90 ? 0 : clamp(v, -MAX_VELOCITY, MAX_VELOCITY);
}

/** Staggered spring speed for bars as focus opens: 17 next to the selected bar down to 8. */
export const staggerOmega = (distance, near = 17, far = 8) => lerp(near, far, Math.min(Math.abs(distance), 8) / 8);

/* Y scale ------------------------------------------------------------------- */

const NICE = [1, 2, 2.5, 5, 10];
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return NICE.find((f) => f * p >= raw - 1e-9) * p;
}

/**
 * A nice top for the y axis: the smallest of step × ticks (ticks 3, 4 or 5, step 1, 2, 2.5 or 5 × 10^k)
 * that holds `max`. { max: 0, step: 0, ticks: 0 } when there's nothing to show.
 */
export function niceScale(max) {
  if (!(max > 0)) return { max: 0, step: 0, ticks: 0 };
  let best = null;
  for (const ticks of [3, 4, 5]) {
    const step = niceStep(max / ticks);
    const top = step * ticks;
    if (!best || top < best.max - 1e-9) best = { max: top, step, ticks };
  }
  return best;
}

/* Months and data ----------------------------------------------------------- */

/**
 * The months the chart shows, from the real current month `now`: 'year' is its calendar year
 * (12 months), 'roll' the 13 months from six before to six after it.
 */
export function rangeMonths(kind, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const out = [];
  const from = kind === 'year' ? y * 12 : y * 12 + m - 6;
  const count = kind === 'year' ? 12 : 13;
  for (let k = 0; k < count; k++) out.push({ y: Math.floor((from + k) / 12), m: (from + k) % 12 });
  return out;
}

/** Index of the real current month in `months`, or -1. */
export function nowIndex(months, now = new Date()) {
  return months.findIndex((x) => x.y === now.getFullYear() && x.m === now.getMonth());
}

export const TYPE_NAMES = Object.freeze({ monthly: 'Monthly plans', annual: 'Annual renewals', once: 'One-offs' });

/**
 * Per-month data for `months` (consecutive) from one currency's items: totals and income from
 * monthSeries, the stacks from breakdown. { months: [{ y, m, total, income, over, byType,
 * byCategory }], average } where `over` is overIncome(total, income) and `average` the mean of
 * the months' totals (seriesAverage), shown as "Average of these months".
 */
export function chartMonths(items, months) {
  if (!months.length) return { months: [], average: 0 };
  const series = monthSeries(items, months[0].y, months[0].m, months.length, { income: true });
  const out = series.map((s) => {
    const b = breakdown(items, s.year, s.month);
    return {
      y: s.year, m: s.month, total: s.total, income: s.income, over: overIncome(s.total, s.income),
      byType: b.byType, byCategory: b.byCategory,
    };
  });
  return { months: out, average: seriesAverage(series) };
}

/**
 * How a month compares with the average: 'about' within 2% of it (or both zero), else 'above' or
 * 'below' with the difference.
 */
export function monthDelta(total, average) {
  const diff = total - average;
  const margin = Math.abs(average) * 0.02;
  if (Math.abs(diff) <= margin || (!average && !total)) return { kind: 'about', amount: 0 };
  return { kind: diff > 0 ? 'above' : 'below', amount: Math.abs(diff) };
}

/** Names as one line, cut at `max` characters with an ellipsis. */
export function listNames(names, max = 34) {
  const s = names.join(', ');
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Above-average marker: more than 10% over the average of these months. */
export const aboveAverage = (total, average) => average > 0 && total > average * 1.1;
