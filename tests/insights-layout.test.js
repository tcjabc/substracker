// In-browser tests for the Insights layout since 1.22.0 (js/app.js renderInsights, renderYearView;
// js/donut-flat.js, js/donut-3d.js, js/year-chart.js; css/app.css): Month | Year beside the title,
// the month arrows under it, the share-of-income line in place of the old purple card and its
// sentence, the chart filling the first screen with the month total in its centre, the legend
// (with the month's plan counts) and the yearly card below the fold, the year chart's 'YY where
// This year wraps, its readout clear of the scale at 320px, the dark theme's Other slice, and
// Insights' own room under the tab bar. Run by tests/insights-layout.html with a fixed clock (18
// November 2026) against a throwaway database, with index.html's markup, at 320, 360 and 393px,
// with and without reduced motion emulated, in English, the pseudo-locale (?lang=xx) and zh-TW
// (?lang=zh-TW). Expected words come from t() and figures from js/insights-calc.js. ?hold=1 sets
// the app up and runs nothing (for looking at it).

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';
import { t } from '../js/i18n.js';
import { parseColour, contrast } from '../js/wallet-math.js';
import { breakdown, cashDue, incomeDue, yearSummary } from '../js/insights-calc.js';
import { wrapRel } from '../js/year-chart-math.js';

const results = [];
const dbName = `substracker-test-insights-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang', 'insightsMode', 'catView', 'yearRange', 'yearStack', 'yearKey'];
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
const T = (n) => money(n, 'TWD');
const r0 = (n) => Math.round(n);

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// "Today" is Wednesday 18 November 2026. TWD in November: Salary 40,000 in; out Rent 30,000 (House),
// the Holiday 50,000 (Travel), Phone 499, Streaming 390 and Coffee 30 (each under 3%, so one "Other"
// slice); Gym is undated. Cash due 80,919: 202% of the income. USD has an income item paid only in
// June (so "none paid" in November) and AWS; EUR has an expense and no income at all ("none recorded").
const SEED = [
  { ...base, type: 'income', id: 'i-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, type: 'income', id: 'i-bonus', name: 'Bonus', price: 12000, cycle: 'annual', nextRenewal: '2027-03-10' },
  { ...base, id: 'i-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 'i-holiday', name: 'Holiday', price: 50000, cycle: 'once', date: '2026-11-28', category: 'Travel' },
  { ...base, id: 'i-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 'i-stream', name: 'Streaming', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
  { ...base, id: 'i-coffee', name: 'Coffee', price: 30, cycle: 'monthly', nextRenewal: '2026-12-05', category: 'Snacks' },
  { ...base, id: 'i-gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
  { ...base, currency: 'USD', id: 'i-aws', name: 'AWS', price: 15, cycle: 'monthly', nextRenewal: '2026-12-09', category: 'Cloud' },
  { ...base, currency: 'USD', type: 'income', id: 'i-gig', name: 'Gig', price: 200, cycle: 'annual', nextRenewal: '2027-06-15' },
  { ...base, currency: 'EUR', id: 'i-eur', name: 'Hosting', price: 12, cycle: 'monthly', nextRenewal: '2026-11-30', category: 'Cloud' },
];

const reduced = () => document.documentElement.classList.contains('reduce-motion');
const roller = () => $('#money-summary').roller;
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(80); };
const fold = () => $('.tabbar').getBoundingClientRect().top;
const headerBottom = () => $('.app-header').getBoundingClientRect().bottom;
const box = (el) => el.getBoundingClientRect();
const fmt = (r) => `${r0(r.top)}–${r0(r.bottom)} × ${r0(r.left)}–${r0(r.right)}`;
/** Fully on the first screen: under the header, above the tab bar, inside the width. */
function onFirstScreen(el, what) {
  assert(el, `${what} is there`);
  const r = box(el);
  assert(r.height > 0 && r.top >= headerBottom() - 0.5 && r.bottom <= fold() + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5,
    `${what} is fully on the first screen (${fmt(r)}; header ends ${r0(headerBottom())}, tab bar starts ${r0(fold())})`);
}
const overlaps = (a, b, slack = 0.5) => a.left < b.right - slack && b.left < a.right - slack && a.top < b.bottom - slack && b.top < a.bottom - slack;
const shown = (el) => el && getComputedStyle(el).display !== 'none' && el.getAttribute('display') !== 'none';

async function insights({ mode = 'month', view = null, currency = 'TWD' } = {}) {
  if ($('.tab[aria-selected="true"]')?.dataset.tab !== 'insights') await goTab('insights');
  const want = $(`#insights-actions [data-insights-mode="${mode}"]`);
  if (want.getAttribute('aria-pressed') !== 'true') { want.click(); await tick(80); }
  const chip = $(`#currency-chips [data-currency="${currency}"]`);
  if (chip && chip.getAttribute('aria-pressed') !== 'true') { chip.click(); await tick(60); }
  if (mode === 'month' && view) {
    const b = $(`#insights [data-catview="${view}"]`);
    if (b.getAttribute('aria-pressed') !== 'true') { b.click(); await tick(60); }
    if (view === 'ring') await until(() => $('#insights .ring-canvas') || $('#insights .ring-note') || !$('#insights .ring-stage'), 'the Ring or its stand-in', 8000);
  }
  window.scrollTo(0, 0);
  await tick(60);
}
function setTheme(theme) {
  const s = $('#set-theme');
  s.value = theme;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}
