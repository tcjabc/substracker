// In-browser tests for 1.22.1 (js/app.js renderInsights and openForm, js/donut-3d.js, css/app.css):
// Insights, Month, By category: the Ring and Donut card capped at about 40% of the screen and never
// taller than the ring needs, pinned under the header while the legend scrolls beneath it, its one
// caption line, the legend's first rows on the first screen, a tapped or focused row never hidden
// behind the chart, the month arrows and Month | Year still working, List and Year as they were; and
// the add sheet starting at Name only when a hardware keyboard is likely (the sheet itself on a touch
// screen), the close button never with a ring. Run by tests/insights-chart.html with a fixed clock (18
// November 2026) against a throwaway database, with index.html's markup, at 320, 360 and 393px, with
// and without reduced motion emulated, in English, the pseudo-locale (?lang=xx) and zh-TW
// (?lang=zh-TW). ?hold=1 sets the app up and runs nothing.

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';
import { t } from '../js/i18n.js';
import { shareText } from '../js/donut-flat.js';
import { cashDue, incomeDue } from '../js/insights-calc.js';

const results = [];
const dbName = `substracker-test-chart-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'period', 'theme', 'reduceMotion', 'lang', 'insightsMode', 'catView', 'yearRange', 'yearStack', 'yearKey'];
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
  for (let t0 = 0; t0 < ms; t0 += 25) { if (cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}
const r0 = (n) => Math.round(n);
const T = (n) => money(n, 'TWD');

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// "Today" is Wednesday 18 November 2026. TWD only (no currency chips): November has six categories
// of 3% or more (Travel, House, Transport, Groceries, Health, Pets) and three small ones pooled into
// "Other", so the legend has seven rows and the page scrolls well past the chart.
const SEED = [
  { ...base, type: 'income', id: 'p-salary', name: 'Salary', price: 120000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, id: 'p-holiday', name: 'Holiday', price: 50000, cycle: 'once', date: '2026-11-28', category: 'Travel' },
  { ...base, id: 'p-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 'p-car', name: 'Car', price: 9000, cycle: 'monthly', nextRenewal: '2026-11-10', category: 'Transport' },
  { ...base, id: 'p-food', name: 'Food', price: 7000, cycle: 'monthly', nextRenewal: '2026-11-12', category: 'Groceries' },
  { ...base, id: 'p-gym', name: 'Gym', price: 5000, cycle: 'monthly', nextRenewal: '2026-11-14', category: 'Health' },
  { ...base, id: 'p-vet', name: 'Vet', price: 4000, cycle: 'once', date: '2026-11-21', category: 'Pets' },
  { ...base, id: 'p-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 'p-stream', name: 'Streaming', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
  { ...base, id: 'p-coffee', name: 'Coffee', price: 30, cycle: 'monthly', nextRenewal: '2026-12-05', category: 'Snacks' },
];

const reduced = () => document.documentElement.classList.contains('reduce-motion');
const box = (el) => el.getBoundingClientRect();
const fold = () => box($('.tabbar')).top;
const headerBottom = () => box($('.app-header')).bottom;
const chart = () => $('#insights .ins-chart');
const rows = () => $$('#insights .ins-legend .legend-row');
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(80); };
const px = (value) => { const p = document.createElement('div'); p.style.position = 'absolute'; p.style.height = value; document.body.append(p); const h = box(p).height; p.remove(); return h; };
/** The cap the card keeps to: the smaller of about 40% of the screen (clamped) and 3/4 of its width. */
const capFor = () => Math.min(px('var(--ins-chart-h)'), 0.75 * box($('#insights .ins-pinned')).width);

async function insights({ mode = 'month', view = 'donut' } = {}) {
  if ($('.tab[aria-selected="true"]')?.dataset.tab !== 'insights') await goTab('insights');
  const want = $(`#insights-actions [data-insights-mode="${mode}"]`);
  if (want.getAttribute('aria-pressed') !== 'true') { want.click(); await tick(80); }
  if (mode === 'month') {
    const b = $(`#insights [data-catview="${view}"]`);
    if (b.getAttribute('aria-pressed') !== 'true') { b.click(); await tick(60); }
    if (view === 'ring') await until(() => $('#insights .ring-canvas') || $('#insights .ring-note'), 'the Ring or its stand-in', 8000);
  }
  window.scrollTo(0, 0);
  await tick(80);
}
const ringShown = () => !!$('#insights .ring-canvas');
/** Let the Ring turn and settle (it snaps in well under a second; with Reduce motion it's the flat donut). */
const settleRing = () => tick(reduced() || !ringShown() ? 60 : 900);
/** The slice at the front (Ring) or lit (Donut): the legend row marked pressed. */
const pressed = () => rows().findIndex((r) => r.getAttribute('aria-pressed') === 'true');

