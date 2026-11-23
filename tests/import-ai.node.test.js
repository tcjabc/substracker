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
  itemFromFields, totalsOf, TOTAL_LABELS, errorReport, isRealDay, AI_SCHEMA_VERSION, MAX_AI_CHARS, MAX_AI_ROWS, PROBLEM,
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
    nextDate: '2026-12-05', category: 'Entertainment', type: 'expense', notes: '',
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
    ['"text"', /must be an object like \{"version": 1, "rows": \[\.\.\.\]\}/],
    [JSON.stringify({ rows: [row()] }), /"version" is missing; add "version": 1\./],
    [JSON.stringify({ version: 2, rows: [row()] }), /"version" must be the number 1 without quotes/],
    [JSON.stringify({ version: '1', rows: [row()] }), /"version" must be the number 1 without quotes/],
    [JSON.stringify({ version: 1 }), /"rows" is missing; add "rows": \[\.\.\.\]/],
    [JSON.stringify({ version: 1, rows: {} }), /"rows" must be a list in square brackets/],
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

/* ------------------------------------------------------------------ Replies pasted on a phone */
// tests/fixtures/ai-reply-statement.json is a real reply's shape from a fictional statement; the
// .txt one is the same reply followed by the follow-up suggestions a chat app shows under it.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const STATEMENT = fixture('ai-reply-statement.json');
const ch = (code) => String.fromCharCode(code); // invisible characters by code, so none hide in this file
const outcome = (text) => reviewAiImport(text).map((r) => `${r.n} ${r.fields.name} ${r.status} ${r.include}`);
const EXPECTED = outcome(STATEMENT);

test('the statement fixture: 18 rows, weekly and quarterly flagged, both Tutoring one-offs included', () => {
  const rows = reviewAiImport(STATEMENT);
  assert.equal(rows.length, 18);
  assert.deepEqual(rows.filter((r) => r.status !== 'ok').map((r) => [r.n, r.status, r.fields.cycleText]), [[5, 'cycle', 'weekly'], [13, 'cycle', 'quarterly']]);
  assert.equal(rows.filter((r) => r.include).length, 16);
  assert.deepEqual(rows.filter((r) => r.fields.name === 'Tutoring').map((r) => [r.fields.nextDate, r.include]), [['2026-10-25', true], ['2026-11-26', true]]);
});

// tests/fixtures/ai-reply-wrapped.txt is the exact text read from the paste box on the phone: the
// chat app copied its on-screen line wrapping as line breaks, at spaces (the space lost) and
// mid-word, inside names, categories, keys and dates, and a stray "q" follows the JSON.
const WRAPPED = fixture('ai-reply-wrapped.txt');

test('the phone paste with copied line wrapping reads exactly like the clean reply', () => {
  assert.equal(WRAPPED.length, 2505);
  assert.equal((WRAPPED.match(/\n/g) ?? []).length, 33);
  assert.ok(/[^\x20-\x7e\n]/.test(WRAPPED) === false, 'printable ASCII and line breaks only');
  assert.throws(() => JSON.parse(WRAPPED.slice(0, -1)), /control character/, 'plain JSON.parse fails on it');
  assert.deepEqual(outcome(WRAPPED), EXPECTED);
  const rows = reviewAiImport(WRAPPED);
  assert.deepEqual(rows.slice(0, 3).map((r) => [r.fields.name, r.fields.category]),
    [['Salary - Northwind Learning Co', ''], ['LoopTune Music', 'Music'], ['PixelFlix Streaming', 'Entertainment']]);
  assert.deepEqual([rows[5].fields.category, rows[6].fields.category, rows[16].fields.nextDate], ['Cloud storage', 'Utilities', '2026-11-26']);
  assert.deepEqual(outcome(WRAPPED.replaceAll('\n', '\r\n')), EXPECTED, 'the same with CRLF line breaks');
  assert.deepEqual(outcome(`Here you go: ${WRAPPED}`), EXPECTED, 'with text before the JSON on its first line');
});

