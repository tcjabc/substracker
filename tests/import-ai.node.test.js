// Node tests for "Import with AI" (js/import-ai.js and js/import-ai-prompt.js): reading a reply
// tolerantly, checking rows strictly with row-level messages, flagging missing dates, unsupported
// cycles and duplicates, the reserved id, the size limits, and turning rows into items through the
// normal backup path. Run with `npm test`. Fixtures are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sync from '../js/sync-core.js';
import * as storage from '../js/storage.js';
import {
  AiImportError, extractJson, parseAiImport, checkRow, reviewRows, reviewAiImport, backupFromRows,
  itemFromFields, totalsOf, errorReport, isRealDay, AI_SCHEMA_VERSION, MAX_AI_CHARS, MAX_AI_ROWS, PROBLEM,
} from '../js/import-ai.js';
import { AI_IMPORT_PROMPT } from '../js/import-ai-prompt.js';

const NOW = '2026-06-01T00:00:00.000Z';
const row = (over = {}) => ({
  name: 'Example Streaming', amount: 390, currency: 'TWD', cycle: 'monthly', nextDate: '2026-12-05',
  category: 'Entertainment', type: 'expense', ...over,
});
const reply = (rows, over = {}) => JSON.stringify({ version: 1, rows, ...over });
const messages = (r) => r.problems.map((p) => p.message);
let seq = 0;
const newId = () => `ai-${++seq}`;

/* ------------------------------------------------------------------ Reading the reply */

test('good JSON: every row is ok and included', () => {
  const rows = reviewAiImport(reply([row(), row({ name: 'Sample Salary', type: 'income', amount: 52000, category: '' })]));
  assert.deepEqual(rows.map((r) => [r.n, r.status, r.include]), [[1, 'ok', true], [2, 'ok', true]]);
  assert.deepEqual(rows[0].fields, {
    name: 'Example Streaming', amount: 390, currency: 'TWD', cycle: 'monthly', cycleText: 'monthly',
    nextDate: '2026-12-05', category: 'Entertainment', type: 'expense',
  });
});

test('tolerant: code fences, text around the JSON, a byte-order mark', () => {
  const json = reply([row()]);
  for (const text of [
    '```json\n' + json + '\n```',
    '```\n' + json + '\n```',
    'Here is your data:\n\n```json\n' + json + '\n```\n\nLet me know if you need anything else.',
    'Sure! ' + json + ' Hope that helps.',
    '﻿' + json,
    '  \n' + json + '\n  ',
  ]) {
    assert.equal(parseAiImport(text).length, 1, text.slice(0, 30));
  }
});

test('tolerant: braces inside strings and a stray {note} before the JSON', () => {
  const text = 'Note {about} the {format}: ' + reply([row({ name: 'Shop {Main} "St"' })]);
  assert.equal(parseAiImport(text)[0].name, 'Shop {Main} "St"');
});

test('bad JSON: no JSON at all, or broken JSON', () => {
  for (const text of ['', '   ', 'I could not read your statement.', '{"version": 1, "rows": [', '```json\n{oops}\n```']) {
    assert.throws(() => parseAiImport(text), AiImportError, JSON.stringify(text));
  }
  assert.throws(() => parseAiImport(undefined), AiImportError);
  assert.throws(() => parseAiImport(42), AiImportError);
});

test('the envelope is checked strictly: object, version 1, a non-empty rows list', () => {
  const cases = [
    ['[1, 2]', /is a list/],
    ['"text"', /should be an object/],
    [JSON.stringify({ rows: [row()] }), /"version" missing/],
    [JSON.stringify({ version: 2, rows: [row()] }), /"version" should be 1/],
    [JSON.stringify({ version: '1', rows: [row()] }), /"version" should be 1/],
    [JSON.stringify({ version: 1 }), /"rows" missing/],
    [JSON.stringify({ version: 1, rows: {} }), /"rows" should be a list/],
    [JSON.stringify({ version: 1, rows: [] }), /"rows" is empty/],
  ];
  for (const [text, re] of cases) assert.throws(() => parseAiImport(text), re, text);
  assert.equal(AI_SCHEMA_VERSION, 1);
});

