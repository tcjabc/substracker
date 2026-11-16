// Node tests for js/sync.js: several simulated devices sync through an in-memory relay built on
// the relay's own room logic, with real encryption. Storage is an in-memory version of
// storage.syncStore built from the same pure functions the app uses. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../js/sync-core.js';
import * as box from '../js/crypto.js';
import { applyRemoteOps, requeueOps, toItem } from '../js/storage.js';
import { createSyncEngine, RelayHttpError, normalizeRelayUrl } from '../js/sync.js';
import { RoomCore, memoryStore } from '../relay/src/room-logic.js';

const RELAY = 'https://relay.example';
const KEY = box.generateKey();

/* ------------------------------------------------------------------ Fakes */

/** The relay: one RoomCore per room. Devices can be cut off; responses can be forced. */
function memoryRelay() {
  const rooms = new Map();
  const sockets = new Set();
  const forced = []; // [{ action, status, retryAfter }]
  const roomOf = (id) => {
    if (!rooms.has(id)) rooms.set(id, { store: memoryStore(), core: null });
    const r = rooms.get(id);
    r.core ??= new RoomCore(r.store, { limits: { rateCapacity: 1e9 } });
    return r;
  };
  const relay = {
    rooms, forced, calls: [],
    wipe() { rooms.clear(); },
    /** A transport as seen from one device; `net.up` false makes requests fail like fetch does offline. */
    transport(net, hooks = {}) {
      const check = (action) => {
        relay.calls.push(action);
        if (!net.up) throw new TypeError('fetch failed');
        const i = forced.findIndex((f) => f.action === action);
        if (i >= 0) {
          const [f] = forced.splice(i, 1);
          throw new RelayHttpError(f.status, f.code ?? 'forced', 'forced', f.retryAfter ? f.retryAfter * 1000 : undefined);
        }
      };
      const unwrap = (r) => {
        if (r.status !== 200) throw new RelayHttpError(r.status, r.body.error, r.body.message, r.headers?.['Retry-After'] * 1000 || undefined);
        return JSON.parse(JSON.stringify(r.body));
      };
      return {
        async push(base, room, token, envelopes, client) {
          check('push');
          await hooks.beforePush?.();
          const res = unwrap(await roomOf(room).core.push({ token, bodyText: JSON.stringify({ envelopes }) }));
          if (res.accepted) for (const s of sockets) if (s.room === room && s.client !== client) s.onHead(res.head);
          return res;
        },
        async pull(base, room, token, after, limit) {
          check('pull');
          if (!rooms.has(room)) return unwrap({ status: 404, body: { error: 'no_room', message: 'none' } });
          return unwrap(await roomOf(room).core.pull({ token, after: String(after), limit: String(limit) }));
        },
        live(base, room, token, client, { onHead, onClose }) {
          if (!net.up) { onClose(); return { close() {} }; }
          const s = { room, client, onHead, onClose };
          sockets.add(s);
          return { close() { if (sockets.delete(s)) onClose(); } };
        },
      };
    },
    dropSockets() { for (const s of [...sockets]) { sockets.delete(s); s.onClose(); } },
  };
  return relay;
}

/** Timers that only run when the test says so. */
function fakeTimers() {
  let n = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(fn, ms) { const id = ++n; pending.set(id, { fn, ms, repeat: false }); return id; },
    clearTimeout(id) { pending.delete(id); },
    setInterval(fn, ms) { const id = ++n; pending.set(id, { fn, ms, repeat: true }); return id; },
    clearInterval(id) { pending.delete(id); },
    delays: () => [...pending.values()].filter((t) => !t.repeat).map((t) => t.ms),
    /** Run the one-shot timers that are due now (all of them). */
    async fire() {
      const due = [...pending.entries()].filter(([, t]) => !t.repeat);
      for (const [id] of due) pending.delete(id);
      for (const [, t] of due) await t.fn();
    },
    async tickIntervals() { for (const t of [...pending.values()].filter((x) => x.repeat)) await t.fn(); },
  };
}

/**
 * A device: in-memory storage with the same behaviour as storage.syncStore, local edit helpers,
 * its own clock offset, network, timers and engine.
 */
