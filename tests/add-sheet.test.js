// In-browser tests for 1.21.1 (js/app.js, js/wallet.js, css/app.css; Category a drop-down since
// 1.25.0, tested in depth by tests/category-select.html): the add and edit sheet (the
// tinted Expense | Income switch, required fields first and the rest under More details, income
// mode, the required date, focus on opening, Android Back), the income gauge with Reduce motion and
// effects when no card is open, and long group names in a Wallet card's header next to a wide total.
// Run by tests/add-sheet.html with a fixed clock (18 November 2026) against a throwaway database,
// with index.html's markup. Run it at 320, 360 and 393px, with and without reduced motion emulated,
// and in English, the pseudo-locale (?lang=xx) and zh-TW (?lang=zh-TW). Expected words come from
// t(), so every language checks the same things. The tests run in order, as one session in the app.

import * as storage from '../js/storage.js';
import { overlays, pressBack } from '../js/overlays.js';
import { t } from '../js/i18n.js';
import { walletGroups, frontGauge, totalGauge, parseColour, contrast, GEOM } from '../js/wallet-math.js';
import { stripSummary } from '../js/insights-calc.js';

const results = [];
const dbName = `substracker-test-sheet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
  for (let t0 = 0; t0 < ms; t0 += 25) { if (cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// Entertainment is US$26.98 a month (Netflix and Spotify) plus two TWD items, so its header has three
// logos and "+1", the widest header there is. Insurance & finance is a long two-word name. The side
// gig is income that holds a domain, an emoji, a plan and a category from before (the form hides them
// for income; saving must keep them). Water has only a note; Phone has nothing optional.
const SEED = [
  { ...base, type: 'income', id: 's-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, type: 'income', id: 's-side', name: 'Side gig', price: 5000, cycle: 'monthly', nextRenewal: '2026-11-30', domain: 'example.org', emoji: '🎸', plan: 'Gold', category: 'Music' },
  { ...base, currency: 'USD', id: 's-netflix', name: 'Netflix', price: 15.49, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Entertainment' },
  { ...base, currency: 'USD', id: 's-spotify', name: 'Spotify', price: 11.49, cycle: 'monthly', nextRenewal: '2026-11-25', category: 'Entertainment' },
  { ...base, id: 's-disney', name: 'Disney', price: 270, cycle: 'monthly', nextRenewal: '2026-11-22', category: 'Entertainment' },
  { ...base, id: 's-concert', name: 'Concert', price: 1500, cycle: 'once', date: '2026-11-28', category: 'Entertainment' },
  { ...base, id: 's-car', name: 'Car insurance', price: 12000, cycle: 'annual', nextRenewal: '2026-11-30', category: 'Insurance & finance' },
  { ...base, currency: 'USD', id: 's-life', name: 'Term life', price: 20, cycle: 'monthly', nextRenewal: '2026-12-02', category: 'Insurance & finance' },
  { ...base, id: 's-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'Home' },
  { ...base, id: 's-water', name: 'Water', price: 300, cycle: 'monthly', nextRenewal: '2026-12-04', category: 'Home', notes: 'Shared with the flat' },
  { ...base, id: 's-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-21', category: 'Home' },
];

const sheet = () => $('#sub-dialog');
const f = () => $('#sub-form').elements;
const closeBtn = () => $('#sub-dialog .sheet-head [data-close]');
const more = () => $('#more-toggle');
const moreBox = () => $('#more-details');
const isOpen = (d) => d.open || d.hasAttribute('open');
const reduced = () => document.documentElement.classList.contains('reduce-motion');
const wallet = () => $('#wallet')?.wallet;
const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(60); };
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };
const view = async (v) => {
  if (appTab() !== 'subs') await goTab('subs');
  $('#view-btn').click();
  $(`#view-menu [data-view="${v}"]`).click();
  await tick(80);
};
/** Whether a field (or its row) is shown: neither it nor a wrapper inside the sheet is hidden. */
const shown = (el) => !!el && el.getClientRects().length > 0;
const fieldOf = (name) => f()[name].closest('.field');
const setValue = (name, v) => { const el = f()[name]; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
/** Pick a type, and let the segments' fade (none with Reduce motion) finish before reading colours. */
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
  const income = (await storage.getAll()).find((s) => s.id === id)?.type === 'income';
  if (income && $('#income-toggle').getAttribute('aria-expanded') !== 'true') { $('#income-toggle').click(); await tick(60); }
  $(`${income ? '#income-list' : '#subs-list'} [data-id="${id}"]`).click();
  await until(() => isOpen(sheet()), 'the edit sheet opens');
  await tick(30);
}
async function save() {
  $('#sub-form button[type="submit"]').click();
  await until(() => !isOpen(sheet()), 'the sheet saves and closes');
  await tick(60);
}
const stored = async (id) => (await storage.getAll()).find((s) => s.id === id);
/** A CSS colour as [r, g, b], resolved in the sheet (color-mix() included). */
function resolve(colour, where = sheet()) {
  const p = document.createElement('span');
  p.style.color = colour;
  where.append(p);
  const out = parseColour(getComputedStyle(p).color);
  p.remove();
  return out;
}
function setTheme(theme) {
  const s = $('#set-theme');
  s.value = theme;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}