/** A CSS colour (a var() too) as [r, g, b], resolved by the browser where `where` is. */
function resolve(colour, where = $('#insights')) {
  const p = document.createElement('span');
  p.style.color = colour;
  where.append(p);
  const out = parseColour(getComputedStyle(p).color);
  p.remove();
  return out;
}
/** The first opaque background up the tree from `el`. */
function backdrop(el) {
  for (let e = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    const rgb = parseColour(c);
    if (rgb && !/rgba\(.*,\s*0\)$/.test(c) && c !== 'transparent') return rgb;
  }
  return parseColour(getComputedStyle(document.body).backgroundColor);
}
const items = () => storage.getAll();
const inCur = async (cur) => (await items()).filter((s) => s.currency === cur);

/* ---------------------------------------------------------------- tests */

test('Month | Year sits beside the page title; the month arrows sit directly under it', async () => {
  await goTab('subs');
  assert($('#insights-actions').hidden, 'not on the Money tab');
  await insights();
  const acts = $('#insights-actions');
  assert(!acts.hidden && acts.closest('.app-header'), 'in the header on Insights');
  const title = box($('#page-title'));
  const toggle = box($('.segmented', acts));
  assert(toggle.left >= title.right - 0.5, `beside the title, after it (${r0(title.right)} ≤ ${r0(toggle.left)})`);
  assert(toggle.top < title.bottom && title.top < toggle.bottom, 'on the title\'s line');
  assert(toggle.right <= innerWidth + 0.5, 'inside the width');
  eq($$('[data-insights-mode]', acts).map((b) => [text(b), b.getAttribute('aria-pressed')]), [[t('insights.mode.month'), 'true'], [t('insights.mode.year'), 'false']], 'Month, then Year; Month pressed');
  eq($('.segmented', acts).getAttribute('aria-label'), t('insights.mode.label'), 'the group is labelled');
  assert(!$('#insights .insights-mode') && !$('#insights [data-insights-mode]'), 'no toggle left in the page');
  const nav = $('#insights .month-nav');
  eq($('#insights .ins-hero').firstElementChild, nav, 'the arrows come first');
  const gap = box(nav).top - headerBottom();
  assert(gap >= -0.5 && gap <= 16, `directly under the header (${r0(gap)}px)`);
  const prev = box($('[data-month-step="-1"]', nav));
  const next = box($('[data-month-step="1"]', nav));
  assert(Math.abs(next.right - toggle.right) <= 2, `the next arrow lines up under the toggle's end (${r0(next.right)} / ${r0(toggle.right)})`);
  assert(prev.left < innerWidth / 3, 'the previous arrow at the start');
  $('#insights-actions [data-insights-mode="year"]').click();
  await tick(80);
  assert(!$('#insights .month-nav') && $('#year-chart .yc-svg'), 'Year shows the year chart, no month arrows');
  eq(storage.getPref('insightsMode'), 'year', 'remembered');
  $('#insights-actions [data-insights-mode="month"]').click();
  await tick(80);
  assert($('#insights .month-nav'), 'and back');
});

