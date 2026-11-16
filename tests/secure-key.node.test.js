// Node tests for js/secure-key.js: the household key in phone secure storage (faked here) or in
// IndexedDB (faked with the same pure config rules as js/storage.js). Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyVault, KeyUnavailableError, nativeSecureStore, SECURE_KEY_ID } from '../js/secure-key.js';
import { nextSyncConfig, householdIdentity } from '../js/storage.js';
import { generateKey } from '../js/crypto.js';

/** The IndexedDB side, with the same config rules as storage.js; counts household changes (cursor resets). */
function idb(initial = {}) {
  const f = {
    cfg: nextSyncConfig(initial, {}), resets: 0, failSet: false, failMove: false, failReplace: false,
    async getSyncConfig() { return { ...f.cfg }; },
    async setSyncConfig(p) {
      if (f.failSet) throw new Error('disk full');
      const next = nextSyncConfig(f.cfg, p);
      if (householdIdentity(next) !== householdIdentity(f.cfg)) f.resets++;
      f.cfg = next;
      return next;
    },
    async replaceWithRemote(ops, cursor, p) {
      if (f.failReplace) throw new Error('disk full');
      f.cfg = nextSyncConfig(f.cfg, p);
      return { records: ops.length, changed: 0, skipped: 0 };
    },
    async moveKeyToSecure(key, tag) {
      if (f.failMove) throw new Error('disk full');
      if (f.cfg.keyLocation !== 'idb' || f.cfg.householdKey !== key) return false;
      f.cfg = { ...nextSyncConfig(f.cfg, { keyLocation: 'secure', keyTag: tag }), wasPaired: true };
      return true;
    },
  };
  return f;
}

/** Phone secure storage. Each failure switch makes that call throw (or, for badReadBack, lie). */
function secureStore(value = null) {
  const s = {
    value, sets: 0, failGet: false, failSet: false, failRemove: false, badReadBack: false,
    async get() { if (s.failGet) throw new Error('KeyStore unavailable'); return s.badReadBack ? 'not-the-key' : s.value; },
    async set(v) { if (s.failSet) throw new Error('KeyStore unavailable'); s.sets++; s.value = v; },
    async remove() { if (s.failRemove) throw new Error('KeyStore unavailable'); s.value = null; },
  };
  return s;
}

function quietLog() { const lines = []; return { lines, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }; }

test('web: kind web-indexeddb, the key stays in the IndexedDB config exactly as before', async () => {
  const store = idb();
  const vault = createKeyVault({ store, secure: null });
  assert.equal(vault.kind, 'web-indexeddb');
  assert.equal(await vault.migrate(), 'not-needed');
  const key = generateKey();
  await vault.set(key, { enabled: true });
  assert.deepEqual([store.cfg.householdKey, store.cfg.keyLocation, store.cfg.enabled], [key, 'idb', true]);
  assert.equal(await vault.get(), key);
  assert.equal((await vault.readConfig()).householdKey, key);
  await vault.remove({ enabled: false });
  assert.equal(store.cfg.householdKey, '');
  assert.equal(await vault.get(), '');
});

test('phone: set / get / remove go to secure storage; IndexedDB keeps only a tag', async () => {
  const store = idb();
  const secure = secureStore();
  const vault = createKeyVault({ store, secure });
  assert.equal(vault.kind, 'native-secure');
  const key = generateKey();
  await vault.set(key, { enabled: true });
  assert.equal(secure.value, key);
  assert.equal(store.cfg.householdKey, '', 'not in IndexedDB');
  assert.equal(store.cfg.keyLocation, 'secure');
  assert.match(store.cfg.keyTag, /^[0-9a-f]{32}$/);
  assert.notEqual(store.cfg.keyTag, key);
  assert.equal(await vault.get(), key);
  const cfg = await vault.readConfig();
  assert.deepEqual([cfg.householdKey, cfg.keyUnavailable, cfg.enabled], [key, false, true]);
  const st = await vault.status();
  assert.deepEqual([st.paired, st.keyUnavailable, st.kind], [true, false, 'native-secure']);
  assert.equal(JSON.stringify(st).includes(key), false, 'status never carries the key');

  await vault.remove({ enabled: false });
  assert.equal(secure.value, null, 'removed from secure storage');
  assert.deepEqual([store.cfg.householdKey, store.cfg.keyLocation, store.cfg.keyTag, store.cfg.enabled], ['', 'idb', '', false]);
  assert.equal(store.cfg.wasPaired, true);
});

