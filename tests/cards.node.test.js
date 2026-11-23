// Node tests for the payment-card groundwork (1.26.0): js/cards.js (ids, field names, tolerant
// reading, tombstones, listCards, payOf) and the storage plumbing (`pay` in ITEM_FIELDS but never
// checked on a remote op, cards on the settings record through setFields only, settingsFromRecord
// and effectiveSettings exposing them). Run with `npm test`. The data is made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cards from '../js/cards.js';
import * as storage from '../js/storage.js';
import * as core from '../js/sync-core.js';
import * as legacy from './legacy-1.19.0/storage.js';

let n = 0;
const newId = () => `op-${++n}`;
const NOW = new Date(2026, 10, 23, 12).getTime();
const replicaOf = (dev = 'devA') => ({ clock: core.newClock(dev), records: new Map() });
const remoteOp = (rec, f, v, dev = 'devB', wall = NOW) => ({ id: newId(), rec, f, v, t: core.formatStamp(wall, 0, dev), dev });

/* ------------------------------------------------------------------ Ids and field names */

test('card ids: letters, digits and _ only, 1-59 characters, never cash in any case', () => {
  for (const id of ['a', 'Visa1', 'c_9f3a', 'x'.repeat(59), '0', '_']) assert.ok(cards.isCardId(id), id);
  for (const id of ['', 'a-b', 'a b', 'é', 'x'.repeat(60), 'cash', 'CASH', 'Cash', null, 7, {}, undefined]) assert.ok(!cards.isCardId(id), String(id));
  assert.equal(cards.CARD_ID_MAX, 59);
});

test('a card field name always passes sync-core\'s field-name rule, on this version and 1.19.0', () => {
  for (const id of ['a', '0', '_', 'x'.repeat(59), 'Z9_z']) {
    const f = cards.cardFieldName(id);
    assert.equal(f, `card_${id}`);
    assert.ok(core.isFieldName(f), f);
    assert.ok(f.length <= 64);
    assert.equal(cards.cardIdOf(f), id);
  }
  assert.equal(cards.cardFieldName('a-b'), null, 'a dash never becomes a field name');
  assert.equal(cards.cardFieldName('cash'), null);
  assert.equal(cards.cardFieldName('x'.repeat(60)), null);
  assert.ok(!core.isFieldName('card_a-b'), 'the rule every version applies (js/sync-core.js:151)');
  for (const f of ['color_x', 'card_', 'card_a-b', 'cards_a', 'app_0123', 7]) assert.equal(cards.cardIdOf(f), null, String(f));
});

/* ------------------------------------------------------------------ Values */

test('parseCardValue is tolerant: a name is all a live card needs; odd parts read as empty', () => {
  assert.deepEqual(cards.parseCardValue({ name: ' Visa ', colour: 'w3', cut: 25, due: 10 }), { name: 'Visa', colour: 'w3', cut: 25, due: 10 });
  assert.deepEqual(cards.parseCardValue({ name: 'Visa' }), { name: 'Visa', colour: '', cut: null, due: null });
  assert.deepEqual(cards.parseCardValue({ name: 'Visa', colour: 7, cut: 0, due: 32, later: [1] }), { name: 'Visa', colour: '', cut: null, due: null });
  assert.deepEqual(cards.parseCardValue({ name: 'Visa', cut: 2.5, due: '10' }), { name: 'Visa', colour: '', cut: null, due: null });
  assert.equal(cards.parseCardValue({ name: 'x'.repeat(41) }).name, 'x'.repeat(40), 'a nickname is cut to 40');
  assert.equal(cards.parseCardValue({ name: '日'.repeat(40) }).name.length, 40);
  for (const v of [null, undefined, 'Visa', 7, [], { name: '' }, { name: '   ' }, { name: 7 }, { colour: 'w1' }]) assert.equal(cards.parseCardValue(v), null, JSON.stringify(v));
  assert.deepEqual(cards.parseCardValue({ name: 'Visa', gone: true }), { gone: true });
  assert.deepEqual(cards.parseCardValue({ gone: true }), { gone: true });
  assert.deepEqual(cards.parseCardValue({ name: 'Visa', gone: 'yes' }), { name: 'Visa', colour: '', cut: null, due: null }, 'only gone: true deletes');
});

