// Node tests for the optional "notes" field of "Import with AI" (1.22.2): js/import-ai.js reads it
// (trimmed, at most 500 characters, longer is shortened and flagged, never refused), carries it
// into the format-4 backup and so into the item's own notes, for income too; the prompt
// (js/import-ai-prompt.js) asks for it. Replies without notes, as every reply before 1.22.2 was,
// read as before: the schema version stays 1. Run with `npm test`. Fixtures are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sync from '../js/sync-core.js';
import * as storage from '../js/storage.js';
import {
  reviewAiImport, reviewRows, backupFromRows, itemFromFields, errorReport, clipText, NOTES_MAX, PROBLEM, AI_SCHEMA_VERSION,
} from '../js/import-ai.js';
import { AI_IMPORT_PROMPT } from '../js/import-ai-prompt.js';

const NOW = '2026-06-01T00:00:00.000Z';
const row = (over = {}) => ({
  name: 'Example Streaming', amount: 390, currency: 'TWD', cycle: 'monthly', nextDate: '2026-12-05',
  category: 'Entertainment', type: 'expense', ...over,
});
const reply = (rows) => JSON.stringify({ version: 1, rows });
let seq = 0;
const newId = () => `note-${++seq}`;
// Characters by code, so none hide in this file.
const ch = (...codes) => String.fromCodePoint(...codes);
const LDQ = ch(0x201c);
const RDQ = ch(0x201d);
const LSQ = ch(0x2018);
const RSQ = ch(0x2019);
const CLAPPER = ch(0x1f3ac);
const BRIEFCASE = ch(0x1f4bc);
const FAMILY = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467); // three people held together by two joiners
const points = (s) => [...s].length;

const liveItems = (replica) => [...replica.records.values()].map(storage.toItem).filter(Boolean).sort((x, y) => x.name.localeCompare(y.name));
/** Import `backup` into an empty replica the way the app's Merge does, and return the items. */
function importIntoEmpty(backup) {
  const { records, clock } = storage.recordsFromItems([], sync.newClock('devA'), Date.parse(NOW));
  const replica = { clock, records: new Map(records.map((r) => [r.id, r])) };
  storage.importOps(replica, storage.planFromBackup(storage.parseBackup(backup), [], {}).merge, { now: Date.parse(NOW) });
  return liveItems(replica);
}

/* ------------------------------------------------------------------ The phone-paste fixture */
// tests/fixtures/ai-reply-notes.txt: a fictional reply as a phone paste brings it, with text around
// the JSON, no-break spaces for indentation and a zero-width space inside a date. Its notes have
// curly double and single quotes, emoji (one held together by joiners), spaces round one note,
// a row without "notes" and one with "notes": "".
const NOTES_REPLY = readFileSync(new URL('./fixtures/ai-reply-notes.txt', import.meta.url), 'utf8');

test('the notes fixture: a phone paste, so plain JSON.parse fails on it', () => {
  assert.ok(NOTES_REPLY.includes(ch(0xa0)) && NOTES_REPLY.includes(ch(0x200b)), 'no-break spaces and a zero-width space');
  const json = NOTES_REPLY.slice(NOTES_REPLY.indexOf('{'), NOTES_REPLY.lastIndexOf('}') + 1);
  assert.throws(() => JSON.parse(json));
});

test('the notes fixture: every row ok and included, each note exactly as written, trimmed', () => {
  const rows = reviewAiImport(NOTES_REPLY);
  assert.deepEqual(rows.map((r) => [r.n, r.fields.name, r.status, r.include]), [
    [1, 'Example Streaming', 'ok', true], [2, 'Sample Gym', 'ok', true], [3, 'Sample Salary', 'ok', true],
    [4, 'Cloud Notes', 'ok', true], [5, 'Concert', 'ok', true],
  ]);
  assert.deepEqual(rows.map((r) => r.fields.notes), [
    `Family plan, shared with ${LDQ}the flat${RDQ} ${CLAPPER}`,
    `Paid from the ${LSQ}Joint account${RSQ}`,
    `After tax, ${LDQ}Main job${RDQ} ${BRIEFCASE} ${FAMILY}`,
    '',
    '',
  ]);
  assert.ok(rows[2].fields.notes.endsWith(FAMILY), 'the joiners inside the emoji stay');
  assert.equal(rows[3].fields.nextDate, '2027-03-14', 'the zero-width space in the date goes');
  assert.equal(errorReport(rows), '', 'nothing to report');
});

