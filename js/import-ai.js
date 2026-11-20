// "Import with AI": read the JSON an AI chat of the person's own choosing wrote from their
// statements (see js/import-ai-prompt.js for the text they give it). The app never sends anything
// anywhere: the person copies the prompt out and pastes or picks the reply. Pure functions, no
// network, no storage access; also used by the Node tests.
//
// The import schema is separate from the backup format and simpler:
//   { "version": 1, "rows": [ { name, amount, currency, cycle, nextDate, category, type, notes? } ] }
// "notes" came in 1.22.2 and is optional, so the version stays 1 and replies without it still read.
// Rows are checked one by one, so a reply with a few bad rows still shows the good ones. A row
// becomes an item only through a normal backup (format 4, without settings), which goes through
// storage.parseBackup and the existing Merge / Replace import, so ids, field stamps, types and
// nextRenewal are made exactly as for any other import.

import { CURRENCIES, uid, isOnce, mergeSyncNote, replaceConfirmSync } from './util.js';
import { t, formatLocale } from './i18n.js';
import { APP_ID, SCHEMA_VERSION, SETTINGS_ID, parseBackup } from './storage.js';
import { DEFAULT_CATEGORIES } from './services.js';

export const AI_SCHEMA_VERSION = 1;
export const MAX_AI_CHARS = 500_000;
export const MAX_AI_ROWS = 500;
export const NAME_MAX = 80;
export const CATEGORY_MAX = 40;
/** In characters (code points), so a note never grows past the item's own 1,000-unit notes limit. */
export const NOTES_MAX = 500;
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

// What copying from a chat on a phone can add to JSON: no-break and other Unicode spaces, zero-width
// spaces and joiners, a byte-order mark in the middle of the text, a soft hyphen, and curly quotes.
const SMART_QUOTE = /[\u201C\u201D\u201E\u201F\u2033\u2036]/;
const UNICODE_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF]/;
const BOM = new RegExp(String.fromCharCode(0xfeff), 'g');
// Inside a string, joiners stay: they hold emoji and some scripts together.
const INVISIBLE_IN_TEXT =/[\u00AD\u180E\u200B\u2060-\u2064\uFEFF]/;
// After a curly closing quote inside a straight-quoted string: the string ends there if JSON goes on.
const ENDS_STRING = /^[ \t\r\n]*[:,}\]]/;