test('huge input: over the character limit or the row limit is refused before any row is read', () => {
  assert.throws(() => parseAiImport('x'.repeat(MAX_AI_CHARS + 1)), /too long/);
  const many = Array.from({ length: MAX_AI_ROWS + 1 }, (_, i) => row({ name: `Item ${i}` }));
  const text = JSON.stringify({ version: 1, rows: many });
  assert.ok(text.length < MAX_AI_CHARS, 'the row limit is reached before the size limit');
  assert.throws(() => parseAiImport(text), new RegExp(`${MAX_AI_ROWS + 1} rows; the most at once is ${MAX_AI_ROWS}`));
  const max = Array.from({ length: MAX_AI_ROWS }, (_, i) => row({ name: `Item ${i}` }));
  assert.equal(reviewAiImport(JSON.stringify({ version: 1, rows: max })).filter((r) => r.include).length, MAX_AI_ROWS);
});

test('a parsed object is accepted as it is', () => {
  assert.equal(extractJson({ version: 1, rows: [row()] }).rows.length, 1);
});

/* ------------------------------------------------------------------ Rows */

test('partial JSON: good rows stay usable next to bad ones, with row-level messages', () => {
  const rows = reviewAiImport(reply([row(), row({ currency: undefined }), 'oops', row({ name: 'Other' })]));
  assert.deepEqual(rows.map((r) => r.status), ['ok', 'error', 'error', 'ok']);
  assert.deepEqual(messages(rows[1]), ['Row 2: currency missing']);
  assert.deepEqual(messages(rows[2]), ['Row 3: is not an object with fields']);
  assert.deepEqual(rows.map((r) => r.include), [true, false, false, true]);
});

test('missing required fields each get their own message', () => {
  const r = checkRow({}, 4);
  assert.deepEqual(r.problems.map((p) => p.message), [
    'Row 4: name missing', 'Row 4: amount missing', 'Row 4: currency missing', 'Row 4: type missing',
    'Row 4: cycle missing', 'Row 4: next renewal date missing',
  ]);
});

test('wrong types are errors, never converted', () => {
  const cases = [
    [{ name: 42 }, 'Row 1: name should be text'],
    [{ amount: '390' }, 'Row 1: amount should be a number, not text'],
    [{ amount: -5 }, 'Row 1: amount should be 0 or more (use "type": "income" for money coming in)'],
    [{ amount: 1e13 }, 'Row 1: amount is too large'],
    [{ currency: 901 }, 'Row 1: currency should be a 3-letter code such as TWD'],
    [{ currency: 'XYZ' }, 'Row 1: currency "XYZ" isn\'t one the app supports'],
    [{ type: 'refund' }, 'Row 1: type should be "expense" or "income"'],
    [{ cycle: 12 }, 'Row 1: cycle should be "monthly", "annual" or "one-off"'],
    [{ category: ['x'] }, 'Row 1: category should be text'],
    [{ category: 'c'.repeat(41) }, 'Row 1: category is longer than 40 characters'],
    [{ name: 'n'.repeat(81) }, 'Row 1: name is longer than 80 characters'],
    [{ nextDate: 20261205 }, 'Row 1: next renewal date "20261205" isn\'t a YYYY-MM-DD date'],
  ];
  for (const [over, msg] of cases) assert.deepEqual(messages(checkRow(row(over), 1)), [msg], msg);
});

test('values are tidied but not guessed: case, spacing and rounding', () => {
  const { fields, problems } = checkRow(row({ name: '  Example  ', currency: ' usd ', cycle: ' Annual ', type: 'Expense', amount: 9.999, category: ' Software ' }), 1);
  assert.deepEqual(problems, []);
  assert.deepEqual([fields.name, fields.currency, fields.cycle, fields.type, fields.amount, fields.category],
    ['Example', 'USD', 'annual', 'expense', 10, 'Software']);
  assert.equal(checkRow(row({ category: undefined }), 1).fields.category, '', 'no category is fine');
  assert.equal(checkRow(row({ type: 'income', category: 'Pay' }), 1).fields.category, '', 'income has no category');
  assert.equal(checkRow(row({ amount: 0 }), 1).problems.length, 0, 'zero is allowed, as in the form');
});

test('missing or unreadable dates are flagged with the app\'s name for the date', () => {
  const cases = [
    [{ nextDate: undefined }, 'Row 1: next renewal date missing'],
    [{ nextDate: '' }, 'Row 1: next renewal date missing'],
    [{ nextDate: null, type: 'income' }, 'Row 1: next payment date missing'],
    [{ nextDate: '  ', cycle: 'one-off' }, 'Row 1: date missing'],
    [{ nextDate: '05/12/2026' }, 'Row 1: next renewal date "05/12/2026" isn\'t a YYYY-MM-DD date'],
    [{ nextDate: '2026-02-30' }, 'Row 1: next renewal date "2026-02-30" isn\'t a YYYY-MM-DD date'],
    [{ nextDate: '2026-12' }, 'Row 1: next renewal date "2026-12" isn\'t a YYYY-MM-DD date'],
  ];
  for (const [over, msg] of cases) {
    const [r] = reviewRows([row(over)]);
    assert.deepEqual(messages(r), [msg]);
    assert.deepEqual([r.status, r.importable, r.include], [PROBLEM.date, false, false]);
  }
  assert.equal(isRealDay('2028-02-29'), true);
  assert.equal(isRealDay('2027-02-29'), false);
});

