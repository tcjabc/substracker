// FROZEN: js/crypto.js from Peek Budget 1.19.0 (commit 08bcdc4), byte for byte below these two lines.
// Never edit, reformat or update it: tests/legacy-fixture.node.test.js checks every byte (see README.md).
// End-to-end encryption for sync. Web Crypto only, so it runs the same in browsers, the Android
// and iOS WebViews and Node 20+. The household key never leaves the device; the relay only sees
// a room id and a token derived from it, and sealed envelopes it cannot read.
// Nothing here logs keys, tokens or plaintext, and errors never include them.

import { isOp, parseStamp } from './sync-core.js';
import { t as tr } from './i18n.js'; // `t` is the key text in parseKey

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

const KEY_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PAD_TO = 64; // plaintext is padded to a multiple of this, so sizes say little about contents
const MAX_ENVELOPE_CHARS = 64 * 1024;

// HKDF inputs. Changing any of these changes every derived value, so they're versioned.
const SALT = enc.encode('peek-budget/sync/v1');
const INFO = {
  room: enc.encode('peek-budget/v1/room-id'),
  token: enc.encode('peek-budget/v1/relay-token'),
  aes: enc.encode('peek-budget/v1/op-encryption'),
};

/* --------------------------------------------------------------------------
   Encoding
   -------------------------------------------------------------------------- */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const toBase64url = (bytes) => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/* --------------------------------------------------------------------------
   Household key
   -------------------------------------------------------------------------- */
/** A new household key: 16 random bytes as base64url (22 characters). */
export function generateKey() {
  return toBase64url(globalThis.crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** The 16 key bytes from its text form. Throws a plain message (without the key) if it isn't one. */
export function parseKey(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!/^[A-Za-z0-9_-]{22}$/.test(t)) throw new Error(tr('sync.key.format'));
  const bytes = fromBase64(t.replace(/-/g, '+').replace(/_/g, '/') + '==');
  // The last character carries 4 unused bits; insist they're zero so each key has one spelling.
  if (bytes.length !== KEY_BYTES || toBase64url(bytes) !== t) throw new Error(tr('sync.key.invalid'));
  return bytes;
}

/**
 * Everything derived from a household key with HKDF-SHA256, one purpose per info string:
 * roomId (128 bits, hex) and token (256 bits, base64url) for the relay, and a non-extractable
 * AES-GCM-256 key for the ops. The relay can't work back from the room id or token to the key.
 */
export async function deriveKeys(keyText) {
  const base = await subtle().importKey('raw', parseKey(keyText), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const bits = async (info, n) => new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info }, base, n));
  const [room, token, aesKey] = await Promise.all([
    bits(INFO.room, 128),
    bits(INFO.token, 256),
    subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: INFO.aes }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
  ]);
  return { roomId: toHex(room), token: toBase64url(token), aesKey };
}

/* --------------------------------------------------------------------------
   Envelopes
   -------------------------------------------------------------------------- */
// An envelope is { id, wall, c }: the op id, the wall-clock part of its stamp (the relay needs it
// to reject far-future stamps) and base64(iv + AES-GCM ciphertext). Both id and wall are bound as
// additional authenticated data, so neither can be changed without the envelope failing to open.
const aadFor = (id, wall) => enc.encode(`peek-budget/v1/op|${id}|${wall}`);

/** Thrown for any envelope that can't be opened. The message never contains its contents. */
export class EnvelopeError extends Error {}

/** Encrypt one op. */
export async function seal(aesKey, op) {
  if (!isOp(op)) throw new Error('Only valid ops can be sealed.');
  const wall = parseStamp(op.t).wall;
  const json = JSON.stringify(op);
  const plain = enc.encode(json.padEnd(Math.ceil((json.length + 1) / PAD_TO) * PAD_TO, ' '));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aadFor(op.id, wall) }, aesKey, plain));
  const body = new Uint8Array(IV_BYTES + ct.length);
  body.set(iv);
  body.set(ct, IV_BYTES);
  return { id: op.id, wall, c: toBase64(body) };
}

/**
 * Decrypt and check one envelope: it must authenticate with this key and its id and wall, and the
 * op inside must be valid, have the same id, and a stamp whose wall part equals `wall`.
 * Throws EnvelopeError otherwise.
 */
export async function open(aesKey, envelope) {
  const fail = () => { throw new EnvelopeError('Envelope failed authentication.'); };
  const e = envelope;
  if (!e || typeof e.id !== 'string' || !e.id || e.id.length > 128 || !Number.isSafeInteger(e.wall) || e.wall < 0
    || typeof e.c !== 'string' || e.c.length > MAX_ENVELOPE_CHARS) fail();
  let body;
  try { body = fromBase64(e.c); } catch { fail(); }
  if (body.length < IV_BYTES + TAG_BYTES) fail();
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: body.subarray(0, IV_BYTES), additionalData: aadFor(e.id, e.wall) },
      aesKey, body.subarray(IV_BYTES));
  } catch { fail(); }
  let op;
  try { op = JSON.parse(dec.decode(plain)); } catch { fail(); }
  if (!isOp(op) || op.id !== e.id || parseStamp(op.t).wall !== e.wall) fail();
  return op;
}
