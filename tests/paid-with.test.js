// In-browser tests for Insights' By category | Paid with (1.29.0; js/paid-with.js, js/app.js
// renderInsights, js/donut-flat.js). Run by tests/paid-with.html with a fixed clock (18 November 2026)
// against a throwaway database, with index.html's markup. Run it at 320, 360 and 393px, with and
// without reduced motion emulated, and in English, the pseudo-locale (?lang=xx) and zh-TW
// (?lang=zh-TW). Expected words come from t(), so every language checks the same things. The tests
// run in order, as one session in the app.

import * as storage from '../js/storage.js';
import { t, formatLocale } from '../js/i18n.js';
import { money } from '../js/util.js';
import { listCards } from '../js/cards.js';
import { breakdown } from '../js/insights-calc.js';
import { paidWith, paidWithSlices, PAY_KEY_CASH, PAY_KEY_NONE, PAY_KEY_OTHER, payCardKey } from '../js/paid-with.js';
import { shareText } from '../js/donut-flat.js';
import * as syncCore from '../js/sync-core.js';

const results = [];
const dbName = `substracker-test-paidwith-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang', 'insightsMode', 'catView', 'insightsBy', 'yearRange', 'yearStack', 'yearKey'];
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
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const text = (el) => norm(el?.textContent);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t0 = 0; t0 < ms; t0 += 25) { if (await cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// November 2026 in TWD: Cash 18,000, Visa 1,590, LINE 1,500 (a colour this version can't draw), Amex
// 999, two tiny cards (pooled into Other cards), and Not set 315 (no pay, and a deleted card's).
const SEED = [
  { ...base, type: 'income', id: 'i-pay', name: 'Salary', price: 50000, cycle: 'monthly', nextRenewal: '2026-11-25', pay: 'k_visa' },
  { ...base, id: 'e-rent', name: 'Rent', price: 18000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'Housing', pay: 'cash' },
  { ...base, id: 'e-netflix', name: 'Netflix', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment', pay: 'k_visa' },
  { ...base, id: 'e-gym', name: 'Gym', price: 1200, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Health', pay: 'k_visa' },
  { ...base, id: 'e-phone', name: 'Phone', price: 999, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities', pay: 'k_amex' },
  { ...base, id: 'e-cloud', name: 'Cloud', price: 90, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 'e-misc', name: 'Misc', price: 150, cycle: 'monthly', nextRenewal: '2026-11-26' },
  { ...base, id: 'e-old', name: 'Old plan', price: 75, cycle: 'monthly', nextRenewal: '2026-11-03', pay: 'k_gone' },
  { ...base, id: 'e-line', name: 'Line plan', price: 1500, cycle: 'monthly', nextRenewal: '2026-11-09', category: 'Utilities', pay: 'k_line' },
  { ...base, id: 'e-t1', name: 'Tiny one', price: 20, cycle: 'monthly', nextRenewal: '2026-11-10', category: 'Snacks', pay: 'k_t1' },
  { ...base, id: 'e-t2', name: 'Tiny two', price: 15, cycle: 'monthly', nextRenewal: '2026-11-11', category: 'Snacks', pay: 'k_t2' },
  { ...base, id: 'e-tool', name: 'Tool', price: 10, currency: 'USD', cycle: 'monthly', nextRenewal: '2026-11-22', category: 'Utilities', pay: 'k_visa' },
  { ...base, id: 'e-app', name: 'App', price: 5, currency: 'USD', cycle: 'monthly', nextRenewal: '2026-11-12', category: 'Utilities', pay: 'cash' },
];

const reduced = () => document.documentElement.classList.contains('reduce-motion');
const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { if (appTab() !== name) { $(`#tab-${name}`).click(); await tick(80); } };
const monthName = () => new Date(2026, 10, 1).toLocaleDateString(formatLocale(), { month: 'long', year: 'numeric' });
const rows = () => $$('#insights .legend-row');
const by = (which) => $(`#insights [data-ins-by="${which}"]`);
async function insights({ view = 'donut', which = null, currency = 'TWD' } = {}) {
  await goTab('insights');
  const mode = $('#insights-actions [data-insights-mode="month"]');
  if (mode.getAttribute('aria-pressed') !== 'true') { mode.click(); await tick(80); }
  const chip = $(`#currency-chips [data-currency="${currency}"]`);
  if (chip && chip.getAttribute('aria-pressed') !== 'true') { chip.click(); await tick(60); }
  const b = $(`#insights [data-catview="${view}"]`);
  if (b.getAttribute('aria-pressed') !== 'true') { b.click(); await tick(60); }
  if (which && by(which).getAttribute('aria-pressed') !== 'true') { by(which).click(); await tick(60); }
  if (view === 'ring') await until(() => $('#insights .ring-canvas') || $('#insights .ring-note'), 'the Ring or its stand-in', 8000);
  window.scrollTo(0, 0);
  await tick(60);
}
/** What Paid with should show for a currency, from the pure modules and the stored data. */
async function expected(currency = 'TWD') {
  const subs = (await storage.getAll()).filter((s) => s.currency === currency && s.type !== 'income');
  const b = breakdown(subs, 2026, 10);
  const cards = listCards(await storage.getSettingsRecord());
  return { total: b.total, slices: paidWithSlices(paidWith(b.byCategory.flatMap((c) => c.items), cards), b.total) };
}
const labelOf = (s) => (s.kind === 'card' ? s.card.name : s.kind === 'cash' ? t('form.pay.cash') : s.kind === 'other' ? t('donut.otherCards') : t('form.pay.notSet'));

