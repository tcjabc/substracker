// In-browser tests for the Money tab's summary since 1.21.0 (js/app.js, js/wallet.js,
// js/wallet-math.js): the Money card (Cash due, Income, Left over, the Monthly | Annual toggle, the
// due-soon chip, a tap that opens Insights), the income card pinned above the stack (no longer a
// Wallet card or a Sort group) and its gauge (the front card's share of the income). Run by
// tests/money-card.html with a fixed clock (18 November 2026) against a throwaway database, with
// index.html's markup. Run it at 320, 360 and 393px, with and without reduced motion emulated, and
// in English, the pseudo-locale (?lang=xx) and zh-TW (?lang=zh-TW). Expected words come from t(),
// so every language checks the same things. The tests run in order, as one session in the app.

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';
import { overlays, pressBack } from '../js/overlays.js';
import { t, formatLocale } from '../js/i18n.js';
import { walletGroups, frontGauge, totalGauge, parseColour, contrast, GEOM, faceText, maxScroll, GAUGE_CONTRAST } from '../js/wallet-math.js';
import { stripSummary } from '../js/insights-calc.js';

const results = [];
const dbName = `substracker-test-card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
async function until(cond, msg, ms = 4000) {
  for (let t0 = 0; t0 < ms; t0 += 25) { if (cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}
const T = (n) => money(n, 'TWD');

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// "Today" is Wednesday 18 November 2026. November: Salary 40,000 in; out: Rent 30,000 (House), the
// Holiday 50,000 on the 28th (Travel: more than the income), Phone 499 (Utilities: 1.2%), Streaming
// 390 (Entertainment: under 1%), Coffee 30 (Snacks: under 1%), AWS 15 USD (Cloud: other currency
// only), Gym undated (Health: nothing). Cash due 80,919, Left over −40,919. The year 2026: income
// 40,000 × 12 + the March bonus 12,000 = 492,000; out 421,028; Left over 70,972. Due in the next 7
// days: Streaming today and Phone on the 20th.
const SEED = [
  { ...base, type: 'income', id: 'c-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, type: 'income', id: 'c-bonus', name: 'Bonus', price: 12000, cycle: 'annual', nextRenewal: '2027-03-10' },
  { ...base, id: 'c-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 'c-holiday', name: 'Holiday', price: 50000, cycle: 'once', date: '2026-11-28', category: 'Travel' },
  { ...base, id: 'c-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 'c-stream', name: 'Streaming', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
  { ...base, id: 'c-coffee', name: 'Coffee', price: 30, cycle: 'monthly', nextRenewal: '2026-12-05', category: 'Snacks' },
  { ...base, currency: 'USD', id: 'c-aws', name: 'AWS', price: 15, cycle: 'monthly', nextRenewal: '2026-12-09', category: 'Cloud' },
  { ...base, id: 'c-gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
];
const INCOME_IDS = ['c-salary', 'c-bonus'];

const card = () => $('#money-summary');
const incomeCard = () => $('#income-card');
const seg = () => $('#income-seg');
const track = () => $('#income-track');
const gaugeState = () => incomeCard().gauge;
const wallet = () => $('#wallet')?.wallet;
const reduced = () => document.documentElement.classList.contains('reduce-motion');
const open = (d) => d.open || d.hasAttribute('open');
const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(60); };
const comeBack = async () => { document.dispatchEvent(new Event('visibilitychange')); await tick(60); };
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };
const view = async (v) => {
  if (appTab() !== 'subs') await goTab('subs');
  $('#view-btn').click();
  $(`#view-menu [data-view="${v}"]`).click();
  await tick(80);
};
const sortBy = async (s) => {
  $('#view-btn').click();
  $(`#view-menu [data-sort="${s}"]`).click();
  await tick(80);
};
const period = async (p) => { $(`#money-summary [data-period="${p}"]`).click(); await tick(60); };
const figure = (id) => Number($(`#money-summary [data-roll="${id}"]`).dataset.value);
const monthName = () => new Date(2026, 10, 1).toLocaleDateString(formatLocale(), { month: 'long', year: 'numeric' });