// A chat app can also copy its on-screen line wrapping as real line breaks: JSON written on one
// line comes out in lines of the screen's width, with breaks inside strings, keys and numbers. The
// wrapping breaks at a space when the line has one, and the space is lost ("Learning⏎Co" was
// "Learning Co"); only a line with no space at all is split mid-word, at the full width ("Clo⏎ud",
// "2026-⏎11-26"), and nothing was lost there. So a break after a short line, or a line with a
// space in it, was a space; a break after a full line without one was mid-word.
//
// What "full" measures depends on the chat's font, so the reply itself is the ruler: a break
// inside a key, inside a field that never has spaces (a date, a code, a cycle, a type), or between
// tokens of JSON with no spaces between tokens, can only be mid-word, so those lines are full. If
// they all have the same number of characters the view is monospaced and that number decides;
// otherwise a line is full when its rough glyph width reaches theirs (narrow characters such as
// quotes and colons count less). A space right at the edge of a line still looks full, so plainJson
// only marks each break inside a string with its guess, and the field decides (tidyRow).
const glyphWidth = (c) => (/[ ,.:;'|!ijl]/.test(c) ? 0.45 : /["frtI()[\]{}-]/.test(c) ? 0.65 : /[mwMW]/.test(c) ? 1.6 : /[A-Z&]/.test(c) ? 1.25 : 1);
/** Without a ruler from the reply: within 3% of the widest line. With one: within 1% of its narrowest full line. */
const FULL_GLYPHS = 0.97;
const FULL_RULER = 0.99;
/** Fields whose values never contain spaces, so a break in them was always mid-word. */
const SPACELESS_FIELDS = new Set(['version', 'rows', 'amount', 'currency', 'cycle', 'nextDate', 'type', 'id']);
const KEY_AFTER = new RegExp(`^(?:[ \\t\\r\\n]|${UNICODE_SPACE.source}|${INVISIBLE.source})*:`);
/** Marks plainJson leaves inside strings for a copied line break: probably mid-word, or probably a lost space. */
const WRAP_JOIN = String.fromCharCode(0xe000);
const WRAP_SPACE = String.fromCharCode(0xe001);
const WRAP_ANY = new RegExp(`[${WRAP_JOIN}${WRAP_SPACE}]`, 'g');

/** Whether the curly or straight quote `c` at `i` closes a string opened by `str` (as plainJson reads it). */
const closesString = (s, i, c, str) => c === '"' || (SMART_QUOTE.test(c) && (str === 'smart' || ENDS_STRING.test(s.slice(i + 1, i + 40))));

/**
 * Where each line break in `s` falls: 'key', 'spaceless' (a value of SPACELESS_FIELDS), 'text'
 * (any other string value) or 'outside' (between tokens); and whether there are spaces between tokens.
 */
function scanBreaks(s) {
  const kinds = [];
  let str = null;
  let inString = []; // the breaks in the current string, labelled when it closes
  let text = '';
  let lastKey = null;
  let spaced = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') {
      if (str) inString.push(kinds.length);
      kinds.push(str ? 'text' : 'outside');
    } else if (str) {
      if (c === '\\') { text += s[i + 1] ?? ''; i++; }
      else if (closesString(s, i, c, str)) {
        const isKey = KEY_AFTER.test(s.slice(i + 1, i + 40));
        const kind = isKey ? 'key' : SPACELESS_FIELDS.has(lastKey) ? 'spaceless' : 'text';
        for (const b of inString) kinds[b] = kind;
        if (isKey) lastKey = text.replace(INVISIBLE_ALL, '').replace(/\s/g, '');
        str = null; inString = []; text = '';
      } else text += c;
    } else if (c === '"') str = 'straight';
    else if (SMART_QUOTE.test(c)) str = 'smart';
    else if (c === ' ' || c === '\t' || UNICODE_SPACE.test(c)) spaced = true;
  }
  return { kinds, spaced };
}

/** For each line break in `s`: whether the line before it looks like a mid-word wrap rather than one at a space. */
function wrapBreaks(s, lead) {
  const lines = s.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length < 2) return [];
  const { kinds, spaced } = scanBreaks(s);
  const chars = lines.map((l, i) => l.length + (i === 0 ? lead : 0));
  const glyphs = lines.map((l, i) => [...l].reduce((sum, c) => sum + glyphWidth(c), 0) + (i === 0 ? lead : 0));
  const noSpace = lines.map((l) => !/[ \t]/.test(l));
  const ruler = kinds.map((k, i) => i).filter((i) => noSpace[i] && i > 0
    && (kinds[i] === 'key' || kinds[i] === 'spaceless' || (kinds[i] === 'outside' && !spaced)));
  const rulerChars = ruler.map((i) => chars[i]);
  const monospaced = ruler.length >= 2 && Math.min(...rulerChars) === Math.max(...rulerChars);
  const fullChars = monospaced ? rulerChars[0] : Math.max(...chars);
  const fullGlyphs = ruler.length ? Math.min(...ruler.map((i) => glyphs[i])) * FULL_RULER : Math.max(...glyphs) * FULL_GLYPHS;
  return lines.slice(0, -1).map((l, i) => noSpace[i]
    && (monospaced ? chars[i] >= fullChars : chars[i] >= fullChars || glyphs[i] >= fullGlyphs));
}

/** A text value with the line-break marks resolved: as text with spaces (a name) or as a code (a date, currency…). */
const unwrapText = (v, spaced) => v.replaceAll(WRAP_JOIN, '').replaceAll(WRAP_SPACE, spaced ? ' ' : '');

