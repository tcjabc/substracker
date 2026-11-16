// Node tests for the pure parts of js/storage.js: turning stored items into sync-ready records
// (the migration), checking that copy, and importing old backup files as ops. The IndexedDB side
// is covered in the browser by tests/storage.html. Run with `npm test`. Fixtures are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sync from '../js/sync-core.js';
import * as storage from '../js/storage.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const NOW = Date.parse('2026-06-01T00:00:00.000Z');

const item = (over = {}) => ({
  id: 'a', type: 'expense', name: 'Example Streaming', domain: 'example.com', emoji: '', plan: 'Family',
  price: 250, currency: 'TWD', cycle: 'monthly', nextRenewal: '2030-01-01', date: '', category: 'Entertainment',
  notes: '', createdAt: T1, updatedAt: T1, ...over,
});
// The 1.0 shape: no type, date or emoji.
const v1Record = (over = {}) => ({
  id: 'old', name: 'Sample Cloud', domain: 'example.org', plan: '', price: 30, currency: 'USD', cycle: 'annual',
  nextRenewal: '', category: 'Software', notes: '', createdAt: T1, updatedAt: T1, ...over,
});

/** Migrate `items` for device `dev` and return the result plus a replica built from it. */
function migrate(items, dev = 'devA', now = NOW) {
  const built = storage.recordsFromItems(items, sync.newClock(dev), now);
  return { ...built, replica: { clock: built.clock, records: new Map(built.records.map((r) => [r.id, r])) } };
}
const live = (replica) => [...replica.records.values()].map(storage.toItem).filter(Boolean).sort((x, y) => x.id.localeCompare(y.id));
const byId = (replica, id) => storage.toItem(replica.records.get(id));

/* ------------------------------------------------------------------ Migration */

test('migration keeps ids and every field exactly, and marks records live', () => {
  const items = [v1Record(), item({ id: 'b' }), item({ id: 'c', type: 'income', name: 'Example Salary', futureField: [1, { x: 2 }] })];
  const { records, replica } = migrate(items);
  assert.deepEqual(records.map((r) => r.id), ['old', 'b', 'c']);
  for (const it of items) assert.deepEqual(byId(replica, it.id), it, `${it.id} unchanged`);
  assert.equal(JSON.stringify(byId(replica, 'old')), JSON.stringify(items[0]), 'same key order too');
  assert.equal('type' in byId(replica, 'old'), false, 'nothing is filled in');
  assert.equal(records.every(sync.isLive), true);
});

test('migration stamps each item with its updatedAt, capped at now, and queues one op per field', () => {
  const future = new Date(NOW + 86_400_000).toISOString();
  const items = [item({ id: 'a', updatedAt: T2 }), item({ id: 'b', updatedAt: future }), item({ id: 'c', updatedAt: 'garbage', createdAt: T1 }),
    item({ id: 'd', updatedAt: undefined, createdAt: undefined })];
  delete items[3].updatedAt;
  delete items[3].createdAt;
  const { records, ops, clock } = migrate(items);
  const wall = (id) => new Set(Object.values(records.find((r) => r.id === id).ts).map((t) => sync.parseStamp(t).wall));
  assert.deepEqual([...wall('a')], [Date.parse(T2)]);
  assert.deepEqual([...wall('b')], [NOW], 'a future updatedAt is capped at now');
  assert.deepEqual([...wall('c')], [Date.parse(T1)], 'falls back to createdAt');
  assert.deepEqual([...wall('d')], [0], 'no dates: oldest possible');

  const fields = records.reduce((n, r) => n + Object.keys(r.fields).length, 0);
  assert.equal(ops.length, fields, 'one op per field, del included');
  assert.equal(ops.every(sync.isOp), true);
  // The clock is past every migration stamp, so the next local edit wins over them.
  const next = sync.tick(clock, NOW).stamp;
  assert.equal(ops.every((op) => sync.compare(op.t, next) < 0), true);
});

test('migration is repeatable: the same items give the same records', () => {
  const items = [v1Record(), item()];
  assert.deepEqual(migrate(items).records, migrate(items).records);
});

