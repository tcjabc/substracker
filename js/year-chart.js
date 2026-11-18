// The Insights year chart: a circular carousel of month bars (SVG, no libraries). The centre
// month is prominent; swipe or fling to move, tap a bar to focus it (the others shrink into a
// mini strip and the chosen month opens with one row per segment). Pure maths lives in
// year-chart-math.js; the figures come in from the app (chartMonths), so this module only draws
// and handles input. It touches nothing outside `host`.
//
// Performance: the animation loop runs only while something moves, all DOM writes happen in one
// pass per frame and only when a value changed, and the centre month is picked out with plain
// shapes and opacity (an accent outline, a label pill, muted neighbours): no shadows, glows,
// background columns or SVG filters.

import {
  GEOM as G, lerp, clamp, wrapRel, centreIndex, nearestPos, taper, edgeOpacity, prominence,
  monthLabel, labelSize, springStep, springSettle, flingStep, dragVelocity, releaseVelocity,
  staggerOmega, niceScale, monthDelta, listNames, aboveAverage,
  FLING_STOP, SNAP_OMEGA, FOCUS_OMEGA, REDUCED_OMEGA,
} from './year-chart-math.js';
import { t, formatLocale } from './i18n.js';

const NS = 'http://www.w3.org/2000/svg';
const TYPE_COLOUR = { monthly: 'var(--type-monthly)', annual: 'var(--type-annual)', once: 'var(--type-once)' };
const TYPE_NAMES = { monthly: 'chart.type.monthly', annual: 'chart.type.annual', once: 'chart.type.once' }; // keys
const MARK_ABOVE = 'M0,-3.2L3.4,2.6L-3.4,2.6Z';     // small triangle: above the average
const MARK_OVER = 'M0,-3.8L3.8,0L0,3.8L-3.8,0Z';    // small diamond: more out than in

function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
}
function html(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.append(e);
  return e;
}
// Write an attribute / style only when it changed (rounded to 0.01 for numbers).
function set(e, name, v) {
  const val = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
  const c = e._c || (e._c = {});
  if (c[name] === val) return;
  c[name] = val;
  e.setAttribute(name, val);
}
function setStyle(e, prop, v) {
  const c = e._s || (e._s = {});
  if (c[prop] === v) return;
  c[prop] = v;
  e.style[prop] = v;
}
const newSpring = (x, w) => ({ x, v: 0, t: x, w });
const moving = (sp) => !springSettle(sp);

// Three letters ("Sep", not the "Sept" some locales use); the carousel cuts to two where it's tight.
const monthShort = (y, m) => new Date(y, m, 1).toLocaleDateString(formatLocale(), { month: 'short' }).replace('.', '').slice(0, 3);
const monthFull = (y, m) => new Date(y, m, 1).toLocaleDateString(formatLocale(), { month: 'long' });

/**
 * Draw the chart into `host`. opts: { months, average, nowIndex, rolling, stack: 'type' |
 * 'category', showIncome, money(n), categoryColour(group), groupLabel(group) (the name shown for a
 * category; default: the name itself), pos (optional start position),
 * onSettle(pos), fadeIn, overlays (optional, js/overlays.js: focus mode registers there),
 * reduced (optional: reduce motion; defaults to the system's prefers-reduced-motion) }.
 * Returns { setStack, destroy, state, stats }.
 */
