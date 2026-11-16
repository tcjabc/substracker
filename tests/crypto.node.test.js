// Node tests for js/crypto.js: key format, derivation, and sealing/opening envelopes.
// Run with `npm test`. Uses Node's built-in Web Crypto.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../js/crypto.js';
import { formatStamp } from '../js/sync-core.js';

const WALL = Date.parse('2026-06-01T00:00:00.000Z');
const op = (over = {}) => ({ id: 'op-1', rec: 'rec-1', f: 'name', v: 'Example Streaming', t: formatStamp(WALL, 3, 'devA'), dev: 'devA', ...over });

test('generated keys are 22 base64url characters of 16 random bytes', () => {
  const a = c.generateKey();
  const b = c.generateKey();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, b);
  assert.equal(c.parseKey(a).length, 16);
  assert.equal(c.parseKey(`  ${a}\n`).length, 16, 'surrounding spaces are fine');
});

test('parseKey rejects anything that is not exactly one key, without echoing it', () => {
  for (const bad of ['', 'short', 'x'.repeat(23), 'abc+def/ghi=jklmnopqrs', null, 42]) {
    assert.throws(() => c.parseKey(bad), (err) => !String(err.message).includes(String(bad)) || bad === '' || bad === null);
  }
  // The last character has 4 unused bits; a non-canonical spelling is refused.
  const k = c.generateKey();
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alt = k.slice(0, 21) + last[(last.indexOf(k[21]) + 1) % 64];
  if (alt !== k) assert.throws(() => c.parseKey(alt));
});

test('derivation is deterministic, purpose-separated and key-specific', async () => {
  const key = c.generateKey();
  const a = await c.deriveKeys(key);
  const b = await c.deriveKeys(key);
  const other = await c.deriveKeys(c.generateKey());
  assert.match(a.roomId, /^[0-9a-f]{32}$/);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([a.roomId, a.token], [b.roomId, b.token]);
  assert.notEqual(a.roomId, other.roomId);
  assert.notEqual(a.token, other.token);
  assert.equal(a.token.includes(a.roomId), false);
  assert.equal(a.aesKey.extractable, false, 'the AES key cannot be exported');
  assert.deepEqual(a.aesKey.algorithm, { name: 'AES-GCM', length: 256 });
});

test('seal → open round-trips, with the wall time outside and fresh IVs', async () => {
  const { aesKey } = await c.deriveKeys(c.generateKey());
  const env = await c.seal(aesKey, op());
  assert.deepEqual(Object.keys(env), ['id', 'wall', 'c']);
  assert.deepEqual([env.id, env.wall], ['op-1', WALL]);
  assert.equal(env.c.includes('Example'), false);
  assert.deepEqual(await c.open(aesKey, env), op());
  const again = await c.seal(aesKey, op());
  assert.notEqual(again.c, env.c, 'a new IV every time');
  // Values of different lengths pad to the same size.
  const short = await c.seal(aesKey, op({ v: 'A' }));
  const longer = await c.seal(aesKey, op({ v: 'Example Streaming Plus' }));
  assert.equal(short.c.length, longer.c.length);
  // Unicode and objects survive.
  const odd = op({ f: 'notes', v: '家用 🔧 "quoted" \n' });
  assert.deepEqual(await c.open(aesKey, await c.seal(aesKey, odd)), odd);
});

test('tampered ciphertext is rejected', async () => {
  const { aesKey } = await c.deriveKeys(c.generateKey());
  const env = await c.seal(aesKey, op());
  const bytes = Buffer.from(env.c, 'base64');
  for (const at of [0, 12, bytes.length - 1]) {
    const t = Buffer.from(bytes);
    t[at] ^= 1;
    await assert.rejects(c.open(aesKey, { ...env, c: t.toString('base64') }), c.EnvelopeError, `byte ${at}`);
  }
  await assert.rejects(c.open(aesKey, { ...env, c: bytes.subarray(0, 20).toString('base64') }), c.EnvelopeError, 'truncated');
  await assert.rejects(c.open(aesKey, { ...env, c: '***' }), c.EnvelopeError, 'not base64');
});

test('changing the authenticated wall or id is rejected', async () => {
  const { aesKey } = await c.deriveKeys(c.generateKey());
  const env = await c.seal(aesKey, op());
  await assert.rejects(c.open(aesKey, { ...env, wall: env.wall + 1 }), c.EnvelopeError, 'wall moved');
  await assert.rejects(c.open(aesKey, { ...env, wall: 0 }), c.EnvelopeError, 'wall reset');
  await assert.rejects(c.open(aesKey, { ...env, id: 'op-2' }), c.EnvelopeError, 'id swapped');
  for (const bad of [null, {}, { ...env, wall: -1 }, { ...env, wall: '1' }, { ...env, id: '' }]) {
    await assert.rejects(c.open(aesKey, bad), c.EnvelopeError);
  }
});

test('the wrong key is rejected', async () => {
  const mine = await c.deriveKeys(c.generateKey());
  const theirs = await c.deriveKeys(c.generateKey());
  await assert.rejects(c.open(theirs.aesKey, await c.seal(mine.aesKey, op())), c.EnvelopeError);
});

test('an op whose stamp does not match the envelope wall is rejected', async () => {
  // Built with the right key and matching AAD, but the op inside claims another time.
  const { aesKey } = await c.deriveKeys(c.generateKey());
  const env = await c.seal(aesKey, op({ t: formatStamp(WALL + 5, 0, 'devA') }));
  assert.equal(env.wall, WALL + 5);
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const forged = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`peek-budget/v1/op|op-1|${WALL}`) },
    aesKey, enc.encode(JSON.stringify(op({ t: formatStamp(WALL + 5, 0, 'devA') })))));
  const c2 = Buffer.concat([iv, forged]).toString('base64');
  await assert.rejects(c.open(aesKey, { id: 'op-1', wall: WALL, c: c2 }), c.EnvelopeError);
  await assert.rejects(c.seal(aesKey, { ...op(), dev: 'other' }), /valid ops/);
});

test('error messages never contain the key, token or plaintext', async () => {
  const key = c.generateKey();
  const { aesKey, token } = await c.deriveKeys(key);
  const env = await c.seal(aesKey, op());
  try { await c.open(aesKey, { ...env, wall: 1 }); } catch (err) {
    for (const secret of [key, token, 'Example Streaming']) assert.equal(err.message.includes(secret), false);
  }
});
