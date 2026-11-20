// In-browser tests for the app screens (js/app.js): the Insights month view and the Money card on
// a cash basis (Cash due and income; tests/money-card.html has the card's own tests), the "needs a renewal date" and "needs a payment date" notices, and the
// add/edit form requiring a renewal or payment date (with field-level saves and rollover still
// working), and the Insights Ring (3D) with its flat fallbacks and the Reduce motion and effects
// setting, and Import with AI (the slide to confirm and its fallback, Back on every step, the review,
// Replace all with the backup button, reduced motion, a blocked clipboard, both themes). Open tests/app.html from a local server. The app runs with
// index.html's markup against a throwaway database, seeded with made-up items dated relative to
// today, so the tests work in any month. The tests run in order, as one session in the app.

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';
import { overlays, pressBack } from '../js/overlays.js';
import { keyToWords } from '../js/words.js';
import { generateKey } from '../js/crypto.js';
import { createWallet } from '../js/wallet.js';
import { walletGroups, parseColour, contrast, isWalletKey } from '../js/wallet-math.js';
import { dueInMonth, groupOf } from '../js/insights-calc.js';
import { isIncome, renewalText, nextRenewal } from '../js/util.js';
import { logoHTML } from '../js/logos.js';

const results = [];
const dbName = `substracker-test-app-${Date.now()}`;
const PREFS = ['tab', 'catView', 'view', 'groupSort', 'period', 'insightsMode', 'yearRange', 'yearStack', 'yearKey', 'theme', 'reduceMotion'];
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

