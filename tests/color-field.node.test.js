// Reference values for storage.colorField(), the group-name hash that names each group's field in the
// synced settings record (color_ plus 16 hex digits). Every device must compute the same field for the
// same name, so this function is part of the sync format. If one of these fails, the hash changed and
// synced colours would split. Never update these values: a new hash needs a migration (see
// docs/plan-intervals-groups.md). Generated once from js/storage.js at 1.19.0 and frozen.
//
// Each row: what the name is, the name, its field, and what settingsFields() does with it as a colour
// change: null when the name isn't accepted as a group name, else the field and the name stored in the
// value (SAME: exactly the name given; otherwise the trimmed name).
//
// What this records about the current code: a name is hashed as its UTF-16 code units, exactly as
// given. There is no trimming, case folding or Unicode normalisation in the hash. So NFC and NFD forms,
// fullwidth letters, and Traditional and Simplified Chinese are all different groups. A colour change
// first trims the name (what String.prototype.trim removes, which includes the no-break and
// ideographic spaces but not the zero-width space), then refuses empty names and names over 40 UTF-16
// code units (so 20 emoji fit, 21 don't). Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorField, settingsFields } from '../js/storage.js';
import * as legacy from './legacy-1.19.0/storage.js';

const SAME = Symbol('the name as given');

const VECTORS = [
  ['empty', '', 'color_488bdcb81aee8d83', null],
  ['one space', ' ', 'color_2347b1af3bf17b24', null],
  ['three spaces', '   ', 'color_cefa3144bff1f43c', null],
  ['Food', 'Food', 'color_566d16f27227b7de', { key: 'color_566d16f27227b7de', name: SAME }],
  ['lower case', 'food', 'color_d9f5bf65a4f3a788', { key: 'color_d9f5bf65a4f3a788', name: SAME }],
  ['upper case', 'FOOD', 'color_95e4843f2336da28', { key: 'color_95e4843f2336da28', name: SAME }],
  ['leading space', ' Food', 'color_d0f9e26d0d636aa2', { key: 'color_566d16f27227b7de', name: 'Food' }],
  ['trailing space', 'Food ', 'color_0b8f1fc9745051a3', { key: 'color_566d16f27227b7de', name: 'Food' }],
  ['space inside', 'Fo od', 'color_457d7bf71631a30e', { key: 'color_457d7bf71631a30e', name: SAME }],
  ['two spaces inside', 'Fo  od', 'color_80ea340af4f30a1e', { key: 'color_80ea340af4f30a1e', name: SAME }],
  ['trailing tab', 'Food\u0009', 'color_9f536d9ac90ade00', { key: 'color_566d16f27227b7de', name: 'Food' }],
  ['trailing no-break space', 'Food\u00A0', 'color_5e4963aff109fd36', { key: 'color_566d16f27227b7de', name: 'Food' }],
  ['trailing ideographic space', 'Food\u3000', 'color_eaf3ccb75f248904', { key: 'color_566d16f27227b7de', name: 'Food' }],
  ['zero-width space inside', 'Fo\u200Bod', 'color_ce2013d0b197ca6e', { key: 'color_ce2013d0b197ca6e', name: SAME }],
  ['fullwidth letters', 'Ｆｏｏｄ', 'color_fe89c395b3b22d25', { key: 'color_fe89c395b3b22d25', name: SAME }],
  ['Uncategorised (the stored key)', 'Uncategorised', 'color_1e4c5c9c5a94eec4', { key: 'color_1e4c5c9c5a94eec4', name: SAME }],
  ['Income', 'Income', 'color_b86bbaa67def643b', { key: 'color_b86bbaa67def643b', name: SAME }],
  ['Gaming', 'Gaming', 'color_0305bb8033dcce51', { key: 'color_0305bb8033dcce51', name: SAME }],
  ['ampersand', 'Software & cloud', 'color_8f577ab20aa988bd', { key: 'color_8f577ab20aa988bd', name: SAME }],
  ['punctuation', 'Health & fitness (gym)', 'color_d3b53a2a0c42ac96', { key: 'color_d3b53a2a0c42ac96', name: SAME }],
  ['apostrophe', 'Kids\' clubs', 'color_75461513e3d47014', { key: 'color_75461513e3d47014', name: SAME }],
  ['accent, composed (NFC)', 'Café', 'color_6c38f2b11c467860', { key: 'color_6c38f2b11c467860', name: SAME }],
  ['accent, decomposed (NFD)', 'Cafe\u0301', 'color_4008240635da5927', { key: 'color_4008240635da5927', name: SAME }],
  ['ring, composed (NFC)', 'Ångström', 'color_b61cf2d236c6103d', { key: 'color_b61cf2d236c6103d', name: SAME }],
  ['ring, decomposed (NFD)', 'A\u030Angstro\u0308m', 'color_d252d4219943b965', { key: 'color_d252d4219943b965', name: SAME }],
  ['emoji first', '🎮 Gaming', 'color_24512ea2d3005e95', { key: 'color_24512ea2d3005e95', name: SAME }],
  ['emoji last', 'Gaming 🎮', 'color_34e18065ab6e31de', { key: 'color_34e18065ab6e31de', name: SAME }],
  ['emoji with variation selector', '☕\uFE0F Coffee', 'color_5f738a548ee195df', { key: 'color_5f738a548ee195df', name: SAME }],
  ['emoji ZWJ sequence', '👨\u200D👩\u200D👧', 'color_c2d667ddd0a2cc89', { key: 'color_c2d667ddd0a2cc89', name: SAME }],
  ['flag', '🇹🇼', 'color_23749b3667f909f6', { key: 'color_23749b3667f909f6', name: SAME }],
  ['Traditional Chinese (software and cloud)', '軟體與雲端', 'color_95e2e86384540336', { key: 'color_95e2e86384540336', name: SAME }],
  ['Simplified Chinese (software and cloud)', '软件与云端', 'color_063b42cc31c7eaec', { key: 'color_063b42cc31c7eaec', name: SAME }],
  ['Traditional Chinese (entertainment)', '娛樂', 'color_befd043421ed1948', { key: 'color_befd043421ed1948', name: SAME }],
  ['Simplified Chinese (entertainment)', '娱乐', 'color_4a417675c5f6a613', { key: 'color_4a417675c5f6a613', name: SAME }],
  ['Traditional Chinese (utilities)', '水電瓦斯', 'color_03e3e4cf207f0266', { key: 'color_03e3e4cf207f0266', name: SAME }],
  ['Simplified Chinese (utilities)', '水电瓦斯', 'color_1a8529492c27de8c', { key: 'color_1a8529492c27de8c', name: SAME }],
  ['Chinese (housing)', '居住', 'color_e010ef85caa1a457', { key: 'color_e010ef85caa1a457', name: SAME }],
  ['Chinese (Uncategorised label)', '未分類', 'color_bc6bc7bf1fec5cb9', { key: 'color_bc6bc7bf1fec5cb9', name: SAME }],
  ['mixed scripts', 'AI 工具', 'color_19ee539fc25406a0', { key: 'color_19ee539fc25406a0', name: SAME }],
  ['40 characters', 'x'.repeat(40), 'color_92f83926ad1fe719', { key: 'color_92f83926ad1fe719', name: SAME }],
  ['41 characters', 'x'.repeat(41), 'color_78f2c16c13221687', null],
  ['1000 characters', 'x'.repeat(1000), 'color_819a7942aee5273b', null],
  ['40 CJK characters', '居'.repeat(40), 'color_95372ec7de244f78', { key: 'color_95372ec7de244f78', name: SAME }],
  ['20 emoji (40 UTF-16 units)', '🎮'.repeat(20), 'color_f44f99d0128ac738', { key: 'color_f44f99d0128ac738', name: SAME }],
  ['21 emoji (42 UTF-16 units)', '🎮'.repeat(21), 'color_0712d766bd9cb6b4', null],
  ['lone surrogate', '\uD800', 'color_66dfb54e0827e5c5', { key: 'color_66dfb54e0827e5c5', name: SAME }],
  ['digits only', '0', 'color_eb2b2475ab050fb7', { key: 'color_eb2b2475ab050fb7', name: SAME }],
  ['__proto__', '__proto__', 'color_268627446511358b', { key: 'color_268627446511358b', name: SAME }],
  ['constructor', 'constructor', 'color_2da02fbea8bf91e2', { key: 'color_2da02fbea8bf91e2', name: SAME }],
];

