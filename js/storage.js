// Peek Budget persistence. This is the only module that touches IndexedDB or localStorage:
// items and settings live in IndexedDB, a few per-device UI preferences in localStorage.
// Nothing here logs item contents.
//
// Items are stored sync-ready (see js/sync-core.js): every record has a stable id, a timestamp per
// field and a deleted flag, and every change is written as ops to an outbox in the same
// transaction. The app still sees plain items: getAll() returns live records in the old shape.
// Settings, preferences and anything device-specific are not records and are never synced.

import { firstEmoji, uid } from './util.js';
import { cleanDomain } from './services.js';
import * as sync from './sync-core.js';

export const APP_ID = 'substracker';

// Database versions:
//   1  `subscriptions` + `settings` (app 1.0–1.2).
//   2  adds `items` + `meta` (1.3.0). `subscriptions` is copied into `items` once, verified,
//      and kept untouched as a fallback.
//   3  adds `records` + `outbox` (sync-ready data). `items` is copied into `records` once,
//      verified, and kept untouched as a fallback in the same way.
// SCHEMA_VERSION is the data/export format, recorded in `meta`: 3 = plain items, 4 = records.
let dbName = 'substracker';
const DB_VERSION = 3;
export const SCHEMA_VERSION = 4;
const RECORDS = 'records';
const OUTBOX = 'outbox';
const ITEMS = 'items';
const SETTINGS = 'settings';
const META = 'meta';
const LEGACY = 'subscriptions';

/** The fields of an item, in the order the app writes them (besides `id`). */
export const ITEM_FIELDS = [
  'type', 'name', 'domain', 'emoji', 'plan', 'price', 'currency', 'cycle',
  'nextRenewal', 'date', 'category', 'notes', 'createdAt', 'updatedAt',
];

let dbPromise = null;
let source = RECORDS; // ITEMS or LEGACY only while a migration could not be verified
let migration = null; // the 1.3.0 subscriptions → items record, for status()
let syncMigration = null; // the items → records record, for status()
let onBlocked = () => {};
let onEnqueued = () => {};

/** Point the module at another database (tests use a throwaway one). */
export function useDatabase(name) {
  const old = dbPromise;
  dbPromise = null;
  dbName = name;
  source = RECORDS;
  migration = null;
  syncMigration = null;
  old?.then((db) => db.close()).catch(() => {});
}

/** Called when another open tab of an older version holds the database and delays the upgrade. */
export function setBlockedHandler(fn) { onBlocked = fn; }

/**
 * TODO(sync): the sync engine registers here to hear that local changes were added to the outbox
 * (to schedule a push to the relay). Called with the number of new ops after the transaction that
 * stored them has committed. Nothing listens yet.
 */
export function onChangesEnqueued(fn) { onEnqueued = fn; }

function changesEnqueued(count) {
  try { onEnqueued(count); } catch (err) { console.error(err); }
}

function openRaw() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(OUTBOX)) {
        // One pending op per record field: a newer local change to the same field replaces the
        // unsent older one, which last-write-wins would discard anyway. Index `t` gives send order.
        db.createObjectStore(OUTBOX, { keyPath: ['rec', 'f'] }).createIndex('t', 't');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let a newer version of the app upgrade the database instead of being blocked by this tab.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // The upgrade waits for the other tab to close; it isn't an error.
    req.onblocked = () => onBlocked();
  });
}

/** The open database, with the one-time migrations done. Every public function goes through this. */
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = openRaw().then(async (db) => { await migrate(db); return db; });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/**
 * Bring the data up to date, one verified step at a time. A step that can't be verified leaves
 * the app on the store before it, unchanged, and is tried again on the next load.
 */
async function migrate(db) {
  const meta = await readMeta(db);
  migration = meta.migration ?? null;
  syncMigration = meta.syncMigration ?? null;
  if (db.objectStoreNames.contains(LEGACY) && !meta.migration?.verified) {
    if (!(await migrateLegacy(db))) { source = LEGACY; return; }
  }
  if (meta.syncMigration?.verified) { source = RECORDS; return; }
  source = (await migrateToRecords(db)) ? RECORDS : ITEMS;
}