/** The figures worked out here from the stored items, with the pure functions the app uses. */
async function expected(p = 'monthly', currency = 'TWD') {
  const items = await storage.getAll();
  const groups = walletGroups(items, { currency, period: p, year: 2026, month: 10 });
  const sum = stripSummary(items.filter((s) => s.currency === currency), p, 2026, 10);
  return { items, groups, sum };
}
/** The gauge's words for a gauge result `k` and a group label (null in Grid and List). */
function gaugeWords(k, label, p = 'monthly') {
  if (k.kind === 'noIncome') return t(p === 'annual' ? 'income.gauge.noIncome.year' : 'income.gauge.noIncome.month');
  if (k.kind === 'empty') return t(p === 'annual' ? 'wallet.nothingDue.year' : 'wallet.nothingDue.month');
  if (k.kind === 'foreign') return t('income.gauge.foreign', { group: label });
  if (label === null) return k.tiny ? t('income.gauge.outgoingsTiny') : t('income.gauge.outgoings', { pct: k.pct });
  return k.tiny ? t('income.gauge.shareTiny', { group: label }) : t('income.gauge.share', { group: label, pct: k.pct });
}
/** The segment's width as a share of the track. */
const shownRatio = () => (seg().hidden ? 0 : seg().getBoundingClientRect().width / track().getBoundingClientRect().width);
const settled = () => (!wallet() || reduced() || wallet().state().mode === 'idle') && !gaugeState().raf;
async function settle() { await until(settled, 'the stack and the gauge settle', 4000); await tick(30); }
/** Bring card `i` (at most the stack's scroll end) to the front with the arrow keys, one card at a time. */
async function front(i) {
  await settle();
  let at = Math.round(wallet().state().f);
  for (let guard = 0; at !== i && guard < 20; guard++) {
    const b = $$('#wallet .w-band')[at];
    b.focus({ preventScroll: true });
    b.dispatchEvent(new KeyboardEvent('keydown', { key: at < i ? 'ArrowDown' : 'ArrowUp', bubbles: true }));
    await settle();
    at = Math.round(wallet().state().f);
  }
  return settle();
}
async function checkGauge(g, income, msg) {
  const k = frontGauge(g, income);
  eq(text($('#income-label')), gaugeWords(k, g ? g.label : ''), `${msg}: the label`);
  eq(seg().hidden, k.kind !== 'share', `${msg}: a segment only for a share`);
  // The width the app set is checked at once; what is drawn, a frame later (headless Chrome now and
  // then still lays out the old width straight after a reduced-motion jump, though the style is set).
  const g0 = gaugeState();
  assert(seg().hidden || Math.abs(parseFloat(seg().style.width) / 100 - k.ratio) < 0.0001, `${msg}: set to ${seg().style.width} for a share of ${k.ratio.toFixed(4)}`);
  assert(g0.target === (k.kind === 'share' ? k.ratio : 0), `${msg}: the spring's target`);
  await frame();
  assert(Math.abs(shownRatio() - k.ratio) * track().getBoundingClientRect().width < 1, `${msg}: drawn ${shownRatio().toFixed(4)} wide for a share of ${k.ratio.toFixed(4)}`);
  return k;
}
function setTheme(theme) {
  const s = $('#set-theme');
  s.value = theme;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}
/** A CSS colour (a var() too) as [r, g, b], resolved by the browser. */
function resolve(colour, where = incomeCard()) {
  const p = document.createElement('span');
  p.style.color = colour;
  where.append(p);
  const out = parseColour(getComputedStyle(p).color);
  p.remove();
  return out;
}

/* ---------------------------------------------------------------- tests */

test('the Money card: this month, Cash due as the big figure, Income and Left over; no Avg line; Annual is the year', async () => {
  await view('wallet');
  const m = (await expected('monthly')).sum;
  eq([m.outgoings, m.income, m.leftOver], [80919, 40000, -40919], 'worked out from the items');
  eq(text($('.mc-when', card())), monthName(), 'the month');
  eq(text($('.mc-label', card())), t('money.card.cashDue'), 'Cash due');
  eq([figure('cash'), figure('income'), figure('left')], [m.outgoings, m.income, m.leftOver], 'the figures');
  eq([text($('[data-roll="cash"]', card())), text($('[data-roll="income"]', card())), text($('[data-roll="left"]', card()))], [T(80919), T(40000), T(-40919)], 'as money');
  eq($$('.mc-cell dt', card()).map(text), [t('money.income'), t('money.leftOver')], 'Income and Left over, always shown');
  assert(text(card()).includes(t('common.moreOutThanIn')), 'a short month says so in words, with its minus sign');
  assert(!text(card()).includes(T(m.average)), `no Avg line on the card (${T(m.average)})`);
  const und = $('.mc-undated', card());
  eq(text(und), t('common.excludesUndated', { count: 1 }), 'the undated line');
  await period('annual');
  const y = (await expected('annual')).sum;
  eq([y.outgoings, y.income, y.leftOver], [421028, 492000, 70972], 'the year from the items');
  eq(text($('.mc-when', card())), t('common.year', { year: 2026 }), 'the year');
  eq([figure('cash'), figure('income'), figure('left')], [y.outgoings, y.income, y.leftOver], 'the year\'s figures');
  assert(!text(card()).includes(t('common.moreOutThanIn')), 'no shortfall this year');
  eq($$('[data-period]', card()).map((b) => b.getAttribute('aria-pressed')), ['false', 'true'], 'the toggle says Annual');
  await period('monthly');
});

