// In-browser tests for js/storage.js: migration, export/import round trip, merge rules,
// bad-file rejection, and keeping the Pro flag (js/entitlements.js) out of backups. Open tests/storage.html from a local server. Each test uses its own
// throwaway database; the fixtures below are made up. This file talks to IndexedDB directly
// only to seed old-format databases; the code under test goes through storage.js.

import * as storage from '../js/storage.js';
import * as entitlements from '../js/entitlements.js';

const results = [];
const created = [];
let n = 0;

function test(name, fn) { results.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
}
async function rejects(promise, includes, msg) {
  try { await promise; } catch (err) {
    assert(err instanceof storage.ImportError, `${msg}: expected ImportError, got ${err}`);
    assert(err.message.includes(includes), `${msg}: message "${err.message}" should include "${includes}"`);
    return;
  }
  throw new Error(`${msg}: expected the import to be rejected`);
}

/** Switch storage.js to a brand-new database name and return it. */
function freshDb() {
  const name = `substracker-test-${Date.now()}-${n++}`;
  created.push(name);
  storage.useDatabase(name);
  return name;
}

function rawOpen(name, version, upgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function rawPut(db, store, rows) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    for (const r of rows) tx.objectStore(store).put(r);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function rawAll(db, store) {
  return new Promise((resolve) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => resolve(q.result); });
}

/** A database in the 1.0–1.2 layout (version 1: subscriptions + settings). */
async function seedV1(name, subs, settings = {}) {
  const db = await rawOpen(name, 1, (d) => {
    d.createObjectStore('subscriptions', { keyPath: 'id' });
    d.createObjectStore('settings', { keyPath: 'key' });
  });
  await rawPut(db, 'subscriptions', subs);
  await rawPut(db, 'settings', Object.entries(settings).map(([key, value]) => ({ key, value })));
  db.close();
}

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const item = (over = {}) => ({
  id: 'a', type: 'expense', name: 'Example Streaming', domain: 'example.com', emoji: '', plan: 'Family',
  price: 250, currency: 'TWD', cycle: 'monthly', nextRenewal: '2030-01-01', date: '', category: 'Entertainment',
  notes: '', createdAt: T1, updatedAt: T1, ...over,
});
const v1Record = (over = {}) => ({
  id: 'old', name: 'Sample Cloud', domain: 'example.org', plan: '', price: 30, currency: 'USD', cycle: 'annual',
  nextRenewal: '', category: 'Software', notes: '', createdAt: T1, updatedAt: T1, ...over,
});
const backup = (items, extra = {}) => ({ app: 'substracker', schemaVersion: 3, exportedAt: T2, items, settings: {}, ...extra });

/* ------------------------------------------------------------------ Migration */

test('migrates the old subscriptions store into items and verifies it', async () => {
  const name = freshDb();
  const subs = [v1Record(), item({ id: 'b' }), item({ id: 'c', type: 'income', name: 'Example Salary' })];
  await seedV1(name, subs, { defaultCurrency: 'TWD' });
  const items = await storage.getAll();
  eq(items.map((s) => s.id).sort(), ['b', 'c', 'old'], 'all old records are in items');
  eq(items.find((s) => s.id === 'old'), subs[0], 'records are copied unchanged');
  const st = await storage.status();
  eq([st.schemaVersion, st.usingLegacy, st.migration.verified, st.migration.items, st.migration.copied], [3, false, true, 3, 3], 'status');
  eq((await storage.getSettings()).defaultCurrency, 'TWD', 'settings survive');
});

test('keeps the old store untouched as a fallback', async () => {
  const name = freshDb();
  await seedV1(name, [v1Record(), item()]);
  await storage.remove('a');
  storage.useDatabase('substracker-test-idle');
  await new Promise((r) => setTimeout(r, 50));
  const db = await rawOpen(name);
  const legacy = await rawAll(db, 'subscriptions');
  db.close();
  eq(legacy.map((s) => s.id).sort(), ['a', 'old'], 'old store still has both records');
});