const now = new Date();
const Y = now.getFullYear();
const M = now.getMonth();
const pad = (n) => String(n).padStart(2, '0');
const day = (y, m, d) => { const x = new Date(y, m, d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// Due this month: Phone 499 + Cloud 1,200 (annual, stored two years ago, rolled forward) = 1,699.
// Not due: Domain (annual, six months away). Undated: Gym 900 /mo and Yoga 1,200 /yr.
// Year: (499 + 900) × 12 + 1,200 + 360 + 1,200 = 19,548, so Avg = 1,629.
const SEED = [
  { ...base, id: 'test-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: day(Y, M, 5), category: 'Utilities' },
  { ...base, id: 'test-cloud', name: 'Cloud', price: 1200, cycle: 'annual', nextRenewal: day(Y - 2, M, 15), category: 'Utilities' },
  { ...base, id: 'test-domain', name: 'Domain', price: 360, cycle: 'annual', nextRenewal: day(Y, M + 6, 1) },
  { ...base, id: 'test-gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
  { ...base, id: 'test-yoga', name: 'Yoga', price: 1200, cycle: 'annual', nextRenewal: '', category: 'Health' },
  // Income paid this month: Salary 40,000 + Refund 3,000 = 43,000. Bonus 12,000 is paid two months
  // from now (stored last year), so that month has 52,000. Lodger 5,000 /mo has no payment date.
  { ...base, type: 'income', id: 'test-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: day(Y, M, 25) },
  { ...base, type: 'income', id: 'test-bonus', name: 'Bonus', price: 12000, cycle: 'annual', nextRenewal: day(Y - 1, M + 2, 10) },
  { ...base, type: 'income', id: 'test-refund', name: 'Refund', price: 3000, cycle: 'once', date: day(Y, M, 8) },
  { ...base, type: 'income', id: 'test-lodger', name: 'Lodger', price: 5000, cycle: 'monthly', nextRenewal: '' },
  // USD: an expense, and one-off income next month only, so this month has no USD income.
  // The year: income 200, outgoings 10 × 12 + Big 500 (annual, three months from now) = 620.
  { ...base, currency: 'USD', id: 'test-usd-tool', name: 'Tool', price: 10, cycle: 'monthly', nextRenewal: day(Y, M, 2) },
  { ...base, currency: 'USD', id: 'test-usd-big', name: 'Big', price: 500, cycle: 'annual', nextRenewal: day(Y, M + 3, 1) },
  { ...base, currency: 'USD', type: 'income', id: 'test-usd-gig', name: 'Gig', price: 200, cycle: 'once', date: day(Y, M + 1, 5) },
];

const dialog = () => $('#sub-dialog');
const isOpen = () => dialog().open || dialog().hasAttribute('open');
const notice = () => $('#insights [data-notice="plans"]');
const incomeNotice = () => $('#insights [data-notice="income"]');
const step = async (n) => {
  for (let i = 0; i < Math.abs(n); i++) {
    $(`#insights [data-month-step="${n > 0 ? 1 : -1}"]`).click();
    await tick(10);
  }
};
const chip = (code) => $(`#currency-chips [data-currency="${code}"]`);
const monthTotal = () => $('#insights [data-roll="month-due"]');
const share = () => text($('#insights .ins-pct'));
/** The income paid in month M + k, as the Calendar's In shows it (Insights shows only its share). */
async function monthIn(k) {
  const back = $('.tab[aria-selected="true"]').dataset.tab;
  $('.tab[data-tab="calendar"]').click();
  await tick(30);
  const d = new Date(Y, M + k, 1);
  $('#calendar').calendar.show(d.getFullYear(), d.getMonth());
  const v = text($('#calendar .cal-flow-amount[data-flow="in"]'));
  $('#calendar').calendar.show(Y, M);
  $(`.tab[data-tab="${back}"]`).click();
  await tick(30);
  return v;
}

/* ---------------------------------------------------------------- Insights */

test('the month total is the cash due this month, and one line says its share of the income', async () => {
  eq(text(monthTotal()), T(1699), 'cash due, in the chart');
  eq(share(), '4% of income', 'the share of the income (1,699 of 43,000)');
  assert(!$('#insights .stat-primary') && !text($('#insights')).includes('Avg'), 'no month card and no Avg line');
});

const yearCard = () => $('#insights .stat-year');
const yearLines = () => $$('.year-line', yearCard()).map((el) => [text($('dt', el)), text($('dd', el))]);
const yearNotes = () => $$('.stat-sub', yearCard()).map(text);

// Year Y in TWD from its twelve cash months (undated Gym, Yoga and Lodger left out):
//   income     Salary 40,000 × 12 + Bonus 12,000 + Refund 3,000             = 495,000
//   outgoings  Phone 499 × 12 + Cloud 1,200 + Domain 360                    =   7,548
//   left over                                                               = 487,452
// The old card showed 19,548: the same plans plus the undated Gym (900 × 12) and Yoga (1,200).
test('the yearly card shows income, outgoings and left over from the twelve cash months', async () => {
  eq(text($('.stat-label', yearCard())), String(Y), 'year label');
  eq(yearLines(), [['Income', T(495000)], ['Outgoings', T(7548)], ['Left over', T(487452)]], 'three lines');
  eq(yearNotes(), ['Excludes 3 undated items'], 'one line for the undated items, not the notices again');
  assert(!$('.year-short', yearCard()), 'not short');
});

test('a year with more going out than coming in, and a year with no income', async () => {
  const usd = (n) => money(n, 'USD');
  // Gig is paid next month; in December that's next year, so view that year instead.
  const gigYear = new Date(Y, M + 1, 5).getFullYear();
  const offset = gigYear === Y ? 0 : 1;
  chip('USD').click();
  await step(offset);
  eq(text($('.stat-label', yearCard())), String(gigYear), 'the year Gig is paid in');
  eq(yearLines(), [['Income', usd(200)], ['Outgoings', usd(620)], ['Left over', usd(-420)]], 'short year');
  assert(usd(-420).includes('-') || usd(-420).includes('−'), 'the amount has a minus sign');
  assert($('.year-line.year-short', yearCard()), 'short style on the left-over line');
  eq(yearNotes(), ['More going out than coming in'], 'said in words too; no undated items in USD');
  await step(-12);
  eq(text($('.stat-label', yearCard())), String(gigYear - 1), 'previous year');
  eq(yearLines(), [['Outgoings', usd(620)]], 'no income line and no left-over figure');
  eq(yearNotes(), [`No income dated in ${gigYear - 1}`], 'says why');
  await step(12 - offset);
  chip('TWD').click();
  eq(text($('.stat-label', yearCard())), String(Y), 'back to this year in TWD');
});

test('the share of income, the donut and the category list all use the month cash total', async () => {
  eq(share(), `${Math.round((1699 / 43000) * 100)}% of income`, 'the share uses the cash total');
  $('#insights [data-catview="donut"]').click();
  eq(text($('#insights .donut-total')), T(1699), 'donut centre');
  const legend = $$('#insights .legend-row .legend-name').map(text);
  eq(legend, ['Utilities'], 'only categories with something due');
  $('#insights [data-catview="list"]').click();
  eq($$('#insights .cat-row .cat-amount').map((el) => el.firstChild.textContent.trim()), [T(1699)], 'category list total');
  eq(text($('#insights .ins-list .legend-foot')), '1 monthly · 1 annual · 0 one-off', 'items due, under the list');
});

/* ------------------------------------------------- Insights Ring (3D) */
// Six months from now TWD has two categories due: Utilities (Phone 499) and Uncategorised (Domain 360).

const stage = () => $('#insights .ring-stage');
const caption = () => text($('#insights .ring-name'));
const pressedRows = () => $$('#insights .legend-row').map((r) => r.getAttribute('aria-pressed'));
const keyOn = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const setUrlFlag = (q) => history.replaceState(null, '', `${location.pathname}${q}`);
let ringMod = null;
async function openRing() {
  $('#insights [data-catview="ring"]').click();
  await until(() => $('#insights .ring-canvas'), 'the Ring canvas appears', 8000);
  ringMod ||= await import('../js/donut-3d.js'); // the module instance the app loaded
  await until(() => !ringMod.ringStats.running, 'the Ring at rest');
}

test('Reduce motion and effects: per device, follows the system until set, flat Ring, not exported or synced', async () => {
  const box = $('#set-motion');
  const sys = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The app started with the setting unset (see run()), so it follows the system. (The runner also
  // loads this page with prefers-reduced-motion emulated as "reduce" to cover the other case.)
  eq(localStorage.getItem('substracker.reduceMotion'), null, 'unset');
  eq(box.checked, sys, 'unset: the checkbox shows the system setting');
  eq(document.documentElement.classList.contains('reduce-motion'), sys, 'unset: the page follows the system');
  const flip = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
  flip(true);
  eq(localStorage.getItem('substracker.reduceMotion'), 'on', 'saved on this device');
  assert(document.documentElement.classList.contains('reduce-motion'), 'motion cut app-wide');
  $('#insights [data-catview="ring"]').click();
  assert(!$('#insights .ring-stage') && $('#insights .donut svg'), 'the Ring shows as the flat donut');
  assert(text($('#insights .ring-note')).includes('Reduce motion and effects'), 'and says why');
  flip(false);
  eq(localStorage.getItem('substracker.reduceMotion'), 'off');
  assert(!document.documentElement.classList.contains('reduce-motion'), 'off overrides the system');
  // Never in a backup or in the synced settings.
  const backup = JSON.stringify(await storage.exportAll());
  assert(!/reduceMotion|reduce-motion/i.test(backup), 'not exported');
  const settings = await storage.getSettings();
  assert(!Object.keys(settings).some((k) => /motion/i.test(k)), 'not a synced setting');
  flip(false);
});

test('Ring: a 3D view with caption, legend and labels; arrow keys turn it; aria-live says the front slice', async () => {
  await step(6);
  await openRing();
  eq(caption(), 'Utilities', 'the largest slice starts at the front');
  eq(text($('#insights .ring-amount')), T(499), 'caption amount');
  eq(text($('#insights .ring-share')), '58%', 'caption share of the month (one caption line since 1.22.1)');
  eq(pressedRows(), ['true', 'false'], 'legend marks the front slice');
  assert(stage().getAttribute('aria-label').includes(`Front: Utilities, ${T(499)}, 58%`), 'stage label names the front slice');
  assert($('#insights .ring-canvas').getAttribute('aria-hidden') === 'true', 'the canvas itself is hidden from screen readers');
  keyOn(stage(), 'ArrowRight');
  await until(() => caption() === 'Uncategorised', 'ArrowRight brings the next slice to the front');
  await until(() => !ringMod.ringStats.running, 'settles');
  await until(() => text($('#ring-live')) === `Uncategorised, ${T(360)}, 42%`, 'announced once at rest');
  eq(pressedRows(), ['false', 'true'], 'legend follows');
  keyOn(stage(), 'ArrowLeft');
  await until(() => caption() === 'Utilities' && !ringMod.ringStats.running, 'ArrowLeft goes back');
});

test('Ring: draws no frames while idle, and only while it moves', async () => {
  const f0 = ringMod.ringStats.frames;
  await tick(600);
  eq(ringMod.ringStats.frames, f0, 'no frames while nothing moves');
  assert(!ringMod.ringStats.running, 'no loop running');
  $$('#insights .legend-row')[1].click(); // a legend row brings its slice round
  await until(() => ringMod.ringStats.running, 'the loop starts');
  await until(() => !ringMod.ringStats.running, 'and stops at rest');
  const f1 = ringMod.ringStats.frames;
  assert(f1 > f0 + 5, `frames drawn while turning (${f1 - f0})`);
  await tick(400);
  eq(ringMod.ringStats.frames, f1, 'idle again');
  eq(ringMod.ringStats.calls, 3, 'one draw call per slice plus the shadow');
});

test('Ring: tapping a slice brings it to the front', async () => {
  eq(caption(), 'Uncategorised', 'starting slice');
  // The far half of the ring is the other slice: tap the back of the ring, near the top of the stage.
  const c = $('#insights .ring-canvas');
  const b = c.getBoundingClientRect();
  const at = { clientX: b.left + b.width / 2, clientY: b.top + b.height * 0.2, pointerId: 41, bubbles: true, isPrimary: true, pointerType: 'touch' };
  c.dispatchEvent(new PointerEvent('pointerdown', at));
  await tick(40);
  c.dispatchEvent(new PointerEvent('pointerup', at));
  await until(() => caption() === 'Utilities', 'the tapped slice comes to the front');
  await until(() => !ringMod.ringStats.running, 'settles');
});

test('Ring: a theme change redraws once with the theme colours', async () => {
  const before = ringMod.ringStats.frames;
  $('#set-theme').value = 'dark';
  $('#set-theme').dispatchEvent(new Event('change'));
  await until(() => ringMod.ringStats.frames === before + 1, 'one frame for the new theme');
  $('#set-theme').value = 'light';
  $('#set-theme').dispatchEvent(new Event('change'));
  await until(() => ringMod.ringStats.frames === before + 2, 'and one back');
  await tick(200);
  eq(ringMod.ringStats.frames, before + 2, 'nothing more');
  $('#set-theme').value = 'system';
  $('#set-theme').dispatchEvent(new Event('change'));
  await tick(50);
});

test('Ring falls back to the flat donut when WebGL is ruled out (flat=1), with arrow keys there too', async () => {
  setUrlFlag('?flat=1');
  $('#insights [data-catview="ring"]').click();
  assert(!$('#insights .ring-stage'), 'no Ring');
  assert($('#insights .donut svg'), 'the flat donut instead');
  assert(text($('#insights .ring-note')).includes('flat donut'), 'a note says why');
  const chart = $('#insights [data-donut-keys]');
  assert(chart, 'the flat donut is focusable');
  keyOn(chart, 'ArrowRight');
  eq(pressedRows().filter((p) => p === 'true').length, 1, 'arrow keys highlight one slice');
  setUrlFlag('');
});

test('Ring: a lost WebGL context falls back to the flat donut for the session', async () => {
  await openRing();
  ringMod.loseContextForTest();
  await until(() => !$('#insights .ring-stage') && $('#insights .donut svg'), 'flat donut after the context is lost');
  assert(text($('#insights .ring-note')).includes('stopped working'), 'says why');
  $('#insights [data-catview="donut"]').click();
  await step(-6);
});

/* ------------------------------------------------------- Money card (the strip until 1.21.0) */

// Cash due (the big figure), then Income and Left over, each [label, figure, note].
const stripCells = () => [
  [text($('#money-summary .mc-label')), text($('#money-summary [data-roll="cash"]')), ''],
  ...$$('#money-summary .mc-cell').map((c) => [text($('dt', c)), text($('dd', c)), text($('.mc-note', c))]),
];
const period = (p) => $(`#money-summary [data-period="${p}"]`).click();

// The card, default currency TWD, this month: income 43,000 (Salary + Refund), cash due 1,699, as
// in Insights (no Avg line on the card since 1.21.0). This year: as the yearly card. Before, on the
// monthly-equivalent basis with undated items, it showed 49,000 / 1,629 for the month and
// 555,000 / 19,548 for the year.
test('the Money card shows this month on the cash basis, as Insights does; no Avg line', async () => {
  period('monthly');
  eq(stripCells(), [
    ['Cash due', T(1699), ''],
    ['Income', T(43000), ''],
    ['Left over', T(41301), ''],
  ], 'monthly card');
  const thisMonth = new Date(Y, M, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  eq(text($('#money-summary .mc-when')), thisMonth, 'this month');
  eq([text(monthTotal()), share()], [T(1699), '4% of income'], 'the same as Insights: its month total, and its share of the same income');
  assert(!text($('#money-summary')).includes('Avg'), 'no Avg line');
  eq(text($('#money-summary > p.mc-note')), "TWD only. 3 items in other currencies aren't included.", 'currency note kept');
});

test('the Money card in Annual shows the year from its twelve cash months', async () => {
  period('annual');
  eq(stripCells(), [
    ['Cash due', T(7548), ''],
    ['Income', T(495000), ''],
    ['Left over', T(487452), ''],
  ], 'annual card, same as the yearly card');
  eq(text($('#money-summary .mc-when')), String(Y), 'this year');
  eq(yearLines(), [['Income', T(495000)], ['Outgoings', T(7548)], ['Left over', T(487452)]], 'yearly card agrees');
  period('monthly');
  eq(stripCells()[1][1], T(43000), 'back to monthly');
});

test('the Money card has one line for undated items that opens the first of them', async () => {
  const line = $('#money-summary .mc-undated');
  eq(text(line), 'Excludes 3 undated items', 'one line, no repeat of the notices');
  line.click();
  await until(isOpen, 'edit sheet opens');
  eq(field('name').value, 'Gym', 'the first undated plan (plans before income)');
  $('#sub-dialog [data-close]').click();
  await until(() => !isOpen(), 'sheet closes');
});

test('a short month on the Money card shows the minus sign and says so in words', async () => {
  const usd = (n) => money(n, 'USD');
  const select = $('#set-currency');
  select.value = 'USD';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => text($('#money-summary [data-roll="income"]')) === usd(0), 'card in USD');
  const [, , left] = stripCells();
  eq(left, ['Left over', usd(-10), 'More going out than coming in'], 'short month');
  assert($('#money-summary .mc-short'), 'short style');
  assert(usd(-10).includes('-') || usd(-10).includes('−'), 'minus sign');
  assert(!$('#money-summary .mc-undated'), 'no undated USD items');
  select.value = 'TWD';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => text($('#money-summary [data-roll="income"]')) === T(43000), 'card back in TWD');
  await until(() => text($('#insights .stat-year .stat-label')) === String(Y), 'Insights back on TWD');
});

test('the notice names the undated plans and their amount', async () => {
  eq(text(notice()), `2 plans need a renewal date, ${T(2100)} not shown`, 'notice text');
});

test('the month income is what is paid in it, not a monthly equivalent', async () => {
  eq([text(monthTotal()), share(), await monthIn(0)], [T(1699), '4% of income', T(43000)], 'this month');
  await step(2);
  eq([text(monthTotal()), share(), await monthIn(2)], [T(499), '1% of income', T(52000)], 'bonus month');
  await step(-1);
  eq([text(monthTotal()), share(), await monthIn(1)], [T(499), '1% of income', T(40000)], 'salary only');
  await step(-1);
});

test('a month with no income shows no percentage and says why', async () => {
  chip('USD').click();
  const usd = (n) => money(n, 'USD');
  const monthName = (k) => new Date(Y, M + k, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  eq([text(monthTotal()), share()], [usd(10), `No USD income paid in ${monthName(0)}, so no percentage`], 'none paid');
  assert(!/%/.test(share()), 'no percentage');
  await step(1);
  eq([text(monthTotal()), share()], [usd(10), '5% of income'], 'next month: 10 of 200');
  await step(-1);
  chip('TWD').click();
  eq([text(monthTotal()), share()], [T(1699), '4% of income'], 'back to TWD');
});

test('undated income has its own notice; income and plan amounts are never added', async () => {
  eq(text(incomeNotice()), `1 income item needs a payment date, ${T(5000)} not shown`, 'income notice');
  eq(text(notice()), `2 plans need a renewal date, ${T(2100)} not shown`, 'plans notice unchanged');
});

test('tapping the notice opens the first undated plan for editing', async () => {
  notice().click();
  await until(isOpen, 'edit sheet opens');
  eq(text($('#sub-dialog-title')), 'Edit expense', 'edit title');
  eq(dialog().querySelector('[name="name"]').value, 'Gym', 'first undated plan, A–Z');
  eq(dialog().querySelector('[name="nextRenewal"]').value, '', 'date not filled in');
  $('#sub-dialog [data-close]').click();
  await until(() => !isOpen(), 'sheet closes');
});

/* ------------------------------------------------------- Renewal date form */

const field = (name) => dialog().querySelector(`[name="${name}"]`);
const errorFor = (name) => text(dialog().querySelector(`[data-error-for="${name}"]`));
const save = () => dialog().querySelector('button[type="submit"]').click();
const setValue = (name, value) => {
  field(name).value = value;
  field(name).dispatchEvent(new Event('input', { bubbles: true }));
};
const stored = async (id) => (await storage.getAll()).find((s) => s.id === id);
// The outbox holds one pending op per record field, replaced when the field is written again.
const opStamps = async (id) => Object.fromEntries((await storage.syncState()).outbox
  .filter((op) => op.rec === id).map((op) => [op.f, op.t]));
const written = (before, after) => Object.keys(after).filter((f) => after[f] !== before[f]).sort();

test('editing any field of an undated plan asks for a renewal date and keeps the sheet open', async () => {
  notice().click();
  await until(isOpen, 'edit sheet opens');
  setValue('notes', 'Changed note');
  save();
  await tick(50);
  assert(isOpen(), 'sheet stays open');
  eq(errorFor('nextRenewal'), 'Pick a renewal date.', 'error message');
  eq(field('nextRenewal').getAttribute('aria-invalid'), 'true', 'field marked invalid');
  assert(document.activeElement === field('nextRenewal'), 'renewal field focused');
  const msg = dialog().querySelector('[data-error-for="nextRenewal"]').getBoundingClientRect();
  const body = dialog().querySelector('.sheet-body').getBoundingClientRect();
  assert(msg.top >= body.top - 1 && msg.bottom <= body.bottom + 1, 'message scrolled into view');
  eq(field('notes').value, 'Changed note', 'what was typed is kept');
  eq((await stored('test-gym')).notes, '', 'nothing saved');
});

test('picking the date clears the error and saves only the fields that changed', async () => {
  const before = await opStamps('test-gym');
  setValue('nextRenewal', day(Y, M, 20));
  eq(errorFor('nextRenewal'), '', 'error cleared on input');
  save();
  await until(() => !isOpen(), 'sheet closes');
  await tick(50);
  eq(written(before, await opStamps('test-gym')), ['nextRenewal', 'notes', 'updatedAt'], 'fields written');
  const gym = await stored('test-gym');
  eq([gym.nextRenewal, gym.notes, gym.price, gym.name], [day(Y, M, 20), 'Changed note', 900, 'Gym'], 'stored item');
});

test('a plan that has its date leaves the notice, and its amount moves into the month', async () => {
  eq(text(notice()), `1 plan needs a renewal date, ${T(1200)} not shown`, 'one left');
  eq(text(monthTotal()), T(1699 + 900), 'month now includes Gym');
});

test('a plan with a past stored date still saves as it is, and rolls forward for display', async () => {
  $('#insights .rank-row[data-id="test-cloud"]').click();
  await until(isOpen, 'edit sheet opens');
  eq(field('nextRenewal').value, day(Y - 2, M, 15), 'stored date shown as entered');
  const before = await opStamps('test-cloud');
  setValue('price', '1300');
  save();
  await until(() => !isOpen(), 'sheet closes (a past date is valid)');
  await tick(50);
  eq(written(before, await opStamps('test-cloud')), ['price', 'updatedAt'], 'date not rewritten');
  eq((await stored('test-cloud')).nextRenewal, day(Y - 2, M, 15), 'stored date unchanged');
  eq(text(monthTotal()), T(499 + 900 + 1300), 'still due this month');
  // The Money tab shows the rolled-forward date: this year's or next year's 15th of this month.
  const tag = text($('#subs-list [data-id="test-cloud"] .tag'));
  assert(/^Renews/.test(tag), `renewal tag shown (${tag})`);
});

test('a new monthly or annual expense needs a renewal date; a one-off needs its date', async () => {
  $('[data-action="add"]').click();
  await until(isOpen, 'add sheet opens');
  setValue('name', 'Test service');
  setValue('price', '10');
  eq(field('nextRenewal').value, '', 'no date filled in');
  save();
  await tick(50);
  assert(isOpen(), 'monthly without a date is not saved');
  eq(errorFor('nextRenewal'), 'Pick a renewal date.', 'monthly message');
  dialog().querySelector('input[name="cycle"][value="annual"]').click();
  save();
  await tick(50);
  assert(isOpen(), 'annual without a date is not saved');
  eq(errorFor('nextRenewal'), 'Pick a renewal date.', 'annual message');
  dialog().querySelector('input[name="cycle"][value="once"]').click();
  eq(errorFor('nextRenewal'), '', 'renewal error cleared for a one-off');
  setValue('date', '');
  save();
  await tick(50);
  assert(isOpen(), 'one-off without a date is not saved');
  eq(errorFor('date'), 'Pick the date it happens.', 'one-off message');
  setValue('date', day(Y, M, 3));
  save();
  await until(() => !isOpen(), 'one-off with a date saves');
  $('[data-action="add"]').click();
  await until(isOpen, 'add sheet opens again');
  setValue('name', 'Dated service');
  setValue('price', '20');
  setValue('nextRenewal', day(Y, M, 9));
  save();
  await until(() => !isOpen(), 'monthly with a date saves');
  eq((await storage.getAll()).find((s) => s.name === 'Dated service')?.nextRenewal, day(Y, M, 9), 'stored');
});

test('tapping the income notice opens the undated income; saving it needs a payment date', async () => {
  incomeNotice().click();
  await until(isOpen, 'edit sheet opens');
  eq(text($('#sub-dialog-title')), 'Edit income', 'edit title');
  eq(field('name').value, 'Lodger', 'the undated income');
  eq(text($('#label-renewal')), 'Next payment', 'payment label');
  eq(field('nextRenewal').value, '', 'date not filled in');
  const before = await opStamps('test-lodger');
  setValue('notes', 'Room 2');
  save();
  await tick(50);
  assert(isOpen(), 'sheet stays open');
  eq(errorFor('nextRenewal'), 'Pick a payment date.', 'payment message');
  assert(document.activeElement === field('nextRenewal'), 'date field focused');
  eq((await stored('test-lodger')).notes, '', 'nothing saved');
  setValue('nextRenewal', day(Y, M, 1));
  save();
  await until(() => !isOpen(), 'sheet closes');
  await tick(50);
  eq(written(before, await opStamps('test-lodger')), ['nextRenewal', 'notes', 'updatedAt'], 'fields written');
  assert(!incomeNotice(), 'income notice gone');
  eq(await monthIn(0), T(48000), 'Lodger now paid this month');
  eq(share(), `${Math.round((Number(monthTotal().dataset.value) / 48000) * 100)}% of income`, 'and the share is of that');
});

test('new income needs a payment date when monthly or annual, and its date when one-off', async () => {
  $('[data-action="add-income"]').click();
  await until(isOpen, 'income sheet opens');
  assert(!$('#field-renewal').hidden, 'date field shown for income');
  eq(text($('#label-renewal')), 'Next payment', 'monthly label');
  setValue('name', 'Test pay');
  setValue('price', '100');
  save();
  await tick(50);
  assert(isOpen(), 'monthly income without a date is not saved');
  eq(errorFor('nextRenewal'), 'Pick a payment date.', 'monthly message');
  dialog().querySelector('input[name="cycle"][value="annual"]').click();
  eq(text($('#label-renewal')), 'Next payment', 'annual label');
  save();
  await tick(50);
  assert(isOpen(), 'annual income without a date is not saved');
  eq(errorFor('nextRenewal'), 'Pick a payment date.', 'annual message');
  dialog().querySelector('input[name="cycle"][value="once"]').click();
  assert($('#field-renewal').hidden && !$('#field-date').hidden, 'one-off shows its Date field');
  // The label is "Date", with the word "required" beside it (1.21.1).
  eq(text($('#field-date .field-label > span:first-child')), 'Date', 'one-off label, as for expenses');
  eq(text($('#field-date .field-label')), 'Date required', 'marked required in words');
  eq(errorFor('nextRenewal'), '', 'payment error cleared');
  setValue('date', '');
  save();
  await tick(50);
  assert(isOpen(), 'one-off income without a date is not saved');
  eq(errorFor('date'), 'Pick the date it happens.', 'one-off message');
  dialog().querySelector('input[name="cycle"][value="monthly"]').click();
  setValue('nextRenewal', day(Y, M, 28));
  save();
  await until(() => !isOpen(), 'monthly income with a date saves');
  const pay = (await storage.getAll()).find((s) => s.name === 'Test pay');
  eq([pay.type, pay.cycle, pay.nextRenewal, pay.date], ['income', 'monthly', day(Y, M, 28), ''], 'stored');
});

test('switching the form between expense and income swaps the date wording', async () => {
  $('[data-action="add"]').click();
  await until(isOpen, 'add sheet opens');
  setValue('name', 'Switch');
  setValue('price', '1');
  save();
  await tick(50);
  eq(errorFor('nextRenewal'), 'Pick a renewal date.', 'expense message');
  dialog().querySelector('input[name="kind"][value="income"]').click();
  eq(text($('#label-renewal')), 'Next payment', 'income label');
  eq(errorFor('nextRenewal'), '', 'the renewal message is cleared');
  dialog().querySelector('input[name="kind"][value="expense"]').click();
  eq(text($('#label-renewal')), 'Next renewal', 'expense label');
  $('#sub-dialog [data-close]').click();
  await until(() => !isOpen(), 'sheet closes');
});

test('income never says "Renews": the income card lists it by name and amount; its dates say "Payment"', async () => {
  // Since 1.21.0 income is listed on its own card (name and amount), not among the groups.
  assert(!$('#subs-list [data-id="test-salary"]'), 'not among the groups');
  $('#income-toggle').click();
  const row = $('#income-list [data-id="test-salary"]');
  const salary = (await storage.getAll()).find((s) => s.id === 'test-salary');
  assert(row && text(row).includes('Salary') && text(row).includes(money(salary.price, salary.currency)), `listed with its amount (${text(row)})`);
  assert(!/Renews/.test(text($('#income-list'))), 'no "Renews" for income');
  $('#income-toggle').click();
  assert(/^Payment/.test(renewalText(nextRenewal(salary), true)), 'its date words say Payment');
  const plan = text($('#subs-list [data-id="test-phone"] .tag'));
  assert(/^Renews/.test(plan), `plans still say Renews (${plan})`);
});

/* ------------------------------------------------------------- Year chart */
// These run last, on the data as the tests above left it. Rolling is 13 months with the real
// current month at index 6; This year has it at index M.

const host = () => $('#year-chart');
const chart = () => host()?.yearChart;
const ycSvg = () => $('#year-chart .yc-svg');
const options = () => $$('#year-chart .yc-hit');
const key = (k) => ycSvg().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const settle = () => until(() => chart() && !chart().state().animating, 'chart settles', 6000);
const centreOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const pointer = (type, target, x, y) => target.dispatchEvent(new PointerEvent(type, {
  clientX: x, clientY: y, pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true,
}));
const tapBar = async (i) => {
  const hit = options()[i];
  const c = centreOf(hit);
  pointer('pointerdown', hit, c.x, c.y);
  pointer('pointerup', ycSvg(), c.x, c.y);
  await tick(10);
};
const mode = (m) => $(`[data-insights-mode="${m}"]`).click();
const monthTitle = (k) => { const d = new Date(Y, M + k, 1); return `${d.toLocaleDateString(undefined, { month: 'long' })} ${d.getFullYear()}`; };

test('Month | Year: Year shows the chart and the yearly card; Month is unchanged', async () => {
  $('.tab[data-tab="insights"]').click();
  mode('month');
  const cardMonth = text(monthTotal());
  mode('year');
  assert(chart(), 'chart drawn');
  assert(!$('#insights .month-nav'), 'no month arrows in Year');
  eq(storage.getPref('insightsMode'), 'year', 'remembered');
  eq(text($('#insights .stat-year .stat-label')), String(Y), 'yearly card for this year');
  eq(chart().state().centre, 6, 'rolling, centred on the current month');
  eq(text($('#year-chart .yc-read-name')), `${monthTitle(0)} · now`, 'readout');
  eq(text($('#year-chart .yc-read-total')), cardMonth, 'the chart agrees with the month total');
  mode('month');
  assert($('#insights .month-nav') && !host(), 'Month view is back');
  eq(text(monthTotal()), cardMonth, 'unchanged');
  mode('year');
});

test('every bar has an aria-label and the listbox is one tab stop', async () => {
  eq(options().length, 13, 'rolling: 13 months');
  eq(options()[6].getAttribute('aria-label'), `${monthTitle(0)}, ${text($('#year-chart .yc-read-total'))}`, 'label');
  assert(options().every((o) => /^\S+ \d{4}, /.test(o.getAttribute('aria-label'))), 'all labelled');
  assert(options().every((o) => !o.hasAttribute('tabindex')), 'bars are not tab stops');
  eq(ycSvg().getAttribute('tabindex'), '0', 'the chart is');
  eq(ycSvg().getAttribute('aria-activedescendant'), options()[6].id, 'active = centre');
  eq($('#year-chart [aria-live]').getAttribute('aria-live'), 'polite', 'live readout');
});

test('range toggle: This year is 12 months (the year only on months past the seam), Rolling 13 with the year under each month', async () => {
  $('[data-year-range="year"]').click();
  await settle();
  eq(options().length, 12, '12 months');
  eq(chart().state().centre, M, 'centred on the current month');
  // A month drawn on the far side of the loop's seam (its place in the loop isn't its place in the year).
  const wrapped = (i) => ((((i - M + 6) % 12) + 12) % 12) - 6 !== i - M;
  const years = $$('#year-chart .yc-year');
  eq(years.map((e) => e.getAttribute('display') !== 'none'), years.map((_, i) => wrapped(i)), 'a year label only past the seam');
  eq(storage.getPref('yearRange'), 'year', 'remembered');
  $('[data-year-range="roll"]').click();
  await settle();
  eq(options().length, 13, '13 months');
  eq($$('#year-chart .yc-year').length, 13, "'YY under every month");
  eq(text($$('#year-chart .yc-year')[0]), `'${String(new Date(Y, M - 6, 1).getFullYear()).slice(2)}`, 'first month’s year');
});

test('stack toggle: By category on a fresh device, crossfades on the same chart, the choice is kept', async () => {
  const pressedStack = () => $$('[data-year-stack]').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.yearStack);
  eq(storage.getPref('yearStack'), null, 'nothing saved on this device');
  eq([chart().state().stack, pressedStack()], ['category', ['category']], 'a fresh device starts By category');
  assert(text($('#year-chart .yc-legend')).includes('Utilities'), 'category legend');
  const before = chart();
  $('[data-year-stack="type"]').click();
  eq(chart(), before, 'no redraw');
  eq([chart().state().stack, pressedStack()], ['type', ['type']], 'by type');
  eq(storage.getPref('yearStack'), 'type', 'the choice is saved on this device');
  await settle();
  assert(text($('#year-chart .yc-legend')).includes('Monthly plans'), 'type legend');
  $('[data-year-stack="category"]').click();
  await settle();
  eq([chart().state().stack, storage.getPref('yearStack')], ['category', 'category'], 'and back, saved');
  assert(text($('#year-chart .yc-legend')).includes('Utilities'), 'category legend again');
  $('[data-year-stack="type"]').click(); // the tests after this read the By type legend
  await settle();
  eq(chart().state().stack, 'type', 'by type for the next tests');
});

test('Jump to now: faded when centred, full when not, hidden in focus', async () => {
  const now = $('#year-chart .yc-now');
  assert(!now.classList.contains('on'), 'faded on the current month');
  key('ArrowRight');
  await settle();
  eq(chart().state().centre, 7, 'one month on');
  assert(now.classList.contains('on'), 'full when another month is centred');
  eq(text($('#year-chart .yc-read-name')), monthTitle(1), 'readout follows, no "now"');
  now.click();
  await settle();
  eq(chart().state().centre, 6, 'back on now');
  assert(!now.classList.contains('on'), 'faded again');
});

test('keyboard: arrows move, Enter focuses, arrows move within focus, Esc closes', async () => {
  ycSvg().focus();
  key('ArrowLeft');
  await settle();
  eq(chart().state().centre, 5, 'left');
  key('ArrowRight');
  await settle();
  key('Enter');
  await settle();
  const s = chart().state();
  eq([s.focus, s.selected], [true, 6], 'focused on the centre month');
  assert($('#year-chart .yc-dock').classList.contains('hide'), 'dock (and Jump to now) hidden');
  assert($('#year-chart .yc-back').classList.contains('on'), 'All months shown');
  const live = text($('#year-chart [aria-live]'));
  assert(live.startsWith(`${monthTitle(0)}, `) && live.includes('Monthly plans'), `detail announced: ${live}`);
  key('ArrowRight');
  await settle();
  eq(chart().state().selected, 7, 'next month in focus');
  eq(ycSvg().getAttribute('aria-activedescendant'), options()[7].id, 'active follows');
  key('Escape');
  await settle();
  eq(chart().state().focus, false, 'closed');
  eq(chart().state().centre, 7, 'stays on that month');
  $('#year-chart .yc-now').click();
  await settle();
});

test('tap a bar to focus, tap the mini strip to move (wrapping), All months returns', async () => {
  await tapBar(8);
  await settle();
  eq([chart().state().focus, chart().state().selected], [true, 8], 'tapped month focused');
  await tapBar(9);
  await settle();
  eq(chart().state().selected, 9, 'mini strip moves');
  key('ArrowRight'); await settle();
  key('ArrowRight'); await settle();
  key('ArrowRight'); await settle();
  key('ArrowRight'); await settle();
  eq(chart().state().selected, 0, 'wraps from the last month to the first');
  await tapBar(0);
  await settle();
  eq(chart().state().focus, false, 'tapping the focused bar returns');
  await tapBar(3);
  await settle();
  $('#year-chart .yc-back').click();
  await settle();
  eq(chart().state().focus, false, 'All months returns');
  $('#year-chart .yc-now').click();
  await settle();
});

test('swipe: dragging moves the loop, past the seam, and settles on a whole month', async () => {
  const svg = ycSvg();
  const r = svg.getBoundingClientRect();
  const unit = r.width / 360; // px per viewBox unit
  let x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  pointer('pointerdown', svg, x, y);
  // 8 months to the left: 8 × 30 units; past index 12 into index 0, 1.
  for (let k = 0; k < 24; k++) { x -= 10 * unit; pointer('pointermove', svg, x, y); await tick(4); }
  await tick(120); // pause, so the release has no fling
  pointer('pointerup', svg, x, y);
  await settle();
  const s = chart().state();
  eq(s.centre, (6 + 8) % 13, 'eight months on, wrapped round');
  assert(Number.isInteger(s.pos), `settled on a whole month (${s.pos})`);
  eq(s.focus, false, 'a drag is not a tap');
  $('#year-chart .yc-now').click();
  await settle();
});

test('Show income: an income line, and the months-over marker instead of above-average', async () => {
  chip('USD').click();
  const markers = () => ({ above: $$('#year-chart .yc-mark-above').length, over: $$('#year-chart .yc-mark-over').length });
  // USD: Tool 10 /mo, Big 500 in month M+3, Gig 200 income in month M+1 only.
  eq(markers(), { above: 1, over: 0 }, 'income off: the above-average marker (Big)');
  assert(text($('#year-chart .yc-legend')).includes('Above average'), 'explained in the legend');
  $('[data-year-income]').click();
  eq($('[data-year-income]').getAttribute('aria-pressed'), 'true', 'chip on');
  eq(markers(), { above: 0, over: 12 }, 'income on: every month but Gig’s is over; never both markers');
  const d = $('#year-chart .yc-income').getAttribute('d');
  assert(/^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){12}$/.test(d), `one line through 13 months, not across the seam: ${d}`);
  const legend = text($('#year-chart .yc-legend'));
  assert(legend.includes('Income') && legend.includes('More out than in') && !legend.includes('Above average'), legend);
  key('ArrowRight'); await settle();
  key('ArrowRight'); await settle();
  const moved = $('#year-chart .yc-income').getAttribute('d');
  eq((moved.match(/M/g) || []).length, 2, 'the line breaks at the loop seam once it is on screen');
  $('[data-year-income]').click();
  eq(markers(), { above: 1, over: 0 }, 'off again');
  chip('TWD').click();
  mode('month');
});

test('centre highlight: an outline in the pill colour and the label pill; nothing shadow-like, in the carousel or in focus', async () => {
  mode('year');
  await settle();
  const shown = (sel) => $$(`#year-chart ${sel}`)
    .filter((e) => e.getAttribute('display') !== 'none' && Number(e.getAttribute('opacity') ?? 1) > 0.01)
    .map((e) => Number(e.dataset.for));
  const strong = (sel) => $$(`#year-chart ${sel}`)
    .filter((e) => e.getAttribute('display') !== 'none' && Number(e.getAttribute('opacity') ?? 1) > 0.5)
    .map((e) => Number(e.dataset.for));
  const centre = chart().state().centre;
  eq(strong('.yc-outline'), [centre], 'outline on the centre bar');
  eq(strong('.yc-pill'), [centre], 'label pill on the centre month');
  const label = $$('#year-chart .yc-month:not(.yc-year)')[centre];
  assert(label.classList.contains('yc-month-pill'), 'centre label styled for the pill');
  const ring = $(`#year-chart .yc-outline[data-for="${centre}"]`);
  const pill = $(`#year-chart .yc-pill[data-for="${centre}"]`);
  eq(getComputedStyle(ring).stroke, getComputedStyle(pill).fill, 'outline in the pill colour');
  eq(getComputedStyle(ring).strokeWidth, '1.5px', '1.5 wide');
  assert(Number(ring.getAttribute('rx')) > 0, 'rounded');
  // A 1px card-coloured gap between the bar and its outline (the annual segment is the accent too).
  const gap = $(`#year-chart .yc-outline-gap[data-for="${centre}"]`);
  eq(getComputedStyle(gap).stroke, getComputedStyle($('#year-chart .yc-stage')).backgroundColor, 'gap in the card colour');
  eq(getComputedStyle(gap).strokeWidth, '1px', 'a 1px gap');
  const barsLayer = $$('#year-chart .yc-svg > g')[1]; // after the grid: one group per bar, in order
  const segment = [...barsLayer.children[centre].querySelectorAll('rect[style]')].find((r) => r.closest('g[display="none"]') === null);
  eq(Math.round((Number(segment.getAttribute('x')) - Number(ring.getAttribute('x'))) * 100) / 100, 1.75, 'outline 1px off the bar (plus half its stroke)');
  // The monthly type colour: the theme's teal token, not the old slate, in the bars and the legend.
  const teal = getComputedStyle(document.documentElement).getPropertyValue('--type-monthly').trim().toLowerCase();
  assert(['#0e8378', '#5eead4'].includes(teal), `monthly is teal (${teal})`);
  const asRgb = (c) => { const i = document.createElement('i'); i.style.color = c; document.body.append(i); const v = getComputedStyle(i).color; i.remove(); return v; };
  const swatch = $$('#year-chart .yc-key').find((k) => text(k) === 'Monthly plans').querySelector('i');
  eq(getComputedStyle(swatch).backgroundColor, asRgb(teal), 'legend swatch in the teal');
  const monthlySeg = $$('#year-chart .yc-svg rect[style]').find((r) => r.getAttribute('style').includes('--type-monthly'));
  eq(getComputedStyle(monthlySeg).fill, asRgb(teal), 'monthly segments in the teal');
  const noShadows = (where) => {
    assert(!$('#year-chart .yc-spot, #year-chart .yc-shadow'), `no spotlight or shadow layer (${where})`);
    assert(!$('#year-chart filter, #year-chart [filter], #year-chart feGaussianBlur'), `no SVG filters (${where})`);
    const below = $$('#year-chart .yc-svg g rect[style], #year-chart .yc-veil')
      .filter((e) => e.getAttribute('display') !== 'none' && e.closest('g[display="none"]') === null)
      .filter((e) => Number(e.getAttribute('y')) + Number(e.getAttribute('height')) > 340.01 && Number(e.getAttribute('y')) < 340);
    eq(below.length, 0, `nothing in the carousel reaches below the baseline (${where})`);
  };
  noShadows('carousel');
  eq(Number(ring.getAttribute('y')) + Number(ring.getAttribute('height')) + 0.75, 340, 'the outline stroke ends on the baseline');
  const veils = $$('#year-chart .yc-veil').filter((e) => e.getAttribute('display') !== 'none').length;
  assert(veils >= 10, `other bars are muted (${veils} veils)`);
  // It follows the carousel: one month on, the highlight moves with it.
  key('ArrowRight');
  await settle();
  eq(strong('.yc-outline'), [centre + 1], 'outline moved');
  eq(strong('.yc-pill'), [centre + 1], 'pill moved');
  // Focus mode: only the opened bar's own outline.
  key('Enter');
  await settle();
  eq(shown('.yc-outline'), [centre + 1], 'only the opened bar is outlined');
  eq(shown('.yc-pill'), [], 'no pill in focus');
  eq($$('#year-chart .yc-veil').filter((e) => e.getAttribute('display') !== 'none').length, 0, 'no veils in focus');
  assert(!$('#year-chart .yc-spot, #year-chart .yc-shadow, #year-chart filter, #year-chart [filter]'), 'nothing shadow-like in focus');
  const opened = $(`#year-chart .yc-outline[data-for="${centre + 1}"]`);
  eq(getComputedStyle(opened).stroke, getComputedStyle(pill).fill, 'the opened bar keeps the accent outline');
  key('Escape');
  await settle();
  eq(strong('.yc-pill'), [centre + 1], 'back in the carousel');
  $('#year-chart .yc-now').click();
  await settle();
  mode('month');
});

test('no bar covers the axis labels; the dock can scroll clear of the floating buttons', async () => {
  mode('year');
  await settle();
  const overlap = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  const axis = $$('#year-chart .yc-axis').map((e) => e.getBoundingClientRect());
  assert(axis.length >= 3, 'axis labels drawn');
  for (const k of [0, 3, 5]) { // the centre month, then others as they pass the gutter side
    if (k) { for (let j = 0; j < k; j++) key('ArrowLeft'); await settle(); }
    const bars = $$('#year-chart .yc-svg rect[style]').map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.height);
    assert(!axis.some((a) => bars.some((b) => overlap(a, b))), `no bar over a label (${k} months back)`);
  }
  const avg = $('#year-chart .yc-avg').getBoundingClientRect();
  assert(axis.every((a) => a.right < avg.left), 'the average line starts after the labels');
  $('#year-chart .yc-now').click();
  await settle();
  scrollTo(0, document.documentElement.scrollHeight);
  await tick(50);
  const now = $('#year-chart .yc-now').getBoundingClientRect();
  // Insights has no + since 1.20.0; the button still ends clear of the tab bar.
  assert($('#fab-stack').hidden, 'no floating + on Insights');
  const bar = $('.tabbar').getBoundingClientRect();
  assert(now.bottom < bar.top, `Jump to now is above the tab bar (${Math.round(now.bottom)} < ${Math.round(bar.top)})`);
  scrollTo(0, 0);
  mode('month');
});

/* ------------------------------------------------------------ Android Back */
// pressBack() is what the native backButton listener calls (js/app.js bindBackButton). It returns
// 'closed' (the topmost overlay closed), 'kept' (its close path refused, e.g. busy), 'root' (went
// to the Money tab) or 'minimize' (would leave the app). Anything but 'minimize' stays in the app.

const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = (t) => $(`.tab[data-tab="${t}"]`).click();
const confirmOpen = () => $('#confirm-dialog').open;
const confirmTitle = () => text($('#confirm-title'));
const confirmButton = (label) => $$('#confirm-actions button').find((b) => text(b) === label);
const syncDlg = () => $('#sync-dialog');
const syncView = () => $$('#sync-dialog [data-sync-view]').find((v) => !v.hidden)?.dataset.syncView;
const backIs = (expected, msg) => { const got = pressBack(); eq(got, expected, msg); return got; };

test('Back: the add sheet closes as Cancel would, the tab stays, the app stays', async () => {
  goTab('subs');
  $('#fab').click();
  assert(isOpen(), 'sheet open');
  eq(overlays.top(), 'sub-dialog', 'registered on open');
  backIs('closed', 'closed the sheet');
  assert(!isOpen(), 'sheet closed');
  await tick(20); // the dialog's close event, where Cancel's clean-up runs
  assert(!document.body.classList.contains('sheet-open'), 'floating buttons back (same clean-up as Cancel)');
  eq(appTab(), 'subs', 'still on Money');
  eq(overlays.ids(), [], 'nothing left on the stack');
});

test('Back: on the edit sheet, the Delete confirmation closes as Cancel first, then the sheet', async () => {
  const before = (await storage.getAll()).length;
  $('#subs-list [data-id="test-phone"]').click();
  assert(isOpen(), 'edit sheet open');
  $('#btn-delete').click();
  await until(confirmOpen, 'delete confirmation');
  eq(overlays.ids(), ['sub-dialog', 'confirm-dialog'], 'confirmation on top of the sheet');
  backIs('closed', 'closed the confirmation');
  await tick(20);
  assert(!confirmOpen() && isOpen(), 'confirmation gone, sheet still open');
  eq((await storage.getAll()).length, before, 'nothing deleted');
  backIs('closed', 'closed the sheet');
  assert(!isOpen(), 'sheet closed');
  eq((await storage.getAll()).length, before, 'still nothing deleted');
});

test('Back: rapid double Back during the sheet\'s opening animation closes it once, then goes on', async () => {
  goTab('calendar'); // the + is on Money and Calendar only
  $('#fab').click();
  const got = [pressBack(), pressBack()];
  eq(got, ['closed', 'root'], 'one press per level: the sheet, then the Money tab');
  assert(!isOpen(), 'sheet closed');
  eq(appTab(), 'subs', 'on Money');
  eq(overlays.ids(), [], 'stack empty');
});

test('Back: the group colour picker closes', async () => {
  goTab('subs');
  const dot = $('#subs-list .group-dot');
  dot.click();
  assert(!$('#swatch-pop').hidden, 'picker open');
  eq(overlays.top(), 'swatch-pop', 'registered');
  backIs('closed', 'closed the picker');
  assert($('#swatch-pop').hidden, 'picker closed');
  eq(dot.getAttribute('aria-expanded'), 'false', 'same clean-up as Escape');
});

test('Back: the year chart\'s focus mode returns to all months, also mid-animation', async () => {
  goTab('insights');
  mode('year');
  await settle();
  await tapBar(4);
  eq(chart().state().focus, true, 'focused');
  eq(overlays.top(), 'year-focus', 'registered');
  backIs('closed', 'closed focus mode before it finished opening');
  await settle();
  eq(chart().state().focus, false, 'all months');
  eq(appTab(), 'insights', 'still on Insights');
  // Focus left open on another tab is out of sight, so Back there doesn't close it unseen.
  await tapBar(4);
  await settle();
  goTab('settings');
  eq(overlays.top(), null, 'hidden focus mode is skipped');
  backIs('root', 'Settings goes to Money');
  goTab('insights'); // Insights redraws the chart, in all months
  await settle();
  eq(chart().state().focus, false, 'redrawn in all months');
  eq(overlays.ids(), [], 'the old chart took its focus mode off the stack');
  await tapBar(4);
  await settle();
  backIs('closed', 'focus mode on the new chart closes');
  await settle();
  eq(chart().state().focus, false, 'all months');
  mode('month');
  eq(overlays.ids(), [], 'the redrawn chart left nothing behind');
});

test('Back: Sync sheet, recovery words step goes back to the start, then the sheet closes', async () => {
  goTab('settings');
  $('#btn-sync').click();
  await until(() => syncDlg().open, 'sync sheet');
  eq(syncView(), 'setup', 'set-up view');
  $('#sync-start').click();
  await until(() => syncView() === 'recovery', 'recovery step');
  assert($$('[data-sync-view="recovery"] .word-grid li').length === 12, 'words shown');
  eq(overlays.ids(), ['sync-dialog', 'sync-step'], 'the step is on top of the sheet');
  backIs('closed', 'step closed');
  eq(syncView(), 'setup', 'back at the start, like Cancel');
  eq($$('#sync-dialog .word-grid li').length, 0, 'words removed from the page');
  assert(syncDlg().open, 'sheet still open');
  backIs('closed', 'sheet closed');
  assert(!syncDlg().open, 'closed');
  eq(appTab(), 'settings', 'still on Settings');
});

test('Back: Sync join step and the web QR scanner view', async () => {
  const md = navigator.mediaDevices;
  const realGUM = md?.getUserMedia;
  let asked = 0;
  if (md) md.getUserMedia = () => { asked++; return new Promise(() => {}); }; // the camera prompt stays up
  try {
    $('#btn-sync').click();
    await until(() => syncDlg().open, 'sync sheet');
    $('#sync-join-open').click();
    await until(() => syncView() === 'join', 'join step');
    await tick(50);
    if (!$('#sync-scan').hidden) {
      $('#sync-scan-start').click();
      await until(() => !$('#sync-scan-view').hidden, 'scanner view');
      eq(overlays.top(), 'sync-scan', 'scanner on top');
      backIs('closed', 'scanner stopped');
      assert($('#sync-scan-view').hidden && !$('#sync-scan-start').hidden, 'as Stop scanning');
      eq(syncView(), 'join', 'still on Join');
      assert(asked === 1, 'the camera was asked for once');
      await tick(30);
      assert(!text($('#toast-text')).startsWith('Unhandled'), 'stopping during the camera prompt is not reported as an error');
    }
    $('#sync-join-words').value = 'some typed words';
    backIs('closed', 'join step closed');
    eq(syncView(), 'setup', 'back at the start');
    backIs('closed', 'sheet closed');
    await tick(20);
    eq($('#sync-join-words').value, '', 'closing cleared the typed words');
  } finally {
    if (md) { if (realGUM) md.getUserMedia = realGUM; else delete md.getUserMedia; }
  }
});

test('Back: busy while looking for the household does nothing; then the choice and Replace steps cancel', async () => {
  const realFetch = window.fetch;
  const calls = [];
  let release;
  window.fetch = (url, init) => {
    calls.push(String(url));
    // The check reads one entry: hold it, then answer "the household exists".
    return new Promise((r) => { release = () => r(new Response(JSON.stringify({ entries: [], head: 0 }), { status: 200 })); });
  };
  try {
    $('#btn-sync').click();
    await until(() => syncDlg().open, 'sync sheet');
    $('#sync-join-open').click();
    await until(() => syncView() === 'join', 'join step');
    $('#sync-join-words').value = (await keyToWords(generateKey())).join(' ');
    $('#sync-join').click();
    await until(() => !$('#sync-busy').hidden && calls.length === 1, 'busy, checking');
    for (let i = 0; i < 3; i++) backIs('kept', `Back ${i + 1} while busy`);
    assert(syncDlg().open && syncView() === 'join', 'sheet and step unchanged');
    eq(appTab(), 'settings', 'no tab change');
    release();
    await until(() => syncView() === 'choice', 'choice step');
    assert($('#sync-busy').hidden, 'not busy');
    assert(!$('#sync-choice-go').disabled, 'buttons enabled again (screen not locked)');
    backIs('closed', 'choice cancelled');
    eq(syncView(), 'join', 'back on Join, as Cancel');
    await tick(20);
    eq(syncView(), 'join', 'and stays there');

    $('#sync-join').click();
    await until(() => calls.length === 2, 'checking again');
    release();
    await until(() => syncView() === 'choice', 'choice step again');
    $('#sync-dialog input[name="join-mode"][value="replace"]').checked = true;
    $('#sync-choice-go').click();
    await until(confirmOpen, 'replace confirmation');
    eq(overlays.top(), 'confirm-dialog', 'confirmation on top');
    backIs('closed', 'confirmation closed');
    await until(() => syncView() === 'join', 'cancelled back to Join');
    assert(calls.every((u) => u.includes('/pull')), 'only the household check reached the relay: nothing joined or replaced');
    assert(!(await storage.getSyncConfig()).enabled, 'sync not set up');
    backIs('closed', 'join step closed');
    backIs('closed', 'sheet closed');
    assert(!syncDlg().open, 'closed');
  } finally {
    window.fetch = realFetch;
  }
});

async function chooseBackup(json) {
  const input = $('#import-file');
  const dt = new DataTransfer();
  dt.items.add(new File([json], 'backup.json', { type: 'application/json' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await until(confirmOpen, 'import dialog');
}

test('Back: import dialogs cancel; Back on the Replace all confirmation cancels and replaces nothing', async () => {
  goTab('settings');
  const before = await storage.getAll();
  const backup = await storage.exportAll();
  backup.items = backup.items.slice(0, 1); // replacing would leave one item
  const json = JSON.stringify(backup);

  await chooseBackup(json);
  eq(confirmTitle(), 'Import this backup?', 'first dialog');
  backIs('closed', 'first dialog closed');
  await tick(30);
  assert(!confirmOpen(), 'no second dialog: cancelled');

  await chooseBackup(json);
  confirmButton('Replace all').click();
  await until(() => confirmOpen() && confirmTitle() !== 'Import this backup?', 'Replace all confirmation');
  eq(overlays.top(), 'confirm-dialog', 'on the stack');
  backIs('closed', 'Back on the second confirmation');
  await tick(50);
  assert(!confirmOpen(), 'closed');
  eq((await storage.getAll()).length, before.length, 'nothing replaced');
  eq(appTab(), 'settings', 'still on Settings');
});

test('Back: during a running import goes to Money and the import still finishes', async () => {
  const backup = await storage.exportAll();
  await chooseBackup(JSON.stringify(backup));
  confirmButton('Merge').click();
  backIs('root', 'no overlay open while it imports: Money tab');
  await until(() => text($('#toast-text')).startsWith('Merged'), 'import finished');
  eq(appTab(), 'subs', 'on Money');
  eq(overlays.ids(), [], 'nothing stuck on the stack');
  $('#fab').click();
  assert(isOpen(), 'the app still responds');
  backIs('closed', 'and Back still works');
});

test('Back: with nothing open, Insights and Settings go to Money; Money leaves the app (minimise)', async () => {
  goTab('insights');
  backIs('root', 'Insights → Money');
  eq(appTab(), 'subs', 'on Money');
  goTab('settings');
  backIs('root', 'Settings → Money');
  backIs('minimize', 'Money with nothing open');
  eq(typeof globalThis.Capacitor, 'undefined', 'web: no native bridge, so no listener and the browser\'s Back is unchanged');
});

/* ------------------------------------------------------------------ Bottom-nav pill, Export as CSV */

const pillEl = () => $('.tabbar .tab-pill');
const tabEl = (t) => $(`.tab[data-tab="${t}"]`);
const pillRest = () => parseFloat(getComputedStyle(pillEl()).getPropertyValue('--tab-pill-w'));
const pillWidth = () => pillEl().getBoundingClientRect().width;
/** Whether the pill sits centred on `tab`, at its resting width, inside the tab's height (to half a pixel). */
function pillOn(tab) {
  const p = pillEl().getBoundingClientRect();
  const t = tabEl(tab).getBoundingClientRect();
  return Math.abs(p.width - Math.min(pillRest(), t.width)) < 0.6
    && Math.abs((p.left + p.right) / 2 - (t.left + t.right) / 2) < 0.6
    && p.top >= t.top - 0.5 && p.bottom <= t.bottom + 0.5;
}
/** The pill's widths, one per frame, for `ms`. */
async function pillWidths(ms) {
  const out = [];
  const end = performance.now() + ms;
  while (performance.now() < end) { out.push(pillWidth()); await new Promise((r) => requestAnimationFrame(r)); }
  return out;
}
/** Run `fn` with this device's Reduce motion setting at `pref` ('on' / 'off'), then put it back. */
async function withMotionPref(pref, fn) {
  const was = localStorage.getItem('substracker.reduceMotion');
  storage.setPref('reduceMotion', pref);
  try { await fn(); } finally {
    if (was === null) localStorage.removeItem('substracker.reduceMotion'); else storage.setPref('reduceMotion', was);
  }
}

test('Pill: decoration only; the tabs keep their roles, keyboard and focus', async () => {
  eq($$('.tabbar .tab-pill').length, 1, 'one pill');
  eq(pillEl().getAttribute('aria-hidden'), 'true', 'hidden from screen readers');
  eq(getComputedStyle(pillEl()).pointerEvents, 'none', 'takes no taps');
  eq(pillEl().tabIndex, -1, 'not focusable');
  eq($$('.tabbar [role="tab"]').map((t) => t.dataset.tab), ['subs', 'calendar', 'insights', 'settings'], 'four tabs (Calendar since 1.20.0; tests/nav.html moves the pill to it)');
  goTab('subs');
  await until(() => pillOn('subs'), 'the pill on Money', 2000);
  tabEl('subs').focus();
  $('.tabbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  eq([appTab(), document.activeElement?.id], ['calendar', 'tab-calendar'], 'arrow keys still move the selection and focus');
  eq($$('.tab').map((t) => [t.getAttribute('aria-selected'), t.tabIndex]), [['false', -1], ['true', 0], ['false', -1], ['false', -1]], 'roving tabindex');
  await until(() => pillOn('calendar'), 'the pill follows the keyboard', 2000);
  $('.tabbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  $('.tabbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  eq([appTab(), document.activeElement?.id], ['settings', 'tab-settings'], 'and wrap round the four');
  await until(() => pillOn('settings'), 'the pill too', 2000);
});

test('Pill: a tap slides it over with a stretch, and it settles exactly on the new tab', async () => {
  await withMotionPref('off', async () => {
    goTab('subs');
    await until(() => pillOn('subs'), 'on Money', 2000);
    const rest = pillWidth();
    const start = performance.now();
    goTab('settings');
    assert(!pillOn('settings'), 'it moves over time, not in one jump');
    const widths = await pillWidths(250);
    assert(Math.max(...widths) > rest * 1.25, `it stretches on the way (max ${Math.round(Math.max(...widths))} px, rest ${Math.round(rest)} px)`);
    await until(() => pillOn('settings'), 'settled on Settings', 2000);
    const took = performance.now() - start;
    assert(took < 900, `settles quickly (${Math.round(took)} ms)`);
    const after = await pillWidths(80);
    assert(after.every((w) => Math.abs(w - rest) < 0.6), 'and stays at its resting width');
  });
});

test('Pill: with Reduce motion and effects it just moves: no stretch, no spring', async () => {
  await withMotionPref('on', async () => {
    goTab('subs');
    assert(pillOn('subs'), 'on Money at once');
    const rest = pillWidth();
    goTab('insights');
    assert(pillOn('insights'), 'on Insights at once');
    goTab('settings');
    assert(pillOn('settings'), 'on Settings at once');
    const widths = await pillWidths(120);
    assert(widths.every((w) => Math.abs(w - rest) < 0.6), 'never stretched');
    assert(pillOn('settings'), 'still there');
  });
});

test('Pill: Back to Money moves it the same way', async () => {
  await withMotionPref('off', async () => {
    goTab('insights');
    await until(() => pillOn('insights'), 'on Insights', 2000);
    const rest = pillWidth();
    backIs('root', 'Back from Insights goes to Money');
    eq(appTab(), 'subs', 'Money');
    const widths = await pillWidths(200);
    assert(Math.max(...widths) > rest * 1.15, 'it slides with the stretch');
    await until(() => pillOn('subs'), 'settled on Money', 2000);
    goTab('settings');
    await until(() => pillOn('settings'), 'on Settings', 2000);
    backIs('root', 'Back from Settings goes to Money');
    await until(() => pillOn('subs'), 'and the pill is back on Money', 2000);
  });
});

test('Pill: stays on the active tab when the bar changes size (rotation, insets)', async () => {
  goTab('insights');
  await until(() => pillOn('insights'), 'on Insights', 2000);
  const bar = $('.tabbar');
  bar.style.right = '140px';
  try {
    await until(() => pillOn('insights'), 'follows a narrower bar', 2000);
    bar.style.paddingLeft = '48px'; // a safe-area inset on the left
    await until(() => pillOn('insights'), 'follows an inset', 2000);
  } finally {
    bar.style.right = '';
    bar.style.paddingLeft = '';
  }
  await until(() => pillOn('insights'), 'and back', 2000);
  goTab('subs');
});

/* ------------------------------------------------------------------ Wallet */
// The Money tab's Wallet view (js/wallet.js). Cards in stack order for the seed: Health (only
// undated plans), Utilities (Phone 499 and Cloud 1,200 this month), Uncategorised (Domain, six
// months away, plus the two USD plans). Income has its own card above the stack since 1.21.0
// (tests/money-card.html tests it and its gauge).
const wallet = () => $('#wallet')?.wallet;
const wCards = () => $$('#wallet .w-card');
const wCard = (name) => wCards().find((c) => text($('.w-name', c)) === name);
const wBand = (name) => wCard(name)?.querySelector('.w-band');
/** Pick a Money view from the header's View menu, the way a person does (js/app.js bindViewMenu). */
function pickView(v) {
  $('#view-btn').click();
  assert(!$('#view-menu').hidden, 'the View menu opens');
  $(`#view-menu [data-view="${v}"]`).click();
}
const wSettled = () => until(() => wallet() && !wallet().state().animating, 'the wallet settles', 4000);
const cssToken = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().toLowerCase();

test('Wallet: a saved Grid choice is kept; Wallet | Grid | List is remembered per device, never exported', async () => {
  goTab('subs');
  eq($('#view-btn').dataset.view, 'grid', 'this device chose Grid before (the runner saved it): kept');
  eq($('#view-btn').getAttribute('aria-label'), 'View: Cards. Sort: A to Z', 'the View button names it');
  eq($$('#view-menu [data-view]').map((b) => [b.dataset.view, b.getAttribute('aria-checked')]), [['wallet', 'false'], ['grid', 'true'], ['list', 'false']],
    'three views (Calendar is a tab since 1.20.0; tests/calendar.html and tests/nav.html test it)');
  pickView('wallet');
  assert($('#subs-list #wallet'), 'the wallet is shown');
  eq(localStorage.getItem('substracker.view'), 'wallet', 'remembered on this device');
  eq(viewItem('wallet').getAttribute('aria-checked'), 'true', 'checked in the menu');
  eq($('#view-btn').dataset.view, 'wallet', 'and the button\'s icon is the Wallet\'s');
  const icons = $$('#view-btn > .icon').filter((i) => i.getClientRects().length).map((i) => i.dataset.icon);
  eq(icons, ['wallet'], 'one icon shown: the view in use');
  pickView('list');
  assert(!$('#subs-list #wallet') && $('#subs-list .sub-row'), 'the list instead');
  eq(localStorage.getItem('substracker.view'), 'list', 'List remembered');
  pickView('wallet');
  await wSettled();
  const backup = JSON.stringify(await storage.exportAll());
  assert(!backup.includes('"view"') && !backup.includes('wallet'), 'not in a backup');
  assert(!('view' in await storage.getSettings()), 'not a (synced) setting');
});

// Earlier tests edit the seed (prices, dates), so these compare with the items as they are now,
// worked out independently with insights-calc's dueInMonth, and with the Money card on screen.
const money$ = (s) => Number(String(s).replace(/[^\d.-]/g, '')) || 0;
const cardTotal = (c) => { const t = text($('.w-total', c)); return /\d/.test(t) && !t.startsWith('+') ? money$(t) : 0; };
// The Money card's figures, named as the yearly card names them (its Cash due is the Outgoings).
const walletStrip = () => ({
  Income: text($('#money-summary [data-roll="income"]')),
  Outgoings: text($('#money-summary [data-roll="cash"]')),
  'Left over': text($('#money-summary [data-roll="left"]')),
});

test('Wallet: card totals match the Money card, month and year; other currencies shown apart, never added', async () => {
  const items = await storage.getAll();
  eq(wCards().map((c) => text($('.w-name', c))), ['Health', 'Utilities', 'Uncategorised'], 'the Money tab groups, no Income card');
  assert(!$('#income-card').hidden, 'income has its own card');
  let usdShown = 0;
  for (const period of ['monthly', 'annual']) {
    $(`#money-summary [data-period="${period}"]`).click();
    await wSettled();
    const word = period === 'annual' ? 'this year' : 'this month';
    const due = (s) => (period === 'annual' ? [...Array(12).keys()].reduce((t, m) => t + dueInMonth(s, Y, m), 0) : dueInMonth(s, Y, M));
    const expense = wCards();
    eq(T(expense.reduce((t, c) => t + cardTotal(c), 0)), walletStrip().Outgoings, `${period}: the cards add up to the Money card's Cash due`);
    for (const c of expense) {
      const name = text($('.w-name', c));
      const mine = items.filter((s) => !isIncome(s) && groupOf(s) === name);
      const twd = mine.filter((s) => s.currency === 'TWD').reduce((t, s) => t + due(s), 0);
      const usd = mine.filter((s) => s.currency === 'USD' && due(s) > 0).length;
      eq(cardTotal(c), twd, `${period}: ${name} total`);
      const n = `${mine.length} item${mine.length === 1 ? '' : 's'}`;
      eq(c.querySelector('.w-band').getAttribute('aria-label'),
        `${name}, ${n}, ${twd ? `${T(twd)} ${word}` : `nothing due ${word}`}${usd ? `, plus ${usd} in USD` : ''}`, `${period}: ${name} label`);
      if (usd) {
        assert(`${text($('.w-total', c))} ${text($('.w-sub', c))}`.includes(`+${usd} in USD`), `${period}: ${name} shows the USD apart`);
        usdShown++;
      }
      if (!twd && !usd) eq(text($('.w-total', c)), 'Nothing due', `${period}: ${name} says Nothing due`);
    }
  }
  assert(usdShown >= 2, 'the seed has USD plans due in both periods');
  $('#money-summary [data-period="monthly"]').click();
  await wSettled();
});

test('Wallet: tap opens a card to its items; an item opens the edit sheet; Back, Escape and the band close it', async () => {
  const w = wallet();
  w.close();
  wBand('Utilities').click();
  await until(() => w.state().open === 'g:Utilities' && !w.state().animating, 'opened');
  eq(wBand('Utilities').getAttribute('aria-expanded'), 'true', 'expanded');
  eq(overlays.top(), 'wallet-card', 'on the overlay stack');
  const count = Number(text($('.w-meta', wCard('Utilities'))).split(' ')[0]);
  eq($$('#wallet .w-card.is-open .w-item').length, count, 'every item');
  assert(wCards().filter((c) => c !== wCard('Utilities')).every((c) => c.inert), 'the other cards are out of reach');
  assert(wCard('Utilities').offsetHeight < $('#wallet').offsetHeight, 'the open card fits its items, not the whole stack');
  const total = text($('.w-total', wCard('Utilities')));
  await until(() => text($('#wallet [aria-live]')) === `Utilities opened. ${count} items, ${total} due this month.`, 'announced');
  $('#wallet .w-item[data-id="test-phone"]').click();
  assert(isOpen(), 'the edit sheet');
  eq(overlays.ids(), ['wallet-card', 'sub-dialog'], 'sheet on top of the card');
  backIs('closed', 'Back closes the sheet first');
  await tick(20);
  assert(!isOpen() && w.state().open === 'g:Utilities', 'the card is still open');
  backIs('closed', 'then the card');
  await until(() => w.state().open === null && !w.state().animating, 'closed');
  eq(appTab(), 'subs', 'still on Money');
  await until(() => text($('#wallet [aria-live]')) === 'Utilities closed.', 'announced');
  wBand('Health').click();
  await until(() => w.state().open === 'g:Health', 'opened Health');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await until(() => w.state().open === null && !w.state().animating, 'Escape closes');
  wBand('Utilities').click();
  await until(() => w.state().open === 'g:Utilities' && !w.state().animating, 'open again');
  wBand('Utilities').click();
  await until(() => w.state().open === null && !w.state().animating, 'tapping the card again closes it');
  eq(overlays.ids(), [], 'nothing left on the stack');
});

test('Wallet: editing an item updates the stack and the Money card; an open card stays open', async () => {
  const w = wallet();
  w.close();
  const phone = (await storage.getAll()).find((s) => s.id === 'test-phone');
  const before = cardTotal(wCard('Utilities'));
  const outBefore = money$(walletStrip().Outgoings);
  wBand('Utilities').click();
  await until(() => w.state().open === 'g:Utilities' && !w.state().animating, 'opened');
  $('#wallet .w-item[data-id="test-phone"]').click();
  $('#sub-form [name="price"]').value = String(phone.price + 100);
  $('#sub-form').requestSubmit();
  await until(() => !isOpen() && cardTotal(wCard('Utilities')) === before + 100, 'the new total');
  eq(w.state().open, 'g:Utilities', 'still open, redrawn');
  eq(money$(walletStrip().Outgoings), outBefore + 100, 'the Money card agrees');
  $('#wallet .w-item[data-id="test-phone"]').click();
  $('#sub-form [name="price"]').value = String(phone.price);
  $('#sub-form').requestSubmit();
  await until(() => !isOpen() && cardTotal(wCard('Utilities')) === before, 'back as it was');
  backIs('closed', 'close the card');
  await wSettled();
});


test('Wallet: keyboard: Tab reaches each card, arrow keys move between them', async () => {
  const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  wBand('Health').focus();
  key('ArrowDown');
  eq(document.activeElement, wBand('Utilities'), 'down');
  key('End');
  eq(document.activeElement, wBand('Uncategorised'), 'End');
  key('ArrowUp');
  eq(document.activeElement, wBand('Utilities'), 'up');
  key('Home');
  eq(document.activeElement, wBand('Health'), 'Home');
  assert(wCards().every((c) => c.querySelector('.w-band').tabIndex === 0 && !c.inert), 'every band is a tab stop');
  eq(getComputedStyle(wCards().at(-1)).visibility, 'visible', 'off-screen cards stay focusable');
  document.activeElement.blur();
  await wSettled();
});

test('Wallet: palette colours in stack order; text keeps 4.5:1 in both themes; picked colours stay', async () => {
  const fill = (name) => wCard(name).style.getPropertyValue('--card').toLowerCase();
  for (const theme of ['light', 'dark']) {
    $('#set-theme').value = theme; $('#set-theme').dispatchEvent(new Event('change'));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    eq([fill('Health'), fill('Utilities'), fill('Uncategorised')], ['--wallet-1', '--wallet-2', '--wallet-3'].map(cssToken), `${theme}: slots 1–3 in order`);
    eq(parseColour(getComputedStyle($('#income-card')).backgroundColor), parseColour(cssToken('--wallet-income')), `${theme}: the income card is neutral`);
    for (const c of wCards()) {
      const ink = parseColour(getComputedStyle(c).color);
      for (const v of ['--card-top', '--card', '--card-bot']) {
        const bg = parseColour(c.style.getPropertyValue(v));
        assert(contrast(ink, bg) >= 4.5, `${theme} ${text($('.w-name', c))} on ${v}: ${contrast(ink, bg).toFixed(2)}`);
      }
    }
    for (const f of wallet().state().fits) assert(f.ratio >= 4.5 && f.ratio2 >= 4.5, `${theme} ${f.key}: fitted ${f.ratio.toFixed(2)} / ${f.ratio2.toFixed(2)}`);
  }
  $('#set-theme').value = 'system'; $('#set-theme').dispatchEvent(new Event('change'));
  // Pick a colour for Health (from the grid's colour dot): it stays exactly as picked in the wallet.
  pickView('grid');
  $('#subs-list .group-dot[data-group="Health"]').click();
  $('#swatch-grid [data-swatch="g6"]').click();
  await until(async () => (await storage.getSettings()).groupColors.Health === 'g6', 'saved as a pick');
  pickView('wallet');
  await wSettled();
  eq(fill('Health'), cssToken('--group-6'), 'the picked swatch');
  eq(fill('Utilities'), cssToken('--wallet-2'), 'the others keep theirs');
  const fills = wCards().map((c) => c.style.getPropertyValue('--card'));
  assert(fills.every((f, i) => i === 0 || f !== fills[i - 1]), 'no two neighbours alike');
  // A backup carries the picked colour only: automatic Wallet colours stay on this device.
  const blobs = [];
  const realUrl = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return realUrl.call(URL, b); };
  try {
    $('#btn-export').click();
    await until(() => blobs.length === 1, 'the backup file');
  } finally { URL.createObjectURL = realUrl; }
  const file = JSON.parse(await blobs[0].text());
  eq(file.settings.groupColors, { Health: 'g6' }, 'only the picked swatch is in the backup');
  assert(Object.values((await storage.getSettings()).groupColors).some(isWalletKey), 'the automatic colours are kept on the device');
});

test('Wallet: Reduce motion and effects: a plain list, no tilt or springs; a card opens and closes at once', async () => {
  $('#set-motion').checked = true; $('#set-motion').dispatchEvent(new Event('change'));
  try {
    const w = wallet();
    assert($('#wallet').classList.contains('is-reduced'), 'list mode');
    assert(wCards().every((c) => getComputedStyle(c).transform === 'none' && getComputedStyle(c).position === 'relative'), 'no 3D, in the page flow');
    const frames = w.state().frames;
    wBand('Utilities').click();
    eq(w.state().open, 'g:Utilities', 'open at once');
    eq(w.state().animating, false, 'no spring');
    eq(wCards().filter((c) => getComputedStyle(c).display !== 'none').length, 1, 'only the open card');
    eq(overlays.top(), 'wallet-card', 'Back still closes it');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    eq(w.state().open, null, 'closed at once');
    eq(wCards().filter((c) => getComputedStyle(c).display !== 'none').length, 3, 'all cards again');
    eq(w.state().frames, frames, 'not a single animation frame');
  } finally {
    $('#set-motion').checked = false; $('#set-motion').dispatchEvent(new Event('change'));
  }
  await wSettled();
  assert(!$('#wallet').classList.contains('is-reduced'), 'the stack is back');
});

test('Wallet: one group, a group with nothing due, and no groups at all', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const w = createWallet(host, {
    reduced: () => false, viewport: () => ({ height: 400, inset: 0 }),
    logo: (s, size) => logoHTML(s, size, { neutral: true, defer: true }), loadLogos: () => {},
  });
  try {
    const ctx = { currency: 'TWD', period: 'monthly', year: Y, month: M };
    const items = [{ ...base, id: 'w-duo', name: 'Duolingo', price: 2490, cycle: 'annual', nextRenewal: day(Y, M + 2, 20), category: 'Education' }];
    w.update({ ...ctx, groups: walletGroups(items, ctx).map((g) => ({ ...g, fillVar: '--wallet-1' })) });
    eq(host.querySelectorAll('.w-card').length, 1, 'one card');
    eq(text(host.querySelector('.w-total')), 'Nothing due', 'nothing due this month');
    eq(host.querySelector('.w-band').getAttribute('aria-label'), 'Education, 1 item, nothing due this month', 'label');
    assert(text(host.querySelector('.w-preview')).includes('Nothing due this month'), 'the front card says so');
    assert(text(host.querySelector('.w-preview')).includes('Next: Duolingo'), 'and what comes next');
    eq(w.state().maxScroll, 0, 'nothing to scroll');
    assert(host.querySelector('.logo-neutral'), 'logos on neutral tiles');
    w.update({ ...ctx, groups: [] });
    eq(host.querySelectorAll('.w-card').length, 0, 'no groups: no cards');
  } finally {
    w.destroy();
    host.remove();
  }
  // The app with no items shows its empty state instead (the wallet needs at least one item).
  assert($('#subs-empty').hidden && !$('#subs-list').hidden, 'with items: the wallet, not the empty state');
});

test('Year chart: the key hides behind Show key (remembered per device); focus mode still names each segment', async () => {
  goTab('insights');
  mode('year');
  await settle();
  const btn = () => $('#year-chart .yc-keybtn');
  const legend = () => $('#year-chart .yc-legend');
  eq(text(btn()), 'Show key', 'the toggle');
  assert(legend().hidden, 'the key starts hidden');
  eq(btn().getAttribute('aria-expanded'), 'false', 'collapsed');
  eq(btn().getAttribute('aria-controls'), legend().id, 'controls the key');
  btn().click();
  assert(!legend().hidden && text(legend()).length > 0, 'shown, with its entries');
  eq(text(btn()), 'Hide key', 'Hide key');
  eq(localStorage.getItem('substracker.yearKey'), 'on', 'remembered on this device');
  mode('month');
  mode('year');
  await settle();
  assert(!legend().hidden, 'still shown after a redraw');
  btn().click();
  assert(legend().hidden, 'hidden again');
  eq(localStorage.getItem('substracker.yearKey'), 'off', 'remembered');
  await tapBar(chart().state().centre);
  await settle();
  eq(chart().state().focus, true, 'focus mode');
  assert(text($('#year-chart .yc-svg')).includes('Phone'), 'the open month names its segments');
  backIs('closed', 'Back leaves focus mode');
  await settle();
  mode('month');
  goTab('subs');
});

/* ------------------------------------------------------------------ Sort groups */
// The Money tab's Sort (js/app.js bindSortMenu, js/wallet-math.js sortGroups). The seed's groups:
// Health (Gym, Yoga: undated, nothing due), Utilities (Phone, Cloud: due this month) and
// Uncategorised (Domain, six months away, plus two USD plans). One extra group, Aardvark, with a
// small TWD amount due this month, makes Total differ from A to Z.
// Sort is the second group of the header's View menu (since 1.20.0; the Sort button before).
const sortBtn = () => $('#view-btn');
const sortMenu = () => $('#view-menu');
const sortItem = (k) => $(`#view-menu [data-sort="${k}"]`);
const viewItem = (v) => $(`#view-menu [data-view="${v}"]`);
/** The accent colour as computed (rgb), to compare with the View button's. */
const accentColour = () => getComputedStyle($('#tab-subs[aria-selected="true"]') ?? document.body).color;
const walletOrder = () => wCards().map((c) => text($('.w-name', c)));
const sectionOrder = () => $$('#subs-list .money-group .section-title > span').map((el) => el.firstChild.textContent.trim());
const AARDVARK = { ...base, id: 'test-sort-aardvark', name: 'Ant food', price: 50, cycle: 'monthly', nextRenewal: day(Y, M, 3), category: 'Aardvark' };
/** Pick an order from the Sort menu the way a person does: open it, click the item. */
function pickSort(k) {
  sortBtn().click();
  assert(!sortMenu().hidden, 'menu open');
  sortItem(k).click();
}
/** Expected orders worked out from the items themselves (not with sortGroups). */
async function expectedOrders() {
  const items = (await storage.getAll()).filter((s) => !isIncome(s));
  const groups = new Map();
  for (const s of items) {
    const g = groupOf(s);
    if (!groups.has(g)) groups.set(g, { name: g, n: 0, twd: 0, total: 0 });
    const e = groups.get(g);
    e.n++;
    if (s.currency === 'TWD') { e.twd++; e.total += dueInMonth(s, Y, M); }
  }
  const az = (a, b) => (a.name === 'Uncategorised') - (b.name === 'Uncategorised') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const list = [...groups.values()];
  const only = (g) => g.n > 0 && g.twd === 0;
  // Income is never a group (its own card since 1.21.0), in any order.
  return {
    az: list.slice().sort(az).map((g) => g.name),
    total: list.slice().sort((a, b) => only(a) - only(b) || (only(a) ? b.n - a.n : b.total - a.total) || az(a, b)).map((g) => g.name),
    items: list.slice().sort((a, b) => b.n - a.n || az(a, b)).map((g) => g.name),
  };
}

test('Sort: A to Z by default (today\'s order); the View menu is labelled, keyboard operable and on the overlay stack', async () => {
  goTab('subs');
  pickView('wallet');
  await wSettled();
  eq(localStorage.getItem('substracker.groupSort'), null, 'never chosen on this device');
  eq(sortBtn().getAttribute('aria-label'), 'View: Wallet. Sort: A to Z', 'the button says the view and the order in use');
  assert(getComputedStyle(sortBtn()).color !== accentColour(), 'A to Z: not the accent colour');
  eq(sortBtn().getAttribute('aria-haspopup'), 'menu', 'opens a menu');
  eq(sortBtn().getAttribute('aria-expanded'), 'false', 'closed');
  eq(walletOrder(), (await expectedOrders()).az, 'the order the Money tab always had');
  sortBtn().click();
  assert(!sortMenu().hidden, 'opens');
  eq(sortBtn().getAttribute('aria-expanded'), 'true', 'expanded');
  eq([sortMenu().getAttribute('role'), sortMenu().getAttribute('aria-label')], ['menu', 'View and sort'], 'a menu, labelled');
  eq($$('#view-menu [role="group"]').map((g) => text($(`#${g.getAttribute('aria-labelledby')}`))), ['View', 'Sort groups'], 'two labelled groups: View, then Sort groups');
  eq($$('#view-menu .menu-item').map((b) => [b.getAttribute('role'), b.dataset.view ?? b.dataset.sort, b.getAttribute('aria-checked')]),
    [['menuitemradio', 'wallet', 'true'], ['menuitemradio', 'grid', 'false'], ['menuitemradio', 'list', 'false'],
      ['menuitemradio', 'az', 'true'], ['menuitemradio', 'total', 'false'], ['menuitemradio', 'items', 'false']], 'six radio items, Wallet and A to Z checked');
  eq(document.activeElement, viewItem('wallet'), 'focus on the view in use');
  eq(overlays.top(), 'view-menu', 'on the overlay stack');
  const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('ArrowDown');
  eq(document.activeElement, viewItem('grid'), 'ArrowDown');
  key('ArrowDown');
  key('ArrowDown');
  eq(document.activeElement, sortItem('az'), 'on from the views into Sort');
  key('ArrowDown');
  eq(document.activeElement, sortItem('total'), 'ArrowDown');
  key('End');
  eq(document.activeElement, sortItem('items'), 'End');
  key('ArrowDown');
  eq(document.activeElement, viewItem('wallet'), 'wraps round');
  key('ArrowUp');
  eq(document.activeElement, sortItem('items'), 'and back');
  key('Home');
  eq(document.activeElement, viewItem('wallet'), 'Home');
  key('Escape');
  assert(sortMenu().hidden, 'Escape closes it');
  eq(document.activeElement, sortBtn(), 'focus back on the button');
  eq(overlays.top(), null, 'off the stack');
  sortBtn().click();
  backIs('closed', 'Android Back closes the menu');
  assert(sortMenu().hidden, 'closed by Back');
  eq(document.activeElement, sortBtn(), 'focus back after Back');
  eq(localStorage.getItem('substracker.groupSort'), null, 'closing without choosing changes nothing');
});

test('Sort: per device, never in a backup, the settings or the sync outbox', async () => {
  const opsBefore = await storage.pendingCount();
  pickSort('items');
  eq(localStorage.getItem('substracker.groupSort'), 'items', 'remembered on this device');
  eq(sortBtn().getAttribute('aria-label'), 'View: Wallet. Sort: Items, most first', 'the button says so');
  eq(sortBtn().dataset.sort, 'items', 'and shows it');
  eq(getComputedStyle(sortBtn()).color, accentColour(), 'in the accent colour: the order isn\'t A to Z');
  assert(sortMenu().hidden, 'the menu closes');
  eq(document.activeElement, sortBtn(), 'focus back on the button');
  const backup = JSON.stringify(await storage.exportAll());
  assert(!/groupSort|"sort"/.test(backup), 'not in a backup');
  assert(!('groupSort' in await storage.getSettings()), 'not a shared setting');
  eq(await storage.pendingCount(), opsBefore, 'no op for sync');
  const ops = JSON.stringify(await storage.pendingOps());
  assert(!/groupSort/.test(ops), 'nothing about it queued');
  pickSort('az');
  eq(localStorage.getItem('substracker.groupSort'), 'az', 'back to A to Z');
});

test('Sort: Wallet, Grid and List all follow it; an open card stays open and comes to the front', async () => {
  await storage.save(AARDVARK);
  await reloadApp();
  goTab('subs');
  pickView('wallet');
  await wSettled();
  const want = await expectedOrders();
  assert(JSON.stringify(want.total) !== JSON.stringify(want.az) && JSON.stringify(want.items) !== JSON.stringify(want.az), 'the three orders differ here');
  eq(walletOrder(), want.az, 'Wallet: A to Z');
  const w = wallet();
  wBand('Utilities').click();
  await until(() => w.state().open === 'g:Utilities' && !w.state().animating, 'Utilities open');
  pickSort('total');
  eq(walletOrder(), want.total, 'Wallet: by total');
  assert(!walletOrder().includes('Income') && !$('#income-card').hidden, 'no Income card in the stack: income keeps its own card');
  eq(w.state().open, 'g:Utilities', 'the open card stays open');
  eq(w.state().f, Math.min(want.total.indexOf('Utilities'), w.state().maxScroll), 'and is the front card, to close back into view');
  eq(overlays.top(), 'wallet-card', 'still on the overlay stack, so Back closes it');
  pickSort('items');
  eq(walletOrder(), want.items, 'Wallet: by items, still open');
  eq(w.state().open, 'g:Utilities', 'still open');
  backIs('closed', 'Back closes the card');
  await wSettled();
  pickSort('total');
  eq(w.state().f, 0, 'with no card open the stack goes back to the top');
  pickView('grid');
  eq(sectionOrder(), want.total, 'Grid: by total');
  pickView('list');
  eq(sectionOrder(), want.total, 'List: by total');
  pickSort('items');
  eq(sectionOrder(), want.items, 'List: by items');
  pickView('grid');
  eq(sectionOrder(), want.items, 'Grid: by items');
  pickSort('az');
  eq(sectionOrder(), want.az, 'Grid: A to Z');
  pickView('wallet');
  await wSettled();
  await storage.remove(AARDVARK.id);
  await reloadApp();
});

/* ------------------------------------------------------------------ Rolling totals */
// js/count-anim.js on the Money card and the Wallet card totals.
const roller = () => $('#money-summary').roller;
const rolling = () => $$('.odo');
const rollsDone = () => until(() => roller().stats().running === 0 && !rolling().length, 'the rolls finish', 3000);
const stripTexts = () => $$('#money-summary [data-roll]').map(text);
const bandLabels = () => $$('#wallet .w-band').map((b) => b.getAttribute('aria-label'));
const odoAnimations = () => document.getAnimations().filter((a) => a.effect?.target?.closest?.('.odo'));
const reloadApp = () => $('#money-summary').reload();
const setMotion = (on) => { $('#set-motion').checked = on; $('#set-motion').dispatchEvent(new Event('change')); };
/** Resolves when the toast next goes away (a repeated confirmation blinks), within `ms`. */
function toastBlink(ms = 3000) {
  return new Promise((resolve, reject) => {
    const el = $('#toast');
    const mo = new MutationObserver(() => { if (el.hidden) { mo.disconnect(); clearTimeout(t); resolve(); } });
    const t = setTimeout(() => { mo.disconnect(); reject(new Error('Timed out: the toast did not go and come back')); }, ms);
    mo.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });
}
/** Pretend the app went to the background and came back. */
function resumeApp() {
  document.dispatchEvent(new Event('visibilitychange'));
}

test('Rolling totals: play when the Money tab comes to the front and when the app comes back, not on redraws', async () => {
  setMotion(false);
  {
    goTab('subs');
    pickView('wallet');
    await wSettled();
    await rollsDone();
    const texts = stripTexts();
    let started = roller().stats().started;
    goTab('settings');
    goTab('subs');
    assert(roller().stats().started >= started + 3, 'the Money card rolls when the tab comes to the front');
    assert($$('#money-summary .odo').length === 3, 'all three of its figures');
    eq(stripTexts(), texts, 'the text is the final value all the way through');
    assert(rolling().every((o) => o.querySelector('.odo-roll').getAttribute('aria-hidden') === 'true'), 'the rolling digits are hidden from screen readers');
    assert(rolling().every((o) => getComputedStyle(o.querySelector('.odo-txt')).color === 'rgba(0, 0, 0, 0)'), 'the real text is there, transparent');
    assert(!$('#money-summary [aria-live]') && !$$('#money-summary .odo [aria-live]').length, 'no live region');
    await rollsDone();
    eq(stripTexts(), texts, 'plain text again afterwards');
    eq($$('#money-summary [data-roll]').map((el) => el.children.length), [0, 0, 0], 'no leftover markup');

    started = roller().stats().started;
    $('#money-summary [data-period="monthly"]').click(); // a redraw: same period, same numbers
    await reloadApp(); // and a full redraw, as after a sync
    eq(roller().stats().started, started, 'a redraw with the same numbers does not roll');

    $('#money-summary [data-period="annual"]').click();
    assert(roller().stats().started > started, 'a changed figure rolls (old value to new)');
    await rollsDone();
    started = roller().stats().started;
    $('#money-summary [data-period="monthly"]').click();
    assert(roller().stats().started > started, 'and back');
    await rollsDone();

    started = roller().stats().started;
    resumeApp();
    assert(roller().stats().started >= started + 3, 'coming back to the app rolls them again');
    await rollsDone();
    started = roller().stats().started;
    goTab('settings');
    resumeApp();
    eq(roller().stats().started, started, 'not while another tab is showing');
    goTab('subs');
    await rollsDone();
  }
});

test('Rolling totals: the Wallet labels are unchanged; only cards near the screen roll, at most 10 at once', async () => {
  const extra = Array.from({ length: 13 }, (_, i) => ({
    ...base, id: `test-roll-${i}`, name: `Roll ${i}`, price: 1000 + i * 37, cycle: 'monthly', nextRenewal: day(Y, M, 4), category: `Roll group ${String(i).padStart(2, '0')}`,
  }));
  for (const s of extra) await storage.save(s);
  await reloadApp();
  try {
    // The labels as they are with no roll (Reduce motion), then during a roll: the same.
    setMotion(true);
    goTab('subs');
    pickView('wallet');
    const still = bandLabels();
    setMotion(false);
    await wSettled();
    eq(wCards().length, 16, '16 groups (income has its own card)');
    eq(bandLabels(), still, 'redrawn: the same labels');
    goTab('settings');
    goTab('subs');
    await wSettled();
    const rolled = $$('#wallet .w-total .odo').length;
    assert(rolled > 0, 'cards on screen roll');
    assert(rolled < 16, `cards far off screen just show their total (${rolled} rolled)`);
    assert(roller().stats().running <= 10, `at most 10 at once (${roller().stats().running})`);
    eq(bandLabels(), still, 'during the roll: the same labels');
    eq(wBand('Utilities').getAttribute('aria-label'), `Utilities, 2 items, ${text($('.w-total', wCard('Utilities')))} this month`, 'the label carries the final total, as before');
    const top = wCards().slice(0, 3).map((c) => c.querySelector('.w-total'));
    assert(top.every((el) => /\d/.test(text(el))), 'totals read as their final value');
    await rollsDone();
    eq(bandLabels(), still, 'afterwards: the same labels');
  } finally {
    for (const s of extra) await storage.remove(s.id);
    await reloadApp();
    goTab('subs');
    await rollsDone();
  }
});

test('Rolling totals: Reduce motion and effects: the number just changes, 0 animation frames', async () => {
  setMotion(true);
  try {
    goTab('subs');
    pickView('wallet');
    await rollsDone();
    const started = roller().stats().started;
    goTab('settings');
    goTab('subs');
    resumeApp();
    $('#money-summary [data-period="annual"]').click();
    const annual = stripTexts();
    $('#money-summary [data-period="monthly"]').click();
    eq(roller().stats().started, started, 'nothing rolled');
    eq(rolling().length, 0, 'no rolling markup');
    eq(odoAnimations().length, 0, 'no animations');
    assert(JSON.stringify(annual) !== JSON.stringify(stripTexts()), 'the figures still changed');
  } finally { setMotion(false); }
});

/* ------------------------------------------------------------------ Rolling totals: Insights */
// The month's total (the donut's or the Ring's centre, the List's head) and the yearly card roll by
// the same rules; the year chart's readout and the per-slice amounts never do. Since 1.22.0 the
// yearly card is below the fold, so it rolls once it's on screen.
const insRolling = () => $$('#insights .odo').map((o) => o.parentElement.dataset.roll);
const insTexts = () => $$('#insights [data-roll]').map((el) => [el.dataset.roll, text(el)]);
const primary = () => monthTotal();
/** Only figures on screen roll. On this page the results list sits above the app, pushing it down;
 * `onTop(true)` hides the list so the app is at the top of the page, as it is for real. */
const onTop = (on) => { $('.t-wrap').hidden = on; window.scrollTo({ top: 0 }); };

test('Rolling totals (Insights): the month total and the yearly card roll when the tab comes to the front, on a month step, and on resume (when on screen); not on a redraw', async () => {
  setMotion(false);
  onTop(true);
  try { await insightsRolls(); } finally { onTop(false); }
});

async function insightsRolls() {
  goTab('insights');
  mode('month');
  await rollsDone();
  const still = insTexts();
  eq(still.map(([k]) => k)[0], 'month-due', 'the month total is marked');
  assert(!still.some(([k]) => k === 'month-avg'), 'no Avg any more');
  assert(still.some(([k]) => k === 'year-Outgoings'), 'and the yearly card');
  const yearOnScreen = () => { const r = $('#insights .stat-year').getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  goTab('subs');
  await rollsDone();
  let started = roller().stats().started;
  goTab('insights');
  assert(roller().stats().started > started, 'coming to the tab rolls them');
  assert(insRolling().includes('month-due'), 'month-due rolls');
  for (const k of ['year-Income', 'year-Outgoings', 'year-Left over']) eq(insRolling().includes(k), yearOnScreen(), `${k} rolls only if the yearly card is on screen`);
  eq(insTexts(), still, 'the text content is the final value while rolling');
  assert($$('#insights .odo-roll').every((r) => r.getAttribute('aria-hidden') === 'true'), 'digits hidden from screen readers');
  eq($$('#insights [data-roll][aria-live], #insights [data-roll] [aria-live]').length, 0, 'no live region on or in a rolling figure');
  await rollsDone();
  eq(insTexts(), still, 'plain text again afterwards');

  // A redraw with the same numbers (switching the category view) doesn't roll.
  started = roller().stats().started;
  $('#insights [data-catview="list"]').click();
  $('#insights [data-catview="donut"]').click();
  eq(roller().stats().started, started, 'no roll on a redraw');
  eq(text($('#insights .donut-total')), text(primary()), 'the donut centre is the month total');

  // Stepping to a month with a different total rolls old to new; the same Avg (same year) doesn't.
  const before = text(primary());
  let k = 1;
  for (; k <= 11; k++) { await step(1); if (text(primary()) !== before) break; }
  assert(text(primary()) !== before, 'found a month with another total');
  assert(insRolling().includes('month-due'), 'the total rolls on a month step');
  const d = $('#insights .donut-total').getBoundingClientRect();
  assert(d.bottom > 0 && d.top < innerHeight, 'the donut centre (the month total) is on the first screen, so it rolled');
  eq(insTexts().find(([key]) => key === 'month-due')[1], text(primary()), 'its text is the new value');
  await rollsDone();
  // Scrolled down to the yearly card, coming back to the app rolls it too.
  $('#insights .stat-year').scrollIntoView({ block: 'center' });
  started = roller().stats().started;
  resumeApp();
  for (const k of ['year-Income', 'year-Outgoings', 'year-Left over']) assert(insRolling().includes(k), `${k} rolls once on screen`);
  await rollsDone();
  window.scrollTo({ top: 0 });
  await step(-k);
  await rollsDone();
  eq(insTexts(), still, 'back where it started');

  started = roller().stats().started;
  resumeApp();
  assert(roller().stats().started > started, 'coming back to the app rolls them again');
  eq(insTexts(), still, 'without drawing the tab again: same text');
  await rollsDone();
  goTab('settings');
  await rollsDone();
  started = roller().stats().started;
  resumeApp();
  eq(roller().stats().started, started, 'not while Settings is showing');

  // Figures off screen just show their value: with the results list back above it, the app is below the fold.
  onTop(false);
  window.scrollTo({ top: 0 });
  goTab('insights');
  eq(roller().stats().started, started, 'nothing off screen rolls');
  eq(insTexts(), still, 'the values are there');
  onTop(true);
}

test('Rolling totals (Insights): the year chart readout stays static while it moves; the figures match the Money card', async () => {
  onTop(true);
  try { await yearReadoutStatic(); } finally { onTop(false); }
});

async function yearReadoutStatic() {
  goTab('insights');
  mode('year');
  await settle();
  await rollsDone();
  const started = roller().stats().started;
  const read = text($('#year-chart .yc-read-name'));
  const card = insTexts();
  for (let i = 0; i < 3; i++) key('ArrowRight');
  await until(() => chart().state().animating, 'the chart moves', 1000).catch(() => {});
  assert(!$('#year-chart .odo'), 'no rolling digits in the chart while it moves');
  await settle();
  assert(text($('#year-chart .yc-read-name')) !== read, 'the readout followed the chart (as plain text)');
  assert(!$('#year-chart .odo'), 'nor once it has settled');
  eq(roller().stats().started, started, 'moving the chart rolls nothing');
  eq(insTexts(), card, 'the yearly card is unchanged');
  key('Home'); key('End'); await settle();
  for (let i = 0; i < 3; i++) key('ArrowLeft');
  await settle();

  // This calendar year's card in Year view is the Money card in Annual; this month's total is its Cash due.
  const year = Object.fromEntries($$('#insights .yc-year-stats .year-line').map((l) => [text($('dt', l)), text($('dd', l))]));
  goTab('subs');
  $('#money-summary [data-period="annual"]').click();
  await rollsDone();
  eq(walletStrip(), year, 'Annual Money card = yearly card');
  $('#money-summary [data-period="monthly"]').click();
  await rollsDone();
  const outgoings = walletStrip().Outgoings;
  goTab('insights');
  mode('month');
  // Back to the current month (earlier tests step away from it).
  for (let i = 0; i < 36 && text($('#insights .month-label')) !== monthTitle(0); i++) {
    const shown = new Date(`1 ${text($('#insights .month-label'))}`);
    await step(shown < new Date(Y, M, 1) ? 1 : -1);
  }
  eq(text($('#insights .month-label')), monthTitle(0), 'this month');
  await rollsDone();
  eq(text(primary()), outgoings, 'this month\'s total = the Money card\'s Cash due');
}

test('Rolling totals (Insights): Reduce motion and effects: plain text, 0 animation frames', async () => {
  setMotion(true);
  onTop(true);
  try {
    goTab('subs');
    goTab('insights');
    mode('month');
    const started = roller().stats().started;
    await step(1);
    await step(-1);
    resumeApp();
    mode('year');
    mode('month');
    eq(roller().stats().started, started, 'nothing rolled');
    eq($$('#insights .odo').length, 0, 'no rolling markup');
    eq(odoAnimations().length, 0, 'no animations');
    assert(insTexts().every(([, t]) => /\d/.test(t)), 'figures shown as plain text');
  } finally { setMotion(false); onTop(false); }
  goTab('subs');
});

test('Download CSV: live items only, with the BOM, columns, quoting and formula escaping, via the download path', async () => {
  goTab('settings');
  assert(text($('#btn-export-csv').closest('.setting-row')).includes('For spreadsheets, not a backup'), 'labelled as not a backup');
  const extra = [
    { ...base, id: 'test-csv-cjk', name: '中華電信 5G', price: 599, cycle: 'monthly', nextRenewal: day(Y, M + 1, 9), category: 'Utilities' },
    { ...base, id: 'test-csv-formula', name: '=HYPERLINK("x")', price: 10, cycle: 'once', date: day(Y, M, 2), category: 'Rent, flat' },
    { ...base, id: 'test-csv-gone', name: 'Deleted Thing', price: 1, cycle: 'monthly', nextRenewal: day(Y, M + 1, 1) },
    { ...base, id: 'test-csv-past', name: 'CSV Past Annual', price: 1200, cycle: 'annual', nextRenewal: day(Y - 2, M, 15), category: 'Utilities' },
    { ...base, type: 'income', id: 'test-csv-pay', name: 'CSV Pay', price: 40000, cycle: 'monthly', nextRenewal: day(Y, M, 25), category: 'ignored' },
    { ...base, id: 'test-csv-undated', name: 'CSV Undated', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
  ];
  for (const s of extra) await storage.save(s);
  await storage.remove('test-csv-gone');
  const blobs = [];
  const realUrl = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return realUrl.call(URL, b); };
  try {
    $('#btn-export-csv').click();
    await until(() => blobs.length === 1, 'the CSV file');
  } finally { URL.createObjectURL = realUrl; }
  eq(downloads.at(-1), `substracker-${day(Y, M, now.getDate())}.csv`, 'downloaded as a .csv file');
  eq(blobs[0].type, 'text/csv;charset=utf-8', 'as CSV');
  const bytes = new Uint8Array(await blobs[0].arrayBuffer());
  eq([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'starts with the UTF-8 byte-order mark');
  const rows = new TextDecoder().decode(bytes).split('\r\n'); // the decoder drops the mark
  eq(rows[0], 'Name,Amount,Currency,Cycle,Next date,Category,Type', 'the header');
  const live = await storage.getAll();
  eq(rows.length - 2, live.length, 'one row per live item (and the final line end)');
  assert(!rows.some((r) => r.includes('Deleted Thing')), 'a deleted item is left out');
  assert(!rows.some((r) => /^settings,|defaultCurrency|groupColors/.test(r)), 'the settings record is left out');
  assert(rows.includes(`中華電信 5G,599,TWD,monthly,${day(Y, M + 1, 9)},Utilities,expense`), 'CJK name');
  assert(rows.includes(`"'=HYPERLINK(""x"")",10,TWD,one-off,${day(Y, M, 2)},"Rent, flat",expense`), 'formula escaped and quoted');
  const cloudNext = new Date(Y, M, 15) >= new Date(Y, M, now.getDate()) ? day(Y, M, 15) : day(Y + 1, M, 15);
  assert(rows.includes(`CSV Past Annual,1200,TWD,annual,${cloudNext},Utilities,expense`), 'a past renewal shows its next date, as the app does');
  assert(rows.includes(`CSV Pay,40000,TWD,monthly,${nextOf(day(Y, M, 25))},,income`), 'income: no category');
  assert(rows.includes('CSV Undated,900,TWD,monthly,,Health,expense'), 'no date: blank');
  await until(() => text($('#toast-text')) === `Saved substracker-${day(Y, M, now.getDate())}.csv`, 'the toast names the file');
  for (const s of extra) await storage.remove(s.id).catch(() => {});
});

/* ------------------------------------------------------------------ Copy CSV */

test('Copy CSV: the downloaded file without its byte-order mark; "Copied N items" and "Saved <file>" every time', async () => {
  goTab('settings');
  const row = $('#btn-copy-csv').closest('.setting-row');
  eq(row, $('#btn-export-csv').closest('.setting-row'), 'beside Download CSV');
  eq(text($('#btn-export-csv')), 'Download CSV', 'renamed');
  eq(text($('#btn-copy-csv')), 'Copy CSV', 'the new button');
  assert(text(row).includes('For spreadsheets, not a backup'), 'labelled as not a backup');
  for (const b of ['#btn-export-csv', '#btn-copy-csv']) assert(/for spreadsheets, not a backup$/.test($(b).getAttribute('aria-label')), `${b}: says so to screen readers too`);
  const blobs = [];
  const realUrl = URL.createObjectURL;
  URL.createObjectURL = (b) => { blobs.push(b); return realUrl.call(URL, b); };
  const toastSeen = async (msg) => {
    await until(() => !$('#toast').hidden && text($('#toast-text')) === msg, msg);
  };
  try {
    $('#btn-export-csv').click();
    await until(() => blobs.length === 1, 'the file');
    const file = `substracker-${day(Y, M, now.getDate())}.csv`;
    await toastSeen(`Saved ${file}`);
    // A second click: the confirmation goes and comes back, so it never looks like nothing happened.
    const blink = toastBlink();
    $('#btn-export-csv').click();
    await until(() => blobs.length === 2, 'the second file');
    await blink;
    await toastSeen(`Saved ${file}`);
  } finally { URL.createObjectURL = realUrl; }
  const bytes = new Uint8Array(await blobs[0].arrayBuffer());
  const fileText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  setClipboard('record');
  try {
    copied.length = 0;
    $('#btn-copy-csv').click();
    await until(() => copied.length === 1, 'copied');
    eq(fileText.charCodeAt(0), 0xfeff, 'the file has the mark');
    eq(copied[0], fileText.slice(1), 'the copy is the file minus the mark, byte for byte');
    assert(copied[0].charCodeAt(0) !== 0xfeff, 'no mark on the clipboard');
    const n = (await storage.getAll()).length;
    await toastSeen(`Copied ${n} items`);
    const blink = toastBlink();
    $('#btn-copy-csv').click();
    await until(() => copied.length === 2, 'copied again');
    await blink;
    await toastSeen(`Copied ${n} items`);
    assert($('#csv-fallback').hidden, 'no fallback when the clipboard works');
  } finally { setClipboard('real'); copied.length = 0; }
});

test('Copy CSV: a blocked clipboard shows the CSV selected, to copy by hand', async () => {
  goTab('settings');
  setClipboard('blocked');
  try {
    $('#btn-copy-csv').click();
    await until(() => !$('#csv-fallback').hidden, 'the fallback');
    const box = $('#csv-copy-text');
    eq(document.activeElement, box, 'focused');
    eq([box.selectionStart, box.selectionEnd], [0, box.value.length], 'all of it selected');
    assert(box.readOnly, 'read-only');
    // A textarea gives its value with LF line ends; the CSV itself has CRLF.
    assert(box.value.startsWith('Name,Amount,Currency,Cycle,Next date,Category,Type\n') && box.value.charCodeAt(0) !== 0xfeff, 'the CSV, no mark');
    eq(text($('#csv-fallback-text')), "Couldn't copy. Select the CSV below and copy it.", 'says what to do');
    await until(() => text($('#toast-text')) === "Couldn't copy: the CSV is selected below", 'and a toast, so the click is seen to do something');
  } finally { setClipboard('record'); }
  try {
    copied.length = 0;
    $('#btn-copy-csv').click();
    await until(() => copied.length === 1 && $('#csv-fallback').hidden, 'a working clipboard hides it again');
  } finally { setClipboard('real'); copied.length = 0; }
  goTab('subs');
});

/** The next monthly date on or after today for a stored YYYY-MM-DD in this month. */
function nextOf(stamp) {
  const d = new Date(`${stamp}T00:00:00`);
  return d >= new Date(Y, M, now.getDate()) ? stamp : day(Y, M + 1, d.getDate());
}

/* ------------------------------------------------------------------ Import with AI */

const aiDlg = () => $('#ai-dialog');
const aiView = () => $$('#ai-dialog [data-ai-view]').find((v) => !v.hidden)?.dataset.aiView;
const slide = () => $('#ai-slide');
const thumb = () => $('#ai-slide [data-slide-thumb]');
const slideCheck = () => $('#ai-slide [data-slide-check]');
const thumbX = () => new DOMMatrix(getComputedStyle(thumb()).transform).m41;
const aiReply = (rows) => JSON.stringify({ version: 1, rows });
const aiRow = (over = {}) => ({
  name: 'Test Streaming', amount: 390, currency: 'TWD', cycle: 'monthly', nextDate: day(Y, M + 1, 5),
  category: 'Entertainment', type: 'expense', ...over,
});

/** Drag the thumb `fraction` of the way along the track with pointer events, then let go. */
async function dragThumb(fraction) {
  const t = thumb().getBoundingClientRect();
  const travel = $('#ai-slide [data-slide-track]').clientWidth - t.width;
  const at = (x, type) => thumb().dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: t.y + t.height / 2,
  }));
  const x0 = t.x + t.width / 2;
  at(x0, 'pointerdown');
  for (let i = 1; i <= 8; i++) { at(x0 + (travel * fraction * i) / 8, 'pointermove'); await tick(5); }
  getComputedStyle(thumb()).transform; // a frame would have drawn the dragged position
  at(x0 + travel * fraction, 'pointerup');
}

/** Open the sheet from Settings; it starts on the warning, locked. */
async function openAi() {
  goTab('settings');
  $('#btn-import-ai').click();
  await until(() => aiDlg().open && aiView() === 'warning', 'the warning step');
}
/** Wait out the lock and confirm with the checkbox. */
async function confirmWarning() {
  await until(() => !slide().classList.contains('is-locked'), 'the lock to end', 3000);
  slideCheck().click();
  await until(() => !$('#ai-continue').disabled, 'Continue enabled');
}
/** From the prompt step: paste `text` and review. */
async function reviewReply(text) {
  $('#ai-reply').value = text;
  $('#ai-review').click();
  await until(() => aiView() === 'review', 'the review step');
}

// Anchor downloads (the web export) are caught, so the tests never save files.
const downloads = [];
const realClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function click() {
  if (this.hasAttribute('download')) { downloads.push(this.download); return; }
  realClick.call(this);
};
/** Replace navigator.clipboard for one test: 'blocked' rejects; else writes are recorded in `copied`. */
const copied = [];
function setClipboard(mode) {
  if (mode === 'real') { delete navigator.clipboard; return; }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t) => (mode === 'blocked' ? Promise.reject(new Error('blocked')) : (copied.push(t), Promise.resolve())) },
  });
}

test('Import with AI: the warning is locked for about 2 s; drags then and early releases spring back', async () => {
  localStorage.setItem('substracker.reduceMotion', 'off');
  $('#set-motion').checked = false; $('#set-motion').dispatchEvent(new Event('change'));
  const opened = performance.now();
  await openAi();
  eq(overlays.top(), 'ai-dialog', 'the sheet is on the overlay stack');
  assert(slide().classList.contains('is-locked'), 'locked');
  assert(slideCheck().disabled && $('#ai-continue').disabled, 'checkbox and Continue disabled');
  eq(thumb().getAttribute('aria-disabled'), 'true', 'aria-disabled while locked');
  await dragThumb(1);
  eq(thumb().getAttribute('aria-valuenow'), '0', 'a full drag while locked springs back');
  slideCheck().click();
  assert(!slideCheck().checked, 'the checkbox stays unticked while locked');
  thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  eq(thumb().getAttribute('aria-valuenow'), '0', 'keys do nothing while locked');
  await until(() => !slide().classList.contains('is-locked'), 'unlocked', 3000);
  const lockMs = performance.now() - opened;
  assert(lockMs > 1800 && lockMs < 2900, `locked for about 2 s (${Math.round(lockMs)} ms)`);
  eq(text($('#ai-slide [data-slide-label]')), "Slide to confirm you've read this", 'the label');
  await dragThumb(0.6);
  eq(thumb().getAttribute('aria-valuenow'), '0', 'released early: back to the start');
  assert(thumbX() > 0, 'and it animates back (springs) with motion on');
  await until(() => thumbX() === 0, 'settled at the start');
  assert($('#ai-continue').disabled, 'still not confirmed');
  await dragThumb(1);
  eq(thumb().getAttribute('aria-valuenow'), '100', 'a full drag confirms');
  assert(slide().classList.contains('is-done') && slideCheck().checked, 'shown as confirmed, checkbox ticked too');
  eq(text($('#ai-slide [data-slide-label]')), 'Confirmed ✓', 'says so');
  assert(!$('#ai-continue').disabled, 'Continue enabled');
});

test('Import with AI: keyboard and the checkbox fallback, aria labels; shown again every time', async () => {
  // Still open from the last test, confirmed. Unticking the checkbox takes the confirmation back.
  slideCheck().click();
  assert(!slideCheck().checked && $('#ai-continue').disabled, 'unticked: not confirmed');
  eq(thumb().getAttribute('role'), 'slider', 'the thumb is a slider');
  eq(thumb().getAttribute('aria-label'), "Slide to confirm you've read this", 'labelled');
  eq(thumb().tabIndex, 0, 'focusable');
  const key = (k) => thumb().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('ArrowRight');
  eq(thumb().getAttribute('aria-valuenow'), '25', 'arrow right steps');
  key('ArrowLeft');
  eq(thumb().getAttribute('aria-valuenow'), '0', 'arrow left steps back');
  key('End');
  assert(slide().classList.contains('is-done') && !$('#ai-continue').disabled, 'End confirms');
  $('#ai-continue').click();
  eq(aiView(), 'prompt', 'on to the prompt');
  $('#ai-prompt-back').click();
  eq(aiView(), 'warning', 'back to the warning');
  assert(slide().classList.contains('is-locked') && !slide().classList.contains('is-done'), 'locked and unconfirmed again');
  assert($('#ai-continue').disabled, 'Continue disabled again');
  $('#ai-warning-cancel').click();
  assert(!aiDlg().open, 'Cancel closes the sheet');
  await openAi(); // at once: the earlier close event must not stop this visit's lock
  assert(slide().classList.contains('is-locked') && !slideCheck().checked, 'reopened: locked and unconfirmed');
  await confirmWarning();
  assert(slide().classList.contains('is-done'), 'the checkbox confirms too');
  $('[data-ai-close]').click();
});

test('Import with AI: the warning\'s backup button exports and says so; it is optional', async () => {
  await openAi();
  const n = (await storage.getAll()).length;
  const btn = $('#ai-dialog [data-ai-backup]');
  eq(text(btn), `Export a backup first (${n} items)`, 'mentions the item count');
  assert(text($('#ai-backup-hint')).includes(`${n} items`), 'and the hint does too');
  const before = downloads.length;
  btn.click();
  await until(() => text(btn) === 'Backup saved ✓', 'Backup saved');
  eq(downloads.length, before + 1, 'one backup file delivered');
  assert(downloads.at(-1).startsWith('substracker-'), 'the normal backup file');
  await confirmWarning(); // Continue works whether or not a backup was made
  $('[data-ai-close]').click();
  await openAi();
  eq(text(btn), `Export a backup first (${n} items)`, 'a new visit starts without the tick');
  $('[data-ai-close]').click();
});

test('Import with AI: Back on every step goes back one step and imports nothing', async () => {
  const before = (await storage.getAll()).length;
  await openAi();
  backIs('closed', 'Back on the warning');
  assert(!aiDlg().open, 'the sheet closed');
  eq(appTab(), 'settings', 'still on Settings');

  await openAi();
  await confirmWarning();
  $('#ai-continue').click();
  eq(overlays.ids().slice(-2), ['ai-dialog', 'ai-step'], 'the prompt step is on the stack');
  backIs('closed', 'Back on the prompt step');
  eq(aiView(), 'warning', 'back on the warning, open');
  assert(aiDlg().open && slide().classList.contains('is-locked'), 'locked again');

  await confirmWarning();
  $('#ai-continue').click();
  await reviewReply(aiReply([aiRow()]));
  backIs('closed', 'Back on the review step');
  eq(aiView(), 'prompt', 'back on the prompt');
  eq($('#ai-reply').value, aiReply([aiRow()]), 'the pasted reply is kept');

  $('#ai-review').click();
  await until(() => aiView() === 'review', 'review again');
  $('#ai-import').click();
  await until(() => confirmOpen() && confirmTitle() === 'Import these items?', 'the choice dialog');
  eq(overlays.top(), 'confirm-dialog', 'the choice is on top');
  backIs('closed', 'Back on the choice');
  await tick(50);
  assert(!confirmOpen() && aiDlg().open && aiView() === 'review', 'cancelled; still on the review');

  $('#ai-import').click();
  await until(() => confirmOpen() && confirmTitle() === 'Import these items?', 'the choice again');
  confirmButton('Replace all').click();
  await until(() => confirmOpen() && confirmTitle() === 'Replace all items?', 'the Replace confirmation');
  backIs('closed', 'Back on the Replace confirmation');
  await tick(50);
  assert(!confirmOpen() && aiDlg().open, 'cancelled; the sheet stays');
  eq((await storage.getAll()).length, before, 'nothing imported or replaced');

  backIs('closed', `review → prompt (${overlays.ids()} on ${aiView()})`);
  backIs('closed', `prompt → warning (${overlays.ids()} on ${aiView()})`);
  backIs('closed', `warning → closed (${overlays.ids()} on ${aiView()} open=${aiDlg().open})`);
  assert(!aiDlg().open, 'closed');
  eq(overlays.ids(), [], 'nothing left on the stack');
  eq((await storage.getAll()).length, before, 'still nothing imported');
});

test('Import with AI: copy buttons fall back to selectable text when the clipboard is blocked', async () => {
  await openAi();
  await confirmWarning();
  $('#ai-continue').click();
  setClipboard('ok');
  $('#ai-copy-prompt').click();
  await until(() => copied.length === 1, 'copied');
  assert(copied[0].includes('"version": 1') && copied[0].includes('only the JSON, nothing else'), 'the prompt was copied');
  assert($('#ai-prompt-fallback').hidden, 'no fallback when copying works');

  setClipboard('blocked');
  $('#ai-copy-prompt').click();
  await until(() => !$('#ai-prompt-fallback').hidden, 'the fallback note');
  assert($('#ai-prompt-details').open, 'the prompt is shown');
  const ta = $('#ai-prompt-text');
  eq(ta.value, copied[0], 'the same text, to copy by hand');
  assert(ta.readOnly && document.activeElement === ta, 'read-only and focused');
  eq([ta.selectionStart, ta.selectionEnd], [0, ta.value.length], 'all of it selected');

  $('#ai-reply').value = '';
  $('#ai-review').click();
  eq(aiView(), 'prompt', 'an empty reply: nothing to review');
  assert(text($('#ai-reply-problems')).startsWith('Nothing to import'), 'and says so');
  $('#ai-reply').value = 'Sorry, I could not read the statement.';
  $('#ai-review').click();
  await until(() => !$('#ai-reply-error').hidden, 'the reply error');
  eq(aiView(), 'prompt', 'still on the prompt');
  assert(text($('#ai-reply-problems')).includes("Couldn't find any JSON"), 'says what is wrong');
  eq($('#ai-reply').getAttribute('aria-invalid'), 'true', 'the field is marked');
  $('#ai-reply-copy-error').click();
  await until(() => !$('#ai-reply-error-text').hidden, 'the error text fallback');
  assert($('#ai-reply-error-text').value.startsWith('Peek Budget could not import some of your JSON:'), 'the error report, to copy by hand');

  setClipboard('ok');
  $('#ai-reply-copy-error').click();
  await until(() => copied.length === 2, 'copied the error');
  assert(copied[1].includes("Couldn't find any JSON") && copied[1].includes('reply with the whole corrected JSON only'), 'the error for the AI');
  setClipboard('real');
  $('[data-ai-close]').click();
  await until(() => $('#ai-reply').value === '', 'closing clears the pasted reply');
});

test('Import with AI: review flags rows, fixes dates and cycles, totals on a cash basis, then Merge', async () => {
  const before = await storage.getAll();
  await openAi();
  await confirmWarning();
  $('#ai-continue').click();
  await reviewReply('Here you go:\n```json\n' + aiReply([
    aiRow(),
    aiRow({ name: 'Test Pay', amount: 52000, type: 'income', category: '' }),
    aiRow({ name: 'Test Gym', amount: 800, cycle: 'weekly', category: 'Fitness' }),
    aiRow({ name: 'Test Drive', amount: 1290, cycle: 'annual', nextDate: '', category: 'Cloud storage' }),
    aiRow(),
    aiRow({ name: 'Test Lamp', amount: '590', cycle: 'one-off' }),
    aiRow({ name: 'Phone', amount: 499, nextDate: day(Y, M, 5), category: 'Utilities' }), // already in the list
    aiRow({ name: 'Test Desk', amount: 2400, cycle: 'one-off', nextDate: day(Y, M, 2), category: '' }),
  ]) + '\n```');
  const row = (n) => $(`#ai-rows [data-row="${n}"]`);
  const include = (n) => $('[data-include]', row(n));
  eq(text($('#ai-review-summary')), '8 rows · 3 selected · 1 needs a date · 1 with an unsupported cycle · 2 duplicates skipped · 1 can’t be imported.', 'summary');
  eq([1, 2, 3, 4, 5, 6, 7, 8].map((n) => include(n).checked), [true, true, false, false, false, false, false, true], 'starting choices');
  eq([3, 4, 6].map((n) => include(n).disabled), [true, true, true], 'flagged rows can\'t be ticked');
  assert(text(row(3)).includes('Unsupported cycle') && $('[data-fix-cycle="3"]', row(3)), 'unsupported cycle flagged, with a fix');
  assert(text(row(4)).includes('Needs a date') && $('[data-fix-date="4"]', row(4)), 'missing date flagged, with a picker');
  assert(text(row(5)).includes('same as row 1, skipped') && text(row(7)).includes('already in your list'), 'duplicates');
  assert(text(row(6)).includes('amount must be a number without quotes, like 390') && !$('[data-fix-date], [data-fix-cycle]', row(6)), 'errors: message, no fix');
  assert(!$('#ai-review-error').hidden, 'Copy error for your AI is offered');

  const totals = () => $$('#ai-totals .ai-totals-groups li').map(text);
  eq(totals(), [`Monthly items (2): ${T(390)} out, ${T(52000)} in, each month`, `One-off (1): ${T(2400)} out`], 'totals by cycle, as paid');

  const fix = (sel, value) => { const el = $(sel); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
  fix('[data-fix-date="4"]', day(Y + 1, 2, 1));
  fix('[data-fix-cycle="3"]', 'monthly');
  eq([3, 4].map((n) => include(n).checked), [true, true], 'fixed rows are included');
  include(8).click();
  assert(!include(8).checked, 'a row can be left out');
  include(5).click();
  assert(include(5).checked, 'a duplicate can be included on purpose');
  eq(totals(), [`Monthly items (4): ${T(1580)} out, ${T(52000)} in, each month`, `Yearly items (1): ${T(1290)} out, each year`], 'no averaged figure: yearly stays yearly');
  assert(!$$('#ai-totals li').some((li) => text(li).includes(T(107.5))), 'no 1,290 / 12');
  eq(text($('#ai-import')), 'Import 5 items', 'the button counts them');
  eq((await storage.getAll()).length, before.length, 'nothing saved during the review');

  $('#ai-import').click();
  await until(() => confirmOpen() && confirmTitle() === 'Import these items?', 'the choice');
  assert(text($('#confirm-message')).startsWith(`5 items to add. Merge adds them to your ${before.length} items.`), 'the AI wording');
  confirmButton('Merge').click();
  await until(() => text($('#toast-text')) === 'Added 5 items', 'merged');
  assert(!aiDlg().open, 'the sheet closed');
  const after = await storage.getAll();
  eq(after.length, before.length + 5, 'five added');
  const added = after.filter((s) => !before.some((b) => b.id === s.id));
  const by = (name) => added.filter((s) => s.name === name);
  eq(by('Test Streaming').length, 2, 'the duplicate went in, as chosen');
  eq([by('Test Gym')[0].cycle, by('Test Drive')[0].nextRenewal, by('Test Drive')[0].cycle], ['monthly', day(Y + 1, 2, 1), 'annual'], 'the fixes were used');
  eq([by('Test Pay')[0].type, by('Test Pay')[0].category, by('Test Pay')[0].nextRenewal], ['income', '', day(Y, M + 1, 5)], 'income uses nextRenewal');
  eq(by('Test Desk').length, 0, 'the row left out stayed out');
  assert(added.every((s) => s.id !== 'settings' && s.createdAt && s.updatedAt), 'new ids and stamps');
});

test('Import with AI: a reply pasted on a phone (invisible spaces, curly quotes, suggestions after it) is read', async () => {
  const before = await storage.getAll();
  const ch = (code) => String.fromCharCode(code);
  const tutoring = (nextDate) => aiRow({ name: 'Test Tutoring', amount: 4800, cycle: 'one-off', nextDate, category: '', type: 'income' });
  const json = aiReply([aiRow({ name: 'Test Music', amount: 149 }), tutoring(day(Y, M, 3)), tutoring(day(Y, M, 26)), tutoring(day(Y, M, 3))])
    .replace('{"version":1,', `{${ch(0xfeff)}${ch(0x201c)}version${ch(0x201d)}:${ch(0xa0)}1,${ch(0x200b)}`)
    .replace('"rows":', `"rows"${ch(0x2060)}:${ch(0x200d)}`);
  await openAi();
  await confirmWarning();
  $('#ai-continue').click();
  await reviewReply(`${json}\n\nCheck the weekly gym membership\nAdd my one-off purchases too`);
  eq(text($('#ai-review-summary')), '4 rows · 3 selected · 1 duplicate skipped.', 'read, not "version is missing"');
  assert($('#ai-reply-error').hidden, 'no error for the reply');
  const include = (n) => $(`#ai-rows [data-row="${n}"] [data-include]`).checked;
  eq([1, 2, 3, 4].map(include), [true, true, true, false], 'both one-offs on different dates go in; the same date again is a duplicate');
  assert(text($('#ai-rows [data-row="4"]')).includes('same as row 2, skipped'), 'the duplicate says which row');
  $('[data-ai-close]').click();
  await until(() => !aiDlg().open, 'closed');
  eq((await storage.getAll()).length, before.length, 'nothing imported');
});

test('Import with AI: the exact phone paste (line wrapping copied as line breaks) reviews like the clean reply', async () => {
  const before = await storage.getAll();
  const wrapped = await (await fetch('./fixtures/ai-reply-wrapped.txt', { cache: 'no-store' })).text();
  eq((wrapped.match(/\n/g) ?? []).length, 33, 'the fixture has its 33 line breaks');
  await openAi();
  await confirmWarning();
  $('#ai-continue').click();
  await reviewReply(wrapped);
  eq(text($('#ai-review-summary')), '18 rows · 16 selected · 2 with an unsupported cycle.', 'read, not "the JSON has a mistake"');
  assert($('#ai-reply-error').hidden, 'no error for the reply');
  const names = $$('#ai-rows [data-row]').map((r) => text(r));
  assert(names[0].includes('Salary - Northwind Learning Co') && names[6].includes('City Power & Water'), 'names have their spaces back');
  assert(!names.some((n) => /Clo ud|Utiliti es|LearningCo/.test(n)), 'no wrap left in a name or category');
  $('[data-ai-close]').click();
  await until(() => !aiDlg().open, 'closed');
  eq((await storage.getAll()).length, before.length, 'nothing imported');
});

test('Import with AI: Reduce motion and effects: the thumb returns at once, no transition', async () => {
  $('#set-motion').checked = true; $('#set-motion').dispatchEvent(new Event('change'));
  try {
  assert(document.documentElement.classList.contains('reduce-motion'), 'reduce motion on');
  await openAi();
  const dur = parseFloat(getComputedStyle(thumb()).transitionDuration) * 1000;
  assert(dur < 1, `no spring animation (${dur} ms)`);
  assert(parseFloat(getComputedStyle(aiDlg()).animationDuration) * 1000 < 1, 'the sheet does not slide in');
  await until(() => !slide().classList.contains('is-locked'), 'unlocked', 3000);
  await dragThumb(0.6);
  eq(thumbX(), 0, 'released early: back at once, in the same moment');
  await dragThumb(1);
  assert(slide().classList.contains('is-done'), 'still confirms');
  } finally {
    if (aiDlg().open) $('[data-ai-close]').click();
    $('#set-motion').checked = false; $('#set-motion').dispatchEvent(new Event('change'));
  }
});

test('Import with AI: light and dark themes use the theme tokens', async () => {
  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rgb = (hex) => { const d = document.createElement('div'); d.style.color = hex; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  for (const theme of ['light', 'dark']) {
    $('#set-theme').value = theme; $('#set-theme').dispatchEvent(new Event('change'));
    await openAi();
    eq(getComputedStyle(aiDlg()).backgroundColor, rgb(token('--surface')), `${theme}: sheet surface`);
    eq(getComputedStyle($('#ai-dialog .sync-warning')).backgroundColor, rgb(token('--warn-soft')), `${theme}: warning box`);
    eq(getComputedStyle(thumb()).backgroundColor, rgb(token('--accent')), `${theme}: thumb`);
    eq(getComputedStyle($('#ai-dialog .ai-points')).color, rgb(token('--text-muted')), `${theme}: text`);
    $('[data-ai-close]').click();
  }
  $('#set-theme').value = 'system'; $('#set-theme').dispatchEvent(new Event('change'));
});

// Last: Replace all removes the seeded items.
test('Import with AI: Replace all with the backup button beside it, at both steps', async () => {
  const before = await storage.getAll();
  const settingsBefore = await storage.getSettings();
  await openAi();
  await confirmWarning();
  $('#ai-continue').click();
  await reviewReply(aiReply([aiRow({ name: 'Only One', amount: 100 }), aiRow({ name: 'Only Two', amount: 200, cycle: 'annual' })]));
  $('#ai-import').click();
  await until(() => confirmOpen() && confirmTitle() === 'Import these items?', 'the choice');
  eq($$('#confirm-actions button').map(text), ['Cancel', `Export a backup first (${before.length} items)`, 'Replace all', 'Merge'], 'backup beside Replace all');
  const n = downloads.length;
  confirmButton(`Export a backup first (${before.length} items)`).click();
  await until(() => confirmOpen() && confirmButton('Backup saved ✓'), 'the choice again, with the tick');
  eq(downloads.length, n + 1, 'a backup was delivered');
  confirmButton('Replace all').click();
  await until(() => confirmOpen() && confirmTitle() === 'Replace all items?', 'the final confirmation');
  eq($$('#confirm-actions button').map(text), ['Cancel', 'Backup saved ✓', 'Replace all'], 'the backup again beside Replace all');
  assert(text($('#confirm-message')).includes('Settings stay as they are'), 'says settings stay');
  confirmButton('Backup saved ✓').click();
  await until(() => confirmOpen() && confirmTitle() === 'Replace all items?' && downloads.length === n + 2, 'backed up again, same step');
  confirmButton('Replace all').click();
  await until(() => text($('#toast-text')) === 'Replaced with 2 items', 'replaced');
  const after = await storage.getAll();
  eq(after.map((s) => s.name).sort(), ['Only One', 'Only Two'], 'only the imported items remain');
  const s = await storage.getSettings();
  eq([s.defaultCurrency, JSON.stringify(s.groupColors)], [settingsBefore.defaultCurrency, JSON.stringify(settingsBefore.groupColors)], 'settings unchanged');
  HTMLAnchorElement.prototype.click = realClick;
});

/* ------------------------------------------------------------------ Runner */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  storage.setPref('tab', 'insights');
  storage.setPref('catView', 'donut');
  storage.setPref('view', 'grid'); // cards show the renewal or payment tag
  storage.setPref('period', 'monthly');
  storage.setPref('insightsMode', 'month');
  storage.setPref('yearRange', 'roll');
  localStorage.removeItem('substracker.reduceMotion'); // unset: follows the system
  localStorage.removeItem('substracker.yearStack'); // unset, as on a fresh device: By category
  localStorage.removeItem('substracker.yearKey'); // unset: the year chart's key starts hidden
  localStorage.removeItem('substracker.groupSort'); // unset: A to Z, the Money tab's order before Sort
  localStorage.removeItem('substracker.theme');

  // Bring in the app's own markup, then the app itself (which starts on import).
  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#insights .ins-hero'), 'Insights rendered');

  const list = document.getElementById('results');
  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    const li = document.createElement('li');
    try {
      await fn();
      passed++;
      li.className = 't-pass';
      li.textContent = `✓ ${name}`;
    } catch (err) {
      failures.push({ name, error: err.message });
      li.className = 't-fail';
      li.append(`✗ ${name}`);
      const d = document.createElement('div');
      d.className = 't-detail';
      d.textContent = err.message;
      li.append(d);
    }
    list.append(li);
  }
  for (const [p, v] of Object.entries(savedPrefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
  const total = results.length;
  document.getElementById('summary').textContent = failures.length
    ? `${failures.length} of ${total} failed` : `All ${total} passed`;
  document.getElementById('summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  window.testResults = { total, passed, failures, dbName };
  // The app keeps its database open; delete it once the page is gone (next load clears old ones).
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

// Clear databases left by earlier runs of this page.
(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-app-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => {
    document.getElementById('summary').textContent = `Setup failed: ${err.message}`;
    document.getElementById('summary').className = 't-summary t-fail';
    window.testResults = { total: results.length, passed: 0, failures: [{ name: 'setup', error: err.message }] };
  });
})();