/* ---------------------------------------------------------------- tests */

test('the switch: By category | Paid with before Ring | Donut | List, By category pressed; the heading stays for screen readers', async () => {
  await insights({ view: 'donut' });
  const sw = $('#insights .ins-by');
  assert(sw, 'the switch shows (there are cards)');
  eq(sw.getAttribute('role'), 'group', 'a group');
  eq(sw.getAttribute('aria-label'), t('insights.by.label'), 'its label');
  eq($$('button', sw).map((b) => [text(b), b.getAttribute('aria-pressed')]), [[norm(t('insights.by.category')), 'true'], [norm(t('insights.by.pay')), 'false']], 'By category, then Paid with');
  const head = $('#insights .ins-chart-head');
  eq([...head.children].map((c) => c.classList.contains('ins-by') ? 'by' : c.classList.contains('ins-views') ? 'views' : c.tagName), ['H2', 'by', 'views'], 'heading, switch, views');
  assert($('#cat-title').classList.contains('sr-only'), 'the heading is for screen readers');
  eq(text($('#cat-title')), norm(t('insights.byCategory')), 'naming the choice');
  eq($('#insights .ins-legend').getAttribute('aria-label'), t('insights.byCategory'), 'the legend\'s label');
});

test('Paid with: each card, Cash, Other cards and Not set; amounts and the centre add up to By category\'s month total; saved per device', async () => {
  await insights({ view: 'donut', which: 'category' });
  const catTotal = Number($('#insights [data-roll="month-due"]').dataset.value);
  await insights({ view: 'donut', which: 'pay' });
  const exp = await expected();
  eq(exp.total, catTotal, 'the pure total is By category\'s');
  eq(Number($('#insights [data-roll="month-due"]').dataset.value), catTotal, 'the centre: the same month total');
  eq(rows().map((r) => r.dataset.slice), [PAY_KEY_CASH, payCardKey('k_visa'), payCardKey('k_line'), payCardKey('k_amex'), PAY_KEY_OTHER, PAY_KEY_NONE], 'largest first, Other cards, then Not set');
  eq(rows().map((r) => text(r.querySelector('.legend-name'))), exp.slices.map((s) => norm(labelOf(s))), 'the names');
  eq(rows().map((r) => text(r.querySelector('.cat-amount')).replace(text(r.querySelector('.pct')), '').trim()), exp.slices.map((s) => norm(money(s.total, 'TWD'))), 'the amounts');
  eq(exp.slices.reduce((a, s) => a + s.total, 0), catTotal, 'they add up to the month total');
  eq(exp.slices.find((s) => s.key === PAY_KEY_NONE).total, 90 + 150 + 75, 'Not set: no pay, and the deleted card\'s item');
  eq(text($(`#insights .legend-row[data-slice="${PAY_KEY_OTHER}"] .legend-sub`)), norm(['Tiny one', 'Tiny two'].join(t('common.listSep'))), 'Other cards names the cards pooled');
  eq(storage.getPref('insightsBy'), 'pay', 'kept on this device');
  eq(by('pay').getAttribute('aria-pressed'), 'true', 'Paid with pressed');
  eq(text($('#cat-title')), norm(t('insights.byPay')), 'the heading names Paid with');
  eq($('#insights .ins-legend').getAttribute('aria-label'), t('insights.byPay'), 'and the legend\'s label');
});