test('runs only once: a deleted item does not come back on the next load', async () => {
  const name = freshDb();
  await seedV1(name, [v1Record(), item()]);
  await storage.remove('a');
  storage.useDatabase(name); // simulates a reload
  eq((await storage.getAll()).map((s) => s.id), ['old'], 'still deleted');
});

test('an empty old database migrates to an empty, verified one', async () => {
  const name = freshDb();
  await seedV1(name, []);
  eq(await storage.getAll(), [], 'no items');
  eq((await storage.status()).migration.verified, true, 'verified');
});

test('a fresh install has no old store and records schemaVersion 3', async () => {
  const name = freshDb();
  await storage.getAll();
  const st = await storage.status();
  eq([st.schemaVersion, st.migration, st.usingLegacy], [3, null, false], 'status');
  storage.useDatabase('substracker-test-idle');
  await new Promise((r) => setTimeout(r, 50));
  const db = await rawOpen(name);
  eq([...db.objectStoreNames].sort(), ['items', 'meta', 'settings'], 'stores');
  db.close();
});

test('an unverifiable migration falls back to the old store', async () => {
  const name = freshDb();
  // Version 2 layout where items already holds something else and nothing was verified.
  const db = await rawOpen(name, 2, (d) => {
    d.createObjectStore('subscriptions', { keyPath: 'id' });
    d.createObjectStore('settings', { keyPath: 'key' });
    d.createObjectStore('items', { keyPath: 'id' });
    d.createObjectStore('meta', { keyPath: 'key' });
  });
  await rawPut(db, 'subscriptions', [v1Record()]);
  await rawPut(db, 'items', [item({ id: 'stray' })]);
  db.close();
  const warn = console.warn;
  console.warn = () => {}; // the expected count-only warning
  try {
    eq((await storage.getAll()).map((s) => s.id), ['old'], 'reads the old store');
    eq((await storage.status()).usingLegacy, true, 'usingLegacy');
  } finally { console.warn = warn; }
});

/* ------------------------------------------------------------------ Export / import */

test('export → JSON → replace import into an empty database round-trips', async () => {
  freshDb();
  const items = [item(), item({ id: 'b', cycle: 'once', date: '2026-11-10', nextRenewal: '', emoji: '🔧' }),
    item({ id: 'c', type: 'income', name: 'Example Salary', price: 50000 })];
  for (const s of items) await storage.save(s);
  await storage.saveSettings({ defaultCurrency: 'USD', groupColors: { Entertainment: 'g3' } });
  const file = JSON.stringify(await storage.exportAll());
  const parsed = JSON.parse(file);
  eq(Object.keys(parsed), ['app', 'schemaVersion', 'exportedAt', 'items', 'settings'], 'envelope keys');
  eq([parsed.app, parsed.schemaVersion], ['substracker', 3], 'header');

  freshDb();
  const summary = await storage.importAll(file, 'replace');
  eq([summary.total, summary.added], [3, 3], 'summary');
  const back = (await storage.getAll()).sort((x, y) => x.id.localeCompare(y.id));
  eq(back, items, 'items identical');
  eq(await storage.getSettings(), { defaultCurrency: 'USD', groupColors: { Entertainment: 'g3' } }, 'settings identical');
});

test('records without a type (pre-1.1.0) export as expenses and re-import', async () => {
  freshDb();
  await storage.save(v1Record());
  const file = await storage.exportAll();
  eq([file.items[0].type, file.items[0].date, file.items[0].emoji], ['expense', '', ''], 'filled fields');
  freshDb();
  await storage.importAll(JSON.stringify(file), 'merge');
  eq((await storage.getAll())[0].type, 'expense', 're-imported');
});

