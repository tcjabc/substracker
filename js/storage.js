// Peek Budget persistence. This is the only module that touches IndexedDB or localStorage:
// items and settings live in IndexedDB, a few per-device UI preferences in localStorage.
// Nothing here logs item contents.
//
// Items are stored sync-ready (see js/sync-core.js): every record has a stable id, a timestamp per
// field and a deleted flag, and every change is written as ops to an outbox in the same
// transaction. The app still sees plain items: getAll() returns live records in the old shape.
//
// Two settings are shared by the household: the default currency and the group colours. They live
// in one reserved record (SETTINGS_ID) that is never live, so it never shows up as an item. Values
// the app picks by itself (the locale currency, auto-assigned colours) stay on this device and only
// fill gaps, so a device that never chose anything can't override a household choice. Everything
// else (theme and other preferences, entitlement flags, device id, clock, cursor, sync config) is
// per device and never synced or exported.

import { firstEmoji, uid } from './util.js';
import { t } from './i18n.js';
import { cleanDomain } from './services.js';
import * as sync from './sync-core.js';
import { isReadableInterval, shadowCycle, effectiveInterval, dayNumber, dayOf } from './interval.js';
import { stepperCheck, planColours, verifyFormatMigration, liveGroups, FORMAT } from './format-migration.js';

export const APP_ID = 'substracker';

// Database versions:
//   1  `subscriptions` + `settings` (app 1.0–1.2).
//   2  adds `items` + `meta` (1.3.0). `subscriptions` is copied into `items` once, verified,
//      and kept untouched as a fallback.
//   3  adds `records` + `outbox` (sync-ready data). `items` is copied into `records` once,
//      verified, and kept untouched as a fallback in the same way.
// SCHEMA_VERSION is the data/export format, recorded in `meta`: 3 = plain items, 4 = records, and 5
// once format 5's first-launch step (migrateFormat) has been verified. Neither changes DB_VERSION.
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
let settingsMigration = null; // the settings → shared settings record step, for status()
let settingsShared = false; // true once that step is verified: settings are read from the record
let formatMigration = null; // format 5's first-launch step (migrateFormat), for status()
let appVersion = null; // the app's version, for this device's version note (setAppVersion)
let migrationFault = null; // tests only (setMigrationFault): the step of migrateFormat to fail at
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
  settingsMigration = null;
  settingsShared = false;
  formatMigration = null;
  old?.then((db) => db.close()).catch(() => {});
}

/**
 * The app's version (js/app.js APP_VERSION), set before the database is first opened. Format 5's
 * first-launch step writes it into this device's version note, so the step waits (and nothing
 * changes) until it is known: pages that use storage without the app (tests) stay on format 4.
 */
export function setAppVersion(version) {
  appVersion = typeof version === 'string' && version.length > 0 && version.length <= 32 ? version : null;
}

/**
 * Tests only: make format 5's first-launch step fail at `step` ('plan', 'write', 'readback' or
 * 'switch'), or null for none. The app never sets it.
 */
export function setMigrationFault(step) { migrationFault = step ?? null; }

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
  settingsMigration = meta.settingsMigration ?? null;
  formatMigration = meta.formatMigration ?? null;
  settingsShared = false;
  if (db.objectStoreNames.contains(LEGACY) && !meta.migration?.verified) {
    if (!(await migrateLegacy(db))) { source = LEGACY; return; }
  }
  if (meta.syncMigration?.verified) source = RECORDS;
  else source = (await migrateToRecords(db)) ? RECORDS : ITEMS;
  if (source !== RECORDS) return;
  settingsShared = meta.settingsMigration?.verified ? true : await migrateSettings(db);
  if (settingsShared && !meta.formatMigration?.verified && appVersion) await migrateFormat(db);
}

/**
 * Format 5's first-launch step (docs/plan-intervals-groups.md section 6; the pure parts are in
 * js/format-migration.js), after every step before it has been verified:
 * 1. Plan (read-only): the stepper check on every live item (1.19.0's date rules against the
 *    shared stepper; any difference stops here), this device's automatic colours adopted as shared
 *    palette slots (planColours: only groups the record has no colour for; picks never move, old
 *    g1–g10 picks are never rewritten), and this device's version note { v, fmt: 5, at }.
 * 2. Write, one transaction over records, outbox and meta: the settings record's new fields, their
 *    outbox ops and the clock. Items and the settings store are only read.
 * 3. Read back the record: every planned field there with its value (or a newer one from another
 *    device), no `del`, every live group with a slot (or an old g pick), the note there.
 * 4. Switch: meta.formatMigration { verified: true, … } and schemaVersion 5, in one transaction.
 * A failure at 1 or 2 changes nothing at all. A failure at 3 or 4 leaves only the fields written in
 * 2 (the planned values, nothing overwritten), and the switch isn't made. Either way it's logged with
 * counts only, nothing is shown, and the step runs again on the next load, planning only what's
 * still missing. Once verified it never runs again; and planning on its own result plans nothing.
 */
