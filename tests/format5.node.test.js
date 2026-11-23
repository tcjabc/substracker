// Node tests for format 5's readers (docs/plan-intervals-groups.md, 4.1–4.3): the `repeat` field's
// limits and shadow cycle, sync never skipping it, backup import keeping a usable one and dropping
// only the field otherwise, and nothing in the app writing it. Run with `npm test`. This file runs
// in a time zone with DST.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../js/sync-core.js';
import * as storage from '../js/storage.js';
import { nextRenewal } from '../js/util.js';
import { stepDays, occurrences } from '../js/calendar-math.js';
import { dueInMonth, incomeInMonth, cashDue, dueEach } from '../js/insights-calc.js';
import { dueSoon } from '../js/due-soon.js';
import { readFileSync, readdirSync } from 'node:fs';
import { READ_LIMITS, isReadableInterval, shadowCycle, effectiveInterval, MONTHLY, ANNUAL } from '../js/interval.js';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const item = (over = {}) => ({
  id: 'a', type: 'expense', name: 'Pottery class', domain: '', emoji: '', plan: '', price: 150, currency: 'TWD',
  cycle: 'monthly', nextRenewal: '2026-11-19', date: '', category: 'Hobbies', notes: '', createdAt: T1, updatedAt: T1, ...over,
});
const every = (n, unit) => ({ every: n, unit });
const fileOf = (items, extra = {}) => ({ app: 'substracker', schemaVersion: 5, exportedAt: T2, items, ...extra });
let n = 0;
const replicaOf = (dev = 'devA') => ({ clock: core.newClock(dev), records: new Map() });
const opts = (now) => ({ now, newId: () => `op-${++n}` });

/* ------------------------------------------------------------------ Limits and shadow */

test('repeat limits: every 1 to 3660 days, 520 weeks, 120 months, 10 years; anything else is unreadable', () => {
  assert.deepEqual(READ_LIMITS, { day: 3660, week: 520, month: 120, year: 10 });
  for (const [unit, max] of Object.entries(READ_LIMITS)) {
    assert.ok(isReadableInterval(every(1, unit)) && isReadableInterval(every(max, unit)), `${unit} 1 and ${max}`);
    assert.equal(isReadableInterval(every(max + 1, unit)), false, `${unit} ${max + 1}`);
  }
  for (const bad of [null, undefined, 'weekly', {}, every(0, 'day'), every(1.5, 'week'), every('2', 'week'), every(2, 'fortnight'), every(-1, 'month'), every(NaN, 'day'), [1, 'week']]) {
    assert.equal(isReadableInterval(bad), false, JSON.stringify(bad));
  }
  assert.ok(isReadableInterval({ every: 2, unit: 'week', note: 'extra keys are fine' }));
});

test('shadow cycle: what 1.19.0 shows for each interval (nearer of a month or a year by period)', () => {
  const cases = [
    [every(1, 'month'), 'monthly'], [every(12, 'month'), 'annual'], [every(1, 'year'), 'annual'],
    [every(1, 'week'), 'monthly'], [every(2, 'week'), 'monthly'], [every(1, 'day'), 'monthly'],
    [every(3, 'month'), 'monthly'], [every(15, 'week'), 'monthly'], [every(105, 'day'), 'monthly'],
    [every(106, 'day'), 'annual'], [every(4, 'month'), 'annual'], [every(6, 'month'), 'annual'], [every(2, 'year'), 'annual'],
  ];
  for (const [interval, want] of cases) assert.equal(shadowCycle(interval), want, JSON.stringify(interval));
  assert.equal(shadowCycle(MONTHLY), 'monthly');
  assert.equal(shadowCycle(ANNUAL), 'annual');
  assert.equal(shadowCycle(null), 'once');
  assert.throws(() => shadowCycle({ every: 0, unit: 'day' }), TypeError);
});

/* ------------------------------------------------------------------ Sync keeps it, always */