test('cardValue cleans a card to write; cardTombstone keeps what it held, with gone: true', () => {
  assert.deepEqual(cards.cardValue({ name: 'Visa', colour: 'w2', cut: 5, due: 20, extra: 1 }), { name: 'Visa', colour: 'w2', cut: 5, due: 20 });
  assert.deepEqual(cards.cardValue({ name: 'Visa', gone: true }), { name: 'Visa', colour: '', cut: null, due: null }, 'a write is never a delete');
  assert.equal(cards.cardValue({ name: '' }), null);
  assert.deepEqual(cards.cardTombstone({ name: 'Visa', due: 3 }), { name: 'Visa', colour: '', cut: null, due: 3, gone: true });
  assert.deepEqual(cards.cardTombstone('junk'), { gone: true });
  assert.deepEqual(cards.cardTombstone({ name: 'Visa', gone: true }), { name: 'Visa', colour: '', cut: null, due: null, gone: true });
});

test('listCards: live cards by name then id, skipping tombstones, unusable values and other fields; two of one name both listed', () => {
  const rec = { fields: {
    card_b: { name: 'Visa' }, card_a: { name: 'Visa', due: 3 }, card_c: { name: 'Amex', colour: 'w1' },
    card_d: { name: 'Old', gone: true }, card_e: 'junk', card_f: null, 'card_g-h': { name: 'Dash' }, card_cash: { name: 'Nope' },
    color_0011223344556677: { name: 'Pets', swatch: 'w1' }, defaultCurrency: 'TWD',
  } };
  assert.deepEqual(cards.listCards(rec), [
    { id: 'c', name: 'Amex', colour: 'w1', cut: null, due: null },
    { id: 'a', name: 'Visa', colour: '', cut: null, due: 3 },
    { id: 'b', name: 'Visa', colour: '', cut: null, due: null },
  ]);
  assert.deepEqual(Object.keys(cards.cardMap(rec)).sort(), ['a', 'b', 'c']);
  for (const r of [null, undefined, {}, { fields: null }, { fields: [] }]) assert.deepEqual(cards.listCards(r), []);
});

test('payOf: cash, a card id, or Not set for anything else (missing, null, a number, an object, a bad id)', () => {
  assert.equal(cards.payOf({ pay: 'cash' }), 'cash');
  assert.equal(cards.payOf({ pay: 'c_1' }), 'c_1');
  for (const v of [undefined, null, '', 0, 7, true, {}, [], 'a-b', 'CASH', 'x'.repeat(60)]) assert.equal(cards.payOf({ pay: v }), '', JSON.stringify(v));
  assert.equal(cards.payOf({}), '');
  assert.equal(cards.payOf(null), '');
  assert.equal(cards.PAY_NOT_SET, '', 'Not set is \'\' (never null): the item sheet compares a missing field with \'\'');
  for (const v of ['', 'cash', 'c1']) assert.ok(cards.isPayValue(v));
  for (const v of [null, 'a-b', 7, 'Cash']) assert.ok(!cards.isPayValue(v));
});

/* ------------------------------------------------------------------ Storage plumbing */

test('`pay` is an item field a save writes, but a remote pay op is stored whatever JSON it holds (never skipped)', () => {
  assert.equal(storage.ITEM_FIELDS.at(-1), 'pay');
  assert.deepEqual([...storage.UNCHECKED_FIELDS], ['repeat', 'pay']);
  const r = replicaOf();
  const odd = ['', 'cash', 'c1', null, 7, { card: 'c1' }, [1, 2], true, 'x'.repeat(5000), 'a-b'];
  const ops = odd.map((v, i) => remoteOp(`item${i}`, 'pay', v, 'devB', NOW + i));
  const out = storage.applyRemoteOps(r, ops, NOW);
  assert.equal(out.skipped, 0, 'no pay op is skipped');
  odd.forEach((v, i) => assert.deepEqual(r.records.get(`item${i}`).fields.pay, v));
  // The string rule still holds for the other listed fields.
  assert.equal(storage.applyRemoteOps(replicaOf(), [remoteOp('x', 'notes', 7)], NOW).skipped, 1, 'notes must still be a string');
  assert.equal(storage.applyRemoteOps(replicaOf(), [remoteOp('x', 'price', -1)], NOW).skipped, 1);
  // 1.19.0 doesn't know pay: it keeps every value too.
  assert.equal(legacy.applyRemoteOps(replicaOf(), ops, NOW).skipped, 0, '1.19.0 keeps them');
});

