// In-browser tests for format 5's first-launch step (js/storage.js migrateFormat, the pure parts in
// js/format-migration.js): the verified run on a database left by 1.22.2, a failure injected at each
// step (plan, write, read-back, switch) leaving the data unchanged and retrying on the next load,
// running twice, an empty database, only picked colours, undated items, and a household record that
// already holds slot values. Open tests/format-migration.html from a local server. Each test uses its
// own throwaway database; the data is made up. This file reads IndexedDB directly only to compare
// the stores before and after; the code under test goes through storage.js.

import * as storage from '../js/storage.js';
import * as syncCore from '../js/sync-core.js';

const results = [];
const created = [];
let n = 0;
const VERSION = '1.23.0';

function test(name, fn) { results.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
}

function rawOpen(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function rawAll(db, store) {
  return new Promise((resolve) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => resolve(q.result); });
}
/** Every store of database `name`, as storage.js left it (its connection closed first). */
async function snapshot(name) {
  storage.useDatabase('substracker-test-fmt-idle');
  await new Promise((r) => setTimeout(r, 50));
  const db = await rawOpen(name);
  try {
    const out = {};
    for (const s of ['records', 'outbox', 'meta', 'settings', 'items']) out[s] = await rawAll(db, s);
    return out;
  } finally { db.close(); }
}
const metaOf = (snap) => Object.fromEntries(snap.meta.map((r) => [r.key, r.value]));
const settingsRec = (snap) => snap.records.find((r) => r.id === storage.SETTINGS_ID) ?? null;
const itemRecs = (snap) => snap.records.filter((r) => r.id !== storage.SETTINGS_ID);

const T1 = '2026-01-01T00:00:00.000Z';
const item = (id, over = {}) => ({
  id, type: 'expense', name: `Sample ${id}`, domain: '', emoji: '', plan: '', price: 120, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-12-05', date: '', category: 'Pets', notes: '', createdAt: T1, updatedAt: T1, ...over,
});

/**
 * A database as 1.22.2 (or this stack before the step) leaves it: records, shared settings, this
 * device's automatic colours in its settings store, schemaVersion 4. Built through storage.js with no
 * app version set, so the step doesn't run. Returns the database name.
 */
async function seedBefore({ items = [], autoColors = {}, picks = {}, remote = [] } = {}) {
  storage.setAppVersion(null);
  const name = `substracker-test-fmt-${Date.now()}-${n++}`;
  created.push(name);
  storage.useDatabase(name);
  for (const it of items) await storage.save(it);
  if (Object.keys(picks).length) await storage.saveSettings({ groupColors: picks });
  if (Object.keys(autoColors).length) await storage.saveLocalDefaults({ groupColors: autoColors });
  if (remote.length) await storage.applyRemote(remote, 1);
  const st = await storage.status();
  eq([st.schemaVersion, st.settingsShared, st.formatMigration], [4, true, null], 'seeded as before the step');
  return name;
}
/**
 * Load the database again as the app would (the step runs on open, or once it's verified the
 * version-note refresh), with `fault` injected, as app version `version`.
 */
async function reload(name, fault = null, version = VERSION) {
  storage.setAppVersion(version);
  storage.setMigrationFault(fault);
  storage.useDatabase(name);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await storage.getAll();
    return { status: await storage.status(), warnings };
  } finally { console.warn = warn; storage.setMigrationFault(null); }
}
const colourValue = (rec, group) => rec?.fields?.[storage.colorField(group)];

const SEED = {
  items: [item('a', { category: 'Pets' }), item('b', { category: 'Garden', cycle: 'annual', nextRenewal: '2027-03-31' }),
    item('c', { category: '' }), item('d', { type: 'income', category: 'Salary', name: 'Sample pay' })],
  autoColors: { Pets: 'w3', Garden: 'w12', Uncategorised: 'w7' },
};

/* ------------------------------------------------------------------ The verified run */