test('the notes fixture: the notes land in the items, income included, through the normal import', () => {
  const backup = backupFromRows(reviewAiImport(NOTES_REPLY), { now: NOW, newId });
  assert.deepEqual([backup.schemaVersion, 'settings' in backup], [storage.SCHEMA_VERSION, false], 'a format-4 backup without settings');
  const items = importIntoEmpty(backup);
  const byName = Object.fromEntries(items.map((s) => [s.name, s]));
  assert.equal(byName['Example Streaming'].notes, `Family plan, shared with ${LDQ}the flat${RDQ} ${CLAPPER}`);
  assert.equal(byName['Sample Salary'].type, 'income');
  assert.equal(byName['Sample Salary'].notes, `After tax, ${LDQ}Main job${RDQ} ${BRIEFCASE} ${FAMILY}`, 'income keeps its note');
  assert.equal(byName['Sample Salary'].category, '', 'and still has no category');
  assert.equal(byName['Cloud Notes'].notes, '');
  assert.equal(byName.Concert.notes, '');
});

/* ------------------------------------------------------------------ Shortened notes */

test('a note over 500 characters is shortened and flagged, and still imported', () => {
  assert.equal(NOTES_MAX, 500);
  const long = 'Paid card '.repeat(75); // 750 characters; character 500 is a space
  const [r] = reviewRows([row({ notes: long })]);
  assert.equal(points(r.fields.notes), 500 - 1, 'cut at 500, then the space left at the cut trimmed');
  assert.ok(long.startsWith(r.fields.notes));
  assert.deepEqual([r.status, r.importable, r.include], [PROBLEM.note, true, true]);
  assert.deepEqual(r.problems.map((p) => [p.code, p.message]), [
    [PROBLEM.note, 'Row 1: notes were longer than 500 characters and were shortened; check them after importing'],
  ]);
  assert.equal(errorReport([r]), '', 'not an error for the AI');
  assert.equal(backupFromRows([r], { now: NOW, newId }).items[0].notes, r.fields.notes, 'the item gets the shortened note');
});

test('exactly 500 characters is kept whole; the limit counts characters, not UTF-16 units', () => {
  const emoji500 = CLAPPER.repeat(500); // 500 characters, 1,000 UTF-16 units
  const [a] = reviewRows([row({ notes: emoji500 })]);
  assert.deepEqual([a.status, a.fields.notes === emoji500], ['ok', true]);
  const [b] = reviewRows([row({ notes: `${'x'.repeat(500)}  ` })]);
  assert.equal(b.status, 'ok', 'spaces round the note are trimmed before counting');
  const [c] = reviewRows([row({ notes: CLAPPER.repeat(501) })]);
  assert.deepEqual([c.status, points(c.fields.notes), c.fields.notes.length], [PROBLEM.note, 500, 1000]);
  const item = importIntoEmpty(backupFromRows([c], { now: NOW, newId }))[0];
  assert.equal(item.notes, c.fields.notes, 'within the item\u2019s own notes limit, so the import keeps all of it');
});

test('a cut never splits an emoji: one held together by joiners goes whole', () => {
  const text = `${'a'.repeat(498)}${FAMILY} after`; // the emoji would be characters 499 to 503
  assert.equal(clipText(text, 500), 'a'.repeat(498));
  assert.equal(clipText(`${'a'.repeat(495)}${FAMILY} after`, 500), `${'a'.repeat(495)}${FAMILY}`);
  assert.equal(clipText('short', 500), 'short');
});

test('a flagged note on a row with another problem: the other problem leads, the note is still said', () => {
  const [r] = reviewRows([row({ nextDate: '', notes: 'n'.repeat(600) })]);
  assert.equal(r.status, PROBLEM.date);
  assert.deepEqual(r.problems.map((p) => p.code), [PROBLEM.date, PROBLEM.note]);
  assert.equal(r.importable, false, 'the missing date still blocks it');
  assert.equal(errorReport([r]), [
    'Peek Budget could not import some of your JSON:',
    '- Row 1: nextDate is missing; add the next renewal date as YYYY-MM-DD, like 2026-12-05',
    '',
    'Please fix these and reply with the whole corrected JSON only, nothing else, in the same shape ({"version": 1, "rows": [...]}).',
    "If a fix needs a date, an amount or a cycle you can't read from my documents, ask me instead of guessing.",
  ].join('\n'), 'the report lists the date, not the note');
});