test('any JSON for a card field is kept by this version and by 1.19.0 (never skipped)', () => {
  const vals = [{ name: 'Visa' }, { gone: true }, null, 'junk', 7, [1], { name: 'x'.repeat(500) }];
  const ops = vals.map((v, i) => remoteOp(storage.SETTINGS_ID, `card_c${i}`, v, 'devB', NOW + i));
  assert.equal(storage.applyRemoteOps(replicaOf(), ops, NOW).skipped, 0);
  assert.equal(legacy.applyRemoteOps(replicaOf(), ops, NOW).skipped, 0);
});

test('cardOps writes one setFields op on the settings record (no del, no record of its own); a bad id throws before any op', () => {
  const r = replicaOf();
  const ops = storage.cardOps(r, 'c1', { name: ' Visa ', colour: 'w4', cut: 25, due: 10, junk: 1 }, { now: NOW, newId });
  assert.deepEqual(ops.map((o) => [o.rec, o.f, o.v]), [[storage.SETTINGS_ID, 'card_c1', { name: 'Visa', colour: 'w4', cut: 25, due: 10 }]]);
  assert.ok(ops.every(core.isOp));
  assert.deepEqual([...r.records.keys()], [storage.SETTINGS_ID], 'no other record');
  assert.ok(!('del' in r.records.get(storage.SETTINGS_ID).fields), 'never del: the record is never an item');
  assert.deepEqual(storage.cardOps(r, 'c1', { name: 'Visa', colour: 'w4', cut: 25, due: 10 }, { now: NOW, newId }), [], 'unchanged: no op');
  const before = JSON.stringify([...r.records]);
  for (const id of ['a-b', 'cash', 'x'.repeat(60), '', null]) assert.throws(() => storage.cardOps(r, id, { name: 'Visa' }, { now: NOW, newId }), /not a card id/);
  assert.throws(() => storage.cardOps(r, 'c2', { name: '' }, { now: NOW, newId }), /needs a name/);
  assert.equal(JSON.stringify([...r.records]), before, 'nothing written by the refused calls');
  // A max-length id and nickname make a valid op.
  const max = storage.cardOps(r, 'x'.repeat(59), { name: 'n'.repeat(40) }, { now: NOW, newId });
  assert.equal(max[0].f.length, 64);
  assert.ok(core.isOp(max[0]));
});

test('removeCardOps writes the tombstone once; settingsFromRecord and effectiveSettings expose only live cards', () => {
  const r = replicaOf();
  storage.cardOps(r, 'c1', { name: 'Visa', due: 10 }, { now: NOW, newId });
  storage.cardOps(r, 'c2', { name: 'Amex' }, { now: NOW + 1, newId });
  let rec = r.records.get(storage.SETTINGS_ID);
  assert.deepEqual(storage.settingsFromRecord(rec).cards, { c1: { name: 'Visa', colour: '', cut: null, due: 10 }, c2: { name: 'Amex', colour: '', cut: null, due: null } });
  const gone = storage.removeCardOps(r, 'c1', { now: NOW + 2, newId });
  assert.deepEqual(gone.map((o) => [o.f, o.v]), [['card_c1', { name: 'Visa', colour: '', cut: null, due: 10, gone: true }]]);
  assert.deepEqual(storage.removeCardOps(r, 'c1', { now: NOW + 3, newId }), [], 'already gone');
  assert.deepEqual(storage.removeCardOps(r, 'nope', { now: NOW + 3, newId }), [], 'missing');
  rec = r.records.get(storage.SETTINGS_ID);
  assert.deepEqual(Object.keys(storage.settingsFromRecord(rec).cards), ['c2']);
  assert.deepEqual(Object.keys(storage.effectiveSettings({}, rec).cards), ['c2']);
  // No live card: no `cards` key at all, so settings look exactly as before 1.26.0.
  storage.removeCardOps(r, 'c2', { now: NOW + 4, newId });
  rec = r.records.get(storage.SETTINGS_ID);
  assert.ok(!('cards' in storage.settingsFromRecord(rec)));
  assert.ok(!('cards' in storage.effectiveSettings({}, rec)));
});

