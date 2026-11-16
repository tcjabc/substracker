// In-browser tests for the app screens (js/app.js): the Insights month view and the Money tab
// summary strip on a cash basis (outgoings and income), the "needs a renewal date" and "needs a payment date" notices, and the
// add/edit form requiring a renewal or payment date (with field-level saves and rollover still
// working). Open tests/app.html from a local server. The app runs with
// index.html's markup against a throwaway database, seeded with made-up items dated relative to
// today, so the tests work in any month. The tests run in order, as one session in the app.

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';

const results = [];
const dbName = `substracker-test-app-${Date.now()}`;
const PREFS = ['tab', 'catView', 'view', 'period', 'insightsMode', 'yearRange'];
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

test('centre highlight: outline, spotlight and label pill on the centre month; none of it in focus but the outline', async () => {
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
  eq($('#year-chart .yc-spot').parentNode.getAttribute('display'), 'inline', 'spotlight shown');
  assert(!$$('#year-chart .yc-shadow').length, 'no shadow rects');
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
  eq($('#year-chart .yc-spot').parentNode.getAttribute('display'), 'none', 'no spotlight in focus');
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