function setMotion(on) {
  const c = $('#set-motion');
  if (c.checked === on) return;
  c.checked = on;
  c.dispatchEvent(new Event('change', { bubbles: true }));
}
function setCurrency(code) {
  const s = $('#set-currency');
  s.value = code;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}

/* The add sheet --------------------------------------------------------------------------------- */

test('the Expense | Income switch: the chosen type tinted, its text 4.5:1 on the tint, light and dark; Save stays the accent', async () => {
  try {
    for (const theme of ['light', 'dark']) {
      setTheme(theme);
      await tick(60);
      await openAdd();
      for (const kind of ['expense', 'income']) {
        await pickKind(kind);
        const span = $(`#field-kind input[value="${kind}"] + span`);
        const fg = parseColour(getComputedStyle(span).color);
        const bg = parseColour(getComputedStyle(span).backgroundColor);
        const token = kind === 'income' ? 'positive' : 'negative';
        eq(fg, resolve(`var(--${token}-text)`), `${theme} ${kind}: the text is --${token}-text`);
        eq(bg, resolve(`var(--${token}-tint)`), `${theme} ${kind}: the fill is --${token}-tint`);
        assert(contrast(fg, bg) >= 4.5, `${theme} ${kind}: ${contrast(fg, bg).toFixed(2)}:1 on the tint`);
        eq(text(span), t(`form.kind.${kind}`), `${theme} ${kind}: the label stays words`);
        const other = $(`#field-kind input:not([value="${kind}"]) + span`);
        eq(parseColour(getComputedStyle(other).color), resolve('var(--text-muted)'), `${theme} ${kind}: the other one is plain`);
        // The "?" tile before there's a name takes the same tint.
        const tile = $('#form-logo .logo');
        eq($('#form-logo').dataset.placeholder, kind, `${theme} ${kind}: the "?" tile is a placeholder`);
        eq(parseColour(getComputedStyle(tile).backgroundColor), bg, `${theme} ${kind}: the "?" tile takes the tint`);
        eq(parseColour(getComputedStyle(tile).color), fg, `${theme} ${kind}: and its text colour`);
        const saveBtn = $('#sub-form button[type="submit"]');
        eq(parseColour(getComputedStyle(saveBtn).backgroundColor), resolve('var(--accent)'), `${theme} ${kind}: Save is the accent`);
      }
      await closeSheets();
    }
  } finally {
    setTheme('light');
    await tick(60);
  }
});

