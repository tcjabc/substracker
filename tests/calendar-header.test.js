// In-browser tests for the Calendar's In, Out and Left over since 1.22.0 (js/calendar.js, css/app.css):
// the three columns under the month heading, their figures against insights-calc's incomeDue and
// cashDue (this month, and over 24 and 48 months), Left over's size and arrow with no sign, its
// colour (the existing --positive-text and --negative-text) and contrast on the Calendar page in
// both themes, the one labelled group screen readers get, other currencies counted and never added,
// rolling and Reduce motion, and fitting at every width with NT$- and US$-style figures. Run by
// tests/calendar-header.html with a fixed clock (18 November 2026) against a throwaway database, with
// index.html's markup, at 320, 360 and 393px, with and without reduced motion emulated, in English,
// the pseudo-locale (?lang=xx) and zh-TW (?lang=zh-TW). Expected words come from t().

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';
import { t } from '../js/i18n.js';
import { parseColour, contrast, othersText } from '../js/wallet-math.js';
import { cashDue, incomeDue } from '../js/insights-calc.js';
import { occurrences } from '../js/calendar-math.js';

const results = [];
const dbName = `substracker-test-calhead-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'period', 'theme', 'reduceMotion', 'lang', 'weekStart'];
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

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// "Today" is Wednesday 18 November 2026. TWD: November has In 40,000 and Out 80,919 (the Holiday),
// so more goes out; December In 40,000, Out 30,919, so more comes in; February 2027 has a one-off of
// 9,081 that makes Out exactly 40,000, the same as In. USD has AWS every month (counted, never added
// to TWD) and, for the US$ check, a large contract and studio.
const SEED = [
  { ...base, type: 'income', id: 'h-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, type: 'income', id: 'h-bonus', name: 'Bonus', price: 12000, cycle: 'annual', nextRenewal: '2027-03-10' },
  { ...base, id: 'h-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 'h-holiday', name: 'Holiday', price: 50000, cycle: 'once', date: '2026-11-28', category: 'Travel' },
  { ...base, id: 'h-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 'h-stream', name: 'Streaming', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
  { ...base, id: 'h-coffee', name: 'Coffee', price: 30, cycle: 'monthly', nextRenewal: '2026-12-05', category: 'Snacks' },
  { ...base, id: 'h-even', name: 'Repairs', price: 9081, cycle: 'once', date: '2027-02-14', category: 'House' },
  { ...base, id: 'h-gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
  { ...base, currency: 'USD', id: 'h-aws', name: 'AWS', price: 15, cycle: 'monthly', nextRenewal: '2026-12-09', category: 'Cloud' },
  { ...base, currency: 'USD', type: 'income', id: 'h-contract', name: 'Contract', price: 42189.5, cycle: 'monthly', nextRenewal: '2026-11-03' },
  { ...base, currency: 'USD', id: 'h-studio', name: 'Studio', price: 38765.25, cycle: 'monthly', nextRenewal: '2026-11-07', category: 'Work' },
];

const reduced = () => document.documentElement.classList.contains('reduce-motion');
const roller = () => $('#money-summary').roller;
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(80); };
const host = () => $('#calendar');
const cal = () => host().calendar;
const flow = () => $('#calendar .cal-flow');
const amount = (key) => $(`#calendar .cal-flow-amount[data-flow="${key}"]`);
const box = (el) => el.getBoundingClientRect();
const overlaps = (a, b, slack = 0.5) => a.left < b.right - slack && b.left < a.right - slack && a.top < b.bottom - slack && b.top < a.bottom - slack;
const items = () => storage.getAll();
const cur = () => $('#set-currency').value;
const inCur = async (c = cur()) => (await items()).filter((s) => s.currency === c);
const ARROW_PATH = { up: 'M7 17L17 7M9 7h8v8', down: 'M7 7l10 10M17 9v8H9' };