function device(name, relay, { skewMs = 0, hooks, key = KEY } = {}) {
  const net = { up: true };
  const env = {
    visible: true, online: true, listeners: { vis: [], on: [], off: [] },
    isVisible() { return this.visible; }, isOnline() { return this.online; },
    onVisibility(fn) { this.listeners.vis.push(fn); }, onOnline(fn) { this.listeners.on.push(fn); }, onOffline(fn) { this.listeners.off.push(fn); },
  };
  const now = () => Date.now() + skewMs;
  const s = {
    clock: core.newClock(name), records: new Map(), outbox: new Map(), cursor: 0, last: null, listener: () => {},
    config: { relayUrl: RELAY, householdKey: key, enabled: true }, failApply: false, applyCalls: 0,
  };
  const k = (rec, f) => `${rec}\u0000${f}`;
  const enqueue = (ops) => { for (const op of ops) s.outbox.set(k(op.rec, op.f), op); if (ops.length) s.listener(ops.length); };
  const store = {
    async getConfig() { return { ...s.config }; },
    async setConfig(p) {
      const next = { ...s.config, ...p };
      if (next.householdKey !== s.config.householdKey) {
        s.cursor = 0;
        if (next.householdKey) for (const op of requeueOps([...s.records.values()])) s.outbox.set(k(op.rec, op.f), op);
      }
      s.config = next;
      return next;
    },
    async requeueAll() { for (const op of requeueOps([...s.records.values()])) s.outbox.set(k(op.rec, op.f), op); s.cursor = 0; },
    async pendingOps(n) { return [...s.outbox.values()].sort((a, b) => core.compare(a.t, b.t)).slice(0, n).map((o) => ({ ...o })); },
    async pendingCount() { return s.outbox.size; },
    async removeSentOps(sent) {
      let removed = 0;
      for (const x of sent) if (s.outbox.get(k(x.rec, x.f))?.t === x.t) { s.outbox.delete(k(x.rec, x.f)); removed++; }
      return removed;
    },
    async getCursor() { return s.cursor; },
    async applyRemote(ops, cursor) {
      s.applyCalls++;
      // All or nothing, like the IndexedDB transaction: work on copies, then commit.
      const replica = { clock: { ...s.clock }, records: new Map(s.records) };
      const out = applyRemoteOps(replica, ops, now());
      if (s.failApply) throw new Error('disk full');
      s.clock = replica.clock;
      s.records = replica.records;
      s.cursor = cursor;
      return out;
    },
    async getLastSynced() { return s.last; },
    async setLastSynced(ms) { s.last = ms; },
    onChangesEnqueued(fn) { s.listener = fn; },
  };
  const timers = fakeTimers();
  const warnings = [];
  const engine = createSyncEngine({
    store, transport: relay.transport(net, hooks), env, timers, now, random: () => 0.5,
    log: { warn: (m) => warnings.push(m), error: (e) => warnings.push(String(e)) },
    clientId: `client-${name}`,
  });
  const local = (fn) => { const r = { clock: s.clock, records: s.records }; const ops = fn(r); s.clock = r.clock; enqueue(ops); return ops; };
  return {
    name, s, net, env, timers, engine, warnings, store,
    add(id, fields) { return local((r) => core.putRecord(r, id, { ...fields, updatedAt: new Date(now()).toISOString() }, { now: now() })); },
    edit(id, fields) { return local((r) => core.editRecord(r, id, { ...fields, updatedAt: new Date(now()).toISOString() }, { now: now() })); },
    remove(id) { return local((r) => core.deleteRecord(r, id, { now: now() })); },
    items() {
      return [...s.records.values()].map(toItem).filter(Boolean).map(({ updatedAt, ...rest }) => rest).sort((a, b) => a.id.localeCompare(b.id));
    },
    goOffline() { net.up = false; env.online = false; },
    goOnline() { net.up = true; env.online = true; return Promise.all(env.listeners.on.map((fn) => fn())); },
  };
}

const sync = (...devices) => devices.reduce((p, d) => p.then(() => d.engine.syncNow()), Promise.resolve());
const expense = (name, price) => ({ type: 'expense', name, price, currency: 'TWD', cycle: 'monthly', notes: '' });

/* ------------------------------------------------------------------ Tests */

