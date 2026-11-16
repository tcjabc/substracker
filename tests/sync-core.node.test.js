// Node tests for js/sync-core.js: clock ordering, convergence, per-field merging and tombstones.
// Run with `npm test` (or `node --test tests/*.node.test.js`). Uses Node built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sync from '../js/sync-core.js';

const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const HOUR = 3_600_000;

/** A replica with its own fake physical clock (`at` ms), so tests control time and skew. */
function replica(dev, at = T0) {
  let n = 0;
  const r = { clock: sync.newClock(dev), records: new Map(), at };
  r.opts = () => ({ now: r.at, newId: () => `${dev}-op-${n++}` });
  return r;
}

/** Records as JSON with ids and object keys sorted: equal content gives equal text, whatever the arrival order. */
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const snapshot = (records) => JSON.stringify(sortKeys([...records.values()].sort((a, b) => a.id.localeCompare(b.id))));

function applyAll(records, ops) {
  for (const op of ops) sync.applyOp(records, op);
  return records;
}

/** A few deterministic shuffles of a list. */
function orders(list) {
  const out = [list, [...list].reverse()];
  let seed = 7;
  for (let k = 0; k < 6; k++) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    out.push(a);
  }
  return out;
}

/* ------------------------------------------------------------------ Clock */

test('stamps sort as strings in time order, with the device id breaking ties', () => {
  const a = sync.formatStamp(5, 0, 'devA');
  const b = sync.formatStamp(5, 1, 'devA');
  const c = sync.formatStamp(6, 0, 'devA');
  const d = sync.formatStamp(5, 1, 'devB');
  assert.deepEqual([c, d, a, b].sort(), [a, b, d, c]);
  assert.equal(sync.compare(b, d) < 0, true);
  assert.deepEqual(sync.parseStamp(d), { wall: 5, count: 1, dev: 'devB' });
  assert.equal(sync.parseStamp('5-1-devB'), null);
  assert.equal(sync.isStamp(a), true);
});

test('tick is strictly increasing when the clock stands still or moves backwards', () => {
  let clock = sync.newClock('dev');
  const stamps = [];
  for (const now of [T0, T0, T0 - HOUR, T0 - 5 * HOUR, T0 + 1, NaN, -1, T0 + 2]) {
    const r = sync.tick(clock, now);
    clock = r.clock;
    stamps.push(r.stamp);
  }
  for (let i = 1; i < stamps.length; i++) assert.equal(sync.compare(stamps[i - 1], stamps[i]) < 0, true, `stamp ${i}`);
  assert.equal(sync.parseStamp(stamps.at(-1)).wall, T0 + 2);
});

test('receive moves the clock past a remote stamp, so later local edits win', () => {
  const ahead = sync.formatStamp(T0 + 3 * HOUR, 4, 'fast');
  const clock = sync.receive(sync.newClock('slow'), ahead, T0);
  const { stamp } = sync.tick(clock, T0 + 1);
  assert.equal(sync.compare(stamp, ahead) > 0, true);
  assert.throws(() => sync.receive(clock, 'nonsense', T0), /Invalid stamp/);
});

test('a stamp a year ahead moves the clock no further than MAX_DRIFT_MS', () => {
  const YEAR = 365 * 24 * HOUR;
  assert.equal(sync.MAX_DRIFT_MS, 24 * HOUR);
  const bogus = sync.formatStamp(T0 + YEAR, 3, 'wrongyear');
  let clock = sync.receive(sync.newClock('local'), bogus, T0);
  assert.equal(clock.wall <= T0 + sync.MAX_DRIFT_MS, true, 'capped');
  assert.equal(clock.wall, T0 + sync.MAX_DRIFT_MS);
  // Seeing it again and again can't ratchet the clock forward a day at a time: the cap is measured
  // from the physical clock, so it only moves as real time does.
  for (let i = 0; i < 50; i++) clock = sync.receive(clock, bogus, T0);
  assert.equal(clock.wall, T0 + sync.MAX_DRIFT_MS, 'same time: no further');
  for (let i = 1; i <= 50; i++) clock = sync.receive(clock, bogus, T0 + i * 1000);
  assert.equal(clock.wall, T0 + 50_000 + sync.MAX_DRIFT_MS, 'later: now + cap, never more');
  // Within the cap nothing changes: the clock follows the remote stamp as before.
  const near = sync.formatStamp(T0 + 23 * HOUR, 7, 'other');
  const followed = sync.receive(sync.newClock('local'), near, T0);
  assert.deepEqual([followed.wall, followed.count], [T0 + 23 * HOUR, 8]);
  // A custom cap is honoured.
  assert.equal(sync.receive(sync.newClock('local'), bogus, T0, HOUR).wall, T0 + HOUR);
});

