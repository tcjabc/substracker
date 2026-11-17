// Node tests for js/wallet-math.js: the Wallet's palette (it matches app.css, every slot keeps 4.5:1
// in both themes with the depth on), the automatic colours (slot order, no equal neighbours, picked
// colours untouched), the card totals on the Money strip's cash basis, and the stack's geometry and
// fling maths. Run with `npm test`. Items are made up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WALLET_LIGHT, WALLET_DARK, WALLET_KEYS, isWalletKey, assignAutoColours, fitCard, parseColour, contrast,
  shiftL, mix, walletGroups, othersText, periodCash, cardPose, maxScroll, rubberBand, releasePlan,
  sampleVelocity, GEOM, collapsedHeight, DEPTH, faceText,
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
  test(`${period}: the cards add up to the Money strip (outgoings and income), other currencies apart`, () => {
    const groups = walletGroups(ITEMS, { currency: 'TWD', period, year: Y, month: M });
    const strip = stripSummary(ITEMS.filter((s) => s.currency === 'TWD'), period, Y, M);
    const out = groups.filter((g) => !g.income).reduce((t, g) => t + g.total, 0);
    const inc = groups.filter((g) => g.income).reduce((t, g) => t + g.total, 0);
    assert.equal(out, strip.outgoings, 'outgoings');
    assert.equal(inc, strip.income, 'income');
  });
}

test('cards: Income first, then the Money tab groups A–Z with Uncategorised last; items A–Z', () => {
  const groups = walletGroups(ITEMS, { currency: 'TWD', period: 'monthly', year: Y, month: M });
  assert.deepEqual(groups.map((g) => g.name), ['Income', 'AI', 'Education', 'Fitness', 'House', 'Insurance', 'Uncategorised']);
  assert.deepEqual(groups.find((g) => g.name === 'Insurance').items.map((s) => s.name), ['Car insurance', 'Travel insurance']);
  assert.deepEqual(groups.map((g) => g.key).slice(0, 2), ['income', 'g:AI']);
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
  assert.deepEqual(m.Income.others, [{ currency: 'USD', count: 1 }], 'the USD gig is paid this month');
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
