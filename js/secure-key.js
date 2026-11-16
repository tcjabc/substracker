// Where the household key lives, behind one small interface (get / set / remove, and `kind`):
//   native-secure  — phones: the Android Keystore / iOS Keychain, through the native plugin of
//                    @aparajita/capacitor-secure-storage. IndexedDB keeps only keyLocation 'secure'
//                    and a random keyTag that says which household the rest of the config is for.
//   web-indexeddb  — browsers have no real secure store, so the key stays in the IndexedDB sync
//                    config exactly as before.
// Everything that reads or writes the key goes through here (sync engine, Sync sheet, developer
// screen). Nothing here logs the key or puts it in an error message.

import { plugin } from './platform.js';

/** The secure-storage entry name. */
export const SECURE_KEY_ID = 'peek-budget.household-key';

// iOS Keychain accessibility from the plugin's KeychainAccess enum: whenUnlockedThisDeviceOnly.
// "ThisDeviceOnly" keeps the key out of iCloud Keychain and out of backups restored to another device.
const IOS_WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;

/** The key should be in secure storage but can't be read (e.g. app data restored to a new phone). */
export class KeyUnavailableError extends Error {
  constructor() {
    super('The household key is not available on this device.');
    this.code = 'key_unavailable';
  }
}

/**
 * The native secure store, or null where there is none (the web, or the plugin isn't installed).
 * Calls the plugin's native methods directly (the app has no bundler for its JS wrapper); values are
 * stored as plain strings, never synced to iCloud.
 */
export function nativeSecureStore(p = plugin('SecureStorage')) {
  if (!p) return null;
  const base = { prefixedKey: SECURE_KEY_ID, sync: false };
  return {
    async get() {
      const r = await p.internalGetItem(base);
      return typeof r?.data === 'string' && r.data ? r.data : null;
    },
    async set(value) { await p.internalSetItem({ ...base, data: value, access: IOS_WHEN_UNLOCKED_THIS_DEVICE_ONLY }); },
    async remove() { await p.internalRemoveItem(base); },
  };
}

function newTag() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const identity = (c) => (c?.keyLocation === 'secure' ? (c.keyTag ? `secure:${c.keyTag}` : '') : c?.householdKey || '');

/**
 * `store` is the IndexedDB side: { getSyncConfig, setSyncConfig, replaceWithRemote, moveKeyToSecure }
 * (js/storage.js). `secure` is nativeSecureStore() or a fake in tests; null means web-indexeddb.
 */
