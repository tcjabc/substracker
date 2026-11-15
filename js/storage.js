// SubsTracker persistence. This is the only module that touches IndexedDB or localStorage:
// items and settings live in IndexedDB, a few per-device UI preferences in localStorage.
// Nothing here logs item contents.

import { firstEmoji } from './util.js';
import { cleanDomain } from './services.js';

export const APP_ID = 'substracker';

// Database versions: 1 had `subscriptions` + `settings`. 2 adds `items` + `meta`; the old
// `subscriptions` store is copied into `items` once and kept untouched as a fallback for at
// least one release. SCHEMA_VERSION is the data/export format, recorded in `meta`.
let dbName = 'substracker';
const DB_VERSION = 2;
export const SCHEMA_VERSION = 3;
const ITEMS = 'items';
const SETTINGS = 'settings';
const META = 'meta';
const LEGACY = 'subscriptions';

let dbPromise = null;
let itemStore = ITEMS; // LEGACY only if the migration could not be verified
let migration = null; // what happened on this load, for status()
let onBlocked = () => {};

/** Point the module at another database (tests use a throwaway one). */
export function useDatabase(name) {
  const old = dbPromise;
  dbPromise = null;
  dbName = name;
  itemStore = ITEMS;
  migration = null;
  old?.then((db) => db.close()).catch(() => {});
}

/** Called when another open tab of an older version holds the database and delays the upgrade. */
export function setBlockedHandler(fn) { onBlocked = fn; }

function openRaw() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
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

/** The open database, with the one-time migration done. Every public function goes through this. */
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = openRaw().then(async (db) => { await migrate(db); return db; });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/**
 * Copy the old `subscriptions` store into `items` the first time (only when `items` is empty),
 * then check every old record arrived. Until that check passes the old store stays in charge.
 * The old store is never modified or deleted here. Logs counts only.
 */
async function migrate(db) {
  const meta = await readMeta(db);
  if (meta.schemaVersion !== SCHEMA_VERSION && !db.objectStoreNames.contains(LEGACY)) {
    await writeMeta(db, { schemaVersion: SCHEMA_VERSION });
  }
  if (!db.objectStoreNames.contains(LEGACY) || meta.migration?.verified) {
    migration = meta.migration ?? null;
    return;
  }

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
  const verified = oldKeys.length === newKeys.length && oldKeys.every((k) => have.has(k));
  if (verified) {
    migration = { from: LEGACY, items: oldKeys.length, copied, verified: true, at: new Date().toISOString() };
    await writeMeta(db, { schemaVersion: SCHEMA_VERSION, migration });
  } else {
    itemStore = LEGACY;
    migration = { from: LEGACY, verified: false };
    console.warn(`Storage: migration check failed (${oldKeys.length} old, ${newKeys.length} new). Using the old store.`);
  }
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

/** Where the data stands: schema version, the migration record, and whether the old store is in use. */
export async function status() {
  const db = await open();
  const meta = await readMeta(db);
  return { schemaVersion: meta.schemaVersion ?? null, migration, usingLegacy: itemStore === LEGACY };
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
   Items and settings
   -------------------------------------------------------------------------- */
export async function getAll() {
  const db = await open();
  return result(db.transaction(itemStore).objectStore(itemStore).getAll());
}

export async function save(item) {
  const db = await open();
  const tx = db.transaction(itemStore, 'readwrite');
  tx.objectStore(itemStore).put(item);
  await done(tx);
  return item;
}

export async function remove(id) {
  const db = await open();
  const tx = db.transaction(itemStore, 'readwrite');
  tx.objectStore(itemStore).delete(id);
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

/** Store the given keys; keys not mentioned are left as they are. */
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
// Backups: { app, schemaVersion, exportedAt, items, settings }. Files from 1.0–1.2 use
// { format, version: 1|2, … } with records under `subscriptions` (v1) or `items` (v2); they still import.

/** Everything needed to restore this device, as a plain object ready for JSON.stringify. */
export async function exportAll() {
  const [items, settings] = await Promise.all([getAll(), getSettings()]);
  // Fill fields older records lack (pre-1.1.0 ones have no type, date or emoji) so every backup
  // carries the full current shape.
  const full = items.map((s) => ({ ...s, type: s.type === 'income' ? 'income' : 'expense', date: s.date ?? '', emoji: s.emoji ?? '' }));
  return { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), items: full, settings };
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
function parseBackup(json) {
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
  return { version, items, settings: data.settings ?? {} };
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
  const have = new Map(existing.map((s) => [s.id, s]));
  const inFile = new Set(backup.items.map(({ item }) => item.id));
  const base = { total: backup.items.length, existing: existing.length, newerVersion: backup.version > SCHEMA_VERSION };

  // Merge: match by id; the newer `updatedAt` wins, and a missing or unreadable date counts as oldest.
  const mergeWrites = [];
  let added = 0;
  let updated = 0;
  let kept = 0;
  for (const { item, ts } of backup.items) {
    const cur = have.get(item.id);
    if (!cur) { added++; mergeWrites.push(item); } else if (ts > stamp(cur.updatedAt)) { updated++; mergeWrites.push(item); } else kept++;
  }

  // Files without colours import fine; the app assigns any gaps. Merge lets the file's colours win for
  // the groups it names; replace takes the file's colours and its default currency.
  const fileColors = cleanColors(backup.settings.groupColors);
  const cur = backup.settings.defaultCurrency;
  const fileCurrency = typeof cur === 'string' && /^[A-Za-z]{3}$/.test(cur) ? cur.toUpperCase() : null;

  return {
    merge: {
      summary: { ...base, mode: 'merge', added, updated, kept, removed: 0 },
      clear: false,
      writes: mergeWrites,
      settings: { groupColors: { ...cleanColors(current.groupColors), ...fileColors } },
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
      settings: { groupColors: fileColors, ...(fileCurrency ? { defaultCurrency: fileCurrency } : {}) },
    },
  };
}

/**
 * What importing would do in each mode, as { merge, replace } summaries. Writes nothing.
 * A summary has total, existing, added, updated, kept, removed and newerVersion.
 * Throws ImportError, with a message naming the problem, for a file that can't be imported.
 */
export async function previewImport(json) {
  const plan = await planImport(json);
  return { merge: plan.merge.summary, replace: plan.replace.summary };
}

/**
 * Import a backup (JSON text or a parsed object). `mode` is "merge" or "replace".
 * The whole file is checked before anything is written, and the write is one transaction,
 * so a bad file or a failed write leaves existing data untouched. Returns the summary.
 */
export async function importAll(json, mode) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error(`Unknown import mode: ${mode}`);
  const { summary, clear, writes, settings } = (await planImport(json))[mode];
  const db = await open();
  const tx = db.transaction([itemStore, SETTINGS], 'readwrite');
  const store = tx.objectStore(itemStore);
  if (clear) store.clear();
  for (const item of writes) store.put(item);
  const sstore = tx.objectStore(SETTINGS);
  for (const [key, value] of Object.entries(settings)) sstore.put({ key, value });
  await done(tx);
  return summary;
}
