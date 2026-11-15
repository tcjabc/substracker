// SubsTracker persistence. This is the only module that touches IndexedDB or localStorage:
// items and settings live in IndexedDB, a few per-device UI preferences in localStorage.
// Nothing here logs item contents.

import { uid, firstEmoji, todayStamp } from './util.js';
import { cleanDomain } from './services.js';

export const APP_ID = 'substracker';

let dbName = 'substracker';
const DB_VERSION = 1;
const ITEMS = 'subscriptions';
const SETTINGS = 'settings';

let dbPromise = null;

/** Point the module at another database (tests use a throwaway one). */
export function useDatabase(name) {
  const old = dbPromise;
  dbPromise = null;
  dbName = name;
  old?.then((db) => db.close()).catch(() => {});
}

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ITEMS)) db.createObjectStore(ITEMS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database upgrade blocked by another open tab.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
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
  return result(db.transaction(ITEMS).objectStore(ITEMS).getAll());
}

export async function save(item) {
  const db = await open();
  const tx = db.transaction(ITEMS, 'readwrite');
  tx.objectStore(ITEMS).put(item);
  await done(tx);
  return item;
}

export async function remove(id) {
  const db = await open();
  const tx = db.transaction(ITEMS, 'readwrite');
  tx.objectStore(ITEMS).delete(id);
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
const EXPORT_VERSION = 2; // v2 adds `type` (income/expense), the "once" cycle and `date`. Import reads v1 and v2.

/** Everything needed to restore this device, as a plain object ready for JSON.stringify. */
export async function exportAll() {
  const [items, settings] = await Promise.all([getAll(), getSettings()]);
  return {
    format: APP_ID,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: { defaultCurrency: settings.defaultCurrency, groupColors: settings.groupColors ?? {} },
    // Renamed from v1's `subscriptions`, so older app versions (which would turn income
    // into expenses) refuse a v2 file instead of importing it wrongly.
    items,
  };
}

/** A problem with an import file. `message` is written for the person importing. */
export class ImportError extends Error {}

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Coerce an imported record (v1 or v2) into a valid item, or null if unusable. */
function sanitize(raw, fallbackCurrency) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? raw.serviceName ?? '').trim().slice(0, 80);
  const price = Number(raw.price);
  if (!name || !Number.isFinite(price) || price < 0) return null;
  const type = raw.type === 'income' ? 'income' : 'expense';
  const currency = /^[A-Za-z]{3}$/.test(raw.currency ?? '') ? raw.currency.toUpperCase() : fallbackCurrency;
  const rawCycle = String(raw.cycle ?? raw.billingCycle ?? '');
  const cycle = /^(once|one-?off)$/i.test(rawCycle) ? 'once'
    : /^(annual|yearly|year)$/i.test(rawCycle) ? 'annual' : 'monthly';
  const nextRenewal = cycle !== 'once' && isDay(raw.nextRenewal) ? raw.nextRenewal : '';
  // A one-off needs a date to be counted anywhere; fall back to when it was created, then today.
  const date = cycle !== 'once' ? ''
    : isDay(raw.date) ? raw.date
    : isDay(String(raw.createdAt ?? '').slice(0, 10)) ? raw.createdAt.slice(0, 10) : todayStamp();
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : uid(),
    type,
    name,
    domain: cleanDomain(String(raw.domain ?? '')).slice(0, 120),
    emoji: firstEmoji(raw.emoji),
    plan: String(raw.plan ?? raw.planName ?? '').trim().slice(0, 80),
    price: Math.round(price * 100) / 100,
    currency,
    cycle,
    nextRenewal,
    date,
    category: String(raw.category ?? '').trim().slice(0, 40),
    notes: String(raw.notes ?? '').trim().slice(0, 1000),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  };
}

/** Group colours from a file: a plain name → swatch-key map. The app drops unknown keys on load. */
function cleanColors(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw)
    .filter(([k, v]) => typeof k === 'string' && k.length <= 40 && typeof v === 'string' && v.length <= 8));
}

/**
 * Import a backup (JSON text or parsed object). `mode` is "merge" or "replace".
 * With { dryRun: true } nothing is written; the returned summary previews the result.
 * Throws ImportError for an unusable file, before anything is written.
 */
export async function importAll(json, mode, { dryRun = false } = {}) {
  if (mode !== 'merge' && mode !== 'replace') throw new Error(`Unknown import mode: ${mode}`);
  let data = json;
  if (typeof json === 'string') {
    try { data = JSON.parse(json); } catch { throw new ImportError("That file isn't valid JSON."); }
  }
  if (!Array.isArray(data) && Number(data?.version) > EXPORT_VERSION) {
    throw new ImportError('That backup is from a newer version of SubsTracker. Update the app, then import it.');
  }
  // v2 files hold `items`; v1 files and bare arrays hold subscriptions.
  const rows = Array.isArray(data) ? data : (data?.items ?? data?.subscriptions);
  if (!Array.isArray(rows)) throw new ImportError('No items found in that file.');

  const current = await getSettings();
  const items = rows.map((r) => sanitize(r, current.defaultCurrency || 'TWD')).filter(Boolean);
  if (!items.length) throw new ImportError('No valid items found in that file.');

  const existing = await getAll();
  const existingIds = new Set(existing.map((s) => s.id));
  const summary = {
    total: items.length,
    added: items.filter((s) => !existingIds.has(s.id)).length,
    updated: items.filter((s) => existingIds.has(s.id)).length,
    skipped: rows.length - items.length,
    existing: existing.length,
  };
  if (dryRun) return summary;

  const settings = {};
  const fileCurrency = data?.settings?.defaultCurrency;
  if (mode === 'replace' && /^[A-Z]{3}$/.test(fileCurrency ?? '')) settings.defaultCurrency = fileCurrency;
  // Files without colours import fine; the app assigns any gaps. Replace takes the file's
  // colours; merge lets the file's colours win for groups it names.
  const colors = cleanColors(data?.settings?.groupColors);
  settings.groupColors = mode === 'replace' ? colors : { ...cleanColors(current.groupColors), ...colors };

  // One transaction: either everything lands or nothing changes.
  const db = await open();
  const tx = db.transaction([ITEMS, SETTINGS], 'readwrite');
  const store = tx.objectStore(ITEMS);
  if (mode === 'replace') store.clear();
  for (const s of items) store.put(s);
  const sstore = tx.objectStore(SETTINGS);
  for (const [key, value] of Object.entries(settings)) sstore.put({ key, value });
  await done(tx);
  return summary;
}