/**
 * 1.3.0: copy the old `subscriptions` store into `items` the first time (only when `items` is
 * empty), then check every old record arrived. The old store is never modified or deleted here.
 */
async function migrateLegacy(db) {
  let tx = db.transaction([LEGACY, ITEMS], 'readwrite');
  const [legacy, itemCount] = await Promise.all([
    result(tx.objectStore(LEGACY).getAll()), result(tx.objectStore(ITEMS).count()),
  ]);
  const copied = itemCount === 0 ? legacy.length : 0;
  if (copied) for (const row of legacy) tx.objectStore(ITEMS).put(row);
  await done(tx);

  // Verify with a fresh read: same count, and every old id present.
  tx = db.transaction([LEGACY, ITEMS]);
  const [oldKeys, newKeys] = await Promise.all([
    result(tx.objectStore(LEGACY).getAllKeys()), result(tx.objectStore(ITEMS).getAllKeys()),
  ]);
  const have = new Set(newKeys);
  if (oldKeys.length === newKeys.length && oldKeys.every((k) => have.has(k))) {
    migration = { from: LEGACY, items: oldKeys.length, copied, verified: true, at: new Date().toISOString() };
    await writeMeta(db, { schemaVersion: 3, migration });
    return true;
  }
  migration = { from: LEGACY, verified: false };
  console.warn(`Storage: migration check failed (${oldKeys.length} old, ${newKeys.length} new). Using the old store.`);
  return false;
}

/**
 * Sync-ready data: copy every item into `records` with per-field timestamps, and queue one op per
 * field in the outbox so a future sync sends the existing data too. Then read everything back and
 * check it. `items` is never modified or deleted here.
 *
 * Safe to interrupt and re-run: the copy is one transaction (all of it lands or none of it), and
 * until the check has passed and been recorded nothing reads or writes `records`, so a re-run
 * simply clears it and copies again from `items`.
 */
async function migrateToRecords(db) {
  try {
    if ((await copyItemsToRecords(db)) === 'already-done') {
      syncMigration = (await readMeta(db)).syncMigration;
      return true;
    }
  } catch (err) {
    syncMigration = { from: ITEMS, verified: false };
    console.warn(`Storage: could not copy items to records (${err?.message ?? err}). Using the previous store.`);
    return false;
  }

  const tx = db.transaction([ITEMS, RECORDS, OUTBOX]);
  const [items, records, outbox] = await Promise.all([
    result(tx.objectStore(ITEMS).getAll()), result(tx.objectStore(RECORDS).getAll()), result(tx.objectStore(OUTBOX).getAll()),
  ]);
  const problem = verifyRecords(items, records, outbox);
  if (problem) {
    syncMigration = { from: ITEMS, verified: false };
    console.warn(`Storage: sync migration check failed (${problem}). Using the previous store.`);
    return false;
  }
  syncMigration = { from: ITEMS, records: records.length, verified: true, at: new Date().toISOString() };
  await writeMeta(db, { schemaVersion: SCHEMA_VERSION, syncMigration });
  return true;
}

async function copyItemsToRecords(db) {
  const tx = db.transaction([ITEMS, RECORDS, OUTBOX, META], 'readwrite');
  const metaStore = tx.objectStore(META);
  const [items, metaRows] = await Promise.all([result(tx.objectStore(ITEMS).getAll()), result(metaStore.getAll())]);
  const m = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
  // Another tab of this version may have finished while this one was starting.
  if (m.syncMigration?.verified) { await done(tx); return 'already-done'; }

  let built;
  try {
    const deviceId = sync.isDeviceId(m.deviceId) ? m.deviceId : uid();
    built = recordsFromItems(items, loadClock(m.hlc, deviceId), Date.now());
  } catch (err) {
    tx.abort();
    throw err;
  }
  const recStore = tx.objectStore(RECORDS);
  const outStore = tx.objectStore(OUTBOX);
  recStore.clear(); // leftovers of an earlier attempt that was never verified, so never used
  outStore.clear();
  for (const r of built.records) recStore.put(r);
  for (const op of built.ops) outStore.put(op);
  metaStore.put({ key: 'deviceId', value: built.clock.dev });
  metaStore.put({ key: 'hlc', value: { wall: built.clock.wall, count: built.clock.count } });
  if (!Number.isInteger(m.syncCursor)) metaStore.put({ key: 'syncCursor', value: 0 });
  await done(tx);
  return 'copied';
}