test('sync stores any repeat value as its own field with its own stamp, never skipping the op', () => {
  const r = replicaOf();
  core.putRecord(r, 'a', { name: 'Pottery class', cycle: 'monthly' }, opts(1000));
  for (const [i, v] of [every(1, 'week'), every(2, 'fortnight'), every(9999, 'day'), 'weekly', null, { every: 1, unit: 'week', future: [1] }].entries()) {
    const op = { id: `r${i}`, rec: 'a', f: 'repeat', v, t: core.formatStamp(2000 + i, 0, 'devB'), dev: 'devB' };
    const out = storage.applyRemoteOps(r, [op], 5000);
    assert.equal(out.skipped, 0, JSON.stringify(v));
    assert.deepEqual(r.records.get('a').fields.repeat, v);
    assert.equal(r.records.get('a').ts.repeat, op.t, 'its own stamp');
  }
  // The other fields' checks are unchanged: a bad cycle is still refused.
  const bad = { id: 'c', rec: 'a', f: 'cycle', v: 7, t: core.formatStamp(9000, 0, 'devB'), dev: 'devB' };
  assert.equal(storage.applyRemoteOps(r, [bad], 10000).skipped, 1);
  // Requeueing sends it like any field.
  assert.ok(storage.requeueOps([...r.records.values()]).some((op) => op.f === 'repeat'));
});

test('saving an item never writes repeat, even when the item carries one', () => {
  assert.ok(!storage.ITEM_FIELDS.includes('repeat'), 'not one of the fields a save writes');
  assert.equal(storage.REPEAT, 'repeat');
});

/* ------------------------------------------------------------------ Backups bring it in */

test('a backup item keeps a usable repeat that agrees with its cycle, as { every, unit } only', () => {
  const parsed = storage.parseBackup(fileOf([item({ repeat: { every: 1, unit: 'week', note: 'x' } })]));
  assert.deepEqual(parsed.items[0].item.repeat, every(1, 'week'));
  const six = storage.parseBackup(fileOf([item({ cycle: 'annual', repeat: every(6, 'month') })]));
  assert.deepEqual(six.items[0].item.repeat, every(6, 'month'));
  for (const v of [3, 4]) {
    const old = storage.parseBackup({ ...fileOf([item({ repeat: every(2, 'week') })]), schemaVersion: v });
    assert.deepEqual(old.items[0].item.repeat, every(2, 'week'), `format ${v} too (a 1.19.0 backup can carry one)`);
  }
});

test('an unusable or disagreeing repeat drops only that field: the item imports as before', () => {
  for (const [label, over] of [
    ['unknown unit', { repeat: every(1, 'fortnight') }],
    ['too long', { repeat: every(121, 'month') }],
    ['not whole', { repeat: every(1.5, 'week') }],
    ['text', { repeat: 'weekly' }],
    ['null', { repeat: null }],
    ['disagrees with the cycle (weekly beside annual)', { cycle: 'annual', repeat: every(1, 'week') }],
    ['disagrees with the cycle (yearly beside monthly)', { repeat: every(1, 'year') }],
    ['on a one-off', { cycle: 'once', nextRenewal: '', date: '2026-12-24', repeat: every(1, 'week') }],
  ]) {
    const parsed = storage.parseBackup(fileOf([item(over)]));
    const got = parsed.items[0].item;
    assert.equal('repeat' in got, false, label);
    const without = storage.parseBackup(fileOf([item({ ...over, repeat: undefined })])).items[0].item;
    assert.deepEqual(got, without, `${label}: otherwise the same item`);
  }
});

test('import writes a file\'s repeat; a file item without one leaves the stored repeat alone', () => {
  const r = replicaOf();
  const plan1 = storage.planFromBackup(storage.parseBackup(fileOf([item({ repeat: every(1, 'week') })])), [], {}).replace;
  const ops1 = storage.importOps(r, plan1, opts(1000));
  assert.ok(ops1.some((op) => op.f === 'repeat'));
  assert.deepEqual(r.records.get('a').fields.repeat, every(1, 'week'));
  // A newer copy of the same item without repeat (say a 1.19.0 backup): it wins the merge, and only
  // the fields it has are written.
  const live = [storage.toItem(r.records.get('a'))];
  const newer = storage.parseBackup(fileOf([item({ price: 160, updatedAt: T2 })]));
  for (const mode of ['merge', 'replace']) {
    const ops = storage.importOps(r, storage.planFromBackup(newer, live, {})[mode], opts(2000));
    assert.ok(!ops.some((op) => op.f === 'repeat'), `${mode}: no op for repeat`);
    assert.deepEqual(r.records.get('a').fields.repeat, every(1, 'week'), `${mode}: the stored repeat stays`);
    assert.equal(r.records.get('a').fields.price, 160);
  }
});

