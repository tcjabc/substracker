// FROZEN: js/sync-core.js from Peek Budget 1.19.0 (commit 08bcdc4), byte for byte below these two lines.
// Never edit, reformat or update it: tests/legacy-fixture.node.test.js checks every byte (see README.md).
// Sync core: a hybrid logical clock, one-field operations and last-write-wins merging.
// Pure: no DOM, no IndexedDB, no network, no platform code. Runs in the browser and in Node,
// so every device (web, Android, iOS) merges the same ops to the same result.
//
// A record is { id, fields: { name: value, …, del: false }, ts: { name: stamp, …, del: stamp } }.
// Each field keeps the stamp of the op that last set it. Deleting sets the field `del` to true
// (a tombstone); records are never removed, so a late op can't bring a deleted one back by accident.

/* --------------------------------------------------------------------------
   Hybrid logical clock
   -------------------------------------------------------------------------- */
// A stamp is "<wall ms, 15 digits>-<counter, 6 digits>-<deviceId>", e.g.
// "001767225600000-000000-3f2a…". The fixed-width parts make plain string order the time order,
// with the device id breaking ties, so stamps can be compared and sorted as strings anywhere.
const WALL_DIGITS = 15;
const COUNT_DIGITS = 6;
const MAX_WALL = 10 ** WALL_DIGITS - 1;
const MAX_COUNT = 10 ** COUNT_DIGITS - 1;
const DEVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STAMP_RE = /^(\d{15})-(\d{6})-([A-Za-z0-9_-]{1,64})$/;

export const isDeviceId = (v) => typeof v === 'string' && DEVICE_RE.test(v);

/** A clock that has seen nothing yet. */
export function newClock(dev) {
  if (!isDeviceId(dev)) throw new Error('Invalid device id');
  return { wall: 0, count: 0, dev };
}

/** True for a well-formed clock state ({ wall, count, dev }). */
export function isClock(c) {
  return c !== null && typeof c === 'object' && isDeviceId(c.dev)
    && Number.isInteger(c.wall) && c.wall >= 0 && c.wall <= MAX_WALL
    && Number.isInteger(c.count) && c.count >= 0 && c.count <= MAX_COUNT;
}

export function formatStamp(wall, count, dev) {
  if (!Number.isInteger(wall) || wall < 0 || wall > MAX_WALL) throw new Error('Clock out of range');
  if (!Number.isInteger(count) || count < 0 || count > MAX_COUNT) throw new Error('Counter out of range');
  if (!isDeviceId(dev)) throw new Error('Invalid device id');
  return `${String(wall).padStart(WALL_DIGITS, '0')}-${String(count).padStart(COUNT_DIGITS, '0')}-${dev}`;
}

/** { wall, count, dev } for a valid stamp, otherwise null. */
export function parseStamp(s) {
  const m = typeof s === 'string' ? STAMP_RE.exec(s) : null;
  return m ? { wall: Number(m[1]), count: Number(m[2]), dev: m[3] } : null;
}

export const isStamp = (s) => parseStamp(s) !== null;

/** Order two stamps: negative if a is earlier, positive if later, 0 if the same. */
export function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The physical clock reading to use: whole ms, and 0 for anything unusable. */
function physical(now) {
  return Number.isFinite(now) && now > 0 ? Math.min(Math.floor(now), MAX_WALL) : 0;
}

/** Keep the counter in range by moving the wall forward 1 ms (only after a million events in one ms). */
function settle(wall, count, dev) {
  if (count > MAX_COUNT) { wall += 1; count = 0; }
  if (wall > MAX_WALL) throw new Error('Clock out of range');
  return { wall, count, dev };
}

/**
 * A stamp for a local event. Never earlier than any stamp this clock has made or seen, even when
 * the phone's clock is wrong or jumps backwards: the wall part only moves forward, and the counter
 * orders events within the same wall time. Returns { clock, stamp }; the input isn't changed.
 */
export function tick(clock, now = Date.now()) {
  if (!isClock(clock)) throw new Error('Invalid clock');
  const pt = physical(now);
  const wall = Math.max(clock.wall, pt);
  const next = settle(wall, wall === clock.wall ? clock.count + 1 : 0, clock.dev);
  return { clock: next, stamp: formatStamp(next.wall, next.count, next.dev) };
}