test('the "?" tile is a placeholder only: a name, a logo or an emoji tile is unchanged', async () => {
  await openAdd();
  await pickKind('expense');
  setValue('name', 'Lessons');
  await tick(30);
  assert(!('placeholder' in $('#form-logo').dataset), 'a name: no placeholder');
  assert(JSON.stringify(parseColour(getComputedStyle($('#form-logo .logo')).backgroundColor)) !== JSON.stringify(resolve('var(--negative-tint)')), 'and the initial keeps its own colour');
  await closeSheets();
  await openEdit('s-side');
  assert(!('placeholder' in $('#form-logo').dataset), 'an emoji tile: no placeholder');
  assert($('#form-logo .logo-emoji'), 'the income item still shows its emoji');
  await closeSheets();
});

test('required fields first: Name, Price and Currency, the cycle, the date; the rest under More details', async () => {
  await openAdd();
  await pickKind('expense');
  const order = ['name', 'price', 'currency', 'cycle', 'nextRenewal'].map((n) => (n === 'cycle' ? $('#label-cycle') : f()[n]));
  const top = order.map((el) => el.getBoundingClientRect().top);
  assert(top.every((y, i) => i === 0 || y >= top[i - 1] - 1), `in that order down the sheet (${top.map(Math.round).join(', ')})`);
  const togglePos = more().compareDocumentPosition(f().nextRenewal);
  assert(togglePos & Node.DOCUMENT_POSITION_PRECEDING, 'More details comes after the date');
  for (const n of ['domain', 'emoji', 'plan', 'category', 'notes']) assert(moreBox().contains(f()[n]), `${n} is under More details`);
  eq(text(more()), t('form.more'), 'the row says More details');
  eq(more().tagName, 'BUTTON', 'a button');
  eq(more().getAttribute('aria-controls'), 'more-details', 'for the fields it folds');
  await closeSheets();
});

test('More details: folded when adding; a tap opens it; open when editing an item with an optional value', async () => {
  await openAdd();
  eq(more().getAttribute('aria-expanded'), 'false', 'adding: folded');
  assert(!shown(f().notes) && !shown(f().domain), 'its fields are hidden');
  more().click();
  eq(more().getAttribute('aria-expanded'), 'true', 'a tap: open');
  assert(shown(f().notes) && shown(f().domain) && shown(f().category), 'its fields show');
  more().click();
  eq(more().getAttribute('aria-expanded'), 'false', 'a second tap: folded again');
  await closeSheets();
  await openAdd();
  eq(more().getAttribute('aria-expanded'), 'false', 'not saved: the next add starts folded');
  await closeSheets();
  await openEdit('s-water');
  eq(more().getAttribute('aria-expanded'), 'true', 'Water (a note only): open');
  eq(f().notes.value, 'Shared with the flat', 'with its note');
  assert(shown(f().notes), 'shown');
  await closeSheets();
  await openEdit('s-netflix');
  eq(more().getAttribute('aria-expanded'), 'true', 'Netflix (a category): open');
  await closeSheets();
  await openEdit('s-phone');
  eq(more().getAttribute('aria-expanded'), 'true', 'Phone (a category, Home): open');
  await closeSheets();
  await openEdit('s-salary');
  eq(more().getAttribute('aria-expanded'), 'false', 'Salary (nothing optional): folded');
  await closeSheets();
  await openEdit('s-side');
  eq(more().getAttribute('aria-expanded'), 'false', 'Side gig (income: only hidden fields hold values): folded');
  await closeSheets();
});

