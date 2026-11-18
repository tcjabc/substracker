// Node tests for the rolling totals' pure parts (js/count-anim.js): the roll plan (it ends on
// exactly the formatter's text, starts on the old value's digits, never changes the layout, steps
// stay in range, separators fade only beside blank columns, other numbering systems) and the rules
// for when a total rolls (first show, a change, a replay, a redraw with the same number). The
// animation itself needs a browser: tests/app.test.js. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rollPlan, rollFrom, MAX_STEPS } from '../js/count-anim.js';
import { money, moneyParts } from '../js/util.js';

const BLANK = ' ';
const glyphsOf = (parts) => Array.from({ length: 10 }, (_, d) => parts(d).filter((p) => p.type === 'integer').map((p) => p.value).join(''));
const app = (cur) => ({ parts: (v) => moneyParts(v, cur), text: (v) => money(v, cur), glyphs: glyphsOf((v) => moneyParts(v, cur)) });
/** The text a plan shows at its start or end. */
const shown = (plan, at) => plan.map((s) => (s.t === 'lit' ? s.text : s.cells[at === 'end' ? s.to : s.from])).join('');
const digitCols = (plan) => plan.filter((s) => s.t === 'dig');

test('moneyParts are the formatter\'s own: joined, they are money()\'s text', () => {
  for (const cur of ['TWD', 'USD', 'JPY', 'EUR', 'GBP'])
    for (const v of [0, 7, 30000, 1234567.5, -37745, 12.05, 999999.99]) {
      assert.equal(moneyParts(v, cur).map((p) => p.value).join(''), money(v, cur), `${cur} ${v}`);
    }
});

test('0 → 30,000: ends exactly on the formatted value, blank columns roll in, the separator fades in', () => {
  const { parts, text, glyphs } = app('TWD');
  const plan = rollPlan(parts(0), parts(30000), glyphs);
  assert.equal(shown(plan, 'end'), text(30000), 'the final text');
  const cols = digitCols(plan);
  assert.equal(cols.length, 5, 'one column per digit of the final value');
  assert.deepEqual(cols.map((c) => c.cells[c.from]), [BLANK, BLANK, BLANK, BLANK, glyphs[0]], 'only the units column has a digit at the start');
  const sep = plan.find((s) => s.t === 'lit' && s.text === ',');
  assert.equal(sep.fade, true, 'the comma has no digits beside it yet');
  assert.ok(plan.filter((s) => s.t === 'lit' && s.text !== ',').every((s) => !s.fade), 'the symbol does not fade');
  assert.ok(cols.slice(1).every((c) => c.to - c.from >= 10), 'low columns spin a full turn');
  assert.equal(cols[0].to - cols[0].from, 4, 'the top column rolls blank, 0, 1, 2, 3');
});

test('a small change only moves the columns that change', () => {
  const { parts, glyphs } = app('TWD');
  const plan = rollPlan(parts(1699), parts(1799), glyphs);
  const cols = digitCols(plan);
  assert.deepEqual(cols.map((c) => c.cells.length), [1, 2, 1, 1], 'the hundreds steps once; the rest stay');
  assert.ok(!plan.some((s) => s.fade), 'nothing fades');
});

test('going down rolls down; the layout is always the final value\'s', () => {
  const { parts, text, glyphs } = app('TWD');
  const plan = rollPlan(parts(30000), parts(500), glyphs);
  assert.equal(shown(plan, 'end'), text(500));
  assert.equal(digitCols(plan).length, 3, 'three columns: the old extra digits are not drawn');
  for (const c of digitCols(plan)) if (c.cells.length > 1) assert.ok(c.from > c.to, 'downward');
});

