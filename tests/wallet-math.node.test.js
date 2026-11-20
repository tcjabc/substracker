// Node tests for js/wallet-math.js: the Wallet's palette (it matches app.css, every slot keeps 4.5:1
// in both themes with the depth on), the automatic colours (slot order, no equal neighbours, picked
// colours untouched), the card totals on the Money card's cash basis, Sort (no Income group), the
// income card's gauge (its share maths and every segment colour against the track), and the
// stack's geometry and fling maths. Run with `npm test`, and with TZ=America/New_York too. Items
// are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WALLET_LIGHT, WALLET_DARK, WALLET_KEYS, isWalletKey, assignAutoColours, fitCard, parseColour, contrast,
  shiftL, mix, walletGroups, othersText, periodCash, cardPose, maxScroll, rubberBand, releasePlan,
  sampleVelocity, GEOM, collapsedHeight, DEPTH, faceText, sortGroups, groupSortFrom, GROUP_SORTS,
  incomeGauge, frontGauge, totalGauge, gaugeNeedsRing, GAUGE_CONTRAST,
} from '../js/wallet-math.js';
import { stripSummary } from '../js/insights-calc.js';
import { viewFrom } from '../js/util.js';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
/** The --wallet-N values in each theme block of app.css: light, dark (media query), dark (data-theme). */
function cssPalettes() {
  const blocks = [];
  const re = /--wallet-1:\s*(#[0-9a-f]{6})/gi;
  let m;
  while ((m = re.exec(css))) {
    const from = m.index;
    const vals = [];
    for (let i = 1; i <= 15; i++) {
      const v = new RegExp(`--wallet-${i}:\\s*(#[0-9a-f]{6})`, 'i').exec(css.slice(from));
      vals.push(v[1].toLowerCase());
    }
    blocks.push(vals);
  }
  return blocks;
}

test('the palette in js/wallet-math.js is the one in app.css, in every theme block', () => {
  const blocks = cssPalettes();
  assert.equal(blocks.length, 3, 'light, dark media query, dark data-theme');
  assert.deepEqual(blocks[0], WALLET_LIGHT);
  assert.deepEqual(blocks[1], WALLET_DARK);
  assert.deepEqual(blocks[2], WALLET_DARK);
  assert.equal(new Set(WALLET_LIGHT).size, 15, '15 different light colours');
  assert.equal(new Set(WALLET_DARK).size, 15, '15 different dark colours');
});

test('parseColour reads hex, rgb() and color(srgb …), which is how a browser gives a color-mix() back', () => {
  assert.deepEqual(parseColour('#4f46e5'), [79, 70, 229]);
  assert.deepEqual(parseColour('#fff'), [255, 255, 255]);
  assert.deepEqual(parseColour('rgb(79, 70, 229)'), [79, 70, 229]);
  assert.deepEqual(parseColour('rgba(79 70 229 / 0.5)'), [79, 70, 229]);
  assert.deepEqual(parseColour('color(srgb 0.31 0.2745 0.898)'), [79, 70, 229]);
  assert.deepEqual(parseColour('color(srgb 1 0 0.5 / 0.4)'), [255, 0, 128]);
  assert.deepEqual(parseColour('color(srgb 1.2 -0.1 0)'), [255, 0, 0], 'clamped to sRGB');
  assert.equal(parseColour('color(display-p3 1 0 0)'), null, 'other spaces are not guessed');
  assert.equal(parseColour(''), null);
});

test('wallet keys: w1 … w15 only', () => {
  assert.deepEqual(WALLET_KEYS.slice(0, 3), ['w1', 'w2', 'w3']);
  assert.equal(WALLET_KEYS.length, 15);
  for (const k of WALLET_KEYS) assert.ok(isWalletKey(k));
  for (const k of ['w0', 'w16', 'g1', '', null, 'w1 ', 'W1']) assert.ok(!isWalletKey(k), String(k));
});

// The lightest point is the gradient top under the sheen's peak; the darkest, the gradient bottom
// under the cast shadow where band text sits.
function extremes(fill, k) {
  return { lo: mix([255, 255, 255], k.top, k.sh), hi: mix([0, 0, 0], k.bot, DEPTH.castAtText) };
}

for (const [theme, palette, sheen] of [['light', WALLET_LIGHT, DEPTH.sheenLight], ['dark', WALLET_DARK, DEPTH.sheenDark]]) {
  test(`every ${theme} slot keeps 4.5:1 for text and secondary text at the lightest and darkest points`, () => {
    palette.forEach((hex, i) => {
      const fill = parseColour(hex);
      const k = fitCard(fill, { sheen });
      const { lo, hi } = extremes(fill, k);
      for (const [what, c] of [['text', k.ink], ['secondary', k.ink2]]) {
        assert.ok(contrast(c, lo) >= 4.5, `${theme} w${i + 1} ${hex} ${what} at the top: ${contrast(c, lo).toFixed(2)}`);
        assert.ok(contrast(c, hi) >= 4.5, `${theme} w${i + 1} ${hex} ${what} at the bottom: ${contrast(c, hi).toFixed(2)}`);
      }
      assert.ok(k.ratio >= 4.5 && k.ratio2 >= 4.5, `${theme} w${i + 1}: reported ratios`);
      assert.ok(k.dt >= 0 && k.dt <= DEPTH.shift && k.db >= 0 && k.db <= DEPTH.shift, 'gradient within ±7%');
    });
  });
}

test('the six darkened light colours now get real top-light and sheen', () => {
  for (const i of [0, 2, 3, 7, 9, 11]) { // teal, red, blue, violet, forest, magenta
    const k = fitCard(parseColour(WALLET_LIGHT[i]), { sheen: DEPTH.sheenLight });
    assert.ok(k.dt >= 0.025, `w${i + 1} top-light ${k.dt}`); // teal 2.5%, the rest 5–7% (before darkening: 0–2%)
    assert.equal(k.sh, DEPTH.sheenLight, `w${i + 1} full sheen`);
    assert.deepEqual(k.ink, [255, 255, 255], `w${i + 1} white text`);
  }
});

test('text colour: the app ink (#16171d) or white; pure black only when neither reaches 4.5:1', () => {
  assert.deepEqual(fitCard(parseColour('#f6d236')).ink, [22, 23, 29], 'yellow: dark ink');
  assert.deepEqual(fitCard(parseColour('#1d2e65')).ink, [255, 255, 255], 'navy: white');
  // The old swatches a user may have picked still get readable text, whatever the depth does.
  for (const hex of ['#b5852a', '#4a78ad', '#c05f3c', '#3a92b5', '#c0577f', '#87609f', '#7a8835', '#8a6648', '#2d8a8c', '#a8474f',
    '#d4a54a', '#7aa3d4', '#e0845f', '#67b6d6', '#df7fa3', '#ae8cc6', '#a3b05a', '#b88f6e', '#5bb3b3', '#d0727a']) {
    const k = fitCard(parseColour(hex));
    assert.ok(k.ratio >= 4.5 && k.ratio2 >= 4.5, `${hex}: ${k.ratio.toFixed(2)} / ${k.ratio2.toFixed(2)}`);
  }
  const flat = fitCard(parseColour('#057274'), { depth: false });
  assert.equal(flat.dt + flat.db + flat.sh, 0, 'depth off: flat');
});

test('shiftL changes lightness only, within sRGB', () => {
  const up = shiftL([5, 114, 116], 0.05);
  const down = shiftL([5, 114, 116], -0.05);
  assert.ok(contrast(up, [255, 255, 255]) < contrast([5, 114, 116], [255, 255, 255]), 'lighter');
  assert.ok(contrast(down, [255, 255, 255]) > contrast([5, 114, 116], [255, 255, 255]), 'darker');
  for (const c of [...up, ...down]) assert.ok(c >= 0 && c <= 255);
  assert.deepEqual(parseColour('rgb(1, 2, 3)'), [1, 2, 3]);
  assert.deepEqual(parseColour(' #abc '), [170, 187, 204]);
  assert.equal(parseColour('nope'), null);
});

/* Automatic colours ------------------------------------------------------------------------- */
const names = (n) => Array.from({ length: n }, (_, i) => `G${String(i).padStart(2, '0')}`);
const noEqualNeighbours = (order, map) => order.every((n, i) => i === 0 || map[n] !== map[order[i - 1]]);

test('up to 15 groups get 15 different colours in slot order', () => {
  const order = names(15);
  const patch = assignAutoColours(order, {}, new Set());
  assert.deepEqual(order.map((n) => patch[n]), WALLET_KEYS);
  assert.deepEqual(assignAutoColours(order, patch, new Set()), {}, 'stable: nothing changes the second time');
});

test('more than 15 groups cycle, never with two equal colours next to each other', () => {
  for (const n of [16, 17, 23, 30, 31, 46]) {
    const order = names(n);
    const map = assignAutoColours(order, {}, new Set());
    assert.ok(noEqualNeighbours(order, map), `${n} groups`);
    assert.ok(order.every((g) => isWalletKey(map[g])), `${n}: all wallet colours`);
  }
});

test('adding or removing a group keeps the others and never makes equal neighbours', () => {
  let order = names(20);
  let map = assignAutoColours(order, {}, new Set());
  const before = { ...map };
  // A group inserted in the middle takes a free colour unlike both neighbours; nobody else moves.
  order = [...order.slice(0, 7), 'G06b', ...order.slice(7)].sort();
  const patch = assignAutoColours(order, map, new Set());
  assert.deepEqual(Object.keys(patch), ['G06b']);
  map = { ...map, ...patch };
  assert.ok(noEqualNeighbours(order, map));
  for (const g of Object.keys(before)) assert.equal(map[g], before[g], `${g} kept`);
  // Removing groups can bring two equal colours together: the later one moves.
  for (let k = 0; k < 6; k++) {
    order = order.filter((_, i) => i !== 3);
    map = { ...map, ...assignAutoColours(order, map, new Set()) };
    assert.ok(noEqualNeighbours(order, map), `after removing ${k + 1}`);
  }
});

test('a colour someone picked is never changed; automatic picks from the old ten move to the palette', () => {
  const order = ['Food', 'Fuel', 'House', 'Travel'];
  const map = { Food: 'g3', Fuel: 'g5', House: 'g1', Travel: 'w9' };
  const patch = assignAutoColours(order, map, new Set(['Fuel']));
  assert.ok(!('Fuel' in patch), 'picked: untouched');
  assert.ok(isWalletKey(patch.Food) && isWalletKey(patch.House), 'old automatic colours move to the palette');
  assert.ok(!('Travel' in patch), 'a wallet colour stays');
  const all = { ...map, ...patch };
  assert.ok(noEqualNeighbours(order, all));
  // Even a picked colour equal to its neighbour stays: it was someone's choice.
  const twins = assignAutoColours(['A', 'B'], { A: 'g2', B: 'g2' }, new Set(['A', 'B']));
  assert.deepEqual(twins, {});
});

/* Totals ----------------------------------------------------------------------------------- */
const Y = 2026;
const M = 10; // November
const pad = (n) => String(n).padStart(2, '0');
const day = (y, m, d) => { const x = new Date(y, m, d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const base = { type: 'expense', currency: 'TWD', date: '', category: '', nextRenewal: '' };
const ITEMS = [
  { ...base, id: 'rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: day(Y, M, 1), category: 'House' },
  { ...base, id: 'car', name: 'Car insurance', price: 12800, cycle: 'annual', nextRenewal: day(Y - 1, M, 30), category: 'Insurance' },
  { ...base, id: 'travel', name: 'Travel insurance', price: 860, cycle: 'once', date: day(Y, 6, 2), category: 'Insurance' },
  { ...base, id: 'duo', name: 'Duolingo', price: 2490, cycle: 'annual', nextRenewal: day(Y, 0, 20), category: 'Education' },
  { ...base, id: 'gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Fitness' }, // undated
  { ...base, id: 'claude', name: 'Claude Pro', price: 20, currency: 'USD', cycle: 'monthly', nextRenewal: day(Y, M, 4), category: 'AI' },
  { ...base, id: 'notion', name: 'Notion AI', price: 330, cycle: 'monthly', nextRenewal: day(Y, M, 23), category: 'AI' },
  { ...base, id: 'misc', name: 'Misc', price: 100, cycle: 'monthly', nextRenewal: day(Y, M, 3) }, // Uncategorised
  { ...base, type: 'income', id: 'salary', name: 'Salary', price: 85000, cycle: 'monthly', nextRenewal: day(Y, M, 5) },
  { ...base, type: 'income', id: 'gig', name: 'Gig', price: 200, currency: 'USD', cycle: 'once', date: day(Y, M, 8) },
];

for (const period of ['monthly', 'annual']) {
  test(`${period}: the cards add up to the Money card's Cash due, other currencies apart; income is no card`, () => {
    const groups = walletGroups(ITEMS, { currency: 'TWD', period, year: Y, month: M });
    const card = stripSummary(ITEMS.filter((s) => s.currency === 'TWD'), period, Y, M);
    assert.equal(groups.reduce((t, g) => t + g.total, 0), card.outgoings, 'outgoings');
    assert.ok(groups.every((g) => g.items.every((s) => s.type !== 'income')), 'no income items in any card');
  });
}

test('cards: the Money tab groups A–Z with Uncategorised last, no Income card; items A–Z', () => {
  const groups = walletGroups(ITEMS, { currency: 'TWD', period: 'monthly', year: Y, month: M });
  assert.deepEqual(groups.map((g) => g.name), ['AI', 'Education', 'Fitness', 'House', 'Insurance', 'Uncategorised']);
  assert.deepEqual(groups.find((g) => g.name === 'Insurance').items.map((s) => s.name), ['Car insurance', 'Travel insurance']);
  assert.deepEqual(groups.map((g) => g.key).slice(0, 2), ['g:AI', 'g:Education']);
  assert.deepEqual(walletGroups(ITEMS.filter((s) => s.type === 'income'), { currency: 'TWD', period: 'monthly', year: Y, month: M }), [], 'income only: no cards');
});

test('cards: month totals, nothing due, undated, and other currencies counted but not added', () => {
  const by = (g) => Object.fromEntries(g.map((x) => [x.name, x]));
  const m = by(walletGroups(ITEMS, { currency: 'TWD', period: 'monthly', year: Y, month: M }));
  assert.equal(m.House.total, 30000);
  assert.equal(m.Insurance.total, 12800, 'annual in its renewal month; the one-off is in July');
  assert.equal(m.Education.total, 0, 'nothing due');
  assert.equal(m.Fitness.total, 0, 'undated: counted nowhere');
  assert.equal(m.AI.total, 330);
  assert.deepEqual(m.AI.others, [{ currency: 'USD', count: 1 }]);
  assert.equal(othersText(m.AI.others), '+1 in USD');
  assert.equal(m.Income, undefined, 'income is no card');
  assert.deepEqual(m.AI.ranked.map((s) => s.name), ['Notion AI', 'Claude Pro'], 'default currency first');
  const y = by(walletGroups(ITEMS, { currency: 'TWD', period: 'annual', year: Y, month: M }));
  assert.equal(y.House.total, 360000);
  assert.equal(y.Insurance.total, 12800 + 860);
  assert.equal(y.Education.total, 2490);
  assert.equal(y.AI.total, 330 * 12);
  assert.equal(periodCash(ITEMS[1], 'annual', Y, M), 12800);
  assert.equal(othersText([]), '');
  assert.deepEqual(walletGroups([], { currency: 'TWD', period: 'monthly', year: Y, month: M }), [], 'no items: no cards');
});

/* Sort ------------------------------------------------------------------------------------- */
// ITEMS plus two groups with nothing in TWD: Cloud (two USD items) and Games (one JPY item), and a
// TWD group, Books, with the same month total as Uncategorised (100) to check the A–Z tie-break.
const SORT_ITEMS = [
  ...ITEMS,
  { ...base, id: 'aws', name: 'AWS', price: 15, currency: 'USD', cycle: 'monthly', nextRenewal: day(Y, M, 9), category: 'Cloud' },
  { ...base, id: 'vps', name: 'VPS', price: 6, currency: 'USD', cycle: 'monthly', nextRenewal: day(Y, M, 12), category: 'Cloud' },
  { ...base, id: 'psn', name: 'PSN', price: 900, currency: 'JPY', cycle: 'monthly', nextRenewal: day(Y, M, 14), category: 'Games' },
  { ...base, id: 'kindle', name: 'Kindle', price: 100, cycle: 'monthly', nextRenewal: day(Y, M, 20), category: 'Books' },
];
const sorted = (sort, period = 'monthly', items = SORT_ITEMS) =>
  sortGroups(walletGroups(items, { currency: 'TWD', period, year: Y, month: M }), sort, 'TWD').map((g) => g.name);

test('sort: A–Z is the order the Money tab always had, and the default for any other saved value', () => {
  const today = walletGroups(SORT_ITEMS, { currency: 'TWD', period: 'monthly', year: Y, month: M }).map((g) => g.name);
  assert.deepEqual(sorted('az'), today, 'unchanged');
  assert.deepEqual(today, ['AI', 'Books', 'Cloud', 'Education', 'Fitness', 'Games', 'House', 'Insurance', 'Uncategorised']);
  for (const pref of [null, undefined, '', 'nope', 'AZ', 'Total']) {
    assert.equal(groupSortFrom(pref), 'az', String(pref));
    assert.deepEqual(sorted(pref), today, `${pref}: today's order`);
  }
  assert.equal(groupSortFrom('total'), 'total');
  assert.equal(groupSortFrom('items'), 'items');
  assert.deepEqual(GROUP_SORTS, ['az', 'total', 'items']);
});

test('sort by total: this month high to low, ties A–Z, other-currency-only groups last by item count', () => {
  // House 30,000 · Insurance 12,800 · AI 330 · Books 100 = Uncategorised 100 (A–Z, Uncategorised
  // last) · Education 0 = Fitness 0 (nothing due, undated) · then Cloud (2 USD) and Games (1 JPY).
  assert.deepEqual(sorted('total'), ['House', 'Insurance', 'AI', 'Books', 'Uncategorised', 'Education', 'Fitness', 'Cloud', 'Games']);
});

test('sort by total: Annual uses the year, so the order follows the year totals', () => {
  // House 360,000 · Insurance 13,660 · AI 3,960 · Education 2,490 · Books 1,200 = Uncategorised 1,200
  // · Fitness 0 (undated) · Cloud · Games. Education moves up: its annual plan renews in January.
  assert.deepEqual(sorted('total', 'annual'), ['House', 'Insurance', 'AI', 'Education', 'Books', 'Uncategorised', 'Fitness', 'Cloud', 'Games']);
  assert.notDeepEqual(sorted('total', 'annual'), sorted('total', 'monthly'), 'Monthly and Annual differ here');
});

test('sort by items: most items first, ties A–Z; every currency counts', () => {
  // AI 2 (one USD) · Cloud 2 · Insurance 2 · then the groups with 1, A–Z, Uncategorised last.
  assert.deepEqual(sorted('items'), ['AI', 'Cloud', 'Insurance', 'Books', 'Education', 'Fitness', 'Games', 'House', 'Uncategorised']);
});

test('sort: no Income group in any order; empty groups, no groups and the input left alone', () => {
  const groups = [
    { name: 'Zed', items: [{ currency: 'TWD' }], total: 5 },
    { name: 'Empty', items: [], total: 0 },
    { name: 'Abc', items: [{ currency: 'USD' }], total: 0 },
    { name: 'Nil', total: 0 },
  ];
  const copy = JSON.stringify(groups);
  assert.deepEqual(sortGroups(groups, 'total', 'TWD').map((g) => g.name), ['Zed', 'Empty', 'Nil', 'Abc'], 'an empty group counts as 0, not as other-currency only');
  assert.deepEqual(sortGroups(groups, 'items', 'TWD').map((g) => g.name), ['Abc', 'Zed', 'Empty', 'Nil']);
  assert.deepEqual(sortGroups(groups, 'az', 'TWD').map((g) => g.name), ['Abc', 'Empty', 'Nil', 'Zed']);
  assert.equal(JSON.stringify(groups), copy, 'not changed in place');
  assert.deepEqual(sortGroups([], 'total', 'TWD'), []);
  for (const mode of GROUP_SORTS) {
    assert.deepEqual(sorted(mode, 'monthly', ITEMS.filter((s) => s.type === 'income')), [], `${mode}: income only, no groups`);
    assert.ok(!sorted(mode).includes('Income'), `${mode}: Income is never a group`);
  }
  assert.deepEqual(sorted('items', 'monthly', ITEMS.filter((s) => s.type !== 'income'))[0], 'AI', 'no income: the same groups');
});

/* Income gauge ------------------------------------------------------------------------------- */
// The front Wallet card's share of the period's income: both in TWD on the Money card's basis.
const gaugeFor = (name, period = 'monthly', items = SORT_ITEMS) => {
  const groups = walletGroups(items, { currency: 'TWD', period, year: Y, month: M });
  const income = stripSummary(items.filter((s) => s.currency === 'TWD'), period, Y, M).income;
  return { g: groups.find((x) => x.name === name) ?? null, groups, income };
};

test('gauge: the front card\'s cash due over the income, rounded for the label, exact for the width', () => {
  // November: Salary 85,000 in TWD (the USD gig is never compared). House 30,000 is 35.29…%.
  const { g, income } = gaugeFor('House');
  assert.equal(income, 85000);
  const k = frontGauge(g, income);
  assert.equal(k.kind, 'share');
  assert.equal(k.ratio, 30000 / 85000, 'the width is the exact share');
  assert.equal(k.pct, 35);
  assert.equal(k.tiny, false);
  assert.equal(frontGauge(gaugeFor('Insurance').g, income).pct, 15, 'Insurance 12,800: 15.06% → 15');
  // Annual: the year's cash due over the year's income (Salary × 12).
  const y = gaugeFor('House', 'annual');
  assert.equal(y.income, 85000 * 12);
  assert.equal(frontGauge(y.g, y.income).ratio, 360000 / (85000 * 12));
  assert.equal(frontGauge(y.g, y.income).pct, 35);
});

test('gauge: under 1% says <1%; 0 is 0%; over 100% fills the bar and keeps the true percentage', () => {
  const income = 85000;
  const tiny = frontGauge(gaugeFor('AI').g, income); // 330: 0.39%
  assert.deepEqual([tiny.kind, tiny.tiny, tiny.pct], ['share', true, 0]);
  assert.ok(tiny.ratio > 0 && tiny.ratio < 0.01, 'a sliver, still the exact share');
  const zero = frontGauge(gaugeFor('Education').g, income); // nothing due this month, all in TWD
  assert.deepEqual([zero.kind, zero.ratio, zero.pct, zero.tiny], ['share', 0, 0, false]);
  const over = incomeGauge({ part: 40000, income: 30000 });
  assert.deepEqual([over.kind, over.ratio, over.pct], ['share', 1, 133], 'full width, the true 133%');
  assert.equal(incomeGauge({ part: 30000, income: 30000 }).ratio, 1, 'exactly the income');
  assert.equal(incomeGauge({ part: 0.995, income: 100 }).tiny, true, '0.995% is under 1%');
  assert.equal(incomeGauge({ part: 1, income: 100 }).tiny, false, '1% is not');
});

test('gauge: no income, no expense groups, and a group in other currencies only', () => {
  const noIncome = ITEMS.filter((s) => s.type !== 'income');
  const a = gaugeFor('House', 'monthly', noIncome);
  assert.equal(a.income, 0);
  assert.deepEqual(frontGauge(a.g, a.income), { kind: 'noIncome', ratio: 0, pct: 0, tiny: false }, 'no income at all');
  // Income that isn't paid this month: an annual bonus in March only.
  const bonusOnly = [...noIncome, { ...base, type: 'income', id: 'bonus', name: 'Bonus', price: 50000, cycle: 'annual', nextRenewal: day(Y, 2, 10) }];
  const b = gaugeFor('House', 'monthly', bonusOnly);
  assert.equal(frontGauge(b.g, b.income).kind, 'noIncome', 'none paid this month');
  assert.equal(frontGauge(gaugeFor('House', 'annual', bonusOnly).g, 50000).kind, 'share', 'but the year has it');
  assert.deepEqual(frontGauge(null, 85000), { kind: 'empty', ratio: 0, pct: 0, tiny: false }, 'no expense groups: an empty bar');
  assert.equal(totalGauge([], 85000).kind, 'empty');
  assert.equal(frontGauge(null, 0).kind, 'noIncome', 'no income wins over no groups');
  const cloud = gaugeFor('Cloud'); // two USD items, due this month
  assert.deepEqual(frontGauge(cloud.g, cloud.income), { kind: 'foreign', ratio: 0, pct: 0, tiny: false }, 'other currencies are never compared');
  assert.equal(frontGauge(gaugeFor('AI').g, 85000).kind, 'share', 'a group with a TWD amount too is compared on that');
});

test('gauge, Grid and List: all the outgoings over the income, the same as the Money card', () => {
  for (const period of ['monthly', 'annual']) {
    const { groups, income } = gaugeFor('House', period);
    const card = stripSummary(SORT_ITEMS.filter((s) => s.currency === 'TWD'), period, Y, M);
    const k = totalGauge(groups, income);
    assert.equal(k.ratio, card.outgoings / card.income, `${period}: Cash due ÷ Income`);
    assert.equal(k.pct, Math.round((card.outgoings / card.income) * 100));
  }
  assert.equal(totalGauge([{ total: 900 }], 600).ratio, 1, 'over the income: full');
  assert.equal(totalGauge([{ total: 900 }], 600).pct, 150);
});

test('gauge colours: every automatic and picked colour, and the accent, at least 3:1 on the track, or ringed', () => {
  // The track, the ring and the segment colours from app.css, in the light block and each dark block
  // (each block lists the accent, then the ten picked colours, then the fifteen automatic ones and
  // the gauge's track and ring).
  const starts = [...css.matchAll(/--wallet-1:/g)].map((m) => m.index);
  assert.equal(starts.length, 3, 'light, dark media query, dark data-theme');
  const after = (name, from) => parseColour(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css.slice(from))[1]);
  const before = (name, at) => after(name, css.lastIndexOf(`--${name}:`, at));
  const ringed = starts.map((at, b) => {
    const theme = ['light', 'dark (media query)', 'dark (data-theme)'][b];
    const track = after('gauge-track', at);
    const ring = after('gauge-ring', at);
    assert.ok(contrast(ring, track) >= GAUGE_CONTRAST, `${theme}: the ring itself is at least 3:1 on the track`);
    const fills = [
      ...Array.from({ length: 15 }, (_, i) => [`wallet-${i + 1}`, after(`wallet-${i + 1}`, at)]),
      ...Array.from({ length: 10 }, (_, i) => [`group-${i + 1}`, before(`group-${i + 1}`, at)]),
      ['accent (Grid and List)', before('accent', at)],
    ];
    assert.equal(fills.length, 26);
    const out = [];
    for (const [name, fill] of fills) {
      const ratio = contrast(fill, track);
      // Below 3:1 the app draws the ring (js/app.js uses this same gaugeNeedsRing).
      assert.equal(gaugeNeedsRing(fill, track), ratio < GAUGE_CONTRAST, `${theme} ${name}: ring exactly when under 3:1`);
      if (ratio < GAUGE_CONTRAST) out.push(name);
    }
    return out;
  });
  assert.deepEqual(ringed[1], ringed[2], 'both dark blocks ring the same colours');
  assert.ok(ringed[0].length > 0 && ringed[1].length > 0, 'some colours need the ring in each theme (so both cases are checked)');
  assert.ok(ringed[0].length < 26 && ringed[1].length < 26, 'and some stand out on their own');
});

test('sort: the groups keep their items and totals; only the order changes', () => {
  const groups = walletGroups(SORT_ITEMS, { currency: 'TWD', period: 'monthly', year: Y, month: M });
  const before = new Map(groups.map((g) => [g.name, g]));
  for (const mode of GROUP_SORTS) {
    const out = sortGroups(groups, mode, 'TWD');
    assert.equal(out.length, groups.length, mode);
    for (const g of out) assert.equal(g, before.get(g.name), `${mode}: ${g.name} is the same card`);
  }
});

/* Geometry and motion ------------------------------------------------------------------------ */
test('card poses: bands follow each other, the front card shows its reveal, passed cards pile up', () => {
  assert.equal(cardPose(0).y, GEOM.peek);
  assert.equal(cardPose(1).y, GEOM.peek + GEOM.band + GEOM.reveal);
  assert.equal(cardPose(2).y - cardPose(1).y, GEOM.band);
  const p = cardPose(-1);
  assert.ok(p.y < GEOM.peek && p.s < 1 && p.rx < 0 && p.o === 1, 'into the pile, tilted back');
  assert.equal(cardPose(-4).o, 0, 'gone after a few');
  // Continuous through the front slot.
  assert.ok(Math.abs(cardPose(-0.001).y - cardPose(0).y) < 0.1);
  assert.ok(Math.abs(cardPose(0.999).y - cardPose(1.001).y) < 0.5);
  assert.equal(collapsedHeight(), 176);
});

test('scroll range: everything fits, one card, and the last face clear of the floating buttons', () => {
  assert.equal(maxScroll(0, 500), 0);
  assert.equal(maxScroll(1, 500), 0);
  assert.equal(maxScroll(4, 800), 0, 'four cards fit in 800 px');
  const plain = maxScroll(16, 472);
  const clear = maxScroll(16, 472, 140);
  assert.ok(clear > plain, 'the inset needs a little more travel');
  // At the end the last card's text is above the inset, and one step less it wouldn't be.
  assert.ok(cardPose(15 - clear).y + faceText() <= 472 - 140, 'last card text clear');
  assert.ok(cardPose(15 - clear + 1).y + faceText() > 472 - 140, 'no further than needed');
  assert.ok(clear < 15, 'the last card does not have to become the front card');
  assert.equal(viewFrom(null), 'wallet', 'a device that never chose: Wallet');
  assert.equal(viewFrom('grid'), 'grid');
  assert.equal(viewFrom('list'), 'list');
  assert.equal(viewFrom('wallet'), 'wallet');
  assert.equal(viewFrom('nonsense'), 'wallet');
  assert.equal(viewFrom('calendar'), 'wallet', 'a saved Calendar view (1.19.0): the Wallet, now that Calendar is a tab');
});

test('rubber band past the ends, never more than two cards', () => {
  assert.equal(rubberBand(3, 5), 3);
  assert.ok(rubberBand(-10, 5) > -2 && rubberBand(-10, 5) < 0);
  assert.ok(rubberBand(50, 5) < 7 && rubberBand(50, 5) > 5);
});

test('release: a fling glides to a band, slow releases and ends snap with the spring', () => {
  assert.deepEqual(releasePlan(2.2, 0.1, 9), { mode: 'spring', target: 2 }, 'slow: nearest band');
  const fling = releasePlan(2, 12, 20);
  assert.equal(fling.mode, 'coast');
  assert.equal(fling.target, Math.round(2 + 12 * 0.33));
  assert.ok(Math.abs(fling.tau * 12 - (fling.target - 2)) < 1e-9, 'lands exactly: the glide starts at the release speed');
  assert.deepEqual(releasePlan(8, 30, 9), { mode: 'spring', target: 9 }, 'into the end: spring there');
  assert.deepEqual(releasePlan(-0.6, -3, 9), { mode: 'spring', target: 0 }, 'pulled past the start');
});

test('release velocity: from the last 90 ms, 0 when the finger stopped first', () => {
  const s = [[0, 0], [16, 0.25], [32, 0.5], [48, 0.75]];
  assert.ok(Math.abs(sampleVelocity(s, 50) - 15.625) < 1e-9);
  assert.equal(sampleVelocity(s, 200), 0, 'held still before letting go');
  assert.equal(sampleVelocity([], 10), 0);
  assert.equal(sampleVelocity([[0, 0], [10, 50]], 12), 60, 'clamped');
});
