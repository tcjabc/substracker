// Thin promise wrapper around IndexedDB. All data stays on this device.

const DB_NAME = 'substracker';
const DB_VERSION = 1;
const SUBS = 'subscriptions';
const SETTINGS = 'settings';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SUBS)) {
        db.createObjectStore(SUBS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database upgrade blocked by another open tab.'));
  });
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

export async function getAllSubs() {
  const db = await open();
  return result(db.transaction(SUBS).objectStore(SUBS).getAll());
}

export async function putSub(sub) {
  const db = await open();
  const tx = db.transaction(SUBS, 'readwrite');
  tx.objectStore(SUBS).put(sub);
  await done(tx);
  return sub;
}

export async function deleteSub(id) {
  const db = await open();
  const tx = db.transaction(SUBS, 'readwrite');
  tx.objectStore(SUBS).delete(id);
  await done(tx);
}

/** Write many records in one transaction. `replace` clears the store first. */
export async function bulkPutSubs(subs, { replace = false } = {}) {
  const db = await open();
  const tx = db.transaction(SUBS, 'readwrite');
  const store = tx.objectStore(SUBS);
  if (replace) store.clear();
  for (const s of subs) store.put(s);
  await done(tx);
}

export async function getSetting(key, fallback) {
  const db = await open();
  const row = await result(db.transaction(SETTINGS).objectStore(SETTINGS).get(key));
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  const db = await open();
  const tx = db.transaction(SETTINGS, 'readwrite');
  tx.objectStore(SETTINGS).put({ key, value });
  await done(tx);
}

export async function getAllSettings() {
  const db = await open();
  const rows = await result(db.transaction(SETTINGS).objectStore(SETTINGS).getAll());
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