test('random pairs: right start digits, exact end text, steps in range, cells in wheel order', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const values = () => {
    const k = rnd();
    if (k < 0.1) return 0;
    const v = Math.round(rnd() * 10 ** Math.floor(rnd() * 8)) / (rnd() < 0.3 ? 100 : 1);
    return rnd() < 0.15 ? -v : v;
  };
  for (const cur of ['TWD', 'USD', 'JPY']) {
    const { parts, text, glyphs } = app(cur);
    for (let i = 0; i < 400; i++) {
      const a = values(), b = values();
      const plan = rollPlan(parts(a), parts(b), glyphs);
      assert.equal(shown(plan, 'end'), text(b), `${cur} ${a} → ${b}: end`);
      for (const c of digitCols(plan)) {
        assert.ok(Math.abs(c.to - c.from) <= MAX_STEPS, `${a} → ${b}: at most ${MAX_STEPS} steps`);
        const ds = c.cells.filter((x) => x !== BLANK).map((x) => glyphs.indexOf(x));
        for (let k = 1; k < ds.length; k++) assert.equal(ds[k], (ds[k - 1] + 1) % 10, `${a} → ${b}: consecutive digits`);
        assert.ok(c.cells.indexOf(BLANK) <= 0, 'a blank cell only at the top');
      }
      // The start shows the old value's digits under the final layout (right-aligned integer
      // digits, fraction digits in place; places the old value didn't reach are blank).
      const int = (v) => parts(v).filter((p) => p.type === 'integer').map((p) => p.value).join('');
      const fr = (v) => parts(v).filter((p) => p.type === 'fraction').map((p) => p.value).join('');
      const cols = digitCols(plan);
      const nInt = int(b).length;
      const startInt = cols.slice(0, nInt).map((c) => c.cells[c.from]).join('').replaceAll(BLANK, '');
      assert.equal(startInt, int(a).slice(-nInt).replace(/^0+(?=.)/, (z) => (int(a).length > nInt ? z : '')) || glyphs[0], `${a} → ${b}: start integer digits`);
      const startFr = cols.slice(nInt).map((c) => c.cells[c.from]).join('');
      assert.equal(startFr, fr(a).padEnd(fr(b).length, glyphs[0]).slice(0, fr(b).length), `${a} → ${b}: start fraction digits`);
    }
  }
});

test('other numbering systems: the formatter\'s own digits', () => {
  const f = new Intl.NumberFormat('ar-EG', { style: 'currency', currency: 'EGP', minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const parts = (v) => f.formatToParts(v);
  const glyphs = glyphsOf(parts);
  assert.notEqual(glyphs[1], '1', 'Arabic-Indic digits in this locale');
  const plan = rollPlan(parts(0), parts(4250), glyphs);
  assert.equal(shown(plan, 'end'), f.format(4250), 'ends on the formatted text');
  assert.ok(digitCols(plan).every((c) => c.cells.every((x) => x === BLANK || glyphs.includes(x))), 'only those digits');
});

test('when a total rolls: first show, a change, a replay; not a redraw with the same number', () => {
  const at = (value, gen = 0, currency = 'TWD') => ({ value, currency, gen });
  assert.equal(rollFrom(undefined, 30000, 'TWD', 0), 0, 'shown for the first time: from 0');
  assert.equal(rollFrom(undefined, 0, 'TWD', 0), null, 'nothing to roll to');
  assert.equal(rollFrom(at(30000), 30000, 'TWD', 0), null, 'a redraw with the same number: no roll');
  assert.equal(rollFrom(at(30000), 31000, 'TWD', 0), 30000, 'changed while shown: from the old value');
  assert.equal(rollFrom(at(30000), 30000, 'TWD', 1), 0, 'replay (tab or app back), unchanged: from 0');
  assert.equal(rollFrom(at(30000), 32000, 'TWD', 1), 30000, 'replay after a change elsewhere: from the value shown before');
  assert.equal(rollFrom(at(30000, 1), 30000, 'TWD', 1), null, 'a redraw after the replay: no second roll');
  assert.equal(rollFrom(at(500, 0, 'USD'), 500, 'TWD', 0), 0, 'another currency: from 0, never from a USD figure');
  assert.equal(rollFrom(at(0), 0, 'TWD', 1), null, 'replay of 0: nothing to roll');
});