export function createYearChart(host, opts) {
  // The app passes its "Reduce motion and effects" setting; on its own the chart follows the system.
  const reduced = opts.reduced ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const W = (w) => (reduced ? REDUCED_OMEGA : w);
  const money = opts.money;
  // A category's name as shown (app.js groupLabel: "Uncategorised" is translated, the rest are the person's).
  const label = opts.groupLabel ?? ((g) => g);
  // Derived figures (the average, differences) in whole units once they're 10 or more.
  const approx = (v) => money(Math.abs(v) >= 10 ? Math.round(v) : v);
  const list = opts.months;
  const n = list.length;
  const avgVal = opts.average;
  const nowIdx = opts.nowIndex;
  const tp = taper(n);
  const R = tp.R;
  const MSLOT = G.MINI_SPAN / n;
  const visibleMax = Math.max(0, ...list.map((d) => (opts.showIncome ? Math.max(d.total, d.income) : d.total)));
  const scaleInfo = niceScale(visibleMax);
  const SCALE = scaleInfo.max ? G.BAR_H / scaleInfo.max : 0;
  const compact = new Intl.NumberFormat(formatLocale(), { notation: 'compact', maximumFractionDigits: 1 });

  /* DOM ------------------------------------------------------------------- */
  host.textContent = '';
  const stage = html('div', 'yc-stage', host);
  const readout = html('div', 'yc-readout', stage);
  readout.setAttribute('aria-hidden', 'true');
  const readTop = html('div', 'yc-read-top', readout);
  const readName = html('span', 'yc-read-name', readTop);
  const readTot = html('span', 'yc-read-total', readTop);
  const readDelta = html('div', 'yc-read-delta', readout);
  const back = html('button', 'yc-back', stage, t('chart.allMonths'));
  back.type = 'button';
  const svg = el('svg', {
    class: 'yc-svg', viewBox: `0 0 ${G.W} ${G.H}`, role: 'listbox', tabindex: '0',
    'aria-label': t('chart.label'),
  }, stage);
  const dock = html('div', 'yc-dock', stage);
  // The key (legend) is hidden until asked for: a small "Show key" toggle, remembered by the app
  // (opts.showKey, opts.onKey). Focus mode names every segment itself.
  const keyBox = html('div', 'yc-keybox', dock);
  const legend = html('div', 'yc-legend', keyBox);
  legend.id = `yc-legend-${Math.random().toString(36).slice(2, 8)}`;
  const keyBtn = html('button', 'yc-keybtn', keyBox);
  keyBtn.type = 'button';
  keyBtn.setAttribute('aria-controls', legend.id);
  let showKey = !!opts.showKey;
  const setKey = (on) => {
    showKey = on;
    legend.hidden = !on;
    keyBtn.textContent = on ? t('chart.key.hide') : t('chart.key.show');
    keyBtn.setAttribute('aria-expanded', String(on));
  };
  setKey(showKey);
  keyBtn.addEventListener('click', () => { setKey(!showKey); opts.onKey?.(showKey); });
  const nowBtn = html('button', 'yc-now', dock, t('chart.now'));
  nowBtn.type = 'button';
  const live = html('p', 'sr-only', stage);
  live.setAttribute('aria-live', 'polite');

  el('rect', { x: 0, y: 0, width: G.W, height: G.H, fill: 'transparent' }, svg);
  const gridL = el('g', {}, svg);
  const barsL = el('g', {}, svg);
  const outlineL = el('g', {}, svg); // the centre (or opened) bar's outline, over the bars
  const incomeL = el('g', {}, svg);
  const markL = el('g', {}, svg);
  const labL = el('g', {}, svg);
  const mlL = el('g', {}, svg);
  const hitL = el('g', {}, svg);

  if (scaleInfo.ticks) {
    for (let k = 1; k <= scaleInfo.ticks; k++) {
      const v = scaleInfo.step * k;
      const y = G.BASE - v * SCALE;
      el('line', { x1: G.PLOT_L, x2: G.PLOT_R, y1: y, y2: y, class: 'yc-grid' }, gridL);
      // Axis labels in the gutter left of the plot, centred on their line: no bar reaches them.
      el('text', { x: G.AXIS_X, y: y + 3, 'text-anchor': 'end', class: 'yc-axis' }, gridL).textContent = compact.format(v);
    }
  }
  el('line', { x1: G.PLOT_L, x2: G.PLOT_R, y1: G.BASE, y2: G.BASE, class: 'yc-baseline' }, gridL);
  const avgY = G.BASE - avgVal * SCALE;
  // The dashed average line spans the plot only (never the gutter's labels); its label is in the
  // legend, where no bar can cover it.
  if (avgVal > 0) el('line', { x1: G.PLOT_L, x2: G.PLOT_R, y1: avgY, y2: avgY, class: 'yc-avg' }, gridL);
  const incomePath = el('path', { class: 'yc-income', d: '' }, incomeL);
  incomeL.setAttribute('display', opts.showIncome ? 'inline' : 'none');

  const deltaText = (total) => {
    const d = monthDelta(total, avgVal);
    // `inline`: the same words inside a sentence read aloud ("…, about the average").
    if (d.kind === 'about') return { text: t('chart.delta.about'), inline: t('chart.delta.about.inline'), cls: 'yc-about' };
    const amount = approx(d.amount);
    return d.kind === 'above'
      ? { text: t('chart.delta.above', { amount }), inline: t('chart.delta.above', { amount }), cls: 'yc-above' }
      : { text: t('chart.delta.below', { amount }), inline: t('chart.delta.below', { amount }), cls: 'yc-below' };
  };
  const monthTitle = (d) => t('chart.monthYear', { month: monthFull(d.y, d.m), year: d.y });

  function segments(d) {
    const T = d.byType.map((ty) => ({
      key: ty.key, name: t(TYPE_NAMES[ty.key]), amount: ty.amount, colour: TYPE_COLOUR[ty.key],
      sub: listNames(ty.names), names: ty.names.join(', '), // `sub` on screen, every name for screen readers
    }));
    const C = d.byCategory.map((c) => ({ key: c.group, name: label(c.group), amount: c.amount, colour: opts.categoryColour(c.group) }));
    for (const segs of [T, C]) {
      let cum = 0;
      for (const s of segs) {
        s.ry = G.BASE - (cum + s.amount) * SCALE; s.rh = s.amount * SCALE;
        s.my = G.MINI_BASE - (cum + s.amount) * SCALE * G.MINI_SCALE; s.mh = s.amount * SCALE * G.MINI_SCALE;
        s.fy = G.FOCUS_BASE - ((cum + s.amount) / d.total) * G.FOCUS_H; s.fh = (s.amount / d.total) * G.FOCUS_H;
        cum += s.amount;
      }
    }
    return { T, C };
  }

  function buildRows(parent, segs, gap, withSub) {
    const rows = segs.slice().reverse();
    const step = rows.length > 1 ? Math.min(gap, 250 / (rows.length - 1)) : gap;
    const y0 = 230 - ((rows.length - 1) * step) / 2;
    rows.forEach((s, j) => {
      const yr = y0 + j * step;
      const ym = s.fy + s.fh / 2;
      el('line', { x1: G.FOCUS_X + G.FOCUS_W + 1, y1: ym, x2: 146, y2: yr, style: `stroke: ${s.colour}`, class: 'yc-leader' }, parent);
      el('circle', { cx: 158, cy: yr, r: 4.5, style: `fill: ${s.colour}` }, parent);
      const name = s.name.length > 17 ? `${s.name.slice(0, 16)}…` : s.name;
      el('text', { x: 170, y: yr + 4, class: 'yc-row-name' }, parent).textContent = name;
      el('text', { x: 344, y: yr + 4, class: 'yc-row-amount', 'text-anchor': 'end' }, parent).textContent = money(s.amount);
      if (withSub && s.sub) el('text', { x: 170, y: yr + 19, class: 'yc-row-sub' }, parent).textContent = s.sub;
    });
  }

  const uid = `yc${Math.random().toString(36).slice(2, 8)}`;
  const bars = list.map((d, i) => {
    const segs = d.total > 0 ? segments(d) : { T: [], C: [] };
    const b = {
      i, d, segs,
      g: newSpring(0, W(14)), s: newSpring(0, W(14)),
      xm: G.MINI_LEFT + MSLOT * (i + 0.5), wm: Math.min(18, MSLOT - 6),
      rTop: G.BASE - d.total * SCALE, mTop: G.MINI_BASE - d.total * SCALE * G.MINI_SCALE, fTop: G.FOCUS_BASE - G.FOCUS_H,
      short: monthShort(d.y, d.m),
    };
    b.grp = el('g', {}, barsL);
    b.gT = el('g', {}, b.grp);
    b.gC = el('g', {}, b.grp);
    b.rT = segs.T.map((s) => el('rect', { style: `fill: ${s.colour}` }, b.gT));
    b.rC = segs.C.map((s) => el('rect', { style: `fill: ${s.colour}` }, b.gC));
    // Away from the centre a bar is muted: less opacity, plus this veil of the card colour over it
    // (a mix with the background, not a filter), so its colours read a little less saturated.
    b.veil = el('rect', { class: 'yc-veil', display: 'none' }, b.grp);
    b.olGap = el('path', { class: 'yc-outline-gap', 'data-for': i, display: 'none' }, outlineL);
    b.ol = el('rect', { class: 'yc-outline', 'data-for': i, display: 'none' }, outlineL);
    b.markAbove = aboveAverage(d.total, avgVal);
    b.markOver = opts.showIncome && d.over && d.total > 0;
    b.mark = (opts.showIncome ? b.markOver : b.markAbove)
      ? el('path', { d: opts.showIncome ? MARK_OVER : MARK_ABOVE, class: opts.showIncome ? 'yc-mark-over' : 'yc-mark-above' }, markL) : null;
    b.lab = el('g', { display: 'none' }, labL);
    el('text', { x: 16, y: 44, class: 'yc-focus-month' }, b.lab).textContent = opts.rolling ? monthTitle(d) : monthFull(d.y, d.m);
    el('text', { x: 16, y: 70, class: 'yc-focus-total' }, b.lab).textContent = money(d.total);
    const dt = deltaText(d.total);
    el('text', { x: 16, y: 90, class: `yc-focus-delta ${dt.cls}` }, b.lab).textContent = dt.text;
    b.labT = el('g', {}, b.lab);
    b.labC = el('g', {}, b.lab);
    buildRows(b.labT, segs.T, 46, true);
    buildRows(b.labC, segs.C, 25, false);
    if (!d.total) el('text', { x: 170, y: 234, class: 'yc-row-sub' }, b.lab).textContent = t('chart.nothingDue');
    // The centre month's label sits in a small accent pill (drawn first, so the text is on top).
    b.pill = el('rect', { class: 'yc-pill', 'data-for': i, height: 15, rx: 7.5, display: 'none' }, mlL);
    b.ml = el('text', { 'text-anchor': 'middle', class: 'yc-month' }, mlL);
    b.yl = opts.rolling ? el('text', { 'text-anchor': 'middle', class: 'yc-month yc-year' }, mlL) : null;
    if (b.yl) b.yl.textContent = `'${String(d.y).slice(2)}`;
    const label = `${monthTitle(d)}, ${money(d.total)}`;
    b.hit = el('rect', { class: 'yc-hit', 'data-i': i, role: 'option', id: `${uid}-${i}`, 'aria-label': label, 'aria-selected': 'false' }, hitL);
    return b;
  });

  /* Legend ------------------------------------------------------------------ */
  function fillLegend(stack) {
    legend.textContent = '';
    const add = (cls, colour, name) => {
      const s = html('span', 'yc-key', legend);
      const i = html('i', cls, s);
      if (colour) i.style.background = colour;
      s.append(name);
    };
    if (stack === 'category') {
      const seen = [];
      for (const d of list) for (const c of d.byCategory) if (!seen.includes(c.group)) seen.push(c.group);
      seen.forEach((g) => add('yc-swatch', opts.categoryColour(g), label(g)));
    } else {
      ['monthly', 'annual', 'once'].forEach((k) => add('yc-swatch', TYPE_COLOUR[k], t(TYPE_NAMES[k])));
    }
    if (avgVal > 0) add('yc-swatch-avg', null, t('chart.legend.average', { amount: approx(avgVal) }));
    if (opts.showIncome) {
      add('yc-swatch-line', null, t('chart.legend.income'));
      if (bars.some((b) => b.markOver)) add('yc-swatch-over', null, t('chart.legend.over'));
    } else if (bars.some((b) => b.markAbove)) {
      add('yc-swatch-above', null, t('chart.legend.above'));
    }
  }

  /* State ------------------------------------------------------------------- */
  let stack = opts.stack === 'category' ? 'category' : 'type';
  const mix = newSpring(stack === 'category' ? 1 : 0, W(12));
  const avgS = newSpring(1, W(12));
  const gS = newSpring(0, W(12));
  const posS = newSpring(0, W(SNAP_OMEGA));
  const start = Number.isFinite(opts.pos) ? opts.pos : Math.max(0, nowIdx);
  let pos = start;
  let posV = 0;
  let mode = 'idle'; // idle | drag | fling | snap
  let sel = -1;
  let focus = false;
  let lastC = -1;
  let announced = -1;
  let raf = 0;
  let last = 0;
  let dragging = false;
  let down = null;
  const perf = { frames: 0, total: 0, max: 0, samples: [] };

  /* Render ------------------------------------------------------------------ */
  function render() {
    const mx = mix.x;
    const ga = clamp(avgS.x, 0, 1);
    const gl = clamp(gS.x, 0, 1);
    const c = centreIndex(pos, n);
    nowBtn.classList.toggle('on', c !== nowIdx);
    dock.classList.toggle('hide', focus);
    back.classList.toggle('on', focus);
    set(gridL, 'opacity', ga);
    setStyle(readout, 'opacity', String(Math.round((1 - gl) * 100) / 100));
    set(incomeL, 'opacity', 1 - gl);
    if (c !== lastC) {
      if (lastC >= 0 && !focus && mode !== 'idle') { try { navigator.vibrate?.(4); } catch { /* unsupported */ } }
      lastC = c;
      const cb = bars[c];
      readName.textContent = c === nowIdx ? t('chart.readout.now', { month: monthTitle(cb.d) }) : monthTitle(cb.d);
      readTot.textContent = money(cb.d.total);
      const dt = deltaText(cb.d.total);
      readDelta.textContent = dt.text;
      readDelta.className = `yc-read-delta ${dt.cls}`;
      if (!focus) setActive(c);
    }
    const showT = mx < 0.99;
    const showC = mx > 0.01;
    const pts = opts.showIncome ? [] : null;
    for (const b of bars) {
      const g = clamp(b.g.x, 0, 1);
      const s = clamp(b.s.x, 0, 1);
      const u = g * s;
      const rel = wrapRel(b.i, pos, n);
      const ar = Math.abs(rel);
      const p = prominence(ar);
      const xc = G.CX + tp.x(rel);
      const wR = tp.width(ar);
      const xR = xc - wR / 2;
      const edge = edgeOpacity(ar, R);
      const xM = b.xm - b.wm / 2;
      const x = lerp(xR, lerp(xM, G.FOCUS_X, s), g);
      const w = lerp(wR, lerp(b.wm, G.FOCUS_W, s), g);
      // Carousel: full opacity at the centre, about 58% one month away, fading further to the edges.
      const muted = lerp(0.58, 1, p) * lerp(1, 0.72, clamp(ar / R, 0, 1));
      set(b.grp, 'opacity', lerp(muted, lerp(0.55, 1, s), g));
      set(b.gT, 'display', showT ? 'inline' : 'none');
      set(b.gC, 'display', showC ? 'inline' : 'none');
      if (showT) set(b.gT, 'opacity', 1 - mx);
      if (showC) set(b.gC, 'opacity', mx);
      const rx = lerp(2, 5, u);
      const place = (rects, segs) => {
        for (let j = 0; j < segs.length; j++) {
          const sg = segs[j];
          const y = lerp(sg.ry, lerp(sg.my, sg.fy, s), g);
          const h = lerp(sg.rh, lerp(sg.mh, sg.fh, s), g);
          const gap = h > 3 ? 0.6 : 0;
          const hh = Math.max(0, h - gap * 2);
          const r = rects[j];
          set(r, 'x', x); set(r, 'y', y + gap); set(r, 'width', w); set(r, 'height', hh);
          set(r, 'rx', Math.min(rx, hh / 2));
        }
      };
      if (showT) place(b.rT, b.segs.T);
      if (showC) place(b.rC, b.segs.C);
      const topY = b.d.total ? lerp(b.rTop, lerp(b.mTop, b.fTop, s), g) : lerp(G.BASE, G.MINI_BASE, g);
      const baseY = lerp(G.BASE, lerp(G.MINI_BASE, G.FOCUS_BASE, s), g);
      const hw = Math.max(w + 4, lerp(tp.spacing(ar), lerp(MSLOT, w + 6, s), g));
      const hy = Math.min(topY, baseY - 34) - 4;
      set(b.hit, 'x', x + w / 2 - hw / 2); set(b.hit, 'width', hw);
      set(b.hit, 'y', hy); set(b.hit, 'height', baseY - hy + 22);
      if (b.mark) {
        set(b.mark, 'transform', `translate(${Math.round((x + w / 2) * 10) / 10} ${Math.round((topY - 8) * 10) / 10})`);
        set(b.mark, 'opacity', (1 - g) * edge);
      }
      // Centre highlight: plain shapes and opacity, following pos as bars pass the centre. In focus
      // only the opened bar keeps its outline (u); the veil and the pill belong to the carousel.
      const pr = p * (1 - g); // how centred, in carousel terms
      const barH = Math.max(0, baseY - topY);
      const veil = b.d.total ? 0.18 * (1 - p) * (1 - g) : 0;
      if (veil > 0.01) {
        set(b.veil, 'display', 'inline');
        set(b.veil, 'x', x); set(b.veil, 'y', topY); set(b.veil, 'width', w); set(b.veil, 'height', barH);
        set(b.veil, 'rx', Math.min(rx, barH / 2)); set(b.veil, 'opacity', veil);
      } else set(b.veil, 'display', 'none');
      // The outline, in the pill's accent, at full strength on the centre (or opened) bar. A 1px
      // card-coloured gap separates it from the bar (top and sides; open at the baseline), so it
      // stays visible against an annual segment, which is the same accent. The outline's bottom
      // edge sits 0.75 above the baseline, so its 1.5 stroke ends on the baseline and never shows
      // below the bar.
      const ring = b.d.total ? Math.max(pr, u) : 0;
      if (ring > 0.01) {
        set(b.ol, 'display', 'inline'); set(b.olGap, 'display', 'inline');
        set(b.ol, 'x', x - 1.75); set(b.ol, 'y', topY - 1.75); set(b.ol, 'width', w + 3.5); set(b.ol, 'height', barH + 1);
        set(b.ol, 'rx', Math.min(rx + 1.75, (barH + 1) / 2)); set(b.ol, 'opacity', ring);
        const x0 = x - 0.5;
        const x1 = x + w + 0.5;
        const yt = topY - 0.5;
        const r = Math.min(rx + 0.5, (x1 - x0) / 2, Math.max(0, baseY - yt) / 2);
        const f = (v) => Math.round(v * 100) / 100;
        set(b.olGap, 'd', `M${f(x0)} ${f(baseY)}V${f(yt + r)}Q${f(x0)} ${f(yt)} ${f(x0 + r)} ${f(yt)}H${f(x1 - r)}Q${f(x1)} ${f(yt)} ${f(x1)} ${f(yt + r)}V${f(baseY)}`);
        set(b.olGap, 'opacity', ring);
      } else { set(b.ol, 'display', 'none'); set(b.olGap, 'display', 'none'); }
      if (pts) pts.push({ i: b.i, rel, x: x + w / 2, y: G.BASE - b.d.income * SCALE });
      // Labels.
      const lx = lerp(xc, b.xm, g);
      set(b.ml, 'x', lx);
      set(b.ml, 'y', lerp(G.LABEL_Y, G.MINI_LABEL_Y, g));
      const pill = pr > 0.5;
      const tone = u > 0.5 ? 'yc-month yc-month-sel' : pill ? 'yc-month yc-month-pill' : 'yc-month';
      set(b.ml, 'class', tone);
      const size = labelSize(ar, R, g, p);
      setStyle(b.ml, 'fontSize', `${Math.round(size * 10) / 10}px`);
      const txt = monthLabel(b.short, tp.spacing(ar), g);
      if (b.mlT !== txt) { b.mlT = txt; b.ml.textContent = txt; }
      set(b.ml, 'opacity', lerp(edge, 1, g));
      if (pr > 0.01) {
        const pw = Math.max(26, size * 2.9);
        set(b.pill, 'display', 'inline');
        set(b.pill, 'x', lx - pw / 2); set(b.pill, 'width', pw); set(b.pill, 'y', G.LABEL_Y - 11.5);
        set(b.pill, 'opacity', pr);
      } else set(b.pill, 'display', 'none');
      if (b.yl) {
        set(b.yl, 'x', lerp(xc, b.xm, g)); set(b.yl, 'y', lerp(G.YEAR_Y, G.MINI_YEAR_Y, g));
        set(b.yl, 'class', `${pill ? 'yc-month yc-month-centre' : tone} yc-year`);
        setStyle(b.yl, 'fontSize', `${Math.round(size * 8.8) / 10}px`);
        set(b.yl, 'opacity', lerp(edge, 1, g) * 0.85);
      }
      const lo = clamp((u - 0.55) / 0.45, 0, 1);
      if (lo > 0.005) {
        set(b.lab, 'display', 'inline'); set(b.lab, 'opacity', lo);
        set(b.labT, 'display', showT ? 'inline' : 'none'); set(b.labC, 'display', showC ? 'inline' : 'none');
        set(b.labT, 'opacity', 1 - mx); set(b.labC, 'opacity', mx);
      } else set(b.lab, 'display', 'none');
    }
    if (pts) {
      // Join neighbouring months only; never across the loop seam.
      pts.sort((a, b2) => a.rel - b2.rel);
      let d = '';
      for (let k = 0; k < pts.length; k++) {
        const q = pts[k];
        const prev = pts[k - 1];
        const joined = prev && Math.abs(q.rel - prev.rel - 1) < 0.01 && q.i === (prev.i + 1) % n && q.i !== 0;
        d += `${joined ? 'L' : 'M'}${Math.round(q.x * 10) / 10} ${Math.round(q.y * 10) / 10}`;
      }
      set(incomePath, 'd', d);
    }
  }

  function setActive(i) {
    for (const b of bars) set(b.hit, 'aria-selected', b.i === i ? 'true' : 'false');
    svg.setAttribute('aria-activedescendant', `${uid}-${i}`);
  }
  function announce(text) { live.textContent = text; }
  function detailText(b) {
    const d = b.d;
    const segs = stack === 'category' ? b.segs.C : b.segs.T;
    const rows = segs.slice().reverse().map((s) => (s.names
      ? t('chart.focus.rowNames', { name: s.name, amount: money(s.amount), names: s.names })
      : t('chart.focus.row', { name: s.name, amount: money(s.amount) })));
    return t('chart.focus.label', {
      month: monthTitle(d), amount: money(d.total), delta: deltaText(d.total).inline,
      rows: rows.length ? t('chart.focus.rows', { rows: rows.join(t('chart.focus.rowSep')) }) : t('chart.focus.nothingDue'),
    });
  }

  /* Loop -------------------------------------------------------------------- */
  function snapTo(target) {
    posS.x = pos; posS.v = posV; posS.t = target != null ? target : Math.round(pos);
    posV = 0; mode = 'snap';
  }
  function frame(ts) {
    const t0 = performance.now();
    const dt = Math.min(0.033, (ts - last) / 1000 || 0.016);
    last = ts;
    let busy = dragging;
    if (mode === 'fling') {
      pos += posV * dt;
      posV = flingStep(posV, dt);
      if (Math.abs(posV) < FLING_STOP) snapTo();
      busy = true;
    } else if (mode === 'snap') {
      springStep(posS, dt);
      pos = posS.x;
      busy = true;
      if (springSettle(posS)) { pos = posS.t; mode = 'idle'; }
    }
    for (const sp of [avgS, mix, gS]) { springStep(sp, dt); if (moving(sp)) busy = true; }
    for (const b of bars) {
      springStep(b.g, dt); if (moving(b.g)) busy = true;
      springStep(b.s, dt); if (moving(b.s)) busy = true;
    }
    render();
    if (!busy) settled();
    raf = busy ? requestAnimationFrame(frame) : 0;
    const cost = performance.now() - t0;
    perf.frames++; perf.total += cost; perf.max = Math.max(perf.max, cost);
    if (perf.samples.length < 600) perf.samples.push(cost);
  }
  function kick() {
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  function settled() {
    // Keep pos small so it never drifts far over many laps.
    pos = ((pos % n) + n) % n;
    const c = centreIndex(pos, n);
    if (!focus && c !== announced) {
      announced = c;
      const bd = bars[c].d;
      announce(t(c === nowIdx ? 'chart.announce.now' : 'chart.announce', { month: monthTitle(bd), amount: money(bd.total), delta: deltaText(bd.total).inline }));
    }
    opts.onSettle?.(pos);
  }

  /* Focus ------------------------------------------------------------------- */
  // Focus mode is an overlay for Android Back (js/overlays.js): Back does what All months does.
  // Out of sight on another tab it's skipped, and destroy() takes it off the stack.
  const overlays = opts.overlays;
  let destroyed = false;
  const leaveFocus = () => { close(); svg.focus({ preventScroll: true }); };
  function open(i) {
    sel = i; focus = true;
    overlays?.open('year-focus', {
      close: leaveFocus,
      isOpen: () => focus && !destroyed,
      isShown: () => host.isConnected && !host.closest('[hidden]'),
    });
    for (const b of bars) {
      b.g.w = W(staggerOmega(wrapRel(b.i, i, n))); b.g.t = 1;
      b.s.w = W(FOCUS_OMEGA); b.s.t = b.i === i ? 1 : 0;
    }
    avgS.t = 0; gS.t = 1;
    setActive(i);
    announce(detailText(bars[i]));
    snapTo(nearestPos(pos, i, n));
    kick();
  }
  function select(i) {
    sel = i;
    for (const b of bars) { b.s.w = W(13); b.s.t = b.i === i ? 1 : 0; }
    setActive(i);
    announce(detailText(bars[i]));
    snapTo(nearestPos(pos, i, n));
    kick();
  }
  function close() {
    overlays?.remove('year-focus');
    if (!focus) return;
    focus = false;
    for (const b of bars) { b.g.w = W(staggerOmega(wrapRel(b.i, sel, n), 16, 8)); b.g.t = 0; }
    avgS.t = 1; gS.t = 0;
    announced = -1;
    setActive(centreIndex(pos, n));
    kick();
  }
  function act(i) {
    if (i == null) { if (focus) close(); return; }
    if (!focus) open(i);
    else if (i === sel) close();
    else select(i);
  }
  const tapAct = (target) => {
    const h = target?.closest ? target.closest('[data-i]') : null;
    act(h ? Number(h.getAttribute('data-i')) : null);
  };

  /* Input ------------------------------------------------------------------- */
  const onDown = (e) => {
    try { svg.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    down = { x: e.clientX, y: e.clientY, lx: e.clientX, lt: performance.now(), v: 0, moved: false, t: e.target };
    if (!focus && (mode === 'fling' || mode === 'snap')) { mode = 'idle'; posV = 0; }
  };
  const onMove = (e) => {
    if (!down || focus) return;
    const adx = Math.abs(e.clientX - down.x);
    const ady = Math.abs(e.clientY - down.y);
    if (!down.moved) {
      if (adx < 6 || adx < ady) return;
      down.moved = true; dragging = true; mode = 'drag'; posV = 0;
    }
    const k = G.W / svg.getBoundingClientRect().width;
    const dpos = (-(e.clientX - down.lx) * k) / G.DRAG;
    pos += dpos;
    const now = performance.now();
    down.v = dragVelocity(down.v, dpos, now - down.lt);
    down.lx = e.clientX; down.lt = now;
    kick();
  };
  const onUp = (e) => {
    if (!down) return;
    const d = down;
    down = null;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (focus) {
      if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy)) { select((sel + (dx < 0 ? 1 : -1) + n) % n); return; }
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) tapAct(d.t);
      return;
    }
    if (d.moved) {
      dragging = false;
      posV = releaseVelocity(d.v, performance.now() - d.lt, reduced);
      if (Math.abs(posV) < FLING_STOP) snapTo(); else mode = 'fling';
      kick();
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      tapAct(d.t);
    }
  };
  const onCancel = () => {
    if (down?.moved) { dragging = false; snapTo(); kick(); }
    down = null;
  };
  const onKey = (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (focus) select((sel + dir + n) % n);
      else { snapTo(Math.round(pos) + dir); kick(); }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      act(focus ? sel : centreIndex(pos, n));
    } else if (e.key === 'Escape' && focus) {
      e.preventDefault();
      close();
    }
  };
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onCancel);
  svg.addEventListener('keydown', onKey);
  back.addEventListener('click', leaveFocus);
  nowBtn.addEventListener('click', () => { snapTo(nearestPos(pos, nowIdx, n)); kick(); });

  fillLegend(stack);
  render();
  setActive(centreIndex(pos, n));
  if (opts.fadeIn && !reduced) {
    stage.classList.add('yc-fade');
    requestAnimationFrame(() => stage.classList.remove('yc-fade'));
  }

  const api = {
    setStack(kind) {
      stack = kind === 'category' ? 'category' : 'type';
      mix.t = stack === 'category' ? 1 : 0;
      fillLegend(stack);
      if (focus) announce(detailText(bars[sel]));
      kick();
    },
    destroy() {
      destroyed = true;
      overlays?.remove('year-focus');
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      host.yearChart = null;
    },
    state: () => ({
      pos, centre: centreIndex(pos, n), focus, selected: sel, mode, stack, animating: !!raf,
      nowVisible: !focus, nowFaded: !focus && centreIndex(pos, n) === nowIdx, scale: scaleInfo,
    }),
    stats: () => {
      const s = perf.samples.slice().sort((a, b) => a - b);
      return {
        frames: perf.frames, avgMs: perf.frames ? perf.total / perf.frames : 0, maxMs: perf.max,
        p95Ms: s.length ? s[Math.floor(s.length * 0.95)] : 0,
      };
    },
    resetStats: () => { perf.frames = 0; perf.total = 0; perf.max = 0; perf.samples = []; },
  };
  host.yearChart = api;
  return api;
}