test('the card\'s figures are Insights\' month total, share of income and yearly card, and the Calendar\'s In and Out; Monthly and Annual', async () => {
  // Step Insights to another month first: the card opens Insights on this month all the same.
  await goTab('insights');
  if (storage.getPref('insightsMode') === 'year') $('[data-insights-mode="month"]').click();
  await tick(60);
  $('[data-month-step="1"]').click();
  await tick(60);
  await goTab('subs');
  for (const p of ['monthly', 'annual']) {
    await period(p);
    const [cash, income, left] = [figure('cash'), figure('income'), figure('left')];
    $('#money-summary .mc-open').click();
    await tick(120);
    eq(appTab(), 'insights', `${p}: the card opened Insights`);
    eq(text($('#insights .month-label')), monthName(), `${p}: on this month`);
    const yearCard = { income: Number($('#insights [data-roll="year-Income"]').dataset.value), out: Number($('#insights [data-roll="year-Outgoings"]').dataset.value), left: Number($('#insights [data-roll="year-Left over"]').dataset.value) };
    if (p === 'monthly') {
      eq(Number($('#insights [data-roll="month-due"]').dataset.value), cash, 'Cash due = the month\'s cash due');
      eq(text($('#insights [data-roll="month-due"]')), T(cash), 'the month total in the chart');
      eq(text($('#insights .ins-pct')), t('insights.pctOfIncome', { pct: Math.round((cash / income) * 100) }), 'the share of the same income');
      eq(left, income - cash, 'Left over = Income − Cash due');
      await goTab('calendar');
      const flow = (k) => Number($(`#calendar .cal-flow-amount[data-flow="${k}"]`).dataset.value);
      eq([flow('in'), flow('out'), flow('left')], [income, cash, Math.abs(left)], 'the Calendar\'s In, Out and Left over (its size)');
    } else {
      eq([income, cash, left], [yearCard.income, yearCard.out, yearCard.left], 'Annual = the yearly card');
    }
    await goTab('subs');
  }
  await period('monthly');
});

test('a tap anywhere on the card opens Insights; the toggle, the chip and the undated line don\'t', async () => {
  const opener = $('.mc-open', card());
  eq(opener.tagName, 'BUTTON', 'one button under the whole card');
  eq(opener.getAttribute('aria-label'), t('money.card.open.month', { amount: T(figure('cash')) }), 'labelled with Cash due and where it goes');
  const r = card().getBoundingClientRect();
  const o = opener.getBoundingClientRect();
  assert(Math.abs(o.width - r.width) < 3 && Math.abs(o.height - r.height) < 3, 'the size of the card');
  const at = (el) => { const b = el.getBoundingClientRect(); return document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2); };
  for (const sel of ['.mc-when', '.mc-label', '.mc-value', '.mc-cell dt', '.mc-cell dd']) eq(at($(sel, card()))?.className, 'mc-open', `a tap on ${sel} reaches the button`);
  eq(at($('[data-period="annual"]', card())), $('[data-period="annual"]', card()), 'the toggle is its own control');
  assert($('#due-chip').contains(at($('#due-chip'))), 'so is the chip, on top of the button');
  assert($('.mc-undated', card()).contains(at($('.mc-undated', card()))), 'and the undated line');
  await period('annual');
  eq(appTab(), 'subs', 'the toggle: still on Money');
  eq($('.mc-open', card()).getAttribute('aria-label'), t('money.card.open.year', { amount: T(figure('cash')) }), 'Annual: this year');
  await period('monthly');
  $('#due-chip').click();
  await until(() => open($('#due-dialog')), 'the chip opens its sheet');
  eq(appTab(), 'subs', 'the chip: still on Money');
  pressBack();
  await tick(60);
  $('.mc-undated', card()).click();
  await until(() => open($('#sub-dialog')), 'the undated line opens the item');
  eq([appTab(), $('#sub-form').elements.name.value], ['subs', 'Gym'], 'still on Money, editing Gym');
  pressBack();
  await tick(60);
  // The keyboard: the button is in the tab order and Enter activates it like any button.
  $('.mc-open', card()).focus();
  eq(document.activeElement, $('.mc-open', card()), 'focusable');
  document.activeElement.click();
  await tick(100);
  eq(appTab(), 'insights', 'it opens Insights');
  eq(document.activeElement, $('#tab-insights'), 'focus on the Insights tab');
  await goTab('subs');
});

