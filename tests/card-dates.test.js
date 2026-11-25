// In-browser tests for card dates (1.29.0; js/card-dates.js, js/calendar.js, js/app.js renderDue and
// fillDueList). Run by tests/card-dates.html with a fixed clock (18 November 2026) against a throwaway
// database, with index.html's markup. Run it at 320, 360 and 393px, with and without reduced motion
// emulated, and in English, the pseudo-locale (?lang=xx) and zh-TW (?lang=zh-TW). Expected words come
// from t(), so every language checks the same things. The tests run in order, as one session.

import * as storage from '../js/storage.js';
import { overlays, pressBack } from '../js/overlays.js';
import { t, dateWords } from '../js/i18n.js';
import { money } from '../js/util.js';
import { listCards } from '../js/cards.js';
import { cashDue, incomeDue, undatedItems } from '../js/insights-calc.js';
import { dueSoon } from '../js/due-soon.js';
import { createCalendar } from '../js/calendar.js';
import { parseColour, contrast } from '../js/wallet-math.js';
import * as syncCore from '../js/sync-core.js';

const results = [];
const dbName = `substracker-test-carddates-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed', 'insightsMode', 'weekStart', 'catView', 'insightsBy'];
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
// t() keeps a no-break space where the page text (text()) has a plain one: compare them alike.
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t0 = 0; t0 < ms; t0 += 25) { if (await cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// November 2026: three expenses on the 20th (with Visa's statement closing day), card dates alone on
// the 21st (Amex due and LINE's closing day: two cards) and the 30th (Master, a colour this version
// can't draw, due on the 31st), and a deleted card's day (the 19th) with nothing on it.
const SEED = [
  { ...base, type: 'income', id: 'i-pay', name: 'Salary', price: 50000, cycle: 'monthly', nextRenewal: '2026-11-25', pay: 'k_visa' },
  { ...base, id: 'e-netflix', name: 'Netflix', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment', pay: 'k_visa' },
  { ...base, id: 'e-gym', name: 'Gym', price: 1200, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Health', pay: 'k_visa' },
  { ...base, id: 'e-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities', pay: 'k_amex' },
  { ...base, id: 'e-cloud', name: 'Cloud', price: 90, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 'e-rent', name: 'Rent', price: 18000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'Housing', pay: 'cash' },
  { ...base, id: 'e-misc', name: 'Misc', price: 150, cycle: 'monthly', nextRenewal: '2026-11-26' },
  { ...base, id: 'e-old', name: 'Old plan', price: 75, cycle: 'monthly', nextRenewal: '2026-11-03', pay: 'k_gone' },
  { ...base, id: 'e-tool', name: 'Tool', price: 10, currency: 'USD', cycle: 'monthly', nextRenewal: '2026-11-22', category: 'Utilities', pay: 'k_visa' },
  { ...base, id: 'e-bag', name: 'Gym bag', price: 300, cycle: 'monthly', nextRenewal: '', category: 'Health' },
];

const isOpen = (d) => d.open || d.hasAttribute('open');
const reduced = () => document.documentElement.classList.contains('reduce-motion');
const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { if (appTab() !== name) { $(`#tab-${name}`).click(); await tick(80); } };
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); overlays.clear(); await tick(30); };
const cal = () => $('#calendar').calendar;
const day = (n) => $(`#calendar .cal-day[data-day="${n}"]`);
const sep = () => t('common.listSep');
const fullDate = (d) => dateWords(new Date(2026, 10, d), { day: 'numeric', month: 'long', year: 'numeric' });
const cardsNow = async () => listCards(await storage.getSettingsRecord());
async function showNovember() {
  await goTab('calendar');
  cal().show(2026, 10);
  await tick(40);
}
async function openDay(n) {
  if (cal().state.selected !== n) day(n).click();
  await tick(40);
  return $('#calendar .cal-list');
}

/* Calendar ------------------------------------------------------------------------------------- */