async function migrateFormat(db) {
  const fail = (step, why) => {
    formatMigration = { verified: false, step };
    console.warn(`Storage: format 5 step not done (${step}: ${why}). Nothing changes; it runs again next time.`);
    return false;
  };
  const fault = (step) => { if (migrationFault === step) throw new Error('test fault'); };
  const now = Date.now();
  let planned;
  let stamps;
  let check;
  let noteField;
  let groups = 0;
  try {
    const tx = db.transaction([SETTINGS, RECORDS, OUTBOX, META], 'readwrite');
    const metaStore = tx.objectStore(META);
    const [rows, autoRow, devRow, hlcRow] = await Promise.all([
      result(tx.objectStore(RECORDS).getAll()), result(tx.objectStore(SETTINGS).get(AUTO_COLORS)),
      result(metaStore.get('deviceId')), result(metaStore.get('hlc')),
    ]);
    let ops;
    let replica;
    try {
      fault('plan');
      if (!sync.isDeviceId(devRow?.value)) throw new Error('this device has no sync id');
      const items = rows.filter((r) => r.id !== SETTINGS_ID).map(toItem).filter(Boolean);
      check = stepperCheck(items, new Date(now));
      if (check.diff) throw new Error(`stepper check: ${check.diff} of ${check.checked} items differ (${check.first})`);
      const rec = rows.find((r) => r.id === SETTINGS_ID) ?? null;
      replica = { clock: loadClock(hlcRow?.value, devRow.value), records: new Map(rec ? [[rec.id, rec]] : []) };
      planned = planColours({ items, record: rec, autoColors: cleanColors(autoRow?.value) }).fields;
      groups = liveGroups(items).length;
      noteField = versionNoteField(devRow.value);
      ops = [
        ...sync.setFields(replica, SETTINGS_ID, planned, { now }),
        ...versionNoteOps(replica, { deviceId: devRow.value, version: appVersion, fmt: FORMAT, now }),
      ];
      const note = ops.find((op) => op.f === noteField);
      if (note) planned = { ...planned, [noteField]: note.v };
      stamps = Object.fromEntries(ops.map((op) => [op.f, op.t]));
    } catch (err) {
      tx.abort();
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { step: 'plan' });
    }
    if (ops.length) {
      tx.objectStore(RECORDS).put(replica.records.get(SETTINGS_ID));
      for (const op of ops) tx.objectStore(OUTBOX).put(op);
      metaStore.put({ key: 'hlc', value: { wall: replica.clock.wall, count: replica.clock.count } });
    }
    if (migrationFault === 'write') { tx.abort(); throw Object.assign(new Error('test fault'), { step: 'write' }); }
    await done(tx);
    if (ops.length) changesEnqueued(ops.length);
  } catch (err) {
    return fail(err?.step ?? 'write', err?.message ?? err);
  }

  let problem;
  try {
    fault('readback');
    const tx = db.transaction(RECORDS);
    const rows = await result(tx.objectStore(RECORDS).getAll());
    const items = rows.filter((r) => r.id !== SETTINGS_ID).map(toItem).filter(Boolean);
    problem = verifyFormatMigration({ record: rows.find((r) => r.id === SETTINGS_ID) ?? null, planned, stamps, items, noteField });
  } catch (err) { problem = err?.message ?? String(err); }
  if (problem) return fail('readback', problem);

  const record = {
    verified: true, at: new Date(now).toISOString(), fields: Object.keys(planned).length,
    groups, items: check.checked + check.skipped, stepper: { checked: check.checked, skipped: check.skipped, custom: check.custom },
  };
  try {
    const tx = db.transaction(META, 'readwrite');
    tx.objectStore(META).put({ key: 'formatMigration', value: record });
    tx.objectStore(META).put({ key: 'schemaVersion', value: FORMAT });
    if (migrationFault === 'switch') { tx.abort(); throw new Error('test fault'); }
    await done(tx);
  } catch (err) {
    return fail('switch', err?.message ?? err);
  }
  formatMigration = record;
  return true;
}

/**
 * Shared settings: copy the default currency and group colours stored on this device into the
 * settings record once, stamped now, and queue them so the household gets them. A field the record
 * already has (it came from another device) is left as it is. Then read it back and check it.
 * The settings store is never modified or deleted here; until the check has passed, settings keep
 * being read from and written to it as before, and the step is tried again on the next load.
 * Safe to interrupt and re-run: the copy is one transaction, and a re-run only adds what's missing.
 */
