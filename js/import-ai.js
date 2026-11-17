// "Import with AI": read the JSON an AI chat of the person's own choosing wrote from their
// statements (see js/import-ai-prompt.js for the text they give it). The app never sends anything
// anywhere: the person copies the prompt out and pastes or picks the reply. Pure functions, no
// network, no storage access; also used by the Node tests.
//
// The import schema is separate from the backup format and simpler:
//   { "version": 1, "rows": [ { name, amount, currency, cycle, nextDate, category, type } ] }
// Rows are checked one by one, so a reply with a few bad rows still shows the good ones. A row
// becomes an item only through a normal backup (format 4, without settings), which goes through
// storage.parseBackup and the existing Merge / Replace import, so ids, field stamps, types and
// nextRenewal are made exactly as for any other import.

import { CURRENCIES, uid, isOnce, MERGE_SYNC_NOTE } from './util.js';
import { APP_ID, SCHEMA_VERSION, SETTINGS_ID, parseBackup } from './storage.js';

export const AI_SCHEMA_VERSION = 1;
export const MAX_AI_CHARS = 500_000;
export const MAX_AI_ROWS = 500;
export const NAME_MAX = 80;
export const CATEGORY_MAX = 40;
const AMOUNT_MAX = 1e12;

/** The cycles the schema accepts, and the app's own name for each. Anything else is flagged, never guessed. */
export const AI_CYCLES = { monthly: 'monthly', annual: 'annual', 'one-off': 'once' };
const TYPES = ['expense', 'income'];
const SHAPE = '{"version": 1, "rows": [...]}';

/** A problem with the reply as a whole (not one row). `message` is written for the person importing. */
export class AiImportError extends Error {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());

/** Whether `v` is a real calendar date written as YYYY-MM-DD. */
export function isRealDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/* --------------------------------------------------------------------------
   Finding the JSON in a reply
   -------------------------------------------------------------------------- */
const tryParse = (s) => { try { return { ok: true, value: JSON.parse(s) }; } catch { return { ok: false }; } };

/** The balanced {...} starting at `start`, skipping braces inside strings, or null. */
function balancedObject(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * The JSON object in a pasted reply or picked file. Tolerant of what chats wrap around it: a
 * byte-order mark, code fences, or text before and after. Throws AiImportError when there's none.
 */
export function extractJson(input) {
  if (isObj(input)) return input;
  if (typeof input !== 'string') throw new AiImportError('Nothing to import. Paste the reply or pick its file.');
  if (input.length > MAX_AI_CHARS) {
    throw new AiImportError(`That's too long to import (over ${MAX_AI_CHARS.toLocaleString('en')} characters). Import fewer rows at a time.`);
  }
  const text = input.replace(/^﻿/, '').trim();
  if (!text) throw new AiImportError('Nothing to import. Paste the reply or pick its file.');

  const candidates = [text];
  for (const m of text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)) candidates.push(m[1].trim());
  let tries = 0;
  for (let i = text.indexOf('{'); i !== -1 && tries < 50; i = text.indexOf('{', i + 1), tries++) {
    const obj = balancedObject(text, i);
    if (obj) candidates.push(obj);
  }
  let found = null;
  for (const c of candidates) {
    const r = tryParse(c);
    if (!r.ok) continue;
    if (isObj(r.value) && 'rows' in r.value) return r.value;
    found ??= r.value;
  }
  if (found !== null) return found;
  throw new AiImportError("Couldn't find any JSON in that. Paste the whole reply, or ask for the JSON only.");
}

/**
 * The rows of a reply, checked as a whole: { version: 1, rows: [...] } within the size limits.
 * Rows themselves are checked by reviewRows. Throws AiImportError.
 */
export function parseAiImport(input) {
  const data = extractJson(input);
  if (Array.isArray(data)) throw new AiImportError(`The JSON is a list; it must be an object like ${SHAPE}.`);
  if (!isObj(data)) throw new AiImportError(`The JSON must be an object like ${SHAPE}.`);
  if (data.version === undefined) throw new AiImportError('"version" is missing; add "version": 1.');
  if (data.version !== AI_SCHEMA_VERSION) throw new AiImportError(`"version" must be the number ${AI_SCHEMA_VERSION} without quotes, like "version": ${AI_SCHEMA_VERSION}.`);
  if (data.rows === undefined) throw new AiImportError('"rows" is missing; add "rows": [...] with one object per item.');
  if (!Array.isArray(data.rows)) throw new AiImportError('"rows" must be a list in square brackets, like "rows": [{...}, {...}].');
  if (!data.rows.length) throw new AiImportError('"rows" is empty; there is nothing to import.');
  if (data.rows.length > MAX_AI_ROWS) {
    throw new AiImportError(`"rows" has ${data.rows.length} rows; the most at once is ${MAX_AI_ROWS}, so split them into smaller batches.`);
  }
  return data.rows;
}