test('the period toggle keeps focus through the redraw and still drives the Wallet totals', async () => {
  $('[data-period="annual"]', card()).focus();
  await period('annual');
  eq(document.activeElement?.dataset.period, 'annual', 'focus stays on the toggle');
  const { groups } = await expected('annual');
  const house = groups.find((g) => g.name === 'House');
  await view('wallet');
  eq(text($('#wallet .w-card[data-key="g:House"] .w-total')), T(house.total), 'the Wallet totals follow Annual');
  await period('monthly');
});

test('the chip: "2 due", the same sheet on the overlay stack; hidden when nothing is due or the setting is off', async () => {
  const chip = $('#due-chip');
  assert(!chip.hidden, 'shown');
  eq(text(chip), t('dueSoon.chip', { count: 2 }).replace(/\s+/g, ' '), 'the count');
  chip.click();
  await until(() => open($('#due-dialog')), 'the sheet');
  eq(overlays.top(), 'due-dialog', 'on the overlay stack');
  eq(text($('#due-text')), t('dueSoon.summary', { count: 2, days: 7 }).replace(/\s+/g, ' '), 'its totals at the top');
  eq(pressBack(), 'closed', 'Android Back closes it');
  await tick(40);
  storage.setPref('dueSoon', 'off');
  await comeBack();
  assert($('#due-chip').hidden, 'the setting off: hidden');
  storage.setPref('dueSoon', 'on');
  // Nothing due: move Streaming and Phone out of the window for a moment.
  const all = await storage.getAll();
  const moved = all.filter((s) => ['c-stream', 'c-phone'].includes(s.id));
  for (const s of moved) await storage.save({ ...s, nextRenewal: '2026-12-15' });
  await card().reload();
  await tick(60);
  try {
    assert($('#due-chip').hidden, 'nothing due: hidden');
  } finally {
    for (const s of moved) await storage.save(s);
    await card().reload();
    await tick(60);
  }
  assert(!$('#due-chip').hidden, 'back');
});

test('income is its own card: never a Wallet card or a Sort group, in every view and order', async () => {
  for (const v of ['wallet', 'grid', 'list']) {
    await view(v);
    for (const s of ['az', 'total', 'items']) {
      await sortBy(s);
      assert(!incomeCard().hidden, `${v}/${s}: the income card is shown`);
      assert(incomeCard().compareDocumentPosition($('#subs-list')) & Node.DOCUMENT_POSITION_FOLLOWING, `${v}/${s}: above the groups`);
      assert(card().compareDocumentPosition(incomeCard()) & Node.DOCUMENT_POSITION_FOLLOWING, `${v}/${s}: under the Money card`);
      for (const id of INCOME_IDS) assert(!$(`#subs-list [data-id="${id}"]`), `${v}/${s}: no income item among the groups`);
      if (v === 'wallet') assert(!$('#wallet .w-card[data-key="income"]') && wallet().state().count === 7, `${v}/${s}: seven expense cards, no Income card`);
      else assert(!$$('#subs-list .section-title').some((h) => text(h).startsWith(t('group.income'))), `${v}/${s}: no Income group`);
    }
  }
  await sortBy('az');
  await view('wallet');
});

