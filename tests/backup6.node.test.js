// Node tests for backup format 6 (1.26.0, docs/plan-cards.md): format 5 plus the household's cards
// (settings.cards) and each item's `pay`. The importer (filePay, fileCards, planFromBackup,
// importChange: Merge adds and updates cards, Replace takes the file's set; every written field is
// read back from the record) and the writer (exportBackupFrom: format 6 only with a card or a pay,
// else format 5 byte for byte as 1.25.1 wrote it; the export check with the cards and pay; the
// fallback). Run with `npm test`. The data is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../js/sync-core.js';
import * as storage from '../js/storage.js';
import * as cards from '../js/cards.js';

let n = 0;
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const AT = '2026-11-23T00:00:00.000Z';
const item = (over = {}) => ({
  id: 'a', type: 'expense', name: 'Sample class', domain: '', emoji: '', plan: '', price: 150, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-12-05', date: '', category: 'Hobbies', notes: '', createdAt: T1, updatedAt: T1, ...over,
});
const fileOf = (items, extra = {}) => ({ app: 'substracker', schemaVersion: 6, exportedAt: T2, items, ...extra });
const replicaOf = (dev = 'devA') => ({ clock: core.newClock(dev), records: new Map() });
const opts = (now) => ({ now, newId: () => `op-${++n}` });
const liveOf = (r) => [...r.records.values()].filter((x) => x.id !== storage.SETTINGS_ID).map(storage.toItem).filter(Boolean);
const fieldsOf = (r) => r.records.get(storage.SETTINGS_ID)?.fields ?? {};
const VISA = { name: 'Visa', colour: 'w3', cut: 25, due: 10 };
const AMEX = { name: 'Amex', colour: '', cut: null, due: 5 };

/** Import `file` into replica `r` in `mode`, as importAll does with shared settings. Returns the ops. */
function importInto(r, file, mode, now = 5000) {
  const plan = storage.planFromBackup(storage.parseBackup(JSON.stringify(file)), liveOf(r), storage.effectiveSettings({}, r.records.get(storage.SETTINGS_ID)))[mode];
  return storage.importChange(r, plan, opts(now));
}

/** A replica holding cards and items as a household would, written the only way the app writes them. */
function household() {
  const r = replicaOf();
  core.putRecord(r, 'a', { ...item(), pay: 'visa1' }, opts(1000));
  core.putRecord(r, 'b', item({ id: 'b', name: 'Sample gym' }), opts(1000));
  storage.cardOps(r, 'visa1', VISA, opts(1100));
  storage.cardOps(r, 'amex1', AMEX, opts(1100));
  return r;
}

/* ------------------------------------------------------------------ Reading a file */

test('filePay: a usable pay from a file of any version; Not set from format 6; nothing from older formats', () => {
  for (const v of [3, 4, 5, 6]) {
    assert.equal(storage.filePay({ pay: 'cash' }, v), 'cash');
    assert.equal(storage.filePay({ pay: 'c_1' }, v), 'c_1');
    assert.equal(storage.filePay({ pay: '' }, v), '');
  }
  for (const odd of [undefined, null, 7, {}, 'a-b', 'CASH']) {
    assert.equal(storage.filePay({ pay: odd }, 6), '', `format 6: ${JSON.stringify(odd)} reads as Not set`);
    assert.equal(storage.filePay({ pay: odd }, 5), undefined, `format 5: ${JSON.stringify(odd)} leaves pay alone`);
  }
});

test('a format 6 file parses: items keep a usable pay, the rest read as Not set; cards come through settings', () => {
  const file = fileOf([item({ pay: 'visa1' }), item({ id: 'b', pay: { x: 1 } }), item({ id: 'c' }), item({ id: 'd', pay: 'cash' })],
    { settings: { groupColors: {}, cards: { visa1: VISA, 'bad-id': VISA, cash: VISA, noname: { name: '' }, old: { name: 'Old', gone: true }, junk: 7 } } });
  const parsed = storage.parseBackup(JSON.stringify(file));
  assert.deepEqual(parsed.items.map(({ item: it }) => [it.id, it.pay]), [['a', 'visa1'], ['b', ''], ['c', ''], ['d', 'cash']]);
  const plan = storage.planFromBackup(parsed, [], {});
  assert.deepEqual(plan.merge.settings.cards, { visa1: VISA }, 'only usable cards with ids every version accepts');
  assert.deepEqual(plan.replace.settings.cards, { visa1: VISA });
  assert.equal(plan.merge.summary.newerVersion, false, 'format 6 is this version\'s own');
});

test('a format 5 file without pay or cards plans exactly as before: no pay on items, no cards in the settings change', () => {
  const file = { ...fileOf([item(), item({ id: 'b' })]), schemaVersion: 5, settings: { groupColors: { Hobbies: 'w5' } } };
  const plan = storage.planFromBackup(storage.parseBackup(JSON.stringify(file)), [], {});
  assert.ok(plan.merge.writes.every((it) => !('pay' in it)));
  assert.ok(!('cards' in plan.merge.settings) && !('cards' in plan.replace.settings));
});

/* ------------------------------------------------------------------ Writing an import */

