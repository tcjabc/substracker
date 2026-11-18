// Node tests for js/group-slots.js, the shared palette slots: default groups' fixed slots, the hash
// probe, repeating past 15 groups, reading colour values (including what 1.19.0 leaves after it
// strips slot and auto), the deterministic repair, and a seeded simulation of two devices adding
// groups offline at once that must converge. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_COUNT, presetFor, slotStart, readValue, autoValue, pickSlot, repairMoves, planSlots, slotsFromRecord, slotFields,
} from '../js/group-slots.js';
import { DEFAULT_GROUPS } from '../js/services.js';
import { colorField } from '../js/storage.js';

const zeros = () => new Array(SLOT_COUNT).fill(0);
const counts = (slots) => { const c = zeros(); for (const s of slots) c[s]++; return c; };
const S = (wall, dev = 'devA') => `${String(wall).padStart(15, '0')}-000000-${dev}`;

test('default groups keep the plan\'s fixed slots (5.2)', () => {
  assert.deepEqual(Object.fromEntries(DEFAULT_GROUPS.map((g) => [g.names[0], g.slot])), {
    Housing: 2, Utilities: 13, Food: 11, Transport: 6, 'Software & cloud': 1, Entertainment: 4,
    Hobbies: 14, Education: 5, Shopping: 7, 'Health & fitness': 8, 'Insurance & finance': 10,
  });
  for (const g of DEFAULT_GROUPS) for (const n of g.names) assert.equal(pickSlot(n, zeros()), g.slot, n);
  assert.equal(presetFor('  food ')?.id, 'food', 'case and outer spaces aside');
  assert.equal(presetFor('Foods'), null);
});

test('a default group whose slot is taken, and any other group, probe from the name\'s hash', () => {
  const c = counts([2]);
  const s = pickSlot('Housing', c);
  assert.notEqual(s, 2);
  assert.equal(s, [...Array(15).keys()].map((i) => (slotStart('Housing') + i) % 15).find((k) => c[k] === 0));
  assert.equal(pickSlot('Pets', zeros()), slotStart('Pets'));
  assert.equal(slotStart('Pets'), parseInt(colorField('Pets').slice(6, 14), 16) % 15, 'from the group-name hash');
  const busy = counts([slotStart('Pets')]);
  assert.equal(pickSlot('Pets', busy), (slotStart('Pets') + 1) % 15, 'the next free one');
});

test('past 15 groups the colours repeat: the least-used slot, in probe order; free-only finds none', () => {
  const full = counts([...Array(15).keys()]);
  assert.equal(pickSlot('Pets', full), slotStart('Pets'), 'all used once: the probe start');
  full[slotStart('Pets')] = 3;
  assert.equal(pickSlot('Pets', full), (slotStart('Pets') + 1) % 15);
  assert.equal(pickSlot('Pets', counts([...Array(15).keys()]), { free: true }), null);
});

test('reading colour values: slot and auto, a w swatch without slot (1.19.0 stripped it) is a pick, g holds none', () => {
  assert.deepEqual(readValue({ name: 'x', swatch: 'w8', slot: 7, auto: true }), { slot: 7, auto: true });
  assert.deepEqual(readValue({ name: 'x', swatch: 'w8', slot: 7 }), { slot: 7, auto: false });
  assert.deepEqual(readValue({ name: 'x', swatch: 'w8' }), { slot: 7, auto: false }, 'stripped by 1.19.0: a pick of that slot');
  assert.deepEqual(readValue({ name: 'x', swatch: 'w3', slot: 17, auto: true }), { slot: 2, auto: true }, 'a later version\'s second lap draws its base');
  assert.deepEqual(readValue({ name: 'x', swatch: 'w8', slot: 6, auto: true }), { slot: 7, auto: false }, 'a slot that doesn\'t match: the swatch decides, as a pick');
  assert.equal(readValue({ name: 'x', swatch: 'g6' }), null);
  assert.equal(readValue(null), null);
  assert.deepEqual(autoValue('Pets', 4), { name: 'Pets', swatch: 'w5', slot: 4, auto: true });
});

