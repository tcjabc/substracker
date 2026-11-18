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