/**
 * A name with line-break marks. A break that looks mid-word may still be a space that fell right at
 * the edge of the line; in a name, a space is usually followed by a capital, a digit or "&" ("Learning
 * Co"), and a mid-word split rarely is ("Clo|ud"), so that decides those.
 */
const unwrapName = (v) => v
  .replace(new RegExp(`(?<=[\\p{L}\\p{N}.)])${WRAP_JOIN}(?=[\\p{Lu}\\p{N}&(])`, 'gu'), ' ')
  .replaceAll(WRAP_JOIN, '')
  .replaceAll(WRAP_SPACE, ' ');

/** A category with line-break marks: the reading that is a known category if one is, else the guess. */
function unwrapCategory(v, known) {
  const isKnown = (text) => known.some((k) => k.toLowerCase() === text.trim().toLowerCase());
  const guess = unwrapText(v, true);
  if (isKnown(guess)) return guess;
  const marks = [...v].filter((c) => c === WRAP_JOIN || c === WRAP_SPACE).length;
  if (marks <= 4) {
    const parts = v.split(WRAP_ANY);
    for (let bits = 0; bits < 2 ** marks; bits++) {
      const text = parts.reduce((acc, p, i) => (i === 0 ? p : acc + ((bits >> (i - 1)) & 1 ? ' ' : '') + p), '');
      if (isKnown(text)) return text;
    }
  }
  return guess;
}

/**
 * JSON with the characters above made plain: Unicode spaces between tokens become spaces,
 * invisible characters go, curly quotes around keys and values become straight ones, and line
 * breaks a copied line wrap put inside strings or numbers are undone (see wrapBreaks). Text inside
 * strings is kept, apart from invisible characters that aren't joiners. Run on one candidate at a
 * time; `lead` is how many characters came before it on its first line.
 */
export function plainJson(s, lead = 0) {
  const midWord = wrapBreaks(s, lead);
  let line = 0;
  let out = '';
  let str = null; // null outside a string, else 'straight' or 'smart' for the quote that opened it
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\r' && s[i + 1] === '\n') continue; // the \n below handles the pair
    if (c === '\n') {
      const mid = midWord[line++];
      if (str) out += mid ? WRAP_JOIN : WRAP_SPACE; // resolved per field by tidyKeys / tidyRow
      else if (!(/[\d.]$/.test(out) && /^[\d.]/.test(s.slice(i + 1, i + 2)))) out += c; // not inside a number
      continue;
    }
    if (str) {
      if (c === '\\') { out += c + (s[i + 1] ?? ''); i++; }
      else if (c === '"') { out += c; str = null; }
      else if (SMART_QUOTE.test(c) && (str === 'smart' || ENDS_STRING.test(s.slice(i + 1, i + 40)))) { out += '"'; str = null; }
      else if (!INVISIBLE_IN_TEXT.test(c)) out += c;
    } else if (c === '"') { out += c; str = 'straight'; }
    else if (SMART_QUOTE.test(c)) { out += '"'; str = 'smart'; }
    else if (UNICODE_SPACE.test(c)) out += ' ';
    else if (!INVISIBLE.test(c)) out += c;
  }
  return out;
}

const INVISIBLE_ALL = new RegExp(INVISIBLE.source, 'g');
const INVISIBLE_IN_TEXT_ALL = new RegExp(INVISIBLE_IN_TEXT.source, 'g');

/**
 * An object with its keys trimmed of spaces, invisible characters and line-break marks (a key like
 * "version " or "\u200Bversion"). A key written exactly wins over a tidied one.
 */
function tidyKeys(v) {
  if (!isObj(v)) return v;
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const key = k.replace(INVISIBLE_ALL, '').replace(WRAP_ANY, '').trim();
    if (Object.prototype.hasOwnProperty.call(out, key) && key !== k) continue;
    out[key] = val;
  }
  return out;
}

/**
 * A row with tidy keys and text values: invisible characters other than joiners go (a date like
 * "2026-11-01" with a zero-width space in it), and copied line breaks are resolved per field: a
 * name takes the guess, a category a known category (`knownCategories`) where one fits, and every
 * other field (dates, codes, cycles, types) has no spaces, so the breaks just go.
 */