/* ---------------------------------------------------------------- tests */

for (const view of ['ring', 'donut']) {
  test(`${view}: the card is capped (about 40% of the screen, never taller than the ring needs) and fully on the first screen, the total in its centre on one line`, async () => {
    await insights({ view });
    const c = box(chart());
    const cap = capFor();
    assert(c.height <= cap + 1, `the card is ${r0(c.height)}px, at most the cap ${r0(cap)}px`);
    assert(c.height <= innerHeight * 0.42, `at most about 40% of the screen (${r0(c.height)} of ${innerHeight})`);
    assert(c.height >= px('10rem') - 1, `at least the minimum (${r0(c.height)}px)`);
    assert(c.top >= headerBottom() - 0.5 && c.bottom <= fold() + 0.5, `on the first screen (${r0(c.top)}–${r0(c.bottom)})`);
    const total = $('#insights [data-roll="month-due"]');
    const tw = await storage.getAll();
    eq(Number(total.dataset.value), cashDue(tw.filter((s) => s.currency === 'TWD'), 2026, 10), 'the month total, from cashDue');
    const line = parseFloat(getComputedStyle(total).lineHeight) || parseFloat(getComputedStyle(total).fontSize) * 1.3;
    assert(box(total).height < line * 1.6, `the total on one line (${r0(box(total).height)}px for a ${r0(line)}px line)`);
    const tb = box(total);
    assert(tb.top >= c.top && tb.bottom <= c.bottom, 'inside the card');
    if (view === 'ring' && ringShown()) {
      const stage = $('#insights .ring-stage');
      const cy = parseFloat(stage.style.getPropertyValue('--ring-cy'));
      assert(Math.abs((tb.top + tb.bottom) / 2 - box(stage).top - cy) < 1.5, 'in the ring\'s hole, where the 3D view measured it');
      // No empty box: the ring (its hole × outer/inner radius) spans most of its stage, which fills the card.
      const ringW = parseFloat(stage.style.getPropertyValue('--ring-hole-w')) * (2.0 / 1.22);
      assert(ringW >= box(stage).width * 0.7, `the ring spans its stage (${r0(ringW)} of ${r0(box(stage).width)}px)`);
      assert(box(stage).height >= c.height - px('var(--space-2)') * 2 - 3, 'the stage fills the card');
    } else {
      const d = box($('#insights .donut'));
      assert(Math.abs((tb.left + tb.right) / 2 - (d.left + d.right) / 2) < 2 && Math.abs((tb.top + tb.bottom) / 2 - (d.top + d.bottom) / 2) < d.height * 0.12, 'in the donut\'s centre');
      assert(d.height >= c.height - px('var(--space-2)') * 2 - (text($('#insights .ring-note')) ? box($('#insights .ring-note')).height : 0) - 3, `the donut fills the card (${r0(d.height)} of ${r0(c.height)}px)`);
    }
    assert(total.scrollWidth <= total.clientWidth + 1, 'the total shows in full');
  });
}