test('an expense added on one device appears on another, and edits and deletes follow', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  const b = device('devB', relay);
  await a.engine.start();
  await b.engine.start();
  a.add('x', expense('Example Streaming', 250));
  await sync(a, b);
  assert.deepEqual(b.items(), a.items());
  assert.equal(b.items()[0].name, 'Example Streaming');
  assert.equal(b.engine.getStatus().state, 'ok');

  b.edit('x', { price: 300 });
  await sync(b, a);
  assert.equal(a.items()[0].price, 300);

  a.remove('x');
  await sync(a, b);
  assert.deepEqual(b.items(), []);
  assert.equal(b.s.records.get('x').fields.del, true, 'tombstone, not removed');
});

test('three devices converge through offline periods and concurrent edits', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  const b = device('devB', relay, { skewMs: -3 * 3600_000 }); // clock 3 h behind
  const c = device('devC', relay, { skewMs: 2 * 3600_000 }); // clock 2 h ahead
  for (const d of [a, b, c]) await d.engine.start();

  a.add('x', expense('Example Streaming', 250));
  a.add('y', expense('Example Cloud', 30));
  await sync(a, b, c);

  c.goOffline();
  b.edit('x', { notes: 'from B' }); // different fields of the same record
  a.edit('x', { price: 260 });
  c.edit('y', { price: 35 }); // made offline
  c.add('z', expense('Example Gym', 900));
  await c.engine.syncNow();
  assert.equal(c.engine.getStatus().state, 'offline');
  await sync(a, b);
  a.remove('y'); // deleted while C still has an edit for it queued
  await sync(a, b);
  await c.goOnline(); // the online event triggers a sync
  await c.engine.idle();
  await sync(a, b, c, a, b);

  for (const d of [b, c]) assert.deepEqual(d.items(), a.items(), `${d.name} converged`);
  const [x, z] = a.items();
  assert.deepEqual([x.id, x.price, x.notes, z.id], ['x', 260, 'from B', 'z']);
  assert.equal(a.items().some((i) => i.id === 'y'), false, 'the delete stands');
  for (const d of [a, b, c]) assert.equal(d.s.outbox.size, 0, `${d.name} sent everything`);
});

test('pulled ops are never queued to send back (no outbox echo)', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  const b = device('devB', relay);
  await a.engine.start();
  await b.engine.start();
  a.add('x', expense('Example', 1));
  await sync(a);
  const pushesBefore = relay.calls.filter((c) => c === 'push').length;
  await sync(b, b);
  assert.equal(b.s.outbox.size, 0);
  assert.equal(relay.calls.filter((c) => c === 'push').length, pushesBefore, 'B pushed nothing');
  const [room] = relay.rooms.values();
  assert.equal(room.store.size, a.s.records.get('x') && Object.keys(a.s.records.get('x').fields).length, 'relay holds only A\'s ops');
});

test('a sent op leaves the outbox only if no newer local edit replaced it meanwhile', async () => {
  const relay = memoryRelay();
  let a;
  let editDuringPush = true;
  a = device('devA', relay, {
    hooks: { beforePush: () => { if (editDuringPush) { editDuringPush = false; a.edit('x', { price: 2 }); } } },
  });
  const b = device('devB', relay);
  await a.engine.start();
  await b.engine.start();
  a.add('x', expense('Example', 1));
  await a.engine.syncNow(); // the edit lands while the first push is in flight
  // The newer price (and updatedAt) stayed pending and went out in the next round of the same sync.
  assert.equal(a.s.outbox.size, 0);
  await sync(b);
  assert.equal(b.items()[0].price, 2, 'the later edit reached B');
});

test('cursor and ops move together: a failed apply changes nothing and is retried', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  const b = device('devB', relay);
  await a.engine.start();
  a.add('x', expense('Example', 1));
  await sync(a);
  b.s.failApply = true;
  await b.engine.start(); // first sync fails while applying
  assert.deepEqual([b.s.cursor, b.items().length], [0, 0], 'nothing applied, cursor not moved');
  assert.equal(b.engine.getStatus().state, 'error');
  assert.equal(b.timers.delays().length, 1, 'a retry is scheduled');
  b.s.failApply = false;
  await b.timers.fire();
  await b.engine.idle();
  assert.deepEqual([b.items().length, b.s.cursor > 0], [1, true]);
});