async function show(year, month) {
  if ($('.tab[aria-selected="true"]')?.dataset.tab !== 'calendar') await goTab('calendar');
  cal().show(year, month);
  await tick(20);
}
function setTheme(theme) {
  const s = $('#set-theme');
  s.value = theme;
  s.dispatchEvent(new Event('change', { bubbles: true }));
}
async function setCurrency(c) {
  const s = $('#set-currency');
  if (s.value === c) return;
  s.value = c;
  s.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => $('#set-currency').value === c, 'the default currency is set');
  await tick(120);
}
function resolve(colour, where = host()) {
  const p = document.createElement('span');
  p.style.color = colour;
  where.append(p);
  const out = parseColour(getComputedStyle(p).color);
  p.remove();
  return out;
}
/** What the three show for a month, worked out here with insights-calc. */
async function expected(year, month, c = cur()) {
  const list = await inCur(c);
  const i = incomeDue(list, year, month);
  const o = cashDue(list, year, month);
  return { i, o, left: Math.abs(i - o), dir: i > o ? 'up' : i < o ? 'down' : 'even', c };
}
function leftWords(e) {
  return t(e.dir === 'down' ? 'calendar.flow.short' : 'calendar.flow.leftOver', { amount: money(e.left, e.c) });
}
async function checkMonth(year, month, what) {
  await show(year, month);
  const e = await expected(year, month);
  eq([Number(amount('in').dataset.value), Number(amount('out').dataset.value), Number(amount('left').dataset.value)], [e.i, e.o, e.left], `${what}: In, Out and Left over`);
  eq([text(amount('in')), text(amount('out')), text(amount('left'))], [money(e.i, e.c), money(e.o, e.c), money(e.left, e.c)], `${what}: as money`);
  eq(flow().dataset.dir, e.dir, `${what}: the direction`);
  eq(flow().getAttribute('aria-label'), t('calendar.flow.label', { in: money(e.i, e.c), out: money(e.o, e.c), left: leftWords(e) }), `${what}: read aloud`);
  return e;
}

/* ---------------------------------------------------------------- tests */

test('the heading, arrows and Today stay; under them In, Out and Left over, a label over each figure; the old line is gone', async () => {
  await show(2026, 10);
  eq($$('#calendar .cal-head > *').map((e) => e.className.split(' ').find((c) => c.startsWith('cal-')) || e.className), ['cal-step', 'cal-month', 'cal-step', 'cal-today'], 'the heading row as it was');
  assert(!$('#calendar .cal-summary') && !$('#calendar .cal-summary-label'), 'no "Cash due in" line');
  const head = box($('#calendar .cal-head'));
  const f = box(flow());
  const grid = box($('#calendar .cal-grid'));
  assert(head.bottom <= f.top + 0.5 && f.bottom <= grid.top + 0.5, `heading ${r0(head.bottom)} ≤ cash flow ${r0(f.top)}–${r0(f.bottom)} ≤ grid ${r0(grid.top)}`);
  const cells = $$('#calendar .cal-flow-cell');
  eq(cells.map((c) => text($('.cal-flow-label', c))), [t('calendar.flow.in'), t('calendar.flow.out'), t('money.leftOver')], 'In, Out, Left over');
  for (const c of cells) {
    const l = box($('.cal-flow-label', c));
    const v = box($('.cal-flow-value', c));
    assert(l.bottom <= v.top + 1, `"${text($('.cal-flow-label', c))}": the label over its figure`);
  }
  const [a, b, c] = cells.map(box);
  assert(a.right <= b.left + 0.5 && b.right <= c.left + 0.5, 'side by side, in that order');
  const row = box($('#calendar .cal-flow-cells'));
  assert(Math.abs(a.left - row.left) < 1 && Math.abs(c.right - row.right) < 1, 'spread across the width');
  const words = text(flow()) + flow().getAttribute('aria-label');
  if (!params.get('lang')) assert(!/saved|lost|saving/i.test(words), 'called Left over, never saved or lost');
});

test('In, Out and Left over are incomeDue, cashDue and their difference: this month, as on the Money card', async () => {
  const e = await checkMonth(2026, 10, 'November 2026');
  eq([e.i, e.o, e.dir], [40000, 80919, 'down'], 'worked out from the items');
  await goTab('subs');
  const card = (k) => Number($(`#money-summary [data-roll="${k}"]`).dataset.value);
  eq([card('income'), card('cash'), Math.abs(card('left'))], [e.i, e.o, e.left], 'the Money card has the same three');
  await show(2026, 10);
  const occ = occurrences(await items(), 2026, 10, { currency: cur() });
  eq([occ.income, occ.total], [e.i, e.o], 'and the days add up to them');
});