test('the Ring\'s caption is one line: the front slice, its amount and share; the share line and the month arrows are as they were', async () => {
  await insights({ view: 'ring' });
  const tw = (await storage.getAll()).filter((s) => s.currency === 'TWD');
  const out = cashDue(tw, 2026, 10);
  eq(text($('#insights .ins-pct')), t('insights.pctOfIncome', { pct: Math.round((out / incomeDue(tw, 2026, 10)) * 100) }), 'the share line');
  assert($('#insights .month-nav [data-month-step="-1"]') && $('#insights .month-nav [data-month-step="1"]'), 'the arrows');
  if (!ringShown()) { assert(reduced() || text($('#insights .ring-note')), 'the flat donut stands in, saying why'); return; }
  const cap = $('#insights .ring-caption');
  const line = parseFloat(getComputedStyle(cap).lineHeight) || 20;
  assert(box(cap).height < line * 1.6, `one line (${r0(box(cap).height)}px)`);
  eq([text($('.ring-name', cap)), text($('.ring-amount', cap)), text($('.ring-share', cap))], ['Travel', T(50000), shareText(50000, out)], 'name, amount, share');
  assert(box(cap).bottom <= box(chart()).bottom && box(cap).top >= box($('#insights .ring-total')).bottom, 'under the total, inside the card');
  for (const s of $$('span', cap)) assert(box(s).right <= box(chart()).right + 0.5 && box(s).left >= box(chart()).left - 0.5, `"${text(s)}" inside the card`);
});

test('on landing the legend\'s first rows show under the chart', async () => {
  for (const view of ['ring', 'donut']) {
    await insights({ view });
    const c = box(chart());
    const legend = box($('#insights .ins-legend'));
    assert(legend.top >= c.bottom - 0.5 && legend.top - c.bottom <= px('var(--space-3)'), `${view}: the legend right under the card (${r0(legend.top - c.bottom)}px)`);
    const shown = rows().filter((r) => box(r).bottom <= fold() + 0.5).length;
    const want = innerHeight >= 700 ? 3 : 2;
    assert(shown >= want, `${view}: ${shown} rows fully on the first screen (at least ${want})`);
  }
});

test('the chart stays pinned under the header while the list scrolls beneath it, clear of the header and the tab bar, and leaves with the list', async () => {
  for (const view of ['ring', 'donut']) {
    await insights({ view });
    const top0 = box(chart()).top;
    const h0 = box(chart()).height;
    for (const y of [80, 200, 320]) {
      window.scrollTo(0, y);
      await tick(40);
      const c = box(chart());
      if (y >= top0 - headerBottom()) assert(Math.abs(c.top - headerBottom()) < 1, `${view} at ${y}: pinned right under the header (${r0(c.top)} / ${r0(headerBottom())})`);
      assert(c.top >= headerBottom() - 0.5, `${view} at ${y}: never under the header`);
      assert(c.bottom <= fold() + 0.5, `${view} at ${y}: never over the tab bar`);
      eq(r0(c.height), r0(h0), `${view} at ${y}: the same size (no shrink)`);
      eq(getComputedStyle(chart()).zIndex !== 'auto' && Number(getComputedStyle(chart()).zIndex) < Number(getComputedStyle($('.app-header')).zIndex), true, `${view}: under the header in the stack`);
    }
    // Past the list the card goes with it, so the notices and the yearly card are never under it.
    $('#insights .ins-stats').scrollIntoView({ block: 'start' });
    await tick(60);
    assert(box(chart()).bottom <= box($('#insights .ins-legend')).bottom + 0.5, `${view}: the card scrolls away with the end of the list`);
    assert(box($('#insights .ins-stats')).top >= box(chart()).bottom - 0.5, `${view}: the yearly card is never under it`);
  }
  window.scrollTo(0, 0);
});

