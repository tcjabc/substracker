// In-browser tests for the Calendar tab (js/calendar.js, js/calendar-math.js, js/app.js; a view on
// the Money tab until 1.20.0), run by tests/calendar.html with a fixed clock (18 November 2026) against a throwaway
// database. The app runs with index.html's markup. Run the page at 320, 360 and 393px (the layout
// tests check the width they're given), with and without reduced motion emulated. The tests run
// in order, as one session in the app.

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';
import { cashDue, incomeDue } from '../js/insights-calc.js';
import { localeWeekStart } from '../js/calendar-math.js';
import { createCalendar } from '../js/calendar.js';
import { pressBack } from '../js/overlays.js';
import { parseColour, contrast } from '../js/wallet-math.js';

const results = [];
const dbName = `substracker-test-cal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
const T = (n) => money(n, 'TWD');
// Dates as the device writes them (en-GB "18 November 2026"): the calendar uses the device's own
// variant of the UI language.
const longDate = (y, m, d) => new Date(y, m, d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const monthName = (y, m) => new Date(y, m, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const weekday = (n) => new Date(2026, 10, 15 + n).toLocaleDateString(undefined, { weekday: 'long' }); // 15 Nov 2026 is a Sunday

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// "Today" is Wednesday 18 November 2026. In November: five small plans on the 5th (A to E, one
// group each), Phone on the 20th, Tool (USD) on the 22nd, Salary (income) on the 25th, Concert (a
// one-off) on the 28th, the 31st-of-the-month plan on the 30th, Streaming today, and Rent on the
// 1st (its stored date is in December: a projection). Cloud is annual, in March. Gym has no date.
const SEED = [
  { ...base, type: 'income', id: 't-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, id: 't-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 't-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 't-stream', name: 'Streaming', emoji: '🎬', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
  { ...base, id: 't-concert', name: 'Concert', price: 1500, cycle: 'once', date: '2026-11-28', category: 'Entertainment' },
  { ...base, id: 't-end', name: 'Month end', price: 250, cycle: 'monthly', nextRenewal: '2026-01-31', category: 'Books' },
  { ...base, id: 't-cloud', name: 'Cloud', price: 1200, cycle: 'annual', nextRenewal: '2027-03-15', category: 'Utilities' },
  { ...base, id: 't-gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
  { ...base, currency: 'USD', id: 't-tool', name: 'Tool', price: 10, cycle: 'monthly', nextRenewal: '2026-11-22', category: 'Utilities' },
  ...['Apps', 'Coffee', 'Games', 'Music', 'News'].map((category, i) => ({
    ...base, id: `t-${'abcde'[i]}`, name: `${'ABCDE'[i]} plan`, price: 10 * (i + 1), cycle: 'monthly', nextRenewal: '2026-11-05', category,
  })),
];
const NOV_DUE = 30000 + 499 + 390 + 1500 + 250 + 150; // 32,789 TWD

const cal = () => $('#calendar');
const api = () => cal().calendar;
const day = (d) => $(`#calendar .cal-day[data-day="${d}"]`);
const heading = () => text($('#cal-month'));
const listRows = () => $$('#calendar .cal-list .due-row');
const subDialog = () => $('#sub-dialog');
const open = (d) => d.open || d.hasAttribute('open');
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(60); };
/** Show a Money view through the View menu, the way a person does, or the Calendar tab. */
const view = async (v) => {
  if (v === 'calendar') { await goTab('calendar'); return; }
  await goTab('subs');
  $('#view-btn').click();
  $(`#view-menu [data-view="${v}"]`).click();
  await tick(60);
};
const comeBack = async () => { document.dispatchEvent(new Event('visibilitychange')); await tick(60); };
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };
const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const setSelect = async (sel, value) => { const s = $(sel); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); await tick(40); };
async function swipe(dx, dy = 0, steps = 6) {
  const el = $('#calendar .cal-weeks');
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const ev = (type, px, py) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, isPrimary: true, pointerType: 'touch', clientX: px, clientY: py, bubbles: true, cancelable: true }));
  ev('pointerdown', x, y);
  for (let i = 1; i <= steps; i++) { ev('pointermove', x + (dx * i) / steps, y + (dy * i) / steps); await tick(16); }
  ev('pointerup', x + dx, y + dy);
  await tick(500);
}
const reduced = () => document.documentElement.classList.contains('reduce-motion');
let before = null; // the other views as they were before the calendar was first shown