test('Calendar: a card date takes one dot slot as a 9px card glyph; two dots and "+1" beside it; one marker per day', async () => {
  await showNovember();
  const marker = (n) => $('.cal-card', day(n));
  // The 5th (Visa due) and the 20th (Visa closes): Visa's colour.
  eq(marker(5)?.dataset.colour, 'c7', 'Visa due on the 5th, in its colour');
  eq(marker(20)?.dataset.colour, 'c7', 'Visa closes on the 20th');
  assert(marker(20).classList.contains('card-glyph') && marker(20).classList.contains('card-glyph-xs'), 'the shared card glyph, xs');
  eq(Math.round(marker(20).getBoundingClientRect().width), 9, '9px wide');
  // The 20th: three expenses, so two dots, the marker and "+1" (the expense left out).
  eq($$('.cal-dot', day(20)).length, 2, 'two expense dots');
  eq(text($('.cal-more', day(20))), t('calendar.more', { count: 1 }), '"+1" counts only the expense rows left out');
  eq([...$('.cal-dots', day(20)).children].map((c) => c.className.split(' ')[0]), ['cal-dot', 'cal-dot', 'card-glyph', 'cal-more'], 'dots, then the card, then +N');
  // Two cards on the 21st, and a colour this version can't draw on the 30th: the neutral outline.
  assert(marker(21) && !('colour' in marker(21).dataset), 'two cards: one neutral marker');
  eq($$('.cal-card', day(21)).length, 1, 'one marker, not two');
  assert(marker(30) && !('colour' in marker(30).dataset), 'an unknown colour: the neutral marker');
  // A deleted card's day, and days with no card date, have no marker.
  assert(!marker(19), 'a deleted card has no dates');
  eq($$('#calendar .cal-card').map((m) => Number(m.closest('.cal-day').dataset.day)), [5, 20, 21, 30], 'markers on those days only');
  assert($$('#calendar .cal-card').every((m) => m.getAttribute('aria-hidden') === 'true'), 'aria-hidden: the label says it');
  // A day with three expenses and no card date keeps three dots (Netflix alone on the 18th: one).
  eq($$('.cal-dot', day(18)).length, 1, 'the 18th: one dot, no marker');
});

test('Calendar: a day with only card dates is not tinted but can be tapped; the 20th stays tinted', async () => {
  await showNovember();
  for (const n of [21, 30]) {
    assert(!day(n).classList.contains('has-items'), `the ${n}th: no tint`);
    assert(day(n).classList.contains('has-cards'), `the ${n}th: marked as having card dates`);
    eq(getComputedStyle(day(n)).cursor, 'pointer', `the ${n}th: a pointer`);
  }
  assert(day(20).classList.contains('has-items'), 'the 20th: tinted (money moves)');
  const plain = getComputedStyle(day(19)).backgroundColor;
  eq(getComputedStyle(day(21)).backgroundColor, plain, 'the 21st looks like a plain day behind its marker');
});

test('Calendar: day labels name each card date; "no payments" on a day with only card dates; totals as before', async () => {
  await showNovember();
  const items = SEED.filter((s) => s.currency === 'TWD');
  eq(day(21).getAttribute('aria-label'), [fullDate(21), t('calendar.day.noPayments'), t('cardDates.due', { name: 'Amex' }), t('cardDates.cut', { name: 'LINE' })].join(sep()), 'the 21st: due first, then A–Z');
  eq(day(30).getAttribute('aria-label'), [fullDate(30), t('calendar.day.noPayments'), t('cardDates.due', { name: 'Master' })].join(sep()), 'the 30th (Master due on the 31st)');
  eq(day(20).getAttribute('aria-label'), [fullDate(20), t('calendar.day.payments', { count: 3 }), money(1789, 'TWD'), t('cardDates.cut', { name: 'Visa' })].join(sep()), 'the 20th: its payments and total, then the card date');
  eq(day(19).getAttribute('aria-label'), [fullDate(19), t('calendar.day.nothing')].join(sep()), 'a plain day as before');
  // In, Out and Left over are the items' alone.
  const flow = (k) => Number($(`#calendar .cal-flow-amount[data-flow="${k}"]`).dataset.value);
  eq(flow('out'), cashDue(items, 2026, 10), 'Out is cashDue');
  eq(flow('in'), incomeDue(items, 2026, 10), 'In is incomeDue');
  // The need-a-date line counts items only (a card with no day set is never in it).
  eq(text($('#calendar .cal-undated')), t('dueSoon.undated', { count: undatedItems(items).length }), 'need a date: the items');
  assert(!$('#calendar .cal-empty'), 'a month with items: no empty line');
});