/** The stored clock ({ wall, count }) for this device, or a new one. */
function loadClock(saved, deviceId) {
  const c = { wall: saved?.wall, count: saved?.count, dev: deviceId };
  return sync.isClock(c) ? c : sync.newClock(deviceId);
}

async function readMeta(db) {
  const rows = await result(db.transaction(META).objectStore(META).getAll());
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function writeMeta(db, obj) {
  const tx = db.transaction(META, 'readwrite');
  for (const [key, value] of Object.entries(obj)) tx.objectStore(META).put({ key, value });
  await done(tx);
}

/** Where the data stands: schema version, the migration records, and whether an older store is in use. */
export async function status() {
  const db = await open();
  const meta = await readMeta(db);
  return { schemaVersion: meta.schemaVersion ?? null, migration, syncMigration, usingLegacy: source !== RECORDS };
}

/** Sync bookkeeping for this device: id, clock, cursor and pending ops (oldest first). Null on a fallback store. */
export async function syncState() {
  const db = await open();
  if (source !== RECORDS) return null;
  const tx = db.transaction([META, OUTBOX]);
  const [rows, outbox] = await Promise.all([
    result(tx.objectStore(META).getAll()), result(tx.objectStore(OUTBOX).index('t').getAll()),
  ]);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { deviceId: m.deviceId, clock: m.hlc, syncCursor: m.syncCursor, outbox };
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* --------------------------------------------------------------------------
   Records ↔ items. Pure functions, also used by the Node tests.
   -------------------------------------------------------------------------- */
/** The app's view of a record: the plain item, or null for a deleted (tombstoned) record. */
export function toItem(record) {
  if (!sync.isLive(record)) return null;
  const item = { id: record.id };
  for (const [f, v] of Object.entries(record.fields)) if (f !== sync.DELETED) item[f] = v;
  return item;
}

/** The item fields to store, in ITEM_FIELDS order. Fields the item doesn't have are left alone. */
function itemFields(item) {
  return Object.fromEntries(ITEM_FIELDS.filter((f) => item[f] !== undefined).map((f) => [f, item[f]]));
}

/** First timestamp for a migrated item: its updatedAt (else createdAt, else 0), never later than now. */
function initialWall(item, now) {
  for (const v of [item.updatedAt, item.createdAt]) {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(t)) return Math.max(0, Math.min(Math.floor(t), now));
  }
  return 0;
}

/**
 * Turn stored items into records plus the ops that describe them. Every field of the item is
 * kept exactly as it is (nothing is filled in or trimmed), plus `del: false`. Each item's fields
 * are stamped with its own `updatedAt`, so when two devices hold copies of the same item (moved
 * by a backup) the more recently edited copy wins, as it does for an import merge. Throws if
 * an item can't be represented (unusable id or a value that isn't plain JSON).
 */
export function recordsFromItems(items, clock, now) {
  const records = new Map();
  const ops = [];
  let latest = null;
  for (const item of items) {
    if (!sync.isRecordId(item?.id)) throw new Error('an item has an unusable id');
    const t = sync.formatStamp(initialWall(item, now), 0, clock.dev);
    const fields = { ...item, [sync.DELETED]: false };
    delete fields.id;
    for (const [f, v] of Object.entries(fields)) {
      const op = { id: uid(), rec: item.id, f, v, t, dev: clock.dev };
      if (!sync.isOp(op)) throw new Error(`an item has an unusable "${f}"`);
      sync.applyOp(records, op);
      ops.push(op);
    }
    if (latest === null || sync.compare(t, latest) > 0) latest = t;
  }
  return { records: [...records.values()], ops, clock: latest ? sync.receive(clock, latest, now) : clock };
}

/**
 * Check migrated data against the items it came from: one live record per item whose view equals
 * the item exactly, a valid stamp on every field, and a matching pending op for every field.
 * Returns null when everything checks out, else a short description with counts only.
 */
export function verifyRecords(items, records, outbox) {
  if (records.length !== items.length) return `${items.length} items, ${records.length} records`;
  const byId = new Map(records.map((r) => [r.id, r]));
  const pending = new Map(outbox.map((op) => [`${op.rec}\u0000${op.f}`, op]));
  let differ = 0;
  let unstamped = 0;
  let fields = 0;
  for (const item of items) {
    const rec = byId.get(item.id);
    if (!rec || !sync.sameValue(toItem(rec), item)) { differ++; continue; }
    for (const [f, v] of Object.entries(rec.fields)) {
      fields++;
      const op = pending.get(`${rec.id}\u0000${f}`);
      if (!sync.isStamp(rec.ts[f]) || !op || op.t !== rec.ts[f] || !sync.sameValue(op.v, v)) unstamped++;
    }
  }
  if (differ) return `${differ} of ${items.length} records differ`;
  if (unstamped || outbox.length !== fields) return `${unstamped} of ${fields} fields without a matching op, ${outbox.length} ops`;
  return null;
}

/**
 * The ops an import makes, applied to `replica` ({ clock, records }). Replace deletes (tombstones)
 * every live record that isn't in the file; both modes then write the file's items, which brings
 * back any that were deleted here. Only fields that actually change produce ops.
 */
export function importOps(replica, { clear, writes }, opts) {
  const ops = [];
  if (clear) {
    const keep = new Set(writes.map((item) => item.id));
    for (const [id, rec] of replica.records) {
      if (sync.isLive(rec) && !keep.has(id)) ops.push(...sync.deleteRecord(replica, id, opts));
    }
  }
  for (const item of writes) ops.push(...sync.putRecord(replica, item.id, itemFields(item), opts));
  return ops;
}

/* --------------------------------------------------------------------------
   Items and settings
   -------------------------------------------------------------------------- */
/** Every item that hasn't been deleted, in the plain item shape. */
export async function getAll() {
  const db = await open();
  const rows = await result(db.transaction(source).objectStore(source).getAll());
  return source === RECORDS ? rows.map(toItem).filter(Boolean) : rows;
}

/**
 * Apply a change to records in one transaction: load the records (`ids`, or all of them), run
 * `change(replica)` to make ops, then store the changed records, the new ops in the outbox, the
 * clock, and any `settings` given. Either all of it is stored or none of it.
 */
async function commit(change, { ids, settings } = {}) {
  const db = await open();
  const tx = db.transaction([RECORDS, OUTBOX, META, ...(settings ? [SETTINGS] : [])], 'readwrite');
  const recStore = tx.objectStore(RECORDS);
  const metaStore = tx.objectStore(META);
  const [rows, devRow, hlcRow] = await Promise.all([
    ids ? Promise.all(ids.map((id) => result(recStore.get(id)))) : result(recStore.getAll()),
    result(metaStore.get('deviceId')), result(metaStore.get('hlc')),
  ]);
  let ops;
  let replica;
  try {
    if (!sync.isDeviceId(devRow?.value)) throw new Error('Storage: this device has no sync id.');
    replica = { clock: loadClock(hlcRow?.value, devRow.value), records: new Map(rows.filter(Boolean).map((r) => [r.id, r])) };
    ops = change(replica);
  } catch (err) {
    tx.abort();
    throw err;
  }
  for (const id of new Set(ops.map((op) => op.rec))) recStore.put(replica.records.get(id));
  for (const op of ops) tx.objectStore(OUTBOX).put(op);
  if (ops.length) metaStore.put({ key: 'hlc', value: { wall: replica.clock.wall, count: replica.clock.count } });
  for (const [key, value] of Object.entries(settings ?? {})) tx.objectStore(SETTINGS).put({ key, value });
  await done(tx);
  if (ops.length) changesEnqueued(ops.length);
  return ops;
}

/** Add or update an item. Only the fields that changed are recorded as ops. */
export async function save(item) {
  if (!sync.isRecordId(item?.id)) throw new Error('Storage: an item needs an id.');
  const db = await open();
  if (source === RECORDS) {
    await commit((r) => sync.putRecord(r, item.id, itemFields(item)), { ids: [item.id] });
    return item;
  }
  const tx = db.transaction(source, 'readwrite');
  tx.objectStore(source).put(item);
  await done(tx);
  return item;
}

/** Delete an item. Its record stays as a tombstone so other devices learn about the delete. */
export async function remove(id) {
  const db = await open();
  if (source === RECORDS) {
    await commit((r) => sync.deleteRecord(r, id), { ids: [id] });
    return;
  }
  const tx = db.transaction(source, 'readwrite');
  tx.objectStore(source).delete(id);
  await done(tx);
}

/** All settings as one object, e.g. { defaultCurrency: 'TWD', groupColors: {…} }. */
export async function getSettings() {
  const db = await open();
  return readSettings(db.transaction(SETTINGS).objectStore(SETTINGS));
}

async function readSettings(store) {
  const rows = await result(store.getAll());
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Store the given keys; keys not mentioned are left as they are. Settings are per device and never synced. */
export async function saveSettings(obj) {
  const db = await open();
  const tx = db.transaction(SETTINGS, 'readwrite');
  const store = tx.objectStore(SETTINGS);
  for (const [key, value] of Object.entries(obj)) store.put({ key, value });
  await done(tx);
}

/* --------------------------------------------------------------------------
   Per-device UI preferences (theme, tab, view…). Synchronous so the first
   paint can use them; silently unavailable in some private modes.
   -------------------------------------------------------------------------- */
const PREF_PREFIX = 'substracker.';

export function getPref(name) {
  try { return localStorage.getItem(PREF_PREFIX + name); } catch { return null; }
}

export function setPref(name, value) {
  try { localStorage.setItem(PREF_PREFIX + name, value); } catch { /* private mode */ }
}

/** Ask the browser not to evict our data under storage pressure. Best effort, asked once per load. */
let persistAsked = false;
export async function requestPersistence() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  try { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* ignore */ }
}

/* --------------------------------------------------------------------------
   Export / import
   -------------------------------------------------------------------------- */
// Backups: { app, schemaVersion: 4, exportedAt, items, settings }: the live (not deleted) items with
// their ids, and the settings worth restoring (BACKUP_SETTINGS). Nothing else from the device goes in:
// no sync bookkeeping (device id, clock, cursor, outbox, field stamps), no entitlement flags, and no
// appearance or other preferences. Settings are restored by import but never synced.
// Older files still import: schemaVersion 3 has the same envelope, and files from 1.0–1.2 use
// { format, version: 1|2, … } with records under `subscriptions` (v1) or `items` (v2).

/** The settings a backup carries. An allowlist, so anything added to settings later stays out until listed here. */
export const BACKUP_SETTINGS = ['defaultCurrency', 'groupColors'];

/** Everything needed to restore this device's items, as a plain object ready for JSON.stringify. */
export async function exportAll() {
  const [items, settings] = await Promise.all([getAll(), getSettings()]);
  // Fill fields older records lack (pre-1.1.0 ones have no type, date or emoji) so every backup
  // carries the full current shape.
  const full = items.map((s) => ({ ...s, type: s.type === 'income' ? 'income' : 'expense', date: s.date ?? '', emoji: s.emoji ?? '' }));
  const kept = Object.fromEntries(BACKUP_SETTINGS.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]));
  return { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), items: full, settings: kept };
}

