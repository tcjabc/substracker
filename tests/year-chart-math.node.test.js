// Node tests for js/year-chart-math.js: the wrap, the taper's widths and positions, snapping and
// rounding, springs and fling, the y axis nice max, the months shown (rolling anchored on the real
// current month, wrapping across a year boundary) and the per-month data. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOM, wrapRel, centreIndex, nearestPos, taper, edgeOpacity, prominence, monthLabel, labelSize,
  springStep, springSettle, flingStep, dragVelocity, releaseVelocity, staggerOmega, niceScale,
  rangeMonths, nowIndex, chartMonths, monthDelta, listNames, aboveAverage, FLING_STOP, SNAP_OMEGA,
  REDUCED_OMEGA,
} from '../js/year-chart-math.js';
import { cashDue, incomeDue, yearSummary } from '../js/insights-calc.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('wrap: every bar sits in [-n/2, n/2) around the position, across the loop seam', () => {
  assert.equal(wrapRel(0, 11, 12), 1, 'January is one after December');
  assert.equal(wrapRel(11, 0, 12), -1, 'December is one before January');
  assert.equal(wrapRel(6, 0, 12), -6, 'the far side is -n/2, never +n/2');
  assert.equal(wrapRel(5, 0, 12), 5);
  assert.ok(near(wrapRel(0, 11.75, 12), 0.25));
  assert.ok(near(wrapRel(3, -0.5, 13), 3.5), 'odd n, negative position');
  for (const n of [12, 13]) {
    for (let p = -30; p <= 30; p += 0.37) {
      for (let i = 0; i < n; i++) {
        const r = wrapRel(i, p, n);
        assert.ok(r >= -n / 2 - 1e-9 && r < n / 2, `n=${n} p=${p} i=${i} r=${r}`);
      }
    }
  }
});

test('snapping: the centre is round(pos) wrapped, and moves go the short way round', () => {
  assert.equal(centreIndex(11.6, 12), 0);
  assert.equal(centreIndex(-0.6, 12), 11);
  assert.equal(centreIndex(5.49, 12), 5);
  assert.equal(centreIndex(25, 13), 12);
  assert.equal(nearestPos(11.6, 0, 12), 12, 'from late December forward to January');
  assert.ok(near(nearestPos(0.3, 11, 12), -1), 'from January back to December');
  assert.equal(nearestPos(5.4, 0, 12), 0);
  assert.equal(Math.round(2.5), 3, 'half rounds up');
});

test('taper: thickest at the centre, WMIN at the edge, the loop spans ±EXT', () => {
  for (const n of [12, 13]) {
    const t = taper(n);
    assert.equal(t.R, n / 2);
    assert.ok(near(t.x(0), 0));
    assert.ok(near(t.x(t.R), GEOM.EXT), `x(R) = ${t.x(t.R)}`);
    assert.ok(near(t.x(-t.R), -GEOM.EXT));
    assert.ok(near(t.x(t.R + 3), GEOM.EXT), 'clamped beyond R');
    assert.ok(near(t.width(0) / t.width(t.R), GEOM.WMAX / GEOM.WMIN), 'width ratio 32 : 8');
    assert.ok(near(t.width(0), GEOM.WMAX * t.scale));
    let prev = -Infinity;
    for (let r = -t.R; r <= t.R; r += 0.25) {
      assert.ok(t.x(r) > prev, 'x increases');
      prev = t.x(r);
      assert.ok(near(t.x(-r), -t.x(r)), 'symmetric');
    }
    for (let a = 0; a < t.R; a += 0.5) assert.ok(t.width(a) >= t.width(a + 0.5) - 1e-9, 'width shrinks outwards');
    // Spacing between neighbours averages the width plus gap over the step.
    const step = t.x(1) - t.x(0);
    assert.ok(step < t.spacing(0) && step > t.spacing(1), `step ${step}`);
  }
  assert.ok(near(taper(12).scale, GEOM.EXT / 138), 'n = 12: unscaled half-extent 138');
});

test('plot: every bar stays inside the plot, clear of the y-axis gutter', () => {
  assert.ok(GEOM.AXIS_X < GEOM.PLOT_L, 'labels end before the plot starts');
  assert.equal(GEOM.CX, (GEOM.PLOT_L + GEOM.PLOT_R) / 2, 'centred in the plot');
  for (const n of [12, 13]) {
    const t = taper(n);
    for (let r = -t.R; r < t.R; r += 0.05) {
      const half = t.width(Math.abs(r)) / 2;
      const x = GEOM.CX + t.x(r);
      assert.ok(x - half >= GEOM.PLOT_L - 1e-9 && x + half <= GEOM.PLOT_R + 1e-9, `n=${n} r=${r}: ${x - half} … ${x + half}`);
    }
  }
});