async function migrateSettings(db) {
  let stored;
  try {
    const tx = db.transaction([SETTINGS, RECORDS, OUTBOX, META], 'readwrite');
    const metaStore = tx.objectStore(META);
    const [rows, rec, devRow, hlcRow] = await Promise.all([
      result(tx.objectStore(SETTINGS).getAll()), result(tx.objectStore(RECORDS).get(SETTINGS_ID)),
      result(metaStore.get('deviceId')), result(metaStore.get('hlc')),
    ]);
    let ops;
    let replica;
    try {
      if (!sync.isDeviceId(devRow?.value)) throw new Error('this device has no sync id');
      stored = storedSharedSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
      replica = { clock: loadClock(hlcRow?.value, devRow.value), records: new Map(rec ? [[rec.id, rec]] : []) };
      ops = seedSettingsOps(replica, stored);
    } catch (err) {
      tx.abort();
      throw err;
    }
    if (ops.length) {
      tx.objectStore(RECORDS).put(replica.records.get(SETTINGS_ID));
      for (const op of ops) tx.objectStore(OUTBOX).put(op);
      metaStore.put({ key: 'hlc', value: { wall: replica.clock.wall, count: replica.clock.count } });
    }
    await done(tx);
  } catch (err) {
    settingsMigration = { verified: false };
    console.warn(`Storage: could not copy settings to the shared record (${err?.message ?? err}). Settings stay on this device.`);
    return false;
  }

  const rec = await result(db.transaction(RECORDS).objectStore(RECORDS).get(SETTINGS_ID));
  const problem = verifySettingsSeed(stored, rec);
  if (problem) {
    settingsMigration = { verified: false };
    console.warn(`Storage: shared settings check failed (${problem}). Settings stay on this device.`);
    return false;
  }
  settingsMigration = { fields: settingsFieldCount(stored), verified: true, at: new Date().toISOString() };
  await writeMeta(db, { settingsMigration });
  return true;
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
  return {
    schemaVersion: meta.schemaVersion ?? null, migration, syncMigration, settingsMigration, formatMigration,
    usingLegacy: source !== RECORDS, settingsShared,
  };
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

/* --------------------------------------------------------------------------
   Sync storage, used by js/sync.js. Config and bookkeeping live in `meta`: per device, never
   exported, never synced. All of this needs the records store (not a fallback store).
   -------------------------------------------------------------------------- */
// The household key lives in one of two places (keyLocation):
//   'idb'    — here, in householdKey (the web, and phones until the key has moved)
//   'secure' — in the phone's secure storage (js/secure-key.js); householdKey is '' and keyTag, a
//              random id with no relation to the key, says which household this config belongs to.
// wasPaired: this device has been in a household before (kept after turning sync off, so starting
// a new household can warn that the other devices stay on the old one). Not a secret.
const NO_CONFIG = Object.freeze({ relayUrl: '', householdKey: '', enabled: false, wasPaired: false, keyLocation: 'idb', keyTag: '' });

/** Which household a config is in ('' for none), without reading the key from secure storage. */
export function householdIdentity(c) {
  if (c?.keyLocation === 'secure') return c.keyTag ? `secure:${c.keyTag}` : '';
  return c?.householdKey || '';
}

/** The stored config after `patch` (pure). Unknown fields are ignored. */
export function nextSyncConfig(cur, patch = {}) {
  const c = { ...NO_CONFIG, ...cur };
  const str = (v, d) => (typeof v === 'string' ? v.trim() : d);
  const next = {
    relayUrl: str(patch.relayUrl, c.relayUrl),
    householdKey: str(patch.householdKey, c.householdKey),
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : c.enabled,
    keyLocation: patch.keyLocation === 'secure' || patch.keyLocation === 'idb' ? patch.keyLocation : c.keyLocation,
    keyTag: str(patch.keyTag, c.keyTag),
  };
  if (next.keyLocation === 'secure') next.householdKey = ''; // never both
  next.wasPaired = Boolean(c.wasPaired || householdIdentity(c) || householdIdentity(next));
  return next;
}

async function recordsDb() {
  const db = await open();
  if (source !== RECORDS) throw new Error('Sync needs the storage update to finish first.');
  return db;
}

/**
 * The stored config: { relayUrl, householdKey, enabled, wasPaired, keyLocation, keyTag }. On a phone
 * whose key has moved to secure storage, householdKey is ''. Everything else reads the config through
 * js/secure-key.js, which fills in the key.
 */
export async function getSyncConfig() {
  const db = await recordsDb();
  const row = await result(db.transaction(META).objectStore(META).get('syncConfig'));
  return { ...NO_CONFIG, ...row?.value };
}

/**
 * Change some config fields. A different household means a different room: the cursor goes back
 * to 0, and every record is queued again so the new room gets this device's data. One transaction.
 */
export async function setSyncConfig(patch) {
  const db = await recordsDb();
  const tx = db.transaction([META, RECORDS, OUTBOX], 'readwrite');
  const metaStore = tx.objectStore(META);
  const [row, records] = await Promise.all([result(metaStore.get('syncConfig')), result(tx.objectStore(RECORDS).getAll())]);
  const cur = { ...NO_CONFIG, ...row?.value };
  const next = nextSyncConfig(cur, patch);
  metaStore.put({ key: 'syncConfig', value: next });
  let requeued = 0;
  if (householdIdentity(next) !== householdIdentity(cur)) {
    metaStore.put({ key: 'syncCursor', value: 0 });
    if (householdIdentity(next)) {
      const ops = requeueOps(records);
      for (const op of ops) tx.objectStore(OUTBOX).put(op);
      requeued = ops.length;
    }
  }
  await done(tx);
  if (requeued) changesEnqueued(requeued);
  return next;
}

/**
 * The key has been copied to secure storage and read back: drop it from here and record where it
 * is, in one write, only if this config still holds exactly `expectedKey` (so a key changed in the
 * meantime is never dropped). Same household: the cursor and outbox are untouched.
 * Returns true if the move was recorded.
 */
export async function moveKeyToSecure(expectedKey, keyTag) {
  if (!expectedKey || !keyTag) throw new Error('moveKeyToSecure needs the key and a tag');
  const db = await recordsDb();
  const tx = db.transaction(META, 'readwrite');
  const metaStore = tx.objectStore(META);
  const cur = { ...NO_CONFIG, ...(await result(metaStore.get('syncConfig')))?.value };
  if (cur.keyLocation !== 'idb' || cur.householdKey !== expectedKey) { await done(tx); return false; }
  metaStore.put({ key: 'syncConfig', value: { ...nextSyncConfig(cur, { keyLocation: 'secure', keyTag }), wasPaired: true } });
  await done(tx);
  return true;
}

/** Queue every record again and restart from cursor 0 (the relay lost its data, or the room is new). */
export async function requeueAll() {
  const db = await recordsDb();
  const tx = db.transaction([META, RECORDS, OUTBOX], 'readwrite');
  const ops = requeueOps(await result(tx.objectStore(RECORDS).getAll()));
  for (const op of ops) tx.objectStore(OUTBOX).put(op);
  tx.objectStore(META).put({ key: 'syncCursor', value: 0 });
  await done(tx);
  return ops.length;
}

/** Up to `limit` pending ops, oldest stamp first. */
export async function pendingOps(limit = 500) {
  const db = await recordsDb();
  return result(db.transaction(OUTBOX).objectStore(OUTBOX).index('t').getAll(null, limit));
}

export async function pendingCount() {
  const db = await recordsDb();
  return result(db.transaction(OUTBOX).objectStore(OUTBOX).count());
}

/**
 * Remove ops the relay has stored. Each is removed only if the outbox still holds that very stamp
 * for its field: a newer local edit made while the push was in flight replaced it and must stay.
 */
export async function removeSentOps(sent) {
  const db = await recordsDb();
  const tx = db.transaction(OUTBOX, 'readwrite');
  const store = tx.objectStore(OUTBOX);
  const rows = await Promise.all(sent.map((s) => result(store.get([s.rec, s.f]))));
  let removed = 0;
  sent.forEach((s, i) => { if (rows[i]?.t === s.t) { store.delete([s.rec, s.f]); removed++; } });
  await done(tx);
  return removed;
}

export async function getSyncCursor() {
  const db = await recordsDb();
  const row = await result(db.transaction(META).objectStore(META).get('syncCursor'));
  return Number.isSafeInteger(row?.value) ? row.value : 0;
}

/**
 * Apply ops from the relay and move the cursor to `cursor`, in ONE transaction over records and
 * meta only: the outbox isn't part of it, so pulled ops can't be queued to send back, and the
 * cursor can't move without the ops (or the ops land without the cursor).
 * Returns { changed, skipped, touched }.
 */
export async function applyRemote(ops, cursor) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid sync cursor');
  const db = await recordsDb();
  const tx = db.transaction([RECORDS, META], 'readwrite');
  const recStore = tx.objectStore(RECORDS);
  const metaStore = tx.objectStore(META);
  const ids = [...new Set(ops.filter((op) => sync.isRecordId(op?.rec)).map((op) => op.rec))];
  const [rows, devRow, hlcRow] = await Promise.all([
    Promise.all(ids.map((id) => result(recStore.get(id)))), result(metaStore.get('deviceId')), result(metaStore.get('hlc')),
  ]);
  let out;
  let replica;
  try {
    replica = { clock: loadClock(hlcRow?.value, devRow?.value), records: new Map(rows.filter(Boolean).map((r) => [r.id, r])) };
    out = applyRemoteOps(replica, ops);
  } catch (err) {
    tx.abort();
    throw err;
  }
  for (const id of out.touched) recStore.put(replica.records.get(id));
  metaStore.put({ key: 'hlc', value: { wall: replica.clock.wall, count: replica.clock.count } });
  metaStore.put({ key: 'syncCursor', value: cursor });
  await done(tx);
  return out;
}

/**
 * Joining a household with "Use the household's data": in ONE transaction over records, outbox and
 * meta, this device's records and pending changes are replaced by the household's (`ops`, everything
 * pulled up to `cursor`), and the sync config is saved (`config`, e.g. the key and enabled). The
 * caller pulls everything first, so a failed pull never gets here; any failure in here aborts the
 * transaction and leaves this device exactly as it was. The device id and clock are kept (the clock
 * moves past every stamp received). Nothing is queued: the household already has all of it.
 * Returns { records, changed, skipped }.
 */