test('the income card: collapsed, its title, the gauge and its words, no total; a tap lists the income; not saved', async () => {
  const toggle = $('#income-toggle');
  eq(toggle.getAttribute('aria-expanded'), 'false', 'collapsed');
  assert($('#income-list').hidden, 'no list');
  assert(text(toggle).startsWith(t('group.income')), 'the title');
  assert(!text(toggle).includes(T(40000)) && !/\d{1,3}(,\d{3})+/.test(text($('.ic-head'))), 'no income total');
  assert(track().getBoundingClientRect().height > 0, 'the gauge');
  const prefs = JSON.stringify(Object.keys(localStorage).sort());
  const stackHeight = wallet().state().height;
  toggle.click();
  await tick(80);
  eq(toggle.getAttribute('aria-expanded'), 'true', 'open');
  eq($$('#income-list .ic-row').map((r) => text($('.sub-name', r))), ['Bonus', 'Salary'], 'the income items, A to Z');
  eq($$('#income-list .ic-row').map((r) => text($('.amount', r))), [T(12000), T(40000)], 'with their amounts');
  // The stack measures its room again: less of it, unless it's already at its smallest (20rem;
  // then the page scrolls instead).
  const least = 20 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  if (!reduced()) assert(wallet().state().height < stackHeight || stackHeight <= least, `the stack measures its room again (${stackHeight} → ${wallet().state().height})`);
  if (!reduced()) assert($('#wallet').getBoundingClientRect().top >= incomeCard().getBoundingClientRect().bottom, 'and still starts under the income card');
  $('#income-list [data-id="c-salary"]').click();
  await until(() => open($('#sub-dialog')), 'the edit sheet');
  eq($('#sub-form').elements.name.value, 'Salary', 'a tap edits that item');
  pressBack();
  await tick(60);
  eq(JSON.stringify(Object.keys(localStorage).sort()), prefs, 'opening it saves nothing');
  toggle.click();
  await tick(80);
  eq(toggle.getAttribute('aria-expanded'), 'false', 'closed again');
  if (!reduced()) eq(wallet().state().height, stackHeight, 'and the stack has its room back');
});

test('the gauge follows the front card: the share, under 1%, 0%, over 100% and a group in other currencies only', async () => {
  await view('wallet');
  const { groups, sum } = await expected('monthly');
  eq(groups.map((g) => g.name), ['Cloud', 'Entertainment', 'Health', 'House', 'Snacks', 'Travel', 'Utilities'], 'the cards, A to Z');
  await settle();
  if (reduced()) {
    // Reduced, the stack is a plain list with no front slot: with every card closed there's no
    // front card, and the gauge shows all the outgoings, as in Grid and List (1.21.1).
    eq(wallet().state().front, null, 'no front card while every card is closed');
    const k = totalGauge(groups, sum.income);
    eq(text($('#income-label')), gaugeWords(k, null), 'the gauge: all the outgoings');
    eq(seg().style.getPropertyValue('--gauge-fill'), 'var(--accent)', 'in the accent colour');
  } else {
    const kinds = [];
    for (let i = 0; i <= wallet().state().maxScroll; i++) {
      await front(i);
      eq(wallet().state().front, groups[i].key, `card ${i} is at the front`);
      kinds.push((await checkGauge(groups[i], sum.income, groups[i].name)).kind);
    }
    await front(0);
    eq(kinds[0], 'foreign', 'Cloud: other currencies only, no segment');
  }
  // The open card is the front card, wherever it sits: every card, opened in turn.
  const seen = {};
  for (let i = 0; i < groups.length; i++) {
    $$('#wallet .w-band')[i].click();
    await until(() => wallet().state().open === groups[i].key && wallet().state().progress === 1, `${groups[i].name} opens`);
    await settle();
    eq(wallet().state().front, groups[i].key, `${groups[i].name}: the open card is the front card`);
    const k = await checkGauge(groups[i], sum.income, `${groups[i].name} open`);
    seen[groups[i].name] = [k.kind, k.pct, k.tiny];
    pressBack();
    await until(() => !wallet().state().open, 'closed');
    await settle();
  }
  eq(seen, {
    Cloud: ['foreign', 0, false], Entertainment: ['share', 1, true], Health: ['share', 0, false], House: ['share', 75, false],
    Snacks: ['share', 0, true], Travel: ['share', 125, false], Utilities: ['share', 1, false],
  }, 'other currency, under 1% (390 and 30), 0%, 75%, over 100% (125%, full width) and 1.2%');
  const travel = groups.findIndex((g) => g.name === 'Travel');
  $$('#wallet .w-band')[travel].click();
  await until(() => wallet().state().open === groups[travel].key && wallet().state().progress === 1, 'Travel opens');
  await settle();
  assert(Math.abs(shownRatio() - 1) < 0.005, 'Travel: the full bar');
  eq(text($('#income-label')), t('income.gauge.share', { group: groups[travel].label, pct: 125 }), 'with the true percentage');
  pressBack();
  await until(() => !wallet().state().open, 'closed');
  await settle();
  // The colour: the front card's group colour; a ring where it needs one.
  await front(reduced() ? 0 : groups.findIndex((g) => g.name === 'House'));
  const house = $('#wallet .w-card[data-key="g:House"]');
  if (!reduced()) eq(resolve(getComputedStyle(seg()).backgroundColor), parseColour(getComputedStyle(house).getPropertyValue('--card').trim()), 'House\'s colour');
  await front(0);
});

