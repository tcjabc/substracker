// Node tests for the shared settings record in js/storage.js (default currency and group colours):
// convergence between replicas, "unset never beats set", per-group merging, the record never
// showing up as an item, the upgrade seeding, and imports/exports. Pure functions only; the
// IndexedDB side is covered in the browser by tests/storage.html. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sync from '../js/sync-core.js';
import * as storage from '../js/storage.js';

const { SETTINGS_ID } = storage;
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const T1 = '2026-01-01T00:00:00.000Z';
let seq = 0;
const newId = () => `op-${++seq}`;

const item = (over = {}) => ({
  id: 'a', type: 'expense', name: 'Example Streaming', domain: 'example.com', emoji: '', plan: '',
  price: 250, currency: 'TWD', cycle: 'monthly', nextRenewal: '', date: '', category: 'Entertainment',
  notes: '', createdAt: T1, updatedAt: T1, ...over,
});

/** A device: a replica plus the ops it has made so far. */
function replica(dev, items = []) {
  const built = storage.recordsFromItems(items, sync.newClock(dev), T0);
  return { clock: built.clock, records: new Map(built.records.map((r) => [r.id, r])), sent: [...built.ops] };
}
const change = (r, patch, now, opts = {}) => {
  const ops = storage.settingsOps(r, patch, { now, newId, ...opts });
  r.sent.push(...ops);
  return ops;
};
/** Deliver every op each replica has made to every other one (in a shuffled order), like the relay. */
function exchange(...reps) {
  for (const to of reps) {
    const incoming = reps.filter((r) => r !== to).flatMap((r) => r.sent);
    const shuffled = [...incoming].sort(() => Math.random() - 0.5);
    storage.applyRemoteOps(to, shuffled, T0);
  }
}
const shared = (r) => storage.settingsFromRecord(r.records.get(SETTINGS_ID));
const items = (r) => [...r.records.values()].map(storage.toItem).filter(Boolean);

/* ------------------------------------------------------------------ Convergence */

test('three replicas converge on currency and colours whatever order the ops arrive in', () => {
  const a = replica('devA');
  const b = replica('devB');
  const c = replica('devC');
  change(a, { defaultCurrency: 'eur', groupColors: { Food: 'g2' } }, T0 + 1000);
  change(b, { defaultCurrency: 'TWD' }, T0 + 2000);
  change(c, { groupColors: { Travel: 'g5', Food: 'g7' } }, T0 + 500);
  exchange(a, b, c);
  exchange(a, b, c); // twice: idempotent
  for (const r of [a, b, c]) {
    assert.deepEqual(shared(r), { defaultCurrency: 'TWD', groupColors: { Food: 'g2', Travel: 'g5' } }, r.clock.dev);
  }
  assert.deepEqual(a.records.get(SETTINGS_ID), b.records.get(SETTINGS_ID));
  assert.deepEqual(b.records.get(SETTINGS_ID), c.records.get(SETTINGS_ID));
});

test('concurrent colour edits to different groups both survive; the same group takes the later stamp', () => {
  const a = replica('devA');
  const b = replica('devB');
  change(a, { groupColors: { Food: 'g1' } }, T0 + 1000);
  change(b, { groupColors: { Home: 'g3' } }, T0 + 1000);
  exchange(a, b);
  assert.deepEqual(shared(a).groupColors, { Food: 'g1', Home: 'g3' });
  change(a, { groupColors: { Food: 'g4' } }, T0 + 5000);
  change(b, { groupColors: { Food: 'g6' } }, T0 + 3000); // earlier, even though b's op is made after a's
  exchange(a, b);
  assert.deepEqual([shared(a).groupColors.Food, shared(b).groupColors.Food], ['g4', 'g4']);
});

test('an explicit local value wins only with a later stamp', () => {
  const a = replica('devA');
  const b = replica('devB');
  change(a, { defaultCurrency: 'USD' }, T0 + 9000);
  change(b, { defaultCurrency: 'JPY' }, T0 + 1000); // older choice
  exchange(a, b);
  assert.equal(shared(b).defaultCurrency, 'USD', 'the older local choice loses');
  change(b, { defaultCurrency: 'JPY' }, T0 + 1000); // b has now seen a's stamp, so this is later
  exchange(a, b);
  assert.deepEqual([shared(a).defaultCurrency, shared(b).defaultCurrency], ['JPY', 'JPY']);
});

/* ------------------------------------------------------------------ Unset never beats set */