test('saving the same key again changes nothing (no new tag, no cursor reset)', async () => {
  const store = idb();
  const vault = createKeyVault({ store, secure: secureStore() });
  const key = generateKey();
  await vault.set(key, { enabled: true });
  const tag = store.cfg.keyTag;
  const resets = store.resets;
  await vault.setConfig({ householdKey: key, enabled: true });
  assert.equal(store.cfg.keyTag, tag);
  assert.equal(store.resets, resets);
  await vault.setConfig({ householdKey: generateKey(), enabled: true });
  assert.notEqual(store.cfg.keyTag, tag, 'a different key is a different household');
  assert.equal(store.resets, resets + 1);
});

test('migration: copied, read back, then dropped from IndexedDB; same household, no re-pairing', async () => {
  const key = generateKey();
  const store = idb({ householdKey: key, enabled: true, relayUrl: '' });
  const secure = secureStore();
  const log = quietLog();
  const vault = createKeyVault({ store, secure, log });
  assert.equal(await vault.migrate(), 'migrated');
  assert.equal(vault.migration, 'migrated');
  assert.equal(secure.value, key);
  assert.deepEqual([store.cfg.householdKey, store.cfg.keyLocation, store.cfg.enabled], ['', 'secure', true]);
  assert.equal(store.resets, 0, 'cursor and outbox untouched');
  assert.equal((await vault.readConfig()).householdKey, key, 'sync keeps using the same key');
  assert.equal(log.lines.join(' ').includes(key), false);
});

test('migration flag: the next launch sees keyLocation secure and does nothing', async () => {
  const key = generateKey();
  const store = idb({ householdKey: key, enabled: true });
  const secure = secureStore();
  await createKeyVault({ store, secure }).migrate();
  const sets = secure.sets;
  const again = createKeyVault({ store, secure });
  assert.equal(await again.migrate(), 'already');
  assert.equal(secure.sets, sets, 'not written again');
  assert.equal(await again.get(), key);
});

test('migration with a failed read-back keeps the IndexedDB copy and sync as before; the next launch retries', async () => {
  const key = generateKey();
  const store = idb({ householdKey: key, enabled: true });
  const secure = secureStore();
  secure.badReadBack = true;
  const log = quietLog();
  const vault = createKeyVault({ store, secure, log });
  assert.equal(await vault.migrate(), 'failed');
  assert.deepEqual([store.cfg.householdKey, store.cfg.keyLocation], [key, 'idb'], 'IndexedDB copy kept');
  assert.equal((await vault.readConfig()).householdKey, key, 'sync still works');
  assert.ok(log.lines.length === 1 && !log.lines[0].includes(key), 'one warning, without the key');
  secure.badReadBack = false;
  assert.equal(await createKeyVault({ store, secure }).migrate(), 'migrated');
  assert.equal(store.cfg.householdKey, '');
});

test('migration: a secure write that throws, or a failed IndexedDB update, also keeps the key where it was', async () => {
  const key = generateKey();
  const store = idb({ householdKey: key, enabled: true });
  const secure = secureStore();
  secure.failSet = true;
  assert.equal(await createKeyVault({ store, secure, log: quietLog() }).migrate(), 'failed');
  assert.equal(store.cfg.householdKey, key);
  secure.failSet = false;
  store.failMove = true;
  assert.equal(await createKeyVault({ store, secure, log: quietLog() }).migrate(), 'failed');
  assert.equal(store.cfg.householdKey, key, 'still in IndexedDB (a copy is also in secure storage, harmless)');
  store.failMove = false;
  assert.equal(await createKeyVault({ store, secure }).migrate(), 'migrated');
});

test('never in neither place: every combination of migration failures', async () => {
  const flags = ['failSet', 'failGet', 'badReadBack', 'failMove'];
  for (let mask = 0; mask < 1 << flags.length; mask++) {
    const key = generateKey();
    const store = idb({ householdKey: key, enabled: true });
    const secure = secureStore();
    for (const [i, f] of flags.entries()) if (mask & (1 << i)) (f === 'failMove' ? store : secure)[f] = true;
    await createKeyVault({ store, secure, log: quietLog() }).migrate();
    const where = store.cfg.keyLocation === 'secure' ? secure.value : store.cfg.householdKey;
    assert.equal(where, key, `mask ${mask}: the config points at a place that holds the key`);
  }
});