test('Calendar: the day list ends with Card dates (no amounts), after its rows and total; a card-only day says no payments', async () => {
  await showNovember();
  let list = await openDay(20);
  eq(text($('.cal-list-sum', list)), norm(t('dueSoon.total', { amount: money(1789, 'TWD') })), 'the day total: the expenses only');
  eq($$('.due-list:not(.cal-card-list) .sub-row', list).length, 3, 'three item rows');
  eq(text($('.cal-cards-title', list)), norm(t('cardDates.title')), 'the Card dates heading');
  eq($('.cal-cards-title', list).tagName, 'H4', 'under the day heading (h3)');
  const rows = $$('.cal-card-list .card-date-row', list);
  eq(rows.map((r) => text(r)), [t('cardDates.cut', { name: 'Visa' })], 'one card date');
  assert(rows.every((r) => !r.querySelector('.amount') && !/\d{2,}/.test(text(r).replace('Visa', ''))), 'no amount');
  list = await openDay(21);
  eq(text($('.cal-note', list)), norm(t('calendar.list.noPayments')), '"No payments on this day", not "Nothing due"');
  assert(!$('.cal-list-sum', list), 'no total line');
  const r21 = $$('.cal-card-list .card-date-row', list);
  eq(r21.map((r) => r.dataset.card), ['k_amex', 'k_line'], 'due first, then the closing day');
  eq(r21.map((r) => r.tagName), ['BUTTON', 'BUTTON'], 'buttons (cards can be edited here)');
  eq(r21.map((r) => r.getAttribute('aria-label')), [t('cardDates.edit', { text: t('cardDates.due', { name: 'Amex' }) }), t('cardDates.edit', { text: t('cardDates.cut', { name: 'LINE' }) })], 'labelled with the edit');
  eq($('.card-glyph', r21[0]).dataset.colour, 'c3', 'Amex in its colour');
  list = await openDay(19);
  eq(text($('.cal-note', list)), norm(t('calendar.list.empty')), 'a plain day as before');
  assert(!$('.cal-cards-title', list), 'no Card dates block without card dates');
});

test('Calendar: a card date opens the card\'s sheet over the Calendar; Back closes it and stays on the Calendar', async () => {
  await showNovember();
  const list = await openDay(21);
  $('.card-date-row[data-card="k_amex"]', list).click();
  await until(() => isOpen($('#card-dialog')), 'the card sheet opens');
  eq($('#card-form').elements.cardName.value, 'Amex', 'that card');
  eq(overlays.ids(), ['card-dialog'], 'on the overlay stack');
  eq(appTab(), 'calendar', 'still on the Calendar');
  pressBack();
  await tick(80);
  assert(!isOpen($('#card-dialog')), 'one Back closes it');
  eq(overlays.ids(), [], 'nothing left open');
  eq(appTab(), 'calendar', 'and stays on the Calendar');
  eq(cal().state.selected, 21, 'the day still selected');
});

