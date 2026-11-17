// In-browser tests for the app screens (js/app.js): the Insights month view and the Money tab
// summary strip on a cash basis (outgoings and income), the "needs a renewal date" and "needs a payment date" notices, and the
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

const results = [];
const dbName = `substracker-test-app-${Date.now()}`;
const PREFS = ['tab', 'catView', 'view', 'period', 'insightsMode', 'yearRange', 'theme', 'reduceMotion'];
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

/* ---------------------------------------------------------------- Insights */

test('headline card shows the cash due this month, with the Avg line', async () => {
  const card = $('#insights .stat-primary');
  eq(text($('.stat-value', card)), T(1699), 'cash due');
  eq($$('.stat-sub', card).map(text), ['Cash due this month', `Avg ${T(1629)}/mo`], 'subtitle and Avg');
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

test('the income bar, the donut and the category list all use the month cash total', async () => {
  assert(text($('#insights .headline-text')).includes(T(1699)), 'headline uses the cash total');
  $('#insights [data-catview="donut"]').click();
  eq(text($('#insights .donut-total')), T(1699), 'donut centre');
  const legend = $$('#insights .legend-row .legend-name').map(text);
  eq(legend, ['Utilities'], 'only categories with something due');
  $('#insights [data-catview="list"]').click();
  eq($$('#insights .cat-row .cat-amount').map((el) => el.firstChild.textContent.trim()), [T(1699)], 'category list total');
  eq(text($$('#insights .stat')[2].querySelector('.stat-sub')), '1 monthly · 1 annual · 0 one-off', 'items due');
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
  eq(text($('#insights .ring-share')), `58% of ${$('#insights .month-label').textContent}`, 'caption share of the month');
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

/* ------------------------------------------------------- Money tab strip */

const stripCells = () => $$('#money-summary .summary-cell').map((c) =>
  [text($('.stat-label', c)), text($('.summary-value', c)), text($('.stat-sub', c))]);
const period = (p) => $(`#money-summary [data-period="${p}"]`).click();

// The strip, default currency TWD, this month: income 43,000 (Salary + Refund), cash due 1,699,
// Avg 1,629 as in Insights. This year: as the yearly card. Before, on the monthly-equivalent basis
// with undated items, it showed 49,000 / 1,629 for the month and 555,000 / 19,548 for the year.
test('the monthly strip shows this month on the cash basis, as the Insights headline does', async () => {
  period('monthly');
  eq(stripCells(), [
    ['Income', T(43000), ''],
    ['Outgoings', T(1699), `Avg ${T(1629)}/mo`],
    ['Left over', T(41301), ''],
  ], 'monthly strip');
  const thisMonth = new Date(Y, M, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  eq(text($('#money-summary .summary-when')), thisMonth, 'this month');
  eq(text($('#insights .headline-text')), `Outgoings ${T(1699)} of ${T(43000)} income (4%)`, 'same as the Insights headline');
  eq(text($('#money-summary p.summary-note')), "TWD only. 3 items in other currencies aren't included.", 'currency note kept');
});

test('the annual strip shows the year from its twelve cash months, with no Avg line', async () => {
  period('annual');
  eq(stripCells(), [
    ['Income', T(495000), ''],
    ['Outgoings', T(7548), ''],
    ['Left over', T(487452), ''],
  ], 'annual strip, same as the yearly card');
  eq(text($('#money-summary .summary-when')), String(Y), 'this year');
  eq(yearLines(), [['Income', T(495000)], ['Outgoings', T(7548)], ['Left over', T(487452)]], 'yearly card agrees');
  period('monthly');
  eq(stripCells()[0][1], T(43000), 'back to monthly');
});

test('the strip has one line for undated items that opens the first of them', async () => {
  const line = $('#money-summary .summary-note-action');
  eq(text(line), 'Excludes 3 undated items', 'one line, no repeat of the notices');
  line.click();
  await until(isOpen, 'edit sheet opens');
  eq(field('name').value, 'Gym', 'the first undated plan (plans before income)');
  $('#sub-dialog [data-close]').click();
  await until(() => !isOpen(), 'sheet closes');
});

test('a short month on the strip shows the minus sign and says so in words', async () => {
  const usd = (n) => money(n, 'USD');
  const select = $('#set-currency');
  select.value = 'USD';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => text($('#money-summary .summary-value')) === usd(0), 'strip in USD');
  const [, , left] = stripCells();
  eq(left, ['Left over', usd(-10), 'More going out than coming in'], 'short month');
  assert($('#money-summary .summary-short'), 'short style');
  assert(usd(-10).includes('-') || usd(-10).includes('−'), 'minus sign');
  assert(!$('#money-summary .summary-note-action'), 'no undated USD items');
  select.value = 'TWD';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => text($('#money-summary .summary-value')) === T(43000), 'strip back in TWD');
  await until(() => text($('#insights .stat-year .stat-label')) === String(Y), 'Insights back on TWD');
});

test('the notice names the undated plans and their amount', async () => {
  eq(text(notice()), `2 plans need a renewal date, ${T(2100)} not shown`, 'notice text');
});

test('the month income is what is paid in it, not a monthly equivalent', async () => {
  eq(text($('#insights .headline-text')), `Outgoings ${T(1699)} of ${T(43000)} income (4%)`, 'this month');
  await step(2);
  eq(text($('#insights .headline-text')), `Outgoings ${T(499)} of ${T(52000)} income (1%)`, 'bonus month');
  await step(-1);
  eq(text($('#insights .headline-text')), `Outgoings ${T(499)} of ${T(40000)} income (1%)`, 'salary only');
  await step(-1);
});

test('a month with no income shows no percentage and says why', async () => {
  chip('USD').click();
  const usd = (n) => money(n, 'USD');
  const monthName = (k) => new Date(Y, M + k, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  eq(text($('#insights .headline-text')), `Outgoings ${usd(10)} · no USD income paid in ${monthName(0)}, so no percentage`, 'none paid');
  assert(!$('#insights .headline .bar'), 'no bar');
  await step(1);
  eq(text($('#insights .headline-text')), `Outgoings ${usd(10)} of ${usd(200)} income (5%)`, 'next month');
  await step(-1);
  chip('TWD').click();
  assert(text($('#insights .headline-text')).includes(T(43000)), 'back to TWD');
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
  eq(text($('#insights .stat-primary .stat-value')), T(1699 + 900), 'month now includes Gym');
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
  eq(text($('#insights .stat-primary .stat-value')), T(499 + 900 + 1300), 'still due this month');
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
  assert(text($('#insights .headline-text')).includes(`of ${T(48000)} income`), 'Lodger now paid this month');
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
  eq(text($('#field-date .field-label')), 'Date', 'one-off label, as for expenses');
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

test('dated income on the Money tab says "Payment", never "Renews"', async () => {
  const tag = text($('#subs-list [data-id="test-salary"] .tag'));
  assert(/^Payment/.test(tag), `payment tag (${tag})`);
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
  const cardMonth = text($('#insights .stat-primary .stat-value'));
  mode('year');
  assert(chart(), 'chart drawn');
  assert(!$('#insights .month-nav'), 'no month arrows in Year');
  eq(storage.getPref('insightsMode'), 'year', 'remembered');
  eq(text($('#insights .stat-year .stat-label')), String(Y), 'yearly card for this year');
  eq(chart().state().centre, 6, 'rolling, centred on the current month');
  eq(text($('#year-chart .yc-read-name')), `${monthTitle(0)} · now`, 'readout');
  eq(text($('#year-chart .yc-read-total')), cardMonth, 'the chart agrees with the month headline');
  mode('month');
  assert($('#insights .month-nav') && !host(), 'Month view is back');
  eq(text($('#insights .stat-primary .stat-value')), cardMonth, 'unchanged');
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

test('range toggle: This year is 12 months, Rolling 13 with the year under each month', async () => {
  $('[data-year-range="year"]').click();
  await settle();
  eq(options().length, 12, '12 months');
  eq(chart().state().centre, M, 'centred on the current month');
  eq($$('#year-chart .yc-year').length, 0, 'no year labels');
  eq(storage.getPref('yearRange'), 'year', 'remembered');
  $('[data-year-range="roll"]').click();
  await settle();
  eq(options().length, 13, '13 months');
  eq($$('#year-chart .yc-year').length, 13, "'YY under every month");
  eq(text($$('#year-chart .yc-year')[0]), `'${String(new Date(Y, M - 6, 1).getFullYear()).slice(2)}`, 'first month’s year');
});

test('stack toggle crossfades on the same chart', async () => {
  const before = chart();
  $('[data-year-stack="category"]').click();
  eq(chart(), before, 'no redraw');
  eq(chart().state().stack, 'category', 'by category');
  assert(text($('#year-chart .yc-legend')).includes('Utilities'), 'category legend');
  await settle();
  eq(chart().state().stack, 'category', 'still by category');
  $('[data-year-stack="type"]').click();
  await settle();
  assert(text($('#year-chart .yc-legend')).includes('Monthly plans'), 'type legend');
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
  const fab = $('#fab-stack').getBoundingClientRect();
  assert(!overlap(now, fab) && now.bottom < fab.top, `Jump to now is above the floating buttons (${Math.round(now.bottom)} < ${Math.round(fab.top)})`);
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
  goTab('insights');
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
  localStorage.removeItem('substracker.theme');

  // Bring in the app's own markup, then the app itself (which starts on import).
  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#insights .stat-primary'), 'Insights rendered');

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