test('More details opens by itself when a known service fills a field in it while adding; not saved; one Back closes the sheet', async () => {
  await openAdd();
  await pickKind('expense');
  setValue('name', 'Lessons');
  await tick(30);
  eq(more().getAttribute('aria-expanded'), 'false', 'a name that is no known service: still folded');
  const focused = document.activeElement;
  setValue('name', 'Netflix');
  await tick(30);
  eq(more().getAttribute('aria-expanded'), 'true', 'Netflix fills Group (and the domain): open');
  assert(shown(f().category) && shown(f().domain), 'the filled fields show');
  eq(f().category.tagName, 'SELECT', 'Category is a drop-down (1.25.0)');
  eq(f().category.value, t('group.preset.entertainment'), 'with the default group, in the language in use');
  eq(f().category.selectedOptions[0]?.textContent, t('group.preset.entertainment'), 'preselected, under its own name');
  eq(document.activeElement, focused, 'focus stays where it was');
  eq(overlays.ids(), ['sub-dialog'], 'still an inline disclosure, no overlay of its own');
  more().click();
  setValue('name', 'Netflix ');
  await tick(30);
  eq(more().getAttribute('aria-expanded'), 'false', 'folded by hand, it stays folded while the same fill holds');
  more().click();
  pressBack();
  await tick(60);
  assert(!isOpen(sheet()), 'one Back closes the sheet, More details open');
  eq(overlays.ids(), [], 'nothing left open');
  await openAdd();
  eq(more().getAttribute('aria-expanded'), 'false', 'not saved: the next add starts folded');
  await pickKind('income');
  setValue('name', 'Netflix');
  await tick(30);
  eq(more().getAttribute('aria-expanded'), 'false', 'income: no service fill, so folded');
  await closeSheets();
  await openEdit('s-salary');
  setValue('name', 'Spotify');
  await tick(30);
  eq(more().getAttribute('aria-expanded'), 'false', 'editing: as before (it opens for values the item has)');
  await closeSheets();
});

test('typed fields survive the Expense | Income switch; income hides the domain, emoji, plan and category, not Notes', async () => {
  await openAdd();
  await pickKind('expense');
  more().click();
  // Category is a drop-down (1.25.0): a default group, named in the language in use.
  const typed = { name: 'Lessons', price: '120', domain: 'music.example', emoji: '🎹', plan: 'Basic', category: t('group.preset.hobbies'), notes: 'Tuesdays', nextRenewal: '2026-12-01' };
  for (const [k, v] of Object.entries(typed)) setValue(k, v);
  await pickKind('income');
  for (const n of ['domain', 'emoji', 'plan', 'category']) assert(!shown(fieldOf(n)), `income: ${n} hidden`);
  assert(shown(fieldOf('notes')), 'income: Notes still shows');
  assert(moreBox().contains(f().notes), 'under More details');
  for (const [k, v] of Object.entries(typed)) eq(f()[k].value, v, `income: ${k} keeps what was typed`);
  await pickKind('expense');
  for (const n of ['domain', 'emoji', 'plan', 'category', 'notes']) assert(shown(fieldOf(n)), `expense again: ${n} shows`);
  for (const [k, v] of Object.entries(typed)) eq(f()[k].value, v, `expense again: ${k} as typed`);
  await pickKind('income');
  await save();
  const item = (await storage.getAll()).find((s) => s.name === 'Lessons');
  assert(item, 'saved');
  eq([item.type, item.domain, item.emoji, item.plan, item.category, item.notes, item.price], ['income', '', '', '', '', 'Tuesdays', 120], 'a new income item: only what income shows');
});

test('editing an income item never clears the domain, emoji, plan or category it already holds', async () => {
  await openEdit('s-side');
  for (const n of ['domain', 'emoji', 'plan', 'category']) assert(!shown(fieldOf(n)), `${n} hidden for income`);
  setValue('price', '5500');
  await save();
  const item = await stored('s-side');
  eq([item.price, item.domain, item.emoji, item.plan, item.category], [5500, 'example.org', '🎸', 'Gold', 'Music'], 'the new price; everything else kept');
  await openEdit('s-side');
  more().click();
  setValue('notes', 'Weekends');
  await save();
  const again = await stored('s-side');
  eq([again.notes, again.domain, again.emoji, again.plan, again.category], ['Weekends', 'example.org', '🎸', 'Gold', 'Music'], 'a note added; still kept');
});