/** A problem with an import file. `message` is written for the person importing. */
export class ImportError extends Error {}

const MAX_IMPORT_CHARS = 5_000_000;
const CYCLES = ['monthly', 'annual', 'once'];
const TYPES = ['expense', 'income'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const stamp = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isNaN(t) ? -Infinity : t; };

/**
 * Check a backup and turn it into clean items. Only the fields the app needs are required
 * (id, name, price, currency, cycle; date for one-offs) and only their types are checked;
 * `type` may be missing (an expense) but not an unknown value. Unknown fields are ignored, so backups from newer versions import too.
 */
export function parseBackup(json) {
  let data = json;
  if (typeof json === 'string') {
    if (json.length > MAX_IMPORT_CHARS) throw new ImportError('That file is too large to be a Peek Budget backup.');
    try { data = JSON.parse(json); } catch { throw new ImportError("That file isn't valid JSON."); }
  }
  if (!isObj(data)) throw new ImportError("That file isn't a Peek Budget backup: it has no backup header.");

  let version, rows, listName;
  if ('app' in data || 'schemaVersion' in data) {
    if (data.app !== APP_ID) throw new ImportError(`That file isn't a Peek Budget backup: "app" should be "${APP_ID}".`);
    if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
      throw new ImportError('The backup\'s "schemaVersion" must be a whole number of 1 or more.');
    }
    version = data.schemaVersion;
    listName = 'items';
    rows = data.items;
  } else if (data.format === APP_ID) {
    version = Number(data.version);
    if (version !== 1 && version !== 2) throw new ImportError('The backup\'s "version" must be 1 or 2.');
    listName = version === 1 ? 'subscriptions' : 'items';
    rows = data[listName];
  } else {
    throw new ImportError(`That file isn't a Peek Budget backup: it has no "app": "${APP_ID}" header.`);
  }
  if (!Array.isArray(rows)) throw new ImportError(`The backup's "${listName}" must be a list.`);
  if (!rows.length) throw new ImportError('That backup has no items.');
  if (data.settings !== undefined && !isObj(data.settings)) {
    throw new ImportError('The backup\'s "settings" must be an object.');
  }

  const firstSeen = new Map();
  const items = rows.map((raw, i) => {
    checkItem(raw, i, firstSeen);
    return { item: normalize(raw, data.exportedAt), ts: stamp(raw.updatedAt) };
  });
  // A file without settings (hand-made, or from a pre-release build of format 4) leaves them as they are.
  return { version, items, settings: data.settings ?? null };
}