/* ---------------------------------------------------------------- tests */

test('Calendar is its own tab: Money | Calendar | Insights | Settings; the tab is saved on this device only', async () => {
  // The Money views first, to compare with after the calendar has been used (the last tests).
  before = {};
  for (const v of ['wallet', 'grid', 'list']) {
    await view(v);
    before[v] = v === 'wallet' ? $$('#wallet .w-band').map((b) => b.getAttribute('aria-label')) : text($('#subs-list'));
  }
  eq($$('.tabbar .tab').map((b) => [b.dataset.tab, text(b)]), [['subs', 'Money'], ['calendar', 'Calendar'], ['insights', 'Insights'], ['settings', 'Settings']], 'four tabs, Calendar second');
  eq($$('#view-menu [data-view]').map((b) => b.dataset.view), ['wallet', 'grid', 'list'], 'Money\'s views: Wallet | Grid | List, no Calendar');
  const tab = $('#tab-calendar');
  eq([tab.getAttribute('role'), tab.getAttribute('aria-controls')], ['tab', 'panel-calendar'], 'a tab for its own panel');
  const opsBefore = await storage.pendingCount();
  await view('calendar');
  assert(cal() && $('#calendar .cal-grid'), 'the calendar is shown');
  assert(cal().closest('#panel-calendar') && !$('#panel-calendar').hidden && $('#panel-subs').hidden, 'on its own page, Money\'s hidden');
  eq([tab.getAttribute('aria-selected'), tab.tabIndex], ['true', 0], 'selected, the tab stop');
  eq($$('.tab[aria-selected="true"]').length, 1, 'only one tab selected');
  eq([text($('#page-title')), document.title], ['Calendar', 'Calendar · Peek Budget'], 'the page and document titles');
  eq(storage.getPref('tab'), 'calendar', 'kept on this device');
  eq(storage.getPref('view'), 'list', 'Money\'s own view is left as it was');
  const backup = JSON.stringify(await storage.exportAll());
  assert(!/"view"|"tab"|calendar|weekStart/i.test(backup), 'not in a backup');
  assert(!Object.keys(await storage.getSettings()).some((k) => /view|tab|week|calendar/i.test(k)), 'not a shared setting');
  eq(await storage.pendingCount(), opsBefore, 'no op for sync');
});

test('the header fits: Calendar\'s title alone, Money\'s title and its View button on one line', async () => {
  const fits = (where) => {
    const title = $('#page-title').getBoundingClientRect();
    const line = parseFloat(getComputedStyle($('#page-title')).lineHeight) || title.height;
    assert(title.height < line * 1.5, `${where}: the title stays on one line (${title.height}px for a ${line}px line)`);
    assert(document.documentElement.scrollWidth <= innerWidth + 1, `${where}: no sideways scroll`);
    return title;
  };
  fits('Calendar');
  assert($('#subs-actions').hidden, 'Calendar: no View button (it has no views or groups)');
  await goTab('subs');
  const title = fits('Money');
  const actions = $('#subs-actions').getBoundingClientRect();
  assert(title.right <= actions.left, `Money: the title (to ${Math.round(title.right)}) is clear of the button (from ${Math.round(actions.left)})`);
  assert(actions.right <= innerWidth, 'Money: the button is on screen');
  eq($$('#subs-actions button').length, 1, 'Money: one button');
  assert($('#view-btn').getBoundingClientRect().width >= 40, 'the View button at least 40px wide');
  await goTab('calendar');
});

test('the Calendar page: the month heading, previous, next and Today, one summary line, the grid; no Money strip, card or banner', async () => {
  for (const sel of ['#money-summary', '#due-banner', '#subs-list', '.wallet']) {
    const el = $(sel);
    assert(!el || !el.getClientRects().length, `${sel} is not on this page`);
  }
  eq(storage.getPref('dueSoon'), null, 'the banner is on (its default), shown on Money only');
  eq($$('#calendar .cal-head > *').map((e) => e.dataset.calStep ?? (e.matches('[data-cal-today]') ? 'today' : e.id)), ['-1', 'cal-month', '1', 'today'], 'previous, the month, next, Today');
  const sum = $('#calendar .cal-summary');
  eq([...sum.children].map((e) => e.className), ['cal-summary-label', 'cal-summary-value'], 'one summary line: its label and figure, nothing under it');
  const head = $('#calendar .cal-head').getBoundingClientRect();
  const s = sum.getBoundingClientRect();
  const g = $('#calendar .cal-grid').getBoundingClientRect();
  assert(head.bottom <= s.top && s.bottom <= g.top, `heading ${Math.round(head.bottom)} ≤ summary ${Math.round(s.top)}–${Math.round(s.bottom)} ≤ grid ${Math.round(g.top)}`);
  const line = parseFloat(getComputedStyle($('.cal-summary-value', sum)).lineHeight) || 24;
  assert(s.height < line * 1.6, `the summary is on one line (${Math.round(s.height)}px for a ${line}px line)`);
});

