// Node tests for the default groups (js/services.js DEFAULT_GROUPS, docs/plan-intervals-groups.md 5.2):
// the eleven names in English and Traditional Chinese, Import with AI's English examples, the known
// services mapped to them, and that a default group is only ever plain name text. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../js/locales/en.js';
import zh from '../js/locales/zh-TW.js';
import { DEFAULT_GROUPS, DEFAULT_CATEGORIES, LEGACY_CATEGORIES, SERVICES, englishGroupName, matchService } from '../js/services.js';
import { AI_IMPORT_PROMPT } from '../js/import-ai-prompt.js';
import { colorField } from '../js/storage.js';

test('the eleven default groups, in English and Traditional Chinese', () => {
  assert.deepEqual(DEFAULT_GROUPS.map((g) => [en[g.key], zh[g.key]]), [
    ['Housing', '居住'], ['Utilities', '生活帳單'], ['Food', '餐飲'], ['Transport', '交通'],
    ['Software & cloud', '軟體與雲端'], ['Entertainment', '娛樂'], ['Hobbies', '嗜好'], ['Education', '教育'],
    ['Shopping', '購物'], ['Health & fitness', '健康與運動'], ['Insurance & finance', '保險與金融'],
  ]);
  assert.equal(new Set(DEFAULT_GROUPS.map((g) => g.id)).size, 11);
  for (const g of DEFAULT_GROUPS) {
    assert.ok(Object.isFrozen(DEFAULT_GROUPS));
    assert.ok(en[g.key].length <= 40 && zh[g.key].length <= 40, 'fits a group name');
    assert.ok(g.aliases.includes(en[g.key].toLowerCase()) && g.aliases.includes(zh[g.key]), `${g.id}: its own names are aliases`);
  }
});

test('Import with AI suggests the English default groups; old category names are still recognised', () => {
  assert.deepEqual(DEFAULT_CATEGORIES, DEFAULT_GROUPS.map((g) => en[g.key]));
  assert.ok(AI_IMPORT_PROMPT.includes(`a short category such as ${DEFAULT_CATEGORIES.join(', ')};`), 'the prompt lists them, in English');
  assert.ok(LEGACY_CATEGORIES.includes('Cloud storage') && LEGACY_CATEGORIES.includes('Music'));
});

test('known services fill in a default group (in the language in use, by its key)', () => {
  const ids = new Set(DEFAULT_GROUPS.map((g) => g.id));
  for (const svc of SERVICES) {
    assert.ok(ids.has(svc.group), `${svc.name}: ${svc.group}`);
    assert.equal(svc.category, englishGroupName(svc.group));
  }
  assert.equal(matchService('netflix').group, 'entertainment');
  assert.equal(matchService('spotify').group, 'hobbies', 'Music goes into Hobbies (the plan)');
  assert.equal(matchService('icloud').group, 'software');
  assert.equal(matchService('nintendo switch online').group, 'entertainment');
});

test('a default group is plain name text: its field is the same hash as any group with that name', () => {
  assert.equal(colorField(en['group.preset.food']), colorField('Food'));
  assert.equal(colorField('Food'), 'color_566d16f27227b7de', 'the frozen reference value (tests/color-field.node.test.js)');
  assert.notEqual(colorField(en['group.preset.housing']), colorField(zh['group.preset.housing']), 'no matching across languages');
});