/** How far ahead of this device's own clock a remote stamp may pull it: 24 hours. */
export const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

/**
 * Fold a stamp from another device into this clock, so every later local stamp sorts after it
 * (an edit made after seeing a change wins over that change). A remote clock that is ahead pulls
 * this one forward; it stays monotonic and settles back to real time as time passes.
 *
 * A stamp more than `maxDrift` ahead of this device's physical clock (a phone set to the wrong
 * year, say) only counts as `now + maxDrift` here, so one bad clock can't drag every device's
 * clock, and with it all their future edits, far into the future. The cap is measured from the
 * physical clock, not from this HLC, so repeated far-ahead stamps can't ratchet it forward a day
 * at a time. The op itself keeps its own stamp for ordering (see applyToRecord). Returns the new
 * clock; throws on a malformed stamp.
 */
export function receive(clock, remoteStamp, now = Date.now(), maxDrift = MAX_DRIFT_MS) {
  if (!isClock(clock)) throw new Error('Invalid clock');
  const parsed = parseStamp(remoteStamp);
  if (!parsed) throw new Error('Invalid stamp');
  const pt = physical(now);
  const limit = Math.min(pt + maxDrift, MAX_WALL);
  const r = parsed.wall > limit ? { wall: limit, count: 0 } : parsed;
  const wall = Math.max(clock.wall, r.wall, pt);
  let count;
  if (wall === clock.wall && wall === r.wall) count = Math.max(clock.count, r.count) + 1;
  else if (wall === clock.wall) count = clock.count + 1;
  else if (wall === r.wall) count = r.count + 1;
  else count = 0;
  return settle(wall, count, clock.dev);
}

/* --------------------------------------------------------------------------
   Values
   -------------------------------------------------------------------------- */
// Field values are plain JSON (strings, finite numbers, booleans, null, arrays, plain objects),
// so every platform stores and compares them the same way.
function isJsonValue(v, depth = 0) {
  if (depth > 16) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.values(v).every((x) => isJsonValue(x, depth + 1));
  }
  return false;
}

/** JSON with object keys sorted, so equal values give equal text. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Deep equality for JSON values (object key order doesn't matter). */
export const sameValue = (a, b) => a === b || canonical(a) === canonical(b);