test('the purple card is gone: one small line under the month says the share of income (or why there is none)', async () => {
  await insights({ view: 'donut' });
  for (const sel of ['.stat-primary', '.headline', '.headline-text', '.stat-value', '.bar[role="img"]:not(.cat-row .bar)']) assert(!$(`#insights ${sel}`), `no ${sel}`);
  const tw = await inCur('TWD');
  const out = cashDue(tw, 2026, 10);
  const inc = incomeDue(tw, 2026, 10);
  eq([out, inc], [80919, 40000], 'worked out from the items');
  const line = $('#insights .ins-pct');
  eq(text(line), t('insights.pctOfIncome', { pct: Math.round((out / inc) * 100) }), 'the old card\'s figure');
  const nav = box($('#insights .month-nav'));
  assert(box(line).top >= nav.bottom - 0.5 && box(line).top - nav.bottom < 12, 'right under the month');
  assert(parseFloat(getComputedStyle(line).fontSize) < parseFloat(getComputedStyle($('#insights .month-label')).fontSize), 'small');
  // USD: an income item, none paid in November. EUR: no income at all.
  await insights({ view: 'donut', currency: 'USD' });
  eq(text($('#insights .ins-pct')), t('insights.headline.noIncomePaid', { currency: 'USD', month: text($('#insights .month-label')) }), 'USD: why there is no percentage');
  assert(!/%/.test(text($('#insights .ins-pct'))), 'and no percentage');
  await insights({ view: 'donut', currency: 'EUR' });
  eq(text($('#insights .ins-pct')), t('insights.headline.noIncomeRecorded', { currency: 'EUR' }), 'EUR: none recorded');
  assert(!/%/.test(text($('#insights .ins-pct'))), 'no percentage');
  await insights({ view: 'donut', currency: 'TWD' });
});

for (const view of ['ring', 'donut', 'list']) {
  test(`${view}: the chart is on the first screen, the month total in its centre, all of it visible on landing`, async () => {
    await insights({ view });
    const total = $('#insights [data-roll="month-due"]');
    eq(text(total), T(80919), 'the month total');
    eq(Number(total.dataset.value), cashDue(await inCur('TWD'), 2026, 10), 'from cashDue');
    onFirstScreen(total, 'the month total');
    const chart = $('#insights .ins-chart');
    if (view === 'list') {
      // A list runs as long as the month's categories: its head and its start are on the first screen.
      onFirstScreen($('#insights .ins-list-head'), 'the head of the list');
      assert(box(chart).top >= headerBottom() && box(chart).top < fold(), 'the list starts on the first screen');
      assert(box(total).top < box($('#insights .cat-row')).top, 'the total heads the list');
      return;
    }
    onFirstScreen(chart, 'the chart');
    // Since 1.22.1 the card is capped (tests/insights-chart.html checks the cap) and pinned, the legend under it.
    assert($('#insights .ins-pinned') && box(chart).height <= innerHeight * 0.42, `a capped card (${r0(box(chart).height)}px)`);
    const ring = $('#insights .ring-stage');
    if (ring) {
      onFirstScreen(ring, 'the Ring');
      const t0 = box(total);
      const cap = box($('.ring-caption', ring));
      assert(!overlaps(t0, cap), 'the total is clear of the caption under the ring');
      assert(Math.abs((t0.left + t0.right) / 2 - (box(ring).left + box(ring).right) / 2) < 2, 'centred across the ring');
      if ($('#insights .ring-canvas')) {
        const cy = parseFloat(ring.style.getPropertyValue('--ring-cy'));
        const holeH = parseFloat(ring.style.getPropertyValue('--ring-hole-h'));
        assert(cy > 0 && holeH > 0, `the ring says where its hole is (${cy}, ${holeH})`);
        const mid = (t0.top + t0.bottom) / 2 - box(ring).top;
        assert(Math.abs(mid - cy) < 1.5, `the total sits in the hole (${r0(mid)} / ${r0(cy)})`);
        assert(t0.height <= holeH + 2, `and fits it (${r0(t0.height)} of ${r0(holeH)}px)`);
        assert(t0.width <= parseFloat(ring.style.getPropertyValue('--ring-hole-w')), 'across too');
      }
    } else {
      const d = box($('#insights .donut'));
      onFirstScreen($('#insights .donut'), 'the donut');
      const t0 = box(total);
      assert(Math.abs((t0.left + t0.right) / 2 - (d.left + d.right) / 2) < 2 && Math.abs((t0.top + t0.bottom) / 2 - (d.top + d.bottom) / 2) < d.height * 0.12, 'in the donut\'s centre');
      if (view === 'ring') assert(reduced() || text($('#insights .ring-note')), 'the stand-in says why');
      if (reduced() && view === 'ring') eq(text($('#insights .ring-note')), t('donut.flat.reduced'), 'Reduce motion and effects: the flat donut, and why');
    }
  });
}