test('Paid with: cards in their colours with the card glyph; LINE and Other cards the neutral outline; Cash and Not set as dots', async () => {
  await insights({ view: 'donut', which: 'pay' });
  const row = (k) => $(`#insights .legend-row[data-slice="${k}"]`);
  eq($('.card-glyph', row(payCardKey('k_visa')))?.dataset.colour, 'c7', 'Visa\'s glyph in its colour');
  eq($('.card-glyph', row(payCardKey('k_amex')))?.dataset.colour, 'c3', 'Amex\'s');
  assert($('.card-glyph', row(payCardKey('k_line'))) && !('colour' in $('.card-glyph', row(payCardKey('k_line'))).dataset), 'LINE: the neutral outline');
  assert($('.card-glyph', row(PAY_KEY_OTHER)) && !('colour' in $('.card-glyph', row(PAY_KEY_OTHER)).dataset), 'Other cards: the neutral outline');
  assert($$('#insights .legend .card-glyph').every((g) => g.getAttribute('aria-hidden') === 'true'), 'glyphs hidden from screen readers');
  for (const [k, v] of [[PAY_KEY_CASH, 'var(--pay-cash)'], [PAY_KEY_NONE, 'var(--pay-none)']]) {
    eq(row(k).querySelector('.legend-dot')?.style.getPropertyValue('--swatch').trim(), v, `${k}: a dot`);
  }
  const slice = (k) => $(`#insights .donut-slice[data-slice="${k}"]`).style.getPropertyValue('--swatch').trim();
  eq([slice(payCardKey('k_visa')), slice(payCardKey('k_line')), slice(PAY_KEY_CASH), slice(PAY_KEY_NONE), slice(PAY_KEY_OTHER)],
    ['var(--card-c7)', 'var(--pay-card-neutral)', 'var(--pay-cash)', 'var(--pay-none)', 'var(--pay-card-neutral)'], 'the donut\'s slice colours');
  // Each slice colour is a real colour in the theme (the Ring reads them the same way).
  for (const v of ['--card-c7', '--pay-cash', '--pay-none', '--pay-card-neutral']) assert(getComputedStyle(document.documentElement).getPropertyValue(v).trim(), `${v} is set`);
});

test('Paid with: the donut, the keys help and the Ring read "by payment method"', async () => {
  await insights({ view: 'donut', which: 'pay' });
  eq($('#insights .donut svg').getAttribute('aria-label'), t('donut.labelPay', { month: monthName() }), 'the donut');
  await insights({ view: 'ring', which: 'pay' });
  const exp = await expected();
  if ($('#insights .ring-stage')) {
    eq(text($('#ring-help')), norm(t('donut.ring.helpPay')), 'the Ring\'s help');
    const s = exp.slices[0];
    const front = t('donut.ring.describe', { name: labelOf(s), amount: money(s.total, 'TWD'), share: shareText(s.total, exp.total) });
    eq($('#insights .ring-stage').getAttribute('aria-label'), t('donut.ring.labelFrontPay', { month: monthName(), front }), 'the Ring, naming the front slice');
  } else {
    eq(text($('#donut-keys-help')), norm(t('donut.keysHelpPay')), 'the flat donut standing in: its keys help');
    assert(text($('#insights .ring-note')), 'saying why');
  }
});

