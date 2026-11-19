// In-browser tests for the app's navigation since 1.20.0 (js/app.js, js/tab-pill.js, js/overlays.js):
// the four tabs (Money | Calendar | Insights | Settings), Money's View menu (the view and Sort), the
// one + button and the add sheet's Expense | Income switch. Run by tests/nav.html with a fixed clock
// (18 November 2026) against a throwaway database, with index.html's markup. Run the page at 320,
// 360 and 393px (the layout tests check the width they're given), with and without reduced motion
// emulated. The tests run in order, as one session in the app; the first one checks what the app
// did with the saved preferences it started with.

import * as storage from '../js/storage.js';
import { overlays, pressBack } from '../js/overlays.js';

const results = [];
const dbName = `substracker-test-nav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed', 'weekStart'];
const savedPrefs = Object.fromEntries(PREFS.map((p) => [p, storage.getPref(p)]));

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
  for (let t = 0; t < ms; t += 25) { if (cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// "Today" is Wednesday 18 November 2026: Streaming today and Phone on the 20th (the due-soon banner
// has them), Salary on the 25th, Rent on the 1st.
const SEED = [
  { ...base, type: 'income', id: 'n-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, id: 'n-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 'n-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 'n-stream', name: 'Streaming', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
];

const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(60); };
const dialog = () => $('#sub-dialog');
const isOpen = () => dialog().open || dialog().hasAttribute('open');
const f = () => $('#sub-form').elements;
const cal = () => $('#calendar')?.calendar;
const day = (d) => $(`#calendar .cal-day[data-day="${d}"]`);
const shown = (el) => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0;
const reduced = () => document.documentElement.classList.contains('reduce-motion');
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };

// The pill behind the active tab (as in tests/app.test.js).
const pillEl = () => $('.tabbar .tab-pill');
const pillRest = () => parseFloat(getComputedStyle(pillEl()).getPropertyValue('--tab-pill-w'));
const pillWidth = () => pillEl().getBoundingClientRect().width;
function pillOn(tab) {
  const p = pillEl().getBoundingClientRect();
  const t = $(`.tab[data-tab="${tab}"]`).getBoundingClientRect();
  return Math.abs(p.width - Math.min(pillRest(), t.width)) < 0.6
    && Math.abs((p.left + p.right) / 2 - (t.left + t.right) / 2) < 0.6
    && p.top >= t.top - 0.5 && p.bottom <= t.bottom + 0.5;
}
async function pillWidths(ms) {
  const out = [];
  const end = performance.now() + ms;
  while (performance.now() < end) { out.push(pillWidth()); await new Promise((r) => requestAnimationFrame(r)); }
  return out;
}

/* ---------------------------------------------------------------- tests */

test('(a) a saved Calendar view (1.19.0) opens as the Wallet, on the Money tab; nothing else changes', async () => {
  // run() saved view = 'calendar' and tab = 'subs' before the app started, as a 1.19.0 device that
  // used the Calendar view would have them.
  eq(appTab(), 'subs', 'the Money tab');
  assert($('#subs-list #wallet .w-band'), 'the Wallet is shown');
  eq($('#view-btn').dataset.view, 'wallet', 'the View button says Wallet');
  eq($$('#view-menu [data-view][aria-checked="true"]').map((b) => b.dataset.view), ['wallet'], 'and its menu');
  assert(!$('#subs-list .cal-grid'), 'no calendar on the Money tab');
  eq($('#view-btn').getAttribute('aria-label'), 'View: Wallet. Sort: A to Z', 'labelled with the view and order in use');
  // The old preference is left as it was until a view is picked: reading it again gives the Wallet.
  eq(storage.getPref('view'), 'calendar', 'the stored value isn\'t rewritten just by starting');
  $('#view-btn').click();
  $('#view-menu [data-view="grid"]').click();
  await tick(40);
  eq(storage.getPref('view'), 'grid', 'picking a view saves it');
  $('#view-btn').click();
  $('#view-menu [data-view="wallet"]').click();
  await tick(40);
  eq(storage.getPref('view'), 'wallet', 'and back to the Wallet');
});