test('colorField: every reference name still hashes to its frozen field, on the current code and on 1.19.0', () => {
  for (const [label, name, key] of VECTORS) {
    assert.equal(colorField(name), key, label);
    assert.equal(legacy.colorField(name), key, `${label} (1.19.0)`);
  }
});

test('colorField: color_ plus 16 lowercase hex digits, and no two reference names share a field', () => {
  for (const [label, , key] of VECTORS) assert.match(key, /^color_[0-9a-f]{16}$/, label);
  assert.equal(new Set(VECTORS.map((v) => v[2])).size, VECTORS.length);
});

test('colorField: no normalisation, so case, spaces, NFC and NFD, fullwidth, Traditional and Simplified are different fields', () => {
  const row = (label) => VECTORS.find((v) => v[0] === label);
  for (const [a, b] of [['Food', 'lower case'], ['Food', 'leading space'], ['Food', 'trailing no-break space'],
    ['accent, composed (NFC)', 'accent, decomposed (NFD)'], ['ring, composed (NFC)', 'ring, decomposed (NFD)'],
    ['Food', 'fullwidth letters'], ['Traditional Chinese (software and cloud)', 'Simplified Chinese (software and cloud)'],
    ['Traditional Chinese (entertainment)', 'Simplified Chinese (entertainment)']]) {
    assert.notEqual(row(a)[2], row(b)[2], `${a} vs ${b}`);
  }
  assert.equal(row('accent, decomposed (NFD)')[1].normalize('NFC'), row('accent, composed (NFC)')[1], 'one name in two forms');
  assert.equal(row('ring, decomposed (NFD)')[1].normalize('NFC'), row('ring, composed (NFC)')[1]);
});

test('a colour change: which names are accepted, and the field and name it stores (current code and 1.19.0)', () => {
  for (const [label, name, , stored] of VECTORS) {
    const change = { groupColors: Object.fromEntries([[name, 'g1']]) };
    const want = stored === null ? {} : { [stored.key]: { name: stored.name === SAME ? name : stored.name, swatch: 'g1' } };
    assert.deepEqual(settingsFields(null, change), want, label);
    assert.deepEqual(legacy.settingsFields(null, change), want, `${label} (1.19.0)`);
    if (stored !== null) assert.equal(stored.key, colorField(stored.name === SAME ? name : stored.name), `${label}: the field is the stored name's hash`);
  }
});