test('401 stops automatic retries until Sync now; 429 waits for Retry-After; network errors back off', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  await a.engine.start();
  a.add('x', expense('Example', 1));

  relay.forced.push({ action: 'push', status: 401 });
  await a.engine.syncNow();
  let st = a.engine.getStatus();
  assert.equal(st.state, 'error');
  assert.match(st.lastError, /household key/);
  assert.deepEqual(a.timers.delays(), [], 'no automatic retry after 401');
  assert.equal(a.s.outbox.size > 0, true, 'nothing lost');

  relay.forced.push({ action: 'push', status: 429, retryAfter: 7 });
  await a.engine.syncNow();
  assert.match(a.engine.getStatus().lastError, /busy/);
  assert.deepEqual(a.timers.delays(), [7000], 'Retry-After respected');
  await a.timers.fire();
  await a.engine.idle();
  assert.equal(a.engine.getStatus().state, 'ok');
  assert.equal(a.s.outbox.size, 0);

  // Network down while the device thinks it's online: offline status and growing, jittered delays.
  a.net.up = false;
  a.add('y', expense('Example 2', 2));
  const delays = [];
  for (let i = 0; i < 4; i++) {
    if (i === 0) await a.engine.syncNow(); else { await a.timers.fire(); await a.engine.idle(); }
    delays.push(...a.timers.delays());
  }
  assert.equal(a.engine.getStatus().state, 'offline');
  assert.deepEqual(delays, [2000, 4000, 8000, 16000], 'exponential (jitter fixed at ×1 here)');
  a.add('z', expense('Saved offline', 3)); // local saves keep working
  assert.equal(a.s.outbox.size > 0, true);
  a.net.up = true;
  await a.timers.fire();
  await a.engine.idle();
  assert.equal(a.engine.getStatus().state, 'ok');
  assert.equal(a.s.outbox.size, 0);
});

test('jitter keeps retries between half and one and a half times the base delay', async () => {
  const relay = memoryRelay();
  for (const r of [0, 0.999]) {
    const d = device('devJ', relay);
    d.engine.stop();
    const e = createSyncEngine({ store: d.store, transport: relay.transport({ up: false }), env: d.env, timers: d.timers, random: () => r, log: { warn() {}, error() {} } });
    await e.start();
    const [ms] = d.timers.delays();
    assert.equal(ms >= 1000 && ms <= 3000, true, `${ms}`);
  }
});

test('envelopes that fail to decrypt are skipped and counted, never applied', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  const b = device('devB', relay);
  await a.engine.start();
  await b.engine.start();
  a.add('x', expense('Example', 1));
  await sync(a);
  // Someone with the token but not the key slips in garbage.
  const { roomId, token } = await box.deriveKeys(KEY);
  const room = relay.rooms.get(roomId);
  await room.core.push({ token, bodyText: JSON.stringify({ envelopes: [{ id: 'junk', wall: Date.now(), c: Buffer.from('not sealed').toString('base64') }] }) });
  const other = await box.deriveKeys(box.generateKey());
  const wrong = await box.seal(other.aesKey, { id: 'w1', rec: 'x', f: 'price', v: 1e6, t: core.formatStamp(Date.now() + 1000, 0, 'evil'), dev: 'evil' });
  await room.core.push({ token, bodyText: JSON.stringify({ envelopes: [wrong] }) });
  await sync(b);
  assert.equal(b.items()[0].price, 1);
  assert.deepEqual(b.warnings, ['Sync: ignored 2 change(s) that could not be verified.']);
  assert.equal(b.s.cursor, room.store.head(), 'cursor moved past them');
});

test('syncs never overlap: requests during a run are coalesced into one more run', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  await a.engine.start();
  a.add('x', expense('Example', 1));
  relay.calls.length = 0;
  await Promise.all([a.engine.syncNow(), a.engine.syncNow(), a.engine.syncNow(), a.engine.syncNow()]);
  const pulls = relay.calls.filter((c) => c === 'pull').length;
  assert.equal(pulls <= 2, true, `${pulls} pulls for 4 requests`);
});