/* ------------------------------------------------------------------ Which interval counts */

const S = (wall, dev = 'devA') => core.formatStamp(wall, 0, dev);

test('effective interval: repeat counts only when it agrees with the cycle and is not older (8 cases)', () => {
  const weekly = every(1, 'week');
  // [cycle, repeat, stamps, want]
  const cases = [
    ['monthly', weekly, undefined, weekly], // agrees, no stamps (a file, a plain item)
    ['annual', weekly, undefined, ANNUAL], // disagrees: cycle wins
    ['monthly', weekly, { repeat: S(2000), cycle: S(1000) }, weekly], // agrees, newer
    ['monthly', weekly, { repeat: S(1000), cycle: S(1000) }, weekly], // agrees, same stamp (written together)
    ['monthly', weekly, { repeat: S(1000), cycle: S(2000) }, MONTHLY], // agrees, older: an older device set the cycle since
    ['annual', weekly, { repeat: S(2000), cycle: S(1000) }, ANNUAL], // disagrees, newer
    ['annual', weekly, { repeat: S(1000), cycle: S(2000) }, ANNUAL], // disagrees, older
    ['monthly', weekly, { cycle: S(1000) }, MONTHLY], // a cycle stamp but no repeat stamp: not trusted
  ];
  for (const [cycle, repeat, stamps, want] of cases) {
    assert.deepEqual(effectiveInterval({ cycle, repeat }, stamps), want, JSON.stringify([cycle, stamps]));
  }
  assert.deepEqual(effectiveInterval({ cycle: 'monthly', repeat: weekly }, { repeat: S(1, 'devB'), cycle: S(1, 'devA') }), weekly, 'same wall: the device id orders stamps');
});

test('effective interval: a missing repeat means "follow the cycle", never "every 1 month"', () => {
  assert.equal(effectiveInterval({ cycle: 'annual' }), ANNUAL);
  assert.equal(effectiveInterval({ cycle: 'annual', repeat: undefined }), ANNUAL);
  assert.equal(effectiveInterval({ cycle: 'annual', repeat: null }), ANNUAL);
  assert.equal(effectiveInterval({ cycle: 'monthly' }), MONTHLY);
  assert.equal(effectiveInterval({ cycle: 'weekly' }), MONTHLY, 'a cycle 1.19.0 doesn\'t know reads as monthly, as before');
  assert.equal(effectiveInterval({}), MONTHLY);
  assert.equal(effectiveInterval({ cycle: 'once', repeat: every(1, 'week') }), null, 'a one-off has none, whatever it carries');
  for (const bad of [every(1, 'fortnight'), every(121, 'month'), 'weekly', { every: '1', unit: 'week' }]) {
    assert.equal(effectiveInterval({ cycle: 'monthly', repeat: bad }), MONTHLY, JSON.stringify(bad));
  }
  assert.deepEqual(effectiveInterval({ cycle: 'monthly', repeat: { every: 3, unit: 'month', future: true } }), every(3, 'month'), 'extra keys ignored');
});

