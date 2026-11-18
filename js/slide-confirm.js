// Slide to confirm: a thumb dragged to the end of a track, for a step that must be read, not
// tapped through. It is locked for a moment after it's shown, so it can't be swiped by reflex, and
// springs back when released early. The same confirmation is also a checkbox (keyboard and screen
// reader friendly, locked for the same moment), and the thumb is a keyboard-operable slider.
// The spring back is a CSS transition. With "Reduce motion and effects" (`reduceMotion`) the
// thumb returns at once instead, and app.css cuts every transition as well. The pure parts at the top are covered by Node tests.

import { t } from './i18n.js';

export const SLIDE_LOCK_MS = 2000;
/** How far along the track (0–1) the thumb must be released to confirm. */
export const SLIDE_DONE = 0.92;
/** How far one arrow key press moves the thumb. */
export const SLIDE_STEP = 0.25;

/** The thumb's position (0–1) after dragging `dx` pixels from `start` along `travel` pixels of track. */
export function slideFraction(start, dx, travel) {
  if (!(travel > 0)) return 0;
  return Math.min(1, Math.max(0, start + dx / travel));
}

/** What releasing the thumb at `fraction` does: 'done' at the end of an unlocked track, else 'back'. */
export const slideRelease = (fraction, locked) => (!locked && fraction >= SLIDE_DONE ? 'done' : 'back');

/** The thumb's position after a key, or null for a key the slider doesn't use. */
export function slideKey(key, fraction) {
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': case 'PageUp': return Math.min(1, fraction + SLIDE_STEP);
    case 'ArrowLeft': case 'ArrowDown': case 'PageDown': return Math.max(0, fraction - SLIDE_STEP);
    case 'End': return 1;
    case 'Home': return 0;
    default: return null;
  }
}

/**
 * Wire up a slide-to-confirm inside `root`, which holds [data-slide-track], [data-slide-thumb]
 * (role="slider"), [data-slide-label] and the fallback checkbox [data-slide-check].
 * `onChange(confirmed)` runs whenever the confirmation changes. Call reset() each time the
 * screen is shown: it clears the confirmation and starts the lock again.
 */
export function createSlideConfirm(root, {
  onChange = () => {}, reduceMotion = () => false, lockMs = SLIDE_LOCK_MS, label = t('ai.slide.label'),
  doneLabel = t('ai.slide.done'), lockedLabel = t('ai.slide.locked'),
} = {}) {
  const track = root.querySelector('[data-slide-track]');
  const thumb = root.querySelector('[data-slide-thumb]');
  const text = root.querySelector('[data-slide-label]');
  const check = root.querySelector('[data-slide-check]');
  let fraction = 0;
  let locked = true;
  let confirmed = false;
  let drag = null;
  let timer = null;

  const travel = () => Math.max(0, track.clientWidth - thumb.offsetWidth);
  const place = (f) => {
    fraction = f;
    thumb.style.transform = `translateX(${Math.round(f * travel())}px)`;
    root.style.setProperty('--slide-fill', `${Math.round(f * travel()) + thumb.offsetWidth}px`);
    thumb.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  };
  const paint = () => {
    root.classList.toggle('is-locked', locked);
    root.classList.toggle('is-done', confirmed);
    thumb.setAttribute('aria-disabled', String(locked || confirmed));
    thumb.setAttribute('aria-valuetext', confirmed ? t('ai.slide.value.confirmed') : locked ? t('ai.slide.value.locked') : t('ai.slide.value.not'));
    text.textContent = confirmed ? doneLabel : locked ? lockedLabel : label;
    check.disabled = locked;
    check.checked = confirmed;
  };
  const setConfirmed = (on) => {
    const changed = on !== confirmed;
    confirmed = on;
    place(on ? 1 : 0);
    paint();
    if (changed) onChange(confirmed);
  };
  const springBack = () => {
    if (reduceMotion()) {
      // Reduce motion and effects: straight back, no spring. Placed while transitions are off,
      // and the style flushed before they come back, so nothing animates.
      root.classList.add('is-dragging');
      place(0);
      void thumb.offsetWidth;
      root.classList.remove('is-dragging');
      return;
    }
    root.classList.remove('is-dragging'); // the transition applies again: the thumb springs back
    place(0);
  };

  thumb.addEventListener('pointerdown', (e) => {
    if (locked || confirmed || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    drag = { id: e.pointerId, x: e.clientX, start: fraction };
    try { thumb.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
    root.classList.add('is-dragging');
  });
  thumb.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    place(slideFraction(drag.start, e.clientX - drag.x, travel()));
  });
  const release = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    if (e.type === 'pointerup' && slideRelease(fraction, locked) === 'done') { root.classList.remove('is-dragging'); setConfirmed(true); } else springBack();
  };
  thumb.addEventListener('pointerup', release);
  thumb.addEventListener('pointercancel', release);
  thumb.addEventListener('lostpointercapture', (e) => { if (drag && e.pointerId === drag.id) { drag = null; springBack(); } });

  thumb.addEventListener('keydown', (e) => {
    const next = slideKey(e.key, fraction);
    if (next === null) return;
    e.preventDefault();
    if (locked || confirmed) return;
    if (next >= 1) setConfirmed(true);
    else place(next);
  });

  check.addEventListener('change', () => {
    if (locked) { check.checked = false; return; }
    setConfirmed(check.checked);
  });

  return {
    /** Clear the confirmation and lock again for `lockMs`. */
    reset() {
      clearTimeout(timer);
      drag = null;
      root.classList.remove('is-dragging');
      locked = true;
      setConfirmed(false);
      place(0);
      paint();
      timer = setTimeout(() => { locked = false; paint(); }, lockMs);
    },
    /** Re-place the thumb (after the track changes size). */
    layout() { place(confirmed ? 1 : fraction); },
    get confirmed() { return confirmed; },
    get locked() { return locked; },
    stop() { clearTimeout(timer); },
  };
}
