// Mixed-version sync harness, Node only. A household of devices, each running the frozen 1.19.0
// modules (tests/legacy-1.19.0/, "legacy"), the frozen 1.25.1 ones (tests/legacy-1.25.1/,
// "legacy125": the last version before payment cards) or the current js/ ("current"). Each device has
// its own store, outbox, clock and HLC state, and the real sync engine of its version
// (createSyncEngine). They sync through an in-memory relay built on the relay's own room logic
// (relay/src/room-logic.js), the protocol tests/sync-engine.node.test.js uses. Nothing here
// changes what a version does: the store adapter is the one the sync-engine tests use, built from
// the version's own pure storage functions.
//
// Where the app's code needs IndexedDB or the DOM, the harness runs the same steps with that
// version's pure functions. Each such place names the code it follows, and
// tests/mixed-version.scenarios.js checks that the current js/ still contains those lines, so a
// later change there can't leave the harness out of date unnoticed:
//   save / remove   storage.save / storage.remove on the records store (commit + putRecord / deleteRecord)
//   choose          storage.saveSettings with shared settings (settingsOps)
//   exportBackup    storage.exportAll + app.js exportData (sorted by name, w keys left out); where
//                   the version has exportBackupFrom (format 5), that pure function itself
//   importBackup    storage.importAll with shared settings: importChange where the version has it
//                   (format 5), else importOps + settingsOps as 1.19.0's importAll
//   formSave        app.js openForm, then readForm + mergeFormEdit (run from the version's app.js
//                   source, with a stand-in form that behaves like the 1.19.0 page) + save
//   turnOff         the Sync sheet's Turn off sync on this device (engine.disconnect)
//   erase           app.js bindErase + js/erase.js (1.28.0): refused while the device can sync
//                   (eraseBlock), engine.stop, storage.eraseDatabase (the whole store goes, no op is
//                   made), then the fresh first launch the reload brings: a new device id, a new engine,
//                   and format 5's step queuing only this device's version note (migrateFormat's
//                   versionNoteOps). relaunch: a later launch's refreshVersionNote.
//
// Envelopes: crypto 'plain' (the default) seals an op as base64 JSON with the same envelope shape
// ({ id, wall, c }) and runs the same checks crypto.open does after decrypting (a valid op, same
// id, same wall). So relay entries can be read in tests, and ops the crypto layer refuses can be
// injected. crypto 'real' uses each version's own crypto.js (AES-GCM) with the household key.
//
// What a device reports (device.report()): live items, the settings record, tombstones, cursor,
// outbox, clock, the ops its storage SKIPPED (refused by its validators: never stored, the cursor
// moves past them) and the envelopes its crypto layer REFUSED (counted as "could not be
// verified": also never stored).

import { readFileSync } from 'node:fs';
import { RoomCore, memoryStore } from '../../relay/src/room-logic.js';
// The current sheet's Category drop-down helpers (1.25.0); 1.19.0's sheet doesn't use them.
import { resolveNewGroup, NEW_GROUP } from '../../js/category-select.js';
import { CATEGORY_MAX } from '../../js/import-ai.js';
import * as cardsLib from '../../js/cards.js';
import { nextCardColour, cardNameError } from '../../js/cards-ui.js';
import { eraseBlock } from '../../js/erase.js';
import { FORMAT } from '../../js/format-migration.js';

export const RELAY_URL = 'https://relay.example';

export const VERSIONS = Object.freeze({
  legacy: { label: '1.19.0', dir: new URL('../legacy-1.19.0/', import.meta.url) },
  // The last version before payment cards (tests/legacy-1.25.1/README.md).
  legacy125: { label: '1.25.1', dir: new URL('../legacy-1.25.1/', import.meta.url) },
  current: { label: 'current', dir: new URL('../../js/', import.meta.url) },
});

const loaded = new Map();