export async function replaceWithRemote(ops, cursor, config = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid sync cursor');
  const db = await recordsDb();
  const tx = db.transaction([RECORDS, OUTBOX, META], 'readwrite');
  const recStore = tx.objectStore(RECORDS);
  const metaStore = tx.objectStore(META);
  const [devRow, hlcRow, cfgRow] = await Promise.all([
    result(metaStore.get('deviceId')), result(metaStore.get('hlc')), result(metaStore.get('syncConfig')),
  ]);
  let replica;
  let out;
  try {
    replica = { clock: loadClock(hlcRow?.value, devRow?.value), records: new Map() };
    out = applyRemoteOps(replica, ops);
  } catch (err) {
    tx.abort();
    throw err;
  }
  recStore.clear();
  tx.objectStore(OUTBOX).clear();
  for (const rec of replica.records.values()) recStore.put(rec);
  const next = nextSyncConfig(cfgRow?.value, config);
  metaStore.put({ key: 'hlc', value: { wall: replica.clock.wall, count: replica.clock.count } });
  metaStore.put({ key: 'syncCursor', value: cursor });
  metaStore.put({ key: 'syncConfig', value: next });
  await done(tx);
  return { records: replica.records.size, changed: out.changed, skipped: out.skipped };
}

/** How many live items (not deleted, not the settings record) this device has. */
export async function liveItemCount() {
  return (await getAll()).length;
}

export async function getLastSynced() {
  const db = await recordsDb();
  const row = await result(db.transaction(META).objectStore(META).get('lastSyncedAt'));
  return typeof row?.value === 'number' ? row.value : null;
}

export async function setLastSynced(ms) {
  await writeMeta(await recordsDb(), { lastSyncedAt: ms });
}

/** Everything js/sync.js needs from storage, as one adapter (tests pass an in-memory one instead). */
export const syncStore = {
  getConfig: getSyncConfig, setConfig: setSyncConfig, requeueAll, pendingOps, pendingCount, removeSentOps,
  getCursor: getSyncCursor, applyRemote, replaceWithRemote, moveKeyToSecure, liveItemCount, getLastSynced, setLastSynced,
  onChangesEnqueued: (fn) => onChangesEnqueued(fn),
};

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
/**
 * The app's view of a record: the plain item, or null for a deleted (tombstoned) record. Every
 * stored field comes through, unknown ones too, except a `repeat` whose stamp is older than the
 * cycle's: an older device changed the cycle after it, so it no longer counts (js/interval.js
 * effectiveInterval, the stamp half of the rule). The record keeps it, and it still syncs.
 */
export function toItem(record) {
  if (!sync.isLive(record)) return null;
  const item = { id: record.id };
  for (const [f, v] of Object.entries(record.fields)) if (f !== sync.DELETED) item[f] = v;
  const { repeat: tr, cycle: tc } = record.ts ?? {};
  if (REPEAT in item && typeof tc === 'string' && !(typeof tr === 'string' && tr >= tc)) delete item[REPEAT];
  return item;
}

/** The item fields to store, in ITEM_FIELDS order. Fields the item doesn't have are left alone. */
function itemFields(item) {
  return Object.fromEntries(ITEM_FIELDS.filter((f) => item[f] !== undefined).map((f) => [f, item[f]]));
}

/**
 * Format 5's interval field: `repeat: { every, unit }` beside `cycle` (docs/plan-intervals-groups.md
 * 4.1). It isn't in ITEM_FIELDS, so saving an item never writes it: in this version only an import
 * carries one in, from a file that has it. Synced as its own field with its own stamp.
 */
export const REPEAT = 'repeat';

/**
 * The `repeat` a backup item may bring in: a readable interval (js/interval.js READ_LIMITS) on a
 * recurring item whose cycle is its shadow, as { every, unit } (other keys dropped). Else null, and
 * only the field is left out: the item itself imports as before.
 */
export function fileRepeat(raw) {
  const r = raw?.[REPEAT];
  if (raw?.cycle === 'once' || !isReadableInterval(r) || shadowCycle(r) !== raw.cycle) return null;
  return { every: r.every, unit: r.unit };
}

/** The fields an import writes for an item: itemFields, plus its `repeat` when the file had a usable one. */
function importFields(item) {
  const fields = itemFields(item);
  if (item[REPEAT] !== undefined) fields[REPEAT] = item[REPEAT];
  return fields;
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
  // An item without `repeat` in the file leaves a stored one alone (putRecord only sets the fields
  // it's given): a missing repeat means "not known here", never "every 1 month" (see effectiveInterval).
  for (const item of writes) ops.push(...sync.putRecord(replica, item.id, importFields(item), opts));
  return ops;
}

/**
 * Whether an op from another device is safe to store. Known item fields must have the type the
 * app expects (so a buggy client can't break the screens); fields this version doesn't know are
 * kept, since a newer version may have added them (sync-core has already checked they're plain JSON).
 */
function acceptableRemote(op) {
  if (op.rec === SETTINGS_ID) return acceptableSetting(op);
  if (op.f === sync.DELETED) return typeof op.v === 'boolean';
  // Any plain JSON is stored for `repeat` (sync-core has checked it is JSON): a value this version
  // can't use is read as "use the cycle" (js/interval.js effectiveInterval), never skipped, because a
  // skipped op never comes back and a later version may know what it means.
  if (op.f === REPEAT) return true;
  if (op.f === 'price') return typeof op.v === 'number' && Number.isFinite(op.v) && op.v >= 0;
  if (ITEM_FIELDS.includes(op.f)) return typeof op.v === 'string' && op.v.length <= 2000;
  return true;
}

/**
 * Apply ops pulled from the relay to `replica`: fold every stamp into the clock (receive), then
 * merge with last-write-wins. Invalid ops are skipped and counted. Nothing is returned for the
 * outbox: these ops came from elsewhere and must not be sent again.
 */
export function applyRemoteOps(replica, ops, now = Date.now()) {
  let changed = 0;
  let skipped = 0;
  const touched = new Set();
  for (const op of ops) {
    if (!sync.isOp(op) || !acceptableRemote(op)) { skipped++; continue; }
    replica.clock = sync.receive(replica.clock, op.t, now);
    if (sync.applyOp(replica.records, op)) { changed++; touched.add(op.rec); }
  }
  return { changed, skipped, touched: [...touched] };
}

/**
 * One op per field of every record, carrying the record's current value and stamp, so that a
 * newly joined household (or a relay that lost its data) receives everything this device knows.
 */
export function requeueOps(records) {
  const ops = [];
  for (const r of records) {
    for (const [f, v] of Object.entries(r.fields)) {
      const s = sync.parseStamp(r.ts[f]);
      if (s) ops.push({ id: uid(), rec: r.id, f, v, t: r.ts[f], dev: s.dev });
    }
  }
  return ops.filter(sync.isOp);
}

/* --------------------------------------------------------------------------
   Shared settings record. Pure functions, also used by the Node tests.
   -------------------------------------------------------------------------- */
