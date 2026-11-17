// Node tests for js/donut-math.js (the Insights Ring's slice angles, lift weights, colours and spin
// physics), the slices it is fed from real month data (insights-calc.js → donut-flat.js), and the
// "Reduce motion and effects" rule in util.js. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TAU, RING, MOTION, wrapPi, bell, sliceAngles, frontIndex, targetFor, sliceWeights, sliceColour,
  stepMotion, releaseVelocity, release, isTap,
} from '../js/donut-math.js';
import { breakdown } from '../js/insights-calc.js';
import { donutSlices } from '../js/donut-flat.js';
import { reduceMotionFrom, catViewFrom } from '../js/util.js';

const DEG = Math.PI / 180;
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// The prototype's sample month: one 60% slice, mid-size and small ones, and a 0.6% one.
const SAMPLE = [16000, 3420, 2350, 1350, 1298, 1170, 640, 149];
const A = sliceAngles(SAMPLE);
const centred = (i) => -A[i].mid; // the rotation that puts slice i's centre at the front

test('slice angles fill the ring, in order, proportional to the values', () => {
  close(A.at(-1).a1, TAU, 1e-9, 'last slice ends at 2π');
  A.forEach((g, i) => {
    if (i) close(g.a0, A[i - 1].a1, 1e-12, `slice ${i} starts where ${i - 1} ends`);
    close(g.mid, (g.a0 + g.a1) / 2, 1e-12, 'mid');
  });
  // Slices drawn at their true share keep their relative sizes.
  close(A[0].span / A[1].span, SAMPLE[0] / SAMPLE[1], 1e-9, 'big slices stay proportional');
});

test('a tiny slice is drawn at the minimum angle; the text keeps the true value', () => {
  assert.ok(SAMPLE[7] / SAMPLE.reduce((a, b) => a + b) * 360 < 3, 'the 0.6% slice would be under 3°');
  close(A[7].span, RING.minSlice, 1e-9, '0.6% slice drawn at 14°');
  close(A[6].span, RING.minSlice, 1e-9, '2.4% slice drawn at 14°');
  for (const g of A) assert.ok(g.span >= RING.minSlice - 1e-9, 'no slice under the minimum');
  // Many tiny slices can't all get 14°: then they share the ring equally.
  const many = sliceAngles(Array(40).fill(1));
  close(many[0].span, TAU / 40, 1e-9, '40 equal slices');
  assert.deepEqual(sliceAngles([]), []);
  close(sliceAngles([5])[0].span, TAU, 1e-12, 'a lone slice is the whole ring');
});

test('slices from real month data: breakdown → donutSlices → angles', () => {
  const item = (over) => ({
    id: over.name, type: 'expense', name: '', domain: '', emoji: '', plan: '', price: 0, currency: 'TWD',
    cycle: 'monthly', nextRenewal: '', date: '', category: '', notes: '', ...over,
  });
  const items = [
    item({ name: 'Music', price: 150, nextRenewal: '2026-02-10', category: 'Entertainment' }),
    item({ name: 'Phone', price: 499, nextRenewal: '2026-11-05', category: 'Utilities' }),
    item({ name: 'Domain', price: 360, cycle: 'annual', nextRenewal: '2026-12-01' }),
    item({ name: 'Concert', price: 2400, cycle: 'once', date: '2026-12-20', category: 'Entertainment' }),
    item({ name: 'Paper', price: 20, nextRenewal: '2026-12-03', category: 'Reading' }),
  ];
  const due = breakdown(items, 2026, 11); // December 2026
  const catList = due.byCategory.map((c) => ({ name: c.group, total: c.amount, count: c.items.length }));
  const slices = donutSlices(catList, due.total, (name) => `var(--test-${name})`);
  assert.deepEqual(slices.map((s) => [s.name, s.total]), [
    ['Entertainment', 2550], ['Utilities', 499], ['Uncategorised', 360], ['Reading', 20],
  ], 'largest first; one small category keeps its own slice');
  assert.equal(slices[0].swatch, 'var(--test-Entertainment)', 'colours come from the group colour function');
  const angles = sliceAngles(slices.map((s) => s.total));
  close(angles[3].span, RING.minSlice, 1e-9, 'the 0.6% Reading slice is drawn at 14°');
  close(angles[0].span / angles[1].span, 2550 / 499, 1e-9, 'others stay proportional');
  // Two small categories are pooled into "Other", as in the flat donut.
  const more = [...items, item({ name: 'Stamp', price: 30, nextRenewal: '2026-12-09', category: 'Post' })];
  const due2 = breakdown(more, 2026, 11);
  const s2 = donutSlices(due2.byCategory.map((c) => ({ name: c.group, total: c.amount, count: c.items.length })), due2.total, () => 'x');
  assert.equal(s2.at(-1).name, 'Other');
  assert.equal(s2.at(-1).total, 50);
});

