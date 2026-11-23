// Mixed-version sync scenarios: a frozen 1.19.0 device (tests/legacy-1.19.0/) and a device on the
// current js/ in one household (tests/helpers/mixed-sync.js). They pin down what 1.19.0 really
// does with fields, ops and files it doesn't know, the checklist in docs/plan-intervals-groups.md
// (sections 2 and 7). Loaded by tests/mixed-version.node.test.js (this machine's time zone) and
// tests/mixed-version-tz.node.test.js (America/New_York). Items and names are made up.
//
// "Writer" and "reader" are versions. Today both are the same code; once js/ changes, the
// legacy -> current and current -> legacy runs are what keep the old device safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHousehold, loadVersion, plainEnvelope } from './helpers/mixed-sync.js';

const PAIRS = [['legacy', 'current'], ['current', 'legacy']];
const VERSIONS = ['legacy', 'current'];
const HOUR = 60 * 60 * 1000;

const item = (id, over = {}) => ({
  id, type: 'expense', name: `Item ${id}`, domain: '', emoji: '', plan: '', price: 100, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-12-05', date: '', category: 'Food', notes: '',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});

/** A clock the test moves by hand, shared by the devices and the relay. */
function manualTime(start = Date.UTC(2026, 10, 19, 4, 0, 0)) {
  const c = { t: start };
  c.advance = (ms = 1000) => { c.t += ms; return c.t; };
  c.now = (skew = 0) => () => c.t + skew;
  return c;
}

/* ------------------------------------------------------------------ Unknown fields */

for (const [writer, reader] of PAIRS) {
  test(`${writer} -> ${reader}: unknown item fields are kept, and the reader's edits of other fields don't lose them`, async () => {
    const h = await createHousehold();
    const W = await h.device('writer', { version: writer });
    const R = await h.device('reader', { version: reader });
    W.save(item('a', { name: 'Pottery class', price: 150 }));
    W.writeFields('a', { repeat: { every: 1, unit: 'week' }, futureNote: 'kept', futureList: [1, 2, { x: null }] });
    await h.syncAll();

    const extras = { repeat: { every: 1, unit: 'week' }, futureNote: 'kept', futureList: [1, 2, { x: null }] };
    assert.deepEqual(R.report().skipped, [], 'nothing skipped');
    for (const [f, v] of Object.entries(extras)) assert.deepEqual(R.record('a').fields[f], v, `${f} stored on the reader`);
    // toItem copies every stored field, so the reader's app sees them too (F3).
    assert.deepEqual(R.item('a').repeat, extras.repeat);

    // The reader edits other fields: in storage (save) and in its item sheet (form).
    const saved = R.save({ ...R.item('a'), price: 160 });
    assert.deepEqual(saved.map((o) => o.f), ['price'], 'save writes only the changed ITEM_FIELDS');
    const form = R.formSave('a', { notes: 'Bring an apron' });
    assert.deepEqual(form.errors, {});
    assert.deepEqual(form.ops.map((o) => o.f).sort(), ['notes', 'updatedAt'], 'the sheet writes the changed field and updatedAt');
    assert.ok(!form.ops.some((o) => o.f in extras), 'no op ever touches an unknown field');
    await h.syncAll();
    for (const d of [W, R]) {
      for (const [f, v] of Object.entries(extras)) assert.deepEqual(d.record('a').fields[f], v, `${d.name}: ${f} still there`);
      assert.equal(d.item('a').price, 160);
      assert.equal(d.item('a').notes, 'Bring an apron');
    }
    // The stamps of the unknown fields are the writer's own: nobody rewrote them.
    const wStamp = W.record('a').ts.repeat;
    assert.equal(R.record('a').ts.repeat, wStamp);
    assert.ok(wStamp.endsWith('-writer'));

    // The reader's backup carries them (exportAll spreads the whole item, F10); importing it back
    // drops them from the file but leaves the stored fields alone (no op for them).
    const file = JSON.parse(R.exportBackup());
    assert.deepEqual(file.items.find((x) => x.id === 'a').repeat, extras.repeat, 'in the reader\'s backup');
    const before = R.s.made.length;
    R.importBackup(JSON.stringify(file), 'merge');
    assert.equal(R.s.made.length, before, 'merging its own backup makes no ops');
    R.importBackup(JSON.stringify(file), 'replace');
    assert.deepEqual(R.record('a').fields.repeat, extras.repeat, 'replace leaves the stored unknown field too');
  });

  test(`${writer} -> ${reader}: unknown settings fields and extra keys in a colour value are kept`, async () => {
    const h = await createHousehold();
    const W = await h.device('writer', { version: writer });
    const R = await h.device('reader', { version: reader });
    const { colorField, SETTINGS_ID } = W.mod.storage;
    W.choose({ defaultCurrency: 'TWD' });
    W.writeFields(SETTINGS_ID, {
      [colorField('Gaming')]: { name: 'Gaming', swatch: 'w8', slot: 7 },
      [colorField('Fuel')]: { name: 'Fuel', swatch: 'w7', slot: 6, auto: true },
      app_0123456789abcdef: { v: '1.20.0', fmt: 5, at: '2026-12-01' },
    });
    await h.syncAll();
    assert.deepEqual(R.report().skipped, []);
    const rec = R.settingsRecord();
    assert.deepEqual(rec.fields[colorField('Gaming')], { name: 'Gaming', swatch: 'w8', slot: 7 });
    assert.deepEqual(rec.fields.app_0123456789abcdef, { v: '1.20.0', fmt: 5, at: '2026-12-01' });
    assert.ok(!('del' in rec.fields), 'the settings record never gets del');
    // The reader's app reads { name, swatch } only, as a colour someone picked (F8).
    assert.deepEqual(R.settings().groupColors, { Gaming: 'w8', Fuel: 'w7' });

    // The reader changes another setting: everything else stays.
    R.choose({ defaultCurrency: 'USD' });
    await h.syncAll();
    for (const d of [W, R]) {
      assert.equal(d.settings().defaultCurrency, 'USD');
      assert.deepEqual(d.settingsRecord().fields[colorField('Fuel')], { name: 'Fuel', swatch: 'w7', slot: 6, auto: true });
      assert.deepEqual(d.settingsRecord().fields.app_0123456789abcdef, { v: '1.20.0', fmt: 5, at: '2026-12-01' });
    }
    // The reader picks a colour for Gaming: its value is { name, swatch }, so slot is dropped everywhere.
    R.choose({ groupColors: { Gaming: 'g6' } });
    await h.syncAll();
    for (const d of [W, R]) assert.deepEqual(d.settingsRecord().fields[colorField('Gaming')], { name: 'Gaming', swatch: 'g6' });
  });
}

/* ------------------------------------------------------------------ Refused ops */

/**
 * Every kind of op the checks were asked about, with what 1.19.0 does with it:
 * 'kept' (stored), 'skipped' (refused by storage's validators: not stored, cursor moves on) or
 * 'refused' (refused by the crypto layer's op check before storage sees it: not stored either).
 */
async function refusalCases(mod) {
  const { colorField } = mod.storage;
  const long = (n) => 'x'.repeat(n);
  const item = [
    ['an unknown cycle string', 'cycle', 'weekly', 'kept'],
    ['cycle as a number', 'cycle', 7, 'skipped'],
    ['cycle null', 'cycle', null, 'skipped'],
    ['cycle as an object', 'cycle', { every: 1, unit: 'week' }, 'skipped'],
    ['an empty date', 'nextRenewal', '', 'kept'],
    ['a date as a number', 'nextRenewal', 20261205, 'skipped'],
    ['a name of 2000 characters', 'name', long(2000), 'kept'],
    ['a name of 2001 characters', 'name', long(2001), 'skipped'],
    ['notes of 2001 characters', 'notes', long(2001), 'skipped'],
    ['price 0', 'price', 0, 'kept'],
    ['price 1e308', 'price', 1e308, 'kept'],
    ['a negative price', 'price', -1, 'skipped'],
    ['price as text', 'price', '390', 'skipped'],
    ['price null', 'price', null, 'skipped'],
    ['an unknown field with an object', 'repeat', { every: 2, unit: 'week' }, 'kept'],
    ['an unknown field with null', 'futureField', null, 'kept'],
    ['an unknown field with a long text', 'futureText', long(5000), 'kept'],
    ['an unknown field named Del (not del)', 'Del', 'x', 'kept'],
    ['del true', 'del', true, 'kept'],
    ['del as text', 'del', 'yes', 'refused'],
    ['a field name with a dash', 'my-field', 'x', 'refused'],
    ['a field name starting with _', '_x', 'x', 'refused'],
    ['a field name of 65 characters', `f${long(64)}`, 'x', 'refused'],
    ['NaN (not JSON)', 'price', NaN, 'refused'],
  ];
  const settings = [
    ['del false on the settings record', 'del', false, 'skipped'],
    ['del true on the settings record', 'del', true, 'skipped'],
    ['currency USD', 'defaultCurrency', 'USD', 'kept'],
    ['currency null (cleared)', 'defaultCurrency', null, 'kept'],
    ['currency in lower case', 'defaultCurrency', 'usd', 'skipped'],
    ['currency of 4 letters', 'defaultCurrency', 'TWDX', 'skipped'],
    ['currency as a number', 'defaultCurrency', 5, 'skipped'],
    ['a colour with a g key', colorField('Food'), { name: 'Food', swatch: 'g1' }, 'kept'],
    ['a colour with a w key', colorField('Fuel'), { name: 'Fuel', swatch: 'w8' }, 'kept'],
    ['a colour with slot and auto', colorField('Pets'), { name: 'Pets', swatch: 'w3', slot: 17, auto: true }, 'kept'],
    ['a colour with an unknown 8-character key', colorField('Books'), { name: 'Books', swatch: 'zzzzzzzz' }, 'kept'],
    ['a colour with a 9-character key', colorField('Music'), { name: 'Music', swatch: 'zzzzzzzzz' }, 'skipped'],
    ['a colour without a swatch', colorField('Gym'), { name: 'Gym', slot: 3 }, 'skipped'],
    ['a colour whose name hashes to another field', colorField('Home'), { name: 'Other', swatch: 'g1' }, 'skipped'],
    ['a colour whose name has spaces around it', colorField(' Rent '), { name: ' Rent ', swatch: 'g1' }, 'skipped'],
    ['a colour whose name has 41 characters', colorField(long(41)), { name: long(41), swatch: 'g1' }, 'skipped'],
    ['a colour as a plain string', colorField('Tea'), 'g1', 'skipped'],
    ['a colour cleared (null)', colorField('Wine'), null, 'kept'],
    ['color_ with a field name that is not a hash', 'color_x', { name: 'x', swatch: 'g1' }, 'skipped'],
    ['an unknown settings field', 'app_0123456789abcdef', { v: '1.20.0', fmt: 5 }, 'kept'],
    ['item-like fields on the settings record', 'price', 5, 'kept'],
  ];
  return { item, settings };
}

for (const version of VERSIONS) {
  test(`${version}: which ops are kept, skipped by storage, or refused by the crypto layer, and that skipped means for good`, async () => {
    const h = await createHousehold();
    const R = await h.device('reader', { version });
    const mod = R.mod;
    const W = h.writer('future');
    const cases = await refusalCases(mod);
    const all = [];
    cases.item.forEach(([label, f, v, expect], i) => all.push({ label, rec: `item-${i}`, f, v, expect }));
    cases.settings.forEach(([label, f, v, expect]) => all.push({ label, rec: mod.storage.SETTINGS_ID, f, v, expect }));
    const items = all.map((c) => {
      const op = W.op(c.rec, c.f, c.v);
      c.op = op;
      // NaN can't go through JSON: a hand-made envelope carries the text a buggy client would send.
      if (Number.isNaN(c.v)) return { envelope: { ...plainEnvelope(op), c: Buffer.from(JSON.stringify(op).replace('"v":null', '"v":NaN')).toString('base64') } };
      return op;
    });
    // Hand-made envelopes the crypto layer refuses whatever the op: a bad stamp, a mismatched id or wall, not JSON.
    const good = W.op('item-env', 'name', 'ok');
    const envelopes = [
      { label: 'a malformed stamp', envelope: plainEnvelope({ ...good, id: 'env-1', t: 'not-a-stamp' }, { wall: 1 }) },
      { label: 'an envelope id that is not the op id', envelope: { ...plainEnvelope(good), id: 'someone-else' } },
      { label: 'an envelope wall that is not the stamp\'s', envelope: { ...plainEnvelope({ ...good, id: 'env-3' }), wall: 1 } },
      { label: 'a body that is not JSON', envelope: { id: 'env-4', wall: 1, c: Buffer.from('{oops').toString('base64') } },
    ];
    await h.inject([...items, ...envelopes.map((e) => ({ envelope: e.envelope }))]);
    const head = await h.head();
    assert.equal(head, all.length + envelopes.length);

    await R.sync();
    const rep = R.report();
    assert.equal(rep.cursor, head, 'the cursor moves past everything, refused or not');
    const skippedIds = new Set(rep.skipped.map((x) => x.op.id));
    const refusedIds = new Set(rep.refused.map((x) => x.envelope.id));
    const outcome = (c) => {
      if (refusedIds.has(c.op.id)) return 'refused';
      if (skippedIds.has(c.op.id)) return 'skipped';
      return 'kept';
    };
    const got = all.map((c) => `${c.label}: ${outcome(c)}`);
    const want = all.map((c) => `${c.label}: ${c.expect}`);
    assert.deepEqual(got, want);
    // Where several kept ops set one field (currency USD, then null), the last one (later stamp) holds it.
    const lastKept = new Map(all.filter((c) => c.expect === 'kept').map((c) => [`${c.rec}/${c.f}`, c]));
    for (const c of all) {
      const stored = R.record(c.rec)?.fields;
      if (c.expect === 'kept' && lastKept.get(`${c.rec}/${c.f}`) === c) assert.deepEqual(stored?.[c.f], c.v, `${c.label}: stored as sent`);
      // Not stored: the op's stamp never reached its field (other ops may have set the field).
      if (c.expect !== 'kept') assert.notEqual(R.record(c.rec)?.ts?.[c.f], c.op.t, `${c.label}: not stored`);
    }
    assert.ok(!('del' in (R.settingsRecord()?.fields ?? {})), 'the settings record never took a del');
    for (const e of envelopes) assert.ok([...refusedIds].includes(e.envelope.id), `${e.label}: refused`);
    // The engine reports refused envelopes plus skipped ops as "could not be verified".
    const nSkipped = all.filter((c) => c.expect === 'skipped').length;
    const nRefused = all.filter((c) => c.expect === 'refused').length + envelopes.length;
    assert.equal(rep.skipped.length, nSkipped);
    assert.equal(rep.refused.length, nRefused);
    assert.deepEqual(R.warnings, [`Sync: ignored ${nSkipped + nRefused} change(s) that could not be verified.`]);

    // Skipped for good: later syncs read only from the cursor on, so nothing comes back.
    const pullsBefore = h.calls.filter((c) => c.device === 'reader' && c.action === 'pull').length;
    await R.sync();
    await R.sync();
    const later = h.calls.filter((c) => c.device === 'reader' && c.action === 'pull').slice(pullsBefore);
    assert.ok(later.length >= 2 && later.every((c) => c.after === head), 'every later pull starts at the head');
    assert.equal(R.report().skipped.length, nSkipped, 'nothing is retried');
    assert.equal(R.report().refused.length, nRefused);
    const entries = await h.entries();
    assert.equal(entries.length, head, 'the relay still holds every refused op');
  });
}

/* ------------------------------------------------------------------ Unknown cycle, item sheet */

test('1.19.0: an unknown cycle is read as monthly everywhere', async () => {
  const h = await createHousehold();
  const W = await h.device('writer', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  W.save(item('w', { name: 'Pottery class', price: 150, cycle: 'weekly', nextRenewal: '2026-12-05' }));
  await h.syncAll();
  const s = L.item('w');
  assert.equal(s.cycle, 'weekly', 'stored as sent');
  const { insights, util, i18n } = L.mod;
  for (let m = 0; m < 12; m++) assert.equal(insights.dueInMonth(s, 2027, m), 150, `cash in month ${m + 1}`);
  assert.deepEqual(insights.breakdown([s], 2027, 3).byType.map((x) => x.key), ['monthly']);
  assert.equal(util.monthlyCost(s), 150);
  assert.equal(util.annualCost(s), 1800);
  assert.equal(insights.yearTotal([s], 2027), 1800);
  assert.equal(util.cycleLabel(s.cycle), i18n.t('cycle.perMonth'));
  const next = util.nextRenewal(s, new Date(2027, 0, 10));
  assert.deepEqual([next.getFullYear(), next.getMonth(), next.getDate()], [2027, 1, 5], 'rolls forward a month at a time');

  // storage.save keeps whatever cycle the item has: it doesn't check values.
  assert.deepEqual(L.save({ ...s, price: 155 }).map((o) => o.f), ['price']);
  assert.equal(L.item('w').cycle, 'weekly');
  // A backup with that cycle is refused as a whole.
  const file = { app: 'substracker', schemaVersion: 4, exportedAt: '2026-11-19T00:00:00.000Z', items: [L.item('w')] };
  assert.throws(() => L.mod.storage.parseBackup(file), (err) => err instanceof L.mod.storage.ImportError
    && err.message === i18n.t('import.error.itemNamed', { n: 1, name: 'Pottery class', problem: i18n.t('import.error.cycle') }));
});

test('1.19.0 item sheet: an unknown cycle shows as Monthly and is saved back as monthly, whatever else was edited', async () => {
  const h = await createHousehold();
  const W = await h.device('writer', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  W.save(item('w', { name: 'Pottery class', price: 150, cycle: 'weekly', nextRenewal: '2026-12-05' }));
  W.writeFields('w', { repeat: { every: 1, unit: 'week' } });
  await h.syncAll();

  const r = L.formSave('w', { notes: 'Bring an apron' });
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.ops.map((o) => `${o.f}=${o.f === 'updatedAt' ? '…' : JSON.stringify(o.v)}`).sort(),
    ['cycle="monthly"', 'notes="Bring an apron"', 'updatedAt=…'], 'cycle is rewritten though nobody touched it');
  await h.syncAll();
  assert.equal(W.item('w').cycle, 'monthly', 'the household now has monthly');
  assert.deepEqual(W.record('w').fields.repeat, { every: 1, unit: 'week' }, 'the stored repeat is untouched');
  // The cycle's stamp is now newer than the repeat's, so for the current reader repeat no longer
  // counts and isn't part of the item (format 5's rule); 1.19.0 shows the raw field as it always did.
  assert.equal('repeat' in W.item('w'), W.version === 'legacy');

  // Opened and saved with no change at all: the cycle is written all the same.
  W.save({ ...W.item('w'), cycle: 'quarterly' });
  await h.syncAll();
  const again = L.formSave('w', {});
  assert.deepEqual(again.ops.map((o) => o.f).sort(), ['cycle', 'updatedAt']);
  assert.equal(again.saved.cycle, 'monthly');
});

test('1.19.0 item sheet: a recurring item needs a date to be saved; Annual and Once are kept', async () => {
  const h = await createHousehold();
  const L = await h.device('legacy', { version: 'legacy' });
  const { t } = L.mod.i18n;
  L.save(item('u', { name: 'Undated plan', nextRenewal: '' }));
  L.save(item('i', { type: 'income', name: 'Salary', category: '', nextRenewal: '' }));
  L.save(item('y', { name: 'Domain', cycle: 'annual', nextRenewal: '2027-03-01' }));
  L.save(item('o', { name: 'Concert', cycle: 'once', nextRenewal: '', date: '2026-12-24' }));

  const undated = L.formSave('u', { price: '120' });
  assert.equal(undated.saved, null, 'not saved');
  assert.deepEqual(undated.errors, { nextRenewal: t('form.error.renewal.expense') });
  const income = L.formSave('i', { price: '5000' });
  assert.equal(income.saved, null);
  assert.deepEqual(income.errors, { nextRenewal: t('form.error.renewal.income') });
  const fixed = L.formSave('u', { price: '120', nextRenewal: '2026-12-10' });
  assert.equal(fixed.saved.nextRenewal, '2026-12-10');
  assert.deepEqual(fixed.ops.map((o) => o.f).sort(), ['nextRenewal', 'price', 'updatedAt']);

  const fresh = L.formSave(null, { name: 'New plan', price: '99' });
  assert.equal(fresh.saved, null, 'a new recurring item without a date');
  assert.deepEqual(fresh.errors, { nextRenewal: t('form.error.renewal.expense') });
  const freshOnce = L.formSave(null, { name: 'Gift', price: '99', cycle: 'once' });
  assert.deepEqual(freshOnce.errors, { date: t('form.error.date') });
  const badDate = L.formSave('y', { nextRenewal: '2027-02-30' });
  assert.equal(badDate.saved, null, 'a date input keeps only real dates, so 30 February is no date');

  assert.deepEqual(L.formSave('y', { price: '500' }).ops.map((o) => o.f).sort(), ['price', 'updatedAt'], 'annual stays annual');
  assert.deepEqual(L.formSave('o', { price: '1500' }).ops.map((o) => o.f).sort(), ['price', 'updatedAt'], 'once stays once');
  assert.equal(L.item('y').cycle, 'annual');
  assert.equal(L.item('o').cycle, 'once');
});

/* ------------------------------------------------------------------ Tombstones, stamps, skew */

for (const [first, second] of PAIRS) {
  test(`${first} + ${second}: a delete beats an older edit, and a later edit never brings a deleted item back`, async () => {
    const time = manualTime();
    const h = await createHousehold({ relayNow: time.now() });
    const A = await h.device('devA', { version: first, now: time.now() });
    const B = await h.device('devB', { version: second, now: time.now() });
    A.save(item('x', { name: 'Gym', price: 900 }));
    A.save(item('y', { name: 'Magazine', price: 120 }));
    await h.syncAll();

    // x: A edits offline first, B deletes later. y: B deletes first, A edits later (offline).
    A.offline();
    time.advance();
    A.save({ ...A.item('x'), price: 950 });
    time.advance();
    B.remove('x');
    B.remove('y');
    time.advance();
    A.save({ ...A.item('y'), price: 130 });
    A.online();
    await h.syncAll(3);

    for (const d of [A, B]) {
      assert.deepEqual(d.tombstones(), ['x', 'y'], `${d.name}: both deleted`);
      assert.deepEqual(d.items(), [], `${d.name}: no live items`);
      assert.equal(d.record('y').fields.price, 130, `${d.name}: the later edit landed on the tombstone`);
      assert.equal(d.record('x').fields.price, 950);
    }
    // A live edit on a deleted record isn't possible locally: save() would revive it (putRecord),
    // which is the import / re-add path, by design. The tombstone itself never flips back by sync.
    assert.equal(A.record('x').fields.del, true);
    assert.equal(B.record('x').fields.del, true);
  });

  test(`${first} + ${second}: concurrent edits of one field end with the later stamp, whatever the delivery order`, async () => {
    const time = manualTime();
    const h = await createHousehold({ relayNow: time.now() });
    const A = await h.device('devA', { version: first, now: time.now() });
    const B = await h.device('devB', { version: second, now: time.now() });
    A.save(item('x', { name: 'Streaming', price: 250 }));
    await h.syncAll();
    A.offline();
    B.offline();
    time.advance();
    const opsA = A.save({ ...A.item('x'), name: 'Streaming (A)' });
    const opsB = B.save({ ...B.item('x'), name: 'Streaming (B)' }); // same wall: the device id breaks the tie
    time.advance();
    const lateA = A.save({ ...A.item('x'), price: 260 });
    assert.ok(opsB[0].t > opsA[0].t, 'devB sorts after devA at the same wall time');

    // Deliver the same ops to fresh devices of both versions, in both orders.
    const history = [...(await h.entries())].map((e) => e.op);
    for (const v of [first, second]) {
      for (const order of [[...opsA, ...lateA, ...opsB], [...opsB, ...lateA, ...opsA]]) {
        const C = await h.device(`fresh-${v}-${h.devices.length}`, { version: v, joined: false, now: time.now() });
        await C.deliver([...history, ...order], { cursor: 0 });
        assert.equal(C.item('x').name, 'Streaming (B)', `${v}: later stamp wins`);
        assert.equal(C.item('x').price, 260, `${v}: other fields merge`);
      }
    }
    A.online();
    B.online();
    await h.syncAll(3);
    for (const d of [A, B]) {
      assert.equal(d.item('x').name, 'Streaming (B)');
      assert.equal(d.item('x').price, 260);
    }
  });

  test(`${first} + ${second}: a clock up to 24 hours ahead wins by stamp; beyond 24 hours the relay holds the change back`, async () => {
    const time = manualTime();
    const h = await createHousehold({ relayNow: time.now() });
    const A = await h.device('devA', { version: first, now: time.now(23 * HOUR) });
    const B = await h.device('devB', { version: second, now: time.now() });
    B.save(item('x', { name: 'Cloud', price: 100 }));
    await h.syncAll();
    time.advance();
    A.save({ ...A.item('x'), price: 110 }); // stamped 23 h ahead
    await A.sync();
    time.advance(HOUR); // B edits an hour later in real time, before it has seen A's change
    B.save({ ...B.item('x'), price: 120 });
    await h.syncAll(3);
    for (const d of [A, B]) assert.equal(d.item('x').price, 110, `${d.name}: the stamp 23 h ahead still wins`);
    // Having seen it, B's clock moved forward, so B's next edit sorts after it.
    assert.ok(B.s.clock.wall >= Number(A.record('x').ts.price.slice(0, 15)));
    B.save({ ...B.item('x'), price: 130 });
    await h.syncAll(3);
    for (const d of [A, B]) assert.equal(d.item('x').price, 130, `${d.name}: an edit made after seeing it wins`);

    // A device 25 hours ahead: the relay refuses its op; it stays queued with the clock message.
    const F = await h.device('devF', { version: first, now: time.now(25 * HOUR) });
    await F.sync();
    F.save({ ...F.item('x'), price: 999 });
    await F.sync();
    assert.equal(F.report().outbox.length, 1, 'still queued');
    assert.equal(F.report().status.lastError, F.mod.i18n.t('sync.clockAhead'));
    await h.syncAll(2);
    assert.equal(B.item('x').price, 130, 'nobody else got it');
  });
}

/* ------------------------------------------------------------------ The settings record */

for (const version of VERSIONS) {
  test(`${version}: the reserved settings record is never an item, whatever fields it gets`, async () => {
    const h = await createHousehold();
    const D = await h.device('dev', { version });
    const { storage, insights, i18n } = D.mod;
    const W = h.writer('future');
    await W.push([
      ...W.fields(storage.SETTINGS_ID, { name: 'Sneaky', price: 5, currency: 'TWD', cycle: 'monthly', nextRenewal: '2026-12-01', type: 'expense' }),
      W.op(storage.SETTINGS_ID, 'del', false),
      W.op(storage.SETTINGS_ID, 'defaultCurrency', 'JPY'),
    ]);
    D.choose({ groupColors: { Food: 'g3' } });
    await D.sync();
    assert.deepEqual(D.items(), [], 'no items');
    assert.equal(await D.store.liveItemCount(), 0);
    assert.equal(D.settingsRecord().fields.name, 'Sneaky', 'item-like fields are kept on the record (unknown settings)');
    assert.ok(!('del' in D.settingsRecord().fields), 'del was skipped');
    assert.equal(D.report().skipped.length, 1);
    assert.equal(insights.cashDue(D.items(), 2026, 11), 0);
    assert.deepEqual(JSON.parse(D.exportBackup()).items, [], 'not in a backup');
    assert.equal(D.settings().defaultCurrency, 'JPY');
    // Local guards: no item may use the id, and a backup can't carry it.
    assert.throws(() => D.save(item(storage.SETTINGS_ID)), /reserved/);
    const file = { app: 'substracker', schemaVersion: 4, exportedAt: '2026-11-19T00:00:00.000Z', items: [item(storage.SETTINGS_ID)] };
    assert.throws(() => storage.parseBackup(file), (err) => err.message.includes(i18n.t('import.error.idReserved', { id: storage.SETTINGS_ID })));
    // Requeueing everything (a new household, a relay that lost its data) never sends a del for it.
    const requeued = storage.requeueOps([...D.s.records.values()]);
    assert.ok(requeued.some((o) => o.rec === storage.SETTINGS_ID));
    assert.ok(!requeued.some((o) => o.rec === storage.SETTINGS_ID && o.f === 'del'));
  });
}

/* ------------------------------------------------------------------ Join */

for (const [household, joiner] of PAIRS) {
  test(`a ${joiner} device joins a ${household} household that holds unknown fields: merge, then replace`, async () => {
    const h = await createHousehold();
    const H = await h.device('home', { version: household });
    const { colorField, SETTINGS_ID } = H.mod.storage;
    H.save(item('a', { name: 'Pottery class', price: 150 }));
    H.writeFields('a', { repeat: { every: 1, unit: 'week' } });
    H.writeFields(SETTINGS_ID, { [colorField('Hobbies')]: { name: 'Hobbies', swatch: 'w15', slot: 14 }, app_00000000000000aa: { v: '1.20.0', fmt: 5 } });
    await H.sync();

    // Merge: the joiner's own item goes to the household, and it gets the unknown fields.
    const M = await h.device('merger', { version: joiner, joined: false });
    M.save(item('m', { name: 'Mine', price: 10 }));
    await M.join('merge');
    await h.syncAll(3);
    for (const d of [H, M]) {
      assert.deepEqual(d.items().map((x) => x.id), ['a', 'm'], `${d.name}: both items`);
      assert.deepEqual(d.record('a').fields.repeat, { every: 1, unit: 'week' });
      assert.deepEqual(d.settingsRecord().fields[colorField('Hobbies')], { name: 'Hobbies', swatch: 'w15', slot: 14 });
      assert.deepEqual(d.settingsRecord().fields.app_00000000000000aa, { v: '1.20.0', fmt: 5 });
    }
    assert.deepEqual(M.report().skipped, []);
    M.formSave('a', { price: '160' });
    await h.syncAll(2);
    assert.deepEqual(H.record('a').fields.repeat, { every: 1, unit: 'week' }, 'the joiner\'s edit keeps it');
    assert.equal(H.item('a').price, 160);

    // Replace: the joiner's items give way to exactly the household's records, nothing is sent back.
    const P = await h.device('replacer', { version: joiner, joined: false });
    P.save(item('p', { name: 'Gone after join', price: 1 }));
    const pushesBefore = h.calls.filter((c) => c.device === 'replacer' && c.action === 'push' && c.count > 0).length;
    await P.join('replace');
    assert.deepEqual(P.items().map((x) => x.id), ['a', 'm']);
    assert.deepEqual(P.record('a').fields.repeat, { every: 1, unit: 'week' });
    assert.deepEqual(P.settingsRecord(), H.settingsRecord(), 'the same settings record, stamps and all');
    assert.equal(P.report().outbox.length, 0);
    assert.equal(h.calls.filter((c) => c.device === 'replacer' && c.action === 'push' && c.count > 0).length, pushesBefore, 'nothing pushed');
    assert.equal(P.record('p'), null, 'its own item is gone, with no tombstone sent');
  });
}

/* ------------------------------------------------------------------ Backups */

/** A 1.19.0 device with one of everything a backup holds. */
async function richLegacyDevice(h, name = 'legacy') {
  const L = await h.device(name, { version: 'legacy', joined: false });
  L.save(item('n', { name: 'Netflix', domain: 'netflix.com', emoji: '🎬', plan: 'Standard', price: 390, category: 'Entertainment', notes: 'Shared, "family" plan, line 1\nline 2' }));
  L.save(item('d', { name: 'Domain', cycle: 'annual', nextRenewal: '2027-02-28', price: 12.5, currency: 'USD', category: 'Software' }));
  L.save(item('c', { name: 'Concert', cycle: 'once', nextRenewal: '', date: '2026-12-24', price: 2400, category: '' }));
  L.save(item('s', { type: 'income', name: 'Salary', category: '', price: 60000, nextRenewal: '2026-12-01' }));
  L.save(item('u', { name: '未設日期 plan', nextRenewal: '', category: '居住', price: 30000 }));
  L.choose({ defaultCurrency: 'TWD', groupColors: { Entertainment: 'g5', 居住: 'g8' } });
  L.setLocal({ autoGroupColors: { Software: 'w4', Uncategorised: 'w7' } });
  return L;
}

test('round trip: 1.19.0 backup -> current import -> current export -> 1.19.0 import loses nothing', async () => {
  const h = await createHousehold();
  const L = await richLegacyDevice(h);
  const original = L.items();
  const file1 = L.exportBackup('2026-11-19T00:00:00.000Z');

  const C = await h.device('current', { version: 'current', joined: false });
  const sum1 = C.importBackup(file1, 'replace');
  assert.equal(sum1.newerVersion, false);
  assert.deepEqual(C.items(), original, 'current has exactly the items');
  const file2 = C.exportBackup('2026-11-19T00:00:00.000Z');
  // Format 5 adds nothing when there is no repeat or slot: the same file but for its version number.
  assert.equal(JSON.parse(file2).schemaVersion, 5);
  assert.equal(file2.replace('"schemaVersion": 5,', '"schemaVersion": 4,'), file1, 'the current export is the same file, byte for byte, but for the version');

  const L2 = await h.device('legacy2', { version: 'legacy', joined: false });
  L2.importBackup(file2, 'replace');
  assert.deepEqual(L2.items(), original, 'back on 1.19.0: every item, field for field');
  assert.equal(L2.settings().defaultCurrency, 'TWD');
  assert.deepEqual(L2.settings().groupColors, { Entertainment: 'g5', 居住: 'g8' }, 'picked colours survive');
  // What doesn't travel (by design in 1.19.0): this device's automatic colours (F9).
  assert.ok(!JSON.parse(file1).settings.groupColors.Software, 'automatic w colours are left out of backups');
});

test('1.19.0 backups: unknown item fields are in the file; 1.19.0\'s import drops them, the current one keeps a usable repeat; a newer file still imports', async () => {
  const h = await createHousehold();
  const W = await h.device('writer', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  W.save(item('a', { name: 'Pottery class', price: 150 }));
  W.writeFields('a', { repeat: { every: 1, unit: 'week' } });
  await h.syncAll();
  const file = JSON.parse(L.exportBackup());
  assert.deepEqual(file.items[0].repeat, { every: 1, unit: 'week' }, 'in the 1.19.0 file');

  for (const v of VERSIONS) {
    const fresh = await h.device(`fresh-${v}`, { version: v, joined: false });
    fresh.importBackup(JSON.stringify(file), 'replace');
    // Format 5's reader keeps a `repeat` that agrees with the cycle (weekly's shadow is monthly).
    const want = v === 'legacy' ? undefined : { every: 1, unit: 'week' };
    assert.deepEqual(fresh.record('a').fields.repeat, want, `${v}: what the import keeps`);
    assert.equal(fresh.item('a').price, 150);
  }

  // A file from a newer version (schemaVersion 5): accepted, flagged, unknown fields ignored.
  const newer = { ...file, schemaVersion: 5, items: [{ ...file.items[0], price: 175, repeat: { every: 2, unit: 'week' } }], settings: { groupSlots: { Food: 3 } } };
  const sum = L.importBackup(JSON.stringify(newer), 'merge');
  assert.equal(sum.newerVersion, true);
  assert.equal(L.mod.storage.planFromBackup(L.mod.storage.parseBackup(newer), [], {}).merge.summary.newerVersion, true);
  // Merge: the file's item is newer only if its updatedAt is; here it's the same, so nothing changes.
  assert.equal(L.item('a').price, 150);
  const newer2 = { ...newer, items: [{ ...newer.items[0], updatedAt: '2030-01-01T00:00:00.000Z' }] };
  L.importBackup(JSON.stringify(newer2), 'merge');
  assert.equal(L.item('a').price, 175, 'the newer item wins');
  assert.deepEqual(L.record('a').fields.repeat, { every: 1, unit: 'week' }, 'the stored unknown field is untouched (the file\'s is dropped)');
  assert.deepEqual(L.settings().groupColors, {}, 'unknown settings in the file are ignored');
});

/* ------------------------------------------------------------------ Real encryption */

test('legacy and current devices interoperate with real end-to-end encryption too', async () => {
  const h = await createHousehold({ crypto: 'real' });
  const L = await h.device('legacy', { version: 'legacy' });
  const C = await h.device('current', { version: 'current' });
  C.save(item('a', { name: 'Pottery class' }));
  C.writeFields('a', { repeat: { every: 1, unit: 'week' } });
  L.save(item('b', { name: 'Gym' }));
  await h.syncAll(3);
  assert.deepEqual(L.record('a').fields.repeat, { every: 1, unit: 'week' });
  assert.equal(C.item('b').name, 'Gym');
  L.remove('a');
  await h.syncAll(2);
  assert.deepEqual(C.tombstones(), ['a']);
  const entries = await h.entries();
  assert.ok(entries.length > 0 && entries.every((e) => e.op), 'every entry decrypts with the household key');
  assert.deepEqual([...L.report().refused, ...C.report().refused], []);
});

/* ------------------------------------------------------------------ The harness follows the app */

test('the code the harness follows is still in js/ (update tests/helpers/mixed-sync.js if this fails)', async () => {
  const storageSrc = readFileSync(new URL('../js/storage.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  for (const line of [
    'return Object.fromEntries(ITEM_FIELDS.filter((f) => item[f] !== undefined).map((f) => [f, item[f]]));',
    'await commit((r) => sync.putRecord(r, item.id, itemFields(item)), { ids: [item.id] });',
    'await commit((r) => sync.deleteRecord(r, id), { ids: [id] });',
    'await commit((r) => settingsOps(r, shared), { ids: [SETTINGS_ID], settings: local });',
    'return (await exportBackup()).payload;',
    'return exportBackupFrom(items, settings, new Date().toISOString());',
    'const [items, settings] = await Promise.all([getAll(), getSettings()]);',
    'await commit((replica) => importChange(replica, plan), { settings: replaceColors ? { [AUTO_COLORS]: {} } : {} });',
    'return effectiveSettings(local, rec);',
  ]) assert.ok(storageSrc.includes(line), `js/storage.js: ${line}`);
  for (const line of [
    'const fromForm = readForm();',
    'const sub = mergeFormEdit(fromForm);',
    'await storage.save(sub);',
    'if (newCard) await storage.saveItemWithCard(sub, newCard.id, newCard.card);',
    'const newCard = fromForm.newCard ?? null;',
    'delete fromForm.newCard;',
    'payload.items.sort(byName);',
    'if (colours) payload.settings.groupColors = Object.fromEntries(Object.entries(colours).filter(([k]) => state.colorPicks.has(k)));',
    'if (slots) payload.settings.groupSlots = Object.fromEntries(Object.entries(slots).filter(([k]) => state.colorPicks.has(k)));',
    'f.cycle.value = sub.cycle;',
    'const plan = planSlots({ live: names, shared: new Map([...shared].filter(([n]) => names.includes(n))), held });',
    'else if (isWalletKey(map[n])) held.set(n, Number(map[n].slice(1)) - 1); // this device\'s own automatic colour',
    'storage.saveColourValues(fields).catch((err) => console.error(err));',
  ]) assert.ok(appSrc.includes(line), `js/app.js: ${line}`);
  const mod = await loadVersion('current');
  assert.ok(/^const isDay = /m.test(mod.appSource));
});
