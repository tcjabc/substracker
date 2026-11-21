// Node tests for js/category-select.js, the add and edit sheet's Category drop-down (1.25.0): the
// options and their order, the de-duplication, an edited item's unusual category, and what a name
// typed under "New group…" saves as, in English and Traditional Chinese. Also that every known
// service (js/services.js) maps to a default group. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../js/locales/en.js';
import zh from '../js/locales/zh-TW.js';
import { categoryOptions, resolveNewGroup, NEW_GROUP } from '../js/category-select.js';
import { DEFAULT_GROUPS, SERVICES } from '../js/services.js';
import { UNCATEGORISED } from '../js/insights-calc.js';

const expense = (name, category) => ({ id: name, type: 'expense', name, price: 1, currency: 'TWD', cycle: 'monthly', nextRenewal: '2026-12-01', category });
const ITEMS = [
  expense('Vet', 'Pets'), expense('Kibble', 'Pets'), expense('Toy', 'pets'), expense('Zoo', 'Zoo club'),
  expense('Netflix', 'Entertainment'), expense('Rent', ' Home '), expense('Misc', ''), expense('Lit', 'Uncategorised'),
  { ...expense('Side gig', 'Side music'), type: 'income' },
];
const opts = (dict, current) => categoryOptions(ITEMS, {
  nameOf: (k) => dict[k],
  labelOf: (n) => (n === UNCATEGORISED ? dict['group.uncategorised'] : n),
  compare: (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }),
  current,
});

test('options: Uncategorised, the eleven defaults in table order, the household\'s own A–Z, New group…', () => {
  const o = opts(en);
  assert.deepEqual(o[0], { value: '', label: 'Uncategorised', kind: 'none' });
  assert.deepEqual(o.slice(1, 12).map((x) => x.value), DEFAULT_GROUPS.map((g) => en[g.key]));
  assert.deepEqual(o.slice(1, 12).map((x) => x.id), DEFAULT_GROUPS.map((g) => g.id));
  // Pets (twice) beats pets (once); Entertainment is the default; " Home " is grouped as Home; no
  // income category; the literal Uncategorised is Uncategorised.
  assert.deepEqual(o.slice(12, -1).map((x) => x.value), ['Home', 'Pets', 'Zoo club']);
  assert.deepEqual(o.at(-1), { value: NEW_GROUP, label: 'New group…', kind: 'new' });
});

test('zh-TW: the defaults in Chinese, and the English Entertainment as the household\'s own group', () => {
  const o = opts(zh);
  assert.equal(o[0].label, '未分類');
  assert.deepEqual(o.slice(1, 12).map((x) => x.value), DEFAULT_GROUPS.map((g) => zh[g.key]));
  assert.deepEqual(o.slice(12, -1).map((x) => x.value).sort(), ['Entertainment', 'Home', 'Pets', 'Zoo club']);
  assert.equal(o.at(-1).label, '新增群組…');
});

test('an edited item\'s category that isn\'t an option is added once, among the household\'s groups', () => {
  assert.deepEqual(opts(en, 'pets').slice(12, -1).map((x) => x.value), ['Home', 'Pets', 'pets', 'Zoo club'], 'ties A–Z by code point');
  assert.equal(opts(en, 'Pets').filter((x) => x.value === 'Pets').length, 1);
  assert.equal(opts(en, 'Food').filter((x) => x.value === 'Food').length, 1, 'a default: not added again');
  assert.equal(opts(en, '').length, opts(en).length);
  assert.notEqual(NEW_GROUP, NEW_GROUP.trim(), 'the New group value can\'t be a stored (trimmed) category');
});

test('a typed new group: empty is Uncategorised, too long is refused, an existing name picks that option', () => {
  const o = opts(en);
  assert.deepEqual(resolveNewGroup('   ', o), { value: '' });
  assert.deepEqual(resolveNewGroup('x'.repeat(41), o, { max: 40 }), { error: 'long' });
  assert.deepEqual(resolveNewGroup(` ${'x'.repeat(40)} `, o, { max: 40 }), { value: 'x'.repeat(40), created: true });
  assert.deepEqual(resolveNewGroup('  zoo   CLUB ', o), { value: 'Zoo club' });
  assert.deepEqual(resolveNewGroup('PETS', o), { value: 'Pets' });
  assert.deepEqual(resolveNewGroup('health&fitness', o), { value: 'Health & fitness' });
  assert.deepEqual(resolveNewGroup('uncategorised', o), { value: '' });
  assert.deepEqual(resolveNewGroup('居住', o), { value: 'Housing' }, 'a default\'s other-language name: the default as shown');
  assert.deepEqual(resolveNewGroup('Board games', o), { value: 'Board games', created: true });
  const z = opts(zh);
  assert.deepEqual(resolveNewGroup('未分類', z), { value: '' });
  assert.deepEqual(resolveNewGroup('uncategorised', z), { value: '' }, 'the stored key too');
  assert.deepEqual(resolveNewGroup('entertainment', z), { value: 'Entertainment' }, 'the household\'s own spelling first');
  assert.deepEqual(resolveNewGroup('housing', z), { value: '居住' });
  assert.deepEqual(resolveNewGroup(' 嗜好 ', z), { value: '嗜好' });
});

test('every known service maps to one of the eleven default groups', () => {
  const ids = new Set(DEFAULT_GROUPS.map((g) => g.id));
  for (const svc of SERVICES) assert.ok(ids.has(svc.group), `${svc.name} → ${svc.group}`);
});
