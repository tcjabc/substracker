// Node tests for the Wallet divider's colour checks (js/wallet-math.js deltaE, simulateCVD,
// seenDistance, dividerIndices): OKLab distance, colour-vision simulation, and which neighbouring
// cards get a divider with the real palette (the 15 slot colours and the old picked g1-g10) in both
// themes. Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WALLET_LIGHT, WALLET_DARK, parseColour, deltaE, simulateCVD, CVD_KINDS, seenDistance, dividerIndices, DIVIDER_DELTA_E,
} from '../js/wallet-math.js';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
/** --group-1 … --group-10 in the light block and in the first dark block of app.css. */
function groupColours() {
  const at = (from) => Array.from({ length: 10 }, (_, i) => parseColour(new RegExp(`--group-${i + 1}:\\s*(#[0-9a-f]{6})`, 'i').exec(css.slice(from))[1]));
  const dark = css.indexOf('prefers-color-scheme: dark');
  return { light: at(0), dark: at(dark) };
}
const W = { light: WALLET_LIGHT.map(parseColour), dark: WALLET_DARK.map(parseColour) };
const G = groupColours();

test('deltaE is OKLab ×100: 0 for the same colour, symmetric, about 100 from black to white', () => {
  assert.equal(deltaE([10, 20, 30], [10, 20, 30]), 0);
  assert.ok(Math.abs(deltaE([0, 0, 0], [255, 255, 255]) - 100) < 0.01);
  assert.equal(deltaE(W.light[3], W.light[7]), deltaE(W.light[7], W.light[3]));
  assert.equal(DIVIDER_DELTA_E, 26);
});

test('colour-vision simulation: greys stay grey; blue and violet nearly meet under protan (the plan\'s 1.2–1.4)', () => {
  for (const k of CVD_KINDS) for (const v of [0, 128, 255]) assert.deepEqual(simulateCVD([v, v, v], k).map((x) => Math.abs(x - v) <= 1), [true, true, true], `${k} ${v}`);
  const protan = deltaE(simulateCVD(W.light[3], 'protan'), simulateCVD(W.light[7], 'protan'));
  assert.ok(protan < 2, `blue/violet under protan: ${protan.toFixed(2)}`);
  assert.ok(deltaE(W.light[3], W.light[7]) > protan * 5, 'much further apart in normal vision');
  assert.ok(seenDistance(W.light[3], W.light[7]) < 2, 'seenDistance takes the closest anyone sees');
  assert.throws(() => simulateCVD([0, 0, 0], 'achromat'));
});

test('dividers: only above a card too close to the one before, in either theme', () => {
  for (const theme of ['light', 'dark']) {
    const [, mint, , blue, , navy, , violet, , , , , , , yellow] = W[theme];
    assert.deepEqual(dividerIndices([navy, yellow, navy, mint]), [], `${theme}: navy, yellow and mint are apart for everyone`);
    assert.deepEqual(dividerIndices([navy, yellow, blue, violet]), [3], `${theme}: violet after blue`);
    assert.deepEqual(dividerIndices([blue, blue]), [1], `${theme}: the same colour twice`);
    assert.deepEqual(dividerIndices([blue]), []);
    assert.deepEqual(dividerIndices([]), []);
    assert.deepEqual(dividerIndices([null, blue, blue]), [2], 'an unknown fill has no divider');
  }
});

test('the old picked colours are neighbours like any other: g2 steel blue beside w4 blue is close', () => {
  for (const theme of ['light', 'dark']) {
    assert.ok(seenDistance(G[theme][1], W[theme][3]) < DIVIDER_DELTA_E, theme);
    assert.deepEqual(dividerIndices([W[theme][3], G[theme][1]]), [1]);
  }
});

// With ΔE 26 under colour-vision simulation as well, about half the slot pairs count as close in
// the light theme (55 of 105) and most in the dark one (77 of 105).
test('every pair among the 25 colours a card can have is measured: the close ones get a divider', () => {
  for (const theme of ['light', 'dark']) {
    const all = [...W[theme], ...G[theme]];
    let close = 0;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const d = seenDistance(all[i], all[j]);
      if (d < DIVIDER_DELTA_E) { close++; assert.deepEqual(dividerIndices([all[i], all[j]]), [1]); }
    }
    assert.ok(close > 0, `${theme}: some pairs are close (${close})`);
  }
});