test('a device that never chose a currency sends nothing and adopts the household value', () => {
  const household = replica('devA', [item()]);
  change(household, { defaultCurrency: 'TWD' }, T0);
  const fresh = replica('devB');
  // The fresh device's own pick (its locale) lives in its settings store only, never as an op.
  const local = { autoCurrency: 'GBP', autoGroupColors: { Entertainment: 'g9' } };
  assert.equal(fresh.sent.length, 0, 'nothing to send');
  assert.deepEqual(storage.requeueOps([...fresh.records.values()]), [], 'joining sends nothing either');
  assert.equal(storage.effectiveSettings(local, fresh.records.get(SETTINGS_ID)).defaultCurrency, 'GBP', 'before joining');

  exchange(household, fresh);
  const after = storage.effectiveSettings(local, fresh.records.get(SETTINGS_ID));
  assert.equal(after.defaultCurrency, 'TWD', 'adopts the household currency');
  assert.deepEqual(after.groupColors, { Entertainment: 'g9' }, 'its own pick fills groups the household has no colour for');
  assert.equal(shared(household).defaultCurrency, 'TWD', 'the household is unchanged');
});

test('a household colour replaces the device\'s automatic one', () => {
  const r = replica('devA');
  change(r, { groupColors: { Entertainment: 'g2' } }, T0);
  const view = storage.effectiveSettings({ autoGroupColors: { Entertainment: 'g9', Home: 'g1' } }, r.records.get(SETTINGS_ID));
  assert.deepEqual(view.groupColors, { Home: 'g1', Entertainment: 'g2' });
});

test('effectiveSettings ignores the old per-device copies once settings are shared, and keeps other keys', () => {
  const view = storage.effectiveSettings({ defaultCurrency: 'GBP', groupColors: { Old: 'g1' }, pro: true }, undefined);
  assert.deepEqual(view, { pro: true, groupColors: {} });
});

test('an unchanged value makes no ops', () => {
  const r = replica('devA');
  change(r, { defaultCurrency: 'TWD', groupColors: { Food: 'g1' } }, T0);
  assert.deepEqual(change(r, { defaultCurrency: 'twd', groupColors: { Food: 'g1' } }, T0 + 1), []);
  assert.deepEqual(change(r, {}, T0 + 2), []);
});

/* ------------------------------------------------------------------ Never an item */

test('the settings record never shows up as an item, a count or a total', () => {
  const r = replica('devA', [item(), item({ id: 'b', price: 10 })]);
  change(r, { defaultCurrency: 'TWD', groupColors: { Entertainment: 'g2' } }, T0);
  const rec = r.records.get(SETTINGS_ID);
  assert.equal(sync.DELETED in rec.fields, false, 'no del field');
  assert.equal(sync.isLive(rec), false, 'not live');
  assert.equal(storage.toItem(rec), null);
  assert.deepEqual(items(r).map((s) => s.id).sort(), ['a', 'b']);
  assert.equal(items(r).reduce((n, s) => n + s.price, 0), 260);
});

test('remote ops that would turn the settings record into an item, or carry bad values, are skipped', () => {
  const r = replica('devA');
  const t = sync.formatStamp(T0, 0, 'evil');
  const op = (f, v) => ({ id: newId(), rec: SETTINGS_ID, f, v, t, dev: 'evil' });
  const out = storage.applyRemoteOps(r, [
    op('del', false), op('name', 'Fake'),
    op('defaultCurrency', 'euro'), op('defaultCurrency', 12),
    op(storage.colorField('Food'), { name: 'Other', swatch: 'g1' }), // field doesn't match the name
    op(storage.colorField('Food'), 'g1'),
    op(storage.colorField('Food'), { name: 'Food', swatch: 'g1' }), // the one good op
  ], T0);
  assert.equal(out.skipped, 5, 'del and the four bad values; an unknown field is kept for newer versions');
  assert.equal(sync.isLive(r.records.get(SETTINGS_ID)), false);
  assert.deepEqual(items(r), []);
  assert.deepEqual(shared(r).groupColors, { Food: 'g1' });
});

test('a replace import never tombstones the settings record, and a backup can\'t use its id', () => {
  const r = replica('devA', [item()]);
  change(r, { defaultCurrency: 'TWD' }, T0);
  const plan = storage.planFromBackup(storage.parseBackup({ app: 'substracker', schemaVersion: 4, items: [item({ id: 'b' })] }), items(r), {}).replace;
  storage.importOps(r, plan, { now: T0 + 1, newId });
  assert.equal(r.records.get(SETTINGS_ID).fields.del, undefined);
  assert.equal(shared(r).defaultCurrency, 'TWD');
  assert.throws(() => storage.parseBackup({ app: 'substracker', schemaVersion: 4, items: [item({ id: SETTINGS_ID })] }), /reserved/);
});

/* ------------------------------------------------------------------ Upgrade seeding */

test('seeding copies stored settings once with a stamp of now, and is idempotent', () => {
  const r = replica('devA', [item()]);
  const stored = storage.storedSharedSettings({ defaultCurrency: 'twd', groupColors: { Entertainment: 'g2', Bad: 5 }, pro: true });
  assert.deepEqual(stored, { defaultCurrency: 'TWD', groupColors: { Entertainment: 'g2' } }, 'only the two settings, cleaned');
  assert.ok(storage.verifySettingsSeed(stored, r.records.get(SETTINGS_ID)), 'not seeded yet');
  const ops = storage.seedSettingsOps(r, stored, { now: T0 + 60_000, newId });
  assert.equal(ops.length, 2);
  assert.equal(new Set(ops.map((o) => o.t)).size, 1, 'one stamp');
  assert.ok(sync.parseStamp(ops[0].t).wall >= T0 + 60_000, 'stamped at migration time, not from item dates');
  assert.equal(storage.verifySettingsSeed(stored, r.records.get(SETTINGS_ID)), null);
  assert.deepEqual(storage.seedSettingsOps(r, stored, { now: T0 + 120_000, newId }), [], 'a re-run adds nothing');
});