test('saving an item that came with pay writes no pay op unless it changed; a new item without pay writes none', () => {
  const r = replicaOf();
  const item = { id: 'a', type: 'expense', name: 'Sample', domain: '', emoji: '', plan: '', price: 5, currency: 'TWD', cycle: 'monthly', nextRenewal: '', date: '', category: '', notes: '', createdAt: 'x', updatedAt: 'x' };
  const first = core.putRecord(r, 'a', Object.fromEntries(storage.ITEM_FIELDS.filter((f) => item[f] !== undefined).map((f) => [f, item[f]])), { now: NOW, newId });
  assert.ok(!first.some((o) => o.f === 'pay'), 'no pay: none written');
  const withPay = { ...storage.toItem(r.records.get('a')), pay: 'c1' };
  const fields = (it) => Object.fromEntries(storage.ITEM_FIELDS.filter((f) => it[f] !== undefined).map((f) => [f, it[f]]));
  assert.deepEqual(core.putRecord(r, 'a', fields(withPay), { now: NOW + 1, newId }).map((o) => o.f), ['pay']);
  assert.deepEqual(core.putRecord(r, 'a', fields({ ...storage.toItem(r.records.get('a')), price: 6 }), { now: NOW + 2, newId }).map((o) => o.f), ['price'], 'pay kept, not rewritten');
  assert.equal(storage.toItem(r.records.get('a')).pay, 'c1');
});

/* ------------------------------------------------------------------ Release B (1.27.0) helpers */

// Full-width digits (U+FF10-FF19) built in code, so this file holds no such characters.
const fullWidth = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
const NBSP = String.fromCharCode(0xa0);

test('newCardId: 32 hex characters, never a dash, never an id the record has in any state', () => {
  const id = cards.newCardId({ fields: {} });
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.ok(cards.isCardId(id));
  assert.ok(core.isFieldName(cards.cardFieldName(id)), 'a valid field name on every version');
  const taken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const gone = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const free = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const seq = [taken, gone, free];
  const rec = { fields: { [`card_${taken.replace(/-/g, '')}`]: { name: 'Visa' }, [`card_${gone.replace(/-/g, '')}`]: { gone: true } } };
  assert.equal(cards.newCardId(rec, () => seq.shift()), free.replace(/-/g, ''), 'skips a live card and a tombstone');
  assert.throws(() => cards.newCardId(rec, () => taken), /could not make/);
  const many = new Set(Array.from({ length: 200 }, () => cards.newCardId(null)));
  assert.equal(many.size, 200);
});

test('cardNameProblem: empty, over 40, and 13 or more digits through spaces, dashes and full-width digits', () => {
  assert.equal(cards.cardNameProblem(''), 'empty');
  assert.equal(cards.cardNameProblem('   '), 'empty');
  assert.equal(cards.cardNameProblem(null), 'empty');
  assert.equal(cards.cardNameProblem('x'.repeat(40)), '');
  assert.equal(cards.cardNameProblem(`  ${'x'.repeat(40)}  `), '', 'trimmed before counting');
  assert.equal(cards.cardNameProblem('x'.repeat(41)), 'long');
  for (const ok of ['Visa', 'Visa 2024 2025 2026', 'Mastercard 1234', '123456789012', 'Jo 1234-5678-9012', fullWidth('Visa 2024 2025 2026'), 'A 123456 B 1234567']) {
    assert.equal(cards.cardNameProblem(ok), '', ok);
  }
  for (const bad of ['4111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', fullWidth('4111111111111'), fullWidth('4111 1111 1111 1'),
    `4111${NBSP}1111${NBSP}1111${NBSP}1`, `Visa ${String.fromCharCode(0x2013)}4111 1111 1111 1`, '411111 1111111', `4111${String.fromCharCode(0xff0d)}1111-1111-1`]) {
    assert.equal(cards.cardNameProblem(bad), 'digits', bad);
  }
  assert.equal(cards.digitRun('Visa 2024 2025 2026'), 12);
  assert.equal(cards.digitRun(fullWidth('12 34')), 4);
  assert.equal(cards.CARD_NAME_DIGITS_MAX, 12);
});