/** The modules of one version: { storage, engine, core, crypto, util, insights, services, i18n, walletMath, appSource }. */
export function loadVersion(version) {
  const v = VERSIONS[version];
  if (!v) throw new Error(`Unknown version "${version}"`);
  if (!loaded.has(version)) {
    loaded.set(version, (async () => {
      const at = (f) => import(new URL(f, v.dir).href);
      const [storage, engine, core, crypto, util, insights, services, i18n, walletMath] = await Promise.all([
        at('storage.js'), at('sync.js'), at('sync-core.js'), at('crypto.js'), at('util.js'), at('insights-calc.js'),
        at('services.js'), at('i18n.js'), at('wallet-math.js'),
      ]);
      const appSource = readFileSync(new URL('app.js', v.dir), 'utf8').replace(/\r\n/g, '\n');
      const groupSlots = await at('group-slots.js').catch(() => null); // shared slots: not in 1.19.0
      const categorySelect = await at('category-select.js').catch(() => null); // the Category drop-down: 1.25.0 on
      return { version, label: v.label, storage, engine, core, crypto, util, insights, services, i18n, walletMath, groupSlots, categorySelect, appSource };
    })());
  }
  return loaded.get(version);
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A plain envelope for an op (or any value, to inject something malformed). */
export function plainEnvelope(op, { id = op?.id, wall } = {}) {
  const m = typeof op?.t === 'string' ? /^(\d{15})-/.exec(op.t) : null;
  return { id: String(id ?? 'no-id'), wall: wall ?? (m ? Number(m[1]) : 0), c: b64(JSON.stringify(op)) };
}

function plainCrypto(mod, onRefused) {
  return {
    deriveKeys: (keyText) => mod.crypto.deriveKeys(keyText),
    async seal(_key, op) {
      if (!mod.core.isOp(op)) throw new Error('Only valid ops can be sealed.');
      return plainEnvelope(op);
    },
    async open(_key, e) {
      let op;
      try { op = JSON.parse(unb64(e.c)); } catch { op = undefined; }
      // The checks crypto.open makes once the text is decrypted.
      const ok = op && mod.core.isOp(op) && op.id === e.id && mod.core.parseStamp(op.t).wall === e.wall;
      if (!ok) { onRefused({ envelope: e, op }); throw new Error('Envelope failed authentication.'); }
      return op;
    },
  };
}

function realCrypto(mod, onRefused) {
  return {
    deriveKeys: (keyText) => mod.crypto.deriveKeys(keyText),
    seal: (key, op) => mod.crypto.seal(key, op),
    async open(key, e) {
      try { return await mod.crypto.open(key, e); } catch (err) { onRefused({ envelope: e }); throw err; }
    },
  };
}

/** Timers that never fire by themselves: the tests drive every sync with device.sync(). */
function idleTimers() {
  let n = 0;
  return { setTimeout: () => ++n, clearTimeout() {}, setInterval: () => ++n, clearInterval() {} };
}

/**
 * A household: one relay room, one key, any number of devices.
 * Options: crypto 'plain' | 'real'; relayNow () => ms (the relay's clock, for the 24-hour cap).
 */
export async function createHousehold({ crypto = 'plain', relayNow = () => Date.now() } = {}) {
  const current = await loadVersion('current');
  const key = current.crypto.generateKey();
  const keys = await current.crypto.deriveKeys(key);
  const rooms = new Map();
  const roomOf = (id) => {
    if (!rooms.has(id)) rooms.set(id, new RoomCore(memoryStore(), { now: relayNow, limits: { rateCapacity: 1e9 } }));
    return rooms.get(id);
  };
  const calls = [];
  const unwrap = (r, RelayHttpError) => {
    if (r.status !== 200) throw new RelayHttpError(r.status, r.body.error, r.body.message, Number(r.headers?.['Retry-After']) * 1000 || undefined);
    return clone(r.body);
  };

  const household = {
    key, crypto, calls, devices: [],
    /** The relay's entries in order, with the op each one carries (null if it can't be read). */
    async entries() {
      const room = rooms.get(keys.roomId);
      if (!room) return [];
      const all = [];
      for (let after = 0; ;) { // the relay returns at most 500 per pull
        const res = await room.pull({ token: keys.token, after: String(after), limit: '500' });
        all.push(...res.body.entries);
        if (!res.body.entries.length || all.length >= res.body.head) break;
        after = all[all.length - 1].seq;
      }
      const out = [];
      for (const e of all) {
        let op = null;
        try { op = crypto === 'real' ? await current.crypto.open(keys.aesKey, e) : JSON.parse(unb64(e.c)); } catch { /* unreadable */ }
        out.push({ seq: e.seq, id: e.id, wall: e.wall, op });
      }
      return out;
    },
    async head() { return rooms.get(keys.roomId)?.store.head() ?? 0; },

    /**
     * Push envelopes straight into the room, as a device we don't model would (a newer version,
     * or a buggy client). `items` are ops (sealed as plain envelopes, or with this household's key
     * when crypto is 'real') or { envelope } for a hand-made, possibly malformed one.
     */
    async inject(items) {
      const envelopes = [];
      for (const x of items) {
        if (x && x.envelope) envelopes.push(x.envelope);
        else envelopes.push(crypto === 'real' ? await current.crypto.seal(keys.aesKey, x) : plainEnvelope(x));
      }
      const r = await roomOf(keys.roomId).push({ token: keys.token, bodyText: JSON.stringify({ envelopes }) });
      if (r.status !== 200) throw new Error(`inject: relay answered ${r.status} ${r.body?.error}`);
      return r.body;
    },

    /**
     * A writer for a device we don't model (say, a future version): it makes ops with its own clock
     * and real stamps, and pushes them with inject(). Nothing checks the values.
     */
    writer(dev, { now = () => Date.now() } = {}) {
      let clock = current.core.newClock(dev);
      let n = 0;
      const op = (rec, f, v) => {
        const r = current.core.tick(clock, now());
        clock = r.clock;
        return { id: `${dev}-op-${++n}`, rec, f, v: clone(v), t: r.stamp, dev };
      };
      return {
        op,
        /** One op per field, all with one stamp (as one local change makes them), plus del: false when `create`. */
        fields(rec, fields, { create = false } = {}) {
          const r = current.core.tick(clock, now());
          clock = r.clock;
          const all = create ? { ...fields, del: false } : fields;
          return Object.entries(all).map(([f, v]) => ({ id: `${dev}-op-${++n}`, rec, f, v: clone(v), t: r.stamp, dev }));
        },
        push: (ops) => household.inject(ops),
      };
    },

    /**
     * Add a device. Options: version 'legacy' | 'legacy125' | 'current'; now () => ms, or skewMs on top of real
     * time; joined (default true): already in the household; otherwise call device.join(mode).
     */
    async device(name, opts = {}) {
      const d = await makeDevice(household, name, opts, { roomOf, unwrap, calls });
      household.devices.push(d);
      return d;
    },

    /** Sync every device in turn, `rounds` times (2 lets every device see every other's changes). */
    async syncAll(rounds = 2) {
      for (let i = 0; i < rounds; i++) for (const d of household.devices) await d.sync();
    },
  };
  return household;
}

async function makeDevice(household, name, opts, { roomOf, unwrap, calls }) {
  const { version = 'current', skewMs = 0, joined = true } = opts;
  const mod = await loadVersion(version);
  const { storage, core } = mod;
  const SETTINGS_ID = storage.SETTINGS_ID;
  const now = opts.now ?? (() => Date.now() + skewMs);

  const s = {
    clock: core.newClock(name), records: new Map(), outbox: new Map(), cursor: 0, last: null, listener: () => {},
    config: joined ? { relayUrl: RELAY_URL, householdKey: household.key, enabled: true } : { relayUrl: RELAY_URL, householdKey: '', enabled: false },
    local: {}, // this device's own settings store rows (autoGroupColors, autoCurrency): never synced
    made: [], skipped: [], refused: [], received: [],
  };
  const k = (rec, f) => `${rec}\u0000${f}`;
  const enqueue = (ops) => {
    for (const op of ops) { s.outbox.set(k(op.rec, op.f), op); s.made.push(clone(op)); }
    if (ops.length) s.listener(ops.length);
  };

  /** Which ops this version's storage refuses: each is tried alone on an empty replica. */
  const refusedByStorage = (op) => storage.applyRemoteOps({ clock: core.newClock('probe'), records: new Map() }, [op], now()).skipped === 1;

  // The storage adapter of tests/sync-engine.node.test.js, with this version's pure functions.
  const store = {
    async getConfig() { return { ...s.config }; },
    async setConfig(p) {
      const next = { ...s.config, ...p };
      if (next.householdKey !== s.config.householdKey) {
        s.cursor = 0;
        if (next.householdKey) for (const op of storage.requeueOps([...s.records.values()])) s.outbox.set(k(op.rec, op.f), op);
      }
      s.config = next;
      return next;
    },
    async requeueAll() { for (const op of storage.requeueOps([...s.records.values()])) s.outbox.set(k(op.rec, op.f), op); s.cursor = 0; },
    async pendingOps(n) { return [...s.outbox.values()].sort((a, b) => core.compare(a.t, b.t)).slice(0, n).map((o) => ({ ...o })); },
    async pendingCount() { return s.outbox.size; },
    async removeSentOps(sent) {
      let removed = 0;
      for (const x of sent) if (s.outbox.get(k(x.rec, x.f))?.t === x.t) { s.outbox.delete(k(x.rec, x.f)); removed++; }
      return removed;
    },
    async getCursor() { return s.cursor; },
    async applyRemote(ops, cursor) {
      // All or nothing, like the IndexedDB transaction: work on copies, then commit.
      const replica = { clock: { ...s.clock }, records: new Map(s.records) };
      const out = storage.applyRemoteOps(replica, ops, now());
      for (const op of ops) {
        s.received.push(clone(op));
        if (refusedByStorage(op)) s.skipped.push({ op: clone(op), cursor });
      }
      s.clock = replica.clock;
      s.records = replica.records;
      s.cursor = cursor;
      return out;
    },
    async replaceWithRemote(ops, cursor, cfg) {
      const replica = { clock: { ...s.clock }, records: new Map() };
      const out = storage.applyRemoteOps(replica, ops, now());
      for (const op of ops) { s.received.push(clone(op)); if (refusedByStorage(op)) s.skipped.push({ op: clone(op), cursor }); }
      s.clock = replica.clock;
      s.records = replica.records;
      s.outbox.clear();
      s.cursor = cursor;
      s.config = { ...s.config, ...cfg };
      return { records: replica.records.size, changed: out.changed, skipped: out.skipped };
    },
    async liveItemCount() { return [...s.records.values()].filter((r) => r.id !== SETTINGS_ID).map(storage.toItem).filter(Boolean).length; },
    async getLastSynced() { return s.last; },
    async setLastSynced(ms) { s.last = ms; },
    onChangesEnqueued(fn) { s.listener = fn; },
  };

  const net = { up: true };
  const env = {
    online: true, isVisible: () => true, isOnline() { return this.online; },
    onVisibility() {}, onOnline() {}, onOffline() {},
  };
  const { RelayHttpError } = mod.engine;
  const transport = {
    async push(base, room, token, envelopes) {
      calls.push({ device: name, action: 'push', count: envelopes.length });
      if (!net.up) throw new TypeError('fetch failed');
      return unwrap(await roomOf(room).push({ token, bodyText: JSON.stringify({ envelopes }) }), RelayHttpError);
    },
    async pull(base, room, token, after, limit) {
      calls.push({ device: name, action: 'pull', after });
      if (!net.up) throw new TypeError('fetch failed');
      return unwrap(await roomOf(room).pull({ token, after: String(after), limit: String(limit) }), RelayHttpError);
    },
    live(base, room, token, client, { onClose }) { return { close() { onClose(); } }; },
  };
  const onRefused = (x) => s.refused.push(clone(x));
  const codec = household.crypto === 'real' ? realCrypto(mod, onRefused) : plainCrypto(mod, onRefused);
  const warnings = [];
  // A new engine on each launch: the first, and the one after an erase (the app's reload makes a new one).
  let launches = 0;
  const newEngine = () => mod.engine.createSyncEngine({
    store, transport, crypto: codec, env, timers: idleTimers(), now, random: () => 0.5,
    log: { warn: (m) => warnings.push(String(m)), error: (e) => warnings.push(String(e?.stack ?? e)) },
    clientId: `client-${name}${launches++ ? `-${launches}` : ''}`,
  });
  let engine = newEngine();
  await engine.start();
  let deviceId = name; // the device id in this device's stamps (s.clock.dev); a new one after an erase

  /** One local change, as storage's commit() makes it: ops applied to the replica and queued. */
  const local = (fn) => {
    const r = { clock: s.clock, records: s.records };
    const ops = fn(r);
    s.clock = r.clock;
    enqueue(ops);
    return ops;
  };
  /** storage.js itemFields(): the ITEM_FIELDS the item has, in order. */
  const itemFields = (item) => Object.fromEntries(storage.ITEM_FIELDS.filter((f) => item[f] !== undefined).map((f) => [f, item[f]]));

  const items = () => [...s.records.values()].filter((r) => r.id !== SETTINGS_ID).map(storage.toItem).filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
  const settings = () => storage.effectiveSettings(s.local, s.records.get(SETTINGS_ID));

  const device = {
    name, version, label: mod.label, mod, s, warnings, store, now,
    get engine() { return engine; },
    get deviceId() { return deviceId; },

    sync: () => engine.syncNow(),
    /** Settings → Sync → Turn off sync on this device: engine.disconnect (the key goes, the data stays). */
    turnOff: () => engine.disconnect(),
    /**
     * Settings → This device → Erase data on this device, then the reload's fresh first launch.
     * Refused (throws, nothing changes) while this device can sync, as js/erase.js eraseBlock refuses
     * it. Otherwise: the engine stops; everything stored goes at once, as storage.eraseDatabase
     * deletes the database (no record written, no op made, nothing pushed); the app opens again as a
     * new install: new device id, new clock, empty outbox, cursor 0, no key, a new engine, and format
     * 5's first-launch step queues this device's version note (migrateFormat's versionNoteOps), which
     * waits in the outbox with no key to send it. Current version only. Returns the new device id.
     */
    async erase({ appVersion = '1.28.0' } = {}) {
      if (version !== 'current') throw new Error(`${mod.label} has no erase`);
      const status = { paired: Boolean(s.config.householdKey), enabled: Boolean(s.config.enabled), keyUnavailable: false };
      if (eraseBlock({ syncAvailable: true, status })) throw new Error('Erase refused: this device can sync');
      engine.stop();
      // The database is deleted whole; preferences and the key go too.
      deviceId = `${name}-new${launches}`;
      s.clock = core.newClock(deviceId);
      s.records = new Map();
      s.outbox = new Map();
      s.cursor = 0;
      s.last = null;
      s.local = {};
      s.config = { relayUrl: '', householdKey: '', enabled: false };
      // The reload: a fresh first launch.
      engine = newEngine();
      await engine.start();
      device.relaunch({ appVersion });
      return deviceId;
    },
    /** A launch's version note (migrateFormat on the first, refreshVersionNote later): queued only when due. */
    relaunch({ appVersion = '1.28.0' } = {}) {
      if (version !== 'current') throw new Error(`${mod.label}: relaunch follows the current storage only`);
      return local((r) => storage.versionNoteOps(r, { deviceId, version: appVersion, fmt: FORMAT, now: now() }));
    },
    offline() { net.up = false; env.online = false; },
    online() { net.up = true; env.online = true; },
    /** Join the household (a device made with joined: false): 'replace' or 'merge', as the Join screen does. */
    join: (mode) => engine.joinHousehold(household.key, mode),

    /** storage.save on the records store: only ITEM_FIELDS, only fields that changed. */
    save(item) {
      if (!core.isRecordId(item?.id)) throw new Error('Storage: an item needs an id.');
      if (item.id === SETTINGS_ID) throw new Error('Storage: that item id is reserved.');
      return local((r) => core.putRecord(r, item.id, itemFields(item), { now: now() }));
    },
    /** storage.remove: a tombstone. */
    remove: (id) => local((r) => core.deleteRecord(r, id, { now: now() })),
    /** storage.saveSettings with shared settings: { defaultCurrency?, groupColors? } as ops. */
    choose: (change, opts2 = {}) => local((r) => storage.settingsOps(r, change, { ...opts2, now: now() })),
    /** This device's own picks (storage.saveLocalDefaults with shared settings): never synced. */
    setLocal(rows) {
      for (const [key, value] of Object.entries(rows)) {
        s.local[key] = key === 'autoGroupColors' ? { ...(s.local[key] ?? {}), ...value } : value;
      }
    },
    /**
     * Fields written as a newer version would write them: any field names and values, on an item
     * (putRecord: creates it or brings it back) or on the settings record (setFields, never del).
     */
    writeFields: (rec, fields) => local((r) => (rec === SETTINGS_ID
      ? core.setFields(r, rec, fields, { now: now() })
      : core.putRecord(r, rec, fields, { now: now() }))),
    /**
     * storage.saveCard (1.26.0 on): write card `id` ({ name, … }) or, with `card` null, delete it, as
     * setFields ops on the settings record. Versions without cards throw.
     */
    saveCard(id, card) {
      if (!storage.cardOps) throw new Error(`${mod.label} has no cards`);
      // 1.27.0's saveCard keeps keys a later version added (cardOps keepUnknown); 1.26.0 had no option.
      const keep = storage.deleteCardOps ? { keepUnknown: true } : {};
      return local((r) => (card === null ? storage.removeCardOps(r, id, { now: now() }) : storage.cardOps(r, id, card, { ...keep, now: now() })));
    },
    /** storage.saveItemWithCard (1.27.0 on): a new card and the item in one commit. */
    saveItemWithCard(item, cardId, card) {
      if (!storage.deleteCardOps) throw new Error(`${mod.label} has no cards UI`);
      return local((r) => [...storage.cardOps(r, cardId, card, { keepUnknown: true, now: now() }), ...core.putRecord(r, item.id, itemFields(item), { now: now() })]);
    },
    /** storage.deleteCard (1.27.0 on): the tombstone and pay '' on every live item with that card, in one commit. */
    deleteCard(id) {
      if (!storage.deleteCardOps) throw new Error(`${mod.label} has no cards UI`);
      let cleared = [];
      const ops = local((r) => { const out = storage.deleteCardOps(r, id, { now: now() }); cleared = out.cleared; return out.ops; });
      return { ops, cleared };
    },
    /** Apply ops as if pulled, in exactly this order, moving the cursor to `cursor` (default: unchanged). */
    deliver: (ops, { cursor = s.cursor } = {}) => store.applyRemote(clone(ops), cursor),

    items,
    item: (id) => items().find((x) => x.id === id) ?? null,
    record: (id) => clone(s.records.get(id) ?? null),
    settingsRecord: () => clone(s.records.get(SETTINGS_ID) ?? null),
    settings,
    tombstones: () => [...s.records.values()].filter((r) => r.fields?.[core.DELETED] === true).map((r) => r.id).sort(),
    report() {
      return {
        version: mod.label, items: items(), settingsRecord: device.settingsRecord(), tombstones: device.tombstones(),
        cursor: s.cursor, outbox: [...s.outbox.values()].map(clone), clock: { ...s.clock },
        skipped: s.skipped.map(clone), refused: s.refused.map(clone), status: engine.getStatus(),
      };
    },

    /** storage.exportAll, then app.js exportData: items sorted by name, automatic Wallet colours left out. */
    exportBackup(exportedAt = new Date(now()).toISOString()) {
      const all = settings();
      let payload;
      if (storage.exportBackupFrom) {
        // A version with format 5 has the whole export as a pure function: use it as it is.
        ({ payload } = storage.exportBackupFrom(items(), all, exportedAt));
        device.lastExport = storage.exportBackupFrom(items(), all, exportedAt);
      } else {
        // 1.19.0's exportAll, step by step.
        const full = items().map((x) => ({ ...x, type: x.type === 'income' ? 'income' : 'expense', date: x.date ?? '', emoji: x.emoji ?? '' }));
        const kept = Object.fromEntries(storage.BACKUP_SETTINGS.filter((key) => all[key] !== undefined).map((key) => [key, all[key]]));
        payload = { app: storage.APP_ID, schemaVersion: storage.SCHEMA_VERSION, exportedAt, items: full, settings: kept };
      }
      payload.items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      const colours = payload.settings?.groupColors;
      if (storage.exportBackupFrom) {
        // The current app.js exportData: only the colours someone picked (the ones in the settings
        // record), old g ones and slot ones alike, never this device's automatic picks.
        const picked = new Set(Object.keys(storage.settingsFromRecord(s.records.get(SETTINGS_ID)).groupColors));
        if (colours) payload.settings.groupColors = Object.fromEntries(Object.entries(colours).filter(([k]) => picked.has(k)));
        const slots = payload.settings?.groupSlots;
        if (slots) payload.settings.groupSlots = Object.fromEntries(Object.entries(slots).filter(([k]) => picked.has(k)));
      } else if (colours) {
        // 1.19.0's exportData: every w key left out.
        payload.settings.groupColors = Object.fromEntries(Object.entries(colours).filter(([, v]) => !mod.walletMath.isWalletKey(v)));
      }
      return JSON.stringify(payload, null, 2);
    },
    /**
     * The slot step of app.js ensureGroupColors (js/group-slots.js), on this device's items and
     * record: a shared slot for each live group without a colour, and the household's repair.
     * Versions without shared slots (1.19.0) do nothing. Returns the writes [{ name, slot }].
     */
    ensureSlots() {
      const gs = mod.groupSlots;
      if (!gs) return [];
      const names = [...new Set(items().filter((x) => x.type !== 'income').map(mod.insights.groupOf))].sort(mod.insights.byGroupName);
      const rec = device.settingsRecord() ?? { fields: {}, ts: {} };
      const { shared, picks } = gs.slotsFromRecord(rec);
      const map = settings().groupColors;
      const held = new Map();
      for (const n of names) {
        if (shared.has(n)) continue;
        if (picks.has(n)) held.set(n, null);
        else if (mod.walletMath.isWalletKey(map[n])) held.set(n, Number(map[n].slice(1)) - 1);
      }
      const plan = gs.planSlots({ live: names, shared: new Map([...shared].filter(([n]) => names.includes(n))), held });
      const writes = [...plan.assign, ...plan.moves];
      if (writes.length) local((r) => core.setFields(r, SETTINGS_ID, gs.slotFields(writes), { now: now() }));
      return writes;
    },
    /** storage.importAll(json, mode) with shared settings: throws ImportError for a bad file. Returns the summary. */
    importBackup(json, mode) {
      if (mode !== 'merge' && mode !== 'replace') throw new Error(`Unknown import mode: ${mode}`);
      const plan = storage.planFromBackup(storage.parseBackup(json), items(), settings())[mode];
      const replaceColors = plan.clear && 'groupColors' in plan.settings;
      if (storage.importChange) local((replica) => storage.importChange(replica, plan, { now: now() })); // format 5: the pure function
      else local((replica) => [...storage.importOps(replica, plan, { now: now() }), ...storage.settingsOps(replica, plan.settings, { replaceColors, now: now() })]);
      if (replaceColors) s.local.autoGroupColors = {};
      return plan.summary;
    },

    /**
     * Edit an item in this version's item sheet and press Save: openForm(item), set the fields in
     * `edits` as a person would (the stand-in inputs sanitise like the page's: a date input keeps
     * only a real YYYY-MM-DD, a number input only a number, a radio group only one of its values),
     * then readForm, mergeFormEdit and save. `id` null opens an empty sheet (type 'expense' or
     * 'income'). Returns { saved: the item saved or null, errors: { field: message }, ops }.
     */
    formSave(id, edits = {}, { type = 'expense' } = {}) {
      const sub = id === null ? null : items().find((x) => x.id === id);
      if (id !== null && !sub) throw new Error(`No item ${id}`);
      const f = itemForm(mod, { subs: items(), defaultCurrency: settings().defaultCurrency ?? 'TWD', settingsRecord: device.settingsRecord() });
      f.open(sub, type);
      for (const [field, v] of Object.entries(edits)) f.set(field, v);
      const fromForm = f.read();
      if (!fromForm) return { saved: null, errors: f.errors(), ops: [] };
      // 1.27.0's submit: a new card readForm described goes in one commit with the item.
      const newCard = fromForm.newCard ?? null;
      delete fromForm.newCard;
      const merged = f.merge(fromForm);
      const ops = newCard ? device.saveItemWithCard(merged, newCard.id, newCard.card) : device.save(merged);
      return { saved: merged, errors: f.errors(), ops, newCard };
    },
  };
  return device;
}

/* -------------------------------------------------------------------------- The item sheet */

/** The top-level function `header` ... `\n}\n` from app.js source. */
function topLevel(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error(`app.js: "${header}" not found`);
  const end = src.indexOf('\n}\n', i);
  if (end < 0) throw new Error(`app.js: end of "${header}" not found`);
  return src.slice(i, end + 2);
}

const realDay = (v) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** A stand-in for the page's item form (index.html at 1.19.0), with the browser's value rules. */
function standInForm() {
  const attrs = () => ({ attrs: {}, setAttribute(a, v) { this.attrs[a] = v; }, removeAttribute(a) { delete this.attrs[a]; }, focus() {} });
  const text = () => ({ ...attrs(), value: '', reset() { this.value = ''; } });
  // <input type="date">: a value that isn't a valid date string becomes ''.
  const date = () => { let v = ''; return { ...attrs(), get value() { return v; }, set value(x) { const s = String(x ?? ''); v = realDay(s) ? s : ''; }, reset() { v = ''; } }; };
  // <input type="number">: a value that isn't a valid floating-point number becomes ''.
  const number = () => { let v = ''; return { ...attrs(), get value() { return v; }, set value(x) { const s = String(x ?? ''); v = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s) ? s : ''; }, reset() { v = ''; } }; };
  // A radio group (RadioNodeList): setting a value no radio has changes nothing; reset checks the default.
  const radios = (values, def) => {
    let checked = def;
    return { ...attrs(), values, get value() { return checked ?? ''; }, set value(x) { if (values.includes(String(x))) checked = String(x); }, reset() { checked = def; } };
  };
  const elements = {
    kind: radios(['expense', 'income'], 'expense'), name: text(), domain: text(), emoji: text(), plan: text(),
    price: number(), currency: text(), cycle: radios(['monthly', 'annual', 'once'], 'monthly'),
    nextRenewal: date(), date: date(), category: text(), notes: text(),
    newGroup: text(), // 1.25.0: the name field under Category's "New group…"
    // 1.27.0: Payment method (a select whose value a person's pick marks as touched, as its change
    // event does on the page) and the nickname field under its "Add new card…".
    pay: (() => { let v = ''; return { ...attrs(), dataset: { touched: '' }, get value() { return v; }, set value(x) { v = String(x ?? ''); this.dataset.touched = '1'; }, reset() { v = ''; this.dataset.touched = ''; }, quiet(x) { v = String(x ?? ''); this.dataset.touched = ''; } }; })(),
    newCard: text(),
  };
  return { elements, reset() { for (const e of Object.values(elements)) e.reset(); }, querySelector: () => null };
}