test('(b) the + is on Money and Calendar only; it is one button, above the tab bar, on screen', async () => {
  const fab = $('#fab-stack');
  eq($$('#fab-stack button').map((b) => [b.id, b.getAttribute('aria-label')]), [['fab', 'Add expense or income']], 'one button, labelled');
  const seen = {};
  for (const tab of ['subs', 'calendar', 'insights', 'settings']) {
    await goTab(tab);
    seen[tab] = shown($('#fab'));
    if (!seen[tab]) { assert(fab.hidden, `${tab}: hidden, not just covered`); continue; }
    const r = $('#fab').getBoundingClientRect();
    const bar = $('.tabbar').getBoundingClientRect();
    assert(r.bottom <= bar.top && r.right <= innerWidth && r.left >= 0, `${tab}: above the tab bar and on screen (${Math.round(r.left)}–${Math.round(r.right)}, to ${Math.round(r.bottom)} < ${Math.round(bar.top)})`);
  }
  eq(seen, { subs: true, calendar: true, insights: false, settings: false }, 'shown on Money and Calendar only');
  // Back on Money after Insights: there again.
  await goTab('insights');
  pressBack();
  await tick(60);
  eq(appTab(), 'subs', 'Back from Insights: Money');
  assert(shown($('#fab')), 'and the + is back');
});

test('(b) the + never hides the end of the Calendar or of Grid and List', async () => {
  await goTab('calendar');
  day(20).click();
  await tick(30);
  scrollTo(0, document.documentElement.scrollHeight);
  await tick(60);
  const fabTop = $('#fab').getBoundingClientRect().top;
  const last = $('#calendar .cal-list').getBoundingClientRect();
  assert(last.bottom <= fabTop + 1, `Calendar: the day's list ends (${Math.round(last.bottom)}) above the + (${Math.round(fabTop)})`);
  scrollTo(0, 0);
  for (const v of ['grid', 'list']) {
    await goTab('subs');
    $('#view-btn').click();
    $(`#view-menu [data-view="${v}"]`).click();
    await tick(60);
    scrollTo(0, document.documentElement.scrollHeight);
    await tick(60);
    const end = $('#subs-list').getBoundingClientRect().bottom;
    const top = $('#fab').getBoundingClientRect().top;
    assert(end <= top + 1, `${v}: the last group ends (${Math.round(end)}) above the + (${Math.round(top)})`);
    scrollTo(0, 0);
  }
  $('#view-btn').click();
  $('#view-menu [data-view="wallet"]').click();
  await tick(60);
  await goTab('calendar');
});

test('(c) on Calendar the + fills in the selected day, whichever cycle; no day selected, no date', async () => {
  await goTab('calendar');
  day(22).click();
  await tick(30);
  eq(cal().state.selected, 22, 'the 22nd selected');
  $('#fab').click();
  await until(isOpen, 'the add sheet');
  eq([f().kind.value, f().nextRenewal.value, f().date.value], ['expense', '2026-11-22', '2026-11-22'], 'an expense, on the 22nd');
  eq(text($('#sub-dialog-title')), 'New expense', 'the add sheet');
  f().cycle.value = 'once';
  f().cycle.forEach((r) => { if (r.checked) r.dispatchEvent(new Event('change', { bubbles: true })); });
  eq([$('#field-date').hidden, f().date.value], [false, '2026-11-22'], 'a one-off keeps the day');
  f().cycle.value = 'monthly';
  f().cycle.forEach((r) => { if (r.checked) r.dispatchEvent(new Event('change', { bubbles: true })); });
  f().name.value = 'Haircut';
  f().name.dispatchEvent(new Event('input', { bubbles: true }));
  f().price.value = '600';
  $('#sub-form button[type="submit"]').click();
  await until(() => !isOpen(), 'saved');
  await tick(60);
  const saved = (await storage.getAll()).find((s) => s.name === 'Haircut');
  eq([saved?.type, saved?.cycle, saved?.nextRenewal], ['expense', 'monthly', '2026-11-22'], 'saved on the 22nd');
  assert(day(22).getAttribute('aria-label').includes('1 payment, NT$600'), `the 22nd now has it (${day(22).getAttribute('aria-label')})`);
  // Another month, nothing selected: no date is filled in, and the usual rule asks for one.
  $('#calendar [data-cal-step="1"]').click();
  await tick(30);
  eq(cal().state.selected, null, 'December: no day selected');
  $('#fab').click();
  await until(isOpen, 'the add sheet');
  eq(f().nextRenewal.value, '', 'no date filled in');
  f().name.value = 'Nothing';
  f().price.value = '1';
  $('#sub-form button[type="submit"]').click();
  await tick(50);
  assert(isOpen(), 'not saved without a date');
  eq(text($('[data-error-for="nextRenewal"]')), 'Pick a renewal date.', 'the usual message');
  $('#sub-dialog [data-close]').click();
  await until(() => !isOpen(), 'closed');
  $('#calendar [data-cal-today]').click();
  await tick(30);
  // The Money tab's + fills in nothing, as before.
  await goTab('subs');
  $('#fab').click();
  await until(isOpen, 'the add sheet from Money');
  eq([f().nextRenewal.value, f().kind.value], ['', 'expense'], 'Money: no date, an expense');
  $('#sub-dialog [data-close]').click();
  await until(() => !isOpen(), 'closed');
});