test('under the chart, in order: the legend (with the month\'s plan counts), then the yearly card', async () => {
  const tw = await inCur('TWD');
  const due = breakdown(tw.filter((s) => s.type !== 'income'), 2026, 10);
  const n = (k) => due.byType.find((x) => x.key === k)?.names.length ?? 0;
  const counts = t('insights.stat.counts', { monthly: n('monthly'), annual: n('annual'), once: n('once') });
  eq([n('monthly'), n('annual'), n('once')], [4, 0, 1], 'worked out from the items');
  const year = yearSummary(tw, 2026);
  for (const view of ['donut', 'ring']) {
    await insights({ view });
    const chart = box($('#insights .ins-chart'));
    const legend = $('#insights .ins-legend');
    const card = $('#insights .ins-stats .stat-year');
    assert(legend && card, `${view}: the legend and the yearly card`);
    assert(box(legend).top >= chart.bottom && box(legend).top < fold(), `${view}: the legend starts right under the chart, on the first screen (${r0(box(legend).top)} / ${r0(fold())})`);
    assert(box(card).top >= box(legend).bottom, `${view}: then the yearly card`);
    assert(legend.compareDocumentPosition($('#insights .ins-stats')) & Node.DOCUMENT_POSITION_FOLLOWING, 'in that order in the page');
    eq(text($('.legend-foot', legend)), counts, `${view}: the plan counts, folded into the legend`);
    eq($$('.legend-row .legend-name', legend).map(text), ['Travel', 'House', t('donut.otherSlice')], `${view}: the legend rows`);
    const lines = Object.fromEntries($$('.year-line', card).map((l) => [$('dd', l).dataset.roll, Number($('dd', l).dataset.value)]));
    eq(lines, { 'year-Income': year.income, 'year-Outgoings': year.outgoings, 'year-Left over': year.leftOver }, `${view}: the yearly card's figures (rolling)`);
  }
  assert(!$$('#insights .stat').some((s) => !s.classList.contains('stat-year')), 'no other card: the counts card is folded into the legend');
  await insights({ view: 'list' });
  eq(text($('#insights .ins-list .legend-foot')), counts, 'List: the counts close the list');
  assert(!$('#insights .ins-legend'), 'List: no second legend');
  await insights({ view: 'donut' });
  $$('#insights .legend-row')[1].click();
  eq($$('#insights .legend-row').map((r) => r.getAttribute('aria-pressed')), ['false', 'true', 'false'], 'a legend row still picks its slice');
  $$('#insights .legend-row')[1].click();
});

