// Node tests for swiping between the tabs (js/swipe-nav.js): the thresholds, the step a swipe makes,
// no wrap-around at either end, where a swipe may start (the edge strips, form controls, regions
// marked data-no-page-swipe), and the listeners with fake touch events: one finger only, passive,
// never preventDefault, nothing while an overlay is open. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SWIPE_NAV, NO_PAGE_SWIPE, startsSwipe, swipeStep, neighbourTab, bindSwipeNav } from '../js/swipe-nav.js';

const ORDER = ['subs', 'calendar', 'insights', 'settings'];

test('the thresholds are named, in one place, and frozen', () => {
  assert.deepEqual({ ...SWIPE_NAV }, { minPx: 64, ratio: 2, edgePx: 24 });
  assert.ok(Object.isFrozen(SWIPE_NAV));
  assert.equal(NO_PAGE_SWIPE, '[data-no-page-swipe]');
});

test('a swipe to the left is the next tab, to the right the previous; short or steep ones do nothing', () => {
  assert.equal(swipeStep(-64, 0), 1, 'exactly the minimum, leftwards');
  assert.equal(swipeStep(64, 0), -1, 'and rightwards');
  assert.equal(swipeStep(-63.9, 0), 0, 'just short');
  assert.equal(swipeStep(-120, 60), 1, 'exactly twice the up-and-down travel');
  assert.equal(swipeStep(-120, 60.1), 0, 'just under the ratio');
  assert.equal(swipeStep(10, 200), 0, 'a scroll');
  assert.equal(swipeStep(0, 0), 0, 'a tap');
  assert.equal(swipeStep(NaN, 0), 0, 'no number, no step');
  assert.equal(swipeStep(-80, 0, { minPx: 100 }), 0, 'thresholds can be passed in');
});

test('no wrap-around: past either end there is no tab', () => {
  assert.equal(neighbourTab(ORDER, 'subs', 1), 'calendar');
  assert.equal(neighbourTab(ORDER, 'calendar', -1), 'subs');
  assert.equal(neighbourTab(ORDER, 'insights', 1), 'settings');
  assert.equal(neighbourTab(ORDER, 'settings', 1), null, 'nothing after Settings');
  assert.equal(neighbourTab(ORDER, 'subs', -1), null, 'nothing before Money');
  assert.equal(neighbourTab(ORDER, 'subs', 0), null, 'no step');
  assert.equal(neighbourTab(ORDER, 'nope', 1), null, 'an unknown tab');
});

// A stand-in element: `inside` lists the selectors its closest() finds.
const el = (...inside) => ({ nodeType: 1, closest: (sel) => (inside.some((s) => sel.includes(s)) ? {} : null) });

test('a swipe may not start at the edges, on a form control or in a region that opts out', () => {
  const W = 393;
  assert.equal(startsSwipe(el(), 200, W), true, 'the middle of a page');
  assert.equal(startsSwipe(el(), 23.9, W), false, 'the left edge strip');
  assert.equal(startsSwipe(el(), 24, W), true, 'just past it');
  assert.equal(startsSwipe(el(), W - 24, W), true, 'just inside the right strip');
  assert.equal(startsSwipe(el(), W - 23.9, W), false, 'the right edge strip');
  assert.equal(startsSwipe(el('input'), 200, W), false, 'an input (a range or checkbox too)');
  assert.equal(startsSwipe(el('textarea'), 200, W), false, 'a textarea');
  assert.equal(startsSwipe(el('select'), 200, W), false, 'a select');
  assert.equal(startsSwipe(el('[contenteditable]'), 200, W), false, 'editable text');
  assert.equal(startsSwipe(el('[data-no-page-swipe]'), 200, W), false, 'an island');
  const text = { nodeType: 3, parentElement: el('[data-no-page-swipe]') };
  assert.equal(startsSwipe(text, 200, W), false, 'a text node inside an island');
  assert.equal(startsSwipe(null, 200, W), false, 'no target');
});

/* The listeners, with a fake window and document. */
function harness({ start = 'subs', blocked = () => false } = {}) {
  const listeners = [];
  const target = () => ({
    addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
    removeEventListener: (type, fn) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1); },
  });
  const doc = target();
  const win = { ...target(), document: doc, innerWidth: 393 };
  const went = [];
  let tab = start;
  const nav = bindSwipeNav({ order: () => ORDER, current: () => tab, go: (t) => { went.push(t); tab = t; }, blocked, win });
  let prevented = 0;
  const fire = (type, { touches = [], changed = [], on = el(), pointerType } = {}) => {
    const e = { type, target: on, touches, changedTouches: changed, pointerType, isPrimary: true, preventDefault: () => { prevented++; } };
    for (const l of listeners.filter((x) => x.type === type)) l.fn(e);
  };
  const pt = (id, x, y) => ({ identifier: id, clientX: x, clientY: y });
  const swipe = (dx, dy = 0, { x = 200, y = 300, on } = {}) => {
    fire('pointerdown', { on, pointerType: 'touch' });
    fire('touchstart', { touches: [pt(1, x, y)], changed: [pt(1, x, y)], on });
    fire('touchmove', { touches: [pt(1, x + dx / 2, y + dy / 2)], changed: [pt(1, x + dx / 2, y + dy / 2)], on });
    fire('touchend', { touches: [], changed: [pt(1, x + dx, y + dy)], on });
  };
  return { listeners, went, fire, pt, swipe, nav, get tab() { return tab; }, get prevented() { return prevented; } };
}