test('the item view leaves out a repeat that is older than the cycle; the record keeps it', () => {
  const rec = (tr, tc) => ({
    id: 'a', fields: { name: 'x', cycle: 'monthly', repeat: every(1, 'week'), del: false },
    ts: { name: S(500), cycle: S(tc), repeat: S(tr), del: S(500) },
  });
  assert.deepEqual(storage.toItem(rec(2000, 1000)).repeat, every(1, 'week'), 'newer');
  assert.deepEqual(storage.toItem(rec(1000, 1000)).repeat, every(1, 'week'), 'same stamp');
  const stale = rec(1000, 2000);
  assert.equal('repeat' in storage.toItem(stale), false, 'older: not part of the item');
  assert.deepEqual(stale.fields.repeat, every(1, 'week'), 'still stored');
  const plain = { id: 'b', fields: { name: 'y', cycle: 'monthly', del: false }, ts: { name: S(1), cycle: S(1), del: S(1) } };
  assert.deepEqual(storage.toItem(plain), { id: 'b', name: 'y', cycle: 'monthly' }, 'no repeat: nothing added');
});

/* ------------------------------------------------------------------ Every stepping site follows it */

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('every stepping site uses the effective interval: a weekly repeat steps weekly everywhere', () => {
  const weekly = item({ nextRenewal: '2026-11-19', repeat: every(1, 'week') }); // a Thursday
  assert.deepEqual(stepDays(weekly, 2026, 11), [3, 10, 17, 24, 31], 'the calendar: five Thursdays in December');
  assert.equal(dueInMonth(weekly, 2026, 11), 750, 'cash: five times the price');
  assert.equal(dueInMonth(weekly, 2027, 1), 600, 'four in February 2027');
  assert.equal(cashDue([weekly], 2026, 11), 750);
  assert.equal(incomeInMonth({ ...weekly, type: 'income' }, 2026, 11), 750);
  assert.equal(ymd(nextRenewal(weekly, new Date(2026, 10, 20, 12))), '2026-11-26', 'the next date: a week on');
  assert.equal(ymd(nextRenewal(weekly, new Date(2026, 10, 1, 12))), '2026-11-19', 'never before the stored date');
  const banner = dueSoon([weekly], new Date(2026, 10, 20, 12), { windowDays: 7 });
  assert.deepEqual(banner.rows.map((r) => [ymd(r.date), r.days, r.amount]), [['2026-11-26', 6, 150]]);
  const month = occurrences([weekly], 2026, 11, { currency: 'TWD' });
  assert.deepEqual(month.days.filter((d) => d.count).map((d) => [d.day, d.total]), [[3, 150], [10, 150], [17, 150], [24, 150], [31, 150]]);
  assert.equal(month.total, dueInMonth(weekly, 2026, 11), 'the day rows add up to the month');
  assert.equal(dueEach(weekly), 150);
});

test('a repeat that doesn\'t count changes nothing: every site behaves as for the cycle alone', () => {
  for (const over of [{ cycle: 'annual', repeat: every(1, 'week') }, { repeat: every(1, 'fortnight') }, { repeat: null }, {}]) {
    const s = item({ nextRenewal: '2026-11-19', ...over });
    const plain = item({ nextRenewal: '2026-11-19', cycle: over.cycle ?? 'monthly' });
    for (const [y, m] of [[2026, 10], [2026, 11], [2027, 10]]) {
      assert.deepEqual(stepDays(s, y, m), stepDays(plain, y, m), JSON.stringify(over));
      assert.equal(dueInMonth(s, y, m), dueInMonth(plain, y, m));
    }
    assert.equal(nextRenewal(s, new Date(2027, 0, 5)).getTime(), nextRenewal(plain, new Date(2027, 0, 5)).getTime());
  }
});

/* ------------------------------------------------------------------ The settings record */

const settingsOf = (fields) => ({ id: storage.SETTINGS_ID, fields, ts: Object.fromEntries(Object.keys(fields).map((k) => [k, S(1)])) });
const C = (name) => storage.colorField(name);