test('(d) the Expense | Income switch: shown when adding, Expense first, fields kept; never when editing', async () => {
  await goTab('calendar');
  day(25).click();
  await tick(30);
  $('#fab').click();
  await until(isOpen, 'the add sheet');
  assert(shown($('#field-kind')), 'the switch is shown');
  eq($('#field-kind').getBoundingClientRect().top < f().name.getBoundingClientRect().top, true, 'at the top, above the name');
  eq(f().kind.value, 'expense', 'Expense by default');
  const set = (k, v) => { f()[k].value = v; f()[k].dispatchEvent(new Event('input', { bubbles: true })); };
  set('name', 'Market stall');
  set('domain', 'stall.example');
  set('plan', 'Weekend');
  set('price', '1234');
  set('category', 'Hobbies');
  set('notes', 'Saturdays');
  const pick = (v) => { const r = $(`#sub-form input[name="kind"][value="${v}"]`); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); };
  pick('income');
  eq(text($('#sub-dialog-title')), 'New income', 'switched to income');
  eq([f().name.value, f().price.value, f().notes.value, f().nextRenewal.value], ['Market stall', '1234', 'Saturdays', '2026-11-25'], 'the name, amount, notes and the calendar\'s day are kept');
  assert($$('[data-expense-only]', dialog()).every((el) => el.hidden), 'the expense-only fields are hidden for income');
  pick('expense');
  eq(text($('#sub-dialog-title')), 'New expense', 'and back');
  eq([f().domain.value, f().plan.value, f().category.value], ['stall.example', 'Weekend', 'Hobbies'], 'the expense fields typed before are still there');
  pick('income');
  $('#sub-form button[type="submit"]').click();
  await until(() => !isOpen(), 'saved as income');
  const s = (await storage.getAll()).find((x) => x.name === 'Market stall');
  eq([s?.type, s?.price, s?.nextRenewal, s?.domain, s?.category], ['income', 1234, '2026-11-25', '', ''], 'saved as income, without the expense fields');
  // Editing: no switch, the item keeps its type.
  for (const [id, title] of [['n-phone', 'Edit expense'], ['n-salary', 'Edit income']]) {
    await goTab('subs');
    $('#view-btn').click();
    $('#view-menu [data-view="list"]').click();
    await tick(40);
    $(`#subs-list .sub-row[data-id="${id}"]`).click();
    await until(isOpen, `the edit sheet for ${id}`);
    eq(text($('#sub-dialog-title')), title, `${id}: the edit sheet`);
    assert(!shown($('#field-kind')), `${id}: no Expense | Income switch`);
    pressBack();
    await until(() => !isOpen(), 'closed');
  }
  // Adding again after an edit: the switch is back, on Expense.
  $('#fab').click();
  await until(isOpen, 'the add sheet again');
  eq([shown($('#field-kind')), f().kind.value], [true, 'expense'], 'the switch is back, on Expense');
  pressBack();
  await until(() => !isOpen(), 'closed');
  $('#view-btn').click();
  $('#view-menu [data-view="wallet"]').click();
  await tick(40);
});

