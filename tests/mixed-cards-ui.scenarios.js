// Mixed-version scenarios for the cards UI (1.27.0, docs/plan-cards.md Release B): the writes that
// are new in this release (a card saved with its item in one commit, a card delete that sets its
// items back to Not set, a card edit that keeps keys a later version added), next to a frozen 1.19.0
// or 1.25.1 device (tests/legacy-1.19.0/, tests/legacy-1.25.1/; tests/helpers/mixed-sync.js). Loaded
// by tests/mixed-version.node.test.js and tests/mixed-version-tz.node.test.js. Items are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHousehold } from './helpers/mixed-sync.js';
import { listCards, payCard, PAY_NEW_CARD } from '../js/cards.js';
import { reviewRows, backupFromRows, rowPay } from '../js/import-ai.js';

const OLD = ['legacy', 'legacy125'];
const SETTINGS = 'settings';

const item = (id, over = {}) => ({
  id, type: 'expense', name: `Item ${id}`, domain: '', emoji: '', plan: '', price: 150, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-12-05', date: '', category: 'Hobbies', notes: '',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});

function manualTime(start = Date.UTC(2026, 10, 24, 4, 0, 0)) {
  const c = { t: start };
  c.advance = (ms = 1000) => { c.t += ms; return c.t; };
  c.now = (skew = 0) => () => c.t + skew;
  return c;
}

async function household({ crypto } = {}) {
  const time = manualTime();
  const h = await createHousehold({ crypto, relayNow: time.now() });
  return { h, time };
}

const cardsOf = (d) => listCards(d.settingsRecord());
function clean(d, msg) {
  const r = d.report();
  assert.deepEqual(r.skipped, [], `${msg}: nothing skipped`);
  assert.deepEqual(r.refused, [], `${msg}: nothing refused`);
  assert.ok(!r.items.some((x) => x.id === SETTINGS || x.id.startsWith('card_')), `${msg}: no ghost item`);
  assert.ok(!('del' in (d.settingsRecord()?.fields ?? {})), `${msg}: the settings record is never an item`);
}

for (const old of OLD) {
  test(`a new device saves an item with a new card in one commit; ${old} edits the item's name and pay survives`, async () => {
    const { h, time } = await household({ crypto: 'real' });
    const N = await h.device('new', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    const ops = N.saveItemWithCard({ ...item('a'), pay: 'k1' }, 'k1', { name: 'Visa', colour: 'c2' });
    assert.deepEqual([...new Set(ops.map((o) => o.rec))].sort(), ['a', SETTINGS], 'one commit: the card and the item');
    await h.syncAll();
    clean(O, old);
    assert.equal(O.item('a').pay, 'k1');
    time.advance();
    const form = O.formSave('a', { name: 'Item a renamed' });
    assert.deepEqual(form.ops.map((o) => o.f).sort(), ['name', 'updatedAt'], `${old}'s sheet writes only what changed`);
    await h.syncAll();
    for (const d of [N, O]) {
      assert.equal(d.item('a').name, 'Item a renamed', `${d.name}: the edit`);
      assert.equal(d.item('a').pay, 'k1', `${d.name}: pay survives`);
      assert.deepEqual(d.settingsRecord().fields.card_k1, { name: 'Visa', colour: 'c2', cut: null, due: null }, `${d.name}: the card`);
      clean(d, d.name);
    }
    assert.equal(payCard(N.item('a'), N.settingsRecord()).name, 'Visa');
  });

  test(`delete-with-clear on the new device: ${old} then shows the items normally, Not set, and nothing else changed`, async () => {
    const { h, time } = await household();
    const N = await h.device('new', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    N.saveCard('k1', { name: 'Visa', colour: 'c1' });
    N.save({ ...item('a'), pay: 'k1' });
    N.save({ ...item('b'), pay: 'k1' });
    N.save({ ...item('c'), pay: 'cash' });
    await h.syncAll();
    time.advance();
    const { ops, cleared } = N.deleteCard('k1');
    assert.deepEqual(cleared.sort(), ['a', 'b']);
    assert.deepEqual(ops.map((o) => `${o.rec}.${o.f}`).sort(), ['a.pay', 'b.pay', 'settings.card_k1'], 'only the pay fields and the tombstone');
    await h.syncAll();
    for (const d of [N, O]) {
      assert.deepEqual(d.items().map((x) => [x.id, x.pay, x.name, x.price]), [['a', '', 'Item a', 150], ['b', '', 'Item b', 150], ['c', 'cash', 'Item c', 150]], d.name);
      assert.equal(d.settingsRecord().fields.card_k1.gone, true, `${d.name}: the tombstone`);
      assert.deepEqual(cardsOf(d), [], `${d.name}: no live card`);
      clean(d, d.name);
    }
    // The old device edits a cleared item: still nothing lost.
    time.advance();
    O.formSave('a', { price: '160' });
    await h.syncAll();
    assert.deepEqual([N.item('a').price, N.item('a').pay], [160, '']);
  });

  test(`one device deletes a card while another assigns it offline: the item names a gone card and reads Not set; ${old} agrees`, async () => {
    const { h, time } = await household();
    const A = await h.device('a', { version: 'current', now: time.now() });
    const B = await h.device('b', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    A.saveCard('k1', { name: 'Visa' });
    A.save(item('a'));
    await h.syncAll();
    A.offline(); B.offline();
    time.advance();
    assert.deepEqual(A.deleteCard('k1').cleared, [], 'no item used it yet on A');
    time.advance();
    B.save({ ...B.item('a'), pay: 'k1' });
    A.online(); B.online();
    await h.syncAll();
    for (const d of [A, B, O]) {
      assert.equal(d.item('a').pay, 'k1', `${d.name}: the item still names the card`);
      assert.equal(payCard(d.item('a'), d.settingsRecord()), null, `${d.name}: reads as Not set`);
      clean(d, d.name);
    }
    // The item sheet shows Not set for it, and a save that doesn't touch the drop-down keeps it.
    time.advance();
    const form = A.formSave('a', { name: 'Item a renamed' });
    assert.deepEqual(form.ops.map((o) => o.f).sort(), ['name', 'updatedAt'], 'no pay written');
    await h.syncAll();
    for (const d of [A, B, O]) assert.equal(d.item('a').pay, 'k1', `${d.name}: the guard kept the pay`);
  });

  test(`the current item sheet's "Add new card…" stores the card with the item; ${old} edits the item and pay survives`, async () => {
    const { h, time } = await household();
    const N = await h.device('new', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    const form = N.formSave(null, { name: 'Phone bill', price: '499', nextRenewal: '2026-12-10', pay: PAY_NEW_CARD, newCard: '  Family Visa ' });
    assert.deepEqual(form.errors, {});
    assert.ok(form.newCard, 'a new card described');
    assert.deepEqual([...new Set(form.ops.map((o) => o.rec))].sort(), [form.saved.id, SETTINGS].sort(), 'one commit');
    await h.syncAll();
    const id = form.saved.id;
    assert.equal(O.item(id).pay, form.newCard.id);
    assert.equal(O.settingsRecord().fields[`card_${form.newCard.id}`].name, 'Family Visa');
    time.advance();
    O.formSave(id, { name: 'Phone' });
    await h.syncAll();
    for (const d of [N, O]) assert.equal(d.item(id).pay, form.newCard.id, `${d.name}: pay survives`);
    assert.equal(payCard(N.item(id), N.settingsRecord()).name, 'Family Visa');
  });

  test(`a card rename on the new device keeps keys a later version added; ${old} stores the whole value`, async () => {
    const { h, time } = await household();
    const N = await h.device('new', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    const W = h.writer('later', { now: time.now() });
    await h.inject([W.op(SETTINGS, 'card_k1', { name: 'Visa', colour: 'c12', cut: 5, due: 25, limit: 5000, alerts: { days: 3 } })]);
    await h.syncAll();
    time.advance();
    N.saveCard('k1', { name: 'Visa Gold' });
    await h.syncAll();
    for (const d of [N, O]) {
      assert.deepEqual(d.settingsRecord().fields.card_k1, { name: 'Visa Gold', colour: 'c12', cut: 5, due: 25, limit: 5000, alerts: { days: 3 } }, d.name);
      clean(d, d.name);
    }
  });
}

test('two new devices add "Visa" offline through the item sheet path: both cards show, each item keeps its own', async () => {
  const { h, time } = await household();
  const A = await h.device('a', { version: 'current', now: time.now() });
  const B = await h.device('b', { version: 'current', now: time.now() });
  A.offline(); B.offline();
  A.saveItemWithCard({ ...item('a'), pay: 'ka' }, 'ka', { name: 'Visa', colour: 'c1' });
  time.advance();
  B.saveItemWithCard({ ...item('b'), pay: 'kb' }, 'kb', { name: 'Visa', colour: 'c4' });
  A.online(); B.online();
  await h.syncAll();
  for (const d of [A, B]) {
    assert.deepEqual(cardsOf(d).map((c) => [c.id, c.name]), [['ka', 'Visa'], ['kb', 'Visa']], d.name);
    assert.equal(payCard(d.item('a'), d.settingsRecord()).id, 'ka');
    assert.equal(payCard(d.item('b'), d.settingsRecord()).id, 'kb');
    clean(d, d.name);
  }
});

test('the current item sheet: Not set writes no pay; a typed nickname that is a card picks it; a card number is refused; income ignores it', async () => {
  const { h, time } = await household();
  const N = await h.device('new', { version: 'current', now: time.now() });
  N.saveCard('k1', { name: 'Visa', colour: 'c7' });
  const plain = N.formSave(null, { name: 'Plain', price: '10', nextRenewal: '2026-12-10' });
  assert.ok(!plain.ops.some((o) => o.f === 'pay'), 'a new item with Not set: no pay op');
  assert.equal(N.item(plain.saved.id).pay, undefined);
  const picked = N.formSave(null, { name: 'Picked', price: '10', nextRenewal: '2026-12-10', pay: PAY_NEW_CARD, newCard: ' vIsA ' });
  assert.equal(picked.newCard, null, 'no new card');
  assert.equal(N.item(picked.saved.id).pay, 'k1', 'the existing card');
  const emptyNick = N.formSave(null, { name: 'Empty nick', price: '10', nextRenewal: '2026-12-10', pay: PAY_NEW_CARD, newCard: '  ' });
  assert.equal(N.item(emptyNick.saved.id).pay, undefined, 'an empty nickname is Not set');
  const before = N.s.made.length;
  const bad = N.formSave(null, { name: 'Bad', price: '10', nextRenewal: '2026-12-10', pay: PAY_NEW_CARD, newCard: '4111 1111 1111 1111' });
  assert.equal(bad.saved, null, 'refused');
  assert.ok(bad.errors.newCard, 'with a message under the field');
  assert.equal(N.s.made.length, before, 'nothing written');
  const cashToNot = N.formSave(null, { name: 'Cash one', price: '10', nextRenewal: '2026-12-10', pay: 'cash' });
  assert.equal(N.item(cashToNot.saved.id).pay, 'cash');
  time.advance();
  N.formSave(cashToNot.saved.id, { pay: '' });
  assert.equal(N.item(cashToNot.saved.id).pay, '', 'a real change back to Not set is written');
  const income = N.formSave(null, { kind: 'income', name: 'Salary', price: '100', nextRenewal: '2026-12-10', pay: 'k1' }, { type: 'income' });
  assert.equal(N.item(income.saved.id).pay, undefined, 'income gets no pay');
  assert.equal(N.item(income.saved.id).type, 'income');
});

test('Import with AI rows with Cash and a card keep pay through parseBackup and importAll (Merge and Replace all); cards untouched; old devices keep it', async () => {
  const { h, time } = await household();
  const N = await h.device('new', { version: 'current', now: time.now() });
  const olds = await Promise.all(OLD.map((v) => h.device(v, { version: v, now: time.now() })));
  N.saveCard('k1', { name: 'Visa', colour: 'c7' });
  N.saveCard('k2', { name: 'Amex', colour: 'c1' });
  N.save(item('mine'));
  const aiRow = (over) => ({ name: 'AI', amount: 100, currency: 'TWD', cycle: 'monthly', nextDate: '2026-12-05', category: 'Hobbies', type: 'expense', ...over });
  const rows = reviewRows([aiRow({ name: 'Stream' }), aiRow({ name: 'Books' }), aiRow({ name: 'Wage', type: 'income', category: '' })]);
  const live = new Set(listCards(N.settingsRecord()).map((c) => c.id));
  const backup = backupFromRows(rows, { now: '2026-11-24T00:00:00.000Z', payOf: (n) => rowPay(n, { all: 'k1', perRow: new Map([[2, 'cash']]), live }) });
  assert.equal(backup.schemaVersion, 4);
  N.importBackup(JSON.stringify(backup), 'merge');
  await h.syncAll();
  for (const d of [N, ...olds]) {
    const by = (name) => d.items().find((x) => x.name === name);
    assert.deepEqual([by('Stream').pay, by('Books').pay, by('Wage').pay], ['k1', 'cash', undefined], d.name);
    assert.deepEqual(listCards(d.settingsRecord()).map((c) => c.id), ['k2', 'k1'], `${d.name}: both cards`);
    clean(d, d.name);
  }
  // Replace all with the same file: the cards stay (the file has no settings), the pays come in again.
  time.advance();
  N.importBackup(JSON.stringify(backupFromRows(rows, { now: '2026-11-24T00:00:00.000Z', payOf: (n) => rowPay(n, { all: 'k2', live }) })), 'replace');
  await h.syncAll();
  assert.deepEqual(listCards(N.settingsRecord()).map((c) => c.id), ['k2', 'k1'], 'Replace all deleted no card');
  assert.deepEqual(N.items().map((x) => [x.name, x.pay]).sort(), [['Books', 'k2'], ['Stream', 'k2'], ['Wage', undefined]]);
});

test('an export with a card is format 6 and round-trips; after delete-with-clear it is format 5 again', async () => {
  const { h, time } = await household();
  const N = await h.device('new', { version: 'current', now: time.now() });
  N.saveItemWithCard({ ...item('a'), pay: 'k1' }, 'k1', { name: 'Visa', colour: 'c3', due: 10 });
  N.save({ ...item('b') });
  const first = N.exportBackup();
  assert.equal(JSON.parse(first).schemaVersion, 6);
  const F = await h.device('fresh', { version: 'current', joined: false, now: time.now() });
  F.importBackup(first, 'replace');
  assert.equal(F.exportBackup(), first, 'the same file again');
  N.deleteCard('k1');
  const after = JSON.parse(N.exportBackup());
  assert.equal(after.schemaVersion, 5, 'no live card and no pay other than Not set: format 5');
  assert.ok(!after.items.some((x) => 'pay' in x && x.pay !== ''));
});
