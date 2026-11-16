// In-browser tests for js/storage.js: migrations (including to sync-ready records), the outbox,
// tombstones, export/import round trip, merge rules and bad-file rejection. Open tests/storage.html from a local server. Each test uses its own
// throwaway database; the fixtures below are made up. This file talks to IndexedDB directly
// only to seed old-format databases; the code under test goes through storage.js.

import * as storage from '../js/storage.js';

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
  eq([st.schemaVersion, st.usingLegacy, st.migration.verified, st.migration.items, st.migration.copied], [4, false, true, 3, 3], 'status');
  eq([st.syncMigration.verified, st.syncMigration.records], [true, 3], 'records step');
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
  const items = await rawAll(db, 'items');
  db.close();
  eq(legacy.map((s) => s.id).sort(), ['a', 'old'], 'old store still has both records');
  eq(items.map((s) => s.id).sort(), ['a', 'old'], 'items store is kept untouched too');
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

test('a fresh install has no old store and records schemaVersion 4', async () => {
  const name = freshDb();
  await storage.getAll();
  const st = await storage.status();
  eq([st.schemaVersion, st.migration, st.usingLegacy, st.syncMigration.verified], [4, null, false, true], 'status');
  storage.useDatabase('substracker-test-idle');
  await new Promise((r) => setTimeout(r, 50));
  const db = await rawOpen(name);
  eq([...db.objectStoreNames].sort(), ['items', 'meta', 'outbox', 'records', 'settings'], 'stores');
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
    eq(await storage.syncState(), null, 'no sync state on a fallback store');
  } finally { console.warn = warn; }
});

/* ------------------------------------------------------------------ Sync-ready records */

/** A database in the 1.3–1.4 layout (version 2: items + meta + settings, items already verified). */
async function seedV2(name, items, { stray = null } = {}) {
  const db = await rawOpen(name, 2, (d) => {
    d.createObjectStore('items', { keyPath: 'id' });
    d.createObjectStore('meta', { keyPath: 'key' });
    d.createObjectStore('settings', { keyPath: 'key' });
  });
  await rawPut(db, 'items', items);
  await rawPut(db, 'meta', [{ key: 'schemaVersion', value: 3 }]);
  db.close();
  if (stray) await stray(name);
}

/** Close storage.js's connection and open the database directly to look inside. */
async function inspect(name, fn) {
  storage.useDatabase('substracker-test-idle');
  await new Promise((r) => setTimeout(r, 50));
  const db = await rawOpen(name);
  try { return await fn(db); } finally { db.close(); storage.useDatabase(name); }
}

const fieldCount = (items) => items.reduce((n, s) => n + Object.keys(s).length, 0); // minus id, plus del

test('migrates a 1.3–1.4 database into records, verifies it and keeps items as they were', async () => {
  const name = freshDb();
  const items = [v1Record(), item(), item({ id: 'c', type: 'income', name: 'Example Salary' })];
  await seedV2(name, items);
  eq((await storage.getAll()).sort((x, y) => x.id.localeCompare(y.id)), [item(), item({ id: 'c', type: 'income', name: 'Example Salary' }), v1Record()], 'same items, same shape');
  const st = await storage.status();
  eq([st.schemaVersion, st.usingLegacy, st.migration, st.syncMigration.verified, st.syncMigration.records], [4, false, null, true, 3], 'status');
  const sync = await storage.syncState();
  assert(/^[0-9a-f-]{36}$/.test(sync.deviceId), 'device id is a UUID');
  eq(sync.syncCursor, 0, 'cursor starts at 0');
  eq(sync.outbox.length, fieldCount(items), 'one pending op per field');

  await storage.save({ ...item(), price: 999 });
  await storage.remove('old');
  const [raw, kept] = await inspect(name, async (db) => [await rawAll(db, 'records'), await rawAll(db, 'items')]);
  const byKey = (list) => [...list].sort((x, y) => x.id.localeCompare(y.id));
  eq(byKey(kept), byKey(items), 'items store untouched by later edits');
  const old = raw.find((r) => r.id === 'old');
  eq([old.fields.del, old.fields.name], [true, 'Sample Cloud'], 'deleted record kept as a tombstone');
  assert(Object.values(old.ts).every((t) => /^\d{15}-\d{6}-/.test(t)), 'every field has a stamp');
});