// The day cell at this width and language: the two dots and the marker always share one row, nothing
// runs out of the cell sideways, and the dots box is never taller than a day with three dots and the
// same "+N" without a card (at 320px "+N" already takes a second line under three dots; it may do so
// under two dots and the marker, never more). For "+1" (the app's 20th) and "+10" (twelve rows).
test('Calendar: the marker fits: dots and marker on one row, no sideways overflow, no taller than three dots and "+N"', async () => {
  await showNovember();
  const check = (cell, ref, what) => {
    const d = cell.querySelector('.cal-dots');
    const mid = (k) => { const r = k.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
    const slots = [...d.querySelectorAll('.cal-dot, .cal-card')].map(mid);
    assert(Math.max(...slots) - Math.min(...slots) <= 1, `${what}: the dots and the marker on one row (${slots.join(', ')})`);
    assert(d.scrollWidth <= d.clientWidth + 1, `${what}: the dots box doesn't overflow (${d.scrollWidth} > ${d.clientWidth})`);
    assert(cell.scrollWidth <= cell.clientWidth + 1, `${what}: the cell doesn't overflow`);
    const c = cell.getBoundingClientRect();
    for (const k of d.children) { const r = k.getBoundingClientRect(); assert(r.left >= c.left - 0.5 && r.right <= c.right + 0.5, `${what}: inside the cell`); }
    const h = d.getBoundingClientRect().height;
    const refH = ref.querySelector('.cal-dots').getBoundingClientRect().height;
    assert(h <= refH + 0.5, `${what}: no taller than three dots and the same "+N" (${h} > ${refH})`);
  };
  const mount = (n, cards) => {
    const host = document.createElement('div');
    $('#panel-calendar').append(host);
    const rows = Array.from({ length: n }, (_, i) => ({ ...base, id: `m${i}`, name: `M${i}`, price: 10, cycle: 'monthly', nextRenewal: '2026-11-20', category: `G${i}` }));
    const c = createCalendar(host, {
      items: () => rows, currency: () => 'TWD', weekStart: () => 1, reduced: () => true, dotColour: () => 'var(--group-1)',
      logo: () => '', onEdit: () => {}, cards: () => cards, cardsWritable: () => false,
    });
    c.show(2026, 10);
    return { cell: $('.cal-day[data-day="20"]', host), done: () => { c.destroy(); host.remove(); } };
  };
  const card = [{ id: 'x', name: 'X', colour: 'c1', cut: 20, due: null }];
  const views = [];
  try {
    // "+1": the app's 20th (three expenses and Visa) against four expenses and no card.
    const ref1 = mount(4, []); views.push(ref1);
    eq(text($('.cal-more', ref1.cell)), t('calendar.more', { count: 1 }), 'the reference: three dots, "+1"');
    check(day(20), ref1.cell, '"+1"');
    // "+10": twelve expenses and a card, against thirteen and none.
    const ten = mount(12, card); views.push(ten);
    const ref10 = mount(13, []); views.push(ref10);
    eq(text($('.cal-more', ten.cell)), t('calendar.more', { count: 10 }), '"+10" beside the marker');
    eq(text($('.cal-more', ref10.cell)), t('calendar.more', { count: 10 }), 'the reference: three dots, "+10"');
    check(ten.cell, ref10.cell, '"+10"');
  } finally { for (const v of views) v.done(); }
});

test('Calendar: where cards can\'t be edited, card dates are plain rows; a month with only card dates says so', async () => {
  const host = document.createElement('div');
  $('#panel-calendar').append(host);
  let opened = 0;
  const c = createCalendar(host, {
    items: () => [], currency: () => 'TWD', weekStart: () => 1, reduced: () => true, dotColour: () => 'var(--group-1)',
    logo: () => '', onEdit: () => {}, onCard: () => { opened++; },
    cards: () => [{ id: 'x', name: 'X card', colour: 'c1', cut: null, due: 18 }], cardsWritable: () => false,
  });
  try {
    c.show(2026, 10); // November, today the 18th: selected
    eq(text($('.cal-empty', host)), t('calendar.nothingMonth.cards', { month: dateWords(new Date(2026, 10, 1), { month: 'long', year: 'numeric' }) }), 'no items, card dates: "No payments planned"');
    const row = $('.card-date-row', host);
    eq(row?.tagName, 'DIV', 'a plain row');
    assert(!host.querySelector('button.card-date-row'), 'no button');
    row.click();
    eq(opened, 0, 'a tap does nothing');
  } finally { c.destroy(); host.remove(); }
});

test('Calendar: the marker\'s outline keeps 3:1 on the day in light and dark', async () => {
  await showNovember();
  const root = document.documentElement;
  const was = root.dataset.theme;
  try {
    for (const theme of ['light', 'dark']) {
      root.dataset.theme = theme;
      cal().update();
      await tick(30);
      for (const n of [20, 21]) {
        const m = $('.cal-card', day(n));
        const ink = parseColour(getComputedStyle(m).borderTopColor);
        const bg = getComputedStyle(day(n)).backgroundColor;
        const clear = bg === 'transparent' || /,\s*0\)$/.test(bg);
        const behind = parseColour(clear ? getComputedStyle($('#calendar .cal-grid')).backgroundColor : bg);
        const r = contrast(ink, behind);
        assert(r >= 3, `${theme}, the ${n}th: ${r.toFixed(2)}:1`);
      }
    }
  } finally {
    if (was) root.dataset.theme = was; else delete root.dataset.theme;
    cal().update();
  }
});