test('the month summary is the Money strip\'s Outgoings for this month, on the same basis', async () => {
  eq(text($('#calendar .cal-summary-label')), `Cash due in ${monthName(2026, 10)}`, 'labelled with the month');
  const strip = $('#money-summary [data-roll="Outgoings"]');
  await tick(1200); // let any roll finish
  eq(text($('#calendar .cal-summary-value')), text(strip), 'the same figure as the strip');
  eq(text(strip), T(NOV_DUE), 'and the worked total');
  assert(!$('#calendar .cal-summary-sub'), 'no second line: income and other currencies are on their days');
  const items = (await storage.getAll()).filter((s) => s.currency === 'TWD');
  eq(NOV_DUE, cashDue(items, 2026, 10), "Insights' cashDue");
  eq(40000, incomeDue(items, 2026, 10), "Insights' incomeDue");
});

test('ARIA: a grid of rows and gridcells; every day a labelled button; one tab stop; today marked and selected', async () => {
  const grid = $('#calendar [role="grid"]');
  assert(grid, 'a grid');
  eq(grid.getAttribute('aria-labelledby'), 'cal-month', 'named by the month heading');
  eq(text($(`#${grid.getAttribute('aria-describedby')}`)), 'Arrow keys move between days, Page Up and Page Down change the month, Enter shows the day.', 'described');
  const rows = $$('[role="row"]', grid);
  eq(rows.length, 7, 'the weekday row and six weeks (November 2026 from Monday)');
  assert(rows.every((r) => r.children.length === 7), 'seven cells a row');
  eq($$('[role="columnheader"]', grid).map((h) => h.getAttribute('aria-label')), [1, 2, 3, 4, 5, 6, 0].map(weekday), 'weekday heads, from Monday (en-GB)');
  eq($$('[role="gridcell"]', grid).length, 42, 'gridcells');
  const days = $$('.cal-day', grid);
  eq(days.length, 30, 'a button for each day of November');
  eq(days.filter((b) => b.tabIndex === 0).map((b) => b.dataset.day), ['18'], 'one tab stop: today');
  eq(day(18).getAttribute('aria-current'), 'date', 'today is marked');
  eq(day(18).parentElement.getAttribute('aria-selected'), 'true', 'and selected');
  eq($$('[aria-selected="true"]', grid).length, 1, 'one selected');
  eq(day(18).getAttribute('aria-label'), `${longDate(2026, 10, 18)}, today, 1 payment, ${T(390)}`, 'today\'s label');
  eq(day(5).getAttribute('aria-label'), `${longDate(2026, 10, 5)}, 5 payments, ${T(150)}`, 'five payments');
  eq(day(1).getAttribute('aria-label'), `${longDate(2026, 10, 1)}, 1 payment, ${T(30000)}`, 'Rent, a projection from its December date');
  eq(day(22).getAttribute('aria-label'), `${longDate(2026, 10, 22)}, 1 payment, +1 in USD`, 'another currency: counted, no total');
  eq(day(25).getAttribute('aria-label'), `${longDate(2026, 10, 25)}, 1 payment, ${T(40000)} income`, 'income, marked as income');
  eq(day(30).getAttribute('aria-label'), `${longDate(2026, 10, 30)}, 1 payment, ${T(250)}`, 'the 31st plan on the 30th');
  eq(day(19).getAttribute('aria-label'), `${longDate(2026, 10, 19)}, nothing due`, 'an empty day');
  eq($$('[aria-live]', cal()).length, 1, 'one live region');
  eq(text($('[aria-live]', cal())), '', 'silent until the month changes');
  eq($$('.cal-out .cal-num').every((n) => n.getAttribute('aria-hidden') === 'true'), true, 'the other months\' days are hidden from screen readers');
});