for (const view of ['ring', 'donut']) {
  test(`${view}: tapping a row ${view === 'ring' ? 'brings its slice to the front' : 'lights its slice'} right above it, and a focused row is never hidden behind the chart`, async () => {
    await insights({ view });
    // Scroll until the chart is pinned and a row near the end sits just under it, then tap that row.
    const list = rows();
    const target = list.length - 2;
    window.scrollTo(0, box(list[target]).top + scrollY - box(chart()).height - headerBottom() - 4);
    await tick(60);
    const row = list[target];
    // The Donut keeps the last highlight (a tap on the lit row clears it): start from another one.
    if (view === 'donut' && pressed() === target) { list[0].click(); await tick(30); }
    assert(box(row).top >= box(chart()).bottom - 0.5, `the row is below the pinned chart (${r0(box(row).top)} / ${r0(box(chart()).bottom)})`);
    const before = scrollY;
    row.click();
    await settleRing();
    eq(pressed(), target, 'its slice is the one shown');
    if (view === 'ring' && ringShown()) eq(text($('#insights .ring-name')), text($('.legend-name', row)), 'the caption names it');
    if (view === 'donut' || !ringShown()) assert($(`#insights .donut-slice[data-slice="${row.dataset.slice}"]`).classList.contains('is-active'), 'its slice lights up');
    eq(r0(scrollY), r0(before), 'the page doesn\'t jump');
    assert(box(row).top >= box(chart()).bottom - 0.5, 'the row is still clear of the chart');
    // Keyboard: a row scrolled under the pinned chart comes back into view when it gets focus.
    window.scrollTo(0, scrollY + 260);
    await tick(40);
    list[1].focus();
    await tick(60);
    assert(box(list[1]).top >= box(chart()).bottom - 1 && box(list[1]).bottom <= fold() + 1, `a focused row shows below the chart (${r0(box(list[1]).top)}–${r0(box(list[1]).bottom)}; chart ends ${r0(box(chart()).bottom)})`);
    window.scrollTo(0, 0);
  });
}

test('the month arrows and Month | Year still work with the pinned chart; List and Year are as they were', async () => {
  await insights({ view: 'donut' });
  $('#insights [data-month-step="1"]').click();
  await tick(60);
  assert($('#insights .ins-pinned > .ins-chart') && $('#insights .ins-pinned > .ins-legend'), 'December: pinned card and its legend');
  $('#insights [data-month-step="-1"]').click();
  await tick(60);
  await insights({ view: 'list' });
  assert(!$('#insights .ins-pinned'), 'List: nothing pinned');
  eq(getComputedStyle(chart()).position, 'static', 'List: the list scrolls with the page');
  assert(box(chart()).height > px('var(--ins-chart-h)'), 'List: the list isn\'t capped (seven categories run past it)');
  assert(!$('#insights .ins-legend'), 'List: the list is the hero, no second legend');
  await insights({ mode: 'year' });
  assert(!$('#insights .ins-pinned') && $('#insights .ins-hero-fill') && $('#year-chart .yc-svg'), 'Year: the year chart fills the first screen as before');
  eq(getComputedStyle(document.documentElement).scrollPaddingTop, 'auto', 'Year: no scroll padding for a pinned chart');
  await insights({ mode: 'month', view: 'donut' });
  assert(getComputedStyle(document.documentElement).scrollPaddingTop !== 'auto', 'Month: the page keeps rows clear of the pinned chart');
  await goTab('subs');
  eq(getComputedStyle(document.documentElement).scrollPaddingTop, 'auto', 'Money: no scroll padding');
  await insights({ view: 'donut' });
});

test('Reduce motion and effects: the Ring stands in as the flat donut, capped and pinned the same; tapping a row just changes it', async () => {
  if (!reduced()) {
    // With motion: the Ring (when this browser has WebGL) is the one capped and pinned.
    await insights({ view: 'ring' });
    assert($('#insights .ins-pinned > .ins-chart'), 'pinned');
    return;
  }
  await insights({ view: 'ring' });
  eq(text($('#insights .ring-note')), t('donut.flat.reduced'), 'the flat donut, and why');
  assert($('#insights .ins-pinned > .ins-chart .donut'), 'capped and pinned');
  assert(box(chart()).height <= capFor() + 1, 'within the cap');
  rows()[2].click();
  await tick(30);
  eq(pressed(), 2, 'the highlight moves at once');
  rows()[2].click();
});