test('edges fade to 0.55; the centre month is prominent; labels shrink and shorten', () => {
  assert.equal(edgeOpacity(0, 6), 1);
  assert.ok(near(edgeOpacity(6, 6), 0.55));
  assert.ok(near(edgeOpacity(9, 6), 0.55));
  assert.equal(prominence(0), 1);
  assert.equal(prominence(1), 0);
  assert.ok(prominence(0.5) > 0 && prominence(0.5) < 1);
  assert.equal(monthLabel('Mar', 23.9), 'Ma');
  assert.equal(monthLabel('Mar', 24), 'Mar');
  assert.equal(monthLabel('Mar', 10, 1), 'Mar', 'full label in the mini strip');
  assert.ok(near(labelSize(0, 6, 0, 1), 11.5), 'centre');
  assert.ok(near(labelSize(6, 6, 0, 0), 7.8), 'edge');
  assert.ok(near(labelSize(3, 6, 1, 0), 9.5), 'mini strip');
});

test('springs settle without overshoot; reduced motion is near-instant', () => {
  const sp = { x: 0, v: 0, t: 1, w: SNAP_OMEGA };
  let max = 0;
  let steps = 0;
  while (!springSettle(sp) && steps < 600) { springStep(sp, 1 / 60); max = Math.max(max, sp.x); steps++; }
  assert.equal(sp.x, 1);
  assert.ok(max <= 1 + 1e-3, `overshoot ${max}`);
  assert.ok(steps < 120, `settles within 2 s (${steps} frames)`);
  const fast = { x: 0, v: 0, t: 1, w: REDUCED_OMEGA };
  let n = 0;
  while (!springSettle(fast) && n < 60) {
    springStep(fast, 1 / 60);
    n++;
    if (n === 4) assert.ok(fast.x > 0.9, `reduced motion is over 90% there after 4 frames (${fast.x})`);
  }
  assert.ok(n <= 20, `reduced motion settles in ${n} frames`);
});

test('fling: friction exp(-3 dt) until under 1.1 months/s, about 3 months from 10/s', () => {
  let v = 10;
  let pos = 0;
  let t = 0;
  const dt = 1 / 120;
  while (Math.abs(v) >= FLING_STOP) { pos += v * dt; v = flingStep(v, dt); t += dt; }
  assert.ok(Math.abs(t - Math.log(10 / 1.1) / 3) < 0.02, `time ${t}`);
  assert.ok(Math.abs(pos - (10 - 1.1) / 3) < 0.05, `distance ${pos}`);
  assert.ok(near(dragVelocity(0, 1, 100), 3), '0.3 × 10 months/s');
  assert.equal(releaseVelocity(30, 10), 14, 'capped');
  assert.equal(releaseVelocity(5, 120), 0, 'a pause before release stops the fling');
  assert.equal(releaseVelocity(5, 10, true), 0, 'no inertia with reduced motion');
  assert.equal(staggerOmega(0), 17);
  assert.equal(staggerOmega(8), 8);
  assert.equal(staggerOmega(-12), 8);
  assert.ok(near(staggerOmega(4), 12.5));
});

test('y axis: the tightest nice max from the visible data', () => {
  assert.deepEqual(niceScale(40398), { max: 50000, step: 10000, ticks: 5 });
  assert.deepEqual(niceScale(60000), { max: 60000, step: 20000, ticks: 3 });
  assert.deepEqual(niceScale(1699), { max: 2000, step: 500, ticks: 4 });
  assert.deepEqual(niceScale(649), { max: 750, step: 250, ticks: 3 });
  assert.deepEqual(niceScale(0), { max: 0, step: 0, ticks: 0 });
  for (const v of [1, 7, 99, 101, 1234.5, 98765, 3e6]) {
    const s = niceScale(v);
    assert.ok(s.max >= v && s.max <= v * 2.5, `${v} → ${s.max}`);
    assert.ok(near(s.max, s.step * s.ticks));
  }
});