test('the gauge with no income this period: no segment and plain words; Annual counts the year', async () => {
  // USD as the default currency: no USD income at all.
  const select = $('#set-currency');
  select.value = 'USD';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => figure('income') === 0 && figure('cash') === 15, 'the card in USD');
  try {
    await settle();
    eq(text($('#income-label')), t('income.gauge.noIncome.month'), 'no income this month');
    assert(seg().hidden && shownRatio() === 0, 'no segment');
    await period('annual');
    await settle();
    eq(text($('#income-label')), t('income.gauge.noIncome.year'), 'no income this year');
    await period('monthly');
  } finally {
    select.value = 'TWD';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await until(() => figure('income') === 40000, 'back in TWD');
  }
});

test('Grid and List: all the outgoings as a share of the income, in the accent colour', async () => {
  for (const v of ['grid', 'list']) {
    await view(v);
    for (const p of ['monthly', 'annual']) {
      await period(p);
      await settle();
      const { groups, sum } = await expected(p);
      const k = totalGauge(groups, sum.income);
      eq(k.ratio, Math.min(1, sum.outgoings / sum.income), `${v}/${p}: Cash due ÷ Income`);
      eq(text($('#income-label')), gaugeWords(k, null, p), `${v}/${p}: the label`);
      assert(Math.abs(shownRatio() - k.ratio) * track().getBoundingClientRect().width < 1, `${v}/${p}: the width (${shownRatio().toFixed(4)} for ${k.ratio.toFixed(4)})`);
      eq(resolve(getComputedStyle(seg()).backgroundColor), resolve('var(--accent)'), `${v}/${p}: the accent colour`);
    }
    eq(text($('#income-label')), t('income.gauge.outgoings', { pct: 86 }), `${v}: Annual 421,028 of 492,000 is 86%`);
    await period('monthly');
    eq(text($('#income-label')), t('income.gauge.outgoings', { pct: 202 }), `${v}: November 80,919 of 40,000 is 202%, the bar full`);
  }
  await view('wallet');
});

