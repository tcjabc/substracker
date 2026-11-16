// Peek Budget relay: the rules for one room, with no Cloudflare APIs, so they run (and are tested)
// in Node too. A room is an append-only log of sealed envelopes the relay can't read. The room's
// Durable Object (room.js) supplies storage; the Worker (index.js) routes and applies CORS.
// Nothing here logs request bodies, tokens or envelopes.

/** Same idea as the client's MAX_DRIFT_MS: envelopes stamped further ahead than this are refused. */
export const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

export const LIMITS = Object.freeze({
  maxBodyBytes: 1_000_000, // per push request
  maxEnvelopesPerPush: 500,
  maxEnvelopeChars: 64 * 1024, // the `c` field
  maxEntriesPerRoom: 200_000,
  pullLimitDefault: 500,
  pullLimitMax: 500,
  rateCapacity: 120, // requests a room may make in a burst…
  rateRefillPerSec: 2, // …refilled at this rate (120 a minute sustained)
});

export const PROTOCOL = 'peek-sync.v1';
const ROOM_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[\x21-\x7e]{1,128}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CLIENT_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const isRoomId = (v) => typeof v === 'string' && ROOM_RE.test(v);
export const isClientId = (v) => typeof v === 'string' && CLIENT_RE.test(v);

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearer(header) {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '');
  return m ? m[1] : null;
}

/**
 * Browsers can't set headers on a WebSocket, so the client offers two subprotocols:
 * "peek-sync.v1" and "bearer.<token>". Returns the token, or null if the offer isn't that.
 * (A header, not the URL, because URLs end up in logs.)
 */
export function protocolToken(header) {
  const offered = (header ?? '').split(',').map((s) => s.trim());
  if (!offered.includes(PROTOCOL)) return null;
  const t = offered.find((s) => s.startsWith('bearer.'))?.slice(7);
  return t && TOKEN_RE.test(t) ? t : null;
}

/** SHA-256 of the token as hex. Only this is stored; the token itself never is. */
export async function hashToken(token) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Equal-length hex strings compared without stopping at the first difference. */
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether a browser Origin may call the relay. `list` is comma-separated; an entry ending in
 * ":*" allows any port on that scheme and host (for local dev servers).
 */
export function originAllowed(origin, list) {
  if (typeof origin !== 'string' || !origin) return false;
  for (const raw of String(list ?? '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.endsWith(':*')) {
      const base = entry.slice(0, -2);
      if (origin === base || (origin.startsWith(`${base}:`) && /^\d{1,5}$/.test(origin.slice(base.length + 1)))) return true;
    } else if (origin === entry) return true;
  }
  return false;
}

const reply = (status, body, headers) => ({ status, body, ...(headers ? { headers } : {}) });
const problem = (status, error, message, headers) => reply(status, { error, message }, headers);

/**
 * One room's behaviour over a storage adapter:
 *   exists() → bool                 tokenHash() → hex | null
 *   claim(hash, at) → stored hash   (first claim wins; later calls return the existing hash)
 *   head() → highest seq (0 if none); seqs have no gaps, so this is also the entry count
 *   insert(envelopes, at) → number stored (ids already present are skipped; one transaction)
 *   after(seq, limit) → [{ seq, id, wall, c }] in seq order
 * Methods return { status, body, headers? } for the caller to turn into a Response.
 */
export class RoomCore {
  constructor(store, { now = () => Date.now(), limits = LIMITS } = {}) {
    this.store = store;
    this.now = now;
    this.limits = { ...LIMITS, ...limits };
    this.bucket = { tokens: this.limits.rateCapacity, at: now() };
  }

  /** Token bucket for this room. The state lives in memory, so it resets if the object is evicted. */
  limited() {
    const t = this.now();
    const b = this.bucket;
    b.tokens = Math.min(this.limits.rateCapacity, b.tokens + ((t - b.at) / 1000) * this.limits.rateRefillPerSec);
    b.at = t;
    if (b.tokens >= 1) { b.tokens -= 1; return null; }
    const wait = Math.ceil((1 - b.tokens) / this.limits.rateRefillPerSec);
    return problem(429, 'rate_limited', 'Too many requests for this room. Try again shortly.', { 'Retry-After': String(wait) });
  }