test('palette slots are read from colour values: 0–29, matching the swatch; groupSlots only when any', () => {
  for (const [v, want] of [
    [{ swatch: 'w8', slot: 7 }, 7], [{ swatch: 'w3', slot: 17 }, 17], [{ swatch: 'w1', slot: 0 }, 0], [{ swatch: 'w15', slot: 29 }, 29],
    [{ swatch: 'w8', slot: 6 }, null], [{ swatch: 'g6', slot: 7 }, null], [{ swatch: 'w8' }, null], [{ swatch: 'w1', slot: 30 }, null],
    [{ swatch: 'w8', slot: '7' }, null], [{ swatch: 'w8', slot: 7.5 }, null], [null, null],
  ]) assert.equal(storage.slotOf(v), want, JSON.stringify(v));
  const rec = settingsOf({
    defaultCurrency: 'TWD',
    [C('Gaming')]: { name: 'Gaming', swatch: 'w8', slot: 7 },
    [C('Fuel')]: { name: 'Fuel', swatch: 'w7', slot: 6, auto: true, later: { x: 1 } },
    [C('Food')]: { name: 'Food', swatch: 'g1' },
  });
  assert.deepEqual(storage.settingsFromRecord(rec), {
    defaultCurrency: 'TWD', groupColors: { Gaming: 'w8', Fuel: 'w7', Food: 'g1' }, groupSlots: { Gaming: 7, Fuel: 6 },
  });
  assert.deepEqual(storage.effectiveSettings({}, rec).groupSlots, { Gaming: 7, Fuel: 6 });
  const none = settingsOf({ [C('Food')]: { name: 'Food', swatch: 'g1' } });
  assert.equal('groupSlots' in storage.settingsFromRecord(none), false, 'nothing new when no value has a slot');
  assert.equal('groupSlots' in storage.effectiveSettings({}, none), false);
});

test('colour values and version notes keep every key through sync and other settings changes', () => {
  const r = replicaOf('devA');
  const fuel = { name: 'Fuel', swatch: 'w7', slot: 6, auto: true, later: { x: 1 } };
  const note = { v: '1.20.0', fmt: 5, at: '2026-12-01', later: true };
  const ops = [
    { id: 'c1', rec: storage.SETTINGS_ID, f: C('Fuel'), v: fuel, t: S(1000, 'devB'), dev: 'devB' },
    { id: 'n1', rec: storage.SETTINGS_ID, f: storage.versionNoteField('devB'), v: note, t: S(1000, 'devB'), dev: 'devB' },
    { id: 'n2', rec: storage.SETTINGS_ID, f: 'app_0123456789abcdef', v: 'not a note', t: S(1000, 'devB'), dev: 'devB' },
  ];
  assert.equal(storage.applyRemoteOps(r, ops, 2000).skipped, 0);
  storage.settingsOps(r, { defaultCurrency: 'EUR' }, opts(3000));
  const f = r.records.get(storage.SETTINGS_ID).fields;
  assert.deepEqual(f[C('Fuel')], fuel);
  assert.deepEqual(f[storage.versionNoteField('devB')], note);
  assert.equal(f.app_0123456789abcdef, 'not a note', 'kept, though no use here');
  assert.ok(!('del' in f));
});

test('version notes: one field per device (frozen hash), the plan\'s value, usable ones read back', () => {
  assert.equal(storage.versionNoteField('devA'), 'app_84ee3903b11475ae');
  assert.equal(storage.versionNoteField('3f2a9c1b-7e4d-4a8b-9c1d-2e3f4a5b6c7d'), 'app_7c26d643d6df0c39');
  assert.ok(core.isFieldName(storage.versionNoteField('a-b_c-'.repeat(10))), 'any device id makes a valid field name');
  const rec = settingsOf({
    [storage.versionNoteField('devA')]: { v: '1.20.0', fmt: 5, at: '2026-12-01' },
    [storage.versionNoteField('devB')]: { v: '1.21.0', fmt: 5, at: '2027-01-02', later: 1 },
    app_00000000000000aa: { v: '', fmt: 5, at: '2026-12-01' },
    app_00000000000000bb: { v: '1.20.0', fmt: '5', at: '2026-12-01' },
    app_00000000000000cc: { v: '1.20.0', fmt: 5, at: '1 Dec' },
    app_short: { v: '1.20.0', fmt: 5, at: '2026-12-01' },
  });
  assert.deepEqual(storage.versionNotes(rec).map((n) => [n.field, n.v, n.fmt, n.at]).sort(), [
    [storage.versionNoteField('devA'), '1.20.0', 5, '2026-12-01'],
    [storage.versionNoteField('devB'), '1.21.0', 5, '2027-01-02'],
  ].sort());
});

