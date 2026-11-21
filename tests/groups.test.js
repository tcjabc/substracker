// In-browser tests for the H + L stack's groups on the 1.22 screens (js/app.js bindGroupMerge,
// bindGroupColors, fillCategorySelect, ensureGroupColors; js/group-merge.js, js/group-slots.js): Tidy
// up groups and the 15-slot colour picker are overlays (Android Back closes them, as Cancel and
// Escape do); Merge moves the items and Undo puts them back; the default groups are options of
// Group under the add sheet's More details, in the language in use, and a known service name fills
// it; income saves no group; and every place that draws a group colour draws the same one (the Grid
// dot, the Wallet card, the income gauge's front card, Insights' donut and legend in the pinned
// card, the year chart's categories, the Calendar's dots). Run by tests/groups.html with a fixed
// clock (18 November 2026) against a throwaway database, with index.html's markup, at 320, 360 and
// 393px, with and without reduced motion emulated, in English, the pseudo-locale (?lang=xx) and
// zh-TW (?lang=zh-TW). ?hold=1 sets the app up and runs nothing.

import * as storage from '../js/storage.js';
import { t, compareNames } from '../js/i18n.js';
import { overlays, pressBack } from '../js/overlays.js';
import { DEFAULT_GROUPS } from '../js/services.js';
import { suggestMerges } from '../js/group-merge.js';
import { WALLET_KEYS } from '../js/wallet-math.js';

const results = [];
const dbName = `substracker-test-groups-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'period', 'theme', 'reduceMotion', 'lang', 'insightsMode', 'catView', 'yearRange', 'yearStack', 'yearKey', 'groupSort'];
const savedPrefs = Object.fromEntries(PREFS.map((p) => [p, storage.getPref(p)]));
const params = new URLSearchParams(location.search);
const HOLD = params.get('hold') === '1';

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
// "Today" is Wednesday 18 November 2026. Five expense groups, every one at least 7% of November (so
// none is pooled into the donut's Other). Four of them are aliases of a default group (Rent, Phone,
// Streaming, Gym), so Tidy up suggests four moves; Pets is nobody's alias. Income has no group.
const SEED = [
  { ...base, type: 'income', id: 'g-salary', name: 'Salary', price: 60000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, id: 'g-rent', name: 'Flat', price: 9000, cycle: 'monthly', nextRenewal: '2026-11-03', category: 'Rent' },
  { ...base, id: 'g-vet', name: 'Vet', price: 3000, cycle: 'once', date: '2026-11-21', category: 'Pets' },
  { ...base, id: 'g-gym', name: 'Gym pass', price: 2500, cycle: 'monthly', nextRenewal: '2026-11-14', category: 'Gym' },
  { ...base, id: 'g-phone', name: 'Mobile', price: 1500, cycle: 'monthly', nextRenewal: '2026-11-12', category: 'Phone' },
  { ...base, id: 'g-stream', name: 'Films', price: 1200, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Streaming' },
];

const reduced = () => document.documentElement.classList.contains('reduce-motion');
const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(80); };
const isOpen = (d) => d.open || d.hasAttribute('open');
const sheet = () => $('#sub-dialog');
const f = () => $('#sub-form').elements;
const confirmDlg = () => $('#confirm-dialog');
const confirmButton = (label) => $$('#confirm-actions button').find((b) => text(b) === label);
const wallet = () => $('#wallet')?.wallet;
const wCards = () => $$('#wallet .w-card');
const wCard = (name) => wCards().find((c) => text($('.w-name', c)) === name);
const wSettled = () => until(() => wallet() && !wallet().state().animating, 'the wallet settles', 4000);
const cssToken = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();
const categories = async () => Object.fromEntries((await storage.getAll()).map((s) => [s.id, s.category]));
const expenseGroups = async () => [...new Set((await storage.getAll()).filter((s) => s.type !== 'income').map((s) => s.category))];
async function view(v) {
  if (appTab() !== 'subs') await goTab('subs');
  $('#view-btn').click();
  assert(!$('#view-menu').hidden, 'the View menu opens');
  $(`#view-menu [data-view="${v}"]`).click();
  await tick(80);
}
const varName = (v) => /^var\((--[\w-]+)\)$/.exec(String(v).trim())?.[1] ?? null;
/** Each expense group's colour as the app resolves it (js/app.js groupSwatch), read from the Grid's dots. */
async function resolved() {
  await view('grid');
  const map = new Map($$('#subs-list .group-dot').map((d) => [d.dataset.group, d.style.getPropertyValue('--swatch').trim()]));
  for (const g of await expenseGroups()) assert(map.has(g), `${g} has a colour dot`);
  return map;
}