test('the gauge is announced once, politely, when the stack settles on a new front card', async () => {
  const live = $('#income-live');
  eq(live.getAttribute('aria-live'), 'polite', 'a polite live region');
  assert(!$('#income-label').closest('[aria-live]') && !$('#income-toggle [aria-live]'), 'the label itself isn\'t live');
  const said = [];
  const mo = new MutationObserver(() => { if (live.textContent) said.push(live.textContent); });
  mo.observe(live, { childList: true, characterData: true, subtree: true });
  try {
    await settle();
    await comeBack(); // a redraw with the same front card
    await tick(100);
    eq(said, [], 'a redraw announces nothing');
    const { groups } = await expected();
    if (reduced()) {
      const i = groups.findIndex((g) => g.name === 'House');
      $$('#wallet .w-band')[i].click();
      await settle();
      await tick(100);
      eq(said, [text($('#income-label'))], 'opening a card: once');
      pressBack();
      await settle();
      await tick(100);
    } else {
      // Two cards on, quickly: the gauge follows, but only where the stack stops is said.
      const b = $$('#wallet .w-band')[0];
      b.focus({ preventScroll: true });
      b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await tick(30);
      $$('#wallet .w-band')[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await settle();
      await tick(100);
      const stop = Math.min(2, wallet().state().maxScroll);
      eq(wallet().state().front, groups[stop].key, 'two cards on (or the stack\'s end)');
      eq(said, [gaugeWords(frontGauge(groups[stop], 40000), groups[stop].label)], 'said once, for the card it stopped on');
      const now = $$('#wallet .w-band')[stop];
      now.focus({ preventScroll: true });
      now.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      await settle();
      await tick(100);
      eq(said, [said[0], gaugeWords(frontGauge(groups[0], 40000), groups[0].label)], 'and once more back at the top (Home)');
    }
  } finally {
    mo.disconnect();
  }
});

test('the segment moves on the spring, and jumps with Reduce motion and effects (0 animation frames)', async () => {
  const { groups } = await expected();
  const i = groups.findIndex((g) => g.name === 'House');
  const before = gaugeState().frames;
  $$('#wallet .w-band')[i].click();
  if (reduced()) {
    eq(gaugeState().frames, before, 'no animation frame');
    assert(!gaugeState().raf, 'none waiting');
    assert(Math.abs(shownRatio() - 30000 / 40000) < 0.01, `at its width at once (${shownRatio().toFixed(3)})`);
    eq(incomeCard().getAnimations({ subtree: true }).length, 0, 'no CSS animation either');
  } else {
    await until(() => wallet().state().open === groups[i].key && wallet().state().progress === 1, 'House opens');
    await settle();
    assert(gaugeState().frames > before, `frames while it moves (${gaugeState().frames - before})`);
    assert(Math.abs(shownRatio() - 30000 / 40000) < 0.01, 'and it settles on the share');
  }
  pressBack();
  await until(() => !wallet().state().open, 'closed');
  await settle();
  if (reduced()) eq(gaugeState().frames, before, 'still none after closing');
});

test('contrast, light and dark: the card\'s text 4.5:1; every segment colour 3:1 on the track or ringed', async () => {
  const keys = [...Array.from({ length: 15 }, (_, i) => `--wallet-${i + 1}`), ...Array.from({ length: 10 }, (_, i) => `--group-${i + 1}`), '--accent'];
  for (const theme of ['light', 'dark']) {
    setTheme(theme);
    await frame(); await frame(); await tick(30);
    const bg = parseColour(getComputedStyle(card()).backgroundColor);
    const texts = [...$$('.mc-when, .mc-label, .mc-value, .mc-cell dt, .mc-cell dd, .mc-undated', card())];
    for (const el of texts) {
      const c = contrast(parseColour(getComputedStyle(el).color), bg);
      assert(c >= 4.5, `${theme}: ${el.className || el.tagName} ${c.toFixed(2)}:1 on the card`);
    }
    for (const el of [...$$('.seg-btn', card()), $('#due-chip')]) {
      const own = parseColour(getComputedStyle(el).backgroundColor);
      const back = own && getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)' ? own : parseColour(getComputedStyle(el.closest('.segmented') ?? card()).backgroundColor);
      const c = contrast(parseColour(getComputedStyle(el).color), back);
      assert(c >= 4.5, `${theme}: ${el.className} "${text(el)}" ${c.toFixed(2)}:1`);
    }
    eq(bg, parseColour(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), `${theme}: the accent fill, as the Insights card`);
    const icBack = parseColour(getComputedStyle(incomeCard()).backgroundColor);
    for (const el of [$('.ic-title'), $('#income-label')]) {
      const c = contrast(parseColour(getComputedStyle(el).color), icBack);
      assert(c >= 4.5, `${theme}: ${el.className} ${c.toFixed(2)}:1 on the income card`);
    }
    const trackRGB = parseColour(getComputedStyle(track()).backgroundColor);
    const ring = resolve('var(--gauge-ring)');
    assert(contrast(ring, trackRGB) >= GAUGE_CONTRAST, `${theme}: the ring ${contrast(ring, trackRGB).toFixed(2)}:1 on the track`);
    const ringed = [];
    for (const k of keys) {
      const fill = resolve(`var(${k})`);
      const c = contrast(fill, trackRGB);
      eq(incomeCard().gaugeRing(`var(${k})`), c < GAUGE_CONTRAST, `${theme} ${k}: ${c.toFixed(2)}:1, ringed exactly when under 3:1`);
      if (c < GAUGE_CONTRAST) ringed.push(k);
    }
    // The segment on screen has the ring exactly when its colour needs it.
    await settle();
    if (!seg().hidden) {
      const colour = seg().style.getPropertyValue('--gauge-fill');
      eq(seg().classList.contains('ic-seg-ring'), incomeCard().gaugeRing(colour), `${theme}: the segment shown (${colour})`);
      if (seg().classList.contains('ic-seg-ring')) assert(getComputedStyle(seg()).boxShadow.includes('inset'), `${theme}: the ring is drawn`);
    }
    assert(ringed.length < keys.length, `${theme}: not every colour needs a ring (${ringed.length})`);
  }
  setTheme('light');
  await frame(); await frame();
});