/* --------------------------------------------------------------------------
   Checking rows
   -------------------------------------------------------------------------- */
// Problem codes. "error" covers fields that are missing or the wrong type; "date" and "cycle" get
// their own codes so the review screen can offer a date picker or a cycle choice to fix them.
export const PROBLEM = { error: 'error', date: 'date', cycle: 'cycle', duplicate: 'duplicate' };

/** The date's name for this row, in the app's words. */
function dateLabel(type, cycle) {
  if (cycle === 'once') return 'date';
  return type === 'income' ? 'next payment date' : 'next renewal date';
}

/**
 * Check one row. Returns { n, fields, problems } where `fields` holds the clean values
 * ({ name, amount, currency, cycle (the app's name), cycleText, nextDate, category, type }, each
 * null when unusable) and `problems` is a list of { code, message } with messages like
 * "Row 3: currency is missing; add …", each saying how to fix it. Any `id` in the row is ignored (every row gets a new id), and a row
 * asking for the reserved id is rejected.
 */
export function checkRow(raw, n) {
  const problems = [];
  const add = (code, msg) => problems.push({ code, message: `Row ${n}: ${msg}` });
  const fields = { name: null, amount: null, currency: null, cycle: null, cycleText: null, nextDate: null, category: '', type: null };
  if (!isObj(raw)) {
    add(PROBLEM.error, 'must be an object with name, amount, currency, cycle, nextDate, category and type');
    return { n, fields, problems };
  }
  if (raw.id === SETTINGS_ID) add(PROBLEM.error, `remove "id": "${SETTINGS_ID}"; rows don't need an id`);

  if (blank(raw.name)) add(PROBLEM.error, 'name is missing; add the merchant or payer name as text, like "Example Streaming"');
  else if (typeof raw.name !== 'string') add(PROBLEM.error, 'name must be text in quotes, like "Example Streaming"');
  else if (raw.name.trim().length > NAME_MAX) add(PROBLEM.error, `name must be at most ${NAME_MAX} characters; shorten it`);
  else fields.name = raw.name.trim();

  if (raw.amount === undefined || raw.amount === null || raw.amount === '') add(PROBLEM.error, 'amount is missing; add it as a number without quotes, like 390');
  else if (typeof raw.amount !== 'number') add(PROBLEM.error, 'amount must be a number without quotes, like 390');
  else if (!Number.isFinite(raw.amount)) add(PROBLEM.error, 'amount must be a number without quotes, like 390');
  else if (raw.amount < 0) add(PROBLEM.error, 'amount must be 0 or more without a minus sign; use "type": "income" for money coming in');
  else if (raw.amount > AMOUNT_MAX) add(PROBLEM.error, 'amount is too large; check it against the document');
  else fields.amount = Math.round(raw.amount * 100) / 100;

  if (blank(raw.currency)) add(PROBLEM.error, 'currency is missing; add a 3-letter code in quotes, like "TWD"');
  else if (typeof raw.currency !== 'string') add(PROBLEM.error, 'currency must be a 3-letter code in quotes, like "TWD"');
  else {
    const c = raw.currency.trim().toUpperCase();
    if (!CURRENCIES.includes(c)) add(PROBLEM.error, `currency "${raw.currency.trim().slice(0, 12)}" isn't supported; use one of ${CURRENCIES.join(', ')}, or leave the row out`);
    else fields.currency = c;
  }

  if (blank(raw.type)) add(PROBLEM.error, 'type is missing; use "expense" or "income"');
  else if (typeof raw.type !== 'string' || !TYPES.includes(raw.type.trim().toLowerCase())) add(PROBLEM.error, 'type must be "expense" or "income"');
  else fields.type = raw.type.trim().toLowerCase();

  if (blank(raw.cycle)) add(PROBLEM.error, 'cycle is missing; use "monthly", "annual" or "one-off"');
  else if (typeof raw.cycle !== 'string') add(PROBLEM.error, 'cycle must be "monthly", "annual" or "one-off" in quotes');
  else {
    const c = raw.cycle.trim().toLowerCase();
    fields.cycleText = c.slice(0, 30);
    if (Object.prototype.hasOwnProperty.call(AI_CYCLES, c)) fields.cycle = AI_CYCLES[c];
    else add(PROBLEM.cycle, `unsupported cycle "${fields.cycleText}"; cycle must be "monthly", "annual" or "one-off", or leave the row out`);
  }

  const label = dateLabel(fields.type, fields.cycle);
  if (blank(raw.nextDate)) add(PROBLEM.date, `nextDate is missing; add the ${label} as YYYY-MM-DD, like 2026-12-05`);
  else if (typeof raw.nextDate !== 'string' || !isRealDay(raw.nextDate.trim())) {
    const got = String(raw.nextDate).slice(0, 20);
    add(PROBLEM.date, /^\d{4}-\d{2}-\d{2}$/.test(got.trim())
      ? `nextDate "${got}" isn't a real date; use the ${label} as a real YYYY-MM-DD date`
      : `nextDate must be YYYY-MM-DD, like 2026-12-05, not "${got}"`);
  } else fields.nextDate = raw.nextDate.trim();

  if (raw.category === undefined || raw.category === null) fields.category = '';
  else if (typeof raw.category !== 'string') add(PROBLEM.error, 'category must be text in quotes, or ""');
  else if (raw.category.trim().length > CATEGORY_MAX) add(PROBLEM.error, `category must be at most ${CATEGORY_MAX} characters; shorten it or use ""`);
  else fields.category = raw.category.trim();
  if (fields.type === 'income') fields.category = ''; // income has no categories in the app

  return { n, fields, problems };
}