test('a version note is written only when due: none yet, another version or format, or over 30 days old', () => {
  const r = replicaOf('devA');
  const write = (version, fmt, now) => storage.versionNoteOps(r, { deviceId: 'devA', version, fmt, now, newId: () => `n${++n}` });
  const day = (y, m, d) => new Date(y, m - 1, d, 12).getTime();
  assert.equal(write('1.20.0', 5, day(2026, 12, 1)).length, 1, 'none yet');
  assert.deepEqual(r.records.get(storage.SETTINGS_ID).fields[storage.versionNoteField('devA')], { v: '1.20.0', fmt: 5, at: '2026-12-01' });
  assert.equal(write('1.20.0', 5, day(2026, 12, 20)).length, 0, 'the same, 19 days on');
  assert.equal(write('1.20.0', 5, day(2026, 12, 31)).length, 0, '30 days on');
  assert.equal(write('1.20.0', 5, day(2027, 1, 1)).length, 1, '31 days on');
  assert.equal(write('1.20.1', 5, day(2027, 1, 2)).length, 1, 'a new version');
  assert.equal(write('1.20.1', 6, day(2027, 1, 3)).length, 1, 'a new format');
  assert.ok(!('del' in r.records.get(storage.SETTINGS_ID).fields));
});

test('only the format 5 step and the launch refresh write a version note; nothing in the app writes a repeat yet; a slot only with a picked colour', () => {
  const dir = new URL('../js/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    if (f !== 'storage.js') assert.ok(!/versionNoteOps\(/.test(src), `${f} calls versionNoteOps`);
  }
  // In storage.js: its definition and two calls, one inside migrateFormat (the first-launch step) and
  // one inside refreshVersionNote (every later launch, 1.26.0).
  const store = readFileSync(new URL('storage.js', dir), 'utf8');
  const calls = [...store.matchAll(/versionNoteOps\(/g)].map((m) => m.index);
  assert.equal(calls.length, 3, 'the definition and two calls');
  const body = (header) => {
    const at = store.indexOf(header);
    return [at, at + store.slice(at).search(/\n\}\r?\n/)];
  };
  const [step, end] = body('async function migrateFormat(');
  const [refresh, refreshEnd] = body('async function refreshVersionNote(');
  const def = store.indexOf('export function versionNoteOps(') + 'export function '.length;
  const inside = (i, [a, b]) => a > 0 && i > a && i < b;
  assert.ok(calls.filter((i) => inside(i, [step, end])).length === 1, 'one call in migrateFormat');
  assert.ok(calls.filter((i) => inside(i, [refresh, refreshEnd])).length === 1, 'one call in refreshVersionNote');
  assert.ok(calls.every((i) => i === def || inside(i, [step, end]) || inside(i, [refresh, refreshEnd])), 'called nowhere else');
  // The refresh runs only once the step is verified, and the step only until then (storage.js migrate).
  const [mig, migEnd] = body('async function migrate(db)');
  const m = store.slice(mig, migEnd);
  assert.ok(m.includes('if (!meta.formatMigration?.verified) await migrateFormat(db);'), 'the step until verified');
  assert.ok(m.includes('else await refreshVersionNote(db);'), 'then the refresh');
  const app = readFileSync(new URL('app.js', dir), 'utf8');
  assert.ok(!/repeat\s*:/.test(app), 'the app builds no repeat values');
  assert.deepEqual([...app.matchAll(/groupSlots:/g)].length, 1, 'one place writes a slot: the colour picker');
});

/* ------------------------------------------------------------------ Backup format 5 */

const legacy = await import('./legacy-1.19.0/storage.js');
const AT = '2026-11-19T00:00:00.000Z';
const liveOf = (r) => [...r.records.values()].filter((x) => x.id !== storage.SETTINGS_ID).map(storage.toItem).filter(Boolean);