// The record has no `del` field, so it is never live and never an item. Fields:
//   defaultCurrency      a 3-letter code (null: cleared)
//   color_<16 hex>       { name, swatch } for one expense group (null: cleared)
// One field per group means concurrent colour changes to different groups both survive; for the
// same field the later stamp wins, as for items. Field names allow only letters, digits and `_`,
// so the group name is hashed into the field name (colorField) and carried in the value.
export const SETTINGS_ID = 'settings';
const CURRENCY_FIELD = 'defaultCurrency';
const COLOR_PREFIX = 'color_';
// Kept in the settings store on this device only: values the app picked by itself, used where the
// household has no value. Never synced, never exported, never seeded into the record.
const AUTO_CURRENCY = 'autoCurrency';
const AUTO_COLORS = 'autoGroupColors';

const isCurrency = (v) => typeof v === 'string' && /^[A-Z]{3}$/.test(v);
const isGroupName = (v) => typeof v === 'string' && v.length > 0 && v.length <= 40 && v === v.trim();
const isSwatchKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 8;

/**
 * The field name for a group's colour: a 64-bit hash of the name (cyrb53's two 32-bit lanes) in
 * hex. Every device must compute the same name, so this function is part of the sync format.
 */
export function colorField(name) {
  return `${COLOR_PREFIX}${hash64(name)}`;
}

/** cyrb53's two 32-bit lanes of `text`, as 16 hex digits. Part of the sync format (colorField, versionNoteField). */
function hash64(name) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return `${hex(h2)}${hex(h1)}`;
}

/** Whether a field value from another device is a usable shared setting (null clears). */
function acceptableSetting(op) {
  if (op.f === sync.DELETED) return false; // the record must never become an item
  if (op.f === CURRENCY_FIELD) return op.v === null || isCurrency(op.v);
  if (op.f.startsWith(COLOR_PREFIX)) {
    return op.v === null || (isObj(op.v) && isGroupName(op.v.name) && isSwatchKey(op.v.swatch) && colorField(op.v.name) === op.f);
  }
  return true; // a shared setting a newer version added: kept, not used here
}

/**
 * A colour value's palette slot (format 5, docs/plan-intervals-groups.md 4.2), or null: a whole
 * number 0–29 whose base colour (slot mod 15) is the value's swatch, `w1`–`w15`. Anything else on
 * the value (no slot, a slot that doesn't match, `auto`, keys a later version adds) is left as it is.
 */
export function slotOf(value) {
  const s = value?.slot;
  if (!Number.isInteger(s) || s < 0 || s > 29) return null;
  return value.swatch === `w${(s % 15) + 1}` ? s : null;
}

/**
 * The shared settings in the record: { defaultCurrency?, groupColors, groupSlots? }. Cleared or bad
 * fields are skipped. groupSlots (name → slot) is there only when a colour value carries a slot
 * (slotOf); the values themselves, with any keys this version doesn't use, stay in the record.
 */
export function settingsFromRecord(record) {
  const out = {};
  const f = record?.fields ?? {};
  if (isCurrency(f[CURRENCY_FIELD])) out.defaultCurrency = f[CURRENCY_FIELD];
  out.groupColors = {};
  const slots = {};
  for (const [k, v] of Object.entries(f)) {
    if (k.startsWith(COLOR_PREFIX) && isObj(v) && isGroupName(v.name) && isSwatchKey(v.swatch) && colorField(v.name) === k) {
      out.groupColors[v.name] = v.swatch;
      if (slotOf(v) !== null) slots[v.name] = slotOf(v);
    }
  }
  if (Object.keys(slots).length) out.groupSlots = slots;
  return out;
}

/* Per-device version notes (format 5, docs/plan-intervals-groups.md 4.2 and 5.4) ---------------- */
// One field per device in the settings record: `app_` plus a 64-bit hash of its device id (the
// same cyrb53 as colorField; a device id may hold characters a field name can't), with the value
// { v: app version, fmt: data format, at: YYYY-MM-DD }. 1.21.0 reads them to tell whether every
// active device can show custom intervals. 1.19.0 keeps the field and ignores it. Format 5's
// first-launch step (migrateFormat) writes this device's note; nothing refreshes it later yet.
const NOTE_PREFIX = 'app_';
const NOTE_MAX_AGE_DAYS = 30;

/** The settings-record field for device `deviceId`'s version note. */
export const versionNoteField = (deviceId) => `${NOTE_PREFIX}${hash64(String(deviceId))}`;

const isNote = (v) => isObj(v) && typeof v.v === 'string' && v.v.length > 0 && v.v.length <= 32
  && Number.isInteger(v.fmt) && v.fmt >= 1 && typeof v.at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.at);

/** Every usable version note in the record: [{ field, v, fmt, at }], by field. Other values are skipped (and kept). */
export function versionNotes(record) {
  return Object.entries(record?.fields ?? {})
    .filter(([k, v]) => /^app_[0-9a-f]{16}$/.test(k) && isNote(v))
    .map(([field, v]) => ({ field, v: v.v, fmt: v.fmt, at: v.at }))
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

/**
 * Ops for this device's version note, only when it's due: none yet, another version or format, or
 * written more than 30 days before `now`. { deviceId, version, fmt, now (ms) }. Called by migrateFormat.
 */
export function versionNoteOps(replica, { deviceId, version, fmt, now = Date.now(), ...opts }) {
  const field = versionNoteField(deviceId);
  const cur = replica.records.get(SETTINGS_ID)?.fields?.[field];
  const d = new Date(now);
  const at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (isNote(cur) && cur.v === version && cur.fmt === fmt) {
    const [y, m, day] = cur.at.split('-').map(Number);
    // Whole local calendar days since it was written (no DST hours, no time of day).
    if (dayNumber(dayOf(d)) - dayNumber({ year: y, month: m - 1, day }) <= NOTE_MAX_AGE_DAYS) return [];
  }
  return sync.setFields(replica, SETTINGS_ID, { [field]: { v: version, fmt, at } }, { now, ...opts });
}

/**
 * Record fields for a settings change ({ defaultCurrency?, groupColors? }, groupColors a patch by
 * group name). With replaceColors, colours in the record that the change doesn't name are cleared.
 */
export function settingsFields(record, change, { replaceColors = false, keepMatching = false } = {}) {
  const fields = {};
  const named = new Set();
  const cur = change?.defaultCurrency;
  if (typeof cur === 'string' && /^[A-Za-z]{3}$/.test(cur)) fields[CURRENCY_FIELD] = cur.toUpperCase();
  const slots = isObj(change?.groupSlots) ? change.groupSlots : {};
  for (const [raw, swatch] of Object.entries(isObj(change?.groupColors) ? change.groupColors : {})) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!isGroupName(name) || !isSwatchKey(swatch)) continue;
    const field = colorField(name);
    named.add(field);
    // A slot comes with the colour only when it matches the swatch (slotOf), as a backup carries it.
    const value = slotOf({ swatch, slot: slots[raw] }) !== null ? { name, swatch, slot: slots[raw] } : { name, swatch };
    // keepMatching (imports): a colour the record already has, same swatch (and same slot, when the
    // change has one), is left as it is, so keys this version doesn't write (auto, later ones) stay.
    const now = record?.fields?.[field];
    if (keepMatching && isObj(now) && now.name === name && now.swatch === swatch && (!('slot' in value) || now.slot === value.slot)) continue;
    fields[field] = value;
  }
  if (replaceColors) {
    for (const [k, v] of Object.entries(record?.fields ?? {})) {
      if (k.startsWith(COLOR_PREFIX) && v !== null && !named.has(k)) fields[k] = null;
    }
  }
  return fields;
}

