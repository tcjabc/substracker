// The Money tab's Wallet view: the pure parts (no DOM, no storage), shared by js/wallet.js and the
// Node tests. Group totals on the Money strip's cash basis, the 15-colour palette and its automatic
// assignment, the automatic text colour with its contrast fitting, and the stack's geometry and
// fling maths. See js/wallet.js for the view itself.

import { dueInMonth, incomeInMonth, groupOf, byGroupName } from './insights-calc.js';
import { isIncome } from './util.js';

/* Palette --------------------------------------------------------------------------------------
   Fifteen fills in stack order (keys w1 … w15, CSS --wallet-1 … --wallet-15 in app.css). Hue and
   lightness alternate so neighbours, cards two apart and the wrap from 15 to 1 never look alike,
   also under protan/deutan simulation (adjacent OKLab ΔE ≥ 33 light, ≥ 25 dark). Teal, red, blue,
   violet, forest and magenta sit 5% OKLCH lightness darker in light mode so their white text has
   room for the top-light and sheen. tests/wallet-math.node.test.js checks these match app.css. */
export const WALLET_NAMES = ['Teal', 'Mint', 'Red', 'Blue', 'Lilac', 'Navy', 'Orange', 'Violet', 'Sky', 'Forest', 'Lime', 'Magenta', 'Pink', 'Brown', 'Yellow'];
export const WALLET_LIGHT = ['#057274', '#95e4c6', '#c2181d', '#1a51bd', '#cdaef2', '#1d2e65', '#f58028', '#7a38bf', '#70c7ed', '#09672e', '#9cd242', '#b30a7b', '#f5acc2', '#7f4d30', '#f6d236'];
export const WALLET_DARK = ['#017073', '#7fc7ab', '#b92524', '#2153b5', '#b296d3', '#2c407f', '#d66e1c', '#773db6', '#5eadcf', '#186632', '#86b734', '#ac1d77', '#d694a8', '#6e4127', '#d7b626'];
export const WALLET_KEYS = WALLET_NAMES.map((_, i) => `w${i + 1}`);
export const isWalletKey = (k) => typeof k === 'string' && /^w([1-9]|1[0-5])$/.test(k);

/**
 * Automatic group colours for the groups in stack order (`names`). `map` is name → swatch key as
 * the app has it now; `picked` the names whose colour someone chose (left exactly as they are).
 * Every other group keeps its wallet colour unless that equals its previous neighbour's; one
 * without a wallet colour (new, or an automatic pick from the old ten) takes the least-used
 * wallet slot, not used by either neighbour, in slot order. So up to 15 groups get 15 different
 * colours in slot order, more than 15 cycle, and no two neighbours are ever equal through an
 * automatic pick. Returns the patch of names whose colour changed.
 */
export function assignAutoColours(names, map, picked, keys = WALLET_KEYS) {
  const out = { ...map };
  const patch = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (picked.has(name)) continue;
    const prev = i > 0 ? out[names[i - 1]] : null;
    const next = i + 1 < names.length ? out[names[i + 1]] : null;
    if (keys.includes(out[name]) && out[name] !== prev) continue;
    const uses = new Map(keys.map((k) => [k, 0]));
    names.forEach((n, j) => { if (j !== i && uses.has(out[n])) uses.set(out[n], uses.get(out[n]) + 1); });
    const free = keys.filter((k) => k !== prev && k !== next);
    const pick = (free.length ? free : keys).reduce((best, k) => (uses.get(k) < uses.get(best) ? k : best));
    out[name] = pick;
    patch[name] = pick;
  }
  return patch;
}