test('unsupported cycles are flagged and skipped, never rounded to a supported one', () => {
  for (const c of ['weekly', 'fortnightly', 'quarterly', 'custom', 'every 3 months', 'yearly', 'once', 'biweekly']) {
    const [r] = reviewRows([row({ cycle: c })]);
    assert.equal(r.status, PROBLEM.cycle, c);
    assert.equal(r.fields.cycle, null, `${c} is not mapped`);
    assert.equal(r.fields.cycleText, c);
    assert.equal(r.include, false);
    assert.match(messages(r)[0], new RegExp(`^Row 1: unsupported cycle "${c}"`));
  }
  assert.equal(checkRow(row({ cycle: 'one-off' }), 1).fields.cycle, 'once');
});

test('a fixed row can be checked again: the review is rebuilt from the edited raw rows', () => {
  const raw = [row({ cycle: 'weekly', nextDate: '' })];
  assert.equal(reviewRows(raw)[0].status, PROBLEM.cycle);
  raw[0] = { ...raw[0], cycle: 'monthly' };
  assert.equal(reviewRows(raw)[0].status, PROBLEM.date);
  raw[0] = { ...raw[0], nextDate: '2026-12-01' };
  assert.deepEqual([reviewRows(raw)[0].status, reviewRows(raw)[0].include], ['ok', true]);
});

test('the reserved id "settings" is rejected; any other id is ignored', () => {
  const [bad, other] = reviewRows([row({ id: 'settings' }), row({ id: 'existing-item', name: 'Other' })]);
  assert.deepEqual(messages(bad), ['Row 1: id "settings" is reserved']);
  assert.equal(bad.include, false);
  assert.equal(other.status, 'ok');
  const backup = backupFromRows([other], { now: NOW, newId });
  assert.notEqual(backup.items[0].id, 'existing-item', 'rows never pick their own id, so they can\'t overwrite an item');
  // Even an id maker that returns the reserved id can't produce it.
  const ids = ['settings', 'settings', 'fresh'];
  assert.equal(itemFromFields(other.fields, NOW, () => ids.shift()).id, 'fresh');
});

test('duplicates within the reply: later copies are skipped but can be included on purpose', () => {
  const rows = reviewRows([row(), row({ name: ' example   STREAMING ', amount: 390.001 }), row({ amount: 391 }), row({ cycle: 'annual' }), row({ currency: 'USD' })]);
  assert.deepEqual(rows.map((r) => r.status), ['ok', 'duplicate', 'ok', 'ok', 'ok']);
  assert.deepEqual(rows[1].duplicateOf, { row: 1 });
  assert.deepEqual(messages(rows[1]), ['Row 2: same as row 1, skipped']);
  assert.deepEqual([rows[1].importable, rows[1].include], [true, false]);
});

test('duplicates of items already in the list are skipped', () => {
  const existing = [{ id: 'a', name: 'Example Streaming', price: 390, currency: 'TWD', cycle: 'monthly', type: 'expense' },
    { id: 'b', name: 'Corner Shop', price: 120, currency: 'TWD', cycle: 'once', date: '2026-05-01' }];
  const rows = reviewRows([row(), row({ name: 'corner shop', amount: 120, cycle: 'one-off', nextDate: '2026-05-01' }), row({ name: 'New' })], existing);
  assert.deepEqual(rows.map((r) => r.status), ['duplicate', 'duplicate', 'ok']);
  assert.deepEqual(messages(rows[0]), ['Row 1: already in your list, skipped']);
  assert.deepEqual(rows[0].duplicateOf, { existing: true });
});

test('a row with a real error and a duplicate shows the error first', () => {
  const [, r] = reviewRows([row(), row({ nextDate: '' })]);
  assert.equal(r.status, PROBLEM.date);
  assert.equal(r.problems.length, 2);
});

/* ------------------------------------------------------------------ Rows → items */

