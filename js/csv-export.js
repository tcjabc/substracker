// "Export as CSV": the live items as a spreadsheet file. It is for reading in a spreadsheet, not a
// backup: it holds no settings, ids or sync data, and the app can't import it (the JSON export is
// the backup). Pure functions, also used by the Node tests.
//
// One row per item: Name, Amount, Currency, Cycle (monthly / annual / one-off), Next date
// (YYYY-MM-DD, the date the app shows: a recurring item's next renewal or payment, rolled forward
// from a past stored date; a one-off's date), Category and Type (expense / income).
// RFC 4180: comma-separated, CRLF line ends, a cell with a comma, quote or line break is quoted and
// its quotes doubled. A cell that starts with =, +, -, @, a tab or a carriage return gets a leading
// apostrophe, so a spreadsheet shows it as text instead of running it as a formula. The file
// starts with a UTF-8 byte-order mark, so spreadsheets read accented and CJK text correctly.

import { isOnce, nextRenewal, dayStamp } from './util.js';

/** The byte-order mark the file starts with. */
export const CSV_BOM = String.fromCharCode(0xfeff);
export const CSV_COLUMNS = ['Name', 'Amount', 'Currency', 'Cycle', 'Next date', 'Category', 'Type'];
const CYCLE_NAMES = { monthly: 'monthly', annual: 'annual', once: 'one-off' };
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell, escaped against formulas and quoted as RFC 4180 needs. */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The date the app shows for an item, as YYYY-MM-DD, or '' when it has none. */
export function itemDate(item) {
  if (isOnce(item)) return /^\d{4}-\d{2}-\d{2}$/.test(item.date ?? '') ? item.date : '';
  const next = nextRenewal(item);
  return next ? dayStamp(next) : '';
}

/** The row for one item, in CSV_COLUMNS order. */
export function itemRow(item) {
  const income = item.type === 'income';
  return [
    item.name ?? '',
    Number.isFinite(item.price) ? item.price : '',
    item.currency ?? '',
    CYCLE_NAMES[item.cycle] ?? item.cycle ?? '',
    itemDate(item),
    income ? '' : item.category ?? '',
    income ? 'income' : 'expense',
  ];
}

const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });

/**
 * The CSV text for `items` (live items, as storage.getAll() gives them), sorted by name, with the
 * byte-order mark first. Nothing that isn't an item gets in: the settings record and deleted items
 * aren't items, and anything without a name is left out too.
 */
export function itemsCsv(items) {
  const rows = items.filter((s) => s && typeof s.name === 'string' && s.id !== 'settings').sort(byName).map(itemRow);
  return CSV_BOM + [CSV_COLUMNS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
