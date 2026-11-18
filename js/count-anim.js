// Rolling totals: the Money strip's figures and the Wallet cards' totals roll to a new value digit
// by digit, like an odometer. Only those two places use it.
//
// The real text (money()'s, from the app's one formatter) stays in the element the whole time,
// made transparent while the roll plays over it, so the box never changes size, its text content
// is always the final value and screen readers read that, once. The rolling digits are
// aria-hidden and drawn with CSS generated content, so they aren't text at all. Each digit is a
// column one figure wide (tabular figures) whose strip of digits slides with a transform, played
// with the Web Animations API (on the compositor; no frame loop here). When the roll finishes, the
// element holds plain text again.
//
// When it plays (createRoller): the first time a total is shown (from 0); when it changes while
// shown (from the old value); and after replay() (the Money tab coming to the front, or the app
// coming back), from the value shown before if it changed meanwhile, else from 0. A redraw with
// the same number doesn't play. Never with "Reduce motion and effects": the text just changes.
//
// The pure parts (rollPlan, rollFrom) have no DOM and are covered by tests/count-anim.node.test.js.

/** Most digit steps one column travels: one full turn plus the distance to its digit. */
export const MAX_STEPS = 19;
const BLANK = ' ';

/**
 * Split formatter parts into what the roll needs: the integer and fraction digits (as 0–9, through
 * `glyphs`, the formatter's own digits 0…9, so other numbering systems work), and the template.
 */
function digitsOf(parts, glyphs) {
  const val = (ch) => { const i = glyphs.indexOf(ch); return i >= 0 ? i : Number.isNaN(Number(ch)) ? -1 : Number(ch); };
  let int = [], frac = [];
  for (const p of parts) {
    if (p.type === 'integer') int = int.concat([...p.value].map(val).filter((d) => d >= 0));
    else if (p.type === 'fraction') frac = frac.concat([...p.value].map(val).filter((d) => d >= 0));
  }
  return { int, frac };
}
const num = (ds) => ds.reduce((n, d) => n * 10 + d, 0);

/**
 * The roll from the text of `fromParts` to the text of `toParts` (both from moneyParts, same
 * currency). `glyphs` is the formatter's digits for 0…9. Returns the segments to draw, in order:
 *   { t: 'lit', text, fade }       a symbol, separator or sign, exactly as the final text has it;
 *                                  `fade` for a group separator that has no digits to its left yet
 *   { t: 'dig', cells, from, to }  one digit column: `cells` top to bottom (' ' for blank),
 *                                  showing cells[from] at the start and cells[to] at the end
 * The layout is always the final value's, so nothing moves sideways. A column steps through the
 * digits between its start and end. On a big change (a tenth of the value or more) a column whose
 * value moved by ten or more steps also spins one full turn, so low columns spin while high ones
 * roll into place; never more than MAX_STEPS. A column the start value didn't reach starts blank.
 */
export function rollPlan(fromParts, toParts, glyphs) {
  const g = (d) => glyphs[d] ?? String(d);
  const A = digitsOf(fromParts, glyphs), B = digitsOf(toParts, glyphs);
  const magA = num(A.int) + num(A.frac) / 10 ** A.frac.length;
  const magB = num(B.int) + num(B.frac) / 10 ** B.frac.length;
  const up = magB >= magA;
  // A big change (a tenth of the value or more: from 0, Monthly to Annual) spins the low columns a
  // full turn, like a real odometer; a small one (an edit) moves only the digits that change.
  const big = Math.abs(magB - magA) >= 0.1 * Math.max(magA, magB);
  const column = (aDigit, bDigit, prefA, prefB, blank) => {
    const n = Math.abs(prefB - prefA);
    const turn = big && n >= 10 ? 10 : 0;
    if (!blank && aDigit === bDigit && !turn) return { t: 'dig', cells: [g(bDigit)], from: 0, to: 0 };
    if (blank) { // rolls in from blank: blank, 0, 1, … up to its digit (plus a turn)
      const steps = Math.min(MAX_STEPS, 1 + bDigit + turn);
      const cells = [BLANK];
      for (let k = 1; k <= steps; k++) cells.push(g((bDigit - (steps - k) + 100) % 10));
      return { t: 'dig', cells, from: 0, to: steps };
    }
    const dist = up ? (bDigit - aDigit + 10) % 10 : (aDigit - bDigit + 10) % 10;
    const steps = Math.min(MAX_STEPS, dist + turn);
    // Cells always run upward in value, like a real wheel: up starts at the top, down at the bottom.
    const low = up ? aDigit : bDigit;
    const cells = Array.from({ length: steps + 1 }, (_, k) => g((low + k) % 10));
    return up ? { t: 'dig', cells, from: 0, to: steps } : { t: 'dig', cells, from: steps, to: 0 };
  };
  const out = [];
  const nInt = B.int.length;
  let intSeen = 0, fracSeen = 0;
  // The integer digits of A, right-aligned under B's; prefixes are the value down to that column.
  const aInt = (p) => (p < A.int.length ? A.int[A.int.length - 1 - p] : null);
  const prefix = (ds, p) => num(ds.slice(0, Math.max(0, ds.length - p)));
  for (const part of toParts) {
    if (part.type === 'integer') {
      for (let j = 0; j < part.value.length; j++) {
        const p = nInt - 1 - intSeen; // place: 0 = units
        const a = aInt(p);
        out.push(column(a ?? 0, B.int[intSeen], prefix(A.int, p), prefix(B.int, p), a === null && p > 0));
        intSeen++;
      }
    } else if (part.type === 'fraction') {
      for (let j = 0; j < part.value.length; j++) {
        const k = fracSeen;
        const pre = (ds, fr) => num(ds) * 10 ** (k + 1) + num(fr.slice(0, k + 1).concat(Array(Math.max(0, k + 1 - fr.length)).fill(0)));
        out.push(column(A.frac[k] ?? 0, B.frac[k], pre(A.int, A.frac), pre(B.int, B.frac), false));
        fracSeen++;
      }
    } else {
      // A group separator whose left column starts blank has no digits beside it yet: it fades in.
      const left = out[out.length - 1];
      out.push({ t: 'lit', text: part.value, fade: part.type === 'group' && left?.t === 'dig' && left.cells[left.from] === BLANK });
    }
  }
  return out;
}