test('merge: matches by id and the newer updatedAt wins', async () => {
  freshDb();
  await storage.save(item({ id: 'a', price: 1, updatedAt: T1 }));
  await storage.save(item({ id: 'b', price: 1, updatedAt: T2 }));
  await storage.save(item({ id: 'keep', price: 1 }));
  const file = backup([
    item({ id: 'a', price: 2, updatedAt: T2 }), // newer in file → updated
    item({ id: 'b', price: 2, updatedAt: T1 }), // older in file → kept
    item({ id: 'c', price: 2 }), // new
  ]);
  const preview = await storage.previewImport(file);
  eq([preview.merge.total, preview.merge.added, preview.merge.updated, preview.merge.kept], [3, 1, 1, 1], 'preview counts');
  const summary = await storage.importAll(file, 'merge');
  eq(summary, preview.merge, 'summary matches preview');
  const by = Object.fromEntries((await storage.getAll()).map((s) => [s.id, s.price]));
  eq(by, { a: 2, b: 1, c: 2, keep: 1 }, 'prices after merge');
});

test('merge: an item with no updatedAt never overwrites yours', async () => {
  freshDb();
  await storage.save(item({ price: 1 }));
  const raw = item({ price: 2 });
  delete raw.updatedAt;
  await storage.importAll(backup([raw]), 'merge');
  eq((await storage.getAll())[0].price, 1, 'kept');
});

test('replace: removes items not in the file and takes its settings', async () => {
  freshDb();
  await storage.save(item({ id: 'gone' }));
  await storage.saveSettings({ defaultCurrency: 'TWD', groupColors: { Old: 'g1' } });
  const file = backup([item({ id: 'a' })], { settings: { defaultCurrency: 'eur', groupColors: { Entertainment: 'g2' } } });
  const preview = await storage.previewImport(file);
  eq(preview.replace.removed, 1, 'preview removed');
  await storage.importAll(file, 'replace');
  eq((await storage.getAll()).map((s) => s.id), ['a'], 'items');
  eq(await storage.getSettings(), { defaultCurrency: 'EUR', groupColors: { Entertainment: 'g2' } }, 'settings');
});

test('imports 1.0 (v1) and 1.1–1.2 (v2) backups', async () => {
  freshDb();
  await storage.importAll({ format: 'substracker', version: 1, settings: {}, subscriptions: [v1Record()] }, 'merge');
  await storage.importAll({ format: 'substracker', version: 2, settings: {}, items: [item(), v1Record({ id: 'v2-old' })] }, 'merge');
  eq((await storage.getAll()).map((s) => s.id).sort(), ['a', 'old', 'v2-old'], 'all imported');
});

test('a newer schemaVersion with unknown fields imports; unknown fields are dropped', async () => {
  freshDb();
  const file = backup([item({ futureField: { x: 1 } })], { schemaVersion: 9, futureTopLevel: true });
  const preview = await storage.previewImport(file);
  eq(preview.merge.newerVersion, true, 'flagged as newer');
  await storage.importAll(file, 'merge');
  const [s] = await storage.getAll();
  assert(!('futureField' in s), 'unknown field dropped');
  eq(s.price, 250, 'known fields kept');
});

/* ------------------------------------------------------------------ Entitlements */

test('the Pro debug flag is stored in settings but never exported', async () => {
  freshDb();
  await storage.save(item());
  await storage.saveSettings({ defaultCurrency: 'USD' });
  await entitlements.setProForTesting(true);
  eq((await storage.getSettings())[storage.DEBUG_PRO_SETTING], true, 'flag stored');
  const file = await storage.exportAll();
  assert(!(storage.DEBUG_PRO_SETTING in file.settings), 'flag left out of the export');
  eq(file.settings, { defaultCurrency: 'USD' }, 'other settings still exported');
});

test('import ignores a Pro flag in the file, in merge and replace', async () => {
  for (const mode of ['merge', 'replace']) {
    freshDb();
    const file = backup([item()], { settings: { defaultCurrency: 'EUR', [storage.DEBUG_PRO_SETTING]: true, pro: true } });
    await storage.importAll(file, mode);
    const s = await storage.getSettings();
    assert(!(storage.DEBUG_PRO_SETTING in s) && !('pro' in s), `${mode}: flag not imported`);
  }
});

test('replace import keeps this device\'s own Pro flag', async () => {
  freshDb();
  await entitlements.setProForTesting(true);
  await storage.importAll(backup([item()], { settings: { [storage.DEBUG_PRO_SETTING]: false } }), 'replace');
  eq((await storage.getSettings())[storage.DEBUG_PRO_SETTING], true, 'flag untouched');
});

