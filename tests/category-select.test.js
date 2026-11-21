// In-browser tests for 1.25.0's Category drop-down in the add and edit sheet (index.html, js/app.js
// fillCategorySelect and readForm, js/category-select.js). Run by tests/category-select.html with a
// fixed clock (18 November 2026) against a throwaway database, with index.html's markup. Run it at
// 320, 360 and 393px, with and without reduced motion emulated, and in English, the pseudo-locale
// (?lang=xx) and zh-TW (?lang=zh-TW). Expected words come from t(), so every language checks the same
// things. The tests run in order, as one session in the app: later ones add items.

import * as storage from '../js/storage.js';
import { overlays, pressBack } from '../js/overlays.js';
import { t, compareNames } from '../js/i18n.js';
import { DEFAULT_GROUPS } from '../js/services.js';
import { groupLabel, UNCATEGORISED } from '../js/insights-calc.js';
import { NEW_GROUP } from '../js/category-select.js';
import { slotsFromRecord, pickSlot, SLOT_COUNT } from '../js/group-slots.js';
import { colorField } from '../js/storage.js';

const results = [];
const dbName = `substracker-test-cat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed', 'insightsMode'];
const savedPrefs = Object.fromEntries(PREFS.map((p) => [p, storage.getPref(p)]));
const LANG = new URLSearchParams(location.search).get('lang') || 'en';

function test(name, fn) { results.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const text = (el) => el?.textContent.replace(/\s+/g, ' ').trim() ?? '';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t0 = 0; t0 < ms; t0 += 25) { if (await cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// A 40-character group (the limit), a default group under its English name (shown as the household's
// own group outside English), Pets twice and "pets" once (one option, Pets; the odd spelling shows
// only when its item is edited), an uncategorised expense, and income with a category (never an option).
const LONG = `Long group ${'x'.repeat(29)}`;
const SEED = [
  { ...base, type: 'income', id: 'i-side', name: 'Side gig', price: 5000, cycle: 'monthly', nextRenewal: '2026-11-30', category: 'Side music' },
  { ...base, id: 'e-netflix', name: 'Netflix', price: 390, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Entertainment' },
  { ...base, id: 'e-vet', name: 'Vet', price: 3000, cycle: 'once', date: '2026-11-21', category: 'Pets' },
  { ...base, id: 'e-kibble', name: 'Kibble', price: 800, cycle: 'monthly', nextRenewal: '2026-11-26', category: 'Pets' },
  { ...base, id: 'e-toy', name: 'Toy', price: 200, cycle: 'monthly', nextRenewal: '2026-11-27', category: 'pets' },
  { ...base, id: 'e-zoo', name: 'Zoo pass', price: 1200, cycle: 'annual', nextRenewal: '2027-03-01', category: 'Zoo club' },
  { ...base, id: 'e-books', name: 'Comic shop', price: 450, cycle: 'monthly', nextRenewal: '2026-11-24', category: 'Books & comics' },
  { ...base, id: 'e-long', name: 'Long one', price: 100, cycle: 'monthly', nextRenewal: '2026-11-29', category: LONG },
  { ...base, id: 'e-misc', name: 'Misc', price: 150, cycle: 'monthly', nextRenewal: '2026-11-23' },
];

const sheet = () => $('#sub-dialog');
const f = () => $('#sub-form').elements;
const select = () => f().category;
const nameField = () => $('#field-new-group');
const more = () => $('#more-toggle');
const body = () => $('#sub-dialog .sheet-body');
const isOpen = (d) => d.open || d.hasAttribute('open');
const reduced = () => document.documentElement.classList.contains('reduce-motion');
const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(60); };
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };
const view = async (v) => {
  if (appTab() !== 'subs') await goTab('subs');
  $('#view-btn').click();
  $(`#view-menu [data-view="${v}"]`).click();
  await tick(80);
};
const shown = (el) => !!el && el.getClientRects().length > 0;
const setValue = (name, v) => { const el = f()[name]; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
/** Pick an option as a tap in the picker does: the value, then input and change. */
const choose = (value) => {
  const s = select();
  s.value = value;
  assert(s.value === value, `"${value}" is an option`);
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
};
const optionValues = () => $$('option', select()).map((o) => o.value);
const optionLabels = () => $$('option', select()).map((o) => o.textContent);
const norm = (s) => s.trim().toLowerCase();
const pickKind = async (kind) => {
  $(`#field-kind input[value="${kind}"]`).click();
  await tick(30);
  await Promise.all($$('#field-kind .seg-option span').flatMap((s) => s.getAnimations()).map((a) => a.finished.catch(() => {})));
};
async function openAdd() {
  if (appTab() !== 'subs') await goTab('subs');
  $('#fab').click();
  await until(() => isOpen(sheet()), 'the add sheet opens');
  await tick(30);
}
async function openEdit(id) {
  await view('list');
  $(`#subs-list [data-id="${id}"]`).click();
  await until(() => isOpen(sheet()), 'the edit sheet opens');
  await tick(30);
}
async function save() {
  $('#sub-form button[type="submit"]').click();
  await until(() => !isOpen(sheet()), 'the sheet saves and closes');
  await tick(60);
}
const all = () => storage.getAll();
const byName = async (name) => (await all()).find((s) => s.name === name);
const groups = async () => new Set((await all()).filter((s) => s.type !== 'income').map((s) => s.category.trim() || UNCATEGORISED));
/** Fill a new expense's required fields. */
function fillRequired(name) {
  setValue('name', name);
  setValue('price', '100');
  setValue('nextRenewal', '2026-12-01');
}
/** Add an expense named `name` with "New group…" and `typed` in its field; returns the stored item. */
async function addWithNewGroup(name, typed) {
  await openAdd();
  await pickKind('expense');
  fillRequired(name);
  more().click();
  choose(NEW_GROUP);
  setValue('newGroup', typed);
  await save();
  return byName(name);
}

/* --------------------------------------------------------------------------------------------- */

test('a native drop-down with its label, under More details; Uncategorised, the default groups, the household\'s own A–Z, then New group…', async () => {
  await openAdd();
  eq(select().tagName, 'SELECT', 'Category is a <select>');
  eq(select().labels.length, 1, 'with one label');
  assert(text(select().labels[0]).startsWith(t('form.category')), `named "${t('form.category')}"`);
  assert($('#more-details').contains(select()), 'under More details');
  eq(more().getAttribute('aria-expanded'), 'false', 'adding: More details folded, as before');
  const values = optionValues();
  const labels = optionLabels();
  eq([values[0], labels[0]], ['', groupLabel(UNCATEGORISED)], 'Uncategorised first, stored as no category, named through groupLabel');
  eq(select().value, '', 'and chosen when adding');
  const n = DEFAULT_GROUPS.length;
  eq(n, 11, 'eleven default groups');
  eq(values.slice(1, 1 + n), DEFAULT_GROUPS.map((g) => t(g.key)), 'then the default groups, in table order, in the language in use');
  eq(labels.slice(1, 1 + n), DEFAULT_GROUPS.map((g) => t(g.key)), 'labelled as stored');
  const defaults = new Set(DEFAULT_GROUPS.map((g) => norm(t(g.key))));
  const own = ['Books & comics', LONG, 'Pets', 'Zoo club', 'Entertainment'].filter((g) => !defaults.has(norm(g))).sort(compareNames);
  eq(values.slice(1 + n, -1), own, 'then the household\'s own groups, A–Z in the language\'s order (Pets once, no income group)');
  if (LANG === 'en') assert(!values.slice(1 + n).includes('Entertainment'), 'English: Entertainment is the default option, not a second one');
  else assert(values.includes('Entertainment'), 'other languages: the English Entertainment is the household\'s own group');
  assert(!values.includes('pets') && !values.includes('Side music'), 'no folded spelling and no income category');
  eq([values.at(-1), labels.at(-1)], [NEW_GROUP, t('form.category.new')], 'New group… last');
  eq(values.length, new Set(values.map(norm)).size, 'no name twice');
  assert(nameField().hidden && !shown(f().newGroup), 'the name field is hidden until New group… is chosen');
  more().click();
  assert(shown(select()), 'shown with More details open');
  await closeSheets();
});

test('adding with nothing chosen saves Uncategorised; a default group saves its name in the language in use', async () => {
  await openAdd();
  await pickKind('expense');
  fillRequired('Plain thing');
  await save();
  eq((await byName('Plain thing')).category, '', 'no category, as before');
  await openAdd();
  fillRequired('Lunch');
  more().click();
  choose(t('group.preset.food'));
  assert(nameField().hidden, 'no name field for a group');
  await save();
  eq((await byName('Lunch')).category, t('group.preset.food'), 'the default group\'s name');
});

test('an existing group saves its stored name', async () => {
  await openAdd();
  fillRequired('Aquarium');
  more().click();
  choose('Zoo club');
  await save();
  eq((await byName('Aquarium')).category, 'Zoo club', 'Zoo club');
});

test('New group…: the name field shows, labelled, and takes focus; the new group is saved and gets a free colour slot', async () => {
  const rec0 = await storage.getSettingsRecord();
  const before = [...await groups()];
  await openAdd();
  fillRequired('Chess set');
  more().click();
  select().focus();
  choose(NEW_GROUP);
  await tick(30);
  assert(!nameField().hidden && shown(f().newGroup), 'the name field shows');
  eq(nameField().previousElementSibling, select().closest('.field'), 'right under the drop-down');
  eq(document.activeElement, f().newGroup, 'and takes focus');
  eq(f().newGroup.labels.length, 1, 'with a label');
  eq(text(f().newGroup.labels[0]), t('form.newGroup'), `"${t('form.newGroup')}"`);
  eq(f().newGroup.placeholder, t('form.newGroup.placeholder'), 'and its placeholder');
  eq(overlays.ids(), ['sub-dialog'], 'inline, not an overlay');
  setValue('newGroup', '  Board games ');
  await save();
  eq((await byName('Chess set')).category, 'Board games', 'saved, trimmed');
  // Its colour comes the usual way, as the app draws again (ensureGroupColors, js/group-slots.js).
  await view('grid');
  const dots = new Map($$('#subs-list .group-dot').map((d) => [d.dataset.group, d.style.getPropertyValue('--swatch').trim()]));
  assert(dots.get('Board games'), 'the new group has a colour dot');
  if (before.length < SLOT_COUNT) {
    for (const g of before) assert(dots.get(g) !== dots.get('Board games'), `not the same colour as ${g} (a free slot)`);
  }
  if (rec0) {
    const { shared } = slotsFromRecord(rec0);
    const counts = new Array(SLOT_COUNT).fill(0);
    for (const g of before) { const s = shared.get(g)?.slot; if (s !== undefined) counts[s]++; }
    await until(async () => (await storage.getSettingsRecord())?.fields[colorField('Board games')], 'the slot is written to the household settings');
    const v = (await storage.getSettingsRecord()).fields[colorField('Board games')];
    eq([v.slot, v.auto], [pickSlot('Board games', counts), true], 'the next free slot, as any new group gets it');
  }
  await view('list');
  await openAdd();
  assert(optionValues().includes('Board games'), 'and it is an option next time');
  await closeSheets();
});

test('New group… with an empty name saves Uncategorised; a name that is already a group picks it (case and spacing ignored)', async () => {
  eq((await addWithNewGroup('Blank one', '   ')).category, '', 'only spaces: Uncategorised');
  const groupsBefore = await groups();
  const cases = [
    ['Zoo one', '  zoo   CLUB ', 'Zoo club'],
    ['Pet two', 'PETS', 'Pets'],
    ['Show one', 'entertainment', 'Entertainment'],
    ['Home one', '居住', t('group.preset.housing')],
    ['Unc one', `  ${t('group.uncategorised').toUpperCase()} `, ''],
    ['Unc two', 'uncategorised', ''],
    ['Food two', `${t('group.preset.food').toLowerCase()} `, t('group.preset.food')],
  ];
  for (const [name, typed, expected] of cases) {
    eq((await addWithNewGroup(name, typed)).category, expected, `"${typed}" saves as "${expected}"`);
  }
  // Housing is the only group these add (as the default group's name in the language in use).
  eq([...await groups()].sort(), [...new Set([...groupsBefore, t('group.preset.housing')])].sort(), 'no second copy of any group');
});

test('a name over 40 characters is refused with the category limit; 40 is fine', async () => {
  await openAdd();
  fillRequired('Too long');
  more().click();
  choose(NEW_GROUP);
  setValue('newGroup', 'y'.repeat(41));
  more().click(); // folded again: the refusal opens it to show the message
  $('#sub-form button[type="submit"]').click();
  await tick(60);
  assert(isOpen(sheet()), 'not saved: the sheet stays open');
  eq(more().getAttribute('aria-expanded'), 'true', 'More details opens to show it');
  eq(f().newGroup.getAttribute('aria-invalid'), 'true', 'the field is marked invalid');
  eq(text($('[data-error-for="newGroup"]')), t('form.error.groupLong', { max: 40 }), 'with the message');
  eq(document.activeElement, f().newGroup, 'focus on the field');
  assert(body().scrollWidth <= body().clientWidth + 1, 'the message fits the sheet\'s width');
  eq((await byName('Too long')), undefined, 'nothing stored');
  setValue('newGroup', 'z'.repeat(40));
  eq(text($('[data-error-for="newGroup"]')), '', 'typing clears the message');
  await save();
  eq((await byName('Too long')).category, 'z'.repeat(40), '40 characters save');
});

test('a known service preselects its default group and opens More details by itself; a pick of your own stays', async () => {
  await openAdd();
  await pickKind('expense');
  setValue('name', 'Netflix');
  await tick(30);
  eq(more().getAttribute('aria-expanded'), 'true', 'More details opens by itself, as in 1.23.0');
  eq(select().value, t('group.preset.entertainment'), 'Entertainment in the language in use');
  eq(select().selectedOptions[0].textContent, t('group.preset.entertainment'), 'shown as chosen');
  setValue('name', 'Spotify');
  await tick(30);
  eq(select().value, t('group.preset.hobbies'), 'another service: its own group');
  choose('Zoo club');
  setValue('name', 'Netflix');
  await tick(30);
  eq(select().value, 'Zoo club', 'chosen by hand: a service name no longer changes it');
  choose('');
  setValue('name', 'Disney+');
  await tick(30);
  eq(select().value, t('group.preset.entertainment'), 'back on Uncategorised: the fill works again');
  choose(NEW_GROUP);
  setValue('name', 'iCloud');
  await tick(30);
  eq(select().value, NEW_GROUP, 'New group… chosen: kept');
  assert(!nameField().hidden, 'with its field');
  await closeSheets();
});

test('editing an item with an unusual category adds it as an option, chosen; saving keeps it', async () => {
  await openEdit('e-toy');
  eq(more().getAttribute('aria-expanded'), 'true', 'More details open (it has a category)');
  eq(select().value, 'pets', 'its own spelling, chosen');
  eq(optionValues().filter((v) => v === 'pets').length, 1, 'added once');
  assert(optionValues().includes('Pets'), 'beside the usual Pets');
  setValue('price', '210');
  await save();
  const toy = (await all()).find((s) => s.id === 'e-toy');
  eq([toy.price, toy.category], [210, 'pets'], 'the new price; the category kept as it was');
  await openEdit('e-vet');
  assert(!optionValues().includes('pets'), 'another item\'s sheet doesn\'t list it');
  eq(select().value, 'Pets', 'Pets chosen');
  await closeSheets();
  await openEdit('e-long');
  eq(select().value, LONG, 'a 40-character group, chosen');
  await closeSheets();
  await openEdit('e-misc');
  eq(select().value, '', 'an uncategorised item: Uncategorised');
  await closeSheets();
});

test('income: no Category and no name field; a new income item saves no category', async () => {
  await openAdd();
  await pickKind('expense');
  fillRequired('Gig');
  more().click();
  choose(NEW_GROUP);
  setValue('newGroup', 'Gig stuff');
  await pickKind('income');
  assert(!shown(select()) && !shown(f().newGroup), 'income: both hidden');
  await pickKind('expense');
  assert(shown(select()) && shown(f().newGroup), 'expense again: both back');
  eq(f().newGroup.value, 'Gig stuff', 'with what was typed');
  await pickKind('income');
  await save();
  const gig = await byName('Gig');
  eq([gig.type, gig.category], ['income', ''], 'income, no category');
  await openEdit('e-netflix');
  await closeSheets();
});

test('keyboard: arrowing onto New group… shows the field without taking focus; Tab goes there next; Back closes the sheet in one press', async () => {
  await openAdd();
  more().click();
  select().focus();
  select().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  select().value = NEW_GROUP;
  select().dispatchEvent(new Event('input', { bubbles: true }));
  select().dispatchEvent(new Event('change', { bubbles: true }));
  await tick(30);
  assert(!nameField().hidden, 'the field shows');
  eq(document.activeElement, select(), 'focus stays on the drop-down while arrowing');
  const focusables = $$('input, select, textarea, button', sheet()).filter((el) => shown(el) && !el.disabled && el.tabIndex >= 0);
  eq(focusables[focusables.indexOf(select()) + 1], f().newGroup, 'the name field is next in Tab order');
  select().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  choose('');
  assert(nameField().hidden, 'another pick hides it');
  choose(NEW_GROUP);
  eq(document.activeElement, f().newGroup, 'a pick from the picker moves focus to it');
  eq(overlays.ids(), ['sub-dialog'], 'only the sheet on the overlay stack');
  pressBack();
  await tick(60);
  assert(!isOpen(sheet()), 'one Back closes the sheet');
  eq(overlays.ids(), [], 'nothing left open');
});

test('no animation when the field shows (Reduce motion and effects or not); nothing wider than the sheet', async () => {
  await openAdd();
  more().click();
  choose(NEW_GROUP);
  // The only motion is the shared .input focus style as focus moves into the field (its border and
  // focus ring), and none of it with Reduce motion and effects. Nothing slides or fades in.
  const anims = [nameField(), select().closest('.field')].flatMap((el) => el.getAnimations({ subtree: true }));
  const focusStyle = /^(border-(top|right|bottom|left)-color|box-shadow)$/;
  const other = anims.filter((a) => !(a.transitionProperty && focusStyle.test(a.transitionProperty) && a.effect.target === f().newGroup));
  eq(other.map((a) => a.transitionProperty ?? a.animationName), [], 'no animation of the field itself');
  if (reduced()) eq(anims.length, 0, 'Reduce motion and effects: no transition at all');
  if (reduced()) {
    for (const el of [nameField(), f().newGroup, select()]) {
      const cs = getComputedStyle(el);
      const durations = cs.transitionDuration.split(',').map((d) => parseFloat(d));
      // css/app.css cuts every transition to 0.01ms with Reduce motion and effects.
      assert(cs.transitionProperty === 'none' || durations.every((d) => d <= 0.00001), `${el.tagName}: no transition with Reduce motion (${cs.transitionDuration})`);
    }
  }
  for (const el of [select(), f().newGroup]) {
    const r = el.getBoundingClientRect();
    const b = body().getBoundingClientRect();
    assert(r.left >= b.left - 0.5 && r.right <= b.right + 0.5, `${el.name} inside the sheet (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(b.left)}–${Math.round(b.right)})`);
  }
  choose(LONG);
  assert(body().scrollWidth <= body().clientWidth + 1, 'a 40-character group chosen: no sideways scroll');
  assert(document.documentElement.scrollWidth <= innerWidth, 'the page doesn\'t scroll sideways');
  await closeSheets();
});

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'list');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  storage.setPref('insightsMode', 'month');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  for (const p of ['groupSort', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed']) localStorage.removeItem(`substracker.${p}`);
  if (LANG === 'zh-TW') storage.setPref('lang', 'zh-TW'); else localStorage.removeItem('substracker.lang');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#subs-list [data-id]'), 'app drawn', 8000);
  await tick(300);

  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; } catch (err) { failures.push({ name, error: err.message }); }
    await closeSheets();
  }
  for (const [p, v] of Object.entries(savedPrefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
  $('#t-report').hidden = false;
  $('#summary').textContent = failures.length ? `${failures.length} of ${results.length} failed` : `All ${results.length} passed`;
  $('#summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  $('#results').innerHTML = results.map(({ name }) => {
    const fl = failures.find((x) => x.name === name);
    return `<li class="${fl ? 't-fail' : 't-pass'}">${fl ? '✗' : '✓'} ${name}${fl ? `<div class="t-detail">${fl.error.replace(/</g, '&lt;')}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures, reduced: reduced() };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-cat-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
