// The pill behind the active bottom-nav tab. When the tab changes it slides over with a liquid
// stretch: its leading edge springs quickly towards the new tab and its trailing edge follows on a
// slower spring, so the pill stretches on the way and settles back to its normal width. Both edges
// are critically damped springs, so they never overshoot from rest, and the slower one settles in
// about 300 ms. With "Reduce motion and effects" the pill moves straight to the tab, with no
// stretch and no spring. The pill is decoration only (aria-hidden, no pointer events): tab
// semantics, focus and keyboard behaviour stay with the tab buttons. The pure parts at the top are
// covered by Node tests.

/** Spring rates (1/s): the leading edge's and the trailing edge's. Higher is faster. */
export const PILL_SPRINGS = { lead: 42, trail: 26 };
/** An edge counts as settled within this distance (px) and below this speed (px/s). */
export const PILL_REST = { distance: 0.5, speed: 8 };
/** The longest step one frame may take (s), so a frame after a stall doesn't jump. */
const MAX_STEP = 1 / 30;

/**
 * One step of a critically damped spring, exact for any `dt` (so the motion doesn't depend on the
 * frame rate): position `x` and velocity `v` towards `target`, at rate `omega`, after `dt` seconds.
 */
export function springStep(x, v, target, omega, dt) {
  const e = x - target;
  const k = v + omega * e;
  const decay = Math.exp(-omega * dt);
  return [target + (e + k * dt) * decay, (v - omega * k * dt) * decay];
}

/** Whether an edge at `x` moving at `v` has settled on `target`. */
export const edgeSettled = (x, v, target) => Math.abs(x - target) < PILL_REST.distance && Math.abs(v) < PILL_REST.speed;

/**
 * The spring rates for the left and right edges when moving from `from` to `to` ({ left, right }
 * in px): the edge on the side the pill is moving towards leads.
 */
export function edgeRates(from, to) {
  const right = (to.left + to.right) / 2 >= (from.left + from.right) / 2;
  return right ? { left: PILL_SPRINGS.trail, right: PILL_SPRINGS.lead } : { left: PILL_SPRINGS.lead, right: PILL_SPRINGS.trail };
}

/**
 * The whole move from `from` to `to` sampled every `dt` seconds until both edges settle (or
 * `limit` seconds pass): [{ t, left, right }]. Used by the tests; the pill itself steps per frame.
 */
export function pillPath(from, to, { dt = 1 / 60, limit = 2 } = {}) {
  const rates = edgeRates(from, to);
  let [l, vl, r, vr] = [from.left, 0, from.right, 0];
  const path = [{ t: 0, left: l, right: r }];
  for (let t = dt; t <= limit + 1e-9; t += dt) {
    [l, vl] = springStep(l, vl, to.left, rates.left, dt);
    [r, vr] = springStep(r, vr, to.right, rates.right, dt);
    path.push({ t, left: l, right: r });
    if (edgeSettled(l, vl, to.left) && edgeSettled(r, vr, to.right)) break;
  }
  return path;
}

/**
 * Put a pill in `bar` (the tab list) and return { moveTo(tab), snap(tab), stop() }. `moveTo` slides
 * to the tab (or jumps there with reduced motion, or the first time); `snap` jumps. The pill
 * follows the bar's size (resize, orientation, safe-area changes) by snapping to the active tab.
 * Its resting width is --tab-pill-w in app.css, or the tab's width when that is narrower.
 */
export function createTabPill(bar, { reduceMotion = () => false } = {}) {
  const pill = document.createElement('span');
  pill.className = 'tab-pill';
  pill.setAttribute('aria-hidden', 'true');
  bar.prepend(pill);

  let active = null;
  let pos = null; // { left, right } now, in px from the bar's left edge
  let vel = { left: 0, right: 0 };
  let goal = null;
  let rates = null;
  let frame = 0;
  let last = 0;

  const restWidth = () => parseFloat(getComputedStyle(pill).getPropertyValue('--tab-pill-w')) || Infinity;
  const place = (tab) => {
    const w = Math.min(restWidth(), tab.offsetWidth);
    const left = tab.offsetLeft + (tab.offsetWidth - w) / 2;
    return { left, right: left + w };
  };
  const draw = () => {
    pill.style.transform = `translateX(${pos.left.toFixed(2)}px)`;
    pill.style.width = `${(pos.right - pos.left).toFixed(2)}px`;
  };
  const stop = () => { cancelAnimationFrame(frame); frame = 0; };

  function snap(tab = active) {
    if (!tab) return;
    stop();
    active = tab;
    pos = place(tab);
    vel = { left: 0, right: 0 };
    goal = null;
    draw();
  }

  function tick(now) {
    const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_STEP);
    last = now;
    [pos.left, vel.left] = springStep(pos.left, vel.left, goal.left, rates.left, dt);
    [pos.right, vel.right] = springStep(pos.right, vel.right, goal.right, rates.right, dt);
    if (edgeSettled(pos.left, vel.left, goal.left) && edgeSettled(pos.right, vel.right, goal.right)) {
      snap(active); // land exactly on the tab
      return;
    }
    draw();
    frame = requestAnimationFrame(tick);
  }

  function moveTo(tab) {
    if (!tab) return;
    if (!pos || reduceMotion() || document.hidden || !bar.offsetWidth) { snap(tab); return; }
    active = tab;
    goal = place(tab);
    rates = edgeRates(pos, goal); // from where the pill is now, so a second tap mid-move turns smoothly
    if (!frame) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }

  // The bar changes size with the window, the orientation and the safe-area insets: keep the pill
  // on the active tab without animating.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => snap()).observe(bar);
  else addEventListener('resize', () => snap());

  return { moveTo, snap, stop, get element() { return pill; } };
}