/** The text wrapped the way a screen does: at the last space that fits (the space is lost), else mid-word. */
function wrapLikeAScreen(text, width) {
  const lines = [];
  let pos = 0;
  while (text.length - pos > width) {
    const k = text.lastIndexOf(' ', pos + width);
    if (k > pos) { lines.push(text.slice(pos, k)); pos = k + 1; } else { lines.push(text.slice(pos, pos + width)); pos += width; }
  }
  lines.push(text.slice(pos));
  return lines.join('\n');
}

test('copied line wrapping at any width: dates, amounts, codes, cycles, types and categories come back exactly', () => {
  const clean = reviewAiImport(STATEMENT);
  const strict = (r) => [r.fields.amount, r.fields.currency, r.fields.cycle, r.fields.cycleText, r.fields.nextDate, r.fields.type, r.fields.category, r.status, r.include];
  let names = 0;
  for (let width = 20; width <= 150; width++) {
    const rows = reviewAiImport(wrapLikeAScreen(STATEMENT.trim(), width));
    assert.deepEqual(rows.map(strict), clean.map(strict), `width ${width}`);
    names += rows.filter((r, i) => r.fields.name === clean[i].fields.name).length;
  }
  // A space that falls exactly at the edge of a line can't be told from a mid-word break; names
  // are guessed then, and almost all come back exactly.
  assert.ok(names / (131 * 18) > 0.97, `${names} of ${131 * 18} names exact`);
});

test('a line break copied inside a number or a key is undone', () => {
  const lines = [`{"version":1,"rows":[{"name":"Rent","amount":180`, `00,"currency":"TWD","cycle":"monthly","nextDa`, `te":"2026-11-05","category":"","type":"expense"}]}`];
  assert.deepEqual(reviewAiImport(lines.join('\n')).map((r) => [r.fields.amount, r.fields.nextDate, r.status]), [[18000, '2026-11-05', 'ok']]);
});

test('the statement fixture with suggestion text after it reads the same', () => {
  const text = fixture('ai-reply-with-chips.txt');
  assert.ok(text.trimEnd().endsWith('Explain the categories'));
  assert.deepEqual(outcome(text), EXPECTED);
});

test('invisible characters and curly quotes from a phone paste are read, not reported as a missing "version"', () => {
  const NBSP = ch(0xa0); const ZWSP = ch(0x200b); const ZWNJ = ch(0x200c); const ZWJ = ch(0x200d); const WJ = ch(0x2060);
  const BOM = ch(0xfeff); const SHY = ch(0xad); const NNBSP = ch(0x202f); const IDEO = ch(0x3000); const LSEP = ch(0x2028);
  const LQ = ch(0x201c); const RQ = ch(0x201d);
  const cases = {
    'no-break space between tokens': STATEMENT.replace('"version":1,', `"version":1,${NBSP}`).replaceAll('},{', `},${NBSP}{`),
    'no-break space inside a key': STATEMENT.replace('"version"', `"version${NBSP}"`),
    'narrow no-break and ideographic spaces': STATEMENT.replace('{"version"', `{${NNBSP}"version"`).replace('"rows":', `"rows":${IDEO}`),
    'line separator': STATEMENT.replace('"rows":', `"rows":${LSEP}`),
    'zero-width space between tokens': STATEMENT.replace('"version":1,', `"version":1${ZWSP},`),
    'zero-width space inside a key': STATEMENT.replace('"version"', `"${ZWSP}version"`).replace('"nextDate"', `"next${ZWSP}Date"`),
    'zero-width space inside a date in otherwise valid JSON': STATEMENT.replace('"2026-11-03"', `"2026-11${ZWSP}-03"`),
    'zero-width joiner between tokens':STATEMENT.replace('"version":1,', `"version":1${ZWJ},`),
    'zero-width non-joiner between tokens': STATEMENT.replace('"rows":[', `"rows":${ZWNJ}[`),
    'word joiner': STATEMENT.replace('"rows":', `"rows"${WJ}:`),
    'soft hyphen': STATEMENT.replace('"rows":', `"rows":${SHY}`),
    'byte-order mark before the JSON': `Here it is:\n${BOM}${STATEMENT}`,
    'byte-order mark inside the JSON': STATEMENT.replace('{"version"', `{${BOM}"version"`).replace('"rows":', `"rows":${BOM}`),
    'curly quotes around the keys': STATEMENT.replace('"version"', `${LQ}version${RQ}`).replace('"rows"', `${LQ}rows${RQ}`),
    'curly quotes everywhere': STATEMENT.replaceAll(/"([^"]*)"/g, `${LQ}$1${RQ}`),
    'a straight quote closed by a curly one': STATEMENT.replace('"version"', `"version${RQ}`),
    'all of them at once': `${BOM}Sure:${NBSP}\n${STATEMENT.replace('{"version":1,', `{${ZWSP}${LQ}version${RQ}:${NBSP}1,${ZWJ}`)}\n\nExplain the categories`,
  };
  for (const [label, text] of Object.entries(cases)) {
    assert.notEqual(text, STATEMENT, `${label}: the case changes the text`);
    assert.deepEqual(outcome(text), EXPECTED, label);
  }
});

