// Mixed-version scenarios for the payment-card groundwork (1.26.0, docs/plan-cards.md): devices on
// the current js/ write cards (card_<id> fields of the settings record) and items' `pay`, next to
// a frozen 1.19.0 or 1.25.1 device (tests/legacy-1.19.0/, tests/legacy-1.25.1/; tests/helpers/
// mixed-sync.js). Checks that the old device never stores a blank item or skips an op, keeps pay
// through its own edits and deletes, and that format 6 files import on both. Loaded by
// tests/mixed-version.node.test.js and tests/mixed-version-tz.node.test.js. Items are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHousehold } from './helpers/mixed-sync.js';
import { listCards, cardMap } from '../js/cards.js';

const OLD = ['legacy', 'legacy125'];
const SETTINGS = 'settings';
const VISA = Object.freeze({ name: 'Visa', colour: 'w3', cut: 25, due: 10 });

const item = (id, over = {}) => ({
  id, type: 'expense', name: `Item ${id}`, domain: '', emoji: '', plan: '', price: 150, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-12-05', date: '', category: 'Hobbies', notes: '',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});

function manualTime(start = Date.UTC(2026, 10, 23, 4, 0, 0)) {
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

/** The live cards a device's record holds, as the current reader lists them (for any device's record). */
const cardsOf = (d) => listCards(d.settingsRecord());
/** Nothing went missing: no op skipped by storage, no envelope refused, no record that looks like an item but isn't one. */
function clean(d, msg) {
  const r = d.report();
  assert.deepEqual(r.skipped, [], `${msg}: nothing skipped`);
  assert.deepEqual(r.refused, [], `${msg}: nothing refused`);
  assert.ok(!r.items.some((x) => x.id === SETTINGS || x.id.startsWith('card_')), `${msg}: no ghost item`);
  assert.ok(!('del' in (d.settingsRecord()?.fields ?? {})), `${msg}: the settings record is never an item`);
}

for (const old of OLD) {
  test(`a new device writes a card and a pay; ${old} syncs them with no blank item and no dropped op`, async () => {
    const { h, time } = await household({ crypto: 'real' });
    const N = await h.device('new', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    N.save(item('a'));
    time.advance();
    N.saveCard('visa1', VISA);
    N.save({ ...N.item('a'), pay: 'visa1' });
    await h.syncAll();
    clean(O, old);
    assert.deepEqual(O.items().map((x) => x.id), ['a'], `${old}: one item, the real one`);
    assert.equal(O.item('a').pay, 'visa1', `${old} keeps the pay (its toItem copies every stored field)`);
    assert.deepEqual(O.settingsRecord().fields.card_visa1, VISA, `${old} stores the card field`);
    assert.equal(O.mod.storage.toItem(O.settingsRecord()), null, `${old} never sees the settings record as an item`);
    // Every op the new device made reached the old one and was stored.
    assert.ok(N.s.made.every((op) => O.record(op.rec)?.ts?.[op.f] !== undefined), 'every op stored on the old device');
  });

  test(`${old} edits an item's name in its sheet and deletes another: pay survives the edit, the delete holds`, async () => {
    const { h, time } = await household();
    const N = await h.device('new', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    N.saveCard('visa1', VISA);
    N.save({ ...item('a'), pay: 'visa1' });
    N.save({ ...item('b'), pay: 'cash' });
    await h.syncAll();
    time.advance();
    const form = O.formSave('a', { name: 'Item a renamed' });
    assert.deepEqual(form.errors, {});
    assert.deepEqual(form.ops.map((o) => o.f).sort(), ['name', 'updatedAt'], `${old}'s sheet writes only what changed`);
    assert.deepEqual(O.save({ ...O.item('a'), price: 160 }).map((o) => o.f), ['price'], `${old} storage save: only the price`);
    O.remove('b');
    await h.syncAll();
    for (const d of [N, O]) {
      assert.equal(d.item('a').name, 'Item a renamed', `${d.name}: the edit`);
      assert.equal(d.item('a').pay, 'visa1', `${d.name}: pay survives`);
      assert.equal(d.item('b'), null, `${d.name}: deleted`);
      assert.deepEqual(d.tombstones(), ['b']);
      clean(d, d.name);
    }
    assert.deepEqual(cardsOf(N).map((c) => c.id), ['visa1']);
  });

  test(`two new devices add cards offline (different cards, and both "Visa"); ${old} and both see every one`, async () => {
    const { h, time } = await household();
    const A = await h.device('a', { version: 'current', now: time.now() });
    const B = await h.device('b', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    A.offline(); B.offline();
    A.saveCard('ca_amex', { name: 'Amex' });
    A.saveCard('ca_visa', { name: 'Visa', due: 3 });
    time.advance();
    B.saveCard('cb_master', { name: 'Master' });
    B.saveCard('cb_visa', { name: 'Visa', due: 20 });
    A.online(); B.online();
    await h.syncAll();
    const want = ['ca_amex', 'cb_master', 'ca_visa', 'cb_visa'];
    for (const d of [A, B, O]) {
      assert.deepEqual(cardsOf(d).map((c) => c.id), want, `${d.name}: every card, two named Visa`);
      clean(d, d.name);
    }
    assert.deepEqual(cardsOf(A).filter((c) => c.name === 'Visa').map((c) => c.due), [3, 20], 'two Visa cards, each its own');
  });

  test(`one device deletes a card while another assigns it offline; ${old} agrees with both`, async () => {
    const { h, time } = await household();
    const A = await h.device('a', { version: 'current', now: time.now() });
    const B = await h.device('b', { version: 'current', now: time.now() });
    const O = await h.device('old', { version: old, now: time.now() });
    A.saveCard('visa1', VISA);
    A.save(item('a'));
    await h.syncAll();
    A.offline(); B.offline();
    time.advance();
    A.saveCard('visa1', null);
    time.advance();
    B.save({ ...B.item('a'), pay: 'visa1' });
    A.online(); B.online();
    await h.syncAll();
    for (const d of [A, B, O]) {
      assert.deepEqual(d.settingsRecord().fields.card_visa1, { ...VISA, gone: true }, `${d.name}: the tombstone`);
      assert.deepEqual(cardsOf(d), [], `${d.name}: no live card`);
      assert.equal(d.item('a').pay, 'visa1', `${d.name}: the item still names it (the screens decide how it reads)`);
      clean(d, d.name);
    }
  });

  test(`a device joins with Replace (and Merge): it gets the household's cards and pay; ${old} joins too`, async () => {
    const { h, time } = await household({ crypto: 'real' });
    const N = await h.device('home', { version: 'current', now: time.now() });
    N.saveCard('visa1', VISA);
    N.save({ ...item('a'), pay: 'visa1' });
    await N.sync();
    for (const [version, mode] of [['current', 'replace'], ['current', 'merge'], [old, 'replace'], [old, 'merge']]) {
      const J = await h.device(`${version}-${mode}`, { version, joined: false, now: time.now() });
      J.save(item(`own-${version}-${mode}`));
      await J.join(mode);
      await h.syncAll(2);
      assert.deepEqual(J.settingsRecord().fields.card_visa1, VISA, `${version} ${mode}: the card`);
      assert.equal(J.item('a').pay, 'visa1', `${version} ${mode}: the pay`);
      clean(J, `${version} ${mode}`);
    }
    assert.deepEqual(cardsOf(N).map((c) => c.id), ['visa1'], 'still one card');
  });

  test(`a format 6 file imported on ${old}: the "newer version" note, every item, nothing else lost`, async () => {
    const { h, time } = await household();
    const N = await h.device('new', { version: 'current', now: time.now() });
    N.saveCard('visa1', VISA);
    N.choose({ groupColors: { Hobbies: 'g3' }, defaultCurrency: 'EUR' });
    N.save({ ...item('a'), pay: 'visa1' });
    N.save(item('b', { cycle: 'annual', nextRenewal: '2027-03-31', category: 'Health' }));
    const file = N.exportBackup();
    assert.equal(JSON.parse(file).schemaVersion, 6);
    for (const mode of ['merge', 'replace']) {
      const O = await h.device(`old-${mode}`, { version: old, joined: false, now: time.now() });
      const sum = O.importBackup(file, mode);
      assert.equal(sum.newerVersion, true, `${old} ${mode}: says the file comes from a newer version`);
      assert.deepEqual(O.items().map((x) => x.id), ['a', 'b'], `${old} ${mode}: every item`);
      assert.deepEqual(O.items().map(({ name, price, cycle, nextRenewal, category }) => ({ name, price, cycle, nextRenewal, category })),
        N.items().map(({ name, price, cycle, nextRenewal, category }) => ({ name, price, cycle, nextRenewal, category })), 'the same items');
      if (mode === 'replace') assert.equal(O.settings().defaultCurrency, 'EUR', 'the currency (Replace takes it; Merge takes only colours)');
      assert.equal(O.settings().groupColors.Hobbies, 'g3', 'the colour');
      assert.ok(!Object.keys(O.settingsRecord()?.fields ?? {}).some((k) => k.startsWith('card_')), `${old} has nowhere to put cards: none written`);
      clean(O, `${old} ${mode}`);
    }
  });
}

test('a dash id is refused before any op on the new code; an injected dash field is refused on every version and stored nowhere', async () => {
  const { h, time } = await household();
  const N = await h.device('new', { version: 'current', now: time.now() });
  const L = await h.device('l119', { version: 'legacy', now: time.now() });
  const M = await h.device('l125', { version: 'legacy125', now: time.now() });
  for (const id of ['a-b', 'cash', 'x'.repeat(60)]) assert.throws(() => N.saveCard(id, VISA), /not a card id/, id);
  assert.deepEqual(N.s.made, [], 'no op made');
  // An import naming a dash id writes nothing for it either.
  N.importBackup(JSON.stringify({ app: 'substracker', schemaVersion: 6, exportedAt: '2026-11-23T00:00:00.000Z', items: [item('a')], settings: { cards: { 'a-b': VISA, ok1: VISA } } }), 'merge');
  assert.deepEqual(Object.keys(N.settingsRecord().fields).filter((k) => k.startsWith('card_')), ['card_ok1']);
  assert.ok(N.s.made.every((op) => N.mod.core.isFieldName(op.f)));
  // A client we don't model sends one anyway: every version's crypto layer refuses it (not a valid op).
  const w = h.writer('rogue', { now: time.now() });
  await h.inject([{ ...w.op(SETTINGS, 'card_ok2', VISA), f: 'card_a-b' }]);
  await h.syncAll();
  for (const d of [N, L, M]) {
    assert.ok(!('card_a-b' in (d.settingsRecord()?.fields ?? {})), `${d.name}: not stored`);
    assert.equal(d.report().refused.length, 1, `${d.name}: refused as an invalid op`);
    assert.deepEqual(d.report().skipped, [], `${d.name}: nothing else skipped`);
  }
});

test('a max-length card id and nickname sync to 1.19.0 and 1.25.1; a longer nickname reads cut to 40', async () => {
  const { h, time } = await household();
  const N = await h.device('new', { version: 'current', now: time.now() });
  const olds = await Promise.all(OLD.map((v) => h.device(v, { version: v, now: time.now() })));
  const id = 'x'.repeat(59);
  N.saveCard(id, { name: 'N'.repeat(40) });
  N.writeFields(SETTINGS, { card_long: { name: 'L'.repeat(80) } }); // as a later version might
  await h.syncAll();
  for (const d of [N, ...olds]) {
    assert.deepEqual(d.settingsRecord().fields[`card_${id}`], { name: 'N'.repeat(40), colour: '', cut: null, due: null }, d.name);
    assert.equal(`card_${id}`.length, 64);
    assert.equal(cardMap(d.settingsRecord()).long.name, 'L'.repeat(40), `${d.name}: read cut to 40, stored as sent`);
    assert.equal(d.settingsRecord().fields.card_long.name.length, 80);
    clean(d, d.name);
  }
});

test('round trip: export with cards and pay, import on a fresh device, export again gives the same file', async () => {
  const { h, time } = await household();
  const N = await h.device('new', { version: 'current', now: time.now() });
  N.saveCard('visa1', VISA);
  N.saveCard('amex1', { name: 'Amex' });
  N.save({ ...item('a'), pay: 'visa1' });
  N.save({ ...item('b'), pay: 'cash' });
  N.save(item('c'));
  const first = N.exportBackup();
  assert.equal(JSON.parse(first).schemaVersion, 6);
  const F = await h.device('fresh', { version: 'current', joined: false, now: time.now() });
  F.importBackup(first, 'replace');
  assert.deepEqual(cardMap(F.settingsRecord()), cardMap(N.settingsRecord()), 'cards back');
  assert.deepEqual(F.items().map((x) => [x.id, x.pay]), [['a', 'visa1'], ['b', 'cash'], ['c', undefined]], 'pay back; Not set writes nothing');
  assert.equal(F.exportBackup(), first, 'the same file again');
});

test('format 5 export is byte-identical to 1.25.1\'s when there are no cards (and stays so with only deleted cards)', async () => {
  const { h, time } = await household();
  const N = await h.device('new', { version: 'current', now: time.now() });
  const M = await h.device('old', { version: 'legacy125', now: time.now() });
  N.choose({ groupColors: { Hobbies: 'w5' }, defaultCurrency: 'TWD' });
  N.save(item('a'));
  N.save(item('b', { type: 'income', category: 'Salary' }));
  N.save(item('c', { cycle: 'once', date: '2026-12-24', nextRenewal: '' }));
  N.writeFields('a', { repeat: { every: 2, unit: 'week' } });
  N.save({ ...N.item('c'), pay: '' });
  N.ensureSlots();
  await h.syncAll();
  const at = '2026-11-23T00:00:00.000Z';
  assert.equal(JSON.parse(N.exportBackup(at)).schemaVersion, 5);
  assert.equal(N.exportBackup(at), M.exportBackup(at), 'the same bytes as 1.25.1 on the same data');
  N.saveCard('gone1', VISA);
  N.saveCard('gone1', null);
  await h.syncAll();
  assert.equal(N.exportBackup(at), M.exportBackup(at), 'a deleted card changes nothing');
});
