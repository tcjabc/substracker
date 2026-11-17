// Node tests for "Export as CSV" (js/csv-export.js) and the year chart's default stacking: the
// columns and their order, RFC 4180 quoting, formula escaping, the byte-order mark, CJK names,
// cycles and dates as the app shows them, and only real items. Run with `npm test`. Fixtures are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemsCsv, csvCell, itemRow, itemDate, CSV_BOM, CSV_COLUMNS } from '../js/csv-export.js';
import { yearStackFrom, dayStamp, todayStamp } from '../js/util.js';

const now = new Date();
const later = (months, d = 15) => dayStamp(new Date(now.getFullYear(), now.getMonth() + months, d));
const item = (over = {}) => ({
  id: `id-${Math.random()}`, type: 'expense', name: 'Example Streaming', price: 390, currency: 'TWD', cycle: 'monthly',
  nextRenewal: later(1), date: '', category: 'Entertainment', domain: '', emoji: '', plan: '', notes: '', ...over,
});
const lines = (csv) => csv.slice(CSV_BOM.length).split('\r\n');

test('the file starts with a UTF-8 byte-order mark and the header row, CRLF line ends', () => {
  const csv = itemsCsv([item()]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.deepEqual([...new TextEncoder().encode(csv).slice(0, 3)], [0xef, 0xbb, 0xbf], 'EF BB BF in UTF-8');
  assert.equal(lines(csv)[0], 'Name,Amount,Currency,Cycle,Next date,Category,Type');
  assert.deepEqual(CSV_COLUMNS, ['Name', 'Amount', 'Currency', 'Cycle', 'Next date', 'Category', 'Type']);
  assert.ok(csv.endsWith('\r\n') && !/[^\r]\n/.test(csv), 'every line ends with CRLF');
  assert.equal(lines(csv).length, 3, 'header, one row, and the final line end');
});

test('one row per item, sorted by name: amount, currency, cycle, date, category and type', () => {
  const csv = itemsCsv([
    item({ name: 'Rent', price: 18000, category: '' }),
    item({ name: 'cloud Drive', price: 9.99, currency: 'USD', cycle: 'annual', nextRenewal: later(3, 8), category: 'Cloud storage' }),
    item({ name: 'Desk', price: 2400, cycle: 'once', date: '2026-05-04', nextRenewal: '' }),
    item({ name: 'Salary', type: 'income', price: 52000, nextRenewal: later(1, 28), category: 'ignored' }),
  ]);
  assert.deepEqual(lines(csv).slice(1, -1), [
    `cloud Drive,9.99,USD,annual,${later(3, 8)},Cloud storage,expense`,
    'Desk,2400,TWD,one-off,2026-05-04,Entertainment,expense',
    `Rent,18000,TWD,monthly,${later(1)},,expense`,
    `Salary,52000,TWD,monthly,${later(1, 28)},,income`,
  ]);
});

test('next date is the one the app shows: a past renewal rolls forward, an undated item stays blank', () => {
  const past = dayStamp(new Date(now.getFullYear() - 2, now.getMonth(), now.getDate()));
  const rolled = itemDate(item({ cycle: 'annual', nextRenewal: past }));
  assert.ok(rolled >= todayStamp(), `${rolled} is today or later`);
  assert.equal(rolled.slice(5), past.slice(5), 'same day of the year');
  assert.equal(itemDate(item({ nextRenewal: '' })), '', 'no date');
  assert.equal(itemDate(item({ cycle: 'once', date: '' })), '', 'a one-off with no date');
  assert.equal(itemRow(item({ type: undefined }))[6], 'expense', 'an old item without a type is an expense');
});

test('RFC 4180 quoting: commas, quotes and line breaks', () => {
  assert.equal(csvCell('Power & Water'), 'Power & Water');
  assert.equal(csvCell('Rent, flat 2'), '"Rent, flat 2"');
  assert.equal(csvCell('The "Best" Shop'), '"The ""Best"" Shop"');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell('cr\rhere'), '"cr\rhere"');
  assert.equal(csvCell(''), '');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(9.5), '9.5');
  const csv = itemsCsv([item({ name: 'Rent, "flat 2"', notes: 'not exported' })]);
  assert.equal(lines(csv)[1].split(',Entertainment')[0].startsWith('"Rent, ""flat 2"""'), true, lines(csv)[1]);
  assert.ok(!csv.includes('not exported'), 'notes are not a column');
});

test('formula escaping: a cell starting with =, +, -, @, tab or CR gets an apostrophe', () => {
  for (const [input, cell] of [
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+44 Plan', "'+44 Plan"],
    ['-5 off', "'-5 off"],
    ['@handle', "'@handle"],
    ['\tTabbed', "'\tTabbed"],
    ['\rReturn', '"\'\rReturn"'],
    ['=HYPERLINK("http://x","y")', '"\'=HYPERLINK(""http://x"",""y"")"'],
    ['=1,2', '"\'=1,2"'],
    ['Plain = fine', 'Plain = fine'],
  ]) assert.equal(csvCell(input), cell, JSON.stringify(input));
  const csv = itemsCsv([item({ name: '=cmd|calc', category: '@SUM(1)' })]);
  assert.equal(lines(csv)[1], `'=cmd|calc,390,TWD,monthly,${later(1)},'@SUM(1),expense`);
});

test('CJK and other non-ASCII names come out as UTF-8 text', () => {
  const csv = itemsCsv([item({ name: '中華電信 5G' }), item({ name: 'ネットフリックス' }), item({ name: 'Café Crème' })]);
  const body = lines(csv).slice(1, -1).map((l) => l.split(',')[0]);
  assert.deepEqual(body.sort(), ['Café Crème', 'ネットフリックス', '中華電信 5G'].sort());
  // A UTF-8 reader takes the mark as the encoding signal and drops it; the rest comes back exactly.
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(csv)), csv.slice(1), 'round-trips through UTF-8');
});

test('only items: no settings record, nothing without a name', () => {
  const csv = itemsCsv([item({ name: 'Kept' }), { id: 'settings', fields: { defaultCurrency: 'TWD' } }, { id: 'settings', name: 'settings' }, null, { id: 'x' }]);
  assert.deepEqual(lines(csv).slice(1, -1).map((l) => l.split(',')[0]), ['Kept']);
  assert.equal(lines(itemsCsv([])).length, 2, 'just the header for an empty list');
});

test('year chart stacking: By category unless this device saved By type', () => {
  assert.equal(yearStackFrom(null), 'category', 'a fresh device');
  assert.equal(yearStackFrom('category'), 'category');
  assert.equal(yearStackFrom('type'), 'type', 'a saved By type is kept');
  assert.equal(yearStackFrom('nonsense'), 'category');
});

test('dayStamp writes a local date as YYYY-MM-DD', () => {
  assert.equal(dayStamp(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(dayStamp(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.equal(todayStamp(), dayStamp(new Date()));
});