/**
 * Where a total should roll from, or null to just show it. `prev` is what this total showed last
 * ({ value, currency, gen }, or undefined the first time); `gen` the current replay generation.
 */
export function rollFrom(prev, value, currency, gen) {
  const changed = !prev || prev.value !== value || prev.currency !== currency;
  let from = null;
  if (!prev) from = 0;
  else if (prev.gen < gen) from = changed && prev.currency === currency ? prev.value : 0;
  else if (changed) from = prev.currency === currency ? prev.value : 0;
  return from === null || from === value ? null : from;
}

/** Steps a column travels, for its duration. */
const stepsOf = (seg) => Math.abs(seg.to - seg.from);

/**
 * The rolling totals. Options:
 *   reduced()             "Reduce motion and effects": never animate
 *   parts(value, cur)     the formatter's parts (util.js moneyParts)
 *   text(value, cur)      the formatter's text (util.js money)
 *   cap                   most totals rolling at once (others just show their value)
 * show(el, key, value, currency, { visible }) shows `value` in `el` (which already holds its final
 * text) and rolls it when the rules above say so and it's `visible`; `key` names the total across
 * redraws (the element may be a new one each time). With el null it only records the value (a
 * total shown as words, like "Nothing due"). replay() makes every total roll the next time it's
 * shown. stats() for tests: { started, running }.
 */
export function createRoller({ reduced, parts, text, cap = 10 }) {
  const last = new Map();
  const runs = new Map(); // key → { el, anims }
  const glyphCache = new Map();
  let gen = 0, running = 0, started = 0;

  const glyphsFor = (cur) => {
    if (!glyphCache.has(cur)) {
      const gl = [];
      for (let d = 0; d < 10; d++) gl.push(parts(d, cur).filter((p) => p.type === 'integer').map((p) => p.value).join('') || String(d));
      glyphCache.set(cur, gl);
    }
    return glyphCache.get(cur);
  };
  // Stop a total's roll now (it's drawn again): its place under the cap is free straight away.
  const stop = (key) => {
    const r = runs.get(key);
    if (!r) return;
    r.finish();
    for (const a of r.anims) a.cancel();
  };

  function roll(el, key, from, value, cur) {
    const finalText = text(value, cur);
    const plan = rollPlan(parts(from, cur), parts(value, cur), glyphsFor(cur));
    const wrap = document.createElement('span');
    wrap.className = 'odo';
    const txt = document.createElement('span');
    txt.className = 'odo-txt';
    txt.textContent = finalText;
    const strip = document.createElement('span');
    strip.className = 'odo-roll';
    strip.setAttribute('aria-hidden', 'true');
    const zero = glyphsFor(cur)[0];
    const anims = [];
    const longest = Math.max(1, ...plan.filter((s) => s.t === 'dig').map(stepsOf));
    const duration = 650 + 22 * longest;
    for (const seg of plan) {
      if (seg.t === 'lit') {
        const l = document.createElement('span');
        l.className = 'odo-l';
        l.dataset.t = seg.text;
        strip.append(l);
        if (seg.fade) anims.push([l, [{ opacity: 0 }, { opacity: 1 }], { duration: duration * 0.5, delay: duration * 0.25, easing: 'ease-out', fill: 'backwards' }]);
        continue;
      }
      const c = document.createElement('span');
      c.className = 'odo-c';
      c.dataset.z = zero;
      const s = document.createElement('span');
      s.className = 'odo-s';
      s.dataset.s = seg.cells.join('\n');
      const at = (i) => `translateY(${((-100 * i) / seg.cells.length).toFixed(4)}%)`;
      s.style.transform = at(seg.to);
      c.append(s);
      strip.append(c);
      if (seg.from !== seg.to) anims.push([s, [{ transform: at(seg.from) }, { transform: at(seg.to) }], { duration, easing: 'cubic-bezier(0.22, 0.8, 0.28, 1)' }]);
    }
    if (!anims.length) return false;
    wrap.append(txt, strip);
    el.textContent = '';
    el.append(wrap);
    const live = anims.map(([node, kf, o]) => node.animate(kf, o));
    running++; started++;
    let done = false;
    const run = {
      anims: live,
      finish() {
        if (done) return;
        done = true;
        running--;
        if (runs.get(key) === run) runs.delete(key);
        if (wrap.parentNode === el) el.textContent = finalText; // plain text again
      },
    };
    runs.set(key, run);
    Promise.all(live.map((a) => a.finished)).then(run.finish, run.finish);
    return true;
  }

  return {
    show(el, key, value, currency, { visible = true } = {}) {
      const prev = last.get(key);
      last.set(key, { value, currency, gen });
      const from = rollFrom(prev, value, currency, gen);
      if (!el) { stop(key); return false; }
      stop(key);
      if (from === null || !visible || reduced() || running >= cap || typeof el.animate !== 'function') return false;
      return roll(el, key, from, value, currency);
    },
    replay() { gen++; },
    stats: () => ({ started, running }),
  };
}