test('Year: the year chart fills the first screen, fully visible', async () => {
  await insights({ mode: 'year' });
  for (const range of ['year', 'roll']) {
    $(`[data-year-range="${range}"]`).click();
    await tick(80);
    window.scrollTo(0, 0);
    await tick(30);
    onFirstScreen($('#year-chart .yc-stage'), `${range}: the year chart`);
    onFirstScreen($('#year-chart .yc-now'), `${range}: Jump to now`);
    const y = box($('#insights .yc-year-stats'));
    assert(y.top >= box($('#year-chart .yc-stage')).bottom, `${range}: the yearly card under it`);
  }
  $('[data-year-range="year"]').click();
  await tick(80);
});

test('Year, This year: the months drawn past the loop\'s seam carry their year, and no label crowds another', async () => {
  await insights({ mode: 'year' });
  $('[data-year-range="year"]').click();
  await tick(120);
  const chart = $('#year-chart').yearChart;
  await until(() => !chart.state().animating, 'the chart settles');
  const n = 12;
  const pos = chart.state().pos;
  eq(chart.state().centre, 10, 'November in the centre');
  const years = $$('#year-chart .yc-year');
  eq(years.length, n, "a 'YY for each month");
  const visible = years.map((e, i) => ({ i, e, on: shown(e) && Number(e.getAttribute('opacity') ?? 1) > 0.05 }));
  const wrapped = (i) => Math.abs(wrapRel(i, pos, n) - (i - pos)) > 0.5;
  eq(visible.filter((v) => v.on).map((v) => v.i), visible.filter((v) => v.on && wrapped(v.i)).map((v) => v.i), 'only months past the seam show it');
  assert(visible[0].on && text(visible[0].e) === t('chart.yearShort', { yy: '26' }), 'January (drawn after December) says 2026');
  assert(!visible[11].on && !visible[10].on, 'December and November don\'t');
  // Every label that can be seen keeps clear of the others.
  const labels = $$('#year-chart .yc-month').filter((e) => shown(e) && Number(e.getAttribute('opacity') ?? 1) > 0.3).map((e) => ({ e, r: box(e) }));
  for (let a = 0; a < labels.length; a++) {
    for (let b = a + 1; b < labels.length; b++) {
      assert(!overlaps(labels[a].r, labels[b].r, 1), `"${text(labels[a].e)}" and "${text(labels[b].e)}" don't overlap`);
    }
  }
  // Move the centre to February: the late months drawn before January carry 2026 as well.
  const svg = $('#year-chart .yc-svg');
  for (let k = 0; k < 9; k++) {
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await until(() => !chart.state().animating, 'the chart settles', 4000);
  }
  eq(chart.state().centre, 1, 'February in the centre');
  const p2 = chart.state().pos;
  const on2 = years.map((e, i) => (shown(e) && Number(e.getAttribute('opacity') ?? 1) > 0.05 ? i : -1)).filter((i) => i >= 0);
  assert(on2.length && on2.every((i) => Math.abs(wrapRel(i, p2, n) - (i - p2)) > 0.5), `the months before the seam (${on2.join(', ')})`);
  assert(on2.includes(11), 'December (drawn before January) says 2026');
  $('#year-chart .yc-now').click();
  await until(() => !chart.state().animating && chart.state().centre === 10, 'back to now', 6000);
});