const clone = (v) => (v !== null && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

/* --------------------------------------------------------------------------
   Ops and merging
   -------------------------------------------------------------------------- */
// An op is one field change on one record: { id, rec, f, v, t, dev }.
//   id   unique id of the op       rec  record id        f  field name
//   v    new value (JSON)          t    HLC stamp        dev  device that made it
// Deleting a record is the op { f: 'del', v: true }. Creating one includes { f: 'del', v: false }.
export const DELETED = 'del';
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const isRecordId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
export const isFieldName = (v) => typeof v === 'string' && FIELD_RE.test(v);

export function isOp(op) {
  if (op === null || typeof op !== 'object') return false;
  const s = parseStamp(op.t);
  return typeof op.id === 'string' && op.id.length > 0 && op.id.length <= 128
    && isRecordId(op.rec) && isFieldName(op.f) && isJsonValue(op.v)
    && s !== null && s.dev === op.dev
    && (op.f !== DELETED || typeof op.v === 'boolean');
}

/** True for a record that exists and isn't deleted. Only these are shown or exported. */
export const isLive = (record) => record?.fields?.[DELETED] === false;

/**
 * Apply one op to one record (or to undefined, if the record isn't known yet).
 * The field takes the op's value only if the op's stamp is later than the field's current stamp,
 * so the result doesn't depend on the order ops arrive in, and applying an op twice does nothing.
 * Two ops with the very same stamp can only come from one device; the larger value wins so that
 * even that case is deterministic. Returns { record, changed }; the input record isn't changed.
 *
 * Ops are always ordered by their own stamp, even one far in the future that receive() wouldn't let
 * move the clock. Rewriting or holding back such a stamp would depend on each device's own clock,
 * so devices would end up with different data; keeping it means every device agrees. The cost is
 * that the field such an op set keeps its value until real time passes that stamp.
 */
export function applyToRecord(record, op) {
  if (!isOp(op)) throw new Error('Invalid op');
  if (record && record.id !== op.rec) throw new Error('Op is for another record');
  const cur = record ?? { id: op.rec, fields: {}, ts: {} };
  const prev = cur.ts[op.f];
  if (prev !== undefined) {
    const order = compare(op.t, prev);
    if (order < 0) return { record: cur, changed: false };
    if (order === 0 && canonical(op.v) <= canonical(cur.fields[op.f])) return { record: cur, changed: false };
  }
  return {
    record: { id: cur.id, fields: { ...cur.fields, [op.f]: clone(op.v) }, ts: { ...cur.ts, [op.f]: op.t } },
    changed: true,
  };
}

/** Apply one op to a Map of records (id → record). Returns whether anything changed. */
export function applyOp(records, op) {
  const { record, changed } = applyToRecord(records.get(op.rec), op);
  if (changed) records.set(op.rec, record);
  return changed;
}

/* --------------------------------------------------------------------------
   Local changes
   -------------------------------------------------------------------------- */
// A replica is { clock, records: Map<id, record> }. Each helper turns one change into ops that
// share one fresh stamp, applies them to the replica (records and clock are updated in place),
// and returns the ops so the caller can store them in the outbox. Options: { now, newId }.

function emit(replica, rec, changes, { now = Date.now(), newId = () => globalThis.crypto.randomUUID() } = {}) {
  const entries = Object.entries(changes);
  if (!entries.length) return [];
  const { clock, stamp } = tick(replica.clock, now);
  const ops = entries.map(([f, v]) => ({ id: newId(), rec, f, v: clone(v), t: stamp, dev: clock.dev }));
  for (const op of ops) if (!isOp(op)) throw new Error(`Invalid value for "${op.f}"`);
  replica.clock = clock;
  for (const op of ops) applyOp(replica.records, op);
  return ops;
}

function checkChange(rec, fields) {
  if (!isRecordId(rec)) throw new Error('Invalid record id');
  if (fields === null || typeof fields !== 'object') throw new Error('Fields must be an object');
  for (const f of Object.keys(fields)) {
    if (!isFieldName(f) || f === DELETED) throw new Error(`Invalid field name "${f}"`);
  }
}

/** Ops for the fields whose value differs from the record's (all of them for a new record). */
function changedFields(cur, fields) {
  const out = {};
  for (const [f, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (!cur || !(f in cur.ts) || !sameValue(cur.fields[f], v)) out[f] = v;
  }
  return out;
}

/** Create a new record. Throws if the id is already in use (even by a deleted record). */
export function createRecord(replica, rec, fields, opts) {
  checkChange(rec, fields);
  if (replica.records.has(rec)) throw new Error('Record already exists');
  return emit(replica, rec, { ...changedFields(null, fields), [DELETED]: false }, opts);
}

/** Change some fields of a live record. Only fields with a new value produce ops. */
export function editRecord(replica, rec, fields, opts) {
  checkChange(rec, fields);
  const cur = replica.records.get(rec);
  if (!isLive(cur)) throw new Error('No such record');
  return emit(replica, rec, changedFields(cur, fields), opts);
}

/** Delete a record (tombstone). Deleting a missing or already deleted record does nothing. */
export function deleteRecord(replica, rec, opts) {
  if (!isRecordId(rec)) throw new Error('Invalid record id');
  if (!isLive(replica.records.get(rec))) return [];
  return emit(replica, rec, { [DELETED]: true }, opts);
}

/**
 * Set fields on a record that isn't an item (such as the shared settings), creating it if needed.
 * It never gets a `del` field, so it is never live: item lists, counts and exports skip it, on this
 * version and on older ones. Only fields with a new value produce ops; null clears a field.
 */
export function setFields(replica, rec, fields, opts) {
  checkChange(rec, fields);
  return emit(replica, rec, changedFields(replica.records.get(rec), fields), opts);
}

/** Create, update, or bring back a deleted record, so that it ends up live with these field values. */
export function putRecord(replica, rec, fields, opts) {
  checkChange(rec, fields);
  const cur = replica.records.get(rec);
  const changes = changedFields(cur, fields);
  if (!isLive(cur)) changes[DELETED] = false;
  return emit(replica, rec, changes, opts);
}