test('every save and delete goes to the outbox; a newer change to a field replaces its pending op', async () => {
  freshDb();
  const heard = [];
  storage.onChangesEnqueued((n) => heard.push(n));
  try {
    await storage.save(item());
    const first = (await storage.syncState()).outbox;
    eq(first.length, Object.keys(item()).length, 'create: every field plus del');
    await storage.save(item({ price: 300, updatedAt: T2 }));
    const second = (await storage.syncState()).outbox;
    eq(second.length, first.length, 'no growth: price and updatedAt ops were replaced');
    const price = second.find((op) => op.f === 'price');
    eq(price.v, 300, 'pending op has the new value');
    assert(price.t > first.find((op) => op.f === 'price').t, 'and a later stamp');
    await storage.save(item({ price: 300, updatedAt: T2 }));
    await storage.remove('a');
    await storage.remove('a'); // already deleted: nothing more
    eq(heard, [Object.keys(item()).length, 2, 1], 'the TODO(sync) hook hears each change');
    eq(await storage.getAll(), [], 'deleted items are absent');
    eq((await storage.exportAll()).items, [], 'and not exported');
    const del = (await storage.syncState()).outbox.find((op) => op.f === 'del');
    eq(del.v, true, 'the delete is pending');
  } finally { storage.onChangesEnqueued(() => {}); }
});

test('the device id and clock survive a reload and stamps keep increasing', async () => {
  const name = freshDb();
  await storage.save(item());
  const before = await storage.syncState();
  storage.useDatabase(name);
  await storage.save(item({ notes: 'later' }));
  const after = await storage.syncState();
  eq(after.deviceId, before.deviceId, 'same device');
  const t = (s) => s.outbox.find((op) => op.f === 'name')?.t ?? s.outbox.find((op) => op.f === 'notes').t;
  assert(after.outbox.find((op) => op.f === 'notes').t > t(before), 'later stamp after reload');
});

test('an interrupted records migration is redone from items', async () => {
  const name = freshDb();
  // Version 3 layout as left by a run that copied but never recorded its check: a stray record
  // and op that items doesn't have, and no syncMigration in meta.
  await seedV2(name, [item()], {
    stray: async (n) => {
      const db = await rawOpen(n, 3, (d) => {
        d.createObjectStore('records', { keyPath: 'id' });
        d.createObjectStore('outbox', { keyPath: ['rec', 'f'] }).createIndex('t', 't');
      });
      await rawPut(db, 'records', [{ id: 'stray', fields: { name: 'x', del: false }, ts: { name: '000000000000001-000000-x', del: '000000000000001-000000-x' } }]);
      await rawPut(db, 'outbox', [{ id: 'o', rec: 'stray', f: 'name', v: 'x', t: '000000000000001-000000-x', dev: 'x' }]);
      await rawPut(db, 'meta', [{ key: 'deviceId', value: 'device-from-first-run' }]);
      db.close();
    },
  });
  eq(await storage.getAll(), [item()], 'only what items has');
  const st = await storage.syncState();
  eq(st.deviceId, 'device-from-first-run', 'keeps the device id it already had');
  eq(st.outbox.some((op) => op.rec === 'stray'), false, 'stray op gone');
  eq((await storage.status()).syncMigration.verified, true, 'verified this time');
});

test('an item that cannot be copied keeps the app on items, unchanged, and it retries next load', async () => {
  const name = freshDb();
  await seedV2(name, [item(), item({ id: 'bad', price: NaN })]);
  const warn = console.warn;
  console.warn = () => {}; // the expected warning
  try {
    eq((await storage.getAll()).length, 2, 'reads items');
    const st = await storage.status();
    eq([st.usingLegacy, st.syncMigration.verified, st.schemaVersion], [true, false, 3], 'status');
    await storage.save(item({ notes: 'still works' }));
    storage.useDatabase(name);
    eq((await storage.getAll()).find((s) => s.id === 'a').notes, 'still works', 'writes land in items');
    eq((await storage.status()).usingLegacy, true, 'still on items after a reload');
  } finally { console.warn = warn; }
  const records = await inspect(name, (db) => rawAll(db, 'records'));
  eq(records, [], 'nothing half-copied');
});