test('cleaning keeps what belongs inside names: joiners in emoji, curly quotes as text', () => {
  const ZWJ = ch(0x200d); const ZWSP = ch(0x200b); const LQ = ch(0x201c); const RQ = ch(0x201d);
  const family = `${String.fromCodePoint(0x1f468)}${ZWJ}${String.fromCodePoint(0x1f467)} Family Plan`;
  const text = `${reply([row({ name: family }), row({ name: `The ${LQ}Best${RQ} Shop` }), row({ name: `Zero${ZWSP}Width` })])}${ch(0xa0)}`;
  assert.deepEqual(reviewAiImport(text).map((r) => r.fields.name), [family, `The ${LQ}Best${RQ} Shop`, 'ZeroWidth']);
});

test('a broken reply says the JSON has a mistake, never that a row lacks "version"', () => {
  for (const text of [STATEMENT.replace('},{"name":"Rent"', '}{"name":"Rent"'), STATEMENT.slice(0, -2), `Here:\n${STATEMENT.replace(':62000,', ':62000,,')}`]) {
    assert.throws(() => parseAiImport(text), (e) => e instanceof AiImportError && !/version/.test(e.message), text.slice(-30));
  }
  assert.throws(() => parseAiImport(STATEMENT.replace('},{"name":"Rent"', '}{"name":"Rent"')),
    { message: 'The JSON has a mistake and can\'t be read, for example a missing comma, quote or bracket. Ask for the whole JSON again, with straight double quotes and nothing else.' });
});

test('the missing-version message, word for word', () => {
  assert.throws(() => parseAiImport(JSON.stringify({ rows: [row()] })), { message: '"version" is missing; add "version": 1.' });
});

/* ------------------------------------------------------------------ Rows */

test('partial JSON: good rows stay usable next to bad ones, with row-level messages', () => {
  const rows = reviewAiImport(reply([row(), row({ currency: undefined }), 'oops', row({ name: 'Other' })]));
  assert.deepEqual(rows.map((r) => r.status), ['ok', 'error', 'error', 'ok']);
  assert.deepEqual(messages(rows[1]), ['Row 2: currency is missing; add a 3-letter code in quotes, like "TWD"']);
  assert.deepEqual(messages(rows[2]), ['Row 3: must be an object with name, amount, currency, cycle, nextDate, category and type']);
  assert.deepEqual(rows.map((r) => r.include), [true, false, false, true]);
});

test('missing required fields each get their own message', () => {
  const r = checkRow({}, 4);
  assert.deepEqual(r.problems.map((p) => p.message), [
    'Row 4: name is missing; add the merchant or payer name as text, like "Example Streaming"',
    'Row 4: amount is missing; add it as a number without quotes, like 390',
    'Row 4: currency is missing; add a 3-letter code in quotes, like "TWD"',
    'Row 4: type is missing; use "expense" or "income"',
    'Row 4: cycle is missing; use "monthly", "annual" or "one-off"',
    'Row 4: nextDate is missing; add the next renewal date as YYYY-MM-DD, like 2026-12-05',
  ]);
});