test('dots: up to three in the group colours, then +N; income in the income colour; days with items are tinted', async () => {
  await view('grid');
  const swatch = Object.fromEntries($$('.group-dot').map((d) => [d.dataset.group, d.style.getPropertyValue('--swatch').trim()]));
  await view('calendar');
  const dots = (d) => $$('.cal-dot', day(d)).map((e) => e.style.getPropertyValue('--dot-colour').trim());
  eq(dots(20), [swatch.Utilities], 'Phone: Utilities\' colour');
  eq(dots(1), [swatch.House], 'Rent: House\'s colour');
  eq(dots(5), [swatch.Apps, swatch.Coffee, swatch.Games], 'the first three of five, A to Z');
  eq(text($('.cal-more', day(5))), '+2', 'then +2');
  eq(dots(25), ['var(--positive)'], 'income: the income colour (income has no group colour)');
  eq(dots(19), [], 'no dots on an empty day');
  assert(day(20).classList.contains('has-items') && !day(19).classList.contains('has-items'), 'days with items are marked');
  assert(getComputedStyle(day(20)).backgroundColor !== getComputedStyle(day(19)).backgroundColor, 'and tinted, so the dots aren\'t the only cue');
  // A picked colour shows here too.
  await view('grid');
  $('.group-dot[data-group="House"]').click();
  await tick(30);
  $('#swatch-pop [data-swatch="g2"]').click();
  await tick(60);
  await view('calendar');
  eq(dots(1), ['var(--group-2)'], 'House picked Steel blue: Rent\'s dot follows');
});

test('light and dark: a dot too close to its cell gets a ring; day text keeps 4.5:1', async () => {
  const report = [];
  for (const theme of ['light', 'dark']) {
    await setSelect('#set-theme', theme);
    api().update();
    let rings = 0;
    for (const dot of $$('#calendar .cal-dot')) {
      const cell = parseColour(getComputedStyle(dot.closest('.cal-day')).backgroundColor);
      const c = contrast(parseColour(getComputedStyle(dot).backgroundColor), cell);
      const ring = dot.classList.contains('cal-dot-ring');
      assert(ring === c < 3, `${theme}: a dot at ${c.toFixed(2)}:1 ${ring ? 'has' : 'has no'} ring`);
      if (ring) {
        rings++;
        const cs = getComputedStyle(dot);
        assert(cs.outlineStyle === 'solid' && parseFloat(cs.outlineWidth) >= 1, `${theme}: the ring is drawn`);
        assert(contrast(parseColour(cs.outlineColor), cell) >= 3, `${theme}: the ring itself stands out (${contrast(parseColour(cs.outlineColor), cell).toFixed(2)}:1)`);
      }
    }
    report.push(`${theme}: ${rings} ringed`);
    // A cell without its own background shows the grid's card.
    const bgOf = (el) => { const c = getComputedStyle(el).backgroundColor; return /rgba\(.*,\s*0\)$|transparent/.test(c) ? bgOf(el.parentElement) : parseColour(c); };
    for (const b of [day(19), day(20), day(18)]) {
      const num = $('.cal-num', b);
      const bg = bgOf(b.classList.contains('is-today') ? num : b);
      const k = contrast(parseColour(getComputedStyle(num).color), bg);
      assert(k >= 4.5, `${theme}: day ${b.dataset.day}'s number ${k.toFixed(2)}:1`);
    }
    const wd = $('#calendar .cal-wd');
    assert(contrast(parseColour(getComputedStyle(wd).color), parseColour(getComputedStyle($('#calendar .cal-grid')).backgroundColor)) >= 4.5, `${theme}: weekday heads`);
  }
  await setSelect('#set-theme', 'light');
  api().update();
  console.info(`calendar dot rings: ${report.join(', ')}`);
});