test('the date says it is required in words; saving without one is refused with its message', async () => {
  await openAdd();
  await pickKind('expense');
  const tag = $('#field-renewal .required');
  assert(shown(tag), 'a visible word by the date');
  eq(text(tag), t('form.required'), 'it says required');
  eq(text($('#label-renewal')), t('form.renewal.expense'), 'the label is still Next renewal');
  eq(f().nextRenewal.getAttribute('aria-required'), 'true', 'and the field says so to screen readers');
  await pickKind('income');
  eq(text($('#label-renewal')), t('form.renewal.income'), 'income: Next payment');
  assert(shown($('#field-renewal .required')), 'still required');
  $('#field-kind input[value="expense"]').click();
  $('#sub-form input[name="cycle"][value="once"]').click();
  await tick(30);
  assert(shown($('#field-date .required')), 'a one-off: Date, required');
  eq(text($('#field-date .field-label > span')), t('form.date'), 'labelled Date');
  $('#sub-form input[name="cycle"][value="monthly"]').click();
  await tick(30);
  setValue('name', 'No date');
  setValue('price', '10');
  setValue('nextRenewal', '');
  $('#sub-form button[type="submit"]').click();
  await tick(60);
  assert(isOpen(sheet()), 'not saved');
  eq(text($('[data-error-for="nextRenewal"]')), t('form.error.renewal.expense'), 'the message');
  await closeSheets();
  assert(!(await storage.getAll()).some((s) => s.name === 'No date'), 'nothing stored');
});

test(`the date and Save show without scrolling (${innerWidth}x${innerHeight})`, async () => {
  for (const kind of ['expense', 'income']) {
    await openAdd();
    await pickKind(kind);
    const body = $('#sub-dialog .sheet-body');
    eq(body.scrollTop, 0, `${kind}: the sheet starts at the top`);
    const date = f().nextRenewal.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const saveBox = $('#sub-form button[type="submit"]').getBoundingClientRect();
    const cancelBox = $('#sub-form .sheet-foot [data-close]').getBoundingClientRect();
    const fits = date.bottom <= bodyBox.bottom + 0.5 && date.top >= bodyBox.top - 0.5 && saveBox.bottom <= innerHeight + 0.5 && cancelBox.bottom <= innerHeight + 0.5;
    // The brief's size is 393x852; a 320x640 screen is shorter than the sheet's required fields.
    if (innerHeight >= 780) assert(fits, `${kind}: date ${Math.round(date.top)}-${Math.round(date.bottom)} in ${Math.round(bodyBox.top)}-${Math.round(bodyBox.bottom)}, Save to ${Math.round(saveBox.bottom)} of ${innerHeight}`);
    else assert(saveBox.bottom <= innerHeight + 0.5, `${kind}: Save and Cancel always show (${Math.round(saveBox.bottom)} of ${innerHeight})`);
    await closeSheets();
  }
});

test('Android Back closes the sheet in one press, More details open or not', async () => {
  for (const open of [false, true]) {
    await openAdd();
    if (open) more().click();
    eq(overlays.top()?.id ?? overlays.ids().at(-1), 'sub-dialog', `${open ? 'open' : 'folded'}: the sheet is the top overlay`);
    eq(overlays.ids().filter((id) => id !== 'sub-dialog').length, 0, 'and More details is no overlay of its own');
    pressBack();
    await tick(60);
    assert(!isOpen(sheet()), `${open ? 'open' : 'folded'}: one Back closes the sheet`);
    assert(!overlays.has('sub-dialog'), 'and it left the stack');
    eq(appTab(), 'subs', 'still on the Money tab');
  }
});