test('on a 1.22.2 database: adopts this device\'s automatic colours, writes the note, reads back, then schemaVersion 5', async () => {
  const name = await seedBefore(SEED);
  const before = await snapshot(name);
  const { status, warnings } = await reload(name);
  eq(warnings, [], 'no warning');
  eq([status.schemaVersion, status.formatMigration.verified, status.formatMigration.fields, status.formatMigration.groups], [5, true, 4, 3], 'status');
  eq(status.formatMigration.stepper, { checked: 4, skipped: 0, custom: 0 }, 'stepper check');
  const after = await snapshot(name);
  const rec = settingsRec(after);
  eq(colourValue(rec, 'Pets'), { name: 'Pets', swatch: 'w3', slot: 2, auto: true }, 'Pets as this device showed it');
  eq(colourValue(rec, 'Garden'), { name: 'Garden', swatch: 'w12', slot: 11, auto: true }, 'Garden');
  eq(colourValue(rec, 'Uncategorised'), { name: 'Uncategorised', swatch: 'w7', slot: 6, auto: true }, 'Uncategorised');
  const note = rec.fields[storage.versionNoteField(metaOf(after).deviceId)];
  eq([note.v, note.fmt, /^\d{4}-\d{2}-\d{2}$/.test(note.at)], [VERSION, 5, true], 'this device\'s version note');
  eq(itemRecs(after), itemRecs(before), 'item records untouched');
  eq(after.settings, before.settings, 'settings store untouched (only read)');
  const newOps = after.outbox.filter((op) => !before.outbox.some((o) => o.id === op.id));
  eq(newOps.map((op) => op.f).sort(), Object.keys(rec.fields).filter((f) => !settingsRec(before)?.fields?.[f]).sort(), 'one outbox op per new field');
  eq(metaOf(after).schemaVersion, 5, 'meta.schemaVersion');
  storage.useDatabase(name);
  eq((await storage.getSettings()).groupSlots, { Garden: 11, Pets: 2, Uncategorised: 6 }, 'read as shared slots');
});

/* ------------------------------------------------------------------ Failures at each step */

for (const step of ['plan', 'write']) {
  test(`a failure at "${step}" changes nothing at all, shows nothing, and the next load does it`, async () => {
    const name = await seedBefore(SEED);
    const before = await snapshot(name);
    const { status, warnings } = await reload(name, step);
    eq([status.schemaVersion, status.formatMigration], [4, { verified: false, step }], 'not switched');
    eq(warnings.length, 1, 'one console warning');
    assert(!/Pets|Garden|Sample/.test(warnings[0]), 'the warning names no group or item');
    eq(await snapshot(name), before, 'every store exactly as before');
    const retry = await reload(name);
    eq(retry.warnings, [], 'no warning on the retry');
    eq([retry.status.schemaVersion, retry.status.formatMigration.verified], [5, true], 'verified on the next load');
  });
}

for (const step of ['readback', 'switch']) {
  test(`a failure at "${step}" leaves only the planned values (nothing overwritten), isn't switched, and the next load verifies`, async () => {
    const name = await seedBefore({ ...SEED, picks: { Garden: 'g4' } });
    const before = await snapshot(name);
    const { status, warnings } = await reload(name, step);
    eq([status.schemaVersion, status.formatMigration], [4, { verified: false, step }], 'not switched');
    eq(warnings.length, 1, 'one console warning');
    const mid = await snapshot(name);
    eq(itemRecs(mid), itemRecs(before), 'item records untouched');
    eq([metaOf(mid).schemaVersion, metaOf(mid).formatMigration], [4, undefined], 'meta not switched');
    const [r0, r1] = [settingsRec(before), settingsRec(mid)];
    for (const [f, v] of Object.entries(r0.fields)) eq(r1.fields[f], v, `existing field ${f} kept`);
    eq(colourValue(r1, 'Garden'), { name: 'Garden', swatch: 'g4' }, 'the g pick is never rewritten');
    const retry = await reload(name);
    eq([retry.status.schemaVersion, retry.status.formatMigration.verified, retry.status.formatMigration.fields], [5, true, 0], 'verified next time, with nothing more to write');
    const end = await snapshot(name);
    eq(settingsRec(end), r1, 'the retry wrote nothing new');
    eq(end.outbox.length, mid.outbox.length, 'no new op');
  });
}

test('a failure that persists keeps the app on format 4, the same after every load, and the data still works', async () => {
  const name = await seedBefore(SEED);
  await reload(name, 'plan');
  await reload(name, 'plan');
  const { status } = await reload(name, 'write');
  eq([status.schemaVersion, status.formatMigration.verified], [4, false], 'still format 4');
  storage.setMigrationFault('write'); // still failing: the save below must not depend on the step
  await storage.save(item('e', { category: 'Pets', name: 'Sample later' }));
  eq((await storage.getAll()).length, 5, 'saves still work');
  storage.setMigrationFault(null);
});