test('tap a day: its items under the grid; the total is the default currency only; tap it again to close', async () => {
  const list = () => $('#calendar .cal-list');
  eq(text($('.cal-list-title', list())), new Date(2026, 10, 18).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }), 'today\'s list, by default');
  eq(listRows().map((r) => text($('.sub-name', r))), ['Streaming'], 'Streaming');
  eq(text($('.cal-list-sum', list())), `${T(390)} due`, 'its total');
  eq(list().getAttribute('aria-label'), `Due on ${longDate(2026, 10, 18)}`, 'the list is labelled with the date');
  day(22).click();
  await tick(30);
  eq(day(22).parentElement.getAttribute('aria-selected'), 'true', 'the 22nd selected');
  eq(day(18).parentElement.getAttribute('aria-selected'), 'false', 'today no longer');
  eq(document.activeElement, day(22), 'focus stays on the day');
  eq(listRows().map((r) => [text($('.sub-name', r)), text($('.amount', r)), text($('.cycle', r))]), [['Tool', money(10, 'USD'), 'not in TWD totals']], 'in its own currency, not in the total');
  eq(text($('.cal-list-sum', list())), '+1 in USD', 'counted, never added');
  day(25).click();
  await tick(30);
  eq(listRows().map((r) => [text($('.sub-name', r)), text($('.sub-plan', r)), r.getAttribute('aria-label')]), [['Salary', 'Income', `Salary, income, ${T(40000)}`]], 'income, marked');
  eq(text($('.cal-list-sum', list())), `${T(40000)} income`, 'its own figure');
  day(5).click();
  await tick(30);
  eq(listRows().map((r) => text($('.sub-name', r))), ['A plan', 'B plan', 'C plan', 'D plan', 'E plan'], 'all five, A to Z');
  eq(listRows()[1].getAttribute('aria-label'), `B plan, Coffee, ${T(20)}`, 'name, group, amount');
  eq(text($('.cal-list-sum', list())), `${T(150)} due`, 'the day\'s total');
  day(5).click();
  await tick(30);
  assert(!list(), 'tapping the selected day again closes its list');
  eq($$('#calendar [aria-selected="true"]').length, 0, 'nothing selected');
  day(19).click();
  await tick(30);
  eq(text($('.cal-note', list())), 'Nothing due on this day', 'an empty day says so');
});

test('a row opens the item in the edit sheet; the need-a-date line opens the undated item', async () => {
  day(20).click();
  await tick(30);
  listRows()[0].click();
  await until(() => open(subDialog()), 'the edit sheet');
  eq($('#sub-form').elements.name.value, 'Phone', 'the tapped item');
  pressBack();
  await tick(60);
  assert(!open(subDialog()), 'Back closed it');
  eq(api().state.selected, 20, 'the calendar kept its day');
  const undated = $('#calendar .cal-undated');
  eq(text(undated), '1 item needs a date', 'the same quiet line as the banner');
  undated.click();
  await until(() => open(subDialog()), 'the edit sheet for the undated item');
  eq($('#sub-form').elements.name.value, 'Gym', 'the first undated item');
  pressBack();
  await tick(60);
});

test('months: next, previous and Today; the month heading is announced once, in one live region', async () => {
  const live = () => text($('#calendar [aria-live]'));
  $('#calendar [data-cal-step="1"]').click();
  await tick(40);
  eq(heading(), monthName(2026, 11), 'December');
  eq(live(), monthName(2026, 11), 'announced');
  eq(document.activeElement, $('#calendar [data-cal-step="1"]'), 'focus stays on Next');
  assert(!$('#calendar .cal-list'), 'no day selected in another month');
  const items = (await storage.getAll()).filter((s) => s.currency === 'TWD');
  await tick(1200);
  eq(text($('#calendar .cal-summary-value')), T(cashDue(items, 2026, 11)), "December's cash due");
  eq($$('#calendar .cal-weeks [role="row"]').length, 5, 'December 2026 is five weeks from Monday');
  eq(day(1).getAttribute('aria-label'), `${longDate(2026, 11, 1)}, 1 payment, ${T(30000)}`, 'Rent on its stored date');
  eq(day(31).getAttribute('aria-label'), `${longDate(2026, 11, 31)}, 1 payment, ${T(250)}`, 'the 31st plan on the 31st again');
  for (let i = 0; i < 3; i++) $('#calendar [data-cal-step="1"]').click();
  await tick(40);
  eq(heading(), monthName(2027, 2), 'March 2027');
  eq(day(15).getAttribute('aria-label'), `${longDate(2027, 2, 15)}, 1 payment, ${T(1200)}`, 'the annual plan in its month');
  eq($$('#calendar [aria-live]').length, 1, 'still one live region');
  eq(live(), monthName(2027, 2), 'the latest month only');
  $('#calendar [data-cal-step="-1"]').click();
  await tick(40);
  eq(day(15).getAttribute('aria-label'), `${longDate(2027, 1, 15)}, nothing due`, 'not in February');
  eq(day(28).getAttribute('aria-label'), `${longDate(2027, 1, 28)}, 1 payment, ${T(250)}`, 'the 31st plan on 28 February');
  $('#calendar [data-cal-today]').click();
  await tick(40);
  eq(heading(), monthName(2026, 10), 'Today: back to November');
  eq(api().state.selected, 18, 'with today selected');
  eq(live(), monthName(2026, 10), 'announced');
  eq(document.activeElement, $('#calendar [data-cal-today]'), 'focus stays on Today');
  const announced = live();
  api().update();
  eq(live(), announced, 'a redraw announces nothing new');
});