test('Year: the readout over the chart never runs into the scale or itself, at every width', async () => {
  await insights({ mode: 'year' });
  const chart = $('#year-chart').yearChart;
  const svg = $('#year-chart .yc-svg');
  const check = (what) => {
    const name = box($('#year-chart .yc-read-name'));
    const total = box($('#year-chart .yc-read-total'));
    const delta = box($('#year-chart .yc-read-delta'));
    assert(!overlaps(name, total), `${what}: the month and its total keep apart`);
    assert(name.right <= box(svg).right + 1 && total.right <= box(svg).right + 1, `${what}: inside the card`);
    const bottom = Math.max(name.bottom, total.bottom, delta.bottom);
    const top = Math.min(...$$('#year-chart .yc-axis').map((e) => box(e).top), ...$$('#year-chart .yc-grid').map((e) => box(e).top));
    assert(bottom <= top + 0.5, `${what}: the readout ends (${r0(bottom)}) above the scale's top label and line (${r0(top)})`);
  };
  check(`${text($('#year-chart .yc-read-name'))}`);
  for (let k = 0; k < 2; k++) {
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await until(() => !chart.state().animating, 'settles', 4000);
    check(text($('#year-chart .yc-read-name')));
  }
  $('#year-chart .yc-now').click();
  await until(() => !chart.state().animating && chart.state().centre === 10, 'back to now', 6000);
  assert(text($('#year-chart .yc-read-name')).length > 0, 'the readout still names the month');
});

test('dark mode: the Ring\'s "Other" slice reads against the card; the other colours are unchanged', async () => {
  setTheme('dark');
  await tick(80);
  await insights({ view: 'donut' });
  const slice = $('#insights .donut-slice[data-slice="other"]');
  assert(slice, 'the month has an Other slice');
  const surface = resolve('var(--surface)');
  const other = parseColour(getComputedStyle(slice).stroke);
  const c = contrast(other, surface);
  assert(c >= 3, `Other is at least 3:1 on the dark card (${c.toFixed(2)}:1)`);
  eq(parseColour(getComputedStyle($('#insights .legend-row[data-slice="other"] .legend-dot')).backgroundColor), other, 'its legend dot too');
  const groups = Array.from({ length: 10 }, (_, i) => resolve(`var(--group-${i + 1})`));
  const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  eq(groups.map(hex), ['#d4a54a', '#7aa3d4', '#e0845f', '#67b6d6', '#df7fa3', '#ae8cc6', '#a3b05a', '#b88f6e', '#5bb3b3', '#d0727a'], 'the category colours are as they were');
  if (!reduced()) {
    await insights({ view: 'ring' });
    if ($('#insights .ring-canvas')) {
      // The Ring reads its slice colours from the same tokens; the front-slice rules are untouched.
      const rows = $$('#insights .legend-row');
      eq(rows.map((r) => r.getAttribute('aria-pressed')), ['true', 'false', 'false'], 'the largest slice is at the front');
      assert(contrast(resolve('var(--group-other)'), surface) >= 3, 'and Other keeps its colour there');
    }
  }
  setTheme('light');
  await tick(80);
  await insights({ view: 'donut' });
});

test('Insights keeps its own room under the tab bar: it no longer follows the + button\'s', async () => {
  await insights({ mode: 'year' });
  assert(document.body.classList.contains('insights-view'), 'the page knows it is Insights');
  const pad = () => parseFloat(getComputedStyle(document.body).paddingBottom);
  const cardEnd = () => { window.scrollTo(0, document.documentElement.scrollHeight); return box($('#insights .yc-year-stats')).bottom; };
  const before = { pad: pad(), end: cardEnd() };
  const px = (name) => { const p = document.createElement('div'); p.style.height = `var(${name})`; document.body.append(p); const h = p.getBoundingClientRect().height; p.remove(); return h; };
  eq(r0(before.pad), r0(px('--tabbar-h') + px('--safe-bottom') + px('--space-6')), 'the tab bar, the system bar and breathing room');
  document.documentElement.style.setProperty('--fab-stack', '300px');
  await tick(30);
  eq([r0(pad()), r0(cardEnd())], [r0(before.pad), r0(before.end)], 'a different + button room changes nothing here');
  document.documentElement.style.removeProperty('--fab-stack');
  const room = fold() - before.end;
  assert(room >= px('--space-4') && room <= px('--space-6') * 3, `the yearly card ends clear of the tab bar (${r0(room)}px)`);
  await goTab('subs');
  assert(!document.body.classList.contains('insights-view'), 'Money keeps its own room (for the +, or the Wallet\'s)');
  await insights();
});