test('export writes format 5: repeat and groupSlots where present, and nothing new otherwise', () => {
  const plain = [item({ id: 'p' })];
  const bare = storage.exportBackupFrom(plain, { defaultCurrency: 'TWD', groupColors: { Hobbies: 'g3' } }, AT);
  assert.equal(bare.format, 5);
  assert.equal(bare.problem, null);
  assert.deepEqual(Object.keys(bare.payload), ['app', 'schemaVersion', 'exportedAt', 'items', 'settings']);
  assert.equal(bare.payload.schemaVersion, 5);
  const as4 = storage.backupPayload(plain, { defaultCurrency: 'TWD', groupColors: { Hobbies: 'g3' } }, AT, 4);
  assert.deepEqual({ ...bare.payload, schemaVersion: 4 }, as4, 'the same as format 4 but for the version');
  const rich = storage.exportBackupFrom([item({ repeat: every(1, 'week') })], { groupColors: { Hobbies: 'w5' }, groupSlots: { Hobbies: 4 } }, AT);
  assert.equal(rich.format, 5);
  assert.deepEqual(rich.payload.items[0].repeat, every(1, 'week'));
  assert.deepEqual(rich.payload.settings.groupSlots, { Hobbies: 4 });
  assert.equal(storage.BACKUP_VERSION, 5);
  assert.equal(storage.SCHEMA_VERSION, 4, 'the data format in meta moves to 5 only with 1.20.0\'s first-launch step');
});

