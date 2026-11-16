// Node tests for js/words.js: the household key as 12 BIP-39 words. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WORDLIST } from '../js/wordlist.js';
import { bytesToWords, keyToWords, parseRecovery, wordProblems, splitWords, closestWord, WordsError } from '../js/words.js';
import { generateKey, parseKey } from '../js/crypto.js';

const fill = (b) => new Uint8Array(16).fill(b);
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

async function rejectsWith(text, code, includes) {
  await assert.rejects(parseRecovery(text), (err) => {
    assert.ok(err instanceof WordsError, `WordsError, got ${err}`);
    assert.equal(err.code, code);
    if (includes) assert.ok(err.message.includes(includes), `"${err.message}" should include "${includes}"`);
    return true;
  });
}

test('the vendored wordlist is the standard BIP-39 English list', () => {
  assert.equal(WORDLIST.length, 2048);
  assert.equal(new Set(WORDLIST).size, 2048);
  const hash = createHash('sha256').update(`${WORDLIST.join('\n')}\n`).digest('hex');
  assert.equal(hash, '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
  // Unique in the first four letters, which closestWord relies on.
  assert.equal(new Set(WORDLIST.map((w) => w.slice(0, 4))).size, 2048);
});

test('required vectors: 16 zero bytes and 16 bytes of 0xFF', async () => {
  assert.equal((await bytesToWords(fill(0))).join(' '),
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  assert.equal((await bytesToWords(fill(0xff))).join(' '), 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
});

test('more BIP-39 reference vectors (128-bit entropy)', async () => {
  const vectors = [
    ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
    ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
    ['9e885d952ad362caeb4efe34a8e91bd2', 'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic'],
    ['c0ba5a8e914111210f2bd131f3d5e08d', 'scheme spot photo card baby mountain device kick cradle pact join borrow'],
  ];
  for (const [hex, words] of vectors) {
    const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
    assert.equal((await bytesToWords(bytes)).join(' '), words, hex);
    assert.equal(await parseRecovery(words), b64url(bytes), `decode ${hex}`);
  }
});

test('the words are the same key as the stored base64url form', async () => {
  // 16 zero bytes as the stored key text.
  assert.equal(await parseRecovery('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
    'AAAAAAAAAAAAAAAAAAAAAA');
  for (let i = 0; i < 200; i++) {
    const key = generateKey();
    const words = await keyToWords(key);
    assert.equal(words.length, 12);
    assert.ok(words.every((w) => WORDLIST.includes(w)));
    assert.equal(await parseRecovery(words.join(' ')), key, 'round trip');
    assert.deepEqual(parseKey(await parseRecovery(words.join(' '))), parseKey(key));
  }
});

test('decoding ignores case, extra spaces, newlines and list numbering', async () => {
  const key = generateKey();
  const words = await keyToWords(key);
  const messy = `  ${words.slice(0, 4).map((w) => w.toUpperCase()).join('   ')}\n\n${words.slice(4, 8).join('\t')}\r\n ${words.slice(8).join(' ,')}  `;
  assert.equal(await parseRecovery(messy), key);
  const numbered = words.map((w, i) => `${i + 1}. ${w[0].toUpperCase()}${w.slice(1)}`).join('\n');
  assert.equal(await parseRecovery(numbered), key);
  assert.deepEqual(splitWords(' Zoo\nZOO  wrong '), ['zoo', 'zoo', 'wrong']);
});

test('the old 22-character key is still accepted, as it is', async () => {
  const key = generateKey();
  assert.equal(await parseRecovery(`  ${key}\n`), key);
  assert.deepEqual(wordProblems(key), []);
  await rejectsWith('AAAAAAAAAAAAAAAAAAAAAB', 'key'); // non-canonical last character
});

test('wrong word count: 11 or 13 words, or nothing', async () => {
  const words = await keyToWords(generateKey());
  await rejectsWith(words.slice(0, 11).join(' '), 'count', 'You entered 11');
  await rejectsWith([...words, 'abandon'].join(' '), 'count', 'You entered 13');
  await rejectsWith('   ', 'empty', 'Enter the 12 recovery words');
  assert.equal(wordProblems(words.slice(0, 11).join(' '))[0].message, 'There are 12 recovery words. You entered 11.');
});

test('a word not in the list is named by position, with the closest match', async () => {
  const words = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'.split(' ');
  words[4] = 'zooo';
  await rejectsWith(words.join(' '), 'unknown', 'Word 5 ("zooo") isn\'t in the list. Did you mean "zoo"?');
  const typo = 'legal winner thank year wave sausage worth usefull legal winner thank yellow';
  const p = wordProblems(typo);
  assert.equal(p.length, 1);
  assert.equal(p[0].word, 8);
  assert.match(p[0].message, /Did you mean "useful"\?/);
  assert.equal(closestWord('abandn'), 'abandon');
  assert.equal(closestWord('aban'), 'abandon', 'first four letters are unique');
  assert.equal(closestWord('xqzv'), null);
  // Several problems at once are all reported.
  assert.equal(wordProblems('foo qux zoo').length, 3, 'the count, then each unknown word');
});

test('a typo that is another list word, or swapped words, fail the checksum', async () => {
  // Swapping two different words changes the bits; the 4-bit checksum catches most changes, so
  // try several keys and require that every swap the checksum can see is refused.
  let refused = 0;
  for (let i = 0; i < 40; i++) {
    const key = generateKey();
    const words = await keyToWords(key);
    const [a, b] = [i % 12, (i + 5) % 12];
    if (words[a] === words[b]) continue;
    const swapped = [...words];
    [swapped[a], swapped[b]] = [swapped[b], swapped[a]];
    try {
      const other = await parseRecovery(swapped.join(' '));
      assert.notEqual(other, key, 'a swap that passes the checksum is a different key, never this one');
    } catch (err) {
      assert.equal(err.code, 'checksum');
      assert.equal(err.message, 'A word is wrong or out of order. Check them against your copy.');
      refused++;
    }
  }
  assert.ok(refused >= 30, `most swaps are refused (${refused}/40)`);
  // A fixed case: the last word of the zero vector replaced by another list word.
  await rejectsWith('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon', 'checksum');
  // Swapped: "about" moved to the front.
  await rejectsWith('about abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon', 'checksum');
});

test('error messages never contain other words than the one being reported', async () => {
  const words = await keyToWords(generateKey());
  const bad = [...words];
  bad[2] = 'qqqq';
  const msg = wordProblems(bad.join(' ')).map((p) => p.message).join(' ');
  for (const w of words.filter((_, i) => i !== 2)) assert.ok(!msg.includes(`"${w}"`), 'no other word quoted');
});