/** Ops for an explicit settings change (a choice in the app or an import). Unchanged values make none. */
export function settingsOps(replica, change, { replaceColors, keepMatching, ...opts } = {}) {
  const fields = settingsFields(replica.records.get(SETTINGS_ID), change, { replaceColors, keepMatching });
  return sync.setFields(replica, SETTINGS_ID, fields, opts);
}

/** The explicitly stored shared settings in this device's settings store (its key → value rows). */
export function storedSharedSettings(rows) {
  const out = {};
  const cur = rows?.defaultCurrency;
  if (typeof cur === 'string' && /^[A-Za-z]{3}$/.test(cur)) out.defaultCurrency = cur.toUpperCase();
  out.groupColors = cleanColors(rows?.groupColors);
  return out;
}

/** Upgrade seeding: ops for the stored settings the record doesn't have yet, all with one stamp of now. */
export function seedSettingsOps(replica, stored, opts) {
  const rec = replica.records.get(SETTINGS_ID);
  const fields = settingsFields(null, stored);
  for (const f of Object.keys(fields)) if (rec && f in rec.ts) delete fields[f];
  return sync.setFields(replica, SETTINGS_ID, fields, opts);
}

const settingsFieldCount = (stored) => Object.keys(settingsFields(null, stored)).length;

/** Check the seeding: every stored setting has a stamped field in the record. Null, or what's wrong (counts only). */
export function verifySettingsSeed(stored, record) {
  const want = Object.keys(settingsFields(null, stored));
  if (record && sync.DELETED in record.fields) return 'the settings record looks like an item';
  const missing = want.filter((f) => !sync.isStamp(record?.ts?.[f])).length;
  return missing ? `${missing} of ${want.length} settings missing` : null;
}

/**
 * What the app sees, from this device's settings store and the record: the household's value
 * where there is one, else the one this device picked by itself. Other stored keys come through
 * unchanged (they are per device); the old per-device copies of the two shared settings don't.
 */
export function effectiveSettings(local, record) {
  const { defaultCurrency, groupColors, [AUTO_CURRENCY]: autoCurrency, [AUTO_COLORS]: autoColors, ...rest } = local ?? {};
  const shared = settingsFromRecord(record);
  const out = { ...rest };
  const cur = shared.defaultCurrency ?? (isCurrency(autoCurrency) ? autoCurrency : undefined);
  if (cur) out.defaultCurrency = cur;
  out.groupColors = { ...cleanColors(autoColors), ...shared.groupColors };
  if (shared.groupSlots) out.groupSlots = shared.groupSlots;
  return out;
}

/* --------------------------------------------------------------------------
   Items and settings
   -------------------------------------------------------------------------- */