/* ---------------------------------------------------------------- tests */

test('Tidy up groups: its dialog is on the overlay stack, lists the four moves, and Back closes it as Cancel (nothing moves)', async () => {
  await goTab('settings');
  const before = await categories();
  $('#btn-group-merge').click();
  await until(() => isOpen(confirmDlg()), 'the merge dialog');
  eq(text($('#confirm-title')), t('groups.merge.title'), 'its title');
  const suggestions = suggestMerges(await storage.getAll(), { nameOf: t, compare: compareNames });
  eq(suggestions.map((s) => s.from).flat().sort(), ['Gym', 'Phone', 'Rent', 'Streaming'], 'four groups to move; Pets stays');
  const msg = text($('#confirm-message'));
  for (const s of suggestions) {
    const line = t('groups.merge.line', { from: s.from.join(t('common.listSep')), to: s.to });
    assert(msg.includes(line.replace(/\s+/g, ' ').trim()), `the dialog says "${line}"`);
  }
  eq(overlays.top(), 'confirm-dialog', 'on the overlay stack');
  eq(pressBack(), 'closed', 'Back closes it');
  await until(() => !isOpen(confirmDlg()), 'the dialog closes');
  await tick(80);
  eq(await categories(), before, 'nothing moved');
  eq(overlays.ids(), [], 'the stack is empty again');
  eq(appTab(), 'settings', 'still on Settings');
});

test('Tidy up groups: Merge moves the items into the default groups (income untouched), Undo puts them back', async () => {
  await goTab('settings');
  const before = await categories();
  const suggestions = suggestMerges(await storage.getAll(), { nameOf: t, compare: compareNames });
  const to = new Map(suggestions.flatMap((s) => s.from.map((g) => [g, s.to])));
  $('#btn-group-merge').click();
  await until(() => isOpen(confirmDlg()), 'the merge dialog');
  confirmButton(t('groups.merge.confirm')).click();
  await until(() => text($('#toast-text')) === t('groups.merge.done', { count: 4 }), 'the done toast');
  const after = await categories();
  for (const s of SEED) {
    const want = s.type === 'income' ? '' : (to.get(s.category) ?? s.category);
    eq(after[s.id], want, `${s.name}: ${s.category || '(none)'} → ${want || '(none)'}`);
  }
  assert(to.get('Rent') === t('group.preset.housing') && to.get('Streaming') === t('group.preset.entertainment'), 'named in the language in use');
  // Every merged group still draws one colour from the resolver (a default group's fixed slot, or the probe).
  const colours = await resolved();
  for (const g of new Set(to.values())) assert(varName(colours.get(g)), `${g}: a colour`);
  await goTab('settings');
  assert(!$('#toast-action').hidden && text($('#toast-action')) === t('groups.merge.undo'), 'an Undo button');
  $('#toast-action').click();
  await until(async () => JSON.stringify(await categories()) === JSON.stringify(before), 'Undo restores the old groups');
  await until(() => text($('#toast-text')) === t('groups.merge.undone'), 'the undone toast');
});