/** The duplicate key: name (case and spacing ignored), amount, currency and cycle. */
export function duplicateKey({ name, amount, currency, cycle }) {
  const nm = String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${nm}\u0000${Math.round(Number(amount) * 100) / 100}\u0000${String(currency ?? '').toUpperCase()}\u0000${cycle}`;
}

const keyOfItem = (s) => duplicateKey({ name: s.name, amount: s.price, currency: s.currency, cycle: s.cycle });

/**
 * Check every row and mark duplicates: a row that matches an earlier row of the reply, or an item
 * already in the list (`existing`, plain items). Returns the review rows, in order:
 * { n, raw, fields, problems, status, duplicateOf, importable, include }.
 *   status       'ok', or the first problem's code: 'error', 'cycle', 'date' or 'duplicate'.
 *   duplicateOf  { row: n } or { existing: true } for a duplicate, else null.
 *   importable   no blocking problem (a duplicate can still be imported on purpose).
 *   include      the starting choice: importable and not a duplicate.
 */
export function reviewRows(rawRows, existing = []) {
  const have = new Set(existing.map(keyOfItem));
  const seen = new Map();
  return rawRows.map((raw, i) => {
    const { n, fields, problems } = checkRow(raw, i + 1);
    let duplicateOf = null;
    const comparable = fields.name !== null && fields.amount !== null && fields.currency !== null && fields.cycle !== null;
    if (comparable) {
      const k = duplicateKey(fields);
      if (have.has(k)) duplicateOf = { existing: true };
      else if (seen.has(k)) duplicateOf = { row: seen.get(k) };
      else seen.set(k, n);
      if (duplicateOf) {
        problems.push({
          code: PROBLEM.duplicate,
          message: `Row ${n}: ${duplicateOf.existing ? 'already in your list' : `same as row ${duplicateOf.row}`}, skipped`,
        });
      }
    }
    const order = [PROBLEM.error, PROBLEM.cycle, PROBLEM.date, PROBLEM.duplicate];
    const status = order.find((c) => problems.some((p) => p.code === c)) ?? 'ok';
    const importable = problems.every((p) => p.code === PROBLEM.duplicate);
    return { n, raw, fields, problems, status, duplicateOf, importable, include: importable && !duplicateOf };
  });
}

/** Read and review a reply in one step. Throws AiImportError for a reply that can't be read at all. */
export function reviewAiImport(input, existing = []) {
  return reviewRows(parseAiImport(input), existing);
}

/* --------------------------------------------------------------------------
   Rows → items, through a normal backup
   -------------------------------------------------------------------------- */
/** The item a checked row becomes, in the shape the app's form saves. */
export function itemFromFields(f, now = new Date().toISOString(), newId = uid) {
  let id = newId();
  while (id === SETTINGS_ID) id = newId();
  const once = f.cycle === 'once';
  return {
    id,
    type: f.type,
    name: f.name,
    domain: '',
    emoji: '',
    plan: '',
    price: f.amount,
    currency: f.currency,
    cycle: f.cycle,
    nextRenewal: once ? '' : f.nextDate,
    date: once ? f.nextDate : '',
    category: f.type === 'income' ? '' : f.category,
    notes: '',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The backup to import from the rows that are included and importable: a format-4 backup with
 * no settings, so importing it leaves the default currency and group colours as they are. It is
 * checked with storage.parseBackup here, and storage.previewImport / importAll take it as it is.
 * Throws AiImportError when no row is selected.
 */
export function backupFromRows(rows, { now = new Date().toISOString(), newId = uid } = {}) {
  const items = rows.filter((r) => r.include && r.importable).map((r) => itemFromFields(r.fields, now, newId));
  if (!items.length) throw new AiImportError('No rows are selected to import.');
  const backup = { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: now, items };
  parseBackup(backup); // the same checks as any backup file
  return backup;
}

/**
 * Totals for the review screen from the selected items, on the app's cash basis: nothing is
 * averaged. Per currency and per cycle, the amounts as they are paid: monthly items (each month),
 * yearly items (each year) and one-offs (once), money out and money in.
 * Returns [{ currency, count, monthly: { out, in, count }, annual: {...}, once: {...} }] by currency.
 */
export function totalsOf(items) {
  const by = new Map();
  const empty = () => ({ out: 0, in: 0, count: 0 });
  for (const s of items) {
    const t = by.get(s.currency) ?? { currency: s.currency, count: 0, monthly: empty(), annual: empty(), once: empty() };
    const bucket = t[isOnce(s) ? 'once' : s.cycle === 'annual' ? 'annual' : 'monthly'];
    bucket[s.type === 'income' ? 'in' : 'out'] += s.price;
    bucket.count++;
    t.count++;
    by.set(s.currency, t);
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  const tidy = (b) => ({ out: r2(b.out), in: r2(b.in), count: b.count });
  return [...by.values()]
    .map((t) => ({ ...t, monthly: tidy(t.monthly), annual: tidy(t.annual), once: tidy(t.once) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** The labels for totalsOf's groups, as the review screen shows them. */
export const TOTAL_LABELS = { monthly: 'Monthly items', annual: 'Yearly items', once: 'One-off' };

/**
 * The text "Copy error for your AI" copies: what's wrong, row by row, and a request for corrected
 * JSON. `problem` is either an AiImportError message (the reply as a whole) or a list of review rows.
 * Duplicates aren't errors and aren't listed.
 */
export function errorReport(problem) {
  const lines = typeof problem === 'string'
    ? [problem]
    : problem.flatMap((r) => r.problems.filter((p) => p.code !== PROBLEM.duplicate).map((p) => p.message));
  if (!lines.length) return '';
  return [
    'Peek Budget could not import some of your JSON:',
    ...lines.map((l) => `- ${l}`),
    '',
    'Please fix these and reply with the whole corrected JSON only, nothing else, in the same shape ({"version": 1, "rows": [...]}).',
    'If a fix needs a date, an amount or a cycle you can\'t read from my documents, ask me instead of guessing.',
  ].join('\n');
}

/* --------------------------------------------------------------------------
   The Merge / Replace all wording for these items
   -------------------------------------------------------------------------- */
// The rows bring no settings and always get new ids, so Merge only adds and Replace all only
// replaces the items; the default currency and group colours stay as they are.
const countOf = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const AI_CHOICE_TITLE = 'Import these items?';
export const AI_REPLACE_SYNC_WARNING = 'Replace all deletes the current items here and on every device you sync with.';
export const AI_REPLACE_TITLE = 'Replace all items?';
export const AI_REPLACE_MESSAGE = "This deletes all current items on this device and keeps only the imported ones. Settings stay as they are. This can't be undone.";

/** The choice dialog's text from previewImport()'s merge summary. */
export function aiImportMessage({ total, existing }, { synced = false } = {}) {
  const text = existing
    ? `${countOf(total, 'item')} to add. Merge adds them to your ${countOf(existing, 'item')}. `
      + `Replace all deletes your ${countOf(existing, 'item')} and keeps only these ${total}. `
      + 'Your default currency and group colours stay as they are.'
    : `${countOf(total, 'item')} to add. Your list is empty, so both options give the same result.`;
  return synced ? `${text}\n${AI_REPLACE_SYNC_WARNING}\n${MERGE_SYNC_NOTE}` : text;
}

/** The final confirmation after choosing Replace all. Cancel comes first: it's focused, and dismissing picks it. */
export function aiReplaceConfirm({ synced = false } = {}) {
  return {
    title: AI_REPLACE_TITLE,
    message: synced ? `${AI_REPLACE_MESSAGE}\nIt also deletes them on every device you sync with.` : AI_REPLACE_MESSAGE,
    actions: [{ label: 'Cancel', value: false }, { label: 'Replace all', value: true, kind: 'danger' }],
  };
}