test('keyboard: arrows by a day and a week, Home and End, Page Up and Page Down; across month ends', async () => {
  day(18).focus();
  const at = () => [heading(), document.activeElement?.dataset?.day];
  key(document.activeElement, 'ArrowRight');
  eq(at(), [monthName(2026, 10), '19'], 'right: the 19th');
  key(document.activeElement, 'ArrowDown');
  eq(at(), [monthName(2026, 10), '26'], 'down: a week on');
  key(document.activeElement, 'Home');
  eq(at(), [monthName(2026, 10), '23'], 'Home: Monday');
  key(document.activeElement, 'End');
  eq(at(), [monthName(2026, 10), '29'], 'End: Sunday');
  eq($$('#calendar .cal-day').filter((b) => b.tabIndex === 0).map((b) => b.dataset.day), ['29'], 'the tab stop moves with focus');
  eq(api().state.selected, 18, 'moving doesn\'t select');
  key(document.activeElement, 'PageDown');
  await tick(20);
  eq(at(), [monthName(2026, 11), '29'], 'Page Down: the 29th of December');
  eq(text($('#calendar [aria-live]')), monthName(2026, 11), 'announced');
  key(document.activeElement, 'PageUp');
  await tick(20);
  eq(at(), [monthName(2026, 10), '29'], 'Page Up: back');
  key(document.activeElement, 'ArrowRight');
  key(document.activeElement, 'ArrowDown');
  await tick(20);
  eq(at(), [monthName(2026, 11), '7'], 'from the 30th, down: 7 December');
  key(document.activeElement, 'ArrowUp');
  await tick(20);
  eq(at(), [monthName(2026, 10), '30'], 'and up again');
  document.activeElement.click(); // Enter or Space on a button
  await tick(20);
  eq(api().state.selected, 30, 'Enter shows the day');
  eq(text($('#calendar .cal-list .sub-name')), 'Month end', 'its list');
  $('#calendar [data-cal-today]').click();
  await tick(30);
});

test('swipe: left for the next month, right for the previous; a short drag stays; an up-and-down drag scrolls', async () => {
  await swipe(-160);
  eq(heading(), monthName(2026, 11), 'left: December');
  await swipe(170);
  eq(heading(), monthName(2026, 10), 'right: November');
  await swipe(-20);
  eq(heading(), monthName(2026, 10), 'a short drag: still November');
  await swipe(14, 120);
  eq(heading(), monthName(2026, 10), 'mostly down: still November');
  eq($('#calendar .cal-weeks').style.transform, '', 'the weeks are back in place');
  eq(api().state.selected, 18, 'today selected again in this month');
});

