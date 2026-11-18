// Node tests for format 5's readers (docs/plan-intervals-groups.md, 4.1–4.3): the `repeat` field's
// limits and shadow cycle, sync never skipping it, backup import keeping a usable one and dropping
// only the field otherwise, and nothing in the app writing it. Run with `npm test`. This file runs
// in a time zone with DST.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../js/sync-core.js';
import * as storage from '../js/storage.js';
import { READ_LIMITS, isReadableInterval, shadowCycle, MONTHLY, ANNUAL } from '../js/interval.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const item = (over = {}) => ({
  id: 'a', type: 'expense', name: 'Pottery class', domain: '', emoji: '', plan: '', price: 150, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-11-19', date: '', category: 'Hobbies', notes: '', createdAt: T1, updatedAt: T1, ...over,
});
const every = (n, unit) => ({ every: n, unit });
const fileOf = (items, extra = {}) => ({ app: 'substracker', schemaVersion: 5, exportedAt: T2, items, ...extra });
let n = 0;
const replicaOf = (dev = 'devA') => ({ clock: core.newClock(dev), records: new Map() });
const opts = (now) => ({ now, newId: () => `op-${++n}` });

/* ------------------------------------------------------------------ Limits and shadow */

test('repeat limits: every 1 to 3660 days, 520 weeks, 120 months, 10 years; anything else is unreadable', () => {
  assert.deepEqual(READ_LIMITS, { day: 3660, week: 520, month: 120, year: 10 });
  for (const [unit, max] of Object.entries(READ_LIMITS)) {
    assert.ok(isReadableInterval(every(1, unit)) && isReadableInterval(every(max, unit)), `${unit} 1 and ${max}`);
    assert.equal(isReadableInterval(every(max + 1, unit)), false, `${unit} ${max + 1}`);
  }
  for (const bad of [null, undefined, 'weekly', {}, every(0, 'day'), every(1.5, 'week'), every('2', 'week'), every(2, 'fortnight'), every(-1, 'month'), every(NaN, 'day'), [1, 'week']]) {
    assert.equal(isReadableInterval(bad), false, JSON.stringify(bad));
  }
  assert.ok(isReadableInterval({ every: 2, unit: 'week', note: 'extra keys are fine' }));
});

test('shadow cycle: what 1.19.0 shows for each interval (nearer of a month or a year by period)', () => {
  const cases = [
    [every(1, 'month'), 'monthly'], [every(12, 'month'), 'annual'], [every(1, 'year'), 'annual'],
    [every(1, 'week'), 'monthly'], [every(2, 'week'), 'monthly'], [every(1, 'day'), 'monthly'],
    [every(3, 'month'), 'monthly'], [every(15, 'week'), 'monthly'], [every(105, 'day'), 'monthly'],
    [every(106, 'day'), 'annual'], [every(4, 'month'), 'annual'], [every(6, 'month'), 'annual'], [every(2, 'year'), 'annual'],
  ];
  for (const [interval, want] of cases) assert.equal(shadowCycle(interval), want, JSON.stringify(interval));
  assert.equal(shadowCycle(MONTHLY), 'monthly');
  assert.equal(shadowCycle(ANNUAL), 'annual');
  assert.equal(shadowCycle(null), 'once');
  assert.throws(() => shadowCycle({ every: 0, unit: 'day' }), TypeError);
});

/* ------------------------------------------------------------------ Sync keeps it, always */

test('sync stores any repeat value as its own field with its own stamp, never skipping the op', () => {
  const r = replicaOf();
  core.putRecord(r, 'a', { name: 'Pottery class', cycle: 'monthly' }, opts(1000));
  for (const [i, v] of [every(1, 'week'), every(2, 'fortnight'), every(9999, 'day'), 'weekly', null, { every: 1, unit: 'week', future: [1] }].entries()) {
    const op = { id: `r${i}`, rec: 'a', f: 'repeat', v, t: core.formatStamp(2000 + i, 0, 'devB'), dev: 'devB' };
    const out = storage.applyRemoteOps(r, [op], 5000);
    assert.equal(out.skipped, 0, JSON.stringify(v));
    assert.deepEqual(r.records.get('a').fields.repeat, v);
    assert.equal(r.records.get('a').ts.repeat, op.t, 'its own stamp');
  }
  // The other fields' checks are unchanged: a bad cycle is still refused.
  const bad = { id: 'c', rec: 'a', f: 'cycle', v: 7, t: core.formatStamp(9000, 0, 'devB'), dev: 'devB' };
  assert.equal(storage.applyRemoteOps(r, [bad], 10000).skipped, 1);
  // Requeueing sends it like any field.
  assert.ok(storage.requeueOps([...r.records.values()]).some((op) => op.f === 'repeat'));
});