function tidyRow(raw, knownCategories) {
  const row = tidyKeys(raw);
  if (!isObj(row)) return row;
  for (const [k, val] of Object.entries(row)) {
    if (typeof val !== 'string') continue;
    const v = val.replace(INVISIBLE_IN_TEXT_ALL, '');
    row[k] = k === 'name' || k === 'notes' ? unwrapName(v) : k === 'category' ? unwrapCategory(v, knownCategories) : unwrapText(v, false);
  }
  return row;
}

/**
 * The JSON object in a pasted reply or picked file. Tolerant of what chats wrap around it and what
 * copying on a phone adds: a byte-order mark, code fences, text before and after (an
 * explanation, suggested follow-up questions), Unicode spaces, invisible characters and curly
 * quotes. Only whole objects are tried, never one nested inside a broken reply, so a reply that
 * doesn't parse is reported as such and not as a row with no "version". Throws AiImportError.
 */
export function extractJson(input) {
  if (isObj(input)) return input;
  if (typeof input !== 'string') throw new AiImportError(t('ai.reply.nothing'));
  if (input.length > MAX_AI_CHARS) {
    throw new AiImportError(t('ai.reply.tooLong', { max: MAX_AI_CHARS.toLocaleString(formatLocale() ?? 'en') }));
  }
  const text = input.replace(BOM, '').trim();
  if (!text) throw new AiImportError(t('ai.reply.nothing'));

  // [candidate, how many characters come before it on its line] (for undoing a copied line wrap)
  const candidates = [[text, 0]];
  for (const m of text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n?([\s\S]*?)```/g)) candidates.push([m[1].trim(), 0]);
  // Each outermost {...} once; the search goes on after it, not inside it.
  let tries = 0;
  for (let i = text.indexOf('{'); i !== -1 && tries < 50; tries++) {
    const obj = balancedObject(text, i);
    if (!obj) break;
    candidates.push([obj, i - (text.lastIndexOf('\n', i - 1) + 1)]);
    i = text.indexOf('{', i + obj.length);
  }
  let found = null;
  let broken = null;
  for (const [c, lead] of candidates) {
    let r = tryParse(c);
    if (!r.ok) r = tryParse(plainJson(c, lead));
    if (!r.ok) {
      if (c.startsWith('{') && /"\s*(version|rows)\s*"/.test(plainJson(c, lead))) broken ??= c;
      continue;
    }
    const value = tidyKeys(r.value);
    if (isObj(value) && 'rows' in value) return value;
    found ??= value;
  }
  if (found !== null) return found;
  if (broken) {
    throw new AiImportError(t('ai.reply.broken'));
  }
  throw new AiImportError(t('ai.reply.noJson'));
}

/**
 * The rows of a reply, checked as a whole: { version: 1, rows: [...] } within the size limits.
 * Rows themselves are checked by reviewRows. Throws AiImportError.
 */
export function parseAiImport(input) {
  const data = extractJson(input);
  if (Array.isArray(data)) throw new AiImportError(t('ai.reply.isList', { shape: SHAPE }));
  if (!isObj(data)) throw new AiImportError(t('ai.reply.notObject', { shape: SHAPE }));
  if (data.version === undefined) throw new AiImportError(t('ai.reply.noVersion'));
  if (data.version !== AI_SCHEMA_VERSION) throw new AiImportError(t('ai.reply.version', { version: AI_SCHEMA_VERSION }));
  if (data.rows === undefined) throw new AiImportError(t('ai.reply.noRows'));
  if (!Array.isArray(data.rows)) throw new AiImportError(t('ai.reply.rowsNotList'));
  if (!data.rows.length) throw new AiImportError(t('ai.reply.rowsEmpty'));
  if (data.rows.length > MAX_AI_ROWS) {
    throw new AiImportError(t('ai.reply.tooMany', { count: data.rows.length, max: MAX_AI_ROWS }));
  }
  return data.rows;
}

/* --------------------------------------------------------------------------
   Checking rows
   -------------------------------------------------------------------------- */
// Problem codes. "error" covers fields that are missing or the wrong type; "date" and "cycle" get
// their own codes so the review screen can offer a date picker or a cycle choice to fix them.
// "note" only flags a note that was shortened: the row is still imported, like a duplicate it
// isn't an error for the AI.
export const PROBLEM = { error: 'error', date: 'date', cycle: 'cycle', duplicate: 'duplicate', note: 'note' };
const NOT_BLOCKING = new Set([PROBLEM.duplicate, PROBLEM.note]);

/**
 * `text` cut to at most `max` code points, at the end of a whole character (an emoji with a skin
 * tone or a joiner stays whole or goes whole), with any space left at the cut trimmed.
 */
export function clipText(text, max) {
  if ([...text].length <= max) return text;
  let out = '';
  let count = 0;
  const parts = typeof Intl?.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map((s) => s.segment)
    : [...text];
  for (const part of parts) {
    const size = [...part].length;
    if (count + size > max) break;
    out += part;
    count += size;
  }
  return out.trimEnd();
}

/** Which date this row has, for the wording: a one-off's date, a payment or a renewal. */
const dateKind = (type, cycle) => (cycle === 'once' ? 'once' : type === 'income' ? 'payment' : 'renewal');

/**
 * Check one row. Returns { n, fields, problems } where `fields` holds the clean values
 * ({ name, amount, currency, cycle (the app's name), cycleText, nextDate, category, type, notes },
 * each null when unusable; category and notes are '' when there are none) and `problems` is a list of { code, message } with messages like
 * "Row 3: currency is missing; add …", each saying how to fix it. Any `id` in the row is ignored (every row gets a new id), and a row
 * asking for the reserved id is rejected.
 */
export function checkRow(raw, n) {
  const problems = [];
  const add = (code, key, params) => problems.push({ code, message: t('ai.row.problem', { n, problem: t(key, params) }) });
  const fields = { name: null, amount: null, currency: null, cycle: null, cycleText: null, nextDate: null, category: '', type: null, notes: '' };
  if (!isObj(raw)) {
    add(PROBLEM.error, 'ai.row.notObject');
    return { n, fields, problems };
  }
  if (raw.id === SETTINGS_ID) add(PROBLEM.error, 'ai.row.reservedId', { id: SETTINGS_ID });

  if (blank(raw.name)) add(PROBLEM.error, 'ai.row.name.missing');
  else if (typeof raw.name !== 'string') add(PROBLEM.error, 'ai.row.name.text');
  else if (raw.name.trim().length > NAME_MAX) add(PROBLEM.error, 'ai.row.name.long', { max: NAME_MAX });
  else fields.name = raw.name.trim();

  if (raw.amount === undefined || raw.amount === null || raw.amount === '') add(PROBLEM.error, 'ai.row.amount.missing');
  else if (typeof raw.amount !== 'number') add(PROBLEM.error, 'ai.row.amount.number');
  else if (!Number.isFinite(raw.amount)) add(PROBLEM.error, 'ai.row.amount.number');
  else if (raw.amount < 0) add(PROBLEM.error, 'ai.row.amount.negative');
  else if (raw.amount > AMOUNT_MAX) add(PROBLEM.error, 'ai.row.amount.large');
  else fields.amount = Math.round(raw.amount * 100) / 100;

  if (blank(raw.currency)) add(PROBLEM.error, 'ai.row.currency.missing');
  else if (typeof raw.currency !== 'string') add(PROBLEM.error, 'ai.row.currency.code');
  else {
    const c = raw.currency.trim().toUpperCase();
    if (!CURRENCIES.includes(c)) add(PROBLEM.error, 'ai.row.currency.unsupported', { currency: raw.currency.trim().slice(0, 12), list: CURRENCIES.join(', ') });
    else fields.currency = c;
  }

  if (blank(raw.type)) add(PROBLEM.error, 'ai.row.type.missing');
  else if (typeof raw.type !== 'string' || !TYPES.includes(raw.type.trim().toLowerCase())) add(PROBLEM.error, 'ai.row.type.value');
  else fields.type = raw.type.trim().toLowerCase();

  if (blank(raw.cycle)) add(PROBLEM.error, 'ai.row.cycle.missing');
  else if (typeof raw.cycle !== 'string') add(PROBLEM.error, 'ai.row.cycle.text');
  else {
    const c = raw.cycle.trim().toLowerCase();
    fields.cycleText = c.slice(0, 30);
    if (Object.prototype.hasOwnProperty.call(AI_CYCLES, c)) fields.cycle = AI_CYCLES[c];
    else add(PROBLEM.cycle, 'ai.row.cycle.unsupported', { cycle: fields.cycleText });
  }

  const kind = dateKind(fields.type, fields.cycle);
  if (blank(raw.nextDate)) {
    add(PROBLEM.date, kind === 'once' ? 'ai.row.date.missing.once' : kind === 'payment' ? 'ai.row.date.missing.payment' : 'ai.row.date.missing.renewal');
  } else if (typeof raw.nextDate !== 'string' || !isRealDay(raw.nextDate.trim())) {
    const got = String(raw.nextDate).slice(0, 20);
    if (/^\d{4}-\d{2}-\d{2}$/.test(got.trim())) {
      add(PROBLEM.date, kind === 'once' ? 'ai.row.date.notReal.once' : kind === 'payment' ? 'ai.row.date.notReal.payment' : 'ai.row.date.notReal.renewal', { got });
    } else add(PROBLEM.date, 'ai.row.date.format', { got });
  } else fields.nextDate = raw.nextDate.trim();

  if (raw.category === undefined || raw.category === null) fields.category = '';
  else if (typeof raw.category !== 'string') add(PROBLEM.error, 'ai.row.category.text');
  else if (raw.category.trim().length > CATEGORY_MAX) add(PROBLEM.error, 'ai.row.category.long', { max: CATEGORY_MAX });
  else fields.category = raw.category.trim();
  if (fields.type === 'income') fields.category = ''; // income has no categories in the app

  // Optional, for income too. Too long is shortened and flagged, never a reason to leave the row out.
  if (raw.notes === undefined || raw.notes === null) fields.notes = '';
  else if (typeof raw.notes !== 'string') add(PROBLEM.error, 'ai.row.notes.text');
  else {
    const note = raw.notes.trim();
    fields.notes = clipText(note, NOTES_MAX);
    if (fields.notes !== note) add(PROBLEM.note, 'ai.row.notes.long', { max: NOTES_MAX });
  }

  return { n, fields, problems };
}

/**
 * The duplicate key: name (case and spacing ignored), amount, currency and cycle, and for a
 * one-off its date too: the same one-off on two dates (a lesson paid twice) is two transactions.
 * A recurring item's date isn't part of it: statements show the same subscription on different dates.
 */
export function duplicateKey({ name, amount, currency, cycle, date = '' }) {
  const nm = String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  const key = `${nm}\u0000${Math.round(Number(amount) * 100) / 100}\u0000${String(currency ?? '').toUpperCase()}\u0000${cycle}`;
  return cycle === 'once' ? `${key} on ${date ?? ''}` : key;
}

const keyOfItem = (s) => duplicateKey({ name: s.name, amount: s.price, currency: s.currency, cycle: s.cycle, date: s.date || s.nextRenewal });

/**
 * Check every row and mark duplicates: a row that matches an earlier row of the reply, or an item
 * already in the list (`existing`, plain items). Returns the review rows, in order:
 * { n, raw, fields, problems, status, duplicateOf, importable, include }.
 *   status       'ok', or the first problem's code: 'error', 'cycle', 'date', 'duplicate' or 'note'.
 *   duplicateOf  { row: n } or { existing: true } for a duplicate, else null.
 *   importable   no blocking problem (a duplicate can still be imported on purpose; a shortened
 *                note is imported as it is shown).
 *   include      the starting choice: importable and not a duplicate.
 */
export function reviewRows(rawRows, existing = []) {
  const have = new Set(existing.map(keyOfItem));
  const knownCategories = [...DEFAULT_CATEGORIES, ...existing.map((s) => s.category).filter(Boolean)];
  const seen = new Map();
  return rawRows.map((raw, i) => {
    const { n, fields, problems } = checkRow(tidyRow(raw, knownCategories), i + 1);
    let duplicateOf = null;
    // A one-off without a usable date isn't compared until its date is fixed.
    const comparable = fields.name !== null && fields.amount !== null && fields.currency !== null && fields.cycle !== null
      && (fields.cycle !== 'once' || fields.nextDate !== null);
    if (comparable) {
      const k = duplicateKey({ ...fields, date: fields.nextDate });
      if (have.has(k)) duplicateOf = { existing: true };
      else if (seen.has(k)) duplicateOf = { row: seen.get(k) };
      else seen.set(k, n);
      if (duplicateOf) {
        problems.push({
          code: PROBLEM.duplicate,
          message: t('ai.row.problem', { n, problem: duplicateOf.existing ? t('ai.row.duplicate.existing') : t('ai.row.duplicate.row', { row: duplicateOf.row }) }),
        });
      }
    }
    const order = [PROBLEM.error, PROBLEM.cycle, PROBLEM.date, PROBLEM.duplicate, PROBLEM.note];
    const status = order.find((c) => problems.some((p) => p.code === c)) ?? 'ok';
    const importable = problems.every((p) => NOT_BLOCKING.has(p.code));
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
    notes: f.notes ?? '',
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
  if (!items.length) throw new AiImportError(t('ai.reply.noneSelected'));
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

/** The labels for totalsOf's groups, as the review screen shows them (read when shown). */
export const TOTAL_LABELS = Object.freeze({
  get monthly() { return t('ai.totals.monthly'); },
  get annual() { return t('ai.totals.annual'); },
  get once() { return t('ai.totals.once'); },
});

/**
 * The text "Copy error for your AI" copies: what's wrong, row by row, and a request for corrected
 * JSON. `problem` is either an AiImportError message (the reply as a whole) or a list of review rows.
 * Duplicates and shortened notes aren't errors and aren't listed. The lines around the problems are written for the
 * AI, like the prompt (js/import-ai-prompt.js), so they stay in English; the problems themselves
 * are the ones the review screen shows, in the app's language.
 */
export function errorReport(problem) {
  const lines = typeof problem === 'string'
    ? [problem]
    : problem.flatMap((r) => r.problems.filter((p) => !NOT_BLOCKING.has(p.code)).map((p) => p.message));
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
const items = (n) => t('common.items', { count: n });

// Read when needed (functions, not constants), in the language in use then.
export const aiChoiceTitle = () => t('ai.choice.title');
export const aiReplaceSyncWarning = () => t('ai.replace.syncWarning');
export const aiReplaceTitle = () => t('ai.replace.title');
export const aiReplaceMessage = () => t('ai.replace.message');

/** The choice dialog's text from previewImport()'s merge summary. */
export function aiImportMessage({ total, existing }, { synced = false } = {}) {
  const text = existing
    ? t('ai.choice.message', { items: items(total), existing: items(existing), count: total })
    : t('ai.choice.empty', { items: items(total) });
  return synced ? `${text}\n${aiReplaceSyncWarning()}\n${mergeSyncNote()}` : text;
}

/** The final confirmation after choosing Replace all. Cancel comes first: it's focused, and dismissing picks it. */
export function aiReplaceConfirm({ synced = false } = {}) {
  return {
    title: aiReplaceTitle(),
    message: synced ? `${aiReplaceMessage()}\n${replaceConfirmSync()}` : aiReplaceMessage(),
    actions: [{ label: t('common.cancel'), value: false }, { label: t('import.replaceAll'), value: true, kind: 'danger' }],
  };
}