test('replace import tombstones what it removes; a later merge brings an item back', async () => {
  const name = freshDb();
  await storage.save(item({ id: 'gone' }));
  await storage.importAll(backup([item({ id: 'a' })]), 'replace');
  eq((await storage.getAll()).map((s) => s.id), ['a'], 'live items');
  const gone = (await inspect(name, (db) => rawAll(db, 'records'))).find((r) => r.id === 'gone');
  eq(gone.fields.del, true, 'tombstone kept');
  const preview = await storage.previewImport(backup([item({ id: 'gone' })]));
  eq(preview.merge.added, 1, 'a deleted item counts as new');
  await storage.importAll(backup([item({ id: 'gone' })]), 'merge');
  eq((await storage.getAll()).map((s) => s.id).sort(), ['a', 'gone'], 'back again');
});

/* ------------------------------------------------------------------ Export / import */

test('export → JSON → replace import into an empty database round-trips, settings included', async () => {
  freshDb();
  const items = [item(), item({ id: 'b', cycle: 'once', date: '2026-11-10', nextRenewal: '', emoji: '🔧' }),
    item({ id: 'c', type: 'income', name: 'Example Salary', price: 50000 })];
  for (const s of items) await storage.save(s);
  // Device-only values that must never travel in a backup, stored next to the real settings.
  await storage.saveSettings({ defaultCurrency: 'USD', groupColors: { Entertainment: 'g3' }, pro: true, entitlement: 'pro', palette: 'ocean' });
  storage.setPref('palette', 'ocean');
  const file = JSON.stringify(await storage.exportAll());
  const parsed = JSON.parse(file);
  eq(Object.keys(parsed), ['app', 'schemaVersion', 'exportedAt', 'items', 'settings'], 'envelope keys');
  eq([parsed.app, parsed.schemaVersion], ['substracker', 4], 'header');
  eq(parsed.settings, { defaultCurrency: 'USD', groupColors: { Entertainment: 'g3' } }, 'only the backup settings');
  for (const word of ['pro', 'entitlement', 'palette', 'ocean', 'deviceId', 'hlc', 'outbox', 'syncCursor', '"ts"', '"del"']) {
    assert(!file.includes(`"${word}"`), `export must not contain ${word}`);
  }

  freshDb();
  const summary = await storage.importAll(file, 'replace');
  eq([summary.total, summary.added, summary.withSettings], [3, 3, true], 'summary');
  const back = (await storage.getAll()).sort((x, y) => x.id.localeCompare(y.id));
  eq(back, items, 'items identical');
  eq(await storage.getSettings(), { defaultCurrency: 'USD', groupColors: { Entertainment: 'g3' } }, 'same currency and colours, no Pro flag');
});

test('import never writes settings outside the backup list, even if a file has them', async () => {
  freshDb();
  await storage.importAll(backup([item()], { schemaVersion: 4, settings: { defaultCurrency: 'eur', groupColors: {}, pro: true, palette: 'x' } }), 'replace');
  eq(await storage.getSettings(), { defaultCurrency: 'EUR', groupColors: {} }, 'pro and palette ignored');
  await storage.importAll(backup([item()], { schemaVersion: 4, settings: { pro: true } }), 'merge');
  eq('pro' in (await storage.getSettings()), false, 'merge ignores it too');
});

test('a file without settings leaves them as they are', async () => {
  freshDb();
  await storage.saveSettings({ defaultCurrency: 'TWD', groupColors: { Mine: 'g4' } });
  const file = backup([item()], { schemaVersion: 4 });
  delete file.settings;
  eq((await storage.previewImport(file)).replace.withSettings, false, 'preview says so');
  await storage.importAll(file, 'replace');
  eq(await storage.getSettings(), { defaultCurrency: 'TWD', groupColors: { Mine: 'g4' } }, 'untouched');
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