/** The version's item-sheet functions, run from its app.js source against the stand-in form. */
function itemForm(mod, { subs, defaultCurrency, settingsRecord = null }) {
  const src = mod.appSource;
  const isDayLine = /^const isDay = .*$/m.exec(src)?.[0];
  if (!isDayLine) throw new Error('app.js: isDay not found');
  // Since 1.21.1 the sheet folds its optional fields under More details (MORE_FIELDS, setMoreDetails)
  // and focuses Name only when a hardware keyboard is likely (keyboardLikely). 1.19.0 has none of them.
  const moreLine = /^const MORE_FIELDS = .*$/m.exec(src)?.[0] ?? '';
  const body = [
    'let formBase = null;',
    'const auto = { domain: false, category: false };',
    isDayLine,
    moreLine,
    topLevel(src, 'function openForm('),
    topLevel(src, 'function readForm('),
    topLevel(src, 'function mergeFormEdit('),
    topLevel(src, 'function setError('),
    'return { openForm, readForm, mergeFormEdit };',
  ].join('\n');
  const form = standInForm();
  const errors = {};
  const slot = (field) => ({ set textContent(v) { if (v) errors[field] = v; else delete errors[field]; }, get textContent() { return errors[field] ?? ''; }, scrollIntoView() {} });
  const $ = (sel) => { const m = /data-error-for="([^"]+)"/.exec(sel); return m ? slot(m[1]) : { hidden: false, scrollIntoView() {} }; };
  const state = { subs, settings: { defaultCurrency }, editingId: null, formType: 'expense', settingsRecord, cardsWritable: true };
  const fns = new Function(
    'form', 'state', 't', 'uid', 'cleanDomain', 'firstEmoji', 'isIncome', '$', 'fillCurrencySelect', 'clearErrors',
    'syncFormMode', 'updateFormLogo', 'openDialog', 'dialog', 'matchMedia', 'reportError', 'console',
    'setMoreDetails', 'keyboardLikely',
    // Since 1.25.0 Category is a drop-down (js/category-select.js): the stand-in keeps the edited
    // item's category as its value, as the page's added option does.
    'fillCategorySelect', 'syncNewGroup', 'categoryChoices', 'resolveNewGroup', 'NEW_GROUP', 'CATEGORY_MAX',
    // Since 1.27.0 the sheet has Payment method (js/cards.js): the stand-in select shows the stored
    // pay when it is a live option (Not set otherwise), as the page's fillPaySelect does.
    'fillPaySelect', 'syncNewCard', 'listCards', 'cardNameProblem', 'cardByName', 'newCardId', 'payToSave',
    'PAY_NEW_CARD', 'PAY_NOT_SET', 'PAY_CASH', 'nextCardColour', 'cardNameError', body,
  )(
    form, state, mod.i18n.t, mod.util.uid, mod.services.cleanDomain, mod.util.firstEmoji, mod.util.isIncome, $,
    (select, selected) => { select.value = selected; }, () => { for (const k of Object.keys(errors)) delete errors[k]; },
    () => {}, () => {}, () => {}, { focus() {} }, () => ({ matches: true }), (msg, err) => { throw err ?? new Error(msg); }, console,
    () => {}, () => false,
    (current = '') => { form.elements.category.value = String(current ?? '').trim(); }, () => {}, [],
    mod.categorySelect?.resolveNewGroup ?? resolveNewGroup, mod.categorySelect?.NEW_GROUP ?? NEW_GROUP, CATEGORY_MAX,
    (current = '') => {
      const live = new Set([cardsLib.PAY_NOT_SET, cardsLib.PAY_CASH, ...cardsLib.listCards(settingsRecord).map((c) => c.id)]);
      form.elements.pay.quiet(live.has(current) ? current : cardsLib.PAY_NOT_SET);
    },
    () => {}, cardsLib.listCards, cardsLib.cardNameProblem, cardsLib.cardByName, cardsLib.newCardId, cardsLib.payToSave,
    cardsLib.PAY_NEW_CARD, cardsLib.PAY_NOT_SET, cardsLib.PAY_CASH, nextCardColour, cardNameError,
  );
  return {
    open: (sub, type) => fns.openForm(sub, type),
    set(field, v) { if (!form.elements[field]) throw new Error(`No form field ${field}`); form.elements[field].value = v; },
    read: () => fns.readForm(),
    merge: (fromForm) => fns.mergeFormEdit(fromForm),
    errors: () => ({ ...errors }),
    field: (name) => form.elements[name].value,
  };
}
