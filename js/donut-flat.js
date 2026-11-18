// The flat Insights donut (SVG) and its legend: the "Donut" view, and what the "Ring" view shows when
// reduce motion and effects is on, WebGL isn't available or the 3D view can't load.
// Slices come from the month's breakdown (js/insights-calc.js) via donutSlices().

import { esc, money } from './util.js';

const DONUT = { r: 80, gap: 2 }; // SVG user units in a 200 × 200 viewBox; stroke width lives in app.css
const SMALL_SLICE = 0.03; // categories under 3% of the month are pooled into "Other"
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Slices for the month, largest first, from catList [{ name, total, count }]. Two or more categories
 * under 3% become one neutral "Other". `swatchFor(name)` gives a category's colour (a CSS value).
 */
export function donutSlices(catList, total, swatchFor) {
  const big = [];
  const small = [];
  for (const c of catList) (total && c.total / total < SMALL_SLICE ? small : big).push(c);
  // Pooling a single category would only hide its name, so keep it as its own slice.
  if (small.length < 2) big.push(...small.splice(0));
  const slices = big.map((c) => ({
    key: `cat:${c.name}`, name: c.name, total: c.total, sub: plural(c.count, 'item'),
    swatch: swatchFor(c.name),
  }));
  if (small.length) {
    slices.push({
      key: 'other', name: 'Other', total: small.reduce((t, c) => t + c.total, 0),
      sub: small.map((c) => c.name).join(', '), swatch: 'var(--group-other)',
    });
  }
  return slices;
}

export const shareText = (v, total) => {
  const p = total ? (v / total) * 100 : 0;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
};

export function emptyDonutHTML(cur, monthName) {
  return `
      <div class="panel donut-empty">
        <div class="donut-empty-ring" aria-hidden="true"></div>
        <p class="donut-empty-title">No ${esc(cur)} outgoings in ${esc(monthName)}</p>
        <p class="donut-empty-text">Add an expense, or step to another month.</p>
      </div>`;
}

/** The legend rows: name, item count or pooled names, amount and share. Each row is a button. */
export function legendHTML(slices, total, cur) {
  return `
      <div class="legend">
        ${slices.map((s) => `
        <button type="button" class="legend-row" data-slice="${esc(s.key)}" aria-pressed="false">
          <span class="legend-dot" style="--swatch: ${s.swatch}" aria-hidden="true"></span>
          <span class="legend-text">
            <span class="legend-name">${esc(s.name)}</span>
            <span class="legend-sub">${esc(s.sub)}</span>
          </span>
          <span class="cat-amount">${esc(money(s.total, cur))}<span class="pct">${shareText(s.total, total)}</span></span>
        </button>`).join('')}
      </div>`;
}

/**
 * The flat donut with its legend. `note` (optional, plain text) is shown above it, used when it
 * stands in for the Ring view. `keys`: true makes the chart focusable, with arrow keys moving the
 * highlight (as the Ring view does).
 */
export function donutHTML(slices, total, cur, monthName, { note = '', keys = false } = {}) {
  if (!slices.length) return emptyDonutHTML(cur, monthName);
  const C = 2 * Math.PI * DONUT.r;
  const gap = slices.length > 1 ? DONUT.gap : 0; // a single category is a full ring
  let offset = 0;
  const arcs = slices.map((s) => {
    const len = total ? (s.total / total) * C : C / slices.length;
    const dash = Math.max(len - gap, 0.5);
    const arc = `<circle class="donut-slice" data-slice="${esc(s.key)}" cx="100" cy="100" r="${DONUT.r}"
      style="--swatch: ${s.swatch}" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"><title>${esc(s.name)}: ${esc(money(s.total, cur))} (${shareText(s.total, total)})</title></circle>`;
    offset += len;
    return arc;
  }).join('');

  return `
    <div class="panel">
      ${note ? `<p class="ring-note">${esc(note)}</p>` : ''}
      <div class="donut-wrap">
        <div class="donut"${keys ? ' tabindex="0" data-donut-keys aria-describedby="donut-keys-help"' : ''}>
          <svg viewBox="0 0 200 200" role="img" aria-label="Donut chart of outgoings by category for ${esc(monthName)}. Amounts are listed below.">${arcs}</svg>
          <div class="donut-center">
            <span class="donut-total" data-roll="donut-total" data-value="${total}" data-cur="${esc(cur)}">${esc(money(total, cur))}</span>
            <span class="donut-label">${esc(monthName)}</span>
          </div>
        </div>
        ${keys ? '<p class="sr-only" id="donut-keys-help">Left and right arrow keys highlight the previous or next category.</p>' : ''}
      </div>
      ${legendHTML(slices, total, cur)}
    </div>`;
}

/** Highlight the slice and legend row for `key` (or nothing). Returns the key if it is shown, else null. */
export function applyDonutHighlight(root, key) {
  const has = !!key && [...root.querySelectorAll('[data-slice]')].some((el) => el.dataset.slice === key);
  root.querySelectorAll('.donut, .legend').forEach((el) => el.classList.toggle('has-active', has));
  root.querySelectorAll('[data-slice]').forEach((el) => {
    const on = has && el.dataset.slice === key;
    el.classList.toggle('is-active', on);
    if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', String(on));
  });
  return has ? key : null;
}
