// Mixed-version scenarios for feature L's colour values: what a frozen 1.19.0 device (tests/legacy-1.19.0/)
// really does with `slot` and `auto` on a group's colour value { name, swatch, slot, auto }, through
// sync and backup import, against the current js/ (tests/helpers/mixed-sync.js). Loaded by
// tests/mixed-version.node.test.js and tests/mixed-version-tz.node.test.js. Names are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHousehold } from './helpers/mixed-sync.js';

const VALUE = Object.freeze({ name: 'Gaming', swatch: 'w8', slot: 7, auto: true });

async function setup() {
  const h = await createHousehold();
  const C = await h.device('current', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  const { colorField, SETTINGS_ID } = C.mod.storage;
  C.writeFields(SETTINGS_ID, { [colorField('Gaming')]: { ...VALUE } });
  await h.syncAll();
  return { h, C, L, field: colorField('Gaming') };
}
const fileWith = (groupColors, extra = {}) => JSON.stringify({
  app: 'substracker', schemaVersion: 5, exportedAt: '2026-11-19T00:00:00.000Z',
  items: [{ id: 'g1', type: 'expense', name: 'Switch Online', price: 120, currency: 'TWD', cycle: 'annual', nextRenewal: '2027-03-01', date: '', category: 'Gaming', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }],
  settings: { groupColors, ...extra },
});

test('1.19.0 and sync: slot and auto on a colour value are stored, kept and shown as a pick of the w colour', async () => {
  const { L, C, field } = await setup();
  assert.deepEqual(L.settingsRecord().fields[field], VALUE, 'stored with every key');
  assert.deepEqual(L.settings().groupColors, { Gaming: 'w8' }, '1.19.0 reads { name, swatch } only');
  assert.deepEqual(L.report().skipped, []);
  assert.deepEqual(C.settings().groupSlots, { Gaming: 7 });
});

test('1.19.0 picking a colour writes { name, swatch }: slot and auto are gone for every device', async () => {
  const { h, L, C, field } = await setup();
  L.choose({ groupColors: { Gaming: 'g6' } });
  await h.syncAll();
  for (const d of [L, C]) assert.deepEqual(d.settingsRecord().fields[field], { name: 'Gaming', swatch: 'g6' }, d.name);
  assert.equal(C.settings().groupSlots, undefined, 'no slot left: the current reader sees a g pick');
});

test('1.19.0 importing a backup with the SAME colour rewrites the value and loses slot and auto (merge and replace)', async () => {
  for (const mode of ['merge', 'replace']) {
    const { h, L, C, field } = await setup();
    const before = L.s.made.length;
    L.importBackup(fileWith({ Gaming: 'w8' }), mode);
    const ops = L.s.made.slice(before).filter((o) => o.f === field);
    assert.equal(ops.length, 1, `${mode}: one op for the matching colour`);
    assert.deepEqual(ops[0].v, { name: 'Gaming', swatch: 'w8' });
    await h.syncAll();
    for (const d of [L, C]) assert.deepEqual(d.settingsRecord().fields[field], { name: 'Gaming', swatch: 'w8' }, `${mode} ${d.name}: slot and auto stripped`);
  }
});

test('the current import of the same backup leaves the value alone, slot and auto included', async () => {
  for (const mode of ['merge', 'replace']) {
    const { C, field } = await setup();
    const before = C.s.made.length;
    C.importBackup(fileWith({ Gaming: 'w8' }), mode);
    assert.ok(!C.s.made.slice(before).some((o) => o.f === field), `${mode}: no op for it`);
    assert.deepEqual(C.settingsRecord().fields[field], VALUE);
  }
});

test('1.19.0 importing a backup without that colour: merge keeps it, replace clears it', async () => {
  for (const [mode, want] of [['merge', VALUE], ['replace', null]]) {
    const { h, L, C, field } = await setup();
    L.importBackup(fileWith({ Other: 'g1' }), mode);
    await h.syncAll();
    for (const d of [L, C]) assert.deepEqual(d.settingsRecord().fields[field], want, `${mode} ${d.name}`);
  }
});

test('1.19.0 importing a backup with groupSlots ignores them (and the colour without a slot)', async () => {
  const { L, field } = await setup();
  L.importBackup(fileWith({ Pets: 'w3' }, { groupSlots: { Pets: 17, Gaming: 7 } }), 'merge');
  const pets = L.settingsRecord().fields[L.mod.storage.colorField('Pets')];
  assert.deepEqual(pets, { name: 'Pets', swatch: 'w3' }, 'written without its slot');
  assert.deepEqual(L.settingsRecord().fields[field], VALUE, 'a colour the file doesn\'t name is untouched');
});

/* ------------------------------------------------------------------ Shared slots across devices */

const { slotStart, presetFor } = await import('../js/group-slots.js');
const gItem = (id, category, over = {}) => ({
  id, type: 'expense', name: `Item ${id}`, price: 100, currency: 'TWD', cycle: 'monthly', nextRenewal: '2026-12-01', date: '',
  category, notes: '', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});
/** Two made-up group names whose probe starts at the same slot (and that are no default group). */
function sameStart() {
  const seen = new Map();
  for (let i = 0; ; i++) {
    const n = `Grp ${i}`;
    if (presetFor(n)) continue;
    const s = slotStart(n);
    if (seen.has(s)) return [seen.get(s), n];
    seen.set(s, n);
  }
}
/** Sync and let every current device run its slot step, until nothing more is written. */
async function settle(h, devices) {
  for (let round = 0; round < 8; round++) {
    await h.syncAll(2);
    let writes = 0;
    for (const d of devices) writes += d.ensureSlots().length;
    if (!writes) { await h.syncAll(2); return round; }
  }
  throw new Error('slots did not settle');
}
const slotOfGroup = (d, name) => d.settingsRecord()?.fields?.[d.mod.storage.colorField(name)];

test('two devices add groups offline at once onto the same slot: after sync the later one moves, and both agree', async () => {
  const h = await createHousehold();
  const A = await h.device('devA', { version: 'current' });
  const B = await h.device('devB', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  const [first, second] = sameStart();
  A.offline(); B.offline();
  A.save(gItem('a1', first));
  assert.deepEqual(A.ensureSlots().map((w) => w.name), [first]);
  await new Promise((r) => setTimeout(r, 5)); // B's stamp is later
  B.save(gItem('b1', second));
  assert.deepEqual(B.ensureSlots().map((w) => w.name), [second]);
  assert.equal(slotOfGroup(A, first).slot, slotOfGroup(B, second).slot, 'both took the same slot offline');
  A.online(); B.online();
  await settle(h, [A, B]);
  for (const d of [A, B, L]) assert.deepEqual(d.settingsRecord().fields, A.settingsRecord().fields, `${d.name}: the same record`);
  const s1 = slotOfGroup(A, first);
  const s2 = slotOfGroup(A, second);
  assert.equal(s1.slot, slotStart(first), 'the earlier one keeps its slot');
  assert.notEqual(s2.slot, s1.slot, 'the later one moved');
  assert.equal(s2.auto, true);
  assert.deepEqual(L.settings().groupColors, { [first]: `w${s1.slot + 1}`, [second]: `w${s2.slot + 1}` }, '1.19.0 draws the same colours (as picks of w keys)');
});

test('the same new name on two devices offline: the same slot, one field, nothing to repair', async () => {
  const h = await createHousehold();
  const A = await h.device('devA', { version: 'current' });
  const B = await h.device('devB', { version: 'current' });
  A.offline(); B.offline();
  A.save(gItem('a1', 'Pets'));
  B.save(gItem('b1', 'Pets'));
  const wa = A.ensureSlots();
  const wb = B.ensureSlots();
  assert.deepEqual(wa, wb, 'the same slot from the same state');
  A.online(); B.online();
  const rounds = await settle(h, [A, B]);
  assert.equal(rounds, 0, 'no repair needed');
  assert.deepEqual(slotOfGroup(A, 'Pets'), slotOfGroup(B, 'Pets'));
  assert.equal(slotOfGroup(A, 'Pets').slot, slotStart('Pets'));
});

test('a 1.19.0 device strips slot and auto during a clash: the stripped group counts as picked and the other moves', async () => {
  const h = await createHousehold();
  const A = await h.device('devA', { version: 'current' });
  const B = await h.device('devB', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  const [first, second] = sameStart();
  A.offline(); B.offline();
  A.save(gItem('a1', first));
  A.ensureSlots();
  await new Promise((r) => setTimeout(r, 5));
  B.save(gItem('b1', second));
  B.ensureSlots();
  B.online();
  await h.syncAll(1);
  await L.sync();
  // The 1.19.0 device imports a backup with the same colour for the later group: slot and auto go.
  const swatch = L.settings().groupColors[second];
  L.importBackup(JSON.stringify({ app: 'substracker', schemaVersion: 4, exportedAt: '2026-11-19T00:00:00.000Z', items: [gItem('b1', second)], settings: { groupColors: { [second]: swatch } } }), 'merge');
  assert.deepEqual(slotOfGroup(L, second), { name: second, swatch });
  await L.sync();
  A.online();
  await settle(h, [A, B]);
  for (const d of [A, B, L]) assert.deepEqual(d.settingsRecord().fields, A.settingsRecord().fields, `${d.name}: the same record`);
  assert.deepEqual(slotOfGroup(A, second), { name: second, swatch }, 'the stripped group stays where it is, a pick now');
  assert.notEqual(slotOfGroup(A, first).slot, Number(swatch.slice(1)) - 1, 'the earlier automatic group moved instead');
  assert.equal(slotOfGroup(A, first).auto, true);
});

test('a group made on 1.19.0 gets its slot from the first current device that sees it, and 1.19.0 then draws it', async () => {
  const h = await createHousehold();
  const C = await h.device('current', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  L.save(gItem('l1', 'Housing'));
  await settle(h, [C]);
  assert.deepEqual(slotOfGroup(C, 'Housing'), { name: 'Housing', swatch: 'w3', slot: 2, auto: true }, 'the default group\'s fixed slot');
  assert.equal(L.settings().groupColors.Housing, 'w3');
  assert.equal(L.ensureSlots().length, 0, '1.19.0 has no slot step');
});

test('more than 15 groups: colours repeat, nothing keeps moving, and every device agrees', async () => {
  const h = await createHousehold();
  const A = await h.device('devA', { version: 'current' });
  const B = await h.device('devB', { version: 'current' });
  for (let i = 0; i < 18; i++) A.save(gItem(`x${i}`, `Many ${i}`));
  A.ensureSlots();
  const rounds = await settle(h, [A, B]);
  assert.ok(rounds <= 1, `settled at once (${rounds})`);
  const slots = Array.from({ length: 18 }, (_, i) => slotOfGroup(B, `Many ${i}`).slot);
  assert.equal(new Set(slots).size, 15, 'all 15 slots in use');
  assert.equal(slots.length - new Set(slots).size, 3, 'three colours repeat');
  assert.deepEqual(A.settingsRecord().fields, B.settingsRecord().fields);
  assert.equal(B.ensureSlots().length, 0);
});

test('an old g pick holds no slot: a new group can take any slot, and the pick is never moved', async () => {
  const h = await createHousehold();
  const C = await h.device('current', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  L.save(gItem('l1', 'Tea'));
  L.choose({ groupColors: { Tea: 'g6' } });
  C.save(gItem('c1', 'Food'));
  await settle(h, [C]);
  assert.deepEqual(slotOfGroup(C, 'Tea'), { name: 'Tea', swatch: 'g6' }, 'kept exactly as picked');
  assert.equal(slotOfGroup(C, 'Food').slot, 11, 'Food takes its fixed slot');
});