test('after a far-future stamp, local edits still order correctly and replicas agree', () => {
  const YEAR = 365 * 24 * HOUR;
  const a = replica('devA', T0);
  const created = sync.createRecord(a, 'x', { name: 'Example', price: 10, notes: '' }, a.opts());

  // devZ's phone is a year ahead. It edits price; devB, with a correct clock, edits name.
  const z = replica('devZ', T0 + YEAR);
  applyAll(z.records, created);
  const future = sync.editRecord(z, 'x', { price: 99 }, z.opts());
  const b = replica('devB', T0);
  applyAll(b.records, created);
  b.at = T0 + 1000;
  const normal = sync.editRecord(b, 'x', { name: 'From B' }, b.opts());

  // devA receives both, folding their stamps into its clock as a sync engine would.
  for (const op of [...future, ...normal]) { applyAll(a.records, [op]); a.clock = sync.receive(a.clock, op.t, a.at); }
  assert.equal(a.clock.wall <= T0 + sync.MAX_DRIFT_MS, true, 'clock stayed within the cap');

  // devA's later edits: increasing, after everything it has seen within the cap, and they win there.
  a.at = T0 + 2000;
  const e1 = sync.editRecord(a, 'x', { name: 'From A' }, a.opts());
  const e2 = sync.editRecord(a, 'x', { notes: 'later' }, a.opts());
  assert.equal(sync.compare(e1[0].t, e2[0].t) < 0, true, 'own edits in order');
  assert.equal(sync.compare(normal[0].t, e1[0].t) < 0, true, 'after the normal remote edit');
  assert.equal(sync.parseStamp(e2[0].t).wall <= T0 + sync.MAX_DRIFT_MS, true, 'not dragged a year ahead');

  // Every replica, in every order, ends up the same. The far-future price keeps winning its field
  // (ordering uses the op's own stamp, the only rule all devices can agree on); other fields are unaffected.
  const all = [...created, ...future, ...normal, ...e1, ...e2];
  const results = new Set(orders(all).map((order) => snapshot(applyAll(new Map(), order))));
  assert.equal(results.size, 1);
  const x = applyAll(new Map(), all).get('x').fields;
  assert.deepEqual([x.name, x.notes, x.price], ['From A', 'later', 99]);
});

test('the counter rolls into the next millisecond instead of overflowing', () => {
  const clock = { wall: T0, count: 999_999, dev: 'dev' };
  const { clock: next, stamp } = sync.tick(clock, T0);
  assert.deepEqual([next.wall, next.count], [T0 + 1, 0]);
  assert.equal(sync.compare(sync.formatStamp(T0, 999_999, 'dev'), stamp) < 0, true);
});

test('clock skew: a device hours behind or ahead still orders its own events', () => {
  for (const skew of [-6 * HOUR, 9 * HOUR]) {
    const r = replica('skewed', T0 + skew);
    const ops = [];
    ops.push(...sync.createRecord(r, 'x', { name: 'one', price: 1 }, r.opts()));
    ops.push(...sync.editRecord(r, 'x', { price: 2 }, r.opts()));
    r.at -= 2 * HOUR; // the phone's clock is corrected backwards in between
    ops.push(...sync.editRecord(r, 'x', { price: 3 }, r.opts()));
    ops.push(...sync.editRecord(r, 'x', { price: 4 }, r.opts()));
    for (let i = 1; i < ops.length; i++) assert.equal(sync.compare(ops[i - 1].t, ops[i].t) <= 0, true);
    // Whatever order another replica sees them in, the last edit wins.
    for (const order of orders(ops)) {
      assert.equal(applyAll(new Map(), order).get('x').fields.price, 4, `skew ${skew}`);
    }
  }
});

/* ------------------------------------------------------------------ Ops */