test('the colour picker: 15 slot colours, the ones other groups show marked, on the overlay stack; Back closes it; a pick saves its slot', async () => {
  const colours = await resolved();
  const dot = $('#subs-list .group-dot[data-group="Pets"]');
  dot.click();
  assert(!$('#swatch-pop').hidden, 'the picker opens');
  eq(overlays.top(), 'swatch-pop', 'on the overlay stack');
  eq($$('#swatch-grid [data-swatch]').map((b) => b.dataset.swatch), WALLET_KEYS, 'the 15 slot colours, in slot order');
  const keyOf = (v) => { const n = varName(v); return n?.startsWith('--wallet-') ? `w${n.slice(9)}` : null; };
  const others = [...colours].filter(([g]) => g !== 'Pets').map(([, v]) => keyOf(v)).filter(Boolean);
  eq($$('#swatch-grid .swatch.is-used').map((b) => b.dataset.swatch).sort(), [...new Set(others)].sort(), 'the colours other groups show are marked');
  eq(pressBack(), 'closed', 'Back closes it');
  assert($('#swatch-pop').hidden, 'closed');
  eq(dot.getAttribute('aria-expanded'), 'false', 'the same clean-up as Escape');
  eq(overlays.ids(), [], 'the stack is empty again');
  dot.click();
  const mine = keyOf(colours.get('Pets'));
  const pick = WALLET_KEYS.find((k) => !others.includes(k) && k !== mine);
  $(`#swatch-grid [data-swatch="${pick}"]`).click();
  const slot = WALLET_KEYS.indexOf(pick);
  await until(async () => (await storage.getSettings()).groupColors.Pets === pick, 'saved as a pick');
  eq((await storage.getSettings()).groupSlots.Pets, slot, 'with its slot');
  eq((await storage.getSettingsRecord()).fields[storage.colorField('Pets')], { name: 'Pets', swatch: pick, slot }, 'in the record: a pick, not automatic');
  eq((await resolved()).get('Pets'), `var(--wallet-${slot + 1})`, 'drawn in the picked colour');
});

test('one colour per group everywhere: Grid dot, Wallet card, the income gauge, Insights donut and legend, the year chart, Calendar', async () => {
  const colours = await resolved();
  const expected = new Set(colours.values());
  // The Wallet: each card's fill is its group's colour; Income has no card.
  await view('wallet');
  await wSettled();
  assert(!wCard(t('group.income')) && !wCard('Salary'), 'no Income card in the stack');
  for (const [g, v] of colours) eq(wCard(g)?.style.getPropertyValue('--card').toLowerCase(), cssToken(varName(v)), `Wallet: ${g}`);
  // The income gauge: the front card's colour (with Reduce motion there is no front card: all the outgoings, the accent).
  const front = wallet().state().front;
  const gauge = front && !reduced() ? colours.get(front.slice(2)) : 'var(--accent)';
  await until(() => $('#income-seg').style.getPropertyValue('--gauge-fill').trim() === gauge, `the gauge is ${gauge}`);
  // Insights, Month, the flat donut in its pinned card and the legend under it.
  await goTab('insights');
  const month = $('#insights-actions [data-insights-mode="month"]');
  if (month.getAttribute('aria-pressed') !== 'true') { month.click(); await tick(80); }
  const donut = $('#insights [data-catview="donut"]');
  if (donut.getAttribute('aria-pressed') !== 'true') { donut.click(); await tick(80); }
  assert($('#insights .ins-pinned .donut'), 'the donut in the pinned card');
  const rows = $$('#insights .ins-legend .legend-row');
  eq(rows.length, colours.size, 'a legend row per group, none pooled');
  for (const r of rows) {
    const g = r.dataset.slice.replace(/^cat:/, '');
    eq($('.legend-dot', r).style.getPropertyValue('--swatch').trim(), colours.get(g), `legend: ${g}`);
  }
  const slices = $$('#insights .ins-pinned .donut [style*="--swatch"]').map((s) => s.style.getPropertyValue('--swatch').trim());
  eq([...new Set(slices)].sort(), [...expected].sort(), 'the donut\'s slices: the same colours');
  // The year chart, by category: every category bar is one of the groups' colours.
  $('#insights-actions [data-insights-mode="year"]').click();
  await tick(120);
  const byCat = $('#insights [data-year-stack="category"]');
  if (byCat.getAttribute('aria-pressed') !== 'true') { byCat.click(); await tick(120); }
  const fills = $$('#insights svg rect').map((r) => r.style.fill || r.style.getPropertyValue('fill')).map((v) => v.trim()).filter((v) => /--(wallet|group)-/.test(v));
  assert(fills.length >= colours.size, `the year chart draws category bars (${fills.length})`);
  for (const v of fills) assert(expected.has(v) || v === 'var(--group-other)', `year chart: ${v} is a group's colour`);
  for (const v of expected) assert(fills.includes(v), `year chart: ${v} is drawn`);
  month.click();
  await tick(80);
  // Calendar: an expense's dot is its group's colour, income's the money-in colour.
  await goTab('calendar');
  await until(() => $('#calendar .cal-day[data-day="21"]'), 'the month grid');
  const dotsOn = (d) => $$(`#calendar .cal-day[data-day="${d}"] .cal-dot`).map((e) => e.style.getPropertyValue('--dot-colour').trim());
  eq(dotsOn(21), [colours.get('Pets')], 'the 21st: the vet, in Pets\' colour');
  eq(dotsOn(3), [colours.get('Rent')], 'the 3rd: the flat, in Rent\'s colour');
  eq(dotsOn(25), ['var(--positive)'], 'the 25th: the salary, in the money-in colour');
  for (const v of $$('#calendar .cal-dot').map((e) => e.style.getPropertyValue('--dot-colour').trim())) {
    assert(expected.has(v) || v === 'var(--positive)', `Calendar: ${v} is a group's colour or income's`);
  }
});

