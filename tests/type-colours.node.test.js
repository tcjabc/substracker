// Node tests for the money-in and money-out text colours in css/app.css (1.21.1): --positive-text and
// --negative-text, defined in all three theme blocks, each keep 4.5:1 on its own 15% tint
// (--positive-tint, --negative-tint: color-mix() in sRGB with the theme's surface), in light and
// dark. The add sheet's Expense | Income switch uses them; a later Calendar arrow will too.
// Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseColour, contrast } from '../js/wallet-math.js';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const BLOCKS = ['light', 'dark (media query)', 'dark (data-theme)'];
const value = (name, from) => parseColour(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css.slice(from))[1]);
/** color-mix(in srgb, fg p%, bg): a straight mix of the sRGB values, as browsers do it. */
const mix = (fg, bg, p) => fg.map((c, i) => Math.round(c * p + bg[i] * (1 - p)));

test('the two tints are 15% of the text colour on the surface, defined once', () => {
  for (const kind of ['positive', 'negative']) {
    const defs = [...css.matchAll(new RegExp(`--${kind}-tint:\\s*([^;]+);`, 'g'))].map((m) => m[1].trim());
    assert.deepEqual(defs, [`color-mix(in srgb, var(--${kind}-text) 15%, var(--surface))`], `--${kind}-tint`);
  }
});

test('money in and money out: defined in every theme block, each 4.5:1 or more on its own tint', () => {
  const starts = [...css.matchAll(/--positive-text:/g)].map((m) => m.index);
  assert.equal(starts.length, 3, 'light, dark media query, dark data-theme');
  const seen = [];
  starts.forEach((at, b) => {
    const surface = value('surface', css.lastIndexOf('--surface:', at));
    for (const kind of ['positive', 'negative']) {
      const text = value(`${kind}-text`, at);
      const tint = mix(text, surface, 0.15);
      const ratio = contrast(text, tint);
      assert.ok(ratio >= 4.5, `${BLOCKS[b]} ${kind}: ${ratio.toFixed(2)}:1 on its tint`);
      assert.ok(contrast(text, surface) >= 4.5, `${BLOCKS[b]} ${kind}: and on the plain surface`);
      seen.push([BLOCKS[b], kind, text, ratio.toFixed(2)]);
    }
  });
  // Both dark blocks carry the same values.
  assert.deepEqual(seen.slice(2, 4).map((r) => r.slice(1, 3)), seen.slice(4, 6).map((r) => r.slice(1, 3)), 'the two dark blocks agree');
});

test('the green and the red stay apart: a different hue family, the green leaning teal, the red warm', () => {
  for (const at of [...css.matchAll(/--positive-text:/g)].map((m) => m.index)) {
    const [gr, gg, gb] = value('positive-text', at);
    const [rr, rg, rb] = value('negative-text', at);
    assert.ok(gg > gr && gb > gr * 0.5, 'green: green first, some blue (teal-ward)');
    assert.ok(rr > rg && rg >= rb * 0.9, 'red: red first, no blue lean (warm)');
  }
});