function checkItem(raw, i, firstSeen) {
  if (!isObj(raw)) throw new ImportError(`Item ${i + 1} isn't an object.`);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const label = `Item ${i + 1}${name ? ` ("${name.slice(0, 40)}")` : ''}`;
  const fail = (msg) => { throw new ImportError(`${label}: ${msg}`); };
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) fail('"id" must be text of 1–64 characters.');
  if (firstSeen.has(raw.id)) fail(`"id" is the same as item ${firstSeen.get(raw.id) + 1}.`);
  firstSeen.set(raw.id, i);
  if (!name) fail('"name" must be non-empty text.');
  if (typeof raw.price !== 'number' || !Number.isFinite(raw.price) || raw.price < 0) fail('"price" must be a number of 0 or more.');
  if (typeof raw.currency !== 'string' || !/^[A-Za-z]{3}$/.test(raw.currency)) fail('"currency" must be a 3-letter code such as TWD.');
  if (!CYCLES.includes(raw.cycle)) fail('"cycle" must be "monthly", "annual" or "once".');
  // Records saved before 1.1.0 have no type and are expenses, in any file version.
  if (raw.type !== undefined && !TYPES.includes(raw.type)) fail('"type" must be "expense" or "income".');
  if (raw.cycle === 'once' && !isDay(raw.date)) fail('"date" must be a YYYY-MM-DD date for a one-off item.');
}