test('add sheet: on a touch screen it starts on the sheet (no phone keyboard); with a keyboard or a mouse at Name; the close button never shows a ring', async () => {
  await goTab('subs');
  const sheet = $('#sub-dialog');
  const close = $('#sub-dialog .sheet-head [data-close]');
  const name = $('#sub-form').elements.name;
  const open = () => sheet.open || sheet.hasAttribute('open');
  const shut = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(40); };
  const add = async (input) => {
    const fab = $('#fab');
    if (input === 'key') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    else fab.dispatchEvent(new PointerEvent('pointerdown', { pointerType: input, isPrimary: true, bubbles: true }));
    fab.click();
    await until(open, 'the add sheet opens');
    await tick(40);
  };
  await add('touch');
  eq(document.activeElement, sheet, 'touch: the sheet itself has focus, so no keyboard opens');
  assert(!close.matches(':focus-visible') && document.activeElement !== close, 'touch: no ring on the close button');
  name.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true }));
  name.focus();
  eq(document.activeElement, name, 'touch: tapping Name takes focus there (the keyboard opens as usual)');
  await shut();
  await add('key');
  eq(document.activeElement, name, 'keyboard: Name has focus');
  assert(!close.matches(':focus-visible'), 'keyboard: no ring on the close button');
  await shut();
  await add('mouse');
  eq(document.activeElement, matchMedia('(hover: hover) and (pointer: fine)').matches ? name : sheet, 'mouse (a fine pointer that hovers): Name');
  await shut();
  await add('pen');
  eq(document.activeElement, sheet, 'pen: the sheet');
  await shut();
  // Editing starts on the sheet whatever was used last.
  for (const input of ['touch', 'key']) {
    if (input === 'key') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    else document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', isPrimary: true, bubbles: true }));
    await insights({ view: 'donut' });
    $('#insights .rank-row').click();
    await until(open, 'the edit sheet opens');
    await tick(40);
    eq(document.activeElement, sheet, `editing after ${input}: the sheet`);
    assert(!close.matches(':focus-visible'), `editing after ${input}: no ring on the close button`);
    await shut();
  }
  await add('touch');
  const controls = $$('button, input, select, textarea', sheet).filter((el) => el.getClientRects().length && !el.disabled);
  eq(controls[0], close, 'the close button is still first in Tab order');
  await shut();
  await goTab('insights');
});

test('light and dark: the pinned card is opaque, so the rows passing under it never show through', async () => {
  for (const theme of ['light', 'dark']) {
    const s = $('#set-theme');
    s.value = theme;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(60);
    for (const view of ['ring', 'donut']) {
      await insights({ view });
      const bg = getComputedStyle(chart()).backgroundColor;
      assert(!/rgba\(.*,\s*0(\.\d+)?\)$/.test(bg) && bg !== 'transparent', `${theme} ${view}: an opaque card (${bg})`);
      eq(bg, getComputedStyle($('#insights .ins-legend')).backgroundColor, `${theme} ${view}: the card colour, as the legend's`);
    }
  }
  const s = $('#set-theme');
  s.value = 'light';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  await tick(60);
});

test('nothing clips or runs sideways (every view, this language)', async () => {
  for (const view of ['ring', 'donut', 'list']) {
    await insights({ view });
    assert(document.documentElement.scrollWidth <= innerWidth + 1, `${view}: no sideways scroll`);
    for (const el of $$('#insights .ins-chart .ins-total, #insights .ring-caption, #insights .legend-name, #insights .cat-amount')) {
      if (!el.clientWidth) continue;
      const b = box(el);
      assert(b.right <= innerWidth + 0.5 && b.left >= -0.5, `${view}: "${text(el)}" on screen`);
    }
  }
  await insights({ view: 'donut' });
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'insights');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', params.get('theme') === 'dark' ? 'dark' : 'light');
  storage.setPref('insightsMode', 'month');
  storage.setPref('catView', 'donut');
  storage.setPref('yearRange', 'year');
  storage.setPref('yearStack', 'type');
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
  await until(() => $('#insights .month-nav'), 'Insights drawn', 8000);
  await tick(300);
  if (HOLD) { window.testResults = { total: 0, passed: 0, failures: [], hold: true }; return; }

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
    const f = failures.find((x) => x.name === name);
    return `<li class="${f ? 't-fail' : 't-pass'}">${f ? '✗' : '✓'} ${name}${f ? `<div class="t-detail">${f.error.replace(/</g, '&lt;')}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-chart-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