/** Every item that hasn't been deleted, in the plain item shape. */
export async function getAll() {
  const db = await open();
  const rows = await result(db.transaction(source).objectStore(source).getAll());
  return source === RECORDS ? rows.filter((r) => r.id !== SETTINGS_ID).map(toItem).filter(Boolean) : rows;
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
  if (item.id === SETTINGS_ID) throw new Error('Storage: that item id is reserved.');
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

/**
 * All settings as one object, e.g. { defaultCurrency: 'TWD', groupColors: {…} }. The default
 * currency and group colours are the household's where it has chosen them (see effectiveSettings).
 */
export async function getSettings() {
  const db = await open();
  if (!settingsShared) return readSettings(db.transaction(SETTINGS).objectStore(SETTINGS));
  const tx = db.transaction([SETTINGS, RECORDS]);
  const [local, rec] = await Promise.all([readSettings(tx.objectStore(SETTINGS)), result(tx.objectStore(RECORDS).get(SETTINGS_ID))]);
  return effectiveSettings(local, rec);
}

/**
 * The group colours someone chose ({ groupName: swatchKey }), without the ones the app picked by
 * itself. With shared settings that's the household's record; before that step every colour was
 * kept in one per-device map, so all of them count as chosen. Read-only.
 */
export async function getPickedGroupColors() {
  const db = await open();
  if (!settingsShared) return cleanColors((await readSettings(db.transaction(SETTINGS).objectStore(SETTINGS))).groupColors);
  return settingsFromRecord(await result(db.transaction(RECORDS).objectStore(RECORDS).get(SETTINGS_ID))).groupColors;
}

/** A copy of the shared settings record (an empty one when nothing is in it yet; null before settings are shared). Read-only. */
export async function getSettingsRecord() {
  const db = await open();
  if (!settingsShared) return null;
  const rec = await result(db.transaction(RECORDS).objectStore(RECORDS).get(SETTINGS_ID));
  return rec ? JSON.parse(JSON.stringify(rec)) : { id: SETTINGS_ID, fields: {}, ts: {} };
}

/**
 * Write group colour values as they are ({ field: value }, js/group-slots.js slotFields): the
 * automatic slots the app assigns and repairs. They sync like any setting. Nothing before settings
 * are shared (the device keeps its own automatic colours then). Returns the ops written.
 */
export async function saveColourValues(fields) {
  await open();
  if (!settingsShared || !Object.keys(fields).length) return [];
  for (const [k, v] of Object.entries(fields)) {
    const ok = k.startsWith(COLOR_PREFIX) && isObj(v) && isGroupName(v.name) && isSwatchKey(v.swatch) && colorField(v.name) === k;
    if (!ok) throw new Error('Storage: not a colour value');
  }
  return commit((r) => sync.setFields(r, SETTINGS_ID, fields), { ids: [SETTINGS_ID] });
}

async function readSettings(store) {
  const rows = await result(store.getAll());
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const COLOR_KEYS = new Set(['groupColors', AUTO_COLORS]);

/** Put settings rows; a group-colour map is merged into the stored one (it's a patch by group). */
async function putLocalSettings(store, obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (COLOR_KEYS.has(key)) {
      const row = await result(store.get(key));
      store.put({ key, value: { ...cleanColors(row?.value), ...cleanColors(value) } });
    } else store.put({ key, value });
  }
}

async function writeLocalSettings(db, obj) {
  if (!Object.keys(obj).length) return;
  const tx = db.transaction(SETTINGS, 'readwrite');
  await putLocalSettings(tx.objectStore(SETTINGS), obj);
  await done(tx);
}

/**
 * A setting the person chose. `groupColors` is a patch: { groupName: swatchKey } for the groups
 * that changed. The default currency and group colours go to the shared record as ops, so they
 * sync; other keys stay on this device. Before the shared record is set up, all of it stays here.
 */
export async function saveSettings(obj) {
  const db = await open();
  if (!settingsShared) return writeLocalSettings(db, obj);
  const shared = Object.fromEntries(Object.entries(obj).filter(([k]) => BACKUP_SETTINGS.includes(k)));
  const local = Object.fromEntries(Object.entries(obj).filter(([k]) => !BACKUP_SETTINGS.includes(k)));
  await commit((r) => settingsOps(r, shared), { ids: [SETTINGS_ID], settings: local });
}

/**
 * A value the app picked by itself ({ defaultCurrency?, groupColors? }, colours as a patch): the
 * locale currency, an auto-assigned group colour. Kept on this device only and never synced, so it
 * can't override what the household chose; the household's value replaces it when it arrives.
 */
export async function saveLocalDefaults({ defaultCurrency, groupColors } = {}) {
  const db = await open();
  const obj = {};
  if (defaultCurrency !== undefined) obj[settingsShared ? AUTO_CURRENCY : 'defaultCurrency'] = defaultCurrency;
  if (groupColors !== undefined) obj[settingsShared ? AUTO_COLORS : 'groupColors'] = groupColors;
  await writeLocalSettings(db, obj);
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
// Backups: { app, schemaVersion: 5, exportedAt, items, settings }: the live (not deleted) items with
// their ids, and the settings worth restoring (BACKUP_SETTINGS). Format 5 (docs/plan-intervals-groups.md
// 4.3) is format 4 plus an item's `repeat` and the colours' `groupSlots`, each only where present.
// Nothing else from the device goes in:
// no sync bookkeeping (device id, clock, cursor, outbox, field stamps), no entitlement flags, and no
// appearance or other preferences. Import restores the two settings as explicit changes, so they sync.
// Older files still import: schemaVersion 3 has the same envelope, and files from 1.0–1.2 use
// { format, version: 1|2, … } with records under `subscriptions` (v1) or `items` (v2).

/** The settings a backup carries. An allowlist, so anything added to settings later stays out until listed here. */
export const BACKUP_SETTINGS = ['defaultCurrency', 'groupColors', 'groupSlots'];

/** The backup format this version writes. Files up to it import as this version's own. */
export const BACKUP_VERSION = 5;
const LEGACY_BACKUP_SETTINGS = ['defaultCurrency', 'groupColors'];

/**
 * A backup of `items` (live, as getAll gives them) and `settings` (as getSettings gives them), in
 * format `version` (5, or 4 as 1.19.0 wrote it: the same items, without groupSlots). Pure.
 */
export function backupPayload(items, settings, exportedAt, version = BACKUP_VERSION) {
  // Fill fields older records lack (pre-1.1.0 ones have no type, date or emoji) so every backup
  // carries the full current shape.
  const full = items.map((s) => ({ ...s, type: s.type === 'income' ? 'income' : 'expense', date: s.date ?? '', emoji: s.emoji ?? '' }));
  const keys = version >= 5 ? BACKUP_SETTINGS : LEGACY_BACKUP_SETTINGS;
  const kept = Object.fromEntries(keys.filter((k) => settings[k] !== undefined).map((k) => [k, settings[k]]));
  return { app: APP_ID, schemaVersion: version, exportedAt, items: full, settings: kept };
}

/**
 * The export check (docs/plan-intervals-groups.md 4.3): read the payload back with this version's
 * reader and with 1.19.0's rules, and compare it with the live items. Null when it all holds, else
 * a short description (counts only). It holds when:
 * - parseBackup reads it without an error;
 * - every item passes what 1.19.0's import requires (so a 1.19.0 device can import the file): an id
 *   (1-64 characters, not the settings id, no two alike), a name, a price of 0 or more, a currency
 *   code, a type of expense or income if any, a cycle of monthly, annual or once, and a date on a one-off;
 * - every live item comes back with the same interval (effectiveInterval), so no repeat that
 *   counts is lost, and the palette slots come back as they are.
 */
export function checkBackup(payload, items, settings = {}) {
  let parsed;
  try { parsed = parseBackup(JSON.parse(JSON.stringify(payload))); } catch (err) {
    return `this version can't read it back (${err instanceof ImportError ? 'import error' : 'error'})`;
  }
  const ids = new Set();
  let legacyBad = 0;
  for (const s of payload.items) {
    const ok = typeof s.id === 'string' && s.id.length >= 1 && s.id.length <= 64 && s.id !== SETTINGS_ID && !ids.has(s.id)
      && typeof s.name === 'string' && s.name.trim() !== '' && typeof s.price === 'number' && Number.isFinite(s.price) && s.price >= 0
      && typeof s.currency === 'string' && /^[A-Za-z]{3}$/.test(s.currency) && (s.type === undefined || TYPES.includes(s.type))
      && CYCLES.includes(s.cycle) && (s.cycle !== 'once' || isDay(s.date));
    ids.add(s.id);
    if (!ok) legacyBad++;
  }
  if (legacyBad) return `${legacyBad} of ${payload.items.length} items would not import on 1.19.0`;
  const back = new Map(parsed.items.map(({ item }) => [item.id, item]));
  const moved = items.filter((s) => !back.has(s.id) || !sync.sameValue(effectiveInterval(back.get(s.id)), effectiveInterval(s))).length;
  if (moved || back.size !== items.length) return `${moved} of ${items.length} items come back with another interval`;
  const slots = cleanSlots(parsed.settings?.groupSlots, cleanColors(parsed.settings?.groupColors));
  if (!sync.sameValue(slots, cleanSlots(settings.groupSlots, settings.groupColors))) return "palette slots don't come back as they are";
  return null;
}

/**
 * What exporting writes, from `items` and `settings` (pure): { payload, format, problem }. Format 5
 * when checkBackup holds; otherwise format 4, exactly as 1.19.0 would have written it, with the
 * problem (counts only). The app says so on screen when it's format 4 (app.js exportData).
 */
export function exportBackupFrom(items, settings, exportedAt) {
  const payload = backupPayload(items, settings, exportedAt);
  const problem = checkBackup(payload, items, settings);
  if (!problem) return { payload, format: BACKUP_VERSION, problem: null };
  return { payload: backupPayload(items, settings, exportedAt, 4), format: 4, problem };
}

/** What exporting this device's data writes: { payload, format, problem } (exportBackupFrom). */
export async function exportBackup() {
  const [items, settings] = await Promise.all([getAll(), getSettings()]);
  return exportBackupFrom(items, settings, new Date().toISOString());
}

/** Everything needed to restore this device's items, as a plain object ready for JSON.stringify. */
export async function exportAll() {
  return (await exportBackup()).payload;
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
    if (json.length > MAX_IMPORT_CHARS) throw new ImportError(t('import.error.tooLarge'));
    try { data = JSON.parse(json); } catch { throw new ImportError(t('import.error.json')); }
  }
  if (!isObj(data)) throw new ImportError(t('import.error.noHeader'));

  let version, rows, listName;
  if ('app' in data || 'schemaVersion' in data) {
    if (data.app !== APP_ID) throw new ImportError(t('import.error.app', { app: APP_ID }));
    if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
      throw new ImportError(t('import.error.schemaVersion'));
    }
    version = data.schemaVersion;
    listName = 'items';
    rows = data.items;
  } else if (data.format === APP_ID) {
    version = Number(data.version);
    if (version !== 1 && version !== 2) throw new ImportError(t('import.error.version'));
    listName = version === 1 ? 'subscriptions' : 'items';
    rows = data[listName];
  } else {
    throw new ImportError(t('import.error.noApp', { app: APP_ID }));
  }
  if (!Array.isArray(rows)) throw new ImportError(t('import.error.list', { list: listName }));
  if (!rows.length) throw new ImportError(t('import.error.empty'));
  if (data.settings !== undefined && !isObj(data.settings)) {
    throw new ImportError(t('import.error.settings'));
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
  if (!isObj(raw)) throw new ImportError(t('import.error.notObject', { n: i + 1 }));
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const fail = (key, params) => {
    const problem = t(key, params);
    throw new ImportError(name ? t('import.error.itemNamed', { n: i + 1, name: name.slice(0, 40), problem }) : t('import.error.item', { n: i + 1, problem }));
  };
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 64) fail('import.error.id');
  if (raw.id === SETTINGS_ID) fail('import.error.idReserved', { id: SETTINGS_ID });
  if (firstSeen.has(raw.id)) fail('import.error.idSame', { n: firstSeen.get(raw.id) + 1 });
  firstSeen.set(raw.id, i);
  if (!name) fail('import.error.name');
  if (typeof raw.price !== 'number' || !Number.isFinite(raw.price) || raw.price < 0) fail('import.error.price');
  if (typeof raw.currency !== 'string' || !/^[A-Za-z]{3}$/.test(raw.currency)) fail('import.error.currency');
  if (!CYCLES.includes(raw.cycle)) fail('import.error.cycle');
  // Records saved before 1.1.0 have no type and are expenses, in any file version.
  if (raw.type !== undefined && !TYPES.includes(raw.type)) fail('import.error.type');
  if (raw.cycle === 'once' && !isDay(raw.date)) fail('import.error.date');
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
    // Format 5's interval, from a file of any version (a 1.19.0 backup can carry one it synced):
    // kept only when usable and in agreement with the cycle (fileRepeat); otherwise left out.
    ...(fileRepeat(raw) ? { [REPEAT]: fileRepeat(raw) } : {}),
  };
}