test('they match over 24 months', async () => {
  for (let k = 0; k < 24; k++) {
    const d = new Date(2026, 10 + k, 1);
    await checkMonth(d.getFullYear(), d.getMonth(), d.toISOString().slice(0, 7));
  }
});

test('they match over 48 months, from two years back', async () => {
  const dirs = new Set();
  for (let k = 0; k < 48; k++) {
    const d = new Date(2024, 10 + k, 1);
    dirs.add((await checkMonth(d.getFullYear(), d.getMonth(), d.toISOString().slice(0, 7))).dir);
  }
  eq([...dirs].sort(), ['down', 'even', 'up'], 'every direction came up');
});

test('Left over: its size and an arrow, never a sign; up-right, down-right or none', async () => {
  for (const [y, m, dir] of [[2026, 10, 'down'], [2026, 11, 'up'], [2027, 1, 'even']]) {
    const e = await checkMonth(y, m, `${y}-${m + 1}`);
    eq(e.dir, dir, `${y}-${m + 1}: ${dir}`);
    const value = $('#calendar .cal-flow-left .cal-flow-value');
    assert(!/[-−+]/.test(text(value)), `${dir}: no minus or plus (${text(value)})`);
    const svg = $('svg', value);
    if (dir === 'even') { assert(!svg, 'equal: no arrow'); continue; }
    assert(svg && svg.getAttribute('aria-hidden') === 'true', `${dir}: an arrow, hidden from screen readers`);
    eq($('path', svg).getAttribute('d'), ARROW_PATH[dir], `${dir}: drawn ${dir === 'up' ? 'up-right' : 'down-right'}`);
    assert(svg.compareDocumentPosition(amount('left')) & Node.DOCUMENT_POSITION_FOLLOWING, 'before the figure');
    assert(!/\p{Extended_Pictographic}/u.test(value.textContent), 'not an emoji');
  }
});

test('only Left over and its arrow are coloured, with the existing tokens, at least 4.5:1 on the page in both themes', async () => {
  for (const theme of ['light', 'dark']) {
    setTheme(theme);
    await tick(60);
    const page = parseColour(getComputedStyle(document.body).backgroundColor);
    const textC = resolve('var(--text)');
    for (const [y, m, token] of [[2026, 11, '--positive-text'], [2026, 10, '--negative-text'], [2027, 1, null]]) {
      await show(y, m);
      const value = $('#calendar .cal-flow-left .cal-flow-value');
      const colour = parseColour(getComputedStyle(value).color);
      eq(colour, token ? resolve(`var(${token})`) : textC, `${theme} ${y}-${m + 1}: Left over in ${token ?? 'the text colour'}`);
      const svg = $('svg', value);
      if (svg) eq(parseColour(getComputedStyle(svg).stroke), colour, `${theme}: the arrow in the same colour`);
      const c = contrast(colour, page);
      assert(c >= 4.5, `${theme}: ${token ?? '--text'} at ${c.toFixed(2)}:1 on the page`);
      for (const k of ['in', 'out']) eq(parseColour(getComputedStyle(amount(k)).color), textC, `${theme}: ${k} in the text colour`);
      eq(parseColour(getComputedStyle($('#calendar .cal-flow-left .cal-flow-label')).color), parseColour(getComputedStyle($('#calendar .cal-flow-in .cal-flow-label')).color), `${theme}: Left over's label as the others`);
    }
  }
  setTheme('light');
  await tick(60);
});

test('screen readers get one group that reads the three in order and says the direction in words', async () => {
  for (const [y, m] of [[2026, 10], [2026, 11], [2027, 1]]) {
    const e = await checkMonth(y, m, `${y}-${m + 1}`);
    eq(flow().getAttribute('role'), 'group', 'one group');
    eq($$('#calendar .cal-flow').length, 1, 'just one');
    eq($('#calendar .cal-flow-cells').getAttribute('aria-hidden'), 'true', 'its parts are not read twice');
    const label = flow().getAttribute('aria-label');
    const inAt = label.indexOf(money(e.i, e.c));
    const outAt = label.indexOf(money(e.o, e.c), inAt + 1);
    assert(inAt >= 0 && outAt > inAt, 'In, then Out');
    assert(label.indexOf(leftWords(e), outAt) > outAt, 'then Left over, in words');
    if (e.dir === 'down') assert(label.includes(t('calendar.flow.short', { amount: money(e.left, e.c) })), 'more going out than coming in, in words');
  }
});