test('the front slice and the shortest way to bring a slice to the front', () => {
  for (let i = 0; i < A.length; i++) {
    assert.equal(frontIndex(A, centred(i)), i, `slice ${i} centred is at the front`);
    assert.equal(frontIndex(A, centred(i) - 7 * TAU), i, 'whole turns make no difference');
  }
  for (const from of [0, 2.5, -9, 40]) {
    for (let i = 0; i < A.length; i++) {
      const t = targetFor(A, i, from);
      assert.ok(Math.abs(t - from) <= Math.PI + 1e-9, 'never more than half a turn');
      assert.equal(frontIndex(A, t), i);
    }
  }
});

test('weights: the selected slice is fully raised, small neighbours partly, the rest not', () => {
  for (let i = 0; i < A.length; i++) close(sliceWeights(A, centred(i))[i], 1, 1e-9, `slice ${i} centred`);
  const w = sliceWeights(A, centred(5)); // Streaming (4.4%) at the front
  close(w[4], bell(Math.abs(wrapPi(A[4].mid - A[5].mid)), RING.width), 1e-12, 'neighbour: bell of its centre distance');
  assert.ok(w[4] > 0.2 && w[4] < 0.5 && w[6] > 0.2 && w[6] < 0.5, 'both neighbours partly raised');
  assert.equal(w[0], 0, 'the big slice stays down');
  assert.equal(w[1], 0, 'far slices stay down');
});

test('weights: a big slice holds full lift across its middle, and stays down beside a centred small one', () => {
  const big = A[0];
  assert.ok(big.span >= RING.plateauMin, 'the 60% slice is "big"');
  // Anywhere in the middle 70% of its arc, it is fully raised.
  for (let k = 0; k <= 20; k++) {
    const f = big.mid + ((k / 20 - 0.5) * RING.plateauShare * big.span);
    close(sliceWeights(A, -f)[0], 1, 1e-9, `front point ${(f / DEG).toFixed(1)}°`);
  }
  // Centred on the 0.6% neighbour, the big slice is (almost) down: the fall-off ends 10° past its edge.
  assert.ok(sliceWeights(A, centred(7))[0] < 0.05, 'big slice beside a centred tiny one');
  assert.ok(sliceWeights(A, centred(1))[0] < 0.05, 'big slice beside a centred mid one');
  // Something is always raised while the front point crosses the big slice.
  let minPeak = 1;
  for (let f = big.a0; f < big.a1; f += 0.1 * DEG) minPeak = Math.min(minPeak, Math.max(...sliceWeights(A, -f)));
  assert.ok(minPeak >= 0.1, `lowest peak across the big slice is ${minPeak.toFixed(2)}`);
  close(RING.plateauOverrun * RING.width, 10 * DEG, 1e-12, 'the overrun is 10°');
});

test('continuity: no weight jumps between frames at 3 rad/s (no pop at slice edges)', () => {
  const step = 3 / 60; // 3 rad/s at 60 fps
  for (const values of [SAMPLE, [1, 1], [5, 1, 1, 1], [100, 1]]) {
    const angles = sliceAngles(values);
    let prev = sliceWeights(angles, 0);
    let maxStep = 0;
    for (let r = -step / 4; r > -TAU - step; r -= step / 4) {
      const w = sliceWeights(angles, r);
      w.forEach((x, i) => { maxStep = Math.max(maxStep, Math.abs(x - prev[i]) * 4); });
      prev = w;
    }
    assert.ok(maxStep < 0.25, `max change per frame ${maxStep.toFixed(3)} for ${values.length} slices`);
    if (values === SAMPLE) close(maxStep, 0.18, 0.02, 'the measured value for the sample month');
  }
  assert.deepEqual(sliceWeights(sliceAngles([7]), 1.234), [1], 'a lone slice is always raised');
});