/**
 * A shared-settings import's ops (importAll with shared settings; pure): the items (importOps), then
 * the settings. Replace clears colours the file doesn't have; a colour the record already has as
 * the file says is left as it is, keys this version doesn't write included (keepMatching).
 */
export function importChange(replica, plan, opts) {
  const replaceColors = plan.clear && 'groupColors' in plan.settings;
  return [...importOps(replica, plan, opts), ...settingsOps(replica, plan.settings, { replaceColors, keepMatching: true, ...opts })];
}

/** Palette slots from a file: name → slot (0-29) for the names in `colors` whose swatch the slot matches. */
function cleanSlots(raw, colors) {
  if (!isObj(raw) || !isObj(colors)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => slotOf({ swatch: colors[k], slot: v }) !== null));
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
  const base = { total: backup.items.length, existing: existing.length, newerVersion: backup.version > BACKUP_VERSION, withSettings };

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
  // `settings` is the change to make (merge: a patch of the file's colours; replace: the whole
  // set). `localSettings` is the same result as whole values, for a device whose settings aren't
  // shared yet and are stored as plain values.
  const fileColors = withSettings ? cleanColors(backup.settings.groupColors) : {};
  // Format 5: a colour's palette slot comes with it when the file has one that matches its swatch.
  const fileSlots = withSettings ? cleanSlots(backup.settings.groupSlots, fileColors) : {};
  const slotPart = Object.keys(fileSlots).length ? { groupSlots: fileSlots } : {};
  const cur = withSettings ? backup.settings.defaultCurrency : null;
  const fileCurrency = typeof cur === 'string' && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : null;
  const replaceLocal = withSettings ? { groupColors: fileColors, ...(fileCurrency ? { defaultCurrency: fileCurrency } : {}) } : {};
  const replaceSettings = withSettings ? { ...replaceLocal, ...slotPart } : {};

  return {
    merge: {
      summary: { ...base, mode: 'merge', added, updated, kept, removed: 0 },
      clear: false,
      writes: mergeWrites,
      settings: withSettings ? { groupColors: fileColors, ...slotPart } : {},
      localSettings: withSettings ? { groupColors: { ...cleanColors(current.groupColors), ...fileColors } } : {},
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
      settings: replaceSettings,
      localSettings: replaceLocal,
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
 * so a bad file or a failed write leaves existing data untouched. Items and the two shared
 * settings are written as ops like any other change, so an import syncs too; replace tombstones
 * the items it removes and clears group colours the file doesn't have. Returns the summary.
 */
export async function importAll(json, mode) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error(`Unknown import mode: ${mode}`);
  const plan = (await planImport(json))[mode];
  if (source === RECORDS && settingsShared) {
    const replaceColors = plan.clear && 'groupColors' in plan.settings;
    // Replace takes the file's colours as they are, so this device's own picks go too.
    await commit((replica) => importChange(replica, plan), { settings: replaceColors ? { [AUTO_COLORS]: {} } : {} });
    return plan.summary;
  }
  if (source === RECORDS) {
    await commit((replica) => importOps(replica, plan), { settings: plan.localSettings });
    return plan.summary;
  }
  // A fallback store (migration not verified): plain writes, as before.
  const db = await open();
  const tx = db.transaction([source, SETTINGS], 'readwrite');
  const store = tx.objectStore(source);
  if (plan.clear) store.clear();
  for (const item of plan.writes) store.put(item);
  const sstore = tx.objectStore(SETTINGS);
  for (const [key, value] of Object.entries(plan.localSettings)) sstore.put({ key, value });
  await done(tx);
  return plan.summary;
}