test('Reduce motion and effects: the months change at once, with no animations and no animation frames', async () => {
  const mine = () => document.getAnimations().filter((a) => cal().contains(a.effect?.target));
  if (!reduced()) {
    // With motion: a swipe slides, and the month's figure rolls (only that figure).
    const el = $('#calendar .cal-weeks');
    const r = el.getBoundingClientRect();
    const ev = (type, px) => el.dispatchEvent(new PointerEvent(type, { pointerId: 9, isPrimary: true, pointerType: 'touch', clientX: px, clientY: r.top + 20, bubbles: true }));
    ev('pointerdown', r.left + 200);
    ev('pointermove', r.left + 180);
    ev('pointermove', r.left + 40);
    ev('pointerup', r.left + 40);
    await tick(20);
    assert(mine().length > 0, 'with motion, the weeks slide');
    await tick(600);
    assert($('#calendar .cal-summary-value .odo-roll') || mine().length, 'and the month\'s figure rolls');
    eq($$('#calendar .cal-grid .odo').length, 0, 'the days never roll');
    await tick(1200);
    $('#calendar [data-cal-today]').click();
    await tick(1200);
    $('#tab-settings').click();
    await tick(20);
    $('#set-motion').click();
    $('#tab-calendar').click();
    await tick(60);
  }
  assert(reduced(), 'Reduce motion and effects is on');
  let frames = 0;
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (fn) => { frames++; return raf.call(window, fn); };
  // Whatever fails, the tests after this one start as they would have: this month, the setting
  // back as it was.
  try {
    $('#calendar [data-cal-step="1"]').click();
    eq(heading(), monthName(2026, 11), 'next: at once, in the same task');
    eq(mine().map((a) => `${a.constructor.name} ${a.transitionProperty ?? ''} ${a.effect.target.className} ${a.effect.getComputedTiming().duration}`), [], 'no animations');
    await swipe(160);
    eq(heading(), monthName(2026, 10), 'swipe: changed at once');
    eq($('#calendar .cal-weeks').style.transform, '', 'the weeks never followed the finger');
    day(20).click();
    $('#calendar [data-cal-step="-1"]').click();
    $('#calendar [data-cal-today]').click();
    await tick(100);
    eq(mine().length, 0, 'still no animations');
    eq(frames, 0, 'no animation frames asked for');
  } finally {
    window.requestAnimationFrame = raf;
    if (heading() !== monthName(2026, 10) || api().state.selected !== 18) $('#calendar [data-cal-today]').click();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && reduced()) {
      $('#tab-settings').click();
      await tick(20);
      $('#set-motion').click();
    }
    $('#tab-calendar').click();
    await tick(60);
  }
});

test('Settings → Week starts on: Automatic (the region\'s day), Monday or Sunday; per device; never in a backup, the settings or the outbox', async () => {
  $('#tab-settings').click();
  await tick(30);
  const select = $('#set-week-start');
  eq(text($('#calendar-settings .group-title')), 'Calendar', 'its own group');
  const auto = localeWeekStart(new Intl.DateTimeFormat().resolvedOptions().locale);
  eq([...select.options].map((o) => [o.value, o.textContent]), [['auto', `Automatic (${weekday(auto)})`], ['mon', weekday(1)], ['sun', weekday(0)]], 'the choices');
  eq(select.value, 'auto', 'Automatic by default');
  const opsBefore = await storage.pendingCount();
  await setSelect('#set-week-start', 'sun');
  eq(storage.getPref('weekStart'), 'sun', 'kept on this device');
  $('#tab-calendar').click();
  await tick(60);
  eq($('#calendar [role="columnheader"]').getAttribute('aria-label'), weekday(0), 'Sunday first');
  eq($$('#calendar .cal-weeks [role="row"]').length, 5, 'November 2026 is five weeks from Sunday');
  eq($('#calendar .cal-weeks .cal-day').dataset.day, '1', 'the 1st, a Sunday, opens the month');
  key(day(18), 'Home');
  eq(document.activeElement.dataset.day, '15', 'Home: Sunday the 15th');
  const backup = JSON.stringify(await storage.exportAll());
  assert(!/weekStart|"sun"/.test(backup), 'not in a backup');
  assert(!Object.keys(await storage.getSettings()).some((k) => /week/i.test(k)), 'not a shared setting');
  eq(await storage.pendingCount(), opsBefore, 'no op for sync');
  $('#tab-settings').click();
  await tick(20);
  await setSelect('#set-week-start', 'mon');
  $('#tab-calendar').click();
  await tick(60);
  eq($('#calendar [role="columnheader"]').getAttribute('aria-label'), weekday(1), 'Monday first');
  $('#tab-settings').click();
  await tick(20);
  await setSelect('#set-week-start', 'auto');
  eq(storage.getPref('weekStart'), 'auto', 'Automatic again');
  $('#tab-calendar').click();
  await tick(60);
  eq($('#calendar [role="columnheader"]').getAttribute('aria-label'), weekday(auto), 'the region\'s day first');
});

test('an empty month: the grid is still there, with a quiet "Nothing due in …" line', async () => {
  const host = document.createElement('div');
  $('#app-host').append(host);
  try {
    const one = { ...base, id: 'x', name: 'Only', price: 5, cycle: 'once', date: '2026-11-28' };
    const c = createCalendar(host, {
      items: () => [one], currency: () => 'TWD', weekStart: () => 1, reduced: () => true,
      dotColour: () => 'var(--group-1)', logo: () => '', onEdit: () => {},
    });
    eq(text($('.cal-empty', host)), '', 'November has the one-off');
    c.show(2026, 11);
    eq($$('.cal-day', host).length, 31, 'December\'s grid, every day');
    eq(text($('.cal-empty', host)), `Nothing due in ${monthName(2026, 11)}`, 'the quiet line');
    eq(text($('.cal-summary-value', host)), T(0), 'and a zero, labelled');
    eq($$('.cal-dot', host).length, 0, 'no dots');
    c.destroy();
  } finally {
    host.remove();
  }
});