/** Where the last card or group ends, scrolled to the end, against the + button. */
async function endClearance(label) {
  const fab = () => $('#fab').getBoundingClientRect();
  if (wallet() && $('#wallet').isConnected && !reduced()) {
    const bands = $$('#wallet .w-band');
    bands[0].focus({ preventScroll: true });
    bands[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settle();
    await tick(200);
    window.scrollTo(0, document.documentElement.scrollHeight);
    await tick(80);
    const last = bands.at(-1).closest('.w-card');
    const face = [bands.at(-1), ...$$('.w-pv-row', last)].map((e) => e.getBoundingClientRect()).filter((r) => r.height);
    const bottom = Math.max(...face.map((r) => r.bottom));
    assert(bottom <= fab().top + 1, `${label}: the last card's face ends at ${Math.round(bottom)}, above the + at ${Math.round(fab().top)}`);
    const st = wallet().state();
    const bar = $('.tabbar').getBoundingClientRect();
    eq(st.maxScroll, maxScroll(st.count, st.height, Math.max(0, bar.top - fab().top)), `${label}: its end measured from the one +`);
    const top = $('#wallet').getBoundingClientRect().top;
    const above = incomeCard().getBoundingClientRect().bottom;
    assert(top >= above, `${label}: the stack starts under the income card (${Math.round(top)} ≥ ${Math.round(above)})`);
    bands[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settle();
  } else {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await tick(80);
    const end = $('#subs-list').getBoundingClientRect().bottom;
    assert(end <= fab().top + 1, `${label}: the end (${Math.round(end)}) above the + (${Math.round(fab().top)})`);
  }
  assert(document.documentElement.scrollWidth <= innerWidth + 1, `${label}: no sideways scroll`);
  window.scrollTo(0, 0);
  await tick(40);
}

test('the page keeps room for the one + only, and the last card clears it in every view, the income card open or not', async () => {
  const cs = getComputedStyle(document.body);
  const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tabbar-h'));
  const fabSize = $('#fab').getBoundingClientRect().height;
  const space = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-4')) * 16;
  await view('grid');
  eq(Math.round(parseFloat(cs.paddingBottom)), Math.round(bar + space + fabSize + space), 'the page\'s bottom room: the tab bar, the + and its gaps (no room for the old pair)');
  for (const v of ['wallet', 'grid', 'list']) {
    await view(v);
    await endClearance(v);
    $('#income-toggle').click();
    await tick(100);
    await endClearance(`${v}, the income card open`);
    $('#income-toggle').click();
    await tick(100);
  }
  await view('wallet');
});

test(`fits ${innerWidth}px in ${LANG}: the big figure never cut, the toggle and the chip inside the card, nothing runs out`, async () => {
  const problems = [];
  const check = (root, label) => {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!el.getClientRects().length || el.closest('svg') || el.closest('[hidden]') || el.closest('.sr-only')) continue;
      const cs = getComputedStyle(el);
      const words = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (words && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1) problems.push(`${label}: ${el.tagName}.${el.className} is ${el.scrollWidth}px for ${el.clientWidth}px`);
    }
  };
  for (const p of ['monthly', 'annual']) {
    await period(p);
    const big = $('.mc-value', card());
    assert(big.scrollWidth <= big.clientWidth + 1, `${p}: the big figure fits (${big.scrollWidth} for ${big.clientWidth})`);
    eq(getComputedStyle(big).textOverflow, 'clip', `${p}: and is never ellipsised`);
    const r = card().getBoundingClientRect();
    for (const el of [$('.mc-period', card()), $('#due-chip'), big]) {
      const b = el.getBoundingClientRect();
      assert(b.left >= r.left && b.right <= r.right + 0.5, `${p}: ${el.className} inside the card (${Math.round(b.left)}–${Math.round(b.right)} in ${Math.round(r.left)}–${Math.round(r.right)})`);
    }
    check(card(), p);
    check(incomeCard(), `${p} income card`);
  }
  await period('monthly');
  $('#income-toggle').click();
  await tick(60);
  check(incomeCard(), 'income card open');
  $('#income-toggle').click();
  await tick(60);
  eq(problems, [], 'text that runs out of its box');
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'no sideways scroll');
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
    const f = failures.find((x) => x.name === name);
    return `<li class="${f ? 't-fail' : 't-pass'}">${f ? '✗' : '✓'} ${name}${f ? `<div class="t-detail">${f.error.replace(/</g, '&lt;')}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-card-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
