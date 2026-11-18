// Mixed-version scenarios for format 5's readers: a frozen 1.19.0 device (tests/legacy-1.19.0/)
// and a device on the current js/ (tests/helpers/mixed-sync.js), both directions where it makes
// sense. Checks that `repeat` (written here by a test device, as 1.21.0 will write it) survives
// 1.19.0's own edits, syncs, backups and joins; that the current reader falls back to the cycle
// exactly when the plan says; and that format 4 and 5 files import on both. Loaded by
// tests/mixed-version.node.test.js and tests/mixed-version-tz.node.test.js. Items are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHousehold } from './helpers/mixed-sync.js';
import { effectiveInterval, MONTHLY, ANNUAL } from '../js/interval.js';

const PAIRS = [['legacy', 'current'], ['current', 'legacy']];
const WEEKLY = Object.freeze({ every: 1, unit: 'week' });

const item = (id, over = {}) => ({
  id, type: 'expense', name: `Item ${id}`, domain: '', emoji: '', plan: '', price: 150, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-11-19', date: '', category: 'Hobbies', notes: '',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});

function manualTime(start = Date.UTC(2026, 10, 19, 4, 0, 0)) {
  const c = { t: start };
  c.advance = (ms = 1000) => { c.t += ms; return c.t; };
  c.now = (skew = 0) => () => c.t + skew;
  return c;
}

/** What the current reader steps a device's item by (its item view, as every screen sees it). */
const interval = (d, id) => effectiveInterval(d.item(id));

async function household({ crypto } = {}) {
  const time = manualTime();
  const h = await createHousehold({ crypto, relayNow: time.now() });
  return { h, time };
}

/* ------------------------------------------------------------------ repeat through 1.19.0's own edits */

for (const [writer, other] of PAIRS) {
  test(`${writer} writes a repeat; 1.19.0's edits of other fields keep it, and the current reader steps by it`, async () => {
    const { h, time } = await household();
    const W = await h.device('writer', { version: writer, now: time.now() });
    const O = await h.device('other', { version: other, now: time.now() });
    const L = W.version === 'legacy' ? W : O;
    const C = W.version === 'legacy' ? O : W;
    W.save(item('a'));
    time.advance();
    W.writeFields('a', { repeat: WEEKLY }); // as 1.21.0 will: its own field, a newer stamp
    await h.syncAll();
    for (const d of [W, O]) assert.deepEqual(d.record('a').fields.repeat, WEEKLY, `${d.name}: stored`);
    assert.deepEqual(interval(C, 'a'), WEEKLY, 'current steps weekly');

    time.advance();
    assert.deepEqual(L.save({ ...L.item('a'), price: 160 }).map((o) => o.f), ['price'], '1.19.0 storage save: only the price');
    time.advance();
    const form = L.formSave('a', { notes: 'Bring an apron', nextRenewal: '2026-11-26' });
    assert.deepEqual(form.ops.map((o) => o.f).sort(), ['nextRenewal', 'notes', 'updatedAt'], '1.19.0 sheet: cycle untouched, it is a known value');
    await h.syncAll();
    for (const d of [W, O]) {
      assert.deepEqual(d.record('a').fields.repeat, WEEKLY, `${d.name}: still there`);
      assert.equal(d.item('a').price, 160);
      assert.equal(d.item('a').nextRenewal, '2026-11-26', 'the anchor moved; the interval stays');
    }
    assert.deepEqual(interval(C, 'a'), WEEKLY, 'still weekly from the new date');
  });
}

test('1.19.0 changes the cycle: the current reader falls back to it, and keeps doing so after it changes back', async () => {
  const { h, time } = await household();
  const C = await h.device('current', { version: 'current', now: time.now() });
  const L = await h.device('legacy', { version: 'legacy', now: time.now() });
  C.save(item('a'));
  time.advance();
  C.writeFields('a', { repeat: WEEKLY });
  await h.syncAll();
  time.advance();
  assert.ok(L.formSave('a', { cycle: 'annual' }).ops.some((o) => o.f === 'cycle'));
  await h.syncAll();
  assert.equal(interval(C, 'a'), ANNUAL, 'the newer cycle wins (weekly would show as monthly, not annual)');
  time.advance();
  L.formSave('a', { cycle: 'monthly' }); // back to the repeat's shadow, but later than the repeat
  await h.syncAll();
  assert.equal(interval(C, 'a'), MONTHLY, 'monthly, not weekly: the cycle was set after the repeat');
  assert.deepEqual(C.record('a').fields.repeat, WEEKLY, 'the repeat is still stored and synced');
  assert.equal('repeat' in C.item('a'), false, 'but not part of the item');
  time.advance();
  C.writeFields('a', { repeat: { every: 2, unit: 'week' } }); // a newer writer sets it again
  await h.syncAll();
  assert.deepEqual(interval(C, 'a'), { every: 2, unit: 'week' });
});

/* ------------------------------------------------------------------ Stale copies */

test('a stale 1.19.0 copy with a newer updatedAt cannot erase a repeat: through sync', async () => {
  const { h, time } = await household();
  const C = await h.device('current', { version: 'current', now: time.now() });
  const L = await h.device('legacy', { version: 'legacy', now: time.now() });
  C.save(item('a'));
  await h.syncAll();
  L.offline();
  time.advance();
  C.writeFields('a', { repeat: WEEKLY });
  await C.sync();
  time.advance(60_000);
  L.formSave('a', { price: '175' }); // newer updatedAt, a copy that never saw the repeat
  L.online();
  await h.syncAll(3);
  for (const d of [C, L]) {
    assert.deepEqual(d.record('a').fields.repeat, WEEKLY, `${d.name}: kept`);
    assert.equal(d.item('a').price, 175, `${d.name}: the later edit landed`);
  }
  assert.deepEqual(interval(C, 'a'), WEEKLY);
});

test('a stale 1.19.0 backup with a newer updatedAt cannot erase a repeat: merge and replace', async () => {
  const { h, time } = await household();
  const C = await h.device('current', { version: 'current', now: time.now() });
  const L = await h.device('legacy', { version: 'legacy', now: time.now(), joined: false });
  C.save(item('a'));
  L.save(item('a', { price: 200, updatedAt: '2030-01-01T00:00:00.000Z' })); // the same item, edited later elsewhere
  const stale = L.exportBackup();
  assert.equal('repeat' in JSON.parse(stale).items[0], false);
  time.advance();
  C.writeFields('a', { repeat: WEEKLY });
  for (const mode of ['merge', 'replace']) {
    time.advance();
    const sum = C.importBackup(stale, mode);
    assert.equal(sum.updated, 1, `${mode}: the file's copy wins`);
    assert.equal(C.item('a').price, 200);
    assert.deepEqual(C.record('a').fields.repeat, WEEKLY, `${mode}: the repeat stays`);
    assert.deepEqual(interval(C, 'a'), WEEKLY, `${mode}: and still counts (the cycle didn't change)`);
  }
});

test('a 1.19.0 backup that changed the cycle does override a repeat on import (the later choice wins)', async () => {
  const { h, time } = await household();
  const C = await h.device('current', { version: 'current', now: time.now() });
  const L = await h.device('legacy', { version: 'legacy', now: time.now(), joined: false });
  C.save(item('a'));
  time.advance();
  C.writeFields('a', { repeat: WEEKLY });
  L.save(item('a', { cycle: 'annual', updatedAt: '2030-01-01T00:00:00.000Z' }));
  time.advance();
  C.importBackup(L.exportBackup(), 'merge');
  assert.equal(C.item('a').cycle, 'annual');
  assert.equal(interval(C, 'a'), ANNUAL);
  assert.deepEqual(C.record('a').fields.repeat, WEEKLY, 'stored, not counting');
});

/* ------------------------------------------------------------------ Values the reader can't use */

for (const [writer, reader] of PAIRS) {
  test(`${writer} -> ${reader}: repeat values the current reader can't use are kept everywhere and read as the cycle`, async () => {
    const { h, time } = await household();
    const W = await h.device('writer', { version: writer, now: time.now() });
    const R = await h.device('reader', { version: reader, now: time.now() });
    const odd = {
      u: { every: 2, unit: 'quarter' }, b: { every: 999, unit: 'month' }, z: { every: 0, unit: 'week' },
      t: 'fortnightly', d: { every: 1, unit: 'week' }, n: null,
    };
    for (const [id, v] of Object.entries(odd)) {
      W.save(item(id, id === 'd' ? { cycle: 'annual' } : {})); // d: a weekly repeat beside annual disagrees
      time.advance();
      W.writeFields(id, { repeat: v });
    }
    await h.syncAll();
    for (const d of [W, R]) {
      assert.deepEqual(d.report().skipped, [], `${d.name}: nothing skipped`);
      for (const [id, v] of Object.entries(odd)) assert.deepEqual(d.record(id).fields.repeat, v, `${d.name} ${id}: kept as sent`);
    }
    const C = W.version === 'current' ? W : R;
    for (const id of Object.keys(odd)) assert.equal(interval(C, id), id === 'd' ? ANNUAL : MONTHLY, `${id}: the cycle's interval`);
    // The current export check passes: these intervals come back the same (as the cycle's).
    const out = C.exportBackup();
    assert.equal(JSON.parse(out).schemaVersion, 5);
    assert.equal(C.lastExport.problem, null);
  });
}

/* ------------------------------------------------------------------ Tombstones */

for (const [first, second] of PAIRS) {
  test(`${first} + ${second}: deleting an item with a repeat is final; a later repeat op doesn't bring it back`, async () => {
    const { h, time } = await household();
    const A = await h.device('devA', { version: first, now: time.now() });
    const B = await h.device('devB', { version: second, now: time.now() });
    A.save(item('a'));
    time.advance();
    A.writeFields('a', { repeat: WEEKLY });
    await h.syncAll();
    time.advance();
    B.remove('a');
    await h.syncAll();
    time.advance();
    const late = h.writer('future', { now: time.now(5000) }); // a newer device, a little ahead
    await late.push([late.op('a', 'repeat', { every: 2, unit: 'week' })]);
    await h.syncAll();
    for (const d of [A, B]) {
      assert.deepEqual(d.tombstones(), ['a'], `${d.name}: deleted`);
      assert.equal(d.item('a'), null);
      assert.deepEqual(d.record('a').fields.repeat, { every: 2, unit: 'week' }, `${d.name}: the late op landed on the tombstone`);
    }
  });
}

/* ------------------------------------------------------------------ Backups across versions */

test('round trip: 1.19.0 backup -> current -> 1.19.0 keeps repeat where each version can', async () => {
  const { h, time } = await household();
  const C0 = await h.device('writer', { version: 'current', now: time.now() });
  const L = await h.device('legacy', { version: 'legacy', now: time.now() });
  C0.save(item('a'));
  time.advance();
  C0.writeFields('a', { repeat: WEEKLY, futureNote: 'kept by sync only' });
  C0.save(item('b', { cycle: 'annual' }));
  await h.syncAll();
  const file1 = L.exportBackup();
  const f1 = JSON.parse(file1);
  assert.equal(f1.schemaVersion, 4);
  assert.deepEqual(f1.items.find((x) => x.id === 'a').repeat, WEEKLY, '1.19.0 writes the stored repeat (it spreads the whole item)');

  const C = await h.device('current2', { version: 'current', joined: false, now: time.now() });
  C.importBackup(file1, 'replace');
  assert.deepEqual(C.record('a').fields.repeat, WEEKLY, 'the current reader keeps a repeat that agrees');
  assert.equal(C.record('a').fields.futureNote, undefined, 'a field no version knows is not part of a backup item');
  assert.deepEqual(interval(C, 'a'), WEEKLY);
  const file2 = C.exportBackup();
  const f2 = JSON.parse(file2);
  assert.equal(f2.schemaVersion, 5);
  assert.deepEqual(f2.items.find((x) => x.id === 'a').repeat, WEEKLY);

  const L2 = await h.device('legacy2', { version: 'legacy', joined: false, now: time.now() });
  const sum = L2.importBackup(file2, 'replace');
  assert.equal(sum.newerVersion, true, '1.19.0 says the file comes from a newer version');
  assert.equal(L2.record('a').fields.repeat, undefined, '1.19.0 imports the item without it, as before');
  assert.deepEqual(L2.items().map((x) => x.id), ['a', 'b']);
  // A 1.19.0 device that already has the repeat (by sync) keeps it when it imports the same file.
  L.importBackup(file2, 'merge');
  L.importBackup(file2, 'replace');
  assert.deepEqual(L.record('a').fields.repeat, WEEKLY);
  assert.equal(L.record('a').fields.futureNote, 'kept by sync only');
});

test('format 4 and format 5 files both import on both versions', async () => {
  const { h, time } = await household();
  const v4 = JSON.stringify({ app: 'substracker', schemaVersion: 4, exportedAt: '2026-11-19T00:00:00.000Z', items: [item('a'), item('b', { cycle: 'annual' })], settings: { defaultCurrency: 'TWD', groupColors: { Hobbies: 'g3' } } });
  const v5 = JSON.stringify({ ...JSON.parse(v4), schemaVersion: 5, items: [item('a', { repeat: WEEKLY }), item('b', { cycle: 'annual', repeat: { every: 6, unit: 'month' } })], settings: { groupColors: { Hobbies: 'w5' }, groupSlots: { Hobbies: 4 } } });
  const got = {};
  for (const version of ['legacy', 'current']) {
    for (const [name, file] of [['v4', v4], ['v5', v5]]) {
      const d = await h.device(`${version}-${name}`, { version, joined: false, now: time.now() });
      const sum = d.importBackup(file, 'replace');
      got[`${version} ${name}`] = {
        newer: sum.newerVersion,
        items: d.items().map(({ id, cycle, repeat }) => ({ id, cycle, ...(repeat ? { repeat } : {}) })),
        colours: d.settings().groupColors, slots: d.settings().groupSlots,
      };
    }
  }
  assert.deepEqual(got['legacy v4'], got['current v4'], 'a format-4 file: the same result on both');
  assert.deepEqual(got['legacy v4'].items, [{ id: 'a', cycle: 'monthly' }, { id: 'b', cycle: 'annual' }]);
  assert.equal(got['legacy v5'].newer, true);
  assert.equal(got['current v5'].newer, false);
  assert.deepEqual(got['legacy v5'].items, got['legacy v4'].items, '1.19.0: format 5 imports as format 4 would');
  assert.deepEqual(got['current v5'].items, [{ id: 'a', cycle: 'monthly', repeat: WEEKLY }, { id: 'b', cycle: 'annual', repeat: { every: 6, unit: 'month' } }]);
  assert.deepEqual(got['current v5'].slots, { Hobbies: 4 });
  assert.equal(got['legacy v5'].slots, undefined);
  assert.deepEqual(got['legacy v5'].colours, { Hobbies: 'w5' });
});

test('a legacy device joining a household with repeats and slots keeps them, merge and replace', async () => {
  const { h, time } = await household({ crypto: 'real' });
  const C = await h.device('home', { version: 'current', now: time.now() });
  C.save(item('a'));
  time.advance();
  C.writeFields('a', { repeat: WEEKLY });
  C.writeFields(C.mod.storage.SETTINGS_ID, { [C.mod.storage.colorField('Hobbies')]: { name: 'Hobbies', swatch: 'w5', slot: 4, auto: true } });
  await C.sync();
  for (const mode of ['merge', 'replace']) {
    const L = await h.device(`legacy-${mode}`, { version: 'legacy', joined: false, now: time.now() });
    L.save(item(`own-${mode}`));
    await L.join(mode);
    await h.syncAll(2);
    assert.deepEqual(L.record('a').fields.repeat, WEEKLY, `${mode}: repeat`);
    assert.deepEqual(L.settingsRecord().fields[C.mod.storage.colorField('Hobbies')], { name: 'Hobbies', swatch: 'w5', slot: 4, auto: true }, `${mode}: the colour value, every key`);
    assert.deepEqual(L.report().skipped, []);
  }
  assert.deepEqual(C.settings().groupSlots, { Hobbies: 4 });
  assert.deepEqual(interval(C, 'a'), WEEKLY);
});