export function createKeyVault({ store, secure = nativeSecureStore(), log = console } = {}) {
  const kind = secure ? 'native-secure' : 'web-indexeddb';
  let migration = secure ? 'not-run' : 'not-needed';

  /** Write the key to secure storage and read it back. Throws if it didn't stick. */
  async function writeSecure(keyText) {
    await secure.set(keyText);
    if ((await secure.get()) !== keyText) throw new Error('secure storage read-back did not match');
  }

  /**
   * Put `keyText` in secure storage, then run `commit` (the IndexedDB write that records it). If the
   * commit fails, the secure slot gets its previous value back, so it never disagrees with the config.
   */
  async function secureThen(keyText, commit) {
    let prev = null;
    try { prev = await secure.get(); } catch { /* unreadable: nothing worth restoring */ }
    await writeSecure(keyText);
    try {
      return await commit();
    } catch (err) {
      try { if (prev) await secure.set(prev); else await secure.remove(); } catch { /* cleaned up on next launch */ }
      throw err;
    }
  }

  /** The household key ('' when there is none). Throws KeyUnavailableError if it should be in secure storage but isn't readable. */
  async function get(cfg) {
    const c = cfg ?? (await store.getSyncConfig());
    if (c.keyLocation !== 'secure') return c.householdKey || '';
    if (!secure) throw new KeyUnavailableError();
    let v;
    try { v = await secure.get(); } catch { throw new KeyUnavailableError(); }
    if (!v) throw new KeyUnavailableError();
    return v;
  }

  /** The config fields that say where `keyText` is going (secure storage when it can be written there). */
  async function placeKey(keyText, write) {
    if (!secure) return write({ householdKey: keyText, keyLocation: 'idb', keyTag: '' });
    try {
      return await secureThen(keyText, () => write({ householdKey: '', keyLocation: 'secure', keyTag: newTag() }));
    } catch (err) {
      if (err?.fromStore) throw err.cause;
      // Secure storage refused the key: keep it in IndexedDB so sync works; the next launch retries the move.
      log.warn('Secure key storage: could not store the key there, keeping it in IndexedDB for now.');
      return write({ householdKey: keyText, keyLocation: 'idb', keyTag: '' });
    }
  }

  // Store failures must not be mistaken for secure-storage failures in placeKey.
  const tagged = (fn) => async (...args) => {
    try { return await fn(...args); } catch (cause) { const e = new Error('store'); e.fromStore = true; e.cause = cause; throw e; }
  };

  /** Save `keyText` (with other config fields in `extra`). The same key as now changes nothing else. */
  async function set(keyText, extra = {}) {
    const cur = await store.getSyncConfig();
    let same = false;
    try { same = Boolean(keyText) && (await get(cur)) === keyText; } catch { /* unreadable: not the same */ }
    if (same) return store.setSyncConfig(extra);
    return placeKey(keyText, tagged((fields) => store.setSyncConfig({ ...extra, ...fields })));
  }

  /** Forget the key on this device (both places). Local data stays. */
  async function remove(extra = {}) {
    const out = await store.setSyncConfig({ ...extra, householdKey: '', keyLocation: 'idb', keyTag: '' });
    if (secure) {
      try { await secure.remove(); } catch { log.warn('Secure key storage: could not remove the key now; it is removed on the next launch.'); }
    }
    return out;
  }

  return {
    kind,
    get: () => get(),
    set,
    remove,
    /** 'not-needed' (web), 'not-run', 'migrated', 'already', 'nothing', 'cleaned' or 'failed'. */
    get migration() { return migration; },

    /**
     * Once per launch on a phone: move a key that is still in IndexedDB into secure storage. It is
     * written, read back and compared; only then is it dropped from IndexedDB (moveKeyToSecure, one
     * write that also records keyLocation 'secure'). Any failure leaves the IndexedDB copy and sync
     * exactly as before, and the next launch tries again. Also removes a key left in secure storage
     * by a turn-off whose removal failed.
     */
    async migrate() {
      if (!secure) return migration;
      let c;
      try { c = await store.getSyncConfig(); } catch { migration = 'failed'; return migration; }
      if (c.keyLocation === 'secure') { migration = 'already'; return migration; }
      if (!c.householdKey) {
        migration = 'nothing';
        try { if (await secure.get()) { await secure.remove(); migration = 'cleaned'; } } catch { /* try again next launch */ }
        return migration;
      }
      try {
        await writeSecure(c.householdKey);
      } catch {
        log.warn('Secure key storage: moving the key failed; it stays in IndexedDB and the move is retried next launch.');
        migration = 'failed';
        return migration;
      }
      let moved = false;
      try { moved = await store.moveKeyToSecure(c.householdKey, newTag()); } catch { moved = false; }
      migration = moved ? 'migrated' : 'failed';
      return migration;
    },

    /** The engine's getConfig: the stored config with the key filled in, or keyUnavailable: true. */
    async readConfig() {
      const c = await store.getSyncConfig();
      try {
        return { ...c, householdKey: await get(c), keyUnavailable: false };
      } catch (err) {
        if (!(err instanceof KeyUnavailableError)) throw err;
        return { ...c, householdKey: '', keyUnavailable: true };
      }
    },

    /** The engine's setConfig: a householdKey in the patch goes through set/remove. */
    async setConfig(patch = {}) {
      if (typeof patch.householdKey !== 'string') return store.setSyncConfig(patch);
      const { householdKey, ...rest } = patch;
      return householdKey.trim() ? set(householdKey.trim(), rest) : remove(rest);
    },

    /** The engine's replaceWithRemote (join with "Use the household's data"): key placed as in set(). */
    async replaceWithRemote(ops, cursor, cfg = {}) {
      const { householdKey = '', ...rest } = cfg;
      return placeKey(householdKey, tagged((fields) => store.replaceWithRemote(ops, cursor, { ...rest, ...fields })));
    },

    /** A summary without the key, for screens: { paired, enabled, wasPaired, keyUnavailable, kind, keyLocation }. */
    async status() {
      const c = await store.getSyncConfig();
      let keyUnavailable = false;
      if (identity(c)) { try { await get(c); } catch { keyUnavailable = true; } }
      return { paired: Boolean(identity(c)), enabled: c.enabled, wasPaired: c.wasPaired, keyUnavailable, kind, keyLocation: c.keyLocation, relayUrl: c.relayUrl };
    },
  };
}
