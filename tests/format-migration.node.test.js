// Format 5's first-launch step, the pure parts (js/format-migration.js, js/legacy-step.js) and the
// step against the mixed-version harness (tests/helpers/mixed-sync.js, with the frozen 1.19.0
// modules). The IndexedDB transaction itself, with failures injected at each step, is in
// tests/format-migration.html. Names and amounts are made up. Run with `npm test`; it also runs in
// America/New_York (tests/format-migration-tz.node.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fm from '../js/format-migration.js';
import * as legacyStep from '../js/legacy-step.js';
import * as storage from '../js/storage.js';
import * as core from '../js/sync-core.js';
import { slotsFromRecord, readValue, presetFor, slotStart } from '../js/group-slots.js';
import { createHousehold } from './helpers/mixed-sync.js';

const frozenUtil = await import('./legacy-1.19.0/util.js');
const frozenCalc = await import('./legacy-1.19.0/insights-calc.js');

const { colorField, SETTINGS_ID } = storage;
const pad = (n) => String(n).padStart(2, '0');
const NOW = new Date(2026, 10, 21, 10, 0);
const base = { type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const item = (id, over = {}) => ({ ...base, id, name: `Item ${id}`, price: 100, cycle: 'monthly', nextRenewal: '2026-12-01', ...over });

/** Items on every month end, mid-month and the 1st over three years, each cycle, expense and income. */
function wideItems() {
  const out = [];
  for (let y = 2025; y <= 2027; y++) for (let m = 1; m <= 12; m++) for (const d of [1, 15, 28, 29, 30, 31]) {
    const date = `${y}-${pad(m)}-${pad(d)}`;
    for (const cycle of ['monthly', 'annual', 'once']) for (const type of ['expense', 'income']) {
      out.push(item(`${date}-${cycle}-${type}`, { type, cycle, price: 12.5, nextRenewal: cycle === 'once' ? '' : date, date: cycle === 'once' ? date : '' }));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 1.19.0's rules, kept */

test('js/legacy-step.js gives exactly what the frozen 1.19.0 modules give', () => {
  const items = [...wideItems(), item('u', { nextRenewal: '' }), item('r', { nextRenewal: '2026-02-30' }), item('x', { price: NaN })];
  for (const now of [NOW, new Date(2028, 1, 29), new Date(2026, 0, 31, 23, 59)]) {
    for (const s of items) {
      assert.equal(String(legacyStep.nextRenewal(s, now)), String(frozenUtil.nextRenewal(s, now)), `next ${s.id}`);
      for (let k = -6; k <= 18; k++) {
        const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
        const [y, m] = [d.getFullYear(), d.getMonth()];
        assert.equal(legacyStep.dueInMonth(s, y, m), frozenCalc.dueInMonth(s, y, m), `due ${s.id} ${y}-${m}`);
        assert.equal(legacyStep.incomeInMonth(s, y, m), frozenCalc.incomeInMonth(s, y, m), `income ${s.id} ${y}-${m}`);
        // 1.19.0's calendar (not among the frozen modules): nextRenewal's day from the stored month on, the clamp before.
        const days = legacyStep.stepDays(s, y, m);
        if (s.cycle !== 'once' && frozenUtil.parseDate(s.nextRenewal) && legacyStep.dueInMonth(s, y, m) + legacyStep.incomeInMonth(s, y, m) > 0) {
          assert.equal(days.length, 1, `one day ${s.id} ${y}-${m}`);
        }
      }
      for (const y of [2026, 2027]) assert.equal(legacyStep.amountInYear(s, y), frozenUtil.amountInYear(s, y), `year ${s.id}`);
    }
  }
});

/* ------------------------------------------------------------------ Step 1: the stepper check */

test('the stepper check finds no difference on real-shaped items (month ends, 29 February, undated, income, one-offs)', () => {
  const items = [...wideItems(), item('u', { nextRenewal: '' }), item('leap', { cycle: 'annual', nextRenewal: '2024-02-29' }), item('old', { nextRenewal: '1990-01-31' })];
  for (const now of [NOW, new Date(2026, 0, 31, 23, 59), new Date(2028, 1, 29, 0, 30), new Date(2026, 2, 8, 2, 30), new Date(2026, 10, 1, 1, 30)]) {
    const r = fm.stepperCheck(items, now);
    assert.equal(r.diff, 0, `no difference at ${now.toISOString()} (first: ${r.first})`);
    assert.equal(r.checked, items.length);
  }
});

test('the stepper check sets a repeat aside (counted), and skips only 1.19.0\'s own faults', () => {
  const items = [
    item('w', { repeat: { every: 1, unit: 'week' } }), // from a format-5 file: compared on its cycle
    item('y99', { nextRenewal: '0050-03-01' }), // 1.19.0 reads years 0–99 as 1900–1999
    item('far', { nextRenewal: '1876-01-15' }), // past 1.19.0's 1200-step walk (docs F13)
    item('fine', { nextRenewal: '1990-01-31' }),
  ];
  const r = fm.stepperCheck(items, NOW);
  assert.deepEqual(r, { checked: 2, diff: 0, skipped: 2, custom: 1, first: null });
});

test('the stepper check does see a difference: a stepper off by one day, by a month, or a wrong total', () => {
  const items = [item('m', { nextRenewal: '2026-01-31' }), item('a', { cycle: 'annual', nextRenewal: '2026-03-15' })];
  const offByDay = { ...fm.CURRENT, nextRenewal: (s, now) => { const d = fm.CURRENT.nextRenewal(s, now); return d && new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); } };
  assert.deepEqual([fm.stepperCheck(items, NOW, offByDay).diff, fm.stepperCheck(items, NOW, offByDay).first], [2, 'next date']);
  const noFeb = { ...fm.CURRENT, stepDays: (s, y, m) => (m === 1 ? [] : fm.CURRENT.stepDays(s, y, m)) };
  assert.equal(fm.stepperCheck(items, NOW, noFeb).first, 'calendar days');
  const double = { ...fm.CURRENT, dueInMonth: (s, y, m) => 2 * fm.CURRENT.dueInMonth(s, y, m) };
  assert.equal(fm.stepperCheck(items, NOW, double).first, 'cash due');
  const year = { ...fm.CURRENT, yearTotal: () => 1 };
  assert.equal(fm.stepperCheck(items, NOW, year).first, 'yearly total');
});

/* ------------------------------------------------------------------ Step 2: the colour plan */

const dev = 'device-a';
const rec = (fields, stamp = '000001700000000-000000-other') => ({ id: SETTINGS_ID, fields, ts: Object.fromEntries(Object.keys(fields).map((k) => [k, stamp])) });
const picked = (name, swatch, slot) => ({ [colorField(name)]: slot === undefined ? { name, swatch } : { name, swatch, slot } });
const valueOf = (fields, name) => fields[colorField(name)];

test('an empty database plans nothing (and only the version note gets written)', () => {
  const plan = fm.planColours({ items: [], record: null, autoColors: {} });
  assert.deepEqual(plan.fields, {});
  const replica = { clock: core.newClock(dev), records: new Map() };
  const ops = storage.versionNoteOps(replica, { deviceId: dev, version: '1.23.0', fmt: 5, now: NOW.getTime() });
  assert.deepEqual(ops.map((o) => o.f), [storage.versionNoteField(dev)]);
  assert.deepEqual(ops[0].v, { v: '1.23.0', fmt: 5, at: '2026-11-21' });
  const back = replica.records.get(SETTINGS_ID);
  assert.equal(fm.verifyFormatMigration({ record: back, planned: {}, stamps: {}, items: [], noteField: storage.versionNoteField(dev) }), null);
});

test('this device\'s automatic colours become shared slots, exactly the colours it shows (auto: true)', () => {
  const items = [item('1', { category: 'Pets' }), item('2', { category: 'Garden' }), item('3', { category: '' }), item('i', { type: 'income', category: 'Salary' })];
  const plan = fm.planColours({ items, record: null, autoColors: { Pets: 'w3', Garden: 'w12', Uncategorised: 'w7', Salary: 'w1' } });
  assert.deepEqual(valueOf(plan.fields, 'Pets'), { name: 'Pets', swatch: 'w3', slot: 2, auto: true });
  assert.deepEqual(valueOf(plan.fields, 'Garden'), { name: 'Garden', swatch: 'w12', slot: 11, auto: true });
  assert.deepEqual(valueOf(plan.fields, 'Uncategorised'), { name: 'Uncategorised', swatch: 'w7', slot: 6, auto: true });
  assert.equal(valueOf(plan.fields, 'Salary'), undefined, 'income has no colour');
  assert.equal(plan.adopted.length, 3);
});

test('a database with only picked colours plans nothing: old g picks and w picks stay as they are', () => {
  const items = [item('1', { category: 'Pets' }), item('2', { category: 'Garden' }), item('3', { category: 'Travel' })];
  const record = rec({ ...picked('Pets', 'g6'), ...picked('Garden', 'w4'), ...picked('Travel', 'w9', 8) });
  const plan = fm.planColours({ items, record, autoColors: { Pets: 'w1', Garden: 'w2', Travel: 'w3' } });
  assert.deepEqual(plan.fields, {}, 'no field for a picked group, whatever this device showed before');
  assert.equal(fm.verifyFormatMigration({ record: { ...record, fields: { ...record.fields, n: { v: '1.23.0', fmt: 5, at: '2026-11-21' } }, ts: { ...record.ts, n: record.ts[colorField('Pets')] } }, items, noteField: 'n' }), null, 'a g pick and w picks resolve');
});

test('a household record that already holds slot values: those groups are left alone; a clash with them probes', () => {
  const items = [item('1', { category: 'Pets' }), item('2', { category: 'Garden' }), item('3', { category: 'Boats' })];
  const record = rec({ [colorField('Pets')]: { name: 'Pets', swatch: 'w5', slot: 4, auto: true }, ...picked('Garden', 'w3', 2) });
  // This device showed Pets in w1 (another device's slot wins), and Boats in w3, which Garden holds.
  const plan = fm.planColours({ items, record, autoColors: { Pets: 'w1', Boats: 'w3', Garden: 'w8' } });
  assert.deepEqual(Object.keys(plan.fields), [colorField('Boats')], 'only the group the record lacks');
  const boats = valueOf(plan.fields, 'Boats');
  assert.notEqual(boats.slot, 2, 'not the slot Garden holds');
  assert.notEqual(boats.slot, 4, 'nor the one Pets holds');
  assert.equal(boats.auto, true);
});

test('undated items still have groups, so their colours are adopted too', () => {
  const items = [item('1', { category: 'Pets', nextRenewal: '' }), item('2', { category: 'Pets', cycle: 'once', date: '' })];
  const plan = fm.planColours({ items, record: null, autoColors: { Pets: 'w10' } });
  assert.deepEqual(valueOf(plan.fields, 'Pets'), { name: 'Pets', swatch: 'w10', slot: 9, auto: true });
});

test('a default group keeps the colour this device showed; a group with no colour at all gets one as the app gives it', () => {
  const items = [item('1', { category: 'Food' }), item('2', { category: 'Knitting' })];
  const plan = fm.planColours({ items, record: null, autoColors: { Food: 'w2' } });
  assert.equal(valueOf(plan.fields, 'Food').slot, 1, 'adopted as shown, not moved to its preset slot');
  assert.equal(valueOf(plan.fields, 'Knitting').slot, slotStart('Knitting') === 1 ? 2 : slotStart('Knitting'), 'the probe, avoiding Food');
  assert.ok(presetFor('Food'));
});

test('two groups this device showed in the same colour (past 15): the second probes for a free slot', () => {
  const items = [item('1', { category: 'Aa' }), item('2', { category: 'Bb' })];
  const plan = fm.planColours({ items, record: null, autoColors: { Aa: 'w4', Bb: 'w4' } });
  const [a, b] = [valueOf(plan.fields, 'Aa').slot, valueOf(plan.fields, 'Bb').slot];
  assert.equal(a, 3);
  assert.notEqual(b, 3);
});

test('names a colour value can\'t carry (over 40 characters) are left out, so no op is ever refused', () => {
  const long = 'L'.repeat(41);
  const plan = fm.planColours({ items: [item('1', { category: long })], record: null, autoColors: { [long]: 'w2' } });
  assert.deepEqual(plan.fields, {});
});

test('idempotent: planning again on the result plans nothing, and the note isn\'t written twice', () => {
  const items = [item('1', { category: 'Pets' }), item('2', { category: 'Garden' }), item('3', { category: 'Food' })];
  const replica = { clock: core.newClock(dev), records: new Map([[SETTINGS_ID, rec(picked('Garden', 'g2'))]]) };
  const first = fm.planColours({ items, record: replica.records.get(SETTINGS_ID), autoColors: { Pets: 'w6', Food: 'w9' } });
  const ops = [...core.setFields(replica, SETTINGS_ID, first.fields, { now: NOW.getTime() }),
    ...storage.versionNoteOps(replica, { deviceId: dev, version: '1.23.0', fmt: 5, now: NOW.getTime() })];
  assert.equal(ops.length, 3, 'Pets, Food and the note');
  const again = fm.planColours({ items, record: replica.records.get(SETTINGS_ID), autoColors: { Pets: 'w6', Food: 'w9' } });
  assert.deepEqual(again.fields, {});
  assert.deepEqual(core.setFields(replica, SETTINGS_ID, again.fields, { now: NOW.getTime() }), []);
  assert.deepEqual(storage.versionNoteOps(replica, { deviceId: dev, version: '1.23.0', fmt: 5, now: NOW.getTime() + 86400000 }), []);
  assert.deepEqual(replica.records.get(SETTINGS_ID).fields[colorField('Garden')], { name: 'Garden', swatch: 'g2' }, 'the g pick is never rewritten');
});

test('every value the step writes passes 1.19.0\'s checks (no op is ever refused and lost)', async () => {
  const legacy = await import('./legacy-1.19.0/storage.js');
  const items = [item('1', { category: 'Pets' }), item('2', { category: '居住' }), item('3', { category: '🐟 Fish' })];
  const replica = { clock: core.newClock(dev), records: new Map() };
  const plan = fm.planColours({ items, record: null, autoColors: { Pets: 'w15', 居住: 'w3', '🐟 Fish': 'w1' } });
  const ops = [...core.setFields(replica, SETTINGS_ID, plan.fields, { now: NOW.getTime() }),
    ...storage.versionNoteOps(replica, { deviceId: dev, version: '1.23.0', fmt: 5, now: NOW.getTime() })];
  const out = legacy.applyRemoteOps({ clock: core.newClock('old'), records: new Map() }, ops, NOW.getTime());
  assert.deepEqual([out.changed, out.skipped], [ops.length, 0]);
});

/* ------------------------------------------------------------------ Step 3: the read-back check */

test('the read-back check: planned values there; a newer value from elsewhere is fine; anything lost or older is not', () => {
  const items = [item('1', { category: 'Pets' })];
  const f = colorField('Pets');
  const mine = '000001800000000-000000-device-a';
  const v = { name: 'Pets', swatch: 'w3', slot: 2, auto: true };
  const note = { v: '1.23.0', fmt: 5, at: '2026-11-21' };
  const good = { id: SETTINGS_ID, fields: { [f]: v, n: note }, ts: { [f]: mine, n: mine } };
  const args = { planned: { [f]: v, n: note }, stamps: { [f]: mine, n: mine }, items, noteField: 'n' };
  assert.equal(fm.verifyFormatMigration({ record: good, ...args }), null);
  const newer = { ...good, fields: { ...good.fields, [f]: { name: 'Pets', swatch: 'g4' } }, ts: { ...good.ts, [f]: '000001800000001-000000-device-b' } };
  assert.equal(fm.verifyFormatMigration({ record: newer, ...args }), null, 'another device picked since: kept, not lost');
  const changed = { ...good, fields: { ...good.fields, [f]: { ...v, slot: 3, swatch: 'w4' } } };
  assert.match(fm.verifyFormatMigration({ record: changed, ...args }), /1 of 2 planned fields/);
  const older = { ...good, ts: { ...good.ts, [f]: '000001700000000-000000-device-b' } };
  assert.match(fm.verifyFormatMigration({ record: older, ...args }), /planned fields/);
  const missing = { ...good, fields: { n: note }, ts: { n: mine } };
  assert.match(fm.verifyFormatMigration({ record: missing, ...args }), /planned fields/);
  assert.match(fm.verifyFormatMigration({ record: { ...good, fields: { ...good.fields, del: false } }, ...args }), /looks like an item/);
  assert.match(fm.verifyFormatMigration({ record: null, ...args }), /no settings record/);
  assert.match(fm.verifyFormatMigration({ record: good, ...args, items: [...items, item('2', { category: 'Garden' })] }), /1 of 2 groups without a slot/);
  assert.match(fm.verifyFormatMigration({ record: { ...good, fields: { [f]: v } }, ...args, planned: { [f]: v } }), /no version note/);
});

/* ------------------------------------------------------------------ With the mixed-version harness */

/** What storage.migrateFormat writes, on a harness device: the colour plan, then the version note. */
function migrateOn(d, version = '1.23.0') {
  const record = d.settingsRecord();
  const plan = fm.planColours({ items: d.items(), record, autoColors: d.s.local.autoGroupColors ?? {} });
  const noteField = storage.versionNoteField(d.s.clock.dev);
  const ops = [...d.writeFields(SETTINGS_ID, plan.fields)];
  const cur = d.settingsRecord()?.fields?.[noteField];
  if (!(cur && cur.v === version && cur.fmt === 5)) ops.push(...d.writeFields(SETTINGS_ID, { [noteField]: { v: version, fmt: 5, at: '2026-11-21' } }));
  const planned = Object.fromEntries(ops.map((o) => [o.f, o.v]));
  const stamps = Object.fromEntries(ops.map((o) => [o.f, o.t]));
  const problem = fm.verifyFormatMigration({ record: d.settingsRecord(), planned, stamps, items: d.items(), noteField });
  return { plan, ops, problem };
}
/** Sync and let every current device run its slot step (app.js ensureGroupColors), until nothing more is written. */
async function settle(h, devices) {
  for (let round = 0; round < 8; round++) {
    await h.syncAll(2);
    let writes = 0;
    for (const d of devices) writes += d.ensureSlots().length;
    if (!writes) { await h.syncAll(2); return; }
  }
  throw new Error('slots did not settle');
}
const colourOf = (d, name) => d.settingsRecord()?.fields?.[colorField(name)];

test('harness: two devices adopting the same slots offline converge, and a 1.19.0 device shows the same colours', async () => {
  const h = await createHousehold();
  const A = await h.device('devA', { version: 'current' });
  const B = await h.device('devB', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  for (const [d, n] of [[A, 'a'], [B, 'b']]) d.save(item(`${n}1`, { category: 'Pets' }));
  A.save(item('a2', { category: 'Garden' }));
  B.save(item('b2', { category: 'Boats' }));
  await h.syncAll();
  // Before the step: each shows its own automatic colours. Pets the same on both; Garden (A) and Boats (B) both w8.
  A.setLocal({ autoGroupColors: { Pets: 'w3', Garden: 'w8', Boats: 'w11' } });
  B.setLocal({ autoGroupColors: { Pets: 'w3', Boats: 'w8', Garden: 'w12' } });
  A.offline(); B.offline();
  for (const d of [A, B]) assert.equal(migrateOn(d).problem, null, `${d.name} verified`);
  A.online(); B.online();
  await settle(h, [A, B]);
  for (const name of ['Pets', 'Garden', 'Boats']) {
    assert.deepEqual(colourOf(A, name), colourOf(B, name), `${name}: A and B agree`);
    assert.deepEqual(colourOf(L, name), colourOf(A, name), `${name}: 1.19.0 has the same value`);
  }
  assert.equal(colourOf(A, 'Pets').slot, 2, 'Pets as both showed it');
  const slots = ['Pets', 'Garden', 'Boats'].map((n) => readValue(colourOf(A, n)).slot);
  assert.equal(new Set(slots).size, 3, 'no two groups share a slot after the repair');
  assert.deepEqual(L.settings().groupColors, Object.fromEntries(['Boats', 'Garden', 'Pets'].map((n) => [n, colourOf(A, n).swatch])), '1.19.0 draws the w keys');
  for (const d of [A, B, L]) assert.deepEqual(d.report().skipped, [], `${d.name} refused nothing`);
  // Each device's note is there, read the same by both.
  assert.equal(storage.versionNotes(A.settingsRecord()).length, 2);
  assert.deepEqual(storage.versionNotes(A.settingsRecord()), storage.versionNotes(B.settingsRecord()));
});

test('harness: the step against a 1.19.0 device that keeps picking g colours: never rewritten, never moved', async () => {
  const h = await createHousehold();
  const C = await h.device('cur', { version: 'current' });
  const L = await h.device('legacy', { version: 'legacy' });
  L.save(item('l1', { category: 'Pets' }));
  L.save(item('l2', { category: 'Garden' }));
  L.choose({ groupColors: { Pets: 'g6' } });
  await h.syncAll();
  C.setLocal({ autoGroupColors: { Garden: 'w7', Pets: 'w2' } });
  const { problem, plan } = migrateOn(C);
  assert.equal(problem, null);
  assert.deepEqual(Object.keys(plan.fields), [colorField('Garden')], 'only Garden: Pets is a g pick');
  await h.syncAll();
  assert.deepEqual(colourOf(L, 'Pets'), { name: 'Pets', swatch: 'g6' });
  assert.deepEqual(colourOf(L, 'Garden'), { name: 'Garden', swatch: 'w7', slot: 6, auto: true });
  // 1.19.0 picks Garden's colour afterwards: a pick again, and the step (or the slot step) leaves it.
  L.choose({ groupColors: { Garden: 'g3' } });
  await h.syncAll();
  assert.deepEqual(migrateOn(C).plan.fields, {});
  assert.deepEqual(C.ensureSlots(), []);
  assert.deepEqual(colourOf(C, 'Garden'), { name: 'Garden', swatch: 'g3' });
  assert.deepEqual(L.report().skipped, []);
});

test('harness: a household that already holds slot values (another device migrated first) keeps them', async () => {
  const h = await createHousehold();
  const A = await h.device('devA', { version: 'current' });
  const B = await h.device('devB', { version: 'current' });
  A.save(item('a1', { category: 'Pets' }));
  await h.syncAll();
  A.setLocal({ autoGroupColors: { Pets: 'w5' } });
  assert.equal(migrateOn(A).problem, null);
  await h.syncAll();
  B.setLocal({ autoGroupColors: { Pets: 'w9' } }); // B showed it otherwise before
  const { plan, problem } = migrateOn(B);
  assert.equal(problem, null);
  assert.deepEqual(plan.fields, {}, 'B adopts nothing: the household already has Pets');
  await h.syncAll();
  assert.equal(colourOf(B, 'Pets').slot, 4, 'A\'s colour, everywhere');
});

test('harness: an empty device and a device with only picks both verify, writing just the note', async () => {
  const h = await createHousehold();
  const E = await h.device('empty', { version: 'current' });
  const P = await h.device('picks', { version: 'current' });
  P.save(item('p1', { category: 'Pets' }));
  P.choose({ groupColors: { Pets: 'g1' } });
  await h.syncAll();
  for (const d of [E, P]) {
    const before = d.s.made.length;
    const { problem, ops } = migrateOn(d);
    assert.equal(problem, null, d.name);
    assert.deepEqual(ops.map((o) => o.f), [storage.versionNoteField(d.s.clock.dev)], `${d.name}: the note only`);
    assert.equal(d.s.made.length - before, 1);
  }
  assert.deepEqual(slotsFromRecord(P.settingsRecord()).picks, new Set(['Pets']));
});