test(`fits this ${innerWidth}px screen: a six-week month, weekday names, the heading; nothing runs out or scrolls sideways`, async () => {
  eq(heading(), monthName(2026, 10), 'November 2026: six weeks from Monday');
  eq($$('#calendar .cal-weeks [role="row"]').length, 6, 'six weeks');
  const problems = [];
  for (const el of [cal(), ...cal().querySelectorAll('*')]) {
    if (!el.getClientRects().length || el.closest('svg, .sr-only')) continue;
    const cs = getComputedStyle(el);
    if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) problems.push(`${el.className} scrolls sideways`);
    const words = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    if (words && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1) problems.push(`${el.tagName}.${el.className} is ${el.scrollWidth}px for ${el.clientWidth}px`);
  }
  for (const wd of $$('#calendar .cal-wd > span')) if (wd.scrollWidth > wd.clientWidth) problems.push(`weekday "${text(wd)}" is cut`);
  for (const b of $$('#calendar .cal-day')) {
    const dots = $('.cal-dots', b);
    if (dots.scrollWidth > b.clientWidth + 1) problems.push(`day ${b.dataset.day}'s dots are wider than the day`);
  }
  const g = $('#calendar .cal-grid').getBoundingClientRect();
  assert(g.left >= 0 && g.right <= innerWidth, `the grid is on screen (${Math.round(g.left)}–${Math.round(g.right)})`);
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'the page doesn\'t scroll sideways');
  // With the list open, it clears the + button once scrolled to the end (the page's bottom room).
  window.scrollTo(0, document.documentElement.scrollHeight);
  await tick(60);
  const last = $('#calendar .cal-list').getBoundingClientRect();
  const fab = $('#fab-stack').getBoundingClientRect();
  assert(last.bottom <= fab.top + 1, `the day's list ends (${Math.round(last.bottom)}) above the buttons (${Math.round(fab.top)})`);
  window.scrollTo(0, 0);
  eq(problems, [], 'text that runs out of its box');
});

test('Wallet, Grid and List are as they were', async () => {
  for (const v of ['wallet', 'grid', 'list']) {
    await view(v);
    assert($('#panel-calendar').hidden && !cal().getClientRects().length, `${v}: the calendar is out of sight`);
    eq($('#view-btn').dataset.view, v, `${v}: the View button shows it`);
    const now = v === 'wallet' ? $$('#wallet .w-band').map((b) => b.getAttribute('aria-label')) : text($('#subs-list'));
    // House's colour changed in the dots test; only its dot's name may differ.
    eq(JSON.stringify(now).replace(/Steel blue|Colour for House: [A-Za-z ]+/g, ''), JSON.stringify(before[v]).replace(/Steel blue|Colour for House: [A-Za-z ]+/g, ''), `${v}: unchanged`);
  }
  await view('calendar');
  eq(heading(), monthName(2026, 10), 'the calendar comes back on this month');
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  // With reduced motion emulated, leave the setting to follow the system (as on a fresh device).
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
  // These tests are about Monday-first weeks (en-GB) unless they set it; Auto is checked on its own.
  if (localeWeekStart(new Intl.DateTimeFormat().resolvedOptions().locale) !== 1) throw new Error('run these tests in an en-GB browser (weeks from Monday)');

  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; } catch (err) { failures.push({ name, error: err.message }); }
    await closeSheets();
  }
  for (const [p, v] of Object.entries(savedPrefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
  window.testClock.reset();
  $('#t-report').hidden = false;
  $('#summary').textContent = failures.length ? `${failures.length} of ${results.length} failed` : `All ${results.length} passed`;
  $('#summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  $('#results').innerHTML = results.map(({ name }) => {
    const f = failures.find((x) => x.name === name);
    return `<li class="${f ? 't-fail' : 't-pass'}">${f ? '✗' : '✓'} ${name}${f ? `<div class="t-detail">${f.error.replace(/</g, '&lt;')}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-cal-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