test('add sheet: the default groups are the suggestions for Group, under More details, in the language in use; a known name fills it', async () => {
  await goTab('subs');
  $('#fab').click();
  await until(() => isOpen(sheet()), 'the add sheet opens');
  assert($('#more-details').hidden, 'More details is folded when adding');
  assert($('#more-details').contains(f().category), 'Group is under More details');
  // 1.25.0: a drop-down. Uncategorised, the default groups in table order, the household's others
  // A–Z, then New group… (tests/category-select.html covers it in depth).
  eq(f().category.tagName, 'SELECT', 'Group is a drop-down');
  const options = $$('option', f().category).map((o) => o.value);
  eq(options[0], '', 'Uncategorised first');
  eq(options.slice(1, 1 + DEFAULT_GROUPS.length), DEFAULT_GROUPS.map((g) => t(g.key)), 'then the default groups, in the language in use');
  const defaults = new Set(DEFAULT_GROUPS.map((g) => t(g.key).toLowerCase()));
  const own = (await expenseGroups()).filter((g) => g && !defaults.has(g.trim().toLowerCase())).sort(compareNames);
  eq(options.slice(1 + DEFAULT_GROUPS.length, -1), own, 'then the household\'s own groups, A–Z');
  eq(options.length, new Set(options).size, 'no name twice');
  f().name.value = 'Netflix';
  f().name.dispatchEvent(new Event('input', { bubbles: true }));
  eq(f().category.value, t('group.preset.entertainment'), 'a known service fills Group');
  await tick(30);
  assert(!$('#more-details').hidden && f().category.getClientRects().length > 0, 'More details opens by itself; Group shows what was filled');
  for (const d of $$('dialog[open]')) d.close();
  await tick(60);
  eq(overlays.ids(), [], 'closed');
});

test('add sheet: income saves no group, even after a group was typed as an expense', async () => {
  await goTab('subs');
  $('#fab').click();
  await until(() => isOpen(sheet()), 'the add sheet opens');
  $('#more-toggle').click();
  await tick(30);
  const set = (name, v) => { f()[name].value = v; f()[name].dispatchEvent(new Event('input', { bubbles: true })); };
  set('name', 'Bonus');
  set('category', t('group.preset.shopping'));
  $('#field-kind input[value="income"]').click();
  await tick(60);
  assert(f().category.getClientRects().length === 0, 'Group is hidden for income');
  set('price', '800');
  set('nextRenewal', '2026-11-28');
  const before = (await storage.getAll()).length;
  $('#sub-form button[type="submit"]').click();
  await until(() => !isOpen(sheet()), 'saved');
  await until(async () => (await storage.getAll()).length === before + 1, 'the new item');
  const item = (await storage.getAll()).find((s) => s.name === 'Bonus');
  eq([item.type, item.category], ['income', ''], 'income, with no group');
  await storage.remove(item.id);
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'wallet');
  storage.setPref('groupSort', 'az');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', params.get('theme') === 'dark' ? 'dark' : 'light');
  storage.setPref('insightsMode', 'month');
  storage.setPref('catView', 'donut');
  storage.setPref('yearRange', 'year');
  storage.setPref('yearStack', 'category');
  localStorage.removeItem('substracker.yearKey');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  const lang = params.get('lang') || 'en';
  if (lang === 'zh-TW') storage.setPref('lang', 'zh-TW'); else localStorage.removeItem('substracker.lang');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => wallet() || $('#subs-list .group-dot'), 'the Money tab drawn', 8000);
  await tick(300);
  if (HOLD) { window.testResults = { total: 0, passed: 0, failures: [], hold: true }; return; }

  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; } catch (err) { failures.push({ name, error: err.message }); }
    for (const d of $$('dialog[open]')) d.close();
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
  window.testResults = { total: results.length, passed, failures };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-groups-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