/* ------------------------------------------------------------------ Wrong notes, income, duplicates */

test('notes that are not text: the row can\u2019t be imported, and the report says so like any field', () => {
  const rows = reviewRows([row({ notes: 42 }), row({ name: 'B', notes: ['a'] }), row({ name: 'C', notes: { a: 1 } }), row({ name: 'D', notes: true })]);
  assert.deepEqual(rows.map((r) => [r.status, r.importable]), Array(4).fill([PROBLEM.error, false]));
  assert.equal(errorReport(rows).split('\n').slice(1, 5).join('\n'), [
    '- Row 1: notes must be text in quotes, or ""',
    '- Row 2: notes must be text in quotes, or ""',
    '- Row 3: notes must be text in quotes, or ""',
    '- Row 4: notes must be text in quotes, or ""',
  ].join('\n'));
});

test('null, "" and spaces-only notes are no note', () => {
  const rows = reviewRows([row({ notes: null }), row({ name: 'B', notes: '' }), row({ name: 'C', notes: '   ' })]);
  assert.deepEqual(rows.map((r) => [r.status, r.fields.notes]), [['ok', ''], ['ok', ''], ['ok', '']]);
});

test('an income row with notes keeps them, also after the form\u2019s own conversion', () => {
  const [r] = reviewRows([row({ name: 'Sample Salary', type: 'income', amount: 52000, category: 'Work', notes: 'After tax' })]);
  assert.deepEqual([r.status, r.fields.category, r.fields.notes], ['ok', '', 'After tax']);
  const item = itemFromFields(r.fields, NOW, () => 'x');
  assert.deepEqual([item.type, item.category, item.notes], ['income', '', 'After tax']);
});

test('notes play no part in duplicates', () => {
  const rows = reviewRows([row({ notes: 'First card' }), row({ notes: 'Second card' }), row({ notes: '' })]);
  assert.deepEqual(rows.map((r) => [r.status, r.duplicateOf]), [['ok', null], [PROBLEM.duplicate, { row: 1 }], [PROBLEM.duplicate, { row: 1 }]]);
  const existing = [{ ...itemFromFields(rows[0].fields, NOW, () => 'have'), notes: 'Something else' }];
  assert.equal(reviewRows([row()], existing)[0].status, PROBLEM.duplicate, 'an item with other notes still matches');
});

test('a line break copied into a note is a space, as in a name', () => {
  const json = reply([row({ notes: 'Shared with the family plan' })]).replace('the family', 'the\nfamily');
  assert.throws(() => JSON.parse(json), 'a raw line break inside a string');
  assert.equal(reviewAiImport(json)[0].fields.notes, 'Shared with the family plan');
});

/* ------------------------------------------------------------------ Old replies, the prompt */

test('an old-schema reply without notes reads exactly as before: version 1, notes empty', () => {
  assert.equal(AI_SCHEMA_VERSION, 1);
  const old = JSON.stringify({ version: 1, rows: [row(), row({ name: 'Sample Salary', type: 'income', amount: 52000, category: '' })] });
  const rows = reviewAiImport(old);
  assert.deepEqual(rows.map((r) => [r.status, r.include, r.fields.notes]), [['ok', true, ''], ['ok', true, '']]);
  assert.deepEqual(backupFromRows(rows, { now: NOW, newId }).items.map((s) => s.notes), ['', '']);
});

test('the prompt asks for notes: optional, 500 characters, context words, never numbers, income too', () => {
  for (const s of ['"notes"', 'notes is optional', 'at most 500 characters', 'account nickname', 'payment reference',
    'Income rows may have notes too', 'Never put account numbers, card numbers, IBANs or reference numbers in notes',
    // the privacy rules are still there, word for word
    'Leave out account numbers, card numbers, IBANs, reference numbers and any person\'s name (mine or anyone else\'s).']) {
    assert.ok(AI_IMPORT_PROMPT.includes(s), s);
  }
  const example = AI_IMPORT_PROMPT.slice(AI_IMPORT_PROMPT.indexOf('{\n  "version"'));
  const [r] = reviewAiImport(example.slice(0, example.indexOf('\n}\n') + 2));
  assert.deepEqual([r.status, r.fields.notes], ['ok', 'Family plan'], 'the example shows a note and is itself a valid reply');
  assert.equal(/\d{4}/.test(r.fields.notes), false, 'with no number in it');
});