test('cardByName: trimmed, case-insensitive, NFKC; null when nothing matches', () => {
  const list = cards.listCards({ fields: { card_a: { name: 'Visa' }, card_b: { name: 'Line Bank' }, card_c: { name: 'visa' } } });
  assert.equal(cards.cardByName(list, '  VISA ').id, 'a', 'the first by name then id');
  assert.equal(cards.cardByName(list, 'line bank').id, 'b');
  const fullWidthVisa = [...'VISA'].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
  assert.equal(cards.cardByName(list, fullWidthVisa).id, 'a', 'full-width letters match after NFKC');
  assert.equal(cards.cardByName(list, 'Amex'), null);
  assert.equal(cards.cardByName(list, ''), null);
  assert.equal(cards.cardByName(null, 'Visa'), null);
});

test('card colours: c1-c10, never a group swatch key; the new-card sentinel is never a pay value', () => {
  assert.deepEqual([...cards.CARD_COLOUR_KEYS], ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
  for (const k of cards.CARD_COLOUR_KEYS) assert.ok(cards.isCardColourKey(k));
  for (const k of ['', 'w3', 'c0', 'c11', 'C1', null]) assert.ok(!cards.isCardColourKey(k), String(k));
  assert.ok(!cards.isPayValue(cards.PAY_NEW_CARD));
  assert.ok(!cards.isCardId(cards.PAY_NEW_CARD));
});

test('payCard: the live card only; Not set, Cash, a gone card and an unknown id read as none', () => {
  const rec = { fields: { card_a: { name: 'Visa', colour: 'c2', due: 10 }, card_g: { name: 'Old', gone: true }, card_bad: 7 } };
  assert.deepEqual(cards.payCard({ pay: 'a' }, rec), { id: 'a', name: 'Visa', colour: 'c2', cut: null, due: 10 });
  for (const pay of ['', 'cash', 'g', 'bad', 'zzz', undefined, { id: 'a' }]) assert.equal(cards.payCard({ pay }, rec), null, String(pay));
  assert.equal(cards.payCard({ pay: 'a' }, null), null);
});

test('payToSave: a pay nobody touched is never overwritten; Not set on a new item stays absent', () => {
  // Untouched: whatever is stored stays, even a card this device doesn't know or a future value.
  for (const stored of [undefined, '', 'cash', 'a', 'gone_card', { v: 2 }]) {
    assert.deepEqual(cards.payToSave({ stored, chosen: '', touched: false }), stored);
  }
  assert.equal(cards.payToSave({ stored: undefined, chosen: '', touched: true }), undefined, 'no pay: "" op on a new item');
  assert.equal(cards.payToSave({ stored: '', chosen: '', touched: true }), '');
  assert.equal(cards.payToSave({ stored: 'a', chosen: '', touched: true }), '', 'a real change back to Not set');
  assert.equal(cards.payToSave({ stored: undefined, chosen: 'cash', touched: true }), 'cash');
  assert.equal(cards.payToSave({ stored: 'gone_card', chosen: 'b', touched: true }), 'b');
});

test('itemsPaidWith: the items whose pay is that card id, exactly', () => {
  const items = [{ id: '1', pay: 'a' }, { id: '2', pay: 'b' }, { id: '3', pay: 'a' }, { id: '4' }, { id: '5', pay: 'A' }, null];
  assert.deepEqual(cards.itemsPaidWith(items, 'a'), ['1', '3']);
  assert.deepEqual(cards.itemsPaidWith(items, 'cash'), []);
  assert.deepEqual(cards.itemsPaidWith(null, 'a'), []);
});