/* Due soon ------------------------------------------------------------------------------------- */

const setWindow = async (days) => {
  await goTab('settings');
  const sel = $('#set-due-days');
  sel.value = String(days);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(40);
  await goTab('subs');
};
async function openDue() {
  await goTab('subs');
  $('#due-chip').click();
  await until(() => isOpen($('#due-dialog')), 'the due-soon sheet opens');
  await tick(40);
}

test('due soon: the chip\'s number is the items\' alone; card dates are listed apart, due first, with no amounts', async () => {
  await setWindow(7);
  const res = dueSoon(SEED, new Date(), { windowDays: 7, currency: 'TWD' });
  eq(text($('#due-chip-text')), norm(t('dueSoon.chip', { count: res.count })), 'the chip: the items in the window');
  assert($('#due-chip').getAttribute('aria-label').endsWith(t('dueSoon.cardCount', { count: 3 })), 'read aloud with the card dates counted apart');
  await openDue();
  eq(text($('#due-text')), norm(t('dueSoon.summary', { count: res.count, days: 7 })), 'the summary: the items');
  eq(text($('#due-sum')), norm(t('dueSoon.total', { amount: money(res.total, 'TWD') })), 'the total: the items');
  eq($$('#due-list .sub-row').length, res.count, 'the item rows');
  const box = $('#due-cards');
  assert(!box.hidden, 'the Card dates section shows');
  eq(text($('.due-cards-title', box)), norm(t('cardDates.title')), 'its heading');
  const rows = $$('.card-date-row', box);
  eq(rows.map((r) => r.dataset.card), ['k_visa', 'k_amex', 'k_line'], 'the 20th, then the 21st (due before the closing day)');
  eq(rows.map((r) => text(r.querySelector('.sub-name'))), [t('cardDates.cut', { name: 'Visa' }), t('cardDates.due', { name: 'Amex' }), t('cardDates.cut', { name: 'LINE' })], 'what each is');
  assert(rows.every((r) => !r.querySelector('.amount')), 'no amounts');
  eq(text($('#due-hint')), norm(t('dueSoon.hintCards')), 'the footnote names card dates');
  // The items' rows come first, then the card dates.
  assert($('#due-list').compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING, 'after the items');
});

test('due soon: a card date closes the sheet and opens the card\'s sheet; Back closes it and stays on Money', async () => {
  await openDue();
  $('#due-cards .card-date-row[data-card="k_line"]').click();
  await until(() => isOpen($('#card-dialog')), 'the card sheet opens');
  assert(!isOpen($('#due-dialog')), 'the due-soon sheet closed first');
  eq($('#card-form').elements.cardName.value, 'LINE', 'that card');
  eq(overlays.ids(), ['card-dialog'], 'only the card sheet on the stack');
  pressBack();
  await tick(80);
  assert(!isOpen($('#card-dialog')), 'Back closes it');
  eq(overlays.ids(), [], 'nothing left open');
  eq(appTab(), 'subs', 'on Money');
});

test('due soon: with no item due but a card date, the chip reads "Card dates" with no number and the sheet opens', async () => {
  window.testClock.set(2026, 10, 27); // 27–30 November: no item, Master due on the 30th
  try {
    await setWindow(3);
    eq(dueSoon(SEED, new Date(), { windowDays: 3, currency: 'TWD' }).count, 0, 'no item in the window');
    assert(!$('#due-chip').hidden, 'the chip shows');
    eq(text($('#due-chip-text')), norm(t('dueSoon.chipCards')), '"Card dates"');
    assert(!/\d/.test(text($('#due-chip-text')).replace(/[٠-٩０-９]/g, '0')), 'no number on the chip');
    await openDue();
    eq(text($('#due-text')), norm(t('dueSoon.summaryNone', { days: 3 })), 'no items due');
    eq(text($('#due-sum')), '', 'no total');
    eq($$('#due-list .sub-row').length, 0, 'no item rows');
    eq($$('#due-cards .card-date-row').map((r) => r.dataset.card), ['k_master'], 'Master');
    eq(text($('#due-hint')), norm(t('dueSoon.hintCardsOnly')), 'the footnote for card dates only');
    $('#due-dialog [data-due-close]').click();
    await tick(40);
  } finally {
    window.testClock.reset();
    await setWindow(7);
  }
});

