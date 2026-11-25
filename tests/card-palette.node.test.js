// Node tests for the payment-card glyph colours in css/app.css (1.27.0): --card-c1 … --card-c10,
// one set for both themes, defined in all three theme blocks with the same values. The glyph's
// outline (--card-ring, the theme's --text) and the muted outline of a colour this version can't
// draw (--card-ring-neutral, --text-muted) keep 4.5:1 on every plate the glyph sits on, in light and
// dark; the ten fills stay apart from each other as seen with normal vision and under protan, deutan
// and tritan simulation (js/wallet-math.js seenDistance), and clear of the outline and the plates.
// They need not differ from the 15 group colours: the card shape tells them apart. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseColour, contrast, deltaE, seenDistance } from '../js/wallet-math.js';
import { CARD_COLOUR_KEYS } from '../js/cards.js';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const BLOCKS = ['light', 'dark (media query)', 'dark (data-theme)'];
const hexAfter = (name, from) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css.slice(from))?.[1];

// The numbers this palette reaches (pinned: a change that lowers them fails here).
const MIN_SEEN = 9.5; // smallest seenDistance between two fills (normal + protan/deutan/tritan)
const MIN_DELTA_E = 12.4; // smallest deltaE (OKLab x100) between two fills, normal vision
const RING_GAP = 25; // each fill's deltaE from the outline ink, both themes
const PLATE_GAP = 15; // each fill's deltaE from every plate, both themes

const starts = [...css.matchAll(/--card-c1:/g)].map((m) => m.index);
const fillsAt = (at) => CARD_COLOUR_KEYS.map((k) => hexAfter(`card-${k}`, at));
// The plates the glyph sits on: page, surface, surface-2 (the card sheet, Settings, the select's
// row) and the Wallet's logo tile. The theme's values, read from the block the fills are in.
const platesAt = (at) => {
  const from = css.lastIndexOf('--surface:', at);
  return ['bg', 'surface', 'surface-2', 'wallet-tile'].map((n) => hexAfter(n, n === 'bg' ? css.lastIndexOf('--bg:', at) : from));
};
const inkAt = (at, name) => hexAfter(name, css.lastIndexOf(`--${name}:`, at));

test('ten fills c1 … c10, in all three theme blocks, with the same values (one set for both themes)', () => {
  assert.equal(starts.length, 3, 'light, dark media query, dark data-theme');
  const sets = starts.map(fillsAt);
  for (const [b, set] of sets.entries()) assert.ok(set.every(Boolean), `${BLOCKS[b]}: every fill is a hex colour`);
  assert.deepEqual(sets[1], sets[0], 'dark (media query) = light');
  assert.deepEqual(sets[2], sets[0], 'dark (data-theme) = light');
  assert.equal(new Set(sets[0]).size, 10);
  assert.match(css, /--card-ring:\s*var\(--text\);/);
  assert.match(css, /--card-ring-neutral:\s*var\(--text-muted\);/);
  for (const k of CARD_COLOUR_KEYS) assert.ok(css.includes(`.card-glyph[data-colour="${k}"] { --card-fill: var(--card-${k}); }`), k);
});

test('the outline and the muted outline keep 4.5:1 on every plate, light and dark', () => {
  const report = [];
  for (const [b, at] of starts.entries()) {
    const plates = platesAt(at);
    assert.ok(plates.every(Boolean), `${BLOCKS[b]}: plates found`);
    for (const ink of ['text', 'text-muted']) {
      const hex = inkAt(at, ink);
      for (const p of plates) {
        const r = contrast(parseColour(hex), parseColour(p));
        assert.ok(r >= 4.5, `${BLOCKS[b]} --${ink} ${hex} on ${p}: ${r.toFixed(2)}:1`);
        report.push(r);
      }
    }
  }
  assert.ok(Math.min(...report) >= 4.5);
});

test(`the fills stay apart: seen distance >= ${MIN_SEEN}, deltaE >= ${MIN_DELTA_E}, clear of the outline and the plates`, () => {
  const fills = fillsAt(starts[0]).map(parseColour);
  let seen = Infinity;
  let dE = Infinity;
  for (let i = 0; i < fills.length; i++) {
    for (let j = i + 1; j < fills.length; j++) {
      seen = Math.min(seen, seenDistance(fills[i], fills[j]));
      dE = Math.min(dE, deltaE(fills[i], fills[j]));
    }
  }
  assert.ok(+seen.toFixed(1) >= MIN_SEEN, `smallest seen distance ${seen.toFixed(2)}`);
  assert.ok(+dE.toFixed(1) >= MIN_DELTA_E, `smallest deltaE ${dE.toFixed(2)}`);
  for (const at of starts) {
    const inks = [inkAt(at, 'text')].map(parseColour);
    const plates = platesAt(at).map(parseColour);
    for (const f of fills) {
      assert.ok(Math.min(...inks.map((x) => deltaE(f, x))) >= RING_GAP, 'clear of the outline');
      assert.ok(Math.min(...plates.map((x) => deltaE(f, x))) >= PLATE_GAP, 'clear of the plates');
    }
  }
});

// Insights "Paid with" (1.29.0): Cash, Not set (the neutral "Other", --group-other) and a card whose
// colour this version can't draw sit beside the ten card fills in one chart. The numbers reached
// (pinned): Cash 11.5 deltaE and 7.0 seen distance from the nearest fill; the neutral card 12.4 / 9.7
// in light, 17.2 / 10.1 in dark.
const PAY_MIN_DELTA_E = 11.4; // Cash and the neutral card: deltaE from the nearest fill
const PAY_MIN_SEEN = 6.9; // and seen distance (normal + protan/deutan/tritan)
const PAY_APART = 15; // Cash, Not set and the neutral card from each other, and each from the plates

test('Paid with: Cash, Not set and the neutral card, in all three theme blocks, apart from the fills, each other and the plates', () => {
  const fills = fillsAt(starts[0]).map(parseColour);
  for (const [b, at] of starts.entries()) {
    const block = css.slice(at, css.indexOf('--ring-shadow:', at));
    assert.match(block, /--pay-none:\s*var\(--group-other\);/, `${BLOCKS[b]}: Not set is the neutral Other`);
    const cash = hexAfter('pay-cash', at);
    const neutral = hexAfter('pay-card-neutral', at);
    assert.ok(cash && neutral && block.includes('--pay-cash:') && block.includes('--pay-card-neutral:'), `${BLOCKS[b]}: both defined in the block`);
    const none = inkAt(at, 'group-other');
    const pay = [cash, neutral].map(parseColour);
    for (const p of pay) {
      const dE = Math.min(...fills.map((f) => deltaE(p, f)));
      const seen = Math.min(...fills.map((f) => seenDistance(p, f)));
      assert.ok(+dE.toFixed(1) >= PAY_MIN_DELTA_E, `${BLOCKS[b]}: deltaE ${dE.toFixed(2)} from the nearest fill`);
      assert.ok(+seen.toFixed(1) >= PAY_MIN_SEEN, `${BLOCKS[b]}: seen distance ${seen.toFixed(2)} from the nearest fill`);
    }
    const three = [...pay, parseColour(none)];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) assert.ok(deltaE(three[i], three[j]) >= PAY_APART, `${BLOCKS[b]}: ${i} and ${j} apart`);
      for (const p of platesAt(at).map(parseColour)) assert.ok(deltaE(three[i], p) >= PAY_APART, `${BLOCKS[b]}: ${i} clear of the plates`);
    }
  }
  assert.match(css, /--card-glyph-xs:\s*9px;/, 'the Calendar marker is 9px wide');
});