test('saving an item never writes repeat, even when the item carries one', () => {
  assert.ok(!storage.ITEM_FIELDS.includes('repeat'), 'not one of the fields a save writes');
  assert.equal(storage.REPEAT, 'repeat');
});

/* ------------------------------------------------------------------ Backups bring it in */

test('a backup item keeps a usable repeat that agrees with its cycle, as { every, unit } only', () => {
  const parsed = storage.parseBackup(fileOf([item({ repeat: { every: 1, unit: 'week', note: 'x' } })]));
  assert.deepEqual(parsed.items[0].item.repeat, every(1, 'week'));
  const six = storage.parseBackup(fileOf([item({ cycle: 'annual', repeat: every(6, 'month') })]));
  assert.deepEqual(six.items[0].item.repeat, every(6, 'month'));
  for (const v of [3, 4]) {
    const old = storage.parseBackup({ ...fileOf([item({ repeat: every(2, 'week') })]), schemaVersion: v });
    assert.deepEqual(old.items[0].item.repeat, every(2, 'week'), `format ${v} too (a 1.19.0 backup can carry one)`);
  }
});

test('an unusable or disagreeing repeat drops only that field: the item imports as before', () => {
  for (const [label, over] of [
    ['unknown unit', { repeat: every(1, 'fortnight') }],
    ['too long', { repeat: every(121, 'month') }],
    ['not whole', { repeat: every(1.5, 'week') }],
    ['text', { repeat: 'weekly' }],
    ['null', { repeat: null }],
    ['disagrees with the cycle (weekly beside annual)', { cycle: 'annual', repeat: every(1, 'week') }],
    ['disagrees with the cycle (yearly beside monthly)', { repeat: every(1, 'year') }],
    ['on a one-off', { cycle: 'once', nextRenewal: '', date: '2026-12-24', repeat: every(1, 'week') }],
  ]) {
    const parsed = storage.parseBackup(fileOf([item(over)]));
    const got = parsed.items[0].item;
    assert.equal('repeat' in got, false, label);
    const without = storage.parseBackup(fileOf([item({ ...over, repeat: undefined })])).items[0].item;
    assert.deepEqual(got, without, `${label}: otherwise the same item`);
  }
});

test('import writes a file\'s repeat; a file item without one leaves the stored repeat alone', () => {
  const r = replicaOf();
  const plan1 = storage.planFromBackup(storage.parseBackup(fileOf([item({ repeat: every(1, 'week') })])), [], {}).replace;
  const ops1 = storage.importOps(r, plan1, opts(1000));
  assert.ok(ops1.some((op) => op.f === 'repeat'));
  assert.deepEqual(r.records.get('a').fields.repeat, every(1, 'week'));
  // A newer copy of the same item without repeat (say a 1.19.0 backup): it wins the merge, and only
  // the fields it has are written.
  const live = [storage.toItem(r.records.get('a'))];
  const newer = storage.parseBackup(fileOf([item({ price: 160, updatedAt: T2 })]));
  for (const mode of ['merge', 'replace']) {
    const ops = storage.importOps(r, storage.planFromBackup(newer, live, {})[mode], opts(2000));
    assert.ok(!ops.some((op) => op.f === 'repeat'), `${mode}: no op for repeat`);
    assert.deepEqual(r.records.get('a').fields.repeat, every(1, 'week'), `${mode}: the stored repeat stays`);
    assert.equal(r.records.get('a').fields.price, 160);
  }
});