test('the listeners are passive and never call preventDefault', () => {
  const h = harness();
  const touch = h.listeners.filter((l) => l.type.startsWith('touch'));
  assert.deepEqual(touch.map((l) => l.type).sort(), ['touchcancel', 'touchend', 'touchmove', 'touchstart']);
  assert.ok(h.listeners.every((l) => l.opts?.passive === true), 'every listener passive');
  h.swipe(-120);
  h.swipe(10, 200);
  assert.equal(h.prevented, 0);
  h.nav.stop();
  assert.equal(h.listeners.length, 0, 'stop() removes them all');
});

test('swipes step through the tabs in order, with no wrap at either end', () => {
  const h = harness();
  h.swipe(120);
  assert.deepEqual(h.went, [], 'right on Money: nothing');
  for (let i = 0; i < 4; i++) h.swipe(-120);
  assert.deepEqual(h.went, ['calendar', 'insights', 'settings'], 'left three times, then nothing on Settings');
  h.swipe(120);
  assert.equal(h.tab, 'insights', 'right goes back one');
});

test('the most up-and-down travel along the way counts, not only where the finger lifts', () => {
  const h = harness();
  h.fire('touchstart', { touches: [h.pt(1, 200, 300)], changed: [h.pt(1, 200, 300)] });
  h.fire('touchmove', { touches: [h.pt(1, 230, 380)], changed: [h.pt(1, 230, 380)] });
  h.fire('touchend', { touches: [], changed: [h.pt(1, 100, 300)] });
  assert.deepEqual(h.went, [], 'down 80 and back: 100 sideways is under twice 80');
});

test('a second finger cancels the swipe; a touchcancel drops it', () => {
  const h = harness({ start: 'calendar' });
  h.fire('touchstart', { touches: [h.pt(1, 200, 300)], changed: [h.pt(1, 200, 300)] });
  h.fire('touchstart', { touches: [h.pt(1, 200, 300), h.pt(2, 250, 300)], changed: [h.pt(2, 250, 300)] });
  h.fire('touchend', { touches: [h.pt(2, 130, 300)], changed: [h.pt(1, 80, 300)] });
  h.fire('touchend', { touches: [], changed: [h.pt(2, 130, 300)] });
  assert.deepEqual(h.went, [], 'two fingers');
  h.fire('touchstart', { touches: [h.pt(3, 200, 300)], changed: [h.pt(3, 200, 300)] });
  h.fire('touchcancel', { touches: [], changed: [h.pt(3, 200, 300)] });
  h.fire('touchend', { touches: [], changed: [h.pt(3, 60, 300)] });
  assert.deepEqual(h.went, [], 'cancelled');
  h.swipe(-120);
  assert.deepEqual(h.went, ['insights'], 'the next one-finger swipe works');
});

test('nothing while an overlay is open, including one a tap outside closes on pointerdown', () => {
  let open = true;
  const h = harness({ blocked: () => open });
  const down = () => h.fire('pointerdown', { pointerType: 'touch' });
  const start = () => h.fire('touchstart', { touches: [h.pt(1, 200, 300)], changed: [h.pt(1, 200, 300)] });
  const end = () => h.fire('touchend', { touches: [], changed: [h.pt(1, 60, 300)] });
  h.swipe(-120);
  assert.deepEqual(h.went, [], 'an overlay is open');
  // A menu open at pointerdown that the same touch closes before touchstart.
  down(); open = false; start(); end();
  assert.deepEqual(h.went, [], 'open when the finger went down: no switch');
  down(); start(); end();
  assert.deepEqual(h.went, ['calendar'], 'the next touch, with nothing open, switches');
  // An overlay that opens during the swipe stops it.
  down(); start(); open = true; end();
  assert.deepEqual(h.went, ['calendar'], 'opened during the swipe');
});

test('a swipe starting on an island, a control or an edge does nothing', () => {
  const h = harness({ start: 'calendar' });
  h.swipe(-120, 0, { on: el('[data-no-page-swipe]') });
  h.swipe(-120, 0, { on: el('input') });
  h.swipe(120, 0, { x: 10 });
  h.swipe(-120, 0, { x: 385 });
  assert.deepEqual(h.went, []);
  h.swipe(120, 0, { x: 30 });
  assert.deepEqual(h.went, ['subs'], 'just inside the strip, it does');
});
