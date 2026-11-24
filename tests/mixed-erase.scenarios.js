// Mixed-version scenarios for Erase data on this device (1.28.0; js/erase.js, js/app.js bindErase,
// js/storage.js eraseDatabase): the erase reaches this device only. A household of the current js/,
// a frozen 1.19.0 device and a frozen 1.25.1 one (tests/helpers/mixed-sync.js): device A is refused
// while it can sync, turns sync off, erases; the relay gets nothing and the other devices, old ones
// included, lose nothing after syncing; A joins again and sends only its new version note, never a
// `del`. Loaded by tests/mixed-version.node.test.js and tests/mixed-version-tz.node.test.js. Items
// and names are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHousehold } from './helpers/mixed-sync.js';
import { listCards } from '../js/cards.js';
import { versionNoteField } from '../js/storage.js';

const SETTINGS = 'settings';

const item = (id, over = {}) => ({
  id, type: 'expense', name: `Item ${id}`, domain: '', emoji: '', plan: '', price: 120, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-12-05', date: '', category: 'Hobbies', notes: '',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});

function manualTime(start = Date.UTC(2026, 10, 24, 4, 0, 0)) {
  const c = { t: start };
  c.advance = (ms = 1000) => { c.t += ms; return c.t; };
  c.now = (skew = 0) => () => c.t + skew;
  return c;
}

/** A household with data from every version: A and D current, L 1.19.0, M 1.25.1. */
async function household({ crypto } = {}) {
  const time = manualTime();
  const h = await createHousehold({ crypto, relayNow: time.now() });
  const A = await h.device('A', { version: 'current', now: time.now() });
  const D = await h.device('D', { version: 'current', now: time.now(5) });
  const L = await h.device('L', { version: 'legacy', now: time.now(10) });
  const M = await h.device('M', { version: 'legacy125', now: time.now(15) });
  A.save(item('a1', { name: 'Streaming', pay: 'k_visa' }));
  A.saveCard('k_visa', { name: 'Visa', colour: 'c7', due: 10 });
  A.choose({ defaultCurrency: 'TWD', groupColors: { Hobbies: 'g3' } });
  time.advance();
  L.save(item('l1', { name: 'Gym', category: 'Health' }));
  M.save(item('m1', { name: 'Rent', price: 18000, category: 'Housing' }));
  D.save(item('d1', { name: 'Books' }));
  await h.syncAll(2);
  return { h, time, A, D, L, M };
}

/** What a device holds, to compare before and after (the cursor and outbox aside). */
const holdings = (d) => ({ items: d.items(), settingsRecord: d.settingsRecord(), tombstones: d.tombstones() });

for (const crypto of ['plain', 'real']) {
  test(`erase (${crypto}): refused while A can sync; after Turn off, the relay and every other device are unchanged`, async () => {
    const { h, time, A, D, L, M } = await household({ crypto });
    assert.equal(A.items().length, 4, 'A has the household\'s items');
    assert.equal(listCards(A.settingsRecord()).length, 1);

    // Refused while A can sync: nothing changes.
    const head0 = await h.head();
    await assert.rejects(A.erase(), /refused/);
    assert.equal(A.items().length, 4, 'A kept everything');
    assert.equal(await h.head(), head0);

    const others = [D, L, M];
    const before = new Map(others.map((d) => [d.name, holdings(d)]));
    const entriesBefore = await h.entries();

    // Settings → Sync → Turn off, then Erase.
    await A.turnOff();
    time.advance();
    const oldId = A.deviceId;
    const newId = await A.erase();
    assert.notEqual(newId, oldId, 'a new device id, as a new install');
    assert.deepEqual(A.items(), [], 'nothing left on A');
    assert.deepEqual(A.tombstones(), [], 'no tombstone was made');
    const rec = A.settingsRecord();
    assert.deepEqual(Object.keys(rec.fields), [versionNoteField(newId)], 'only the new version note');
    assert.equal(rec.fields[versionNoteField(newId)].v, '1.28.0');
    const outbox = A.report().outbox;
    assert.deepEqual(outbox.map((o) => [o.rec, o.f]), [[SETTINGS, versionNoteField(newId)]], 'only the note waits to send');
    assert.ok(outbox.every((o) => o.f !== 'del' && o.dev === newId));
    assert.equal(A.s.config.householdKey, '', 'no key');

    // Everyone syncs, twice: A can't send anything, and nobody loses anything.
    for (let i = 0; i < 2; i++) { time.advance(); await h.syncAll(1); }
    assert.equal(await h.head(), head0, 'the relay received nothing');
    assert.deepEqual(await h.entries(), entriesBefore, 'its entries are as they were');
    for (const d of others) {
      assert.deepEqual(holdings(d), before.get(d.name), `${d.label} ${d.name}: unchanged`);
      assert.deepEqual(d.report().skipped, [], `${d.name}: nothing skipped`);
      assert.deepEqual(d.report().refused, [], `${d.name}: nothing refused`);
    }
    assert.equal(A.engine.getStatus().state, 'off', 'A: sync is off');
    assert.equal(A.report().outbox.length, 1, 'the note still waits on A');
  });
}

test('erase: A joins again with "Use the household\'s data" (an empty device) and sends only its new note, no del', async () => {
  const { h, time, A, D, L, M } = await household();
  await A.turnOff();
  time.advance();
  const newId = await A.erase();
  const head0 = await h.head();
  const before = new Map([D, L, M].map((d) => [d.name, holdings(d)]));

  time.advance();
  await A.join('replace'); // js/pairing.js chooseJoinMode: a device with no items joins this way
  assert.equal(await h.head(), head0, 'joining sends nothing');
  assert.deepEqual(A.items().map((x) => x.id), ['a1', 'd1', 'l1', 'm1'], 'A has the household\'s data again');
  assert.equal(listCards(A.settingsRecord()).length, 1, 'and its card');
  assert.deepEqual(A.report().outbox, [], 'the household\'s data replaced the queued note');

  // The next launch writes the note again (refreshVersionNote), and it syncs.
  time.advance();
  const note = A.relaunch();
  assert.deepEqual(note.map((o) => o.f), [versionNoteField(newId)]);
  await h.syncAll(2);
  const sent = (await h.entries()).slice(head0);
  assert.deepEqual(sent.map((e) => [e.op.rec, e.op.f, e.op.dev]), [[SETTINGS, versionNoteField(newId), newId]], 'only the new note reached the relay');
  assert.ok(sent.every((e) => e.op.f !== 'del'));
  for (const d of [D, L, M]) {
    const now = holdings(d);
    assert.deepEqual(now.items, before.get(d.name).items, `${d.name}: items unchanged`);
    assert.deepEqual(now.tombstones, [], `${d.name}: no tombstone`);
    const { [versionNoteField(newId)]: added, ...rest } = now.settingsRecord.fields;
    assert.deepEqual(rest, before.get(d.name).settingsRecord.fields, `${d.name}: the settings record gained only the note`);
    assert.equal(added?.v, '1.28.0', `${d.name}: the note arrived`);
    assert.deepEqual(d.report().skipped, [], `${d.name}: nothing skipped`);
  }
});

test('erase: A joins again with Merge and sends only its new note, no del; the others lose nothing', async () => {
  const { h, time, A, D, L, M } = await household();
  await A.turnOff();
  time.advance();
  const newId = await A.erase();
  const head0 = await h.head();
  const before = new Map([D, L, M].map((d) => [d.name, holdings(d)]));
  time.advance();
  await A.join('merge');
  await h.syncAll(2);
  const sent = (await h.entries()).slice(head0);
  assert.deepEqual(sent.map((e) => [e.op.rec, e.op.f, e.op.dev]), [[SETTINGS, versionNoteField(newId), newId]]);
  assert.deepEqual(A.items().map((x) => x.id), ['a1', 'd1', 'l1', 'm1']);
  for (const d of [D, L, M]) {
    assert.deepEqual(holdings(d).items, before.get(d.name).items, `${d.name}: items unchanged`);
    assert.deepEqual(holdings(d).tombstones, [], `${d.name}: no tombstone`);
  }
});

test('erase: the old devices keep A\'s data, and A\'s old note stays in the household (it can\'t be removed without an op)', async () => {
  const { h, time, A, L, M } = await household();
  const oldNote = versionNoteField(A.deviceId);
  A.relaunch(); // A's note, as its launches write it
  await h.syncAll(2);
  assert.ok(L.settingsRecord().fields[oldNote], '1.19.0 keeps the note it doesn\'t read');
  await A.turnOff();
  time.advance();
  await A.erase();
  await h.syncAll(2);
  for (const d of [L, M]) {
    assert.ok(d.item('a1'), `${d.name}: A's item is still there`);
    assert.ok(d.settingsRecord().fields[oldNote], `${d.name}: A's old note stays`);
  }
});

/* ------------------------------------------------------------------ The harness follows the app */

test('the erase code the harness follows is still in js/ (update tests/helpers/mixed-sync.js if this fails)', () => {
  const src = (f) => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const app = src('app.js');
  for (const line of [
    'stop: () => syncParts?.engine?.stop(),',
    'database: ({ onBlocked }) => storage.eraseDatabase({ onBlocked }),',
    'const reason = await block();',
    'if (reason) { setBusy(\'\'); show(\'blocked\', reason); return; }',
    "if (storage.wasErased()) return; // erased meanwhile: the app opens again as a fresh launch",
  ]) assert.ok(app.includes(line), `js/app.js: ${line}`);
  const storage = src('storage.js');
  for (const line of [
    'const req = indexedDB.deleteDatabase(dbName);',
    'if (erased) return Promise.reject(new Error(ERASED));',
    '...versionNoteOps(replica, { deviceId: devRow.value, version: appVersion, fmt: FORMAT, now }),',
    "const deviceId = sync.isDeviceId(m.deviceId) ? m.deviceId : uid();",
  ]) assert.ok(storage.includes(line), `js/storage.js: ${line}`);
  const erase = src('erase.js');
  assert.ok(erase.includes("return status.paired && !status.keyUnavailable ? 'sync' : null;"));
  const pairing = src('pairing.js');
  assert.ok(pairing.includes('if (!localItems) return JOIN_REPLACE;'), 'an empty device joins with the household\'s data');
});
