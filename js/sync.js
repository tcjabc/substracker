// Sync engine: sends this device's outbox to the relay and applies everything other devices sent,
// end-to-end encrypted with the household key. Plain JS with every dependency injected (storage,
// transport, crypto, clock, timers, environment), so Node tests run it against an in-memory relay
// and the browser, Android and iOS builds all run the same code.
//
// It never throws into the UI and never blocks a local save: failures become a status and a retry.
// Nothing here logs keys, tokens or the contents of changes.

import * as box from './crypto.js';

const PULL_LIMIT = 500;
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60_000;
const SOCKET_RETRY_MAX_MS = 60_000;
const PING_MS = 30_000;

/* --------------------------------------------------------------------------
   Relay URL and transport
   -------------------------------------------------------------------------- */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A clean relay base URL, or null. HTTPS only, except plain HTTP to this machine for development,
 * so the token is never sent in the clear over a network.
 */
export function normalizeRelayUrl(text) {
  let u;
  try { u = new URL(String(text ?? '').trim()); } catch { return null; }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** An HTTP error from the relay. `message` is the relay's text, which never contains secrets. */
export class RelayHttpError extends Error {
  constructor(status, code, message, retryAfterMs) {
    super(message || `The relay answered ${status}.`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The relay protocol over fetch and WebSocket. Network failures reject with a TypeError (from fetch). */
export function fetchTransport({ fetch = (...a) => globalThis.fetch(...a), WebSocket = globalThis.WebSocket, timers = globalThis } = {}) {
  const roomUrl = (base, room, action) => `${base}/v1/rooms/${room}/${action}`;
  async function call(url, init) {
    const res = await fetch(url, init);
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const ra = Number(res.headers.get('Retry-After'));
      throw new RelayHttpError(res.status, body?.error, body?.message, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    return body;
  }
  return {
    push(base, room, token, envelopes, client) {
      return call(roomUrl(base, room, 'push'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Sync-Client': client },
        body: JSON.stringify({ envelopes }),
      });
    },
    pull(base, room, token, after, limit) {
      return call(`${roomUrl(base, room, 'pull')}?after=${after}&limit=${limit}`, { headers: { Authorization: `Bearer ${token}` } });
    },
    /** Open the live socket. Calls onHead(seq) for each announcement and onClose() once. Returns { close }. */
    live(base, room, token, client, { onOpen, onHead, onClose }) {
      if (typeof WebSocket !== 'function') { onClose(); return { close() {} }; }
      const url = `${roomUrl(base, room, 'live').replace(/^http/, 'ws')}?client=${client}`;
      // The token rides in a subprotocol (browsers can't set headers on a WebSocket, and URLs get logged).
      const ws = new WebSocket(url, ['peek-sync.v1', `bearer.${token}`]);
      let ping = null;
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        timers.clearInterval(ping);
        onClose();
      };
      ws.onopen = () => { ping = timers.setInterval(() => { try { ws.send('ping'); } catch { /* closing */ } }, PING_MS); onOpen?.(); };
      ws.onmessage = (m) => {
        if (m.data === 'pong') return;
        try { const msg = JSON.parse(m.data); if (msg?.type === 'head' && Number.isSafeInteger(msg.seq)) onHead(msg.seq); } catch { /* ignore */ }
      };
      ws.onclose = finish;
      ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } finish(); };
      return { close() { try { ws.close(1000); } catch { /* ignore */ } finish(); } };
    },
  };
}

/** Visibility and connectivity from the browser (also the Android and iOS WebViews). */
export function browserEnv() {
  const doc = globalThis.document;
  return {
    isVisible: () => !doc || doc.visibilityState !== 'hidden',
    isOnline: () => globalThis.navigator?.onLine !== false,
    onVisibility(fn) { doc?.addEventListener('visibilitychange', () => fn(doc.visibilityState !== 'hidden')); },
    onOnline(fn) { globalThis.addEventListener?.('online', fn); },
    onOffline(fn) { globalThis.addEventListener?.('offline', fn); },
  };
}

function randomId() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* --------------------------------------------------------------------------
   Engine
   -------------------------------------------------------------------------- */
/** Human-readable messages for failures. They never include keys, tokens or data. */
function describe(err) {
  if (err instanceof RelayHttpError) {
    switch (err.status) {
      case 401: return "The relay didn't accept this household key. Check the key on both devices.";
      case 413: return 'A change is too large for the relay.';
      case 429: return 'The relay is busy. Retrying shortly.';
      case 507: return 'The sync room on the relay is full.';
      default: return err.status >= 500 ? 'The relay had a problem. Retrying.' : `The relay refused the request (${err.status}).`;
    }
  }
  if (err instanceof TypeError) return "Can't reach the relay.";
  return err?.message ? String(err.message) : 'Sync failed.';
}

/**
 * Create the engine. Options (all optional except `store`):
 *   store      storage adapter (storage.syncStore in the app)
 *   transport  relay client (fetchTransport())       crypto  { deriveKeys, seal, open } (js/crypto.js)
 *   env        visibility/online hooks (browserEnv()) timers  { setTimeout, clearTimeout, setInterval, clearInterval }
 *   now, random, log, clientId, debounceMs (1000), intervalMs (60000), batchSize (200), maxBatchChars (512000)
 */
export function createSyncEngine(opts) {
  const {
    store, transport = fetchTransport(), crypto = box, env = browserEnv(), timers = globalThis,
    now = () => Date.now(), random = Math.random, log = console, clientId = randomId(),
    debounceMs = 1000, intervalMs = 60_000, batchSize = 200, maxBatchChars = 512_000,
  } = opts;

  const status = { state: 'off', lastSyncedAt: null, pendingCount: 0, lastError: '' };
  const statusListeners = new Set();
  const remoteListeners = new Set();
  let config = null;
  let keys = null; // { keyText, roomId, token, aesKey }
  let started = false;
  let running = null;
  let again = false;
  let failures = 0;
  let pausedUntilTrigger = false; // after a 401: no automatic retries until something changes
  let knownHead = 0;
  let batchLimit = batchSize;
  let retryTimer = null;
  let debounceTimer = null;
  let intervalTimer = null;
  let socket = null;
  let socketTimer = null;
  let socketFailures = 0;

  const emitStatus = () => {
    const copy = { ...status };
    for (const fn of statusListeners) { try { fn(copy); } catch (err) { log.error(err); } }
  };
  const setStatus = (state, lastError = status.lastError) => {
    status.state = state;
    status.lastError = lastError;
    emitStatus();
  };
  const clear = (t, fn = 'clearTimeout') => { if (t !== null) timers[fn](t); return null; };

  async function refreshPending() {
    try { status.pendingCount = await store.pendingCount(); } catch { /* fallback store: leave as is */ }
  }

  /** Read the config and derive keys when the household key changed. */
  async function loadConfig() {
    config = await store.getConfig();
    const keyText = config.householdKey || '';
    if (keys?.keyText !== keyText) keys = keyText ? { keyText, ...(await crypto.deriveKeys(keyText)) } : null;
    const url = normalizeRelayUrl(config.relayUrl);
    config = { ...config, relayUrl: url };
    return Boolean(config.enabled && url && keys);
  }

  /* ---------------- one sync: push, then pull ---------------- */
  async function pushAll() {
    let clockAhead = false;
    for (let round = 0; round < 50; round++) {
      const ops = await store.pendingOps(batchLimit);
      if (!ops.length) break;
      const batch = [];
      const envelopes = [];
      let size = 0;
      for (const op of ops) {
        const env = await crypto.seal(keys.aesKey, op);
        const n = env.c.length + env.id.length + 32;
        if (batch.length && size + n > maxBatchChars) break;
        batch.push(op);
        envelopes.push(env);
        size += n;
      }
      const res = await transport.push(config.relayUrl, keys.roomId, keys.token, envelopes, clientId);
      if (Number.isSafeInteger(res?.head)) knownHead = Math.max(knownHead, res.head);
      const rejected = new Set(Array.isArray(res?.rejected) ? res.rejected : []);
      const sent = batch.filter((op) => !rejected.has(op.id)).map(({ rec, f, t }) => ({ rec, f, t }));
      if (sent.length) await store.removeSentOps(sent);
      if (rejected.size) clockAhead = true;
      if (!sent.length) break; // everything left was refused (stamped too far ahead)
    }
    return { clockAhead };
  }

  async function pullAll() {
    let cursor = await store.getCursor();
    let changed = 0;
    let bad = 0;
    let lost = false;
    for (let page = 0; page < 10_000; page++) {
      let res;
      try {
        res = await transport.pull(config.relayUrl, keys.roomId, keys.token, cursor, PULL_LIMIT);
      } catch (err) {
        if (err instanceof RelayHttpError && err.status === 404) {
          // No room yet: nobody has pushed. If we had pulled before, the relay lost the room.
          if (cursor > 0) { await store.requeueAll(); lost = true; }
          knownHead = 0;
          break;
        }
        throw err;
      }
      const entries = Array.isArray(res?.entries) ? res.entries : [];
      const head = Number.isSafeInteger(res?.head) ? res.head : 0;
      if (head < cursor) {
        // The relay has fewer entries than we've already seen: its data was lost or reset.
        // Send everything again and read it from the start.
        await store.requeueAll();
        lost = true;
        cursor = 0;
        continue;
      }
      let last = cursor;
      const ops = [];
      for (const e of entries) {
        if (!Number.isSafeInteger(e?.seq) || e.seq <= last) throw new Error('The relay sent entries out of order.');
        last = e.seq;
        try { ops.push(await crypto.open(keys.aesKey, e)); } catch { bad++; }
      }
      if (entries.length) {
        const out = await store.applyRemote(ops, last); // ops, clock and cursor in one transaction
        changed += out.changed;
        bad += out.skipped;
        cursor = last;
      }
      knownHead = Math.max(head, cursor);
      if (!entries.length || cursor >= head) break;
    }
    if (bad) log.warn(`Sync: ignored ${bad} change(s) that could not be verified.`);
    return { changed, lost };
  }

  async function runOnce() {
    let ready;
    try { ready = await loadConfig(); } catch (err) { setStatus('error', describe(err)); return; }
    if (!ready) { closeSocket(); stopInterval(); setStatus('off', ''); return; }
    if (!env.isOnline()) { closeSocket(); setStatus('offline', "This device is offline. Changes are kept and sent later."); return; }
    setStatus('syncing');
    try {
      const { clockAhead } = await pushAll();
      const { changed, lost } = await pullAll();
      if (lost) again = true; // push what was re-queued
      failures = 0;
      batchLimit = batchSize;
      pausedUntilTrigger = false;
      status.lastSyncedAt = now();
      try { await store.setLastSynced(status.lastSyncedAt); } catch { /* not important */ }
      await refreshPending();
      setStatus('ok', clockAhead ? "Some changes are waiting: this device's clock is more than a day ahead." : '');
      if (changed) for (const fn of remoteListeners) { try { await fn(); } catch (err) { log.error(err); } }
      ensureSocket();
      ensureInterval();
    } catch (err) {
      await refreshPending();
      fail(err);
    }
  }

  /** Decide the status and when to try again. */
  function fail(err) {
    const message = describe(err);
    if (err instanceof TypeError) { setStatus('offline', message); return retryIn(backoff()); }
    if (!(err instanceof RelayHttpError)) { setStatus('error', message); return retryIn(backoff()); }
    if (err.status === 401) { pausedUntilTrigger = true; closeSocket(); return setStatus('error', message); }
    if (err.status === 413 && batchLimit > 1) { batchLimit = Math.max(1, Math.floor(batchLimit / 2)); setStatus('error', message); return retryIn(1000); }
    if (err.status === 429) { setStatus('error', message); return retryIn(err.retryAfterMs ?? backoff()); }
    if (err.status === 507) { setStatus('error', message); return retryIn(60 * 60_000); }
    setStatus('error', message);
    return retryIn(backoff());
  }

  /** Exponential backoff with jitter: 2 s, 4 s, 8 s … up to 5 minutes, each ×0.5–1.5. */
  function backoff() {
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** failures);
    failures++;
    return Math.round(ms * (0.5 + random()));
  }

  function retryIn(ms) {
    retryTimer = clear(retryTimer);
    retryTimer = timers.setTimeout(() => { retryTimer = null; request('retry'); }, ms);
  }

  /** Run a sync now, or after the current one if one is running. Never rejects. */
  function request(reason) {
    if (!started) return Promise.resolve();
    if (reason === 'retry' && pausedUntilTrigger) return Promise.resolve();
    if (reason !== 'retry') retryTimer = clear(retryTimer);
    debounceTimer = clear(debounceTimer); // this run covers it
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        await runOnce();
      } while (again && started);
    })().catch((err) => log.error(err)).finally(() => { running = null; });
    return running;
  }

  /* ---------------- triggers ---------------- */
  function ensureInterval() {
    if (intervalTimer !== null || !env.isVisible()) return;
    intervalTimer = timers.setInterval(() => request('interval'), intervalMs);
  }
  function stopInterval() { intervalTimer = clear(intervalTimer, 'clearInterval'); }

  function ensureSocket() {
    if (socket || socketTimer !== null || !started || !keys || !config?.relayUrl || !config.enabled || pausedUntilTrigger) return;
    if (!env.isVisible() || !env.isOnline()) return;
    const conn = transport.live(config.relayUrl, keys.roomId, keys.token, clientId, {
      onOpen: () => { socketFailures = 0; },
      onHead: (seq) => { if (seq > knownHead) request('live'); },
      onClose: () => {
        if (socket !== conn) return;
        socket = null;
        if (!started || !env.isVisible() || !config?.enabled) return;
        const ms = Math.round(Math.min(SOCKET_RETRY_MAX_MS, 1000 * 2 ** socketFailures++) * (0.5 + random()));
        socketTimer = timers.setTimeout(() => { socketTimer = null; ensureSocket(); }, ms);
      },
    });
    socket = conn;
  }

  function closeSocket() {
    socketTimer = clear(socketTimer);
    const s = socket;
    socket = null;
    s?.close();
  }

  const onLocalChange = () => {
    refreshPending().then(emitStatus);
    debounceTimer = clear(debounceTimer);
    debounceTimer = timers.setTimeout(() => { debounceTimer = null; request('local'); }, debounceMs);
  };

  /* ---------------- public API ---------------- */
  return {
    /** Start listening for triggers and sync once if configured. */
    async start() {
      if (started) return;
      started = true;
      try { status.lastSyncedAt = await store.getLastSynced(); } catch { /* fallback store */ }
      store.onChangesEnqueued(onLocalChange);
      env.onVisibility((visible) => {
        if (!started) return;
        if (visible) { request('visible'); } else { stopInterval(); closeSocket(); }
      });
      env.onOnline(() => request('online'));
      env.onOffline?.(() => { closeSocket(); if (status.state !== 'off') setStatus('offline', 'This device is offline. Changes are kept and sent later.'); });
      await refreshPending();
      await request('start');
    },
    /** Stop all timers and the socket. Local data is untouched. */
    stop() {
      started = false;
      debounceTimer = clear(debounceTimer);
      retryTimer = clear(retryTimer);
      stopInterval();
      closeSocket();
      store.onChangesEnqueued(() => {});
    },
    /** Sync now (the dev screen's button). Resolves when done; never rejects. */
    syncNow() { pausedUntilTrigger = false; failures = 0; return request('manual'); },
    /** Save config fields ({ relayUrl, householdKey, enabled }) and sync with them. */
    async configure(patch) {
      await store.setConfig(patch);
      pausedUntilTrigger = false;
      failures = 0;
      knownHead = 0;
      closeSocket();
      return request('config');
    },
    /** Stop syncing and forget the household key on this device. Local data stays. */
    async disconnect() {
      closeSocket();
      stopInterval();
      retryTimer = clear(retryTimer);
      await store.setConfig({ enabled: false, householdKey: '' });
      keys = null;
      return request('config');
    },
    getStatus: () => ({ ...status }),
    /** Called with a status copy on every change. Returns an unsubscribe function. */
    onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    /** Called after a sync applied changes from other devices (refresh the screens). */
    onRemoteChanges(fn) { remoteListeners.add(fn); return () => remoteListeners.delete(fn); },
    /** Resolves once no sync is running (tests). */
    async idle() { while (running) await running; },
  };
}