test('migration refuses data it cannot represent instead of changing it', () => {
  assert.throws(() => migrate([item({ price: NaN })]), /unusable "price"/);
  assert.throws(() => migrate([item({ id: 42 })]), /unusable id/);
  assert.throws(() => migrate([item({ id: 'x'.repeat(65) })]), /unusable id/);
});

test('verifyRecords passes a faithful copy and names what is wrong otherwise (counts only)', () => {
  const items = [v1Record(), item(), item({ id: 'b' })];
  const { records, ops } = migrate(items);
  assert.equal(storage.verifyRecords(items, records, ops), null);
  assert.equal(storage.verifyRecords([], [], []), null, 'empty is fine');

  assert.match(storage.verifyRecords(items, records.slice(1), ops), /3 items, 2 records/);
  const changed = records.map((r) => (r.id === 'a' ? { ...r, fields: { ...r.fields, price: 1 } } : r));
  assert.match(storage.verifyRecords(items, changed, ops), /1 of 3 records differ/);
  const dead = records.map((r) => (r.id === 'a' ? { ...r, fields: { ...r.fields, del: true } } : r));
  assert.match(storage.verifyRecords(items, dead, ops), /1 of 3 records differ/);
  assert.match(storage.verifyRecords(items, records, ops.slice(1)), /without a matching op/);
  assert.doesNotMatch(storage.verifyRecords(items, changed, ops), /Example|Sample/, 'no item contents');
});

test('two devices that migrated copies of the same item converge on the newer copy', () => {
  // The same item moved between devices by a backup, then edited on B before the update.
  const onA = migrate([item({ price: 250, updatedAt: T1 })], 'devA');
  const onB = migrate([item({ price: 300, notes: 'B', updatedAt: T2 })], 'devB');
  for (const op of onB.ops) sync.applyOp(onA.replica.records, op);
  for (const op of onA.ops) sync.applyOp(onB.replica.records, op);
  assert.deepEqual(byId(onA.replica, 'a'), byId(onB.replica, 'a'));
  assert.deepEqual([byId(onA.replica, 'a').price, byId(onA.replica, 'a').notes], [300, 'B']);
});

/* ------------------------------------------------------------------ Import of old exports */

/** Import a backup into `replica` the way importAll does, and return the plan summary and ops. */
function importInto(replica, file, mode) {
  const backup = storage.parseBackup(file);
  const plan = storage.planFromBackup(backup, live(replica), { groupColors: { Mine: 'g4' } })[mode];
  const ops = storage.importOps(replica, plan, { now: NOW });
  return { plan, ops };
}

test('imports a 1.0 (version 1) export: records get ids kept, missing fields filled, timestamps', () => {
  const { replica } = migrate([]);
  const { plan, ops } = importInto(replica, JSON.stringify({ format: 'substracker', version: 1, settings: { defaultCurrency: 'TWD' }, subscriptions: [v1Record()] }), 'merge');
  assert.equal(plan.summary.added, 1);
  assert.equal(plan.summary.withSettings, true);
  const got = byId(replica, 'old');
  assert.deepEqual([got.type, got.date, got.emoji, got.price], ['expense', '', '', 30]);
  assert.equal(ops.every(sync.isOp), true);
  assert.equal(Object.values(replica.records.get('old').ts).every(sync.isStamp), true);
});

test('imports 1.1–1.2 (version 2) and 1.3 (schemaVersion 3) exports by id, newer updatedAt wins', () => {
  const { replica } = migrate([item({ id: 'a', price: 1, updatedAt: T1 }), item({ id: 'b', price: 1, updatedAt: T2 })]);
  importInto(replica, { format: 'substracker', version: 2, settings: {}, items: [item({ id: 'v2', price: 5 })] }, 'merge');
  const { plan } = importInto(replica, {
    app: 'substracker', schemaVersion: 3, exportedAt: T2, settings: { groupColors: { Entertainment: 'g2' } },
    items: [item({ id: 'a', price: 2, updatedAt: T2 }), item({ id: 'b', price: 2, updatedAt: T1 })],
  }, 'merge');
  assert.deepEqual([plan.summary.added, plan.summary.updated, plan.summary.kept], [0, 1, 1]);
  assert.deepEqual(plan.settings, { groupColors: { Entertainment: 'g2' } }, 'old files still bring colours (as a patch)');
  assert.deepEqual(plan.localSettings, { groupColors: { Mine: 'g4', Entertainment: 'g2' } }, 'merged for an unshared device');
  assert.deepEqual(live(replica).map((s) => [s.id, s.price]), [['a', 2], ['b', 1], ['v2', 5]]);
});

