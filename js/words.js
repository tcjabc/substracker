// Recovery words: the 16-byte household key written as 12 BIP-39 English words (128 bits of key
// plus a 4-bit SHA-256 checksum, 11 bits per word). They're another spelling of the same key as
// the 22-character base64url form in js/crypto.js, so a device paired with the old form shows its
// current household's words and nothing needs pairing again. Storage keeps the base64url form.
//
// Pure functions (Web Crypto only for the checksum), so Node tests run them as they are.
// Nothing here logs keys or words.

import { WORDLIST } from './wordlist.js';
import { parseKey } from './crypto.js';
import { t } from './i18n.js';

export const WORD_COUNT = 12;
const KEY_BYTES = 16;
const INDEX = new Map(WORDLIST.map((w, i) => [w, i]));

/** A problem with entered words. `problems` lists one { word?, message } per issue. */
export class WordsError extends Error {
  constructor(code, problems) {
    super(problems.map((p) => p.message).join('\n'));
    this.code = code; // 'empty' | 'count' | 'unknown' | 'checksum' | 'key'
    this.problems = problems;
  }
}

async function checksumBits(bytes) {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return hash[0] >> 4; // the first 4 bits (entropy bits / 32)
}

function toBase64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The 12 words (array) for 16 key bytes. */
export async function bytesToWords(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_BYTES) throw new Error('A household key is 16 bytes.');
  // 128 key bits followed by 4 checksum bits, read 11 bits at a time.
  let big = 0n;
  for (const b of bytes) big = (big << 8n) | BigInt(b);
  big = (big << 4n) | BigInt(await checksumBits(bytes));
  const words = [];
  for (let i = WORD_COUNT - 1; i >= 0; i--) words.push(WORDLIST[Number((big >> BigInt(i * 11)) & 0x7ffn)]);
  return words;
}

/** The 12 words (array) for a stored household key (the 22-character base64url text). */
export async function keyToWords(keyText) {
  return bytesToWords(parseKey(keyText));
}

/** Split typed text into lowercase words: any case, extra spaces, newlines, commas or numbering. */
export function splitWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\b\d+[.)]/g, ' ') // "1. abandon 2) ability" as copied from a numbered list
    .split(/[^a-z]+/)
    .filter(Boolean);
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * The list word someone most likely meant, or null. BIP-39 words are unique in their first four
 * letters, so a matching start wins; otherwise the single nearest word within two edits.
 */
export function closestWord(word) {
  const w = String(word ?? '').toLowerCase();
  if (w.length >= 4) {
    const byStart = WORDLIST.filter((x) => x.startsWith(w.slice(0, 4)));
    if (byStart.length === 1) return byStart[0];
  }
  let best = null;
  let bestD = 3;
  let tie = false;
  for (const x of WORDLIST) {
    if (Math.abs(x.length - w.length) >= bestD) continue;
    const d = distance(w, x);
    if (d < bestD) { best = x; bestD = d; tie = false; } else if (d === bestD) tie = true;
  }
  return best && !tie ? best : null;
}

/**
 * Checks that need no hashing, for messages while typing: the word count and each word against
 * the list. Returns a list of problems ([] when the words could be a key; the checksum is checked
 * by parseRecovery). A 22-character old-style key counts as fine here.
 */
export function wordProblems(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [{ message: t('sync.words.error.empty') }];
  if (/^[A-Za-z0-9_-]{22}$/.test(raw)) return [];
  const words = splitWords(raw);
  const problems = [];
  words.forEach((w, i) => {
    if (INDEX.has(w)) return;
    const near = closestWord(w);
    problems.push({
      word: i + 1,
      message: near ? t('sync.words.error.unknownNear', { n: i + 1, word: w, near }) : t('sync.words.error.unknown', { n: i + 1, word: w }),
    });
  });
  if (words.length !== WORD_COUNT) {
    problems.unshift({ message: t('sync.words.error.count', { count: words.length }) });
  }
  return problems;
}

/**
 * The household key (22-character base64url, the stored form) from typed recovery words, or from
 * an old-style 22-character key. Throws WordsError with a plain message otherwise.
 */
export async function parseRecovery(text) {
  const raw = String(text ?? '').trim();
  if (/^[A-Za-z0-9_-]{22}$/.test(raw)) {
    try { parseKey(raw); } catch (err) { throw new WordsError('key', [{ message: err.message }]); }
    return raw;
  }
  const problems = wordProblems(raw);
  if (problems.length) {
    const code = !raw ? 'empty' : splitWords(raw).length !== WORD_COUNT ? 'count' : 'unknown';
    throw new WordsError(code, problems);
  }
  let big = 0n;
  for (const w of splitWords(raw)) big = (big << 11n) | BigInt(INDEX.get(w));
  const check = Number(big & 0xfn);
  big >>= 4n;
  const bytes = new Uint8Array(KEY_BYTES);
  for (let i = KEY_BYTES - 1; i >= 0; i--) { bytes[i] = Number(big & 0xffn); big >>= 8n; }
  if (check !== await checksumBits(bytes)) {
    throw new WordsError('checksum', [{ message: t('sync.words.error.checksum') }]);
  }
  return toBase64url(bytes);
}
