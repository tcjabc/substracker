// Node tests for relay/src/room-logic.js (no Cloudflare runtime needed). Run with `npm test` here
// or from the repository root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../src/room-logic.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const TOKEN = 'A'.repeat(43);
const OTHER = 'B'.repeat(43);
const env = (id, wall = NOW) => ({ id, wall, c: Buffer.from(`sealed-${id}`).toString('base64') });
const body = (envelopes) => JSON.stringify({ envelopes });

function room(limits) {
  let t = NOW;
  const store = R.memoryStore();
  const core = new R.RoomCore(store, { now: () => t, limits });
  return { core, store, advance: (ms) => { t += ms; } };
}

test('push stores envelopes in order and pull pages through them', async () => {
  const { core } = room();
  const r1 = await core.push({ token: TOKEN, bodyText: body([env('a'), env('b'), env('c')]) });
  assert.deepEqual([r1.status, r1.body], [200, { head: 3, accepted: 3, rejected: [] }]);
  await core.push({ token: TOKEN, bodyText: body([env('d')]) });
  const all = await core.pull({ token: TOKEN, after: '0' });
  assert.deepEqual(all.body.entries.map((e) => [e.seq, e.id]), [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
  assert.equal(all.body.head, 4);
  assert.deepEqual(Object.keys(all.body.entries[0]), ['seq', 'id', 'wall', 'c'], 'nothing about clients');
  const page = await core.pull({ token: TOKEN, after: '1', limit: '2' });
  assert.deepEqual(page.body.entries.map((e) => e.seq), [2, 3]);
  assert.equal((await core.pull({ token: TOKEN, after: '4' })).body.entries.length, 0);
});

test('push is idempotent: duplicate ids are ignored, never errors', async () => {
  const { core, store } = room();
  await core.push({ token: TOKEN, bodyText: body([env('a'), env('b')]) });
  const again = await core.push({ token: TOKEN, bodyText: body([env('b'), env('a'), env('c'), env('c')]) });
  assert.deepEqual([again.status, again.body.accepted, again.body.head], [200, 1, 3]);
  assert.equal(store.size, 3);
  const empty = await core.push({ token: TOKEN, bodyText: body([]) });
  assert.deepEqual([empty.status, empty.body.accepted], [200, 0]);
});

test('the first push claims the room; other tokens get 401, unknown rooms 404', async () => {
  const { core } = room();
  assert.deepEqual((await core.pull({ token: TOKEN })).status, 404, 'no auto-create on pull');
  assert.equal((await core.live({ token: TOKEN })).status, 404);
  assert.equal((await core.push({ token: TOKEN, bodyText: body([env('a')]) })).status, 200);
  assert.equal((await core.push({ token: OTHER, bodyText: body([env('x')]) })).status, 401);
  assert.equal((await core.pull({ token: OTHER })).status, 401);
  assert.equal((await core.live({ token: OTHER })).status, 401);
  assert.equal(await core.live({ token: TOKEN }), null, 'right token may go live');
  for (const bad of [undefined, '', 'short', `${TOKEN}x`]) {
    assert.equal((await core.pull({ token: bad })).status, 401);
  }
  assert.equal((await core.pull({ token: TOKEN })).body.entries.length, 1, 'the rejected push stored nothing');
});

test('only a hash of the token is kept', async () => {
  const { core, store } = room();
  await core.push({ token: TOKEN, bodyText: body([env('a')]) });
  assert.equal(store.tokenHash(), await R.hashToken(TOKEN));
  assert.notEqual(store.tokenHash(), TOKEN);
  assert.match(store.tokenHash(), /^[0-9a-f]{64}$/);
});

test('envelopes stamped more than MAX_DRIFT_MS ahead are refused one by one', async () => {
  const { core } = room();
  const r = await core.push({
    token: TOKEN,
    bodyText: body([env('ok'), env('edge', NOW + R.MAX_DRIFT_MS), env('ahead', NOW + R.MAX_DRIFT_MS + 1), env('year', NOW + 365 * 86_400_000)]),
  });
  assert.deepEqual([r.status, r.body.accepted, r.body.rejected], [200, 2, ['ahead', 'year']]);
  assert.deepEqual((await core.pull({ token: TOKEN })).body.entries.map((e) => e.id), ['ok', 'edge']);
});

test('malformed requests are rejected with clear errors', async () => {
  const { core } = room();
  const cases = [
    ['not json', '{', 400, 'bad_json'],
    ['no list', JSON.stringify({ envelopes: {} }), 400, 'bad_request'],
    ['bad id', body([{ ...env('a'), id: 'has space' }]), 400, 'bad_envelope'],
    ['negative wall', body([{ ...env('a'), wall: -1 }]), 400, 'bad_envelope'],
    ['wall as text', body([{ ...env('a'), wall: '1' }]), 400, 'bad_envelope'],
    ['c not base64', body([{ ...env('a'), c: 'not base64!' }]), 400, 'bad_envelope'],
    ['empty c', body([{ ...env('a'), c: '' }]), 400, 'bad_envelope'],
  ];
  for (const [label, text, status, code] of cases) {
    const r = await core.push({ token: TOKEN, bodyText: text });
    assert.deepEqual([r.status, r.body.error], [status, code], label);
  }
  assert.equal((await core.pull({ token: TOKEN })).status, 404, 'nothing was created by bad pushes');
  await core.push({ token: TOKEN, bodyText: body([env('a')]) });
  assert.equal((await core.pull({ token: TOKEN, after: '-1' })).status, 400);
  assert.equal((await core.pull({ token: TOKEN, after: 'x' })).status, 400);
  assert.equal((await core.pull({ token: TOKEN, limit: '0' })).status, 400);
  assert.equal((await core.pull({ token: TOKEN, limit: '99999' })).status, 200, 'large limits are clamped');
});

test('size and count limits', async () => {
  const { core } = room({ maxBodyBytes: 2000, maxEnvelopesPerPush: 3, maxEnvelopeChars: 100, pullLimitMax: 2 });
  assert.equal((await core.push({ token: TOKEN, bodyText: 'x'.repeat(2001) })).status, 413);
  const many = await core.push({ token: TOKEN, bodyText: body([env('a'), env('b'), env('c'), env('d')]) });
  assert.deepEqual([many.status, many.body.error], [413, 'too_many']);
  const big = await core.push({ token: TOKEN, bodyText: body([{ ...env('a'), c: 'A'.repeat(104) }]) });
  assert.equal(big.status, 400);
  await core.push({ token: TOKEN, bodyText: body([env('a'), env('b'), env('c')]) });
  assert.equal((await core.pull({ token: TOKEN, limit: '50' })).body.entries.length, 2, 'pull limit capped');
});

test('a full room says so and stores nothing more', async () => {
  const { core } = room({ maxEntriesPerRoom: 2 });
  await core.push({ token: TOKEN, bodyText: body([env('a'), env('b')]) });
  const r = await core.push({ token: TOKEN, bodyText: body([env('c')]) });
  assert.deepEqual([r.status, r.body.error], [507, 'room_full']);
  assert.match(r.body.message, /full/);
  assert.equal((await core.pull({ token: TOKEN })).body.head, 2);
});

test('per-room rate limit with Retry-After, refilling over time', async () => {
  const { core, advance } = room({ rateCapacity: 3, rateRefillPerSec: 1 });
  await core.push({ token: TOKEN, bodyText: body([env('a')]) });
  assert.equal((await core.pull({ token: TOKEN })).status, 200);
  assert.equal((await core.pull({ token: TOKEN })).status, 200);
  const r = await core.pull({ token: TOKEN });
  assert.deepEqual([r.status, r.body.error, r.headers['Retry-After']], [429, 'rate_limited', '1']);
  advance(1000);
  assert.equal((await core.pull({ token: TOKEN })).status, 200);
});

test('bearer and WebSocket protocol tokens', () => {
  assert.equal(R.bearer(`Bearer ${TOKEN}`), TOKEN);
  for (const bad of [null, '', TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN} `, `Bearer short`]) assert.equal(R.bearer(bad), null);
  assert.equal(R.protocolToken(`peek-sync.v1, bearer.${TOKEN}`), TOKEN);
  assert.equal(R.protocolToken(`bearer.${TOKEN}`), null, 'must offer the app protocol too');
  assert.equal(R.protocolToken('peek-sync.v1'), null);
  assert.equal(R.protocolToken(`peek-sync.v1, bearer.short`), null);
});

test('CORS origins: exact entries and :* port wildcards only', () => {
  const list = 'https://tcjabc.github.io,http://localhost:*,https://localhost,capacitor://localhost';
  for (const ok of ['https://tcjabc.github.io', 'http://localhost', 'http://localhost:8080', 'https://localhost', 'capacitor://localhost']) {
    assert.equal(R.originAllowed(ok, list), true, ok);
  }
  for (const no of ['https://evil.github.io', 'https://tcjabc.github.io.evil.com', 'http://localhost.evil.com', 'http://localhost:80x',
    'https://localhost:8443', 'http://127.0.0.1:8080', 'null', '', null]) {
    assert.equal(R.originAllowed(no, list), false, String(no));
  }
});

test('room ids must be 128-bit hex', () => {
  assert.equal(R.isRoomId('0123456789abcdef0123456789abcdef'), true);
  for (const bad of ['0123456789ABCDEF0123456789ABCDEF', 'short', '0123456789abcdef0123456789abcdeg', '../x']) assert.equal(R.isRoomId(bad), false);
});