test('mutate helpers return ops and apply them locally', () => {
  const r = replica('a');
  const created = sync.createRecord(r, 'x', { name: 'Example', price: 10 }, r.opts());
  assert.deepEqual(created.map((o) => [o.rec, o.f, o.v]), [['x', 'name', 'Example'], ['x', 'price', 10], ['x', 'del', false]]);
  assert.equal(new Set(created.map((o) => o.t)).size, 1, 'one change, one stamp');
  assert.equal(created.every(sync.isOp), true);
  assert.equal(sync.isLive(r.records.get('x')), true);

  assert.deepEqual(sync.editRecord(r, 'x', { name: 'Example', price: 12 }, r.opts()).map((o) => o.f), ['price'], 'only changed fields');
  assert.deepEqual(sync.editRecord(r, 'x', { price: 12 }, r.opts()), [], 'no change, no ops');

  const del = sync.deleteRecord(r, 'x', r.opts());
  assert.deepEqual(del.map((o) => [o.f, o.v]), [['del', true]]);
  assert.equal(sync.isLive(r.records.get('x')), false);
  assert.equal(r.records.get('x').fields.price, 12, 'tombstone keeps its fields');
  assert.deepEqual(sync.deleteRecord(r, 'x', r.opts()), [], 'deleting twice does nothing');
  assert.throws(() => sync.editRecord(r, 'x', { price: 1 }, r.opts()), /No such record/);
  assert.throws(() => sync.createRecord(r, 'x', { price: 1 }, r.opts()), /already exists/);

  const back = sync.putRecord(r, 'x', { name: 'Example', price: 12 }, r.opts());
  assert.deepEqual(back.map((o) => [o.f, o.v]), [['del', false]], 'put brings it back, only del changes');
  assert.equal(sync.isLive(r.records.get('x')), true);
});

test('bad input is rejected', () => {
  const r = replica('a');
  assert.throws(() => sync.createRecord(r, '', { a: 1 }, r.opts()), /record id/);
  assert.throws(() => sync.createRecord(r, 'x', { del: true }, r.opts()), /field name/);
  assert.throws(() => sync.createRecord(r, 'x', { __proto__x: 1 }, r.opts()), /field name/);
  assert.throws(() => sync.createRecord(r, 'x', { price: NaN }, r.opts()), /Invalid value/);
  assert.equal(r.records.size, 0, 'nothing applied');
  assert.throws(() => sync.applyOp(new Map(), { id: 'o', rec: 'x', f: 'del', v: 'yes', t: sync.formatStamp(1, 0, 'a'), dev: 'a' }), /Invalid op/);
  assert.throws(() => sync.applyOp(new Map(), { id: 'o', rec: 'x', f: 'name', v: 'n', t: sync.formatStamp(1, 0, 'a'), dev: 'b' }), /Invalid op/);
});

test('applying the same op twice changes nothing', () => {
  const r = replica('a');
  const ops = sync.createRecord(r, 'x', { name: 'Example', price: 10 }, r.opts());
  const other = new Map();
  for (const op of ops) assert.equal(sync.applyOp(other, op), true);
  const before = snapshot(other);
  for (const op of ops) assert.equal(sync.applyOp(other, op), false);
  assert.equal(snapshot(other), before);
  // A copy of an op (as it would arrive over the network) is just as harmless.
  for (const op of JSON.parse(JSON.stringify(ops))) assert.equal(sync.applyOp(other, op), false);
});

/* ------------------------------------------------------------------ Convergence */

test('three replicas apply the same ops in different orders and converge', () => {
  const a = replica('devA');
  const b = replica('devB', T0 - 2 * HOUR); // clock behind
  const c = replica('devC', T0 + 2 * HOUR); // clock ahead
  const all = [];
  const share = (ops, ...to) => { all.push(...ops); for (const r of to) applyAll(r.records, ops); };

  share(sync.createRecord(a, 'r1', { name: 'Example Streaming', price: 250, currency: 'TWD' }, a.opts()), b, c);
  share(sync.createRecord(b, 'r2', { name: 'Example Salary', price: 50_000 }, b.opts()), a, c);
  // Concurrent edits nobody has seen yet.
  share(sync.editRecord(a, 'r1', { price: 260 }, a.opts()));
  share(sync.editRecord(b, 'r1', { price: 270, currency: 'USD' }, b.opts()));
  share(sync.editRecord(c, 'r1', { name: 'Renamed' }, c.opts()));
  share(sync.deleteRecord(c, 'r2', c.opts()));
  share(sync.editRecord(a, 'r2', { price: 51_000 }, a.opts()));
  share(sync.createRecord(c, 'r3', { name: 'Example Cloud', price: 30 }, c.opts()));

  const results = new Set(orders(all).map((order) => snapshot(applyAll(new Map(), order))));
  assert.equal(results.size, 1, 'every order gives the same records');
  // The replicas themselves converge once they get each other's ops.
  for (const r of [a, b, c]) applyAll(r.records, all);
  assert.equal(snapshot(a.records), snapshot(b.records));
  assert.equal(snapshot(b.records), snapshot(c.records));
});