/** Keep only the fields the app knows, trimmed to the same limits as the form. */
function normalize(raw, exportedAt) {
  const fallbackTime = typeof exportedAt === 'string' && !Number.isNaN(Date.parse(exportedAt))
    ? exportedAt : new Date().toISOString();
  const once = raw.cycle === 'once';
  return {
    id: raw.id,
    type: raw.type === 'income' ? 'income' : 'expense',
    name: raw.name.trim().slice(0, 80),
    domain: cleanDomain(text(raw.domain, 200)).slice(0, 120),
    emoji: firstEmoji(raw.emoji),
    plan: text(raw.plan, 80),
    price: Math.round(raw.price * 100) / 100,
    currency: raw.currency.toUpperCase(),
    cycle: raw.cycle,
    nextRenewal: !once && isDay(raw.nextRenewal) ? raw.nextRenewal : '',
    date: once ? raw.date : '',
    category: text(raw.category, 40),
    notes: text(raw.notes, 1000),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : fallbackTime,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : fallbackTime,
  };
}

/** Group colours from a file: a plain name → swatch-key map. The app drops unknown keys on load. */
function cleanColors(raw) {
  if (!isObj(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => k.length <= 40 && typeof v === 'string' && v.length <= 8));
}

/** Work out what each mode would do, without writing anything. */
async function planImport(json) {
  const backup = parseBackup(json);
  const [existing, current] = await Promise.all([getAll(), getSettings()]);
  return planFromBackup(backup, existing, current);
}