test('a legend row turns the Ring to it or lights it; switching By category | Paid with clears it', async () => {
  await insights({ view: 'donut', which: 'pay' });
  $(`#insights .legend-row[data-slice="${payCardKey('k_visa')}"]`).click();
  await tick(40);
  eq(rows().filter((r) => r.getAttribute('aria-pressed') === 'true').map((r) => r.dataset.slice), [payCardKey('k_visa')], 'Visa lit');
  by('category').click();
  await tick(60);
  eq(rows().filter((r) => r.getAttribute('aria-pressed') === 'true').length, 0, 'By category: nothing lit');
  eq(document.activeElement, by('category'), 'focus stays on the switch');
  by('pay').click();
  await tick(60);
  eq(rows().filter((r) => r.getAttribute('aria-pressed') === 'true').length, 0, 'back to Paid with: nothing lit');
  await insights({ view: 'ring', which: 'pay' });
  const amex = () => $(`#insights .legend-row[data-slice="${payCardKey('k_amex')}"]`);
  amex().click();
  // The row read again: a Ring that can't run here draws the flat donut in its place.
  await until(() => amex()?.getAttribute('aria-pressed') === 'true', 'the Ring (or its stand-in) brings Amex to the front', 3000);
  if ($('#insights .ring-canvas')) eq(text($('#insights .ring-name')), 'Amex', 'the caption names it');
});

test('List view: the switch is there too; the rows by payment method with their amounts and the month total', async () => {
  await insights({ view: 'list', which: 'pay' });
  assert($('#insights .ins-by'), 'the switch in List view');
  const exp = await expected();
  eq($$('#insights .ins-list .cat-row .cat-name').map((n) => text(n).replace(/\s\d+$/, '')), exp.slices.map((s) => norm(labelOf(s))), 'the rows');
  eq($$('#insights .ins-list .cat-row .cat-amount').map((a) => text(a).replace(text(a.querySelector('.pct')), '').trim()), exp.slices.map((s) => norm(money(s.total, 'TWD'))), 'their amounts');
  eq(Number($('#insights .ins-list [data-roll="month-due"]').dataset.value), exp.total, 'the month total');
  by('category').click();
  await tick(60);
  assert($$('#insights .ins-list .cat-row').length > 0 && !$('#insights .ins-list .cat-row .card-glyph'), 'By category again');
});

test('the currency chip: Paid with follows it (USD), adding up to USD\'s By category total', async () => {
  await insights({ view: 'donut', which: 'category', currency: 'USD' });
  const catTotal = Number($('#insights [data-roll="month-due"]').dataset.value);
  await insights({ view: 'donut', which: 'pay', currency: 'USD' });
  const exp = await expected('USD');
  eq(exp.total, catTotal, 'USD By category total');
  eq(Number($('#insights [data-roll="month-due"]').dataset.value), catTotal, 'the centre');
  eq(rows().map((r) => r.dataset.slice), exp.slices.map((s) => s.key), 'Visa and Cash');
  eq(rows().map((r) => r.dataset.slice).sort(), [PAY_KEY_CASH, payCardKey('k_visa')].sort(), 'Visa and Cash, in USD');
  await insights({ view: 'donut', which: 'category', currency: 'TWD' });
});