test('different fields edited on two devices: both edits survive', () => {
  const a = replica('devA');
  const b = replica('devB');
  const create = sync.createRecord(a, 'x', { name: 'Example', price: 10, notes: '' }, a.opts());
  applyAll(b.records, create);
  a.at += 1000;
  b.at += 2000;
  const ea = sync.editRecord(a, 'x', { price: 11 }, a.opts());
  const eb = sync.editRecord(b, 'x', { notes: 'shared' }, b.opts());
  applyAll(a.records, eb);
  applyAll(b.records, ea);
  for (const r of [a, b]) {
    const { fields } = r.records.get('x');
    assert.deepEqual([fields.name, fields.price, fields.notes], ['Example', 11, 'shared']);
  }
});

test('same field edited on two devices: the later stamp wins, ties go to the larger device id', () => {
  const a = replica('devA');
  const b = replica('devB');
  const create = sync.createRecord(a, 'x', { price: 10 }, a.opts());
  applyAll(b.records, create);

  a.at = T0 + 5000;
  b.at = T0 + 9000;
  const ea = sync.editRecord(a, 'x', { price: 11 }, a.opts());
  const eb = sync.editRecord(b, 'x', { price: 12 }, b.opts());
  for (const order of orders([...create, ...ea, ...eb])) {
    assert.equal(applyAll(new Map(), order).get('x').fields.price, 12, 'later wins');
  }

  // Same wall time and counter on both: decided by device id, the same way everywhere.
  const ta = replica('devA', T0);
  const tb = replica('devB', T0);
  const oa = sync.createRecord(ta, 'y', { price: 1 }, ta.opts());
  const ob = sync.createRecord(tb, 'y', { price: 2 }, tb.opts());
  assert.equal(sync.parseStamp(oa[0].t).wall, sync.parseStamp(ob[0].t).wall);
  for (const order of orders([...oa, ...ob])) {
    assert.equal(applyAll(new Map(), order).get('y').fields.price, 2, 'devB > devA');
  }
});

test('tombstone vs an older edit: the record stays deleted', () => {
  const a = replica('devA');
  const b = replica('devB');
  const create = sync.createRecord(a, 'x', { price: 10 }, a.opts());
  applyAll(b.records, create);
  b.at = T0 + 1000;
  const edit = sync.editRecord(b, 'x', { price: 11 }, b.opts());
  a.at = T0 + 2000;
  const del = sync.deleteRecord(a, 'x', a.opts());
  for (const order of orders([...create, ...edit, ...del])) {
    const x = applyAll(new Map(), order).get('x');
    assert.equal(sync.isLive(x), false);
    assert.equal(x.fields.price, 11, 'the edit is kept inside the tombstone');
  }
});

test('tombstone vs a newer edit: still deleted (per-field LWW); only an explicit undelete revives it', () => {
  const a = replica('devA');
  const b = replica('devB');
  const create = sync.createRecord(a, 'x', { price: 10 }, a.opts());
  applyAll(b.records, create);
  a.at = T0 + 1000;
  const del = sync.deleteRecord(a, 'x', a.opts());
  b.at = T0 + 2000; // b hasn't seen the delete and edits later
  const edit = sync.editRecord(b, 'x', { price: 12 }, b.opts());
  for (const order of orders([...create, ...del, ...edit])) {
    const x = applyAll(new Map(), order).get('x');
    assert.equal(sync.isLive(x), false, 'del is its own field; an edit to price does not touch it');
    assert.equal(x.fields.price, 12);
  }

  // An undelete with a later stamp brings it back with the newest values; an older one doesn't.
  const merged = applyAll(new Map(), [...create, ...del, ...edit]);
  const c = { clock: sync.receive(sync.newClock('devC'), edit[0].t, T0), records: merged };
  const undo = sync.putRecord(c, 'x', { price: 12 }, { now: T0, newId: () => 'u1' });
  assert.deepEqual(undo.map((o) => [o.f, o.v]), [['del', false]]);
  for (const order of orders([...create, ...del, ...edit, ...undo])) {
    assert.equal(sync.isLive(applyAll(new Map(), order).get('x')), true);
  }
  const stale = { ...undo[0], id: 'u0', t: sync.formatStamp(T0 + 500, 0, 'devC') };
  assert.equal(sync.isLive(applyAll(new Map(), [...create, ...del, stale]).get('x')), false);
});

test('ops arriving before the create leave a hidden record until the create lands', () => {
  const a = replica('devA');
  const create = sync.createRecord(a, 'x', { name: 'Example', price: 10 }, a.opts());
  const edit = sync.editRecord(a, 'x', { price: 11 }, a.opts());
  const m = applyAll(new Map(), edit);
  assert.equal(sync.isLive(m.get('x')), false, 'no del:false yet, so not shown');
  applyAll(m, create);
  assert.equal(sync.isLive(m.get('x')), true);
  assert.equal(m.get('x').fields.price, 11, 'the older create does not undo the edit');
});