test('months: rolling is anchored on the real current month and wraps the year boundary', () => {
  const nov = new Date(2026, 10, 17);
  const roll = rangeMonths('roll', nov);
  assert.equal(roll.length, 13);
  assert.deepEqual(roll[0], { y: 2026, m: 4 });
  assert.deepEqual(roll[6], { y: 2026, m: 10 });
  assert.deepEqual(roll[12], { y: 2027, m: 4 });
  assert.deepEqual(roll.slice(7, 9), [{ y: 2026, m: 11 }, { y: 2027, m: 0 }], 'December then January');
  assert.equal(nowIndex(roll, nov), 6);
  const year = rangeMonths('year', nov);
  assert.deepEqual([year.length, year[0], year[11], nowIndex(year, nov)], [12, { y: 2026, m: 0 }, { y: 2026, m: 11 }, 10]);
  const jan = rangeMonths('roll', new Date(2027, 0, 3));
  assert.deepEqual([jan[0], jan[6], jan[12]], [{ y: 2026, m: 6 }, { y: 2027, m: 0 }, { y: 2027, m: 6 }]);
  // On the loop, the last month wraps to the first.
  assert.equal(wrapRel(0, 12, 13), 1);
  assert.equal(nowIndex(roll, new Date(2030, 0, 1)), -1);
});

const item = (over) => ({
  id: over.name, type: 'expense', name: '', price: 0, currency: 'TWD', cycle: 'monthly', nextRenewal: '', date: '', category: '', ...over,
});
const ITEMS = [
  item({ name: 'Rent', price: 1500, nextRenewal: '2026-01-01', category: 'Home' }),
  item({ name: 'Cover', price: 900, cycle: 'annual', nextRenewal: '2025-11-10', category: 'Home' }),
  item({ name: 'Flights', price: 4000, cycle: 'once', date: '2027-02-14', category: 'Travel' }),
  item({ name: 'Gym', price: 40, category: 'Health' }), // undated: in no month
  item({ name: 'Pay', type: 'income', price: 2000, nextRenewal: '2026-01-25' }),
  item({ name: 'Bonus', type: 'income', price: 1000, cycle: 'annual', nextRenewal: '2026-03-15' }),
];

test('per-month data comes from the calculation layer and agrees with it', () => {
  const months = rangeMonths('roll', new Date(2026, 10, 17));
  const { months: data, average } = chartMonths(ITEMS, months);
  assert.equal(data.length, 13);
  for (const d of data) {
    assert.equal(d.total, cashDue(ITEMS, d.y, d.m), 'same as the Insights month headline');
    assert.equal(d.income, incomeDue(ITEMS, d.y, d.m));
    assert.equal(d.byType.reduce((t, r) => t + r.amount, 0), d.total);
    assert.equal(d.byCategory.reduce((t, r) => t + r.amount, 0), d.total);
  }
  const nov = data[6];
  assert.deepEqual([nov.y, nov.m, nov.total, nov.over], [2026, 10, 2400, true], 'Cover renews: 2,400 out, 2,000 in');
  assert.deepEqual(nov.byType.map((t) => [t.key, t.amount]), [['monthly', 1500], ['annual', 900]]);
  const feb = data[9];
  assert.deepEqual([feb.y, feb.m, feb.total, feb.over], [2027, 1, 5500, true]);
  const mar = data[10];
  assert.deepEqual([mar.total, mar.income, mar.over], [1500, 3000, false], 'bonus month');
  // 13 months: 1,500 × 13 + 900 + 4,000 = 24,400 → average 1,876.92…
  assert.ok(near(average, 24400 / 13));
  // A calendar year's over months match yearSummary's monthsOver.
  const year = chartMonths(ITEMS, rangeMonths('year', new Date(2026, 5, 1))).months;
  assert.equal(year.filter((d) => d.over).length, yearSummary(ITEMS, 2026).monthsOver);
  assert.deepEqual(chartMonths(ITEMS, []), { months: [], average: 0 });
});

test('readout wording helpers: delta vs the average, names, the above-average marker', () => {
  assert.deepEqual(monthDelta(1000, 1000), { kind: 'about', amount: 0 });
  assert.deepEqual(monthDelta(1015, 1000), { kind: 'about', amount: 0 }, 'within 2%');
  assert.deepEqual(monthDelta(1500, 1000), { kind: 'above', amount: 500 });
  assert.deepEqual(monthDelta(400, 1000), { kind: 'below', amount: 600 });
  assert.deepEqual(monthDelta(0, 0), { kind: 'about', amount: 0 });
  assert.deepEqual(monthDelta(50, 0), { kind: 'above', amount: 50 });
  assert.equal(listNames(['Music', 'Phone']), 'Music, Phone');
  const long = listNames(['YouTube Premium', 'Amazon Prime', 'Loot Studios', 'NYT Games']);
  assert.ok(long.length <= 34 && long.endsWith('…') && !/[,\s]…$/.test(long), long);
  assert.equal(listNames(['Energy', 'Gym', 'Music', 'Phone', 'Rent', 'Video']), 'Energy, Gym, Music, Phone, Rent…');
  assert.equal(aboveAverage(1101, 1000), true);
  assert.equal(aboveAverage(1100, 1000), false);
  assert.equal(aboveAverage(5, 0), false);
});