test('a schemaVersion 4 export restores currency and colours; other settings in a file are ignored', () => {
  const { replica } = migrate([item()]);
  const file = {
    app: 'substracker', schemaVersion: 4, exportedAt: T2, items: live(replica),
    settings: { defaultCurrency: 'usd', groupColors: { Entertainment: 'g2' }, pro: true, palette: 'ocean' },
  };
  const plans = storage.planFromBackup(storage.parseBackup(JSON.stringify(file)), [], { groupColors: { Mine: 'g4' } });
  assert.deepEqual(plans.replace.settings, { groupColors: { Entertainment: 'g2' }, defaultCurrency: 'USD' });
  assert.deepEqual(plans.merge.settings, { groupColors: { Entertainment: 'g2' } });
  assert.deepEqual(plans.merge.localSettings, { groupColors: { Mine: 'g4', Entertainment: 'g2' } });
  assert.deepEqual(plans.replace.localSettings, plans.replace.settings);
  assert.equal(plans.replace.summary.withSettings, true);
  assert.deepEqual(storage.BACKUP_SETTINGS, ['defaultCurrency', 'groupColors']);
});

test('a file without settings leaves settings alone', () => {
  const { replica } = migrate([item()]);
  const backup = storage.parseBackup({ app: 'substracker', schemaVersion: 4, items: live(replica) });
  const plans = storage.planFromBackup(backup, [], { groupColors: { Mine: 'g4' } });
  assert.deepEqual([plans.merge.settings, plans.replace.settings], [{}, {}]);
  assert.equal(plans.replace.summary.withSettings, false);
});

test('import only records fields that change, and an unchanged merge makes no ops', () => {
  const { replica } = migrate([item({ price: 1, updatedAt: T1 })]);
  const { ops } = importInto(replica, { app: 'substracker', schemaVersion: 3, items: [item({ price: 2, updatedAt: T2 })] }, 'merge');
  assert.deepEqual(ops.map((o) => o.f).sort(), ['price', 'updatedAt']);
  assert.deepEqual(importInto(replica, { app: 'substracker', schemaVersion: 3, items: [item({ price: 2, updatedAt: T2 })] }, 'merge').ops, []);
});

test('replace tombstones items not in the file instead of removing them', () => {
  const { replica } = migrate([item({ id: 'gone' }), item({ id: 'a' })]);
  const { plan, ops } = importInto(replica, { app: 'substracker', schemaVersion: 3, items: [item({ id: 'a' }), item({ id: 'new' })] }, 'replace');
  assert.deepEqual([plan.summary.removed, plan.summary.added], [1, 1]);
  assert.equal(replica.records.has('gone'), true, 'still stored');
  assert.equal(sync.isLive(replica.records.get('gone')), false, 'but deleted');
  assert.deepEqual(live(replica).map((s) => s.id), ['a', 'new']);
  assert.deepEqual(ops.filter((o) => o.rec === 'gone').map((o) => [o.f, o.v]), [['del', true]]);
});

test('importing a backup that has an item deleted here brings it back', () => {
  const { replica } = migrate([item()]);
  sync.deleteRecord(replica, 'a', { now: NOW });
  assert.deepEqual(live(replica), []);
  const { plan } = importInto(replica, { app: 'substracker', schemaVersion: 3, items: [item()] }, 'merge');
  assert.equal(plan.summary.added, 1, 'counts as new, as before');
  assert.deepEqual(live(replica), [item()]);
});

test('the strict checks still reject bad files', () => {
  assert.throws(() => storage.parseBackup('[]'), storage.ImportError);
  assert.throws(() => storage.parseBackup({ app: 'substracker', schemaVersion: 4, items: [item({ price: '30' })] }), /"price"/);
  assert.throws(() => storage.parseBackup({ app: 'substracker', schemaVersion: 4, items: [item(), item()] }), /same as item 1/);
  assert.throws(() => storage.parseBackup({ app: 'substracker', schemaVersion: 4, items: [item({ id: 'x'.repeat(65) })] }), /1–64/);
});