test('(e) the View menu: on the overlay stack; Back and Escape close it, focus back on the button; a pick closes it', async () => {
  await goTab('subs');
  const btn = $('#view-btn');
  const menu = $('#view-menu');
  eq([btn.getAttribute('aria-haspopup'), btn.getAttribute('aria-controls'), btn.getAttribute('aria-expanded')], ['menu', 'view-menu', 'false'], 'a menu button, closed');
  eq($$('#subs-actions button').length, 1, 'one button in Money\'s header');
  assert(!$('#sort-btn') && !$('.seg-btn[data-view="calendar"]'), 'no separate Sort button, no four-way toggle');
  btn.click();
  assert(!menu.hidden, 'opens');
  eq(overlays.top(), 'view-menu', 'on the overlay stack');
  const m = menu.getBoundingClientRect();
  assert(m.left >= 0 && m.right <= innerWidth && m.bottom <= innerHeight, `on screen (${Math.round(m.left)}–${Math.round(m.right)}, to ${Math.round(m.bottom)})`);
  eq(document.activeElement, $('#view-menu [data-view="wallet"]'), 'focus on the view in use');
  eq(pressBack(), 'closed', 'Android Back closes it');
  assert(menu.hidden, 'closed');
  eq([btn.getAttribute('aria-expanded'), document.activeElement], ['false', btn], 'focus back on the button');
  eq([appTab(), overlays.ids()], ['subs', []], 'still on Money, nothing left on the stack');
  btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert(!menu.hidden, 'ArrowDown on the button opens it');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  eq(document.activeElement, $('#view-menu [data-view="grid"]'), 'arrow keys move through it');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  eq([menu.hidden, document.activeElement, overlays.top()], [true, btn, null], 'Escape closes it, focus back, off the stack');
  btn.click();
  $('#view-menu [data-sort="total"]').click();
  await tick(30);
  eq([menu.hidden, document.activeElement, overlays.top()], [true, btn, null], 'a pick closes it too');
  eq([btn.dataset.view, btn.dataset.sort, btn.getAttribute('aria-label')], ['wallet', 'total', 'View: Wallet. Sort: Total, high to low'], 'the button shows the new order');
  const accent = getComputedStyle($('.tab[aria-selected="true"]')).color;
  eq(getComputedStyle(btn).color, accent, 'in the accent colour (not A to Z)');
  btn.click();
  $('#view-menu [data-sort="az"]').click();
  await tick(30);
  assert(getComputedStyle(btn).color !== accent, 'A to Z: the usual colour again');
  // The View button and its menu fit the page at this width.
  const b = btn.getBoundingClientRect();
  assert(b.right <= innerWidth && b.width >= 40, `the button is on screen and at least 40px wide (${Math.round(b.width)})`);
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'no sideways scroll');
});

test('(e) the View menu over the Calendar tab: switching tabs closes it, so Back never acts on it out of sight', async () => {
  await goTab('subs');
  $('#view-btn').click();
  assert(!$('#view-menu').hidden, 'open');
  // A tap on the Calendar tab is a pointerdown outside the menu.
  $('#tab-calendar').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  $('#tab-calendar').click();
  await tick(40);
  assert($('#view-menu').hidden, 'closed by the tap');
  eq(overlays.ids(), [], 'off the stack');
  eq(pressBack(), 'root', 'Back from Calendar goes to Money');
  eq(appTab(), 'subs', 'on Money');
});