test('other currencies are counted on their own line, never added in', async () => {
  const e = await checkMonth(2026, 10, 'November');
  const occ = occurrences(await items(), 2026, 10, { currency: cur() });
  assert(occ.others.length, 'November has items in other currencies');
  eq(text($('#calendar .cal-flow-note')), othersText(occ.others), 'counted');
  const all = await items();
  eq([incomeDue(all.filter((s) => s.currency === cur()), 2026, 10), cashDue(all.filter((s) => s.currency === cur()), 2026, 10)], [e.i, e.o], 'only the default currency is in the figures');
  assert(cashDue(all, 2026, 10) !== e.o, 'adding the others would change Out, so they really are left out');
});

test('the three roll by the shared rule, a month step from old to new; with Reduce motion they just change', async () => {
  await show(2026, 10);
  await tick(50);
  if (!reduced()) await until(() => roller().stats().running === 0, 'any first roll finishes', 3000);
  const started = roller().stats().started;
  $('#calendar [data-cal-step="1"]').click();
  await tick(40);
  const e = await expected(2026, 11);
  if (reduced()) {
    eq(roller().stats().started, started, 'nothing rolls');
    eq(document.getAnimations().filter((a) => flow().contains(a.effect?.target)).length, 0, 'no animation frames');
    eq([text(amount('in')), text(amount('out')), text(amount('left'))], [money(e.i, e.c), money(e.o, e.c), money(e.left, e.c)], 'the figures just change');
  } else {
    assert(roller().stats().started >= started + 2, `Out and Left over roll (${roller().stats().started - started})`);
    assert($('#calendar .cal-flow .odo-roll'), 'in the cash flow');
    await until(() => roller().stats().running === 0, 'the rolls finish', 3000);
    eq([text(amount('in')), text(amount('out')), text(amount('left'))], [money(e.i, e.c), money(e.o, e.c), money(e.left, e.c)], 'and end on the figures');
  }
  $('#calendar [data-cal-step="-1"]').click();
  await tick(40);
  if (!reduced()) await until(() => roller().stats().running === 0, 'back', 3000);
});

test('nothing clips at this width: NT$-length figures and US$-style ones', async () => {
  for (const c of ['TWD', 'USD']) {
    await setCurrency(c);
    for (const [y, m] of [[2026, 10], [2026, 11]]) {
      await show(y, m);
      await tick(30);
      const row = $('#calendar .cal-flow-cells');
      assert(row.scrollWidth <= row.clientWidth + 1, `${c} ${y}-${m + 1}: the three fit side by side (${row.scrollWidth} in ${row.clientWidth})`);
      const cells = $$('#calendar .cal-flow-cell');
      for (const cell of cells) {
        const v = $('.cal-flow-value', cell);
        assert(v.scrollWidth <= v.clientWidth + 1 && box(v).right <= innerWidth && box(v).left >= 0, `${c}: "${text(v)}" shows in full`);
        const l = $('.cal-flow-label', cell);
        assert(l.scrollWidth <= l.clientWidth + 1, `${c}: "${text(l)}" fits`);
      }
      for (let i = 1; i < cells.length; i++) assert(!overlaps(box(cells[i - 1]), box(cells[i])), `${c}: columns ${i} and ${i + 1} keep apart`);
      assert(document.documentElement.scrollWidth <= innerWidth + 1, `${c}: no sideways scroll`);
      if (c === 'USD') assert(text(amount('in')).length >= 10, `a long figure was checked (${text(amount('in'))})`);
    }
  }
  await setCurrency('TWD');
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'calendar');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  localStorage.removeItem('substracker.weekStart');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  const lang = params.get('lang') || 'en';
  if (lang === 'zh-TW') storage.setPref('lang', 'zh-TW'); else localStorage.removeItem('substracker.lang');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#calendar .cal-flow'), 'Calendar drawn', 8000);
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
      if (name?.startsWith('substracker-test-calhead-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