test('the record, read for slots', () => {
  const rec = {
    id: 'settings',
    fields: {
      [colorField('A')]: { name: 'A', swatch: 'w1', slot: 0, auto: true }, [colorField('B')]: { name: 'B', swatch: 'g6' },
      [colorField('C')]: { name: 'C', swatch: 'w9' }, [colorField('D')]: null, color_bad: { name: 'E', swatch: 'w1' }, defaultCurrency: 'TWD',
    },
    ts: { [colorField('A')]: S(5) },
  };
  const { shared, picks } = slotsFromRecord(rec);
  assert.deepEqual([...shared], [['A', { slot: 0, auto: true, ts: S(5) }], ['C', { slot: 8, auto: false, ts: '' }]]);
  assert.deepEqual([...picks], ['B']);
  assert.deepEqual(slotFields([{ name: 'A', slot: 3 }]), { [colorField('A')]: { name: 'A', swatch: 'w4', slot: 3, auto: true } });
});

test('repair: the later automatic group moves; a pick never; two names of one default may share; no free slot, no move', () => {
  const m = (entries) => new Map(entries);
  const later = repairMoves(m([['Pets', { slot: 3, auto: true, ts: S(1) }], ['Garden', { slot: 3, auto: true, ts: S(2) }]]));
  assert.equal(later.length, 1);
  assert.equal(later[0].name, 'Garden');
  assert.notEqual(later[0].slot, 3);
  assert.deepEqual(repairMoves(m([['Pets', { slot: 3, auto: false, ts: S(9) }], ['Garden', { slot: 3, auto: true, ts: S(1) }]])).map((x) => x.name), ['Garden'], 'the pick stays though later');
  assert.deepEqual(repairMoves(m([['Pets', { slot: 3, auto: false, ts: S(1) }], ['Garden', { slot: 3, auto: false, ts: S(2) }]])), [], 'two picks: someone chose them');
  assert.deepEqual(repairMoves(m([['Housing', { slot: 2, auto: true, ts: S(1) }], ['居住', { slot: 2, auto: true, ts: S(2) }]])), [], 'one default group in two languages');
  const sameTs = repairMoves(m([['b', { slot: 0, auto: true, ts: S(1) }], ['a', { slot: 0, auto: true, ts: S(1) }]]));
  assert.deepEqual(sameTs.map((x) => x.name), ['b'], 'same stamp: the name first in code-point order stays');
  const full = m([...Array(15).keys()].map((k) => [`g${k}`, { slot: k, auto: true, ts: S(k) }]).concat([['extra', { slot: 0, auto: true, ts: S(99) }]]));
  assert.deepEqual(repairMoves(full), [], 'past 15: colours repeat as they are');
});

test('repair is the same on every device: order of entries doesn\'t matter', () => {
  const entries = [['Pets', { slot: 3, auto: true, ts: S(3, 'b') }], ['Garden', { slot: 3, auto: true, ts: S(2, 'a') }], ['Books', { slot: 3, auto: true, ts: S(4) }], ['Tea', { slot: 9, auto: false, ts: S(1) }]];
  const a = repairMoves(new Map(entries));
  const b = repairMoves(new Map([...entries].reverse()));
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((x) => x.name), ['Books', 'Pets'], 'later first; Garden (earliest) stays');
  assert.equal(new Set([3, ...a.map((x) => x.slot)]).size, 3, 'all apart afterwards');
});

test('planning: a new group gets a slot, avoiding the ones this device shows; old g picks and held colours get none', () => {
  const live = ['Food', 'Pets', 'Rent', 'Tea'];
  const shared = new Map([['Food', { slot: 11, auto: true, ts: S(1) }]]);
  const held = new Map([['Rent', slotStart('Pets')], ['Tea', null]]); // Rent: a local automatic colour; Tea: an old g pick
  const plan = planSlots({ live, shared, held });
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.assign.map((a) => a.name), ['Pets']);
  assert.notEqual(plan.assign[0].slot, slotStart('Pets'), 'not the slot Rent shows here');
  assert.notEqual(plan.assign[0].slot, 11);
  const again = planSlots({ live: ['Food'], shared, held: new Map() });
  assert.deepEqual(again, { assign: [], moves: [] }, 'nothing to do: nothing written');
});