test('triggers: local change (debounced), live head from another device, visibility and interval', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  const b = device('devB', relay);
  await a.engine.start();
  await b.engine.start();

  a.add('x', expense('Example', 1));
  assert.deepEqual(a.timers.delays(), [1000], 'debounced ~1 s');
  await a.timers.fire();
  await a.engine.idle();
  await b.engine.idle(); // B was told over its live socket and pulled on its own
  assert.equal(b.items().length, 1, 'arrived via the live socket');

  b.env.visible = false;
  b.env.listeners.vis.forEach((fn) => fn(false));
  assert.equal([...b.timers.pending.values()].some((t) => t.repeat), false, 'no interval while hidden');
  a.edit('x', { price: 5 });
  await a.timers.fire();
  await a.engine.idle();
  assert.equal(b.items()[0].price, 1, 'hidden: socket closed, nothing pulled');
  b.env.visible = true;
  await Promise.all(b.env.listeners.vis.map((fn) => fn(true)));
  await b.engine.idle();
  assert.equal(b.items()[0].price, 5, 'pulled when visible again');

  a.edit('x', { price: 6 });
  relay.dropSockets(); // B's socket is gone; the interval still catches up
  await a.engine.syncNow();
  await b.timers.tickIntervals();
  await b.engine.idle();
  assert.equal(b.items()[0].price, 6);
});

test('a relay that lost its data gets everything again', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  await a.engine.start();
  a.add('x', expense('Example', 1));
  await sync(a);
  relay.wipe();
  await sync(a); // pull → 404 with a cursor > 0 → re-queue everything and push again
  const b = device('devB', relay);
  await b.engine.start();
  await b.engine.idle();
  assert.deepEqual(b.items(), a.items());
});

test('changes stamped more than a day ahead stay queued with a clear message, the rest goes through', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay, { skewMs: 3 * 86_400_000 });
  await a.engine.start();
  a.add('x', expense('Example', 1));
  await a.engine.syncNow();
  const st = a.engine.getStatus();
  assert.equal(st.state, 'ok');
  assert.match(st.lastError, /clock/);
  assert.equal(st.pendingCount > 0, true, 'still queued');
});

test('disconnect stops syncing and forgets the key but keeps local data', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  await a.engine.start();
  a.add('x', expense('Example', 1));
  await sync(a);
  await a.engine.disconnect();
  assert.deepEqual([a.s.config.householdKey, a.s.config.enabled, a.engine.getStatus().state], ['', false, 'off']);
  assert.equal(a.items().length, 1);
  relay.calls.length = 0;
  a.edit('x', { price: 2 });
  await a.timers.fire();
  await a.engine.idle();
  assert.deepEqual(relay.calls, [], 'no network after disconnect');
});

test('joining with the key on a device that already has data sends that data too', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  await a.engine.start();
  a.add('x', expense('From A', 1));
  await sync(a);
  const b = device('devB', relay, { key: '' });
  b.s.config.enabled = false;
  await b.engine.start();
  b.add('y', expense('From B before joining', 2));
  b.s.outbox.clear(); // as if those changes had already gone to some other room long ago
  await b.engine.configure({ householdKey: KEY, enabled: true });
  await sync(a);
  assert.deepEqual(a.items().map((i) => i.id), ['x', 'y']);
  assert.deepEqual(b.items(), a.items());
});

test('status updates are emitted and never contain the key or token', async () => {
  const relay = memoryRelay();
  const a = device('devA', relay);
  const seen = [];
  a.engine.onStatus((s) => seen.push(s));
  await a.engine.start();
  relay.forced.push({ action: 'pull', status: 500 });
  await a.engine.syncNow();
  const { token } = await box.deriveKeys(KEY);
  const text = JSON.stringify(seen);
  assert.equal(text.includes(KEY) || text.includes(token), false);
  assert.deepEqual([...new Set(seen.map((s) => s.state))].sort(), ['error', 'ok', 'syncing']);
});

test('relay URLs: HTTPS anywhere, plain HTTP only to this machine', () => {
  assert.equal(normalizeRelayUrl(' https://relay.example.workers.dev/ '), 'https://relay.example.workers.dev');
  assert.equal(normalizeRelayUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeRelayUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
  for (const bad of ['http://relay.example', 'ftp://x', 'not a url', 'https://u:p@relay.example', 'https://relay.example/?t=1', '']) {
    assert.equal(normalizeRelayUrl(bad), null, bad);
  }
});