test('focus: adding starts at Name, editing at the sheet; the close button never opens with a ring', async () => {
  await openAdd();
  eq(document.activeElement, f().name, 'adding: Name has focus');
  assert(document.activeElement !== closeBtn() && !closeBtn().matches(':focus-visible'), 'no ring on the close button');
  await closeSheets();
  await openEdit('s-rent');
  eq(document.activeElement, sheet(), 'editing: the sheet itself has focus');
  assert(!closeBtn().matches(':focus-visible'), 'no ring on the close button');
  eq(getComputedStyle(sheet()).outlineStyle, 'none', 'and none round the sheet');
  eq(sheet().tabIndex, -1, 'the sheet is out of the Tab order');
  // Keyboard order is unchanged: the close button is still the first control in the sheet.
  const controls = $$('button, input, select, textarea', sheet()).filter((el) => shown(el) && !el.disabled);
  eq(controls[0], closeBtn(), 'the close button is still first');
  await closeSheets();
});

test('Reduce motion and effects: More details and the tint never animate; nothing has a transition', async () => {
  const was = reduced();
  setMotion(true);
  await tick(60);
  try {
    await openAdd();
    more().click();
    for (const el of [$('.disclosure-chev', more()), $('#field-kind input[value="expense"] + span')]) {
      const d = getComputedStyle(el).transitionDuration.split(',').map((s) => parseFloat(s));
      assert(d.every((s) => s <= 0.0001), `${el.className || el.tagName}: no transition (${getComputedStyle(el).transitionDuration})`);
    }
    await closeSheets();
  } finally {
    if (!was) setMotion(false);
    await tick(60);
  }
});

/* The gauge with no front card ---------------------------------------------------------------- */

async function gaugeExpected() {
  const items = await storage.getAll();
  const groups = walletGroups(items, { currency: 'TWD', period: 'monthly', year: 2026, month: 10 });
  const sum = stripSummary(items.filter((s) => s.currency === 'TWD'), 'monthly', 2026, 10);
  return { groups, income: sum.income };
}
const outgoingsWords = (k) => (k.tiny ? t('income.gauge.outgoingsTiny') : t('income.gauge.outgoings', { pct: k.pct }));

test('Reduce motion, every card closed: the gauge shows all the outgoings in the accent colour; an open card shows its share', async () => {
  const was = reduced();
  await view('wallet');
  setMotion(true);
  await tick(120);
  try {
    await until(() => $('#wallet .w-band'), 'the Wallet');
    const { groups, income } = await gaugeExpected();
    const all = totalGauge(groups, income);
    eq(wallet().front(), null, 'no front card while every card is closed');
    eq(text($('#income-label')), outgoingsWords(all), 'the label: all the outgoings, as in Grid and List');
    eq($('#income-seg').style.getPropertyValue('--gauge-fill'), 'var(--accent)', 'in the accent colour');
    // Open a card: its share. Close it again: back to the outgoings.
    const i = groups.findIndex((g) => g.name === 'Home');
    $$('#wallet .w-band')[i].click();
    await until(() => wallet().state().open === groups[i].key, 'Home opens');
    await tick(60);
    const k = frontGauge(groups[i], income);
    eq(text($('#income-label')), t('income.gauge.share', { group: groups[i].label, pct: k.pct }), 'Home open: its share');
    pressBack();
    await until(() => !wallet().state().open, 'closed');
    await tick(60);
    eq(text($('#income-label')), outgoingsWords(all), 'closed again: the outgoings');
    eq($('#income-seg').style.getPropertyValue('--gauge-fill'), 'var(--accent)', 'in the accent colour');
    // Grid and List show the same words.
    await view('grid');
    eq(text($('#income-label')), outgoingsWords(all), 'Grid: the same words');
    await view('wallet');
  } finally {
    if (!was) setMotion(false);
    await tick(120);
  }
  if (!reduced()) {
    // With motion, the stack has a front card and the gauge follows it, as before.
    await until(() => wallet()?.front(), 'a front card again');
    const { income } = await gaugeExpected();
    const g = wallet().front();
    const k = frontGauge(g, income);
    const words = k.kind === 'foreign' ? t('income.gauge.foreign', { group: g.label })
      : k.tiny ? t('income.gauge.shareTiny', { group: g.label }) : t('income.gauge.share', { group: g.label, pct: k.pct });
    eq(text($('#income-label')), words, `motion: the front card (${g.label}) and its share again`);
  }
});