test('dim and brighten: un-raised slices fade toward the card colour, raised ones glow', () => {
  const base = [0.6, 0.3, 0.1], surface = [1, 1, 1], glow = 0.07;
  const up = sliceColour(base, surface, 1, glow);
  assert.deepEqual(up.colour, base, 'a fully raised slice keeps its colour');
  up.emissive.forEach((e, i) => close(e, base[i] * (glow + 0.6 * RING.dim), 1e-12, 'glow'));
  const down = sliceColour(base, surface, 0, glow);
  assert.ok(down.colour.every((c, i) => c > base[i]), 'toward a light card');
  assert.deepEqual(down.emissive, [0, 0, 0], 'no glow when down');
  const dark = sliceColour(base, [0.01, 0.01, 0.01], 0, glow);
  assert.ok(dark.colour[0] < base[0], 'toward a dark card in the dark theme');
  assert.deepEqual(sliceColour(base, surface, 0, glow, 0).colour, base, 'dim 0 is off');
});

test('spin physics: a fling slows, then snaps exactly to a slice centre', () => {
  const m = { r: centred(0), v: 0, target: 0, phase: 'idle' };
  release(m, A, 12);
  assert.equal(m.phase, 'fling');
  let steps = 0;
  while (m.phase !== 'idle' && steps < 2000) { stepMotion(m, A, 1 / 60); steps++; }
  assert.equal(m.phase, 'idle', 'comes to rest');
  assert.ok(steps < 400, `rests within ${steps} frames`);
  const i = frontIndex(A, m.r);
  close(m.r, centred(i) + Math.round((m.r - centred(i)) / TAU) * TAU, 1e-9, 'rests on a slice centre');
  // A slow release snaps to the nearest slice.
  const s = { r: centred(2) + 0.02, v: 0, target: 0, phase: 'drag' };
  release(s, A, 0.5);
  assert.equal(s.phase, 'snap');
  assert.equal(frontIndex(A, s.target), 2);
  assert.equal(stepMotion({ r: 1, v: 0, target: 1, phase: 'idle' }, A, 1 / 60), false, 'idle does nothing');
});

test('release speed and taps', () => {
  assert.equal(releaseVelocity([{ t: 0, r: 0 }, { t: 50, r: 0.5 }], 60), 10);
  assert.equal(releaseVelocity([{ t: 0, r: 0 }, { t: 50, r: 0.5 }], 50 + MOTION.staleMs), 0, 'a pause before release: no fling');
  assert.equal(releaseVelocity([{ t: 0, r: 0 }, { t: 10, r: 5 }], 12), MOTION.maxSpeed, 'clamped');
  assert.equal(releaseVelocity([{ t: 0, r: 0 }], 5), 0);
  assert.ok(isTap(3, 2, 120));
  assert.ok(!isTap(5, 4, 120), 'moved too far');
  assert.ok(!isTap(0, 0, 500), 'held too long');
});

test('Reduce motion and effects: unset follows the system; a saved choice overrides it', () => {
  assert.equal(reduceMotionFrom(null, true), true, 'unset, system reduces → on');
  assert.equal(reduceMotionFrom(null, false), false, 'unset, system does not → off');
  assert.equal(reduceMotionFrom('', true), true, 'empty counts as unset');
  assert.equal(reduceMotionFrom('on', false), true);
  assert.equal(reduceMotionFrom('off', true), false);
});

test('By category view: the Ring unless Donut or List was saved', () => {
  assert.equal(catViewFrom(null), 'ring', 'nothing saved');
  assert.equal(catViewFrom('ring'), 'ring');
  assert.equal(catViewFrom('donut'), 'donut', 'a saved Donut is kept');
  assert.equal(catViewFrom('list'), 'list', 'a saved List is kept');
  assert.equal(catViewFrom('bogus'), 'ring');
});
