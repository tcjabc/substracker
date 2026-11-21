// Swipe between the bottom tabs: a mostly sideways swipe on a page goes to the next tab (a swipe to
// the left) or the previous one (to the right), in the tab bar's order, when the finger lifts. A
// shortcut only: the tab bar, its roles and its keys are unchanged, and the switch goes through the
// app's own tab change (js/app.js setTab), so the pill, Android Back and the rolling totals behave
// exactly as for a tap on a tab. No wrap-around, no page following the finger, no new animation.
//
// Never from: an open overlay (js/overlays.js), a second finger (it cancels the swipe), a form
// control, a region marked data-no-page-swipe (the Ring and flat donut, the year chart, the Wallet
// stack, the Calendar grid and the currency chips: each has its own drag or scroll), or a strip
// at either side of the screen (the phone's own Back gesture). The check is where the touch STARTS.
// Touch events, passive, never preventDefault: scrolling is never held up, and a scroll the browser
// takes over still ends with touchend (pointer events would end in pointercancel instead).
// The decisions are plain functions, so Node tests cover them (tests/swipe-nav.node.test.js).

/** The thresholds, in CSS pixels. */
export const SWIPE_NAV = Object.freeze({
  /** The least sideways travel that counts. */
  minPx: 64,
  /** Sideways at least this many times the most up-and-down travel along the way. */
  ratio: 2,
  /** A touch starting this close to either side of the screen is the system's Back gesture. */
  edgePx: 24,
});

/** A region that keeps its own sideways drag or scroll: no page swipe starts inside it. */
export const NO_PAGE_SWIPE = '[data-no-page-swipe]';
const CONTROLS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Whether a touch at x (viewport width `width`) on `target` may start a page swipe. */
export function startsSwipe(target, x, width, { edgePx = SWIPE_NAV.edgePx } = {}) {
  if (!(x >= edgePx && x <= width - edgePx)) return false;
  const el = target && target.nodeType === 3 ? target.parentElement : target; // a text node's element
  if (!el || typeof el.closest !== 'function') return false;
  return !el.closest(CONTROLS) && !el.closest(NO_PAGE_SWIPE);
}

/**
 * The step a finished swipe makes: 1 (next tab, a swipe to the left), -1 (previous) or 0.
 * `dx` is the sideways travel from start to lift; `dyMax` the most up-and-down travel along the way.
 */
export function swipeStep(dx, dyMax, { minPx = SWIPE_NAV.minPx, ratio = SWIPE_NAV.ratio } = {}) {
  const ax = Math.abs(dx);
  if (!(ax >= minPx) || ax < ratio * Math.abs(dyMax)) return 0;
  return dx < 0 ? 1 : -1;
}

/** The tab `step` places from `current` in `order`, or null past either end (no wrap-around). */
export function neighbourTab(order, current, step) {
  const i = order.indexOf(current);
  if (i < 0 || !step) return null;
  return order[i + step] ?? null;
}

/**
 * Listen for page swipes on `win`'s document. `order()` the tab ids in the tab bar's order,
 * `current()` the shown tab, `go(tab)` the app's tab change, `blocked()` true while an overlay is
 * open. Returns { stop() }.
 */
export function bindSwipeNav({ order, current, go, blocked, win = window }) {
  const doc = win.document;
  let g = null; // the swipe in progress: { id, x, y, dyMax }
  // A tap outside a popover closes it on pointerdown, before the touch events of the same touch:
  // the overlay state is taken then, so a swipe that starts by closing a menu doesn't switch tabs.
  let downBlocked = false;
  const find = (list) => { for (const t of list) if (t.identifier === g.id) return t; return null; };

  const onPointerDown = (e) => { if (e.pointerType === 'touch' && e.isPrimary) downBlocked = !!blocked(); };
  const onStart = (e) => {
    const wasBlocked = downBlocked;
    downBlocked = false;
    if (e.touches.length !== 1) { g = null; return; } // a second finger cancels the swipe
    const t = e.changedTouches[0];
    // The page's own width: a desktop's classic scrollbar isn't part of it (a phone's overlays it).
    const width = doc.documentElement?.clientWidth || win.innerWidth;
    if (wasBlocked || blocked() || !startsSwipe(e.target, t.clientX, width)) { g = null; return; }
    g = { id: t.identifier, x: t.clientX, y: t.clientY, dyMax: 0 };
  };
  const onMove = (e) => {
    if (!g) return;
    if (e.touches.length > 1) { g = null; return; }
    const t = find(e.changedTouches);
    if (t) g.dyMax = Math.max(g.dyMax, Math.abs(t.clientY - g.y));
  };
  const onEnd = (e) => {
    if (!g) return;
    const t = find(e.changedTouches);
    if (!t) return;
    const d = g;
    g = null;
    if (blocked()) return; // an overlay opened during the swipe
    const step = swipeStep(t.clientX - d.x, Math.max(d.dyMax, Math.abs(t.clientY - d.y)));
    const next = neighbourTab(order(), current(), step);
    if (next) go(next);
  };
  const onCancel = () => { g = null; downBlocked = false; };

  const passive = { passive: true };
  win.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  doc.addEventListener('touchstart', onStart, passive);
  doc.addEventListener('touchmove', onMove, passive);
  doc.addEventListener('touchend', onEnd, passive);
  doc.addEventListener('touchcancel', onCancel, passive);
  return {
    stop() {
      win.removeEventListener('pointerdown', onPointerDown, { capture: true });
      doc.removeEventListener('touchstart', onStart, passive);
      doc.removeEventListener('touchmove', onMove, passive);
      doc.removeEventListener('touchend', onEnd, passive);
      doc.removeEventListener('touchcancel', onCancel, passive);
    },
  };
}
