// Node tests for js/overlays.js: the overlay stack (open/close order, closing twice, close-all,
// refusals, stale entries) and what Android Back does at each level. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayStack, createBackHandler } from '../js/overlays.js';

/** A fake overlay: `close` removes it from the stack unless `refuse` is set (like a busy sheet). */
function fake(stack, id, log, { refuse = false } = {}) {
  const o = {
    open: true,
    refuse,
    show() { o.open = true; stack.open(id, { close: o.close, isOpen: () => o.open }); },
    close() {
      log.push(`close ${id}`);
      if (o.refuse) return;
      o.open = false;
      stack.remove(id);
    },
  };
  o.show();
  return o;
}

test('closeTop closes the most recently opened overlay first', () => {
  const s = createOverlayStack();
  const log = [];
  fake(s, 'sheet', log);
  fake(s, 'confirm', log);
  assert.deepEqual(s.ids(), ['sheet', 'confirm']);
  assert.equal(s.top(), 'confirm');
  assert.equal(s.closeTop(), 'closed');
  assert.equal(s.top(), 'sheet');
  assert.equal(s.closeTop(), 'closed');
  assert.equal(s.closeTop(), null, 'nothing left');
  assert.deepEqual(log, ['close confirm', 'close sheet']);
});

test('opening an overlay again moves it to the top instead of adding a second entry', () => {
  const s = createOverlayStack();
  const log = [];
  const a = fake(s, 'a', log);
  fake(s, 'b', log);
  a.show();
  assert.deepEqual(s.ids(), ['b', 'a']);
});

test('removing twice, or removing what was never opened, is harmless', () => {
  const s = createOverlayStack();
  const log = [];
  const a = fake(s, 'a', log);
  fake(s, 'b', log);
  a.close();
  a.close();
  s.remove('a');
  s.remove('never');
  assert.deepEqual(s.ids(), ['b']);
});

test('a double close (Back pressed twice) closes two overlays, one each, never the same one twice', () => {
  const s = createOverlayStack();
  const log = [];
  fake(s, 'sheet', log);
  fake(s, 'step', log);
  fake(s, 'confirm', log);
  s.closeTop();
  s.closeTop();
  assert.deepEqual(log, ['close confirm', 'close step']);
  assert.deepEqual(s.ids(), ['sheet']);
});

test('an overlay whose close path refuses stays on top, and Back keeps landing on it', () => {
  const s = createOverlayStack();
  const log = [];
  fake(s, 'sheet', log);
  const busy = fake(s, 'sync', log, { refuse: true });
  assert.equal(s.closeTop(), 'kept');
  assert.equal(s.closeTop(), 'kept');
  assert.equal(s.top(), 'sync', 'the sheet below is not closed instead');
  busy.refuse = false;
  assert.equal(s.closeTop(), 'closed');
  assert.equal(s.top(), 'sheet');
});

test('closeAll closes everything topmost first, and stops at one that refuses', () => {
  const s = createOverlayStack();
  const log = [];
  fake(s, 'a', log);
  fake(s, 'b', log);
  fake(s, 'c', log);
  assert.equal(s.closeAll(), true);
  assert.deepEqual(log, ['close c', 'close b', 'close a']);
  assert.equal(s.top(), null);

  const log2 = [];
  fake(s, 'x', log2);
  fake(s, 'busy', log2, { refuse: true });
  fake(s, 'y', log2);
  assert.equal(s.closeAll(), false);
  assert.deepEqual(s.ids(), ['x', 'busy']);
  assert.deepEqual(log2, ['close y', 'close busy']);
});

test('an entry whose overlay vanished without unregistering is dropped, so Back never sticks', () => {
  const s = createOverlayStack();
  const log = [];
  fake(s, 'sheet', log);
  const pop = fake(s, 'pop', log);
  pop.open = false; // closed some other way that forgot to unregister
  assert.equal(s.top(), 'sheet');
  assert.deepEqual(s.ids(), ['sheet']);
});

test('a close path that throws, or forgets to unregister, still leaves the stack consistent', () => {
  const s = createOverlayStack();
  let shown = true;
  s.open('a', { close: () => { shown = false; throw new Error('boom'); }, isOpen: () => shown });
  const err = console.error;
  console.error = () => {};
  try { assert.equal(s.closeTop(), 'closed'); } finally { console.error = err; }
  assert.equal(s.top(), null);
});

test('an overlay that is open but out of sight is skipped, and kept for when it is back', () => {
  const s = createOverlayStack();
  const log = [];
  fake(s, 'sheet', log);
  let visible = true;
  s.open('focus', { close: () => { log.push('close focus'); s.remove('focus'); }, isShown: () => visible });
  visible = false;
  assert.equal(s.top(), 'sheet');
  assert.ok(s.has('focus'));
  visible = true;
  assert.equal(s.top(), 'focus');
});

/* Back --------------------------------------------------------------------- */

function backFixture(tab = 'subs') {
  const stack = createOverlayStack();
  const calls = [];
  const app = { tab };
  const back = createBackHandler({
    stack,
    getTab: () => app.tab,
    goRoot: () => { calls.push('root'); app.tab = 'subs'; },
    minimize: () => calls.push('minimize'),
  });
  return { stack, calls, app, back };
}

test('Back with an overlay open closes only that overlay and never leaves the app', () => {
  const { stack, calls, back } = backFixture('settings');
  const log = [];
  fake(stack, 'sync-dialog', log);
  fake(stack, 'sync-step', log);
  assert.equal(back(), 'closed');
  assert.deepEqual(log, ['close sync-step']);
  assert.deepEqual(calls, [], 'no tab change, no minimise');
  assert.equal(back(), 'closed');
  assert.deepEqual(log, ['close sync-step', 'close sync-dialog']);
  assert.deepEqual(calls, []);
});

test('Back on an overlay that refuses (busy) does nothing else: no tab change, no minimise', () => {
  const { stack, calls, back } = backFixture('settings');
  fake(stack, 'sync-dialog', [], { refuse: true });
  for (let i = 0; i < 5; i++) assert.equal(back(), 'kept');
  assert.deepEqual(calls, []);
});

test('Back with nothing open goes to the root tab, then minimises from there', () => {
  const { calls, back, app } = backFixture('insights');
  assert.equal(back(), 'root');
  assert.equal(app.tab, 'subs');
  assert.equal(back(), 'minimize');
  assert.deepEqual(calls, ['root', 'minimize']);
});

test('rapid Back presses walk down one level each: overlays, then the root tab, then minimise', () => {
  const { stack, calls, back } = backFixture('settings');
  const log = [];
  fake(stack, 'sub-dialog', log);
  fake(stack, 'confirm-dialog', log);
  const got = [back(), back(), back(), back()];
  assert.deepEqual(got, ['closed', 'closed', 'root', 'minimize']);
  assert.deepEqual(log, ['close confirm-dialog', 'close sub-dialog']);
  assert.deepEqual(calls, ['root', 'minimize']);
});