/* Colour and contrast ------------------------------------------------------------------------- */
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/** '#rrggbb' (or 'rgb(r, g, b)') → [r, g, b] 0–255; null if it can't be read. */
export function parseColour(s) {
  const t = String(s ?? '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(t);
  return m ? [m[1], m[2], m[3]].map((v) => Math.round(Number(v))) : null;
}
export const hexOf = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
export const luminance = (rgb) => { const [r, g, b] = rgb.map((v) => lin(v / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG contrast ratio of two [r, g, b] colours. */
export const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** `a` over `b` at opacity `t` (0–1). */
export const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));

function toOk(rgb) {
  const [r, g, b] = rgb.map((v) => lin(v / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOk([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
    .map((v) => Math.round(clamp(gam(clamp(v, 0, 1)), 0, 1) * 255));
}
/** The colour `d` lighter (or darker, d < 0) in OKLCH lightness, hue kept; chroma pulled in if it leaves sRGB. */
export function shiftL(rgb, d) {
  const [L, a, b] = toOk(rgb);
  const t = clamp(L + d, 0, 1);
  for (let k = 1; k >= 0; k -= 0.05) {
    const o = fromOk([t, a * k, b * k]);
    if (Math.abs(toOk(o)[0] - t) < 0.004) return o;
  }
  return fromOk([t, 0, 0]);
}

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
/** The text colours a card may use: the app's ink and white, then pure black as a last resort. */
export const INK_DARK = [22, 23, 29]; // #16171d, the light theme's --text
export const INK_LIGHT = WHITE;
/** Depth amounts: the largest lightness shift of the gradient, the sheen's peak white, the cast shadow where band text sits. */
export const DEPTH = Object.freeze({ shift: 0.07, sheenLight: 0.07, sheenDark: 0.05, castAtText: 0.05 });
const TARGET = 4.52; // fit to a little over 4.5:1

/**
 * Text colour and depth for one card fill (`fill` [r, g, b]). The gradient (top `+dt`, bottom
 * `−db` lightness) and the sheen (`sh`) shrink, bottom first, then top, then sheen, until the text
 * keeps 4.5:1 at the lightest point (gradient top under the sheen's peak) and the darkest (gradient
 * bottom under the cast shadow). The flat pick (#16171d or white, whichever is stronger) goes first;
 * if it still can't pass, the other ink, then pure black. Secondary text blends the text towards
 * the fill only as far as 4.5:1 allows everywhere. With depth off the fill is flat (dt = db = sh = 0).
 * Returns { ink, ink2, top, bot, dt, db, sh, ratio, ratio2 } (colours as [r, g, b], ratios the lowest).
 */
export function fitCard(fill, { depth = true, sheen = DEPTH.sheenLight } = {}) {
  const flatDark = contrast(INK_DARK, fill), flatLight = contrast(INK_LIGHT, fill);
  const first = flatLight > flatDark ? INK_LIGHT : INK_DARK;
  const tries = [first, first === INK_LIGHT ? INK_DARK : INK_LIGHT, BLACK];
  let best = null;
  for (const ink of tries) {
    const r = fitWith(fill, ink, depth ? DEPTH.shift : 0, depth ? sheen : 0, depth ? DEPTH.castAtText : 0);
    if (r.ratio >= 4.5 && r.ratio2 >= 4.5) return r;
    if (!best || r.ratio > best.ratio) best = r;
  }
  return best;
}
function fitWith(fill, ink, D, SH, cast) {
  const ok = (c) => contrast(ink, c) >= TARGET;
  const lo = (dt, sh) => mix(WHITE, shiftL(fill, dt), sh);
  const hi = (db) => mix(BLACK, shiftL(fill, -db), cast);
  const step = (x) => Math.max(0, Math.round((x - 0.005) * 1000) / 1000);
  let dt = D, db = D, sh = SH;
  while (db > 0 && !ok(hi(db))) db = step(db);
  while (dt > 0 && !ok(lo(dt, sh))) dt = step(dt);
  while (sh > 0 && !ok(lo(dt, sh))) sh = step(sh);
  const L = lo(dt, sh), Hd = hi(db);
  let ink2 = ink;
  for (const t of [0.74, 0.8, 0.86, 0.92]) {
    const c = mix(ink, fill, t);
    if (contrast(c, L) >= 4.5 && contrast(c, Hd) >= 4.5) { ink2 = c; break; }
  }
  return {
    ink, ink2, top: shiftL(fill, dt), bot: shiftL(fill, -db), dt, db, sh,
    ratio: Math.min(contrast(ink, L), contrast(ink, Hd)), ratio2: Math.min(contrast(ink2, L), contrast(ink2, Hd)),
  };
}

/* Groups and totals ---------------------------------------------------------------------------- */
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** What `s` moves in the strip's period: this month's cash, or the sum of the year's twelve cash months. */
export function periodCash(s, period, year, month) {
  const f = isIncome(s) ? incomeInMonth : dueInMonth;
  if (period !== 'annual') return f(s, year, month);
  let t = 0;
  for (let m = 0; m < 12; m++) t += f(s, year, m);
  return t;
}

/**
 * The wallet's cards, in stack order: Income first (when there is any), then the expense groups as
 * the Money tab groups them (category or Uncategorised, A–Z with Uncategorised last). Each card:
 * { key, name, income, items (A–Z), total, others: [{ currency, count }], ranked }. `total` is the
 * cash in the default `currency` for the period, the same basis as the Money strip (so the
 * expense totals add up to its Outgoings and the Income card to its Income; undated items count
 * nowhere). `others` counts the items in other currencies that move cash in the period ("+1 in
 * USD"); they're never converted or added. `ranked` is the items by period cash (default currency
 * first), then price, then name: the front preview and the logo chip use it.
 */
export function walletGroups(items, { currency, period, year, month }) {
  const groups = [];
  const income = items.filter(isIncome);
  const cats = new Map();
  for (const s of items) {
    if (isIncome(s)) continue;
    const k = groupOf(s);
    if (!cats.has(k)) cats.set(k, []);
    cats.get(k).push(s);
  }
  const card = (key, name, list, isInc) => {
    const sorted = list.slice().sort(byName);
    let total = 0;
    const others = new Map();
    const cash = new Map();
    for (const s of sorted) {
      const c = periodCash(s, period, year, month);
      cash.set(s, c);
      if (s.currency === currency) total += c;
      else if (c > 0) others.set(s.currency, (others.get(s.currency) || 0) + 1);
    }
    const ranked = sorted.slice().sort((a, b) =>
      (b.currency === currency) - (a.currency === currency) || cash.get(b) - cash.get(a) || (b.price || 0) - (a.price || 0) || byName(a, b));
    return {
      key, name, income: isInc, items: sorted, total, ranked,
      cash: (s) => cash.get(s) ?? 0,
      others: [...others.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([cur, count]) => ({ currency: cur, count })),
    };
  };
  if (income.length) groups.push(card('income', 'Income', income, true));
  [...cats.keys()].sort(byGroupName).forEach((k) => groups.push(card(`g:${k}`, k, cats.get(k), false)));
  return groups;
}

/* Group order ---------------------------------------------------------------------------------- */
/** The Money tab's group orders (Sort, per device). 'az' is the order the tab always had, and the default. */
export const GROUP_SORTS = Object.freeze(['az', 'total', 'items']);
/** The order from the saved preference: a saved Total or Items is kept, else A–Z. */
export const groupSortFrom = (pref) => (pref === 'total' || pref === 'items' ? pref : 'az');

/**
 * `groups` (walletGroups' cards, or anything with { name, income, items, total }) in the order
 * `sort` asks for; Income stays first whatever the order. Only the groups move: their items and
 * their colours stay as they are (colours follow the group, see app.js ensureGroupColors).
 *   'az'     A–Z with Uncategorised last: walletGroups' own order, unchanged.
 *   'total'  the period's cash in `currency` (the strip's basis), high to low. A group whose items
 *            are all in other currencies has no total to compare, so those come after the rest,
 *            most items first. A group with nothing due this period counts as 0.
 *   'items'  number of items, high to low.
 * Ties break A–Z (Uncategorised last). Returns a new array; `groups` isn't changed.
 */
export function sortGroups(groups, sort, currency) {
  const mode = groupSortFrom(sort);
  const income = groups.filter((g) => g.income);
  const rest = groups.filter((g) => !g.income);
  if (mode === 'az') return [...income, ...rest.slice().sort((a, b) => byGroupName(a.name, b.name))];
  const count = (g) => g.items?.length ?? 0;
  const foreignOnly = (g) => count(g) > 0 && g.items.every((s) => s.currency !== currency);
  const cmp = mode === 'items'
    ? (a, b) => count(b) - count(a)
    : (a, b) => foreignOnly(a) - foreignOnly(b) || (foreignOnly(a) ? count(b) - count(a) : (b.total || 0) - (a.total || 0));
  return [...income, ...rest.slice().sort((a, b) => cmp(a, b) || byGroupName(a.name, b.name))];
}

/** "+1 in USD", "+2 in USD · +1 in JPY", or ''. */
export const othersText = (others) => others.map((o) => `+${o.count} in ${o.currency}`).join(' · ');

/* Stack geometry and motion --------------------------------------------------------------------- */
/** Band height, front-card reveal, room for the pile above the front card (px). */
export const GEOM = Object.freeze({ band: 64, reveal: 88, peek: 30, pile: 30, lip: 24 });
export const collapsedHeight = (g = GEOM) => g.band + g.reveal + g.lip;
/**
 * Motion constants. The snap and open springs are critically damped (js/tab-pill.js springStep),
 * so they never overshoot: open/close reaches 95% in about 280 ms and 99% in about 390 ms.
 */
export const MOTION = Object.freeze({
  snapOmega: 15, openOmega: 17, tau: 0.33, dragPx: 7, rubber: 2, maxVelocity: 60,
  sampleMs: 90, idleMs: 60, coastHandoverPx: 2, restPx: 0.3, restSpeedPx: 6, openRestPx: 0.4, openRestSpeedPx: 8,
});

/**
 * Where a card sits for stack offset d = index − scroll position: at or below the front slot the
 * bands follow each other (the front card shows its reveal too); passed cards go into the pile
 * above it, compressed, tilted back around their top edge and fading out. { y, s, rx, o }.
 */
export function cardPose(d, g = GEOM) {
  if (d >= 0) return { y: g.peek + d * g.band + g.reveal * Math.min(d, 1), s: 1, rx: 0, o: 1 };
  const t = -d;
  return {
    y: g.peek - g.pile * (1 - Math.exp(-0.42 * t)),
    s: 1 - 0.05 * Math.min(t, 4),
    rx: -10 * Math.min(t, 1.5),
    o: clamp(1 - (t - 2.2) / 1.4, 0, 1),
  };
}

/** The part of a card face that carries text: its band and the preview rows (the rest is an empty lip). */
export const faceText = (g = GEOM) => g.band + g.reveal - 12;

/**
 * The furthest scroll position: the first at which the last card's text (faceText) is in view
 * above `inset` px at the bottom of a stack `height` px tall, where the floating buttons sit
 * (0 when everything fits). Its empty lip may pass under them.
 */
export function maxScroll(n, height, inset = 0, g = GEOM) {
  if (n <= 1) return 0;
  const room = height - inset - 8 - g.peek - g.reveal - faceText(g);
  return clamp(Math.ceil(n - 1 - room / g.band), 0, n - 1);
}

/** A drag past either end: resistance that never goes further than MOTION.rubber cards. */
export function rubberBand(raw, max) {
  const rb = (x) => (1 - 1 / ((x * 0.55) / MOTION.rubber + 1)) * MOTION.rubber;
  return raw < 0 ? -rb(-raw) : raw > max ? max + rb(raw - max) : raw;
}

/**
 * What a release at position `f` with velocity `v` (cards/s) does: { mode: 'spring', target } or
 * { mode: 'coast', target, tau }. A fling projects its landing (v × tau) onto the nearest band and
 * glides there exponentially, so it lands exactly; slow releases, releases past an end and flings
 * into an end use the snap spring with the release velocity.
 */
export function releasePlan(f, v, max) {
  const cl = (x) => clamp(x, 0, max);
  if (f < 0 || f > max || Math.abs(v) < 0.6) return { mode: 'spring', target: cl(Math.round(f)) };
  const target = Math.round(f + v * MOTION.tau);
  if (cl(target) !== target) return { mode: 'spring', target: cl(target) };
  const tau = (target - f) / v;
  if (tau < 0.08 || tau > 0.7) return { mode: 'spring', target };
  return { mode: 'coast', target, tau };
}

/** Release velocity from recent [timeStamp, position] samples: 0 if the pointer stopped before letting go. */
export function sampleVelocity(samples, upTime) {
  if (!samples.length) return 0;
  const last = samples[samples.length - 1];
  if (upTime - last[0] >= MOTION.idleMs) return 0;
  let k = 0;
  while (k < samples.length - 2 && last[0] - samples[k][0] > MOTION.sampleMs) k++;
  const dt = (last[0] - samples[k][0]) / 1000;
  return dt > 0.008 ? clamp((last[1] - samples[k][1]) / dt, -MOTION.maxVelocity, MOTION.maxVelocity) : 0;
}