/* Long group names next to a wide total ------------------------------------------------------- */

test(`long group names at ${innerWidth}px in ${LANG}: the whole total, the name on two lines before it's cut, the card height unchanged`, async () => {
  await view('wallet');
  try {
    for (const code of ['USD', 'TWD']) {
      setCurrency(code);
      await until(() => $('#wallet .w-band'), `the Wallet in ${code}`);
      await tick(120);
      for (const band of $$('#wallet .w-band')) {
        const name = $('.w-name > span', band);
        const total = $('.w-total', band);
        const label = name.textContent;
        assert(total.scrollWidth <= total.clientWidth + 1, `${code} ${label}: the total "${total.textContent}" isn't cut`);
        assert(total.getBoundingClientRect().right <= band.getBoundingClientRect().right + 0.5, `${code} ${label}: the total is inside the card`);
        assert(name.scrollHeight <= name.clientHeight + 1, `${code} ${label}: the name isn't cut (${name.scrollHeight} of ${name.clientHeight}px)`);
        assert(name.scrollWidth <= name.clientWidth + 1, `${code} ${label}: nor runs out sideways`);
        const line = parseFloat(getComputedStyle(name).lineHeight);
        assert(name.clientHeight <= line * 2 + 1, `${code} ${label}: at most two lines`);
        if (label.length <= 6) assert(name.clientHeight <= line + 1, `${code} ${label}: a short name stays on one line`);
        eq(Math.round(band.getBoundingClientRect().height), GEOM.band, `${code} ${label}: the band keeps its height`);
        assert($('.w-meta', band).getBoundingClientRect().bottom <= band.getBoundingClientRect().bottom + 0.5, `${code} ${label}: the item count still fits under it`);
        // The logo chip goes only where the name needs the room: with the chip back, two lines would cut
        // it, or a word wouldn't fit on a line.
        const chip = $('.w-logos', band);
        const needs = () => {
          if (name.scrollHeight > name.clientHeight + 1) return true;
          name.style.overflowWrap = 'normal';
          const wide = name.scrollWidth > name.clientWidth + 1;
          name.style.overflowWrap = '';
          return wide;
        };
        if (band.classList.contains('w-tight')) {
          assert(!shown(chip), `${code} ${label}: no room, so no logo chip`);
          band.classList.remove('w-tight');
          const needed = needs();
          band.classList.add('w-tight');
          assert(needed, `${code} ${label}: the chip went only because the name needed the room`);
        } else {
          assert(shown(chip), `${code} ${label}: the logo chip stays`);
          assert(!needs(), `${code} ${label}: and the name fits beside it, whole words`);
        }
      }
      if (innerWidth >= 393 && LANG === 'en') eq($$('#wallet .w-band.w-tight').length, 0, `${code}: at ${innerWidth}px in English every card keeps its logos`);
      if (code === 'USD') {
        const ent = $$('#wallet .w-band').find((b) => $('.w-name > span', b).textContent === 'Entertainment');
        assert(ent && /26[.,]98/.test(text($('.w-total', ent))), `Entertainment shows its US$26.98 (${ent && text($('.w-total', ent))})`);
      }
    }
  } finally {
    setCurrency('TWD');
    await tick(120);
  }
});

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  storage.setPref('insightsMode', 'month');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  for (const p of ['groupSort', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed']) localStorage.removeItem(`substracker.${p}`);
  // zh-TW is picked as in Settings → Language; ?lang=xx is the pseudo-locale, read by the app itself.
  if (LANG === 'zh-TW') storage.setPref('lang', 'zh-TW'); else localStorage.removeItem('substracker.lang');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#wallet .w-band'), 'app drawn', 8000);
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
  window.testResults = { total: results.length, passed, failures };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-sheet-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