test('isPro() is always true on the web, and onChange can be removed', async () => {
  freshDb();
  let calls = 0;
  const off = entitlements.onChange(() => { calls++; });
  await entitlements.setProForTesting(false);
  eq(entitlements.isPro(), true, 'web stays Pro with the flag off');
  await entitlements.initEntitlements();
  eq(entitlements.isPro(), true, 'still Pro after reloading the flag');
  off();
  eq(calls, 0, 'no change event: the web is never Basic');
});

/* ------------------------------------------------------------------ Bad files */

const bad = [
  ['not JSON', 'not json at all', "isn't valid JSON"],
  ['a bare array', '[]', 'no backup header'],
  ['another app', backup([item()], { app: 'other' }), '"app" should be "substracker"'],
  ['missing schemaVersion', { app: 'substracker', items: [item()] }, '"schemaVersion" must be a whole number'],
  ['schemaVersion as text', backup([item()], { schemaVersion: '3' }), '"schemaVersion" must be a whole number'],
  ['unknown old version', { format: 'substracker', version: 7, items: [item()] }, '"version" must be 1 or 2'],
  ['items not a list', backup({}), '"items" must be a list'],
  ['no items', backup([]), 'has no items'],
  ['settings not an object', backup([item()], { settings: [] }), '"settings" must be an object'],
  ['item not an object', backup([item(), 'x']), "Item 2 isn't an object"],
  ['missing id', backup([item({ id: undefined })]), 'Item 1 ("Example Streaming"): "id"'],
  ['duplicate id', backup([item(), item()]), '"id" is the same as item 1'],
  ['empty name', backup([item({ name: '  ' })]), '"name" must be non-empty'],
  ['price as text', backup([item({ id: 'a' }), item({ id: 'b', price: '30' })]), 'Item 2 ("Example Streaming"): "price"'],
  ['negative price', backup([item({ price: -1 })]), '"price" must be a number of 0 or more'],
  ['bad currency', backup([item({ currency: 'NT' })]), '"currency" must be a 3-letter code'],
  ['unknown cycle', backup([item({ cycle: 'weekly' })]), '"cycle" must be'],
  ['unknown type', backup([item({ type: 'transfer' })]), '"type" must be "expense" or "income"'],
  ['one-off without date', backup([item({ cycle: 'once', date: '' })]), '"date" must be a YYYY-MM-DD date'],
];

for (const [label, file, msg] of bad) {
  test(`rejects ${label} and leaves data untouched`, async () => {
    freshDb();
    await storage.save(item({ id: 'mine', name: 'Mine' }));
    await storage.saveSettings({ defaultCurrency: 'TWD' });
    const before = JSON.stringify([await storage.getAll(), await storage.getSettings()]);
    await rejects(storage.previewImport(file), msg, 'preview');
    await rejects(storage.importAll(file, 'replace'), msg, 'replace');
    await rejects(storage.importAll(file, 'merge'), msg, 'merge');
    eq(JSON.stringify([await storage.getAll(), await storage.getSettings()]), before, 'data unchanged');
  });
}

/* ------------------------------------------------------------------ Runner */

async function run() {
  const list = document.getElementById('results');
  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    const li = document.createElement('li');
    try {
      await fn();
      passed++;
      li.className = 't-pass';
      li.textContent = `✓ ${name}`;
    } catch (err) {
      failures.push({ name, error: err.message });
      li.className = 't-fail';
      li.innerHTML = '';
      li.append(`✗ ${name}`);
      const d = document.createElement('div');
      d.className = 't-detail';
      d.textContent = err.message;
      li.append(d);
    }
    list.append(li);
  }
  storage.useDatabase('substracker-test-idle');
  await new Promise((r) => setTimeout(r, 50));
  for (const name of [...created, 'substracker-test-idle']) indexedDB.deleteDatabase(name);
  const total = results.length;
  document.getElementById('summary').textContent = failures.length
    ? `${failures.length} of ${total} failed` : `All ${total} passed`;
  document.getElementById('summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  window.testResults = { total, passed, failures };
}

run();