/* ------------------------------------------------------------------ Running twice, edge cases */

test('running twice changes nothing: once verified, a reload writes nothing and keeps the record', async () => {
  const name = await seedBefore(SEED);
  await reload(name);
  const once = await snapshot(name);
  const { status } = await reload(name);
  eq(status.formatMigration.at, metaOf(once).formatMigration.at, 'the same verified run');
  eq(await snapshot(name), once, 'every store exactly as after the first run');
});

test('an empty database: verified, with only this device\'s note', async () => {
  const name = await seedBefore({});
  const { status } = await reload(name);
  eq([status.schemaVersion, status.formatMigration.verified, status.formatMigration.fields, status.formatMigration.groups], [5, true, 1, 0], 'status');
  const rec = settingsRec(await snapshot(name));
  eq(Object.keys(rec.fields).map((f) => f.slice(0, 4)), ['app_'], 'only the note');
});

test('a database with only picked colours: none moved or rewritten, only the note written', async () => {
  const name = await seedBefore({ items: [item('a', { category: 'Pets' }), item('b', { category: 'Garden' })], picks: { Pets: 'g6', Garden: 'w2' }, autoColors: { Pets: 'w9' } });
  const before = settingsRec(await snapshot(name));
  const { status } = await reload(name);
  eq([status.schemaVersion, status.formatMigration.fields], [5, 1], 'the note only');
  const rec = settingsRec(await snapshot(name));
  eq([colourValue(rec, 'Pets'), colourValue(rec, 'Garden')], [colourValue(before, 'Pets'), colourValue(before, 'Garden')], 'picks as they were');
});

test('undated items: their groups are adopted like any other, and the stepper check passes', async () => {
  const name = await seedBefore({ items: [item('a', { nextRenewal: '' }), item('b', { cycle: 'once', date: '', category: 'Trips' })], autoColors: { Pets: 'w5', Trips: 'w14' } });
  const { status } = await reload(name);
  eq([status.schemaVersion, status.formatMigration.stepper.checked], [5, 2], 'verified');
  const rec = settingsRec(await snapshot(name));
  eq([colourValue(rec, 'Pets').slot, colourValue(rec, 'Trips').slot], [4, 13], 'adopted');
});

test('a household record that already holds slot values: kept as they are; a clash with them probes', async () => {
  const other = { clock: syncCore.newClock('another-device'), records: new Map() };
  const remote = syncCore.setFields(other, storage.SETTINGS_ID, {
    [storage.colorField('Pets')]: { name: 'Pets', swatch: 'w8', slot: 7, auto: true },
    [storage.colorField('Garden')]: { name: 'Garden', swatch: 'w3', slot: 2, auto: true },
  }, { now: Date.now() - 60_000 });
  const name = await seedBefore({ items: [item('a'), item('b', { category: 'Garden' }), item('c', { category: 'Boats' })], autoColors: { Pets: 'w1', Garden: 'w4', Boats: 'w3' }, remote });
  const before = settingsRec(await snapshot(name));
  const { status } = await reload(name);
  eq([status.schemaVersion, status.formatMigration.fields], [5, 2], 'Boats and the note');
  const rec = settingsRec(await snapshot(name));
  eq([colourValue(rec, 'Pets'), colourValue(rec, 'Garden')], [colourValue(before, 'Pets'), colourValue(before, 'Garden')], 'the household\'s values kept');
  const boats = colourValue(rec, 'Boats');
  assert(boats.auto === true && boats.slot !== 2 && boats.slot !== 7, `Boats probed to a free slot (got ${boats.slot})`);
});

test('before settings are shared, or without the app\'s version, the step waits and changes nothing', async () => {
  const name = await seedBefore(SEED);
  storage.setAppVersion(null);
  storage.useDatabase(name);
  await storage.getAll();
  eq([(await storage.status()).schemaVersion, (await storage.status()).formatMigration], [4, null], 'no version: not run');
});

/* ------------------------------------------------------------------ The version-note refresh (1.26.0) */

const noteOf = (snap) => settingsRec(snap).fields[storage.versionNoteField(metaOf(snap).deviceId)];

