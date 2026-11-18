// Node tests for js/group-merge.js, the merge helper. The household below is a synthetic copy of the
// real group list in docs/plan-intervals-groups.md (13 expense groups for 16 items, income without a
// category); no fixture of it exists in the repo. The helper must give exactly its merge map, 13
// groups to 9, in English and in Traditional Chinese, and never rename a group the household has.
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../js/locales/en.js';
import zh from '../js/locales/zh-TW.js';
import { suggestMerges, mergeChanges, groupCounts } from '../js/group-merge.js';
import { DEFAULT_GROUPS } from '../js/services.js';

const expense = (name, category) => ({ id: name, type: 'expense', name, price: 1, currency: 'TWD', cycle: 'monthly', nextRenewal: '2026-12-01', category });
const HOUSEHOLD = [
  expense('Amazon Prime', 'Shopping'), expense('Apple One', 'Cloud Storage'), expense('Insta360', 'Cloud Storage'),
  expense('Claude', 'AI'), expense('Coffee', 'Food'), expense('Financial Times', 'News'), expense('Petrol', 'Fuel'),
  expense('Loot Studios', 'Hobbies'), expense('Internet', 'Utilities'), expense('Mortgage', 'House'), expense('MuseScore', 'Music'),
  expense('Nintendo Switch Online', 'Gaming'), expense('NYT Games', 'Gaming'), expense('Twinkl', 'Education'),
  expense('YouTube Premium', 'Streaming'), expense('Spare', ''),
  { id: 'salary', type: 'income', name: 'Salary', price: 1, currency: 'TWD', cycle: 'monthly', nextRenewal: '2026-12-01', category: '' },
];
const nameIn = (dict) => (key) => dict[key];

test('default groups: their names here are the locale files\' names', () => {
  for (const g of DEFAULT_GROUPS) assert.deepEqual(g.names, [en[g.key], zh[g.key]], g.id);
});

test('the real household (synthetic copy): exactly the merge map, 13 groups to 9 (Uncategorised apart)', () => {
  const s = suggestMerges(HOUSEHOLD, { nameOf: nameIn(en) });
  assert.deepEqual(s, [
    { to: 'Housing', from: ['House'] },
    { to: 'Transport', from: ['Fuel'] },
    { to: 'Software & cloud', from: ['AI', 'Cloud Storage'] },
    { to: 'Entertainment', from: ['Gaming', 'News', 'Streaming'] },
    { to: 'Hobbies', from: ['Music'] },
  ]);
  // 13 named groups and Uncategorised (the "Spare" item) before; 9 named and Uncategorised after.
  assert.deepEqual(groupCounts(HOUSEHOLD, s), { before: 14, after: 10 });
  const moved = mergeChanges(HOUSEHOLD, s).map(({ item, category }) => `${item.name}: ${item.category} -> ${category}`);
  assert.deepEqual(moved.sort(), [
    'Apple One: Cloud Storage -> Software & cloud', 'Claude: AI -> Software & cloud', 'Financial Times: News -> Entertainment',
    'Insta360: Cloud Storage -> Software & cloud', 'Mortgage: House -> Housing', 'MuseScore: Music -> Hobbies',
    'NYT Games: Gaming -> Entertainment', 'Nintendo Switch Online: Gaming -> Entertainment', 'Petrol: Fuel -> Transport',
    'YouTube Premium: Streaming -> Entertainment',
  ]);
  assert.ok(!mergeChanges(HOUSEHOLD, s).some(({ item }) => item.type === 'income' || item.category === ''), 'income and Uncategorised stay');
});

test('in Traditional Chinese the new targets get Chinese names; groups the household has keep theirs', () => {
  const s = suggestMerges(HOUSEHOLD, { nameOf: nameIn(zh) });
  assert.deepEqual(s.map((x) => [x.to, x.from]), [
    ['居住', ['House']], ['交通', ['Fuel']], ['軟體與雲端', ['AI', 'Cloud Storage']], ['娛樂', ['Gaming', 'News', 'Streaming']], ['Hobbies', ['Music']],
  ]);
});

test('a default the household already has under another language\'s name is the target, never a second copy', () => {
  const items = [expense('a', 'Housing'), expense('b', 'House'), expense('c', '居住')];
  assert.deepEqual(suggestMerges(items, { nameOf: nameIn(en) }), [{ to: 'Housing', from: ['House', '居住'] }]);
  assert.deepEqual(suggestMerges(items, { nameOf: nameIn(zh) }), [{ to: '居住', from: ['House', 'Housing'] }]);
  assert.deepEqual(suggestMerges([expense('a', 'food'), expense('b', 'Coffee')], { nameOf: nameIn(en) }), [{ to: 'food', from: ['Coffee'] }], 'case doesn\'t make a new group');
});

test('nothing to suggest: groups that match no alias, or a default with nothing else in it', () => {
  assert.deepEqual(suggestMerges([expense('a', 'Pets'), expense('b', 'Garden'), expense('c', 'Food')], { nameOf: nameIn(en) }), []);
  assert.deepEqual(suggestMerges([], { nameOf: nameIn(en) }), []);
  assert.deepEqual(suggestMerges([expense('a', 'Cloudy'), expense('b', 'Fuel station')], { nameOf: nameIn(en) }), [], 'whole names only, no fuzzy matching');
});