test('wrong types are errors, never converted', () => {
  const cases = [
    [{ name: 42 }, 'Row 1: name must be text in quotes, like "Example Streaming"'],
    [{ amount: '390' }, 'Row 1: amount must be a number without quotes, like 390'],
    [{ amount: -5 }, 'Row 1: amount must be 0 or more without a minus sign; use "type": "income" for money coming in'],
    [{ amount: 1e13 }, 'Row 1: amount is too large; check it against the document'],
    [{ currency: 901 }, 'Row 1: currency must be a 3-letter code in quotes, like "TWD"'],
    [{ currency: 'XYZ' }, 'Row 1: currency "XYZ" isn\'t supported; use one of TWD, USD, EUR, GBP, JPY, HKD, CNY, KRW, SGD, AUD, CAD, NZD, CHF, THB, MYR, PHP, IDR, VND, INR, or leave the row out'],
    [{ type: 'refund' }, 'Row 1: type must be "expense" or "income"'],
    [{ cycle: 12 }, 'Row 1: cycle must be "monthly", "annual" or "one-off" in quotes'],
    [{ category: ['x'] }, 'Row 1: category must be text in quotes, or ""'],
    [{ category: 'c'.repeat(41) }, 'Row 1: category must be at most 40 characters; shorten it or use ""'],
    [{ name: 'n'.repeat(81) }, 'Row 1: name must be at most 80 characters; shorten it'],
    [{ nextDate: 20261205 }, 'Row 1: nextDate must be YYYY-MM-DD, like 2026-12-05, not "20261205"'],
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
    [{ nextDate: undefined }, 'Row 1: nextDate is missing; add the next renewal date as YYYY-MM-DD, like 2026-12-05'],
    [{ nextDate: '' }, 'Row 1: nextDate is missing; add the next renewal date as YYYY-MM-DD, like 2026-12-05'],
    [{ nextDate: null, type: 'income' }, 'Row 1: nextDate is missing; add the next payment date as YYYY-MM-DD, like 2026-12-05'],
    [{ nextDate: '  ', cycle: 'one-off' }, 'Row 1: nextDate is missing; add the date as YYYY-MM-DD, like 2026-12-05'],
    [{ nextDate: '05/12/2026' }, 'Row 1: nextDate must be YYYY-MM-DD, like 2026-12-05, not "05/12/2026"'],
    [{ nextDate: '2026-02-30' }, 'Row 1: nextDate "2026-02-30" isn\'t a real date; use the next renewal date as a real YYYY-MM-DD date'],
    [{ nextDate: '2026-12' }, 'Row 1: nextDate must be YYYY-MM-DD, like 2026-12-05, not "2026-12"'],
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
    assert.match(messages(r)[0], new RegExp(`^Row 1: unsupported cycle "${c}"; cycle must be "monthly", "annual" or "one-off", or leave the row out$`));
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
  assert.deepEqual(messages(bad), ['Row 1: remove "id": "settings"; rows don\'t need an id']);
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

test('one-offs are duplicates only on the same date; monthly and annual ignore the date', () => {
  const tutoring = (nextDate) => row({ name: 'Tutoring', amount: 4800, cycle: 'one-off', nextDate, category: '', type: 'income' });
  const rows = reviewRows([tutoring('2026-10-25'), tutoring('2026-11-26'), tutoring('2026-10-25'),
    row(), row({ nextDate: '2027-01-05' }), row({ cycle: 'annual', name: 'Cloud' }), row({ cycle: 'annual', name: 'Cloud', nextDate: '2027-06-01' })]);
  assert.deepEqual(rows.map((r) => [r.status, r.include]), [
    ['ok', true], ['ok', true], ['duplicate', false],
    ['ok', true], ['duplicate', false], ['ok', true], ['duplicate', false],
  ]);
  assert.deepEqual(messages(rows[2]), ['Row 3: same as row 1, skipped']);
  // Against the list: a one-off already there on another date is a new transaction.
  const existing = [{ id: 'a', type: 'income', name: 'Tutoring', price: 4800, currency: 'TWD', cycle: 'once', date: '2026-10-25' }];
  assert.deepEqual(reviewRows([tutoring('2026-10-25'), tutoring('2026-11-26')], existing).map((r) => r.status), ['duplicate', 'ok']);
  // A one-off with no date isn't compared until the date is fixed.
  assert.deepEqual(reviewRows([tutoring('2026-10-25'), tutoring('')]).map((r) => r.status), ['ok', 'date']);
  assert.deepEqual(reviewRows([tutoring('2026-10-25'), tutoring('2026-10-25')], []).map((r) => r.status), ['ok', 'duplicate']);
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
  // Every item field but `pay` (1.26.0): Import with AI leaves how an item is paid Not set, which is no `pay` at all.
  assert.deepEqual(Object.keys(items[0]), ['id', ...storage.ITEM_FIELDS.filter((f) => f !== 'pay')]);
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

test('totals preview: cash basis per currency and cycle, nothing averaged', () => {
  const rows = reviewRows([row(), row({ name: 'Cloud', cycle: 'annual', amount: 1290 }), row({ name: 'Bonus', cycle: 'annual', type: 'income', amount: 30000 }),
    row({ name: 'Pay', type: 'income', amount: 50000 }), row({ name: 'Desk', cycle: 'one-off', amount: 99 }), row({ name: 'US', currency: 'USD', amount: 10 })]);
  const { items } = backupFromRows(rows, { now: NOW, newId });
  assert.deepEqual(totalsOf(items), [
    { currency: 'TWD', count: 5, monthly: { out: 390, in: 50000, count: 2 }, annual: { out: 1290, in: 30000, count: 2 }, once: { out: 99, in: 0, count: 1 } },
    { currency: 'USD', count: 1, monthly: { out: 10, in: 0, count: 1 }, annual: { out: 0, in: 0, count: 0 }, once: { out: 0, in: 0, count: 0 } },
  ]);
  assert.equal(JSON.stringify(totalsOf(items)).includes('107.5'), false, 'no 1290 / 12 anywhere');
  assert.deepEqual(TOTAL_LABELS, { monthly: 'Monthly items', annual: 'Yearly items', once: 'One-off' });
});

/* ------------------------------------------------------------------ Error text for the AI */

test('the error report lists row problems (not duplicates) and asks for JSON only', () => {
  const rows = reviewRows([row(), row(), row({ currency: '' }), row({ cycle: 'weekly', name: 'W' })]);
  const text = errorReport(rows);
  assert.match(text, /- Row 3: currency is missing; add a 3-letter code in quotes, like "TWD"\n- Row 4: unsupported cycle "weekly"/);
  assert.doesNotMatch(text, /Row 2/);
  assert.match(text, /whole corrected JSON only, nothing else/);
  assert.equal(errorReport(reviewRows([row()])), '', 'nothing to report');
  assert.match(errorReport('"version" is missing; add "version": 1.'), /- "version" is missing/);
});

test('the error report text, exactly: every line says how to fix it', () => {
  const rows = reviewRows([
    row(),
    row({ amount: '390' }),
    row(),
    row({ nextDate: '05/12/2026' }),
    row({ name: 'Weekly Box', cycle: 'weekly' }),
    row({ name: 'Pay', type: 'income', nextDate: '' }),
  ]);
  const footer = [
    '',
    'Please fix these and reply with the whole corrected JSON only, nothing else, in the same shape ({"version": 1, "rows": [...]}).',
    "If a fix needs a date, an amount or a cycle you can't read from my documents, ask me instead of guessing.",
  ];
  assert.equal(errorReport(rows), [
    'Peek Budget could not import some of your JSON:',
    '- Row 2: amount must be a number without quotes, like 390',
    '- Row 4: nextDate must be YYYY-MM-DD, like 2026-12-05, not "05/12/2026"',
    '- Row 5: unsupported cycle "weekly"; cycle must be "monthly", "annual" or "one-off", or leave the row out',
    '- Row 6: nextDate is missing; add the next payment date as YYYY-MM-DD, like 2026-12-05',
    ...footer,
  ].join('\n'), 'row 3 is a duplicate of row 1 and is not an error');
  assert.equal(errorReport('"rows" is empty; there is nothing to import.'), [
    'Peek Budget could not import some of your JSON:',
    '- "rows" is empty; there is nothing to import.',
    ...footer,
  ].join('\n'));
});

/* ------------------------------------------------------------------ The prompt */

test('the prompt states the schema, allowed values and the rules', () => {
  for (const s of ['"version": 1', '"rows"', '"name"', '"amount"', '"currency"', '"cycle"', '"nextDate"', '"category"', '"type"',
    '"monthly", "annual" or "one-off"', '"expense"', '"income"', 'YYYY-MM-DD', 'only the JSON, nothing else', "every field must be present on every row; category may be ''", 'leave that item out unless I tell you which currency to use',
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