test('(f) Back from Calendar goes to Money and the pill slides with it; an open sheet closes first', async () => {
  await goTab('calendar');
  await until(() => pillOn('calendar'), 'the pill on Calendar', 2000);
  $('#fab').click();
  await until(isOpen, 'the add sheet');
  eq(pressBack(), 'closed', 'Back: the sheet first');
  await tick(30);
  eq(appTab(), 'calendar', 'still on Calendar');
  const rest = pillWidth();
  eq(pressBack(), 'root', 'Back again: to Money');
  eq([appTab(), text($('#page-title'))], ['subs', 'Money'], 'on Money');
  if (reduced()) {
    // Straight there: no stretch, no spring (the reduce-motion rule leaves a 0.01ms step).
    const widths = await pillWidths(120);
    assert(widths.every((w) => Math.abs(w - rest) < 0.6), 'with Reduce motion and effects it never stretches');
    await until(() => pillOn('subs'), 'and is on Money', 200);
  } else {
    const widths = await pillWidths(200);
    assert(Math.max(...widths) > rest * 1.1, `it slides with the stretch (max ${Math.round(Math.max(...widths))} px, rest ${Math.round(rest)} px)`);
    await until(() => pillOn('subs'), 'settled on Money', 2000);
  }
  eq(pressBack(), 'minimize', 'and from Money, Back leaves the app');
});

test('four tabs at this width: roles and roving tabindex, labels that fit, the pill on each, through a resize and an inset', async () => {
  eq($$('.tabbar [role="tab"]').map((t) => [t.id, t.getAttribute('aria-controls'), text(t)]),
    [['tab-subs', 'panel-subs', 'Money'], ['tab-calendar', 'panel-calendar', 'Calendar'], ['tab-insights', 'panel-insights', 'Insights'], ['tab-settings', 'panel-settings', 'Settings']], 'four tabs, each with its panel');
  for (const tab of ['subs', 'calendar', 'insights', 'settings']) {
    await goTab(tab);
    await until(() => pillOn(tab), `the pill on ${tab}`, 2000);
    eq($$('.tab').map((t) => t.tabIndex), ['subs', 'calendar', 'insights', 'settings'].map((x) => (x === tab ? 0 : -1)), `${tab}: one tab stop`);
    eq($$('.tab-panel').filter((p) => !p.hidden).map((p) => p.id), [`panel-${tab}`], `${tab}: its panel only`);
  }
  for (const t of $$('.tab')) {
    const r = t.getBoundingClientRect();
    assert(r.width >= 44 && r.left >= 0 && r.right <= innerWidth, `${t.id}: at least 44px wide and on screen (${Math.round(r.width)}px)`);
    const label = $('span', t);
    assert(label.scrollWidth <= label.clientWidth + 1 || label.getBoundingClientRect().width <= r.width, `${t.id}: its label fits`);
  }
  await goTab('calendar');
  const bar = $('.tabbar');
  bar.style.paddingLeft = '44px'; // a landscape safe-area inset
  bar.style.paddingRight = '44px';
  try {
    await tick(60); // a frame for the new padding (Reduce motion's 0.01ms step included)
    await until(() => pillOn('calendar'), 'the pill follows the insets', 2000);
    for (const t of $$('.tab')) assert(t.getBoundingClientRect().left >= 44 - 0.5, `${t.id}: clear of the inset`);
  } finally {
    bar.style.paddingLeft = '';
    bar.style.paddingRight = '';
  }
  await until(() => pillOn('calendar'), 'and back', 2000);
  await goTab('subs');
});

test('the due-soon banner is on Money only', async () => {
  await goTab('subs');
  assert(shown($('#due-banner')), 'shown on Money');
  eq(text($('#due-text')), '3 due in the next 7 days', 'as before: Streaming, Phone and the Haircut added on the 22nd');
  await goTab('calendar');
  assert(!shown($('#due-banner')), 'not on Calendar');
  assert(!$('#panel-calendar #due-banner') && !$('#panel-calendar #money-summary'), 'and not in its page');
  await goTab('subs');
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  // As a 1.19.0 device that last used the Calendar view on the Money tab.
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'calendar');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  for (const p of ['groupSort', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed', 'weekStart']) localStorage.removeItem(`substracker.${p}`);

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#wallet .w-band'), 'app drawn');
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
      if (name?.startsWith('substracker-test-nav-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
