// Node tests for the bottom-nav pill's motion (js/tab-pill.js): the springs are exact for any frame
// rate, never overshoot from rest, settle in roughly 250-350 ms, and stretch the pill on the way
// with the leading edge ahead, then return it to its resting width. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { springStep, edgeRates, edgeSettled, pillPath, PILL_SPRINGS } from '../js/tab-pill.js';

// Three tabs on a 412 px phone: each 137 px wide, the pill 76 px wide in the middle of each.
const pillAt = (i) => ({ left: 137 * i + 30.5, right: 137 * i + 106.5 });

test('a spring step is exact: one long step equals many short ones', () => {
  let [x, v] = [0, 0];
  for (let i = 0; i < 10; i++) [x, v] = springStep(x, v, 100, 30, 0.01);
  const [x1, v1] = springStep(0, 0, 100, 30, 0.1);
  assert.ok(Math.abs(x - x1) < 1e-9 && Math.abs(v - v1) < 1e-9, `${x} vs ${x1}`);
  assert.deepEqual(springStep(100, 0, 100, 30, 0.016), [100, 0], 'at rest on the target it stays');
});

test('the leading edge is the one on the side the pill moves towards', () => {
  assert.deepEqual(edgeRates(pillAt(0), pillAt(1)), { left: PILL_SPRINGS.trail, right: PILL_SPRINGS.lead });
  assert.deepEqual(edgeRates(pillAt(2), pillAt(0)), { left: PILL_SPRINGS.lead, right: PILL_SPRINGS.trail });
  assert.ok(PILL_SPRINGS.lead > PILL_SPRINGS.trail);
});

for (const [from, to] of [[0, 1], [0, 2], [2, 0], [1, 0], [2, 1]]) {
  test(`moving from tab ${from} to tab ${to}: stretches, no overshoot, settles in 250-350 ms at rest width`, () => {
    const a = pillAt(from);
    const b = pillAt(to);
    const path = pillPath(a, b, { dt: 1 / 120 });
    const end = path.at(-1);
    assert.ok(end.t >= 0.25 && end.t <= 0.36, `settled at ${Math.round(end.t * 1000)} ms`);
    assert.ok(Math.abs(end.left - b.left) < 0.5 && Math.abs(end.right - b.right) < 0.5, 'ends on the tab');
    const rest = b.right - b.left;
    const widths = path.map((s) => s.right - s.left);
    assert.ok(Math.max(...widths) > rest * 1.3, `stretches (max ${Math.max(...widths).toFixed(1)} px, rest ${rest})`);
    assert.ok(widths.every((w) => w >= rest - 0.5), 'never narrower than at rest');
    assert.ok(Math.abs(widths.at(-1) - rest) < 1, 'back to its resting width');
    const right = b.left > a.left;
    for (const s of path) {
      // No overshoot: neither edge passes its target.
      if (right) assert.ok(s.left <= b.left + 1e-6 && s.right <= b.right + 1e-6, `overshoot at ${s.t}`);
      else assert.ok(s.left >= b.left - 1e-6 && s.right >= b.right - 1e-6, `overshoot at ${s.t}`);
    }
    // The leading edge covers more of its way early on than the trailing edge.
    const early = path.find((s) => s.t >= 0.05);
    const share = (x, x0, x1) => (x - x0) / (x1 - x0);
    const lead = right ? share(early.right, a.right, b.right) : share(early.left, a.left, b.left);
    const trail = right ? share(early.left, a.left, b.left) : share(early.right, a.right, b.right);
    assert.ok(lead > trail + 0.15, `lead ${lead.toFixed(2)} vs trail ${trail.toFixed(2)}`);
  });
}

test('the path does not depend on the frame rate', () => {
  const at = (path, t) => path.find((s) => s.t >= t - 1e-9);
  const p60 = pillPath(pillAt(0), pillAt(2), { dt: 1 / 60 });
  const p120 = pillPath(pillAt(0), pillAt(2), { dt: 1 / 120 });
  for (const t of [0.05, 0.1, 0.2]) {
    assert.ok(Math.abs(at(p60, t).left - at(p120, t).left) < 1e-6 && Math.abs(at(p60, t).right - at(p120, t).right) < 1e-6, `at ${t}s`);
  }
});

test('settled means close and slow', () => {
  assert.equal(edgeSettled(100.2, 1, 100), true);
  assert.equal(edgeSettled(100.2, 50, 100), false, 'still moving');
  assert.equal(edgeSettled(101, 0, 100), false, 'not there yet');
});