test('rows map to items in the form\'s shape: recurring dates in nextRenewal, one-offs in date', () => {
  const rows = reviewRows([row(), row({ name: 'Sample Pay', type: 'income', category: 'x' }), row({ name: 'Desk', cycle: 'one-off', nextDate: '2026-05-04' })]);
  const { items } = backupFromRows(rows, { now: NOW, newId });
  assert.deepEqual(Object.keys(items[0]), ['id', ...storage.ITEM_FIELDS]);
  assert.deepEqual(items.map((s) => [s.type, s.cycle, s.nextRenewal, s.date, s.category]), [
    ['expense', 'monthly', '2026-12-05', '', 'Entertainment'],
    ['income', 'monthly', '2026-12-05', '', ''],
    ['expense', 'once', '', '2026-05-04', 'Entertainment'],
  ]);
  assert.equal(items.every((s) => s.createdAt === NOW && s.updatedAt === NOW), true);
  assert.equal(new Set(items.map((s) => s.id)).size, 3);
});

test('only included, importable rows become items; none selected is an error', () => {
  const rows = reviewRows([row(), row({ name: 'B' }), row({ name: 'C', cycle: 'weekly' })]);
  rows[1].include = false;
  rows[2].include = true; // a flagged row can't be forced in
  assert.deepEqual(backupFromRows(rows, { now: NOW, newId }).items.map((s) => s.name), ['Example Streaming']);
  rows[0].include = false;
  assert.throws(() => backupFromRows(rows, { now: NOW, newId }), /No rows are selected/);
});

test('the backup is a format-4 backup without settings, so import leaves settings alone', () => {
  const backup = backupFromRows(reviewRows([row()]), { now: NOW, newId });
  assert.deepEqual([backup.app, backup.schemaVersion, 'settings' in backup], [storage.APP_ID, storage.SCHEMA_VERSION, false]);
  const plans = storage.planFromBackup(storage.parseBackup(backup), [], { defaultCurrency: 'USD', groupColors: { Mine: 'g4' } });
  assert.deepEqual([plans.merge.settings, plans.replace.settings, plans.replace.summary.withSettings], [{}, {}, false]);
});

const liveItems = (replica) => [...replica.records.values()].map(storage.toItem).filter(Boolean).sort((x, y) => x.name.localeCompare(y.name));

test('merge and replace go through the existing import: records, stamps and ops', () => {
  const mine = { id: 'mine', type: 'expense', name: 'Mine', domain: '', emoji: '', plan: '', price: 1, currency: 'TWD', cycle: 'monthly', nextRenewal: '2026-01-01', date: '', category: '', notes: '', createdAt: NOW, updatedAt: NOW };
  const backup = backupFromRows(reviewRows([row(), row({ name: 'Desk', cycle: 'one-off', nextDate: '2026-05-04' })]), { now: NOW, newId });
  for (const mode of ['merge', 'replace']) {
    const { records, clock } = storage.recordsFromItems([mine], sync.newClock('devA'), Date.parse(NOW));
    const replica = { clock, records: new Map(records.map((r) => [r.id, r])) };
    const plan = storage.planFromBackup(storage.parseBackup(backup), liveItems(replica), {})[mode];
    const ops = storage.importOps(replica, plan, { now: Date.parse(NOW) });
    assert.equal(ops.every(sync.isOp), true);
    assert.deepEqual(liveItems(replica).map((s) => s.name), mode === 'merge' ? ['Desk', 'Example Streaming', 'Mine'] : ['Desk', 'Example Streaming']);
    assert.equal(plan.summary.added, 2);
  }
});

test('round trip: imported rows export and re-import unchanged', () => {
  const rows = reviewRows([row(), row({ name: 'Sample Pay', type: 'income', amount: 52000.5, category: '' }), row({ name: 'Desk', cycle: 'one-off', nextDate: '2026-05-04', currency: 'usd' }), row({ name: 'Cloud', cycle: 'annual', amount: 1290 })]);
  const backup = backupFromRows(rows, { now: NOW, newId });
  const { records, clock } = storage.recordsFromItems([], sync.newClock('devA'), Date.parse(NOW));
  const replica = { clock, records: new Map(records.map((r) => [r.id, r])) };
  storage.importOps(replica, storage.planFromBackup(storage.parseBackup(backup), [], {}).merge, { now: Date.parse(NOW) });
  // The same envelope exportAll writes, then imported again as a file.
  const exported = JSON.stringify({ app: storage.APP_ID, schemaVersion: storage.SCHEMA_VERSION, exportedAt: NOW, items: liveItems(replica), settings: {} });
  const again = storage.parseBackup(exported).items.map(({ item }) => item).sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(again, [...backup.items].sort((x, y) => x.name.localeCompare(y.name)));
  assert.deepEqual(again.map((s) => [s.name, s.price, s.currency, s.cycle]), [
    ['Cloud', 1290, 'TWD', 'annual'], ['Desk', 390, 'USD', 'once'], ['Example Streaming', 390, 'TWD', 'monthly'], ['Sample Pay', 52000.5, 'TWD', 'monthly'],
  ]);
});