test('the export check: something 1.19.0 couldn\'t import, or an interval that wouldn\'t come back, falls back to format 4', () => {
  const settings = { groupColors: {} };
  const bad = storage.exportBackupFrom([item({ id: 'p' }), item({ id: 'q', cycle: 'weekly' })], settings, AT);
  assert.equal(bad.format, 4);
  // This version's reader is as strict as 1.19.0's about these fields, so it is the first to say so;
  // the 1.19.0 rules in checkBackup stay as a backstop should the reader ever accept more.
  assert.match(bad.problem, /can't read it back|would not import on 1\.19\.0/);
  assert.equal(bad.payload.schemaVersion, 4);
  assert.deepEqual(bad.payload, storage.backupPayload([item({ id: 'p' }), item({ id: 'q', cycle: 'weekly' })], settings, AT, 4), 'what 1.19.0 would have written');
  const undatedOnce = storage.exportBackupFrom([item({ cycle: 'once', nextRenewal: '', date: '' })], settings, AT);
  assert.equal(undatedOnce.format, 4);
  // Forced by hand: a payload that loses a repeat which counts on the live item.
  const live = [item({ repeat: every(1, 'week') })];
  const lossy = storage.backupPayload([item()], settings, AT);
  assert.match(storage.checkBackup(lossy, live, settings), /1 of 1 items come back with another interval/);
  assert.equal(storage.checkBackup(storage.backupPayload(live, settings, AT), live, settings), null);
  assert.match(storage.checkBackup(storage.backupPayload(live, settings, AT), live, { groupColors: { A: 'w1' }, groupSlots: { A: 0 } }), /palette slots/);
});

test('import reads formats 3, 4 and 5 as this version\'s own and flags anything newer', () => {
  for (const [v, newer] of [[3, false], [4, false], [5, false], [6, true], [9, true]]) {
    const plan = storage.planFromBackup(storage.parseBackup(fileOf([item()], { schemaVersion: v })), [], {});
    assert.equal(plan.merge.summary.newerVersion, newer, `format ${v}`);
  }
});

test('a format-4 file imports exactly as 1.19.0 imports it (items, settings, ops)', () => {
  const file = {
    app: 'substracker', schemaVersion: 4, exportedAt: T2,
    items: [item({ id: 'a' }), item({ id: 'b', cycle: 'annual', price: 12.5, currency: 'usd' }), item({ id: 'c', cycle: 'once', date: '2026-12-24', nextRenewal: 'x' }), item({ id: 'd', type: 'income', category: 'x' })],
    settings: { defaultCurrency: 'eur', groupColors: { Hobbies: 'g3', Food: 'w2' }, pro: true },
  };
  for (const mode of ['merge', 'replace']) {
    const run = (mod) => {
      const r = { clock: core.newClock('devA'), records: new Map() };
      core.putRecord(r, 'z', { name: 'Old', cycle: 'monthly', price: 1, currency: 'TWD' }, { now: 500, newId: () => 'x0' });
      core.setFields(r, mod.SETTINGS_ID, { [mod.colorField('Food')]: { name: 'Food', swatch: 'g1' } }, { now: 600, newId: () => 'x1' });
      let k = 0;
      const plan = mod.planFromBackup(mod.parseBackup(JSON.stringify(file)), [], mod.settingsFromRecord(r.records.get(mod.SETTINGS_ID)))[mode];
      const o = { now: 1000, newId: () => `i${++k}` };
      const replaceColors = plan.clear && 'groupColors' in plan.settings;
      const ops = mod.importChange ? mod.importChange(r, plan, o) : [...mod.importOps(r, plan, o), ...mod.settingsOps(r, plan.settings, { replaceColors, ...o })];
      return { ops, records: [...r.records.values()], summary: plan.summary };
    };
    assert.deepEqual(run(storage), run(legacy), `${mode}: the same ops and records as 1.19.0`);
  }
});

test('import brings in palette slots that match their colour, and keeps a colour that is already as the file says', () => {
  const r = replicaOf();
  const fuel = { name: 'Fuel', swatch: 'w7', slot: 6, auto: true, later: 1 };
  core.setFields(r, storage.SETTINGS_ID, { [C('Fuel')]: fuel }, opts(500));
  const file = fileOf([item()], { settings: { groupColors: { Gaming: 'w8', Fuel: 'w7', Food: 'w2' }, groupSlots: { Gaming: 7, Fuel: 6, Food: 5, Ghost: 3 } } });
  const plan = storage.planFromBackup(storage.parseBackup(file), [], storage.settingsFromRecord(r.records.get(storage.SETTINGS_ID))).replace;
  assert.deepEqual(plan.settings.groupSlots, { Gaming: 7, Fuel: 6 }, 'only slots that match their colour (Food\'s 5 is not w2, Ghost has no colour)');
  const ops = storage.importChange(r, plan, opts(1000));
  const f = r.records.get(storage.SETTINGS_ID).fields;
  assert.deepEqual(f[C('Gaming')], { name: 'Gaming', swatch: 'w8', slot: 7 });
  assert.deepEqual(f[C('Food')], { name: 'Food', swatch: 'w2' });
  assert.deepEqual(f[C('Fuel')], fuel, 'already as the file says: left as it is, auto and later keys too');
  assert.ok(!ops.some((op) => op.f === C('Fuel')));
});

test('format 5 round trip: export, import into an empty device, export again gives the same file', () => {
  const r = replicaOf();
  const file = fileOf([item({ repeat: every(2, 'week') }), item({ id: 'b', cycle: 'annual', repeat: every(6, 'month') }), item({ id: 'c' })],
    { settings: { defaultCurrency: 'TWD', groupColors: { Hobbies: 'w5' }, groupSlots: { Hobbies: 19 } } });
  storage.importChange(r, storage.planFromBackup(storage.parseBackup(file), [], {}).replace, opts(1000));
  const settings = storage.effectiveSettings({}, r.records.get(storage.SETTINGS_ID));
  const first = storage.exportBackupFrom(liveOf(r), settings, AT);
  assert.equal(first.format, 5);
  const r2 = replicaOf('devB');
  storage.importChange(r2, storage.planFromBackup(storage.parseBackup(first.payload), [], {}).replace, opts(2000));
  const second = storage.exportBackupFrom(liveOf(r2), storage.effectiveSettings({}, r2.records.get(storage.SETTINGS_ID)), AT);
  assert.deepEqual(second.payload, first.payload);
  assert.deepEqual(first.payload.items.find((x) => x.id === 'a').repeat, every(2, 'week'));
  assert.deepEqual(first.payload.settings.groupSlots, { Hobbies: 19 });
});