test('import into an empty store: cards via setFields on the settings record, pay on the items; read back from the record', () => {
  const r = replicaOf('devB');
  const file = fileOf([item({ pay: 'visa1' }), item({ id: 'b', name: 'Sample gym' }), item({ id: 'c', name: 'Sample shop', pay: 'cash' })],
    { settings: { groupColors: {}, cards: { visa1: VISA, amex1: AMEX } } });
  const ops = importInto(r, file, 'replace');
  assert.ok(ops.every(core.isOp), 'every op valid');
  const cardOps = ops.filter((o) => o.f.startsWith('card_'));
  assert.ok(cardOps.every((o) => o.rec === storage.SETTINGS_ID), 'cards only on the settings record');
  assert.ok(!ops.some((o) => o.rec === storage.SETTINGS_ID && o.f === 'del'), 'the settings record never gets del');
  assert.ok(!ops.some((o) => o.rec.startsWith('card_') || o.rec === 'visa1'), 'no card is ever a record of its own');
  // Read-back: the written card fields and pay, from the record itself.
  assert.deepEqual(fieldsOf(r).card_visa1, VISA);
  assert.deepEqual(fieldsOf(r).card_amex1, AMEX);
  assert.deepEqual(liveOf(r).map((x) => [x.id, x.pay]).sort(), [['a', 'visa1'], ['b', undefined], ['c', 'cash']], 'Not set over no pay writes nothing');
  assert.ok(!ops.some((o) => o.rec === 'b' && o.f === 'pay'));
  assert.deepEqual(cards.listCards(r.records.get(storage.SETTINGS_ID)).map((c) => c.id), ['amex1', 'visa1']);
  assert.equal(liveOf(r).length, 3, 'no ghost item');
});

test('Merge adds and updates cards and deletes none; a card already as the file says is left as it is', () => {
  const r = household();
  core.setFields(r, storage.SETTINGS_ID, { card_amex1: { ...AMEX, later: 'kept' } }, opts(1200));
  const file = fileOf([item({ updatedAt: T2, pay: 'mc1' })], { settings: { groupColors: {}, cards: { mc1: { name: 'Master' }, amex1: AMEX, visa1: { ...VISA, due: 12 } } } });
  const ops = importInto(r, file, 'merge');
  const f = fieldsOf(r);
  assert.deepEqual(f.card_mc1, { name: 'Master', colour: '', cut: null, due: null }, 'added');
  assert.equal(f.card_visa1.due, 12, 'updated');
  assert.deepEqual(f.card_amex1, { ...AMEX, later: 'kept' }, 'already as the file says: not rewritten, later keys kept');
  assert.ok(!ops.some((o) => o.f === 'card_amex1'));
  assert.ok(!Object.values(f).some((v) => v?.gone === true), 'Merge deletes no card');
  assert.equal(storage.toItem(r.records.get('a')).pay, 'mc1', 'the newer item brings its pay');
  assert.equal(storage.toItem(r.records.get('b')).pay, undefined, 'an item not in the file is untouched');
});

test('Replace takes the file\'s cards: one the file lacks becomes a tombstone; pay follows the file, Not set over a stored pay', () => {
  const r = household();
  const file = fileOf([item({ pay: '' }), item({ id: 'b', name: 'Sample gym', pay: 'visa1' })], { settings: { groupColors: {}, cards: { visa1: VISA } } });
  importInto(r, file, 'replace');
  const f = fieldsOf(r);
  assert.deepEqual(f.card_visa1, VISA, 'kept');
  assert.deepEqual(f.card_amex1, { ...AMEX, gone: true }, 'not in the file: deleted as a tombstone, its value kept');
  assert.deepEqual(cards.listCards(r.records.get(storage.SETTINGS_ID)).map((c) => c.id), ['visa1']);
  assert.equal(storage.toItem(r.records.get('a')).pay, '', 'Not set in the file clears a stored pay');
  assert.equal(storage.toItem(r.records.get('b')).pay, 'visa1');
  assert.ok(!('del' in f));
});

test('Replace with a format 6 file that has no cards deletes every card; with a format 5 file, cards and pay are left alone', () => {
  const r6 = household();
  importInto(r6, fileOf([item({ pay: 'cash' })], { settings: { groupColors: {}, cards: {} } }), 'replace');
  assert.deepEqual(cards.listCards(r6.records.get(storage.SETTINGS_ID)), [], 'format 6 says the household has no cards');
  const r5 = household();
  const before = JSON.stringify(Object.entries(fieldsOf(r5)).filter(([k]) => k.startsWith('card_')));
  importInto(r5, { ...fileOf([item(), item({ id: 'b', name: 'Sample gym' })]), schemaVersion: 5, settings: { groupColors: {} } }, 'replace');
  assert.equal(JSON.stringify(Object.entries(fieldsOf(r5)).filter(([k]) => k.startsWith('card_'))), before, 'format 5: cards untouched');
  assert.equal(storage.toItem(r5.records.get('a')).pay, 'visa1', 'format 5 can\'t say how an item is paid: the stored pay stays');
});

test('a deleted card the file has comes back on import; an import never writes a field with a dash', () => {
  const r = household();
  storage.removeCardOps(r, 'amex1', opts(1500));
  const ops = importInto(r, fileOf([item()], { settings: { cards: { amex1: AMEX, 'a-b': VISA, ['x'.repeat(60)]: VISA } } }), 'merge');
  assert.deepEqual(fieldsOf(r).card_amex1, AMEX, 'back');
  assert.ok(ops.every((o) => core.isFieldName(o.f)), 'every field name valid on every version');
  assert.ok(!Object.keys(fieldsOf(r)).some((k) => k.includes('-')));
});

test('a bad file changes nothing: parseBackup throws before any op', () => {
  const r = household();
  const before = JSON.stringify([...r.records]);
  assert.throws(() => importInto(r, fileOf([item({ price: -1 })], { settings: { cards: { visa2: VISA } } }), 'replace'), storage.ImportError);
  assert.throws(() => importInto(r, { ...fileOf([item()]), settings: 'nope' }, 'merge'), storage.ImportError);
  assert.equal(JSON.stringify([...r.records]), before);
});