test('an unreadable secure value (backup restored to a new phone): keyUnavailable, nothing deleted', async () => {
  const store = idb({ keyLocation: 'secure', keyTag: 'a'.repeat(32), enabled: true });
  const secure = secureStore(null); // the Keystore entry doesn't exist on this phone
  const vault = createKeyVault({ store, secure });
  await assert.rejects(vault.get(), KeyUnavailableError);
  const cfg = await vault.readConfig();
  assert.deepEqual([cfg.householdKey, cfg.keyUnavailable, cfg.enabled], ['', true, true]);
  const st = await vault.status();
  assert.deepEqual([st.paired, st.keyUnavailable], [true, true]);
  assert.equal(await vault.migrate(), 'already', 'no migration loop');
  assert.equal(store.cfg.keyLocation, 'secure', 'config left as it was');
  secure.failGet = true; // the OS refusing is handled the same way
  assert.equal((await vault.readConfig()).keyUnavailable, true);
  // Join again with the words: works normally.
  secure.failGet = false;
  const key = generateKey();
  await vault.setConfig({ householdKey: key, enabled: true });
  assert.equal(await vault.get(), key);
  assert.equal((await vault.readConfig()).keyUnavailable, false);
});

test('turn off removes the key from both places; a failed secure removal is cleaned up next launch', async () => {
  const store = idb();
  const secure = secureStore();
  const vault = createKeyVault({ store, secure, log: quietLog() });
  await vault.set(generateKey(), { enabled: true });
  secure.failRemove = true;
  await vault.setConfig({ householdKey: '', enabled: false }); // what engine.disconnect() sends
  assert.equal(store.cfg.keyLocation, 'idb');
  assert.equal(store.cfg.householdKey, '');
  assert.notEqual(secure.value, null, 'removal failed this time');
  assert.equal(await vault.get(), '', 'but the app no longer uses it');
  secure.failRemove = false;
  assert.equal(await createKeyVault({ store, secure }).migrate(), 'cleaned');
  assert.equal(secure.value, null);
});

test('a failed config write puts the previous secure value back', async () => {
  const store = idb();
  const secure = secureStore();
  const vault = createKeyVault({ store, secure });
  const k1 = generateKey();
  await vault.set(k1, { enabled: true });
  const before = { ...store.cfg };
  store.failSet = true;
  await assert.rejects(vault.set(generateKey(), { enabled: true }), /disk full/);
  assert.equal(secure.value, k1, 'slot restored');
  assert.deepEqual(store.cfg, before);
  store.failSet = false;
  // Same for join → replace.
  store.failReplace = true;
  await assert.rejects(vault.replaceWithRemote([], 0, { householdKey: generateKey(), enabled: true }), /disk full/);
  assert.equal(secure.value, k1);
  assert.equal(await vault.get(), k1);
});

test('secure storage refusing a new key: it is kept in IndexedDB so sync works, and moved next launch', async () => {
  const store = idb();
  const secure = secureStore();
  secure.failSet = true;
  const log = quietLog();
  const vault = createKeyVault({ store, secure, log });
  const key = generateKey();
  await vault.replaceWithRemote([], 5, { householdKey: key, enabled: true });
  assert.deepEqual([store.cfg.householdKey, store.cfg.keyLocation], [key, 'idb']);
  assert.equal(await vault.get(), key);
  assert.equal(log.lines.join(' ').includes(key), false);
  secure.failSet = false;
  assert.equal(await createKeyVault({ store, secure }).migrate(), 'migrated');
});

test('the native adapter calls the plugin with a fixed entry name, no iCloud sync, this-device-only access', async () => {
  const calls = [];
  let stored = null;
  const fakePlugin = {
    async internalSetItem(o) { calls.push(['set', o]); stored = o.data; },
    async internalGetItem(o) { calls.push(['get', o]); return { data: stored }; },
    async internalRemoveItem(o) { calls.push(['remove', o]); stored = null; return { success: true }; },
  };
  const s = nativeSecureStore(fakePlugin);
  await s.set('k-value');
  assert.equal(await s.get(), 'k-value');
  await s.remove();
  assert.equal(await s.get(), null, 'a missing entry reads as null');
  assert.deepEqual(calls[0], ['set', { prefixedKey: SECURE_KEY_ID, sync: false, data: 'k-value', access: 1 }]);
  assert.deepEqual(calls[1], ['get', { prefixedKey: SECURE_KEY_ID, sync: false }]);
  assert.equal(nativeSecureStore(null), null, 'web: no adapter');
});