test('totals preview: monthly equivalents and one-offs per currency', () => {
  const rows = reviewRows([row(), row({ name: 'Cloud', cycle: 'annual', amount: 1200 }), row({ name: 'Pay', type: 'income', amount: 50000 }), row({ name: 'Desk', cycle: 'one-off', amount: 99 }), row({ name: 'US', currency: 'USD', amount: 10 })]);
  const { items } = backupFromRows(rows, { now: NOW, newId });
  assert.deepEqual(totalsOf(items), [
    { currency: 'TWD', count: 4, expenseMonthly: 490, incomeMonthly: 50000, onceExpense: 99, onceIncome: 0 },
    { currency: 'USD', count: 1, expenseMonthly: 10, incomeMonthly: 0, onceExpense: 0, onceIncome: 0 },
  ]);
});

/* ------------------------------------------------------------------ Error text for the AI */

test('the error report lists row problems (not duplicates) and asks for JSON only', () => {
  const rows = reviewRows([row(), row(), row({ currency: '' }), row({ cycle: 'weekly', name: 'W' })]);
  const text = errorReport(rows);
  assert.match(text, /- Row 3: currency missing\n- Row 4: unsupported cycle "weekly"/);
  assert.doesNotMatch(text, /Row 2/);
  assert.match(text, /whole corrected JSON only, nothing else/);
  assert.equal(errorReport(reviewRows([row()])), '', 'nothing to report');
  assert.match(errorReport('"version" missing. It should be 1.'), /- "version" missing/);
});

/* ------------------------------------------------------------------ The prompt */

test('the prompt states the schema, allowed values and the rules', () => {
  for (const s of ['"version": 1', '"rows"', '"name"', '"amount"', '"currency"', '"cycle"', '"nextDate"', '"category"', '"type"',
    '"monthly", "annual" or "one-off"', '"expense"', '"income"', 'YYYY-MM-DD', 'only the JSON, nothing else',
    'ask me. Never guess a date', 'account numbers, card numbers', 'any person\'s name', 'TWD, USD, EUR']) {
    assert.ok(AI_IMPORT_PROMPT.includes(s), s);
  }
  // The example in the prompt is itself a valid reply.
  const example = AI_IMPORT_PROMPT.slice(AI_IMPORT_PROMPT.indexOf('{\n  "version"'));
  assert.deepEqual(reviewAiImport(example.slice(0, example.indexOf('\n}\n') + 2)).map((r) => r.status), ['ok']);
});

// Kept reversed so the names themselves don't appear in the source either.
const NAMES = ['tpgtahc', 'ianepo', 'edualc', 'ciporhtna', 'inimeg', 'drab', 'tolipoc', 'tfosorcim', 'elgoog', 'ytixelprep',
  'lartsim', 'amall', 'atem', 'korg', 'keespeed', 'newq', 'yenruojdim', 'iax'].map((s) => [...s].reverse().join(''));

test('no AI product or company is named in the new files, and they make no network calls', () => {
  for (const file of ['js/import-ai.js', 'js/import-ai-prompt.js']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').toLowerCase();
    for (const n of NAMES) assert.equal(new RegExp(`\\b${n}\\b`).test(src), false, `${file} names "${n}"`);
    for (const api of ['fetch(', 'xmlhttprequest', 'websocket', 'sendbeacon', 'eventsource', 'navigator.share', 'http://', 'https://']) {
      assert.equal(src.includes(api), false, `${file} uses ${api}`);
    }
  }
});

test('no network: the whole flow runs with every network API removed', () => {
  const saved = {};
  for (const k of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) { saved[k] = globalThis[k]; globalThis[k] = () => { throw new Error(`network used: ${k}`); }; }
  try {
    const rows = reviewAiImport('```json\n' + reply([row(), row({ name: 'X', cycle: 'weekly' })]) + '\n```');
    backupFromRows(rows, { now: NOW });
    errorReport(rows);
  } finally {
    for (const [k, v] of Object.entries(saved)) globalThis[k] = v;
  }
});