test('the yearly card\'s small print reads; the old card\'s styles are gone', async () => {
  for (const theme of ['light', 'dark']) {
    setTheme(theme);
    await tick(60);
    await insights({ view: 'donut' });
    const subs = $$('#insights .stat-sub');
    assert(subs.length, `${theme}: the card has its notes`);
    for (const s of subs) {
      const c = contrast(parseColour(getComputedStyle(s).color), backdrop(s));
      assert(c >= 4.5, `${theme}: "${text(s)}" at ${c.toFixed(2)}:1`);
    }
  }
  setTheme('light');
  await tick(60);
  const dead = [];
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = [...sheet.cssRules]; } catch { continue; }
    const walk = (list) => { for (const r of list) { if (r.selectorText && /\.(stat-primary|headline|stat-value|insights-mode)\b/.test(r.selectorText)) dead.push(r.selectorText); if (r.cssRules) walk(r.cssRules); } };
    walk(rules);
  }
  eq(dead, [], 'no rules for the removed card');
  await insights({ view: 'donut' });
});

test('the month total rolls by the shared rule, and with Reduce motion just changes', async () => {
  await insights({ view: 'donut' });
  const started = roller().stats().started;
  $('#insights [data-month-step="1"]').click();
  await tick(40);
  const total = $('#insights [data-roll="month-due"]');
  const dec = cashDue(await inCur('TWD'), 2026, 11);
  eq(Number(total.dataset.value), dec, 'December\'s total');
  if (reduced()) {
    eq(roller().stats().started, started, 'nothing rolls');
    const anims = document.getAnimations().filter((a) => $('#insights').contains(a.effect?.target));
    eq(anims.length, 0, 'no animation frames on the page');
    eq(text(total), T(dec), 'the figure just changes');
  } else {
    assert(roller().stats().started > started, 'the month total rolls from the old figure');
    await until(() => roller().stats().running === 0, 'the roll finishes', 3000);
    eq(text(total), T(dec), 'and ends on the figure');
  }
  $('#insights [data-month-step="-1"]').click();
  await tick(40);
  if (!reduced()) await until(() => roller().stats().running === 0, 'back', 3000);
});

test('nothing clips or runs sideways, in every view and language', async () => {
  const fits = (el) => el.scrollWidth <= el.clientWidth + 1;
  const sels = ['.page-title', '#insights-actions .seg-btn', '#insights .month-label', '#insights .ins-pct', '#insights .section-title',
    '#insights .ins-total', '#insights .donut-label', '#insights .legend-name', '#insights .cat-amount', '#insights .ring-name'];
  for (const view of ['ring', 'donut', 'list']) {
    await insights({ view });
    for (const sel of sels) for (const el of $$(sel)) if (el.clientWidth) assert(fits(el), `${view}: ${sel} "${text(el)}" fits (${el.scrollWidth} > ${el.clientWidth})`);
    assert(document.documentElement.scrollWidth <= innerWidth + 1, `${view}: no sideways scroll`);
    const title = box($('#page-title'));
    const toggle = box($('#insights-actions .segmented'));
    assert(!overlaps(title, toggle), `${view}: the title and the toggle keep apart`);
    const total = $('#insights [data-roll="month-due"]');
    assert(total.scrollWidth <= total.clientWidth + 1 && box(total).width > 0, `${view}: the total shows in full`);
  }
  await insights({ mode: 'year' });
  for (const el of $$('#insights .yc-controls .seg-btn, #insights .yc-controls .chip')) assert(fits(el), `Year: "${text(el)}" fits`);
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Year: no sideways scroll');
  await insights();
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'insights');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  storage.setPref('insightsMode', 'month');
  storage.setPref('catView', 'donut');
  storage.setPref('yearRange', 'year');
  storage.setPref('yearStack', 'type');
  localStorage.removeItem('substracker.yearKey');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  localStorage.removeItem('substracker.groupSort');
  // zh-TW is picked as in Settings → Language; ?lang=xx is the pseudo-locale, read by the app itself.
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
      if (name?.startsWith('substracker-test-insights-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