/**
 * The plan for each mode from a parsed backup, the live items here and the current settings.
 * Pure. Each plan has a summary, whether to clear (replace), the items to write, and settings.
 */
export function planFromBackup(backup, existing, current) {
  const have = new Map(existing.map((s) => [s.id, s]));
  const inFile = new Set(backup.items.map(({ item }) => item.id));
  const withSettings = backup.settings !== null;
  const base = { total: backup.items.length, existing: existing.length, newerVersion: backup.version > SCHEMA_VERSION, withSettings };

  // Merge: match by id; the newer `updatedAt` wins, and a missing or unreadable date counts as oldest.
  // Deleted items aren't "here", so an item deleted since the backup counts as new and comes back.
  const mergeWrites = [];
  let added = 0;
  let updated = 0;
  let kept = 0;
  for (const { item, ts } of backup.items) {
    const cur = have.get(item.id);
    if (!cur) { added++; mergeWrites.push(item); } else if (ts > stamp(cur.updatedAt)) { updated++; mergeWrites.push(item); } else kept++;
  }

  // Only the backup settings are read from a file, so it can't set anything else (such as an
  // entitlement). A file without settings leaves them as they are. Merge lets the file's colours win
  // for the groups it names; replace takes the file's colours and its default currency. Files
  // without colours import fine; the app assigns any gaps.
  const fileColors = withSettings ? cleanColors(backup.settings.groupColors) : {};
  const cur = withSettings ? backup.settings.defaultCurrency : null;
  const fileCurrency = typeof cur === 'string' && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : null;

  return {
    merge: {
      summary: { ...base, mode: 'merge', added, updated, kept, removed: 0 },
      clear: false,
      writes: mergeWrites,
      settings: withSettings ? { groupColors: { ...cleanColors(current.groupColors), ...fileColors } } : {},
    },
    replace: {
      summary: {
        ...base,
        mode: 'replace',
        added: backup.items.filter(({ item }) => !have.has(item.id)).length,
        updated: backup.items.filter(({ item }) => have.has(item.id)).length,
        kept: 0,
        removed: existing.filter((s) => !inFile.has(s.id)).length,
      },
      clear: true,
      writes: backup.items.map(({ item }) => item),
      settings: withSettings ? { groupColors: fileColors, ...(fileCurrency ? { defaultCurrency: fileCurrency } : {}) } : {},
    },
  };
}

/**
 * What importing would do in each mode, as { merge, replace } summaries. Writes nothing.
 * A summary has total, existing, added, updated, kept, removed, newerVersion and withSettings.
 * Throws ImportError, with a message naming the problem, for a file that can't be imported.
 */
export async function previewImport(json) {
  const plan = await planImport(json);
  return { merge: plan.merge.summary, replace: plan.replace.summary };
}

/**
 * Import a backup (JSON text or a parsed object). `mode` is "merge" or "replace".
 * The whole file is checked before anything is written, and the write is one transaction,
 * so a bad file or a failed write leaves existing data untouched. Items are written as ops like
 * any other change, so an import syncs too; replace tombstones the items it removes.
 * Returns the summary.
 */
export async function importAll(json, mode) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error(`Unknown import mode: ${mode}`);
  const plan = (await planImport(json))[mode];
  if (source === RECORDS) {
    await commit((replica) => importOps(replica, plan), { settings: plan.settings });
    return plan.summary;
  }
  // A fallback store (migration not verified): plain writes, as before.
  const db = await open();
  const tx = db.transaction([source, SETTINGS], 'readwrite');
  const store = tx.objectStore(source);
  if (plan.clear) store.clear();
  for (const item of plan.writes) store.put(item);
  const sstore = tx.objectStore(SETTINGS);
  for (const [key, value] of Object.entries(plan.settings)) sstore.put({ key, value });
  await done(tx);
  return plan.summary;
}