test('the header row at this width and language: nothing overflows; Ring | Donut | List end on the right; the card height is the same', async () => {
  for (const view of ['ring', 'donut', 'list']) {
    await insights({ view, which: 'pay' });
    const head = $('#insights .ins-chart-head');
    assert(head.scrollWidth <= head.clientWidth + 1, `${view}: the row doesn't overflow (${head.scrollWidth} > ${head.clientWidth})`);
    for (const b of $$('.seg-btn', head)) assert(b.scrollWidth <= b.clientWidth + 1, `${view}: "${text(b) || b.title}" shows in full`);
    const h = head.getBoundingClientRect();
    const v = $('.ins-views', head).getBoundingClientRect();
    assert(Math.abs(v.right - h.right) < 1, `${view}: the views end on the right`);
    const s = $('.ins-by', head).getBoundingClientRect();
    assert(s.left >= h.left - 0.5 && s.right <= h.right + 0.5, `${view}: the switch inside the row`);
    assert(v.top >= s.bottom - 1 || v.left >= s.right, `${view}: the views beside or under the switch, never over it`);
    if (view !== 'list') {
      const card = $('#insights .ins-pinned > .ins-chart').getBoundingClientRect().height;
      by('category').click();
      await tick(view === 'ring' ? 400 : 60);
      eq(Math.round($('#insights .ins-pinned > .ins-chart').getBoundingClientRect().height), Math.round(card), `${view}: the pinned card is as tall either way`);
    }
  }
});

test('Year has no switch; the month view without the switch as before when By category', async () => {
  await goTab('insights');
  $('#insights-actions [data-insights-mode="year"]').click();
  await tick(120);
  assert(!$('#insights .ins-by'), 'no switch on the year chart');
  $('#insights-actions [data-insights-mode="month"]').click();
  await tick(120);
  assert($('#insights .ins-by'), 'back on the month');
});

test('switching writes nothing but the device preference; with Reduce motion and effects it starts no animation', async () => {
  await insights({ view: 'donut', which: 'category' });
  const pending = (await storage.pendingOps()).length;
  by('pay').click();
  await tick(5);
  if (reduced()) {
    const running = document.getAnimations().filter((a) => a.playState === 'running' && $('#insights').contains(a.effect?.target));
    eq(running.length, 0, 'no animation');
  }
  await tick(60);
  eq((await storage.pendingOps()).length, pending, 'no sync op');
  eq(localStorage.getItem('substracker.insightsBy'), 'pay', 'the preference');
  by('category').click();
  await tick(60);
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveCard('k_visa', { name: 'Visa', colour: 'c7', cut: 20, due: 5 });
  await storage.saveCard('k_amex', { name: 'Amex', colour: 'c3', due: 21 });
  await storage.saveCard('k_t1', { name: 'Tiny one', colour: 'c4' });
  await storage.saveCard('k_t2', { name: 'Tiny two', colour: 'c5' });
  await storage.saveCard('k_gone', { name: 'Gone', colour: 'c6' });
  await storage.deleteCard('k_gone');
  await storage.save({ ...SEED.find((s) => s.id === 'e-old') }); // still on the deleted card, as an older copy has it
  {
    const r = { clock: syncCore.newClock('later-device'), records: new Map() };
    const ops = syncCore.setFields(r, 'settings', { card_k_line: { name: 'LINE', colour: 'w3' } }, { now: Date.now() - 60_000 });
    await storage.applyRemote(ops, 1);
  }
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'insights');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  storage.setPref('insightsMode', 'month');
  storage.setPref('catView', 'donut');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  for (const p of ['groupSort', 'insightsBy', 'yearRange', 'yearStack', 'yearKey']) localStorage.removeItem(`substracker.${p}`);
  if (LANG === 'zh-TW') storage.setPref('lang', 'zh-TW'); else localStorage.removeItem('substracker.lang');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#insights .ins-hero'), 'Insights drawn', 8000);
  await tick(300);

  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; } catch (err) { failures.push({ name, error: err.message }); }
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
      if (name?.startsWith('substracker-test-paidwith-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