test('due soon: with neither, no chip; with items and no card dates in the window, the sheet as before', async () => {
  window.testClock.set(2026, 11, 8); // 8–11 December: no item, no card date
  try {
    await setWindow(3);
    assert($('#due-chip').hidden, 'no chip');
  } finally { window.testClock.reset(); }
  window.testClock.set(2026, 10, 25); // 25–28 November: Misc on the 26th, no card date
  try {
    await setWindow(3);
    await openDue();
    assert($('#due-cards').hidden && !text($('#due-cards')), 'no Card dates section, and no words in it');
    eq(text($('#due-hint')), norm(t('dueSoon.hint')), 'the footnote as before');
    $('#due-dialog [data-due-close]').click();
    await tick(40);
  } finally {
    window.testClock.reset();
    await setWindow(7);
  }
});

/* Isolation ------------------------------------------------------------------------------------ */

test('card dates are never items: the items, the Wallet and the outbox are as before', async () => {
  await goTab('subs');
  const all = await storage.getAll();
  eq(all.map((s) => s.id).sort(), SEED.map((s) => s.id).sort(), 'the same items');
  const cards = await cardsNow();
  const names = new Set(cards.map((c) => c.name));
  assert(!$$('#subs-list [data-id]').some((el) => names.has(text(el.querySelector('.sub-name, .w-name')))), 'no card as an item');
  const pending = await storage.pendingOps();
  await showNovember();
  await openDay(21);
  await openDue();
  $('#due-dialog [data-due-close]').click();
  await tick(40);
  eq((await storage.pendingOps()).length, pending.length, 'looking writes nothing');
});

test('Reduce motion and effects: no animation on a card-date day, its list or the due-soon card rows', async () => {
  if (!reduced()) return; // the motion run has the calendar's own transitions
  await showNovember();
  await openDay(21);
  const running = document.getAnimations().filter((a) => a.playState === 'running' && $('#calendar').contains(a.effect?.target));
  eq(running.length, 0, 'nothing animating in the Calendar');
});

/* --------------------------------------------------------------------------------------------- */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveCard('k_visa', { name: 'Visa', colour: 'c7', cut: 20, due: 5 });
  await storage.saveCard('k_amex', { name: 'Amex', colour: 'c3', due: 21 });
  await storage.saveCard('k_line', { name: 'LINE', colour: 'c2', cut: 21 });
  await storage.saveCard('k_none', { name: 'No days', colour: 'c4' });
  await storage.saveCard('k_gone', { name: 'Gone', colour: 'c5', due: 19 });
  await storage.deleteCard('k_gone');
  // Master came from a later version: a colour this one can't draw.
  {
    const r = { clock: syncCore.newClock('later-device'), records: new Map() };
    const ops = syncCore.setFields(r, 'settings', { card_k_master: { name: 'Master', colour: 'x9', due: 31 } }, { now: Date.now() - 60_000 });
    await storage.applyRemote(ops, 1);
  }
  // Put the deleted card's item back on it (as a device that hasn't seen the delete would have it).
  await storage.save({ ...SEED.find((s) => s.id === 'e-old') });
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  storage.setPref('insightsMode', 'month');
  storage.setPref('weekStart', 'mon');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  for (const p of ['groupSort', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed', 'catView', 'insightsBy']) localStorage.removeItem(`substracker.${p}`);
  if (LANG === 'zh-TW') storage.setPref('lang', 'zh-TW'); else localStorage.removeItem('substracker.lang');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#subs-list .w-item, #subs-list [data-id]'), 'app drawn', 8000);
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
      if (name?.startsWith('substracker-test-carddates-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