  /** null when the token may use this room; otherwise the reply. `claim` creates the room on first use. */
  async authorize(token, { claim = false } = {}) {
    if (!token || !TOKEN_RE.test(token)) return problem(401, 'unauthorized', 'Missing or malformed token.');
    const hash = await hashToken(token);
    let stored = this.store.exists() ? this.store.tokenHash() : null;
    if (stored === null) {
      if (!claim) return problem(404, 'no_room', 'This room has no data yet.');
      stored = this.store.claim(hash, this.now()); // trust on first use
    }
    return sameHash(hash, stored) ? null : problem(401, 'unauthorized', 'This token does not open this room.');
  }

  /** POST /push { envelopes } → { head, accepted, rejected }. Duplicates are ignored, never errors. */
  async push({ token, bodyText }) {
    const L = this.limits;
    const limited = this.limited();
    if (limited) return limited;
    if (typeof bodyText !== 'string' || bodyText.length > L.maxBodyBytes) {
      return problem(413, 'too_large', `A push may be at most ${L.maxBodyBytes} bytes.`);
    }
    let body;
    try { body = JSON.parse(bodyText); } catch { return problem(400, 'bad_json', 'The body is not JSON.'); }
    const list = body?.envelopes;
    if (!Array.isArray(list)) return problem(400, 'bad_request', '"envelopes" must be a list.');
    if (list.length > L.maxEnvelopesPerPush) {
      return problem(413, 'too_many', `A push may carry at most ${L.maxEnvelopesPerPush} envelopes.`);
    }
    for (const e of list) {
      if (!e || typeof e !== 'object' || !ID_RE.test(e.id ?? '') || !Number.isSafeInteger(e.wall) || e.wall < 0
        || typeof e.c !== 'string' || !e.c.length || e.c.length > L.maxEnvelopeChars || !B64_RE.test(e.c)) {
        return problem(400, 'bad_envelope', 'An envelope is malformed.');
      }
    }
    const denied = await this.authorize(token, { claim: true });
    if (denied) return denied;

    const before = this.store.head();
    if (before >= L.maxEntriesPerRoom) {
      return problem(507, 'room_full', `This room is full (${L.maxEntriesPerRoom} entries). Nothing was stored.`);
    }
    // Far-future stamps are refused one by one, so the rest of the push still lands.
    const limit = this.now() + MAX_DRIFT_MS;
    const rejected = [];
    const keep = [];
    for (const e of list) {
      if (e.wall > limit) rejected.push(e.id);
      else keep.push({ id: e.id, wall: e.wall, c: e.c });
    }
    const accepted = keep.length ? this.store.insert(keep, this.now()) : 0;
    return reply(200, { head: this.store.head(), accepted, rejected });
  }

  /** GET /pull?after=N&limit=M → { entries, head } */
  async pull({ token, after, limit }) {
    const L = this.limits;
    const limited = this.limited();
    if (limited) return limited;
    const a = after === undefined || after === null || after === '' ? 0 : Number(after);
    const n = limit === undefined || limit === null || limit === '' ? L.pullLimitDefault : Number(limit);
    if (!Number.isSafeInteger(a) || a < 0) return problem(400, 'bad_request', '"after" must be a whole number of 0 or more.');
    if (!Number.isSafeInteger(n) || n < 1) return problem(400, 'bad_request', '"limit" must be a whole number of 1 or more.');
    const denied = await this.authorize(token);
    if (denied) return denied;
    return reply(200, { entries: this.store.after(a, Math.min(n, L.pullLimitMax)), head: this.store.head() });
  }

  /** May this token open a live connection? null if yes; otherwise the reply. */
  async live({ token }) {
    return this.limited() ?? (await this.authorize(token));
  }
}

/** An in-memory store with the same behaviour as the SQLite one, for tests and local experiments. */
export function memoryStore() {
  let hash = null;
  const entries = [];
  const ids = new Set();
  return {
    exists: () => hash !== null,
    tokenHash: () => hash,
    claim(h) { if (hash === null) hash = h; return hash; },
    head: () => entries.length,
    insert(list, at) {
      let added = 0;
      for (const e of list) {
        if (ids.has(e.id)) continue;
        ids.add(e.id);
        entries.push({ seq: entries.length + 1, id: e.id, wall: e.wall, c: e.c, received_at: at });
        added++;
      }
      return added;
    },
    after: (seq, limit) => entries.slice(seq, seq + limit).map(({ seq: s, id, wall, c }) => ({ seq: s, id, wall, c })),
    get size() { return entries.length; },
  };
}