test('seeding leaves fields the household already set alone', () => {
  const household = replica('devA');
  change(household, { defaultCurrency: 'EUR' }, T0);
  const upgraded = replica('devB');
  exchange(household, upgraded);
  const ops = storage.seedSettingsOps(upgraded, { defaultCurrency: 'GBP', groupColors: { Food: 'g3' } }, { now: T0 + 1000, newId });
  assert.deepEqual(ops.map((o) => o.f), [storage.colorField('Food')], 'only the missing colour');
  assert.equal(shared(upgraded).defaultCurrency, 'EUR');
  assert.equal(storage.verifySettingsSeed({ defaultCurrency: 'GBP', groupColors: { Food: 'g3' } }, upgraded.records.get(SETTINGS_ID)), null);
});

test('nothing stored seeds nothing', () => {
  const r = replica('devA');
  const stored = storage.storedSharedSettings({});
  assert.deepEqual(storage.seedSettingsOps(r, stored, { now: T0, newId }), []);
  assert.equal(storage.verifySettingsSeed(stored, undefined), null);
});

/* ------------------------------------------------------------------ Import / export */

test('import restores settings as ops: merge patches colours, replace takes the file\'s set', () => {
  const r = replica('devA', [item()]);
  change(r, { defaultCurrency: 'USD', groupColors: { Entertainment: 'g1', Old: 'g4' } }, T0);
  const file = { app: 'substracker', schemaVersion: 4, items: [item()], settings: { defaultCurrency: 'eur', groupColors: { Entertainment: 'g2' } } };
  const plans = storage.planFromBackup(storage.parseBackup(file), items(r), storage.settingsFromRecord(r.records.get(SETTINGS_ID)));

  const m = replica('devA', [item()]);
  change(m, { defaultCurrency: 'USD', groupColors: { Entertainment: 'g1', Old: 'g4' } }, T0);
  storage.settingsOps(m, plans.merge.settings, { now: T0 + 1, newId });
  assert.deepEqual(shared(m), { defaultCurrency: 'USD', groupColors: { Entertainment: 'g2', Old: 'g4' } }, 'merge keeps the currency');

  const ops = storage.settingsOps(r, plans.replace.settings, { now: T0 + 1, newId, replaceColors: true });
  assert.deepEqual(shared(r), { defaultCurrency: 'EUR', groupColors: { Entertainment: 'g2' } }, 'replace');
  assert.ok(ops.some((o) => o.f === storage.colorField('Old') && o.v === null), 'the dropped colour is cleared for everyone');
});

test('old export formats still import their settings', () => {
  const v1 = storage.parseBackup({ format: 'substracker', version: 1, settings: { defaultCurrency: 'TWD' }, subscriptions: [item({ id: 'x' })] });
  assert.deepEqual(storage.planFromBackup(v1, [], {}).replace.settings, { groupColors: {}, defaultCurrency: 'TWD' });
  const v3 = storage.parseBackup({ app: 'substracker', schemaVersion: 3, settings: { groupColors: { Food: 'g2' } }, items: [item()] });
  const r = replica('devA');
  storage.settingsOps(r, storage.planFromBackup(v3, [], {}).merge.settings, { now: T0, newId });
  assert.deepEqual(shared(r).groupColors, { Food: 'g2' });
});

test('the export allowlist is exactly the shared settings (format 5 adds the palette slots of the colours)', () => {
  assert.deepEqual(storage.BACKUP_SETTINGS, ['defaultCurrency', 'groupColors', 'groupSlots']);
  const view = storage.effectiveSettings({ autoCurrency: 'GBP', autoGroupColors: { A: 'g1' }, pro: true, palette: 'ocean' }, undefined);
  const kept = Object.fromEntries(storage.BACKUP_SETTINGS.filter((k) => view[k] !== undefined).map((k) => [k, view[k]]));
  assert.deepEqual(kept, { defaultCurrency: 'GBP', groupColors: { A: 'g1' } }, 'what exportAll keeps: no pro, palette or auto keys');
});

test('colorField is stable, valid as a field name and distinct for different names', () => {
  assert.equal(storage.colorField('Food'), storage.colorField('Food'));
  const names = ['Food', 'food', 'Entertainment', 'Uncategorised', '外食', 'A'.repeat(40), 'Home & garden'];
  const fields = names.map(storage.colorField);
  assert.equal(new Set(fields).size, names.length);
  assert.ok(fields.every((f) => sync.isFieldName(f) && /^color_[0-9a-f]{16}$/.test(f)));
});