/* ------------------------------------------------------------------ Two devices offline, converging */

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const word = () => Array.from({ length: 4 + Math.floor(rand() * 5) }, () => String.fromCharCode(97 + Math.floor(rand() * 26))).join('');
const PRESET_NAMES = DEFAULT_GROUPS.flatMap((g) => g.names);

/** A device's view of the record: field → { v, t }. Last write wins per field, as sync does. */
function merge(a, b) {
  const out = new Map(a);
  for (const [k, x] of b) if (!out.has(k) || x.t > out.get(k).t) out.set(k, x);
  return out;
}
const asRecord = (fields) => ({ fields: Object.fromEntries([...fields].map(([k, x]) => [k, x.v])), ts: Object.fromEntries([...fields].map(([k, x]) => [k, x.t])) });
function run(device, fields, live, clock) {
  const { shared, picks } = slotsFromRecord(asRecord(fields));
  const held = new Map([...picks].map((n) => [n, null]));
  const plan = planSlots({ live, shared: new Map([...shared].filter(([n]) => live.includes(n))), held });
  const out = new Map(fields);
  for (const { name, slot } of [...plan.assign, ...plan.moves]) out.set(colorField(name), { v: autoValue(name, slot), t: S(clock.t++, device) });
  return { fields: out, writes: plan.assign.length + plan.moves.length };
}

test('simulation: two devices add groups offline at once; after sync and repair both hold the same slots, apart where they can be', () => {
  let trials = 0;
  for (let i = 0; i < 400; i++) {
    const clock = { t: 1000 };
    const base = Array.from({ length: Math.floor(rand() * 10) }, () => (rand() < 0.3 ? PRESET_NAMES[Math.floor(rand() * PRESET_NAMES.length)] : word()));
    let start = new Map();
    ({ fields: start } = run('devA', start, [...new Set(base)], clock));
    const same = rand() < 0.2 ? word() : null; // the same new name on both
    const addA = [...new Set([...Array.from({ length: 1 + Math.floor(rand() * 3) }, word), ...(same ? [same] : [])])];
    const addB = [...new Set([...Array.from({ length: 1 + Math.floor(rand() * 3) }, () => (rand() < 0.3 ? PRESET_NAMES[Math.floor(rand() * PRESET_NAMES.length)] : word())), ...(same ? [same] : [])])];
    const live = [...new Set([...base, ...addA, ...addB])];
    let A = run('devA', start, [...new Set([...base, ...addA])], clock).fields;
    let B = run('devB', start, [...new Set([...base, ...addB])], clock).fields;
    // Sync, then each device repairs with everything it now knows, until nothing changes.
    for (let round = 0; round < 6; round++) {
      const both = merge(A, B);
      const ra = run('devA', both, live, clock);
      const rb = run('devB', both, live, clock);
      A = ra.fields;
      B = rb.fields;
      if (!ra.writes && !rb.writes) break;
    }
    const final = merge(A, B);
    assert.deepEqual(run('devA', final, live, clock).writes, 0, `trial ${i}: settled`);
    const { shared } = slotsFromRecord(asRecord(final));
    const slots = live.map((n) => shared.get(n)?.slot);
    assert.ok(slots.every((s) => Number.isInteger(s)), `trial ${i}: every live group has a slot`);
    const families = new Map();
    live.forEach((n, j) => { const f = presetFor(n)?.id ?? n; if (!families.has(slots[j])) families.set(slots[j], new Set()); families.get(slots[j]).add(f); });
    if (new Set(live.map((n) => presetFor(n)?.id ?? n)).size <= SLOT_COUNT) {
      assert.ok([...families.values()].every((f) => f.size === 1), `trial ${i}: no two groups share a slot while slots are free`);
    }
    trials++;
  }
  assert.equal(trials, 400);
});