test('after the step: a launch on a new version rewrites only this device\'s note (one op), other notes and items untouched', async () => {
  const other = { clock: syncCore.newClock('another-device'), records: new Map() };
  const otherNote = { v: '1.25.1', fmt: 5, at: '2026-11-01' };
  const remote = syncCore.setFields(other, storage.SETTINGS_ID, { [storage.versionNoteField('another-device')]: otherNote }, { now: Date.now() - 60_000 });
  const name = await seedBefore({ ...SEED, remote });
  await reload(name);
  const before = await snapshot(name);
  eq(noteOf(before).v, VERSION, 'the step wrote the note');
  const { status, warnings } = await reload(name, null, '1.26.0');
  eq(warnings, [], 'no warning');
  eq(status.formatMigration, metaOf(before).formatMigration, 'the step is not run again');
  const after = await snapshot(name);
  eq([noteOf(after).v, noteOf(after).fmt], ['1.26.0', 5], 'this device\'s note now names the new version');
  const changed = Object.keys(settingsRec(after).fields).filter((f) => JSON.stringify(settingsRec(after).fields[f]) !== JSON.stringify(settingsRec(before).fields[f]));
  eq(changed, [storage.versionNoteField(metaOf(after).deviceId)], 'only this device\'s note field changed');
  eq(settingsRec(after).fields[storage.versionNoteField('another-device')], otherNote, 'another device\'s note as it was');
  eq(itemRecs(after), itemRecs(before), 'item records untouched');
  eq(after.settings, before.settings, 'settings store untouched');
  const newOps = after.outbox.filter((op) => !before.outbox.some((o) => o.id === op.id));
  eq(newOps.map((op) => op.f), [storage.versionNoteField(metaOf(after).deviceId)], 'one outbox op, the note');
  assert(!('del' in settingsRec(after).fields), 'the settings record never gets del');
  eq(await snapshot(name).then((s) => s.records), after.records, 'reading it back changes nothing');
  await reload(name, null, '1.26.0');
  eq(await snapshot(name), after, 'the same version again: nothing written');
});

test('after the step: a launch writes the note again when it is missing (cleared elsewhere)', async () => {
  const name = await seedBefore(SEED);
  await reload(name);
  const dev = metaOf(await snapshot(name)).deviceId;
  const other = { clock: syncCore.newClock('another-device'), records: new Map() };
  const clear = syncCore.setFields(other, storage.SETTINGS_ID, { [storage.versionNoteField(dev)]: null }, { now: Date.now() + 1000 });
  storage.useDatabase(name);
  await storage.applyRemote(clear, 2);
  eq(settingsRec(await snapshot(name)).fields[storage.versionNoteField(dev)], null, 'cleared');
  await reload(name);
  const note = noteOf(await snapshot(name));
  eq([note.v, note.fmt, /^\d{4}-\d{2}-\d{2}$/.test(note.at)], [VERSION, 5, true], 'written again');
});

test('a failure in the refresh changes nothing, shows nothing, and the next launch does it', async () => {
  const name = await seedBefore(SEED);
  await reload(name);
  const before = await snapshot(name);
  const { status, warnings } = await reload(name, 'note', '1.26.0');
  eq(warnings, [], 'silent');
  eq(status.schemaVersion, 5, 'still format 5');
  eq(await snapshot(name), before, 'every store exactly as before');
  await reload(name, null, '1.26.0');
  eq(noteOf(await snapshot(name)).v, '1.26.0', 'done on the next launch');
});

test('before the step is verified the refresh never runs: a failed step leaves no note', async () => {
  const name = await seedBefore(SEED);
  const before = await snapshot(name);
  await reload(name, 'plan', '1.26.0');
  eq(await snapshot(name), before, 'nothing written');
});

async function run() {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; } catch (err) { failures.push({ name, error: err.message }); }
  }
  storage.setAppVersion(null);
  storage.setMigrationFault(null);
  storage.useDatabase('substracker-test-fmt-idle');
  await new Promise((r) => setTimeout(r, 50));
  for (const name of [...created, 'substracker-test-fmt-idle']) indexedDB.deleteDatabase(name);
  const summary = document.getElementById('summary');
  summary.textContent = failures.length ? `${failures.length} of ${results.length} failed` : `All ${results.length} passed`;
  summary.className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  document.getElementById('results').innerHTML = results.map(({ name }) => {
    const fl = failures.find((x) => x.name === name);
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `<li class="${fl ? 't-fail' : 't-pass'}">${fl ? '✗' : '✓'} ${esc(name)}${fl ? `<div class="t-detail">${esc(fl.error)}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures };
}

run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
