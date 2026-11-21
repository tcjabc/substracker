// In-browser tests for swiping between the tabs (js/swipe-nav.js, wired in js/app.js bindTabs): a
// mostly sideways swipe on a page goes to the next tab (to the left) or the previous one (to the
// right), through the same setTab as a tap, with no wrap-around; never from an island
// (data-no-page-swipe: the Ring, the flat donut, the year chart, the currency chips, the Calendar
// grid), the 24px edge strips, a form control, a second finger, or while an overlay is open; never
// from a scroll. A Wallet card isn't an island: a swipe there changes the tab and leaves the stack
// alone, while its own up-and-down drag and a tap still work. Run by tests/swipe-nav.html with a fixed clock (18 November
// 2026) against a throwaway database, with index.html's markup. The touches are made in the page,
// as a phone sends them: pointer events (pointerType touch) first, then touch events, all to the
// element the touch started on. Run it at 320, 360 and 393px, with reduced motion emulated too, and
// in English, ?lang=xx and ?lang=zh-TW. The tests run in order, as one session in the app.

import * as storage from '../js/storage.js';
import { overlays, pressBack } from '../js/overlays.js';
import { SWIPE_NAV } from '../js/swipe-nav.js';

const results = [];
const dbName = `substracker-test-swipe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome',
  'dueSoonDismissed', 'weekStart', 'catView', 'insightsMode', 'yearKey', 'yearRange', 'yearStack'];
const savedPrefs = Object.fromEntries(PREFS.map((p) => [p, storage.getPref(p)]));

function test(name, fn) { results.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t = 0; t < ms; t += 25) { if (cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}
const describe = (el) => (el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map((c) => `.${c}`).join('')}` : 'nothing');

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// "Today" is Wednesday 18 November 2026. Two currencies, so Insights has its currency chips.
const SEED = [
  { ...base, type: 'income', id: 's-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, id: 's-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 's-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 's-stream', name: 'Streaming', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
  { ...base, id: 's-gym', name: 'Gym', price: 1200, cycle: 'monthly', nextRenewal: '2026-11-22', category: 'Health' },
  { ...base, id: 's-cloud', name: 'Cloud', price: 10, currency: 'USD', cycle: 'monthly', nextRenewal: '2026-11-28', category: 'Software' },
];

const ORDER = ['subs', 'calendar', 'insights', 'settings'];
const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(80); };
const reduced = () => document.documentElement.classList.contains('reduce-motion');
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };
const heading = () => $('#cal-month')?.textContent.trim();
const day = (d) => $(`#calendar .cal-day[data-day="${d}"]`);

// The pill behind the active tab (as in tests/nav.test.js).
const pillEl = () => $('.tabbar .tab-pill');
const pillRest = () => parseFloat(getComputedStyle(pillEl()).getPropertyValue('--tab-pill-w'));
function pillOn(tab) {
  const p = pillEl().getBoundingClientRect();
  const t = $(`.tab[data-tab="${tab}"]`).getBoundingClientRect();
  return Math.abs(p.width - Math.min(pillRest(), t.width)) < 0.6
    && Math.abs((p.left + p.right) / 2 - (t.left + t.right) / 2) < 0.6;
}

/* Touches ---------------------------------------------------------------------------------- */
let nextId = 1;
const mkTouch = (id, target, x, y) => new Touch({ identifier: id, target, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY, screenX: x, screenY: y, radiusX: 4, radiusY: 4, force: 1 });
const pointer = (target, type, id, x, y, primary = true) => target.dispatchEvent(new PointerEvent(type, {
  pointerId: 50 + id, isPrimary: primary, pointerType: 'touch', clientX: x, clientY: y,
  button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true,
}));
const touchEvent = (target, type, live, changed) => target.dispatchEvent(new TouchEvent(type, {
  touches: live, targetTouches: live, changedTouches: changed, bubbles: true, cancelable: type !== 'touchcancel', composed: true,
}));

/**
 * One finger from (x, y) along `path` (offsets from the start; by default a straight line to
 * (dx, dy) in six steps), then lifted. `on`: the element to send it to (default: what's at the point).
 */
async function swipeAt(x, y, dx, dy = 0, { path = null, on = null } = {}) {
  const target = on ?? document.elementFromPoint(x, y);
  assert(target, `nothing at ${Math.round(x)},${Math.round(y)}`);
  const id = nextId++;
  const pts = path ?? Array.from({ length: 6 }, (_, i) => [(dx * (i + 1)) / 6, (dy * (i + 1)) / 6]);
  pointer(target, 'pointerdown', id, x, y);
  touchEvent(target, 'touchstart', [mkTouch(id, target, x, y)], [mkTouch(id, target, x, y)]);
  for (const [px, py] of pts) {
    pointer(target, 'pointermove', id, x + px, y + py);
    const t = mkTouch(id, target, x + px, y + py);
    touchEvent(target, 'touchmove', [t], [t]);
    await tick(16);
  }
  const [ex, ey] = pts[pts.length - 1];
  pointer(target, 'pointerup', id, x + ex, y + ey);
  touchEvent(target, 'touchend', [], [mkTouch(id, target, x + ex, y + ey)]);
  await tick(60);
  return target;
}
/** A swipe from the middle of `el`, which must be what's on screen there (or `force` it). */
async function swipeOn(el, dx, dy = 0, { force = false, path = null } = {}) {
  assert(el, 'the element is there');
  const r0 = el.getBoundingClientRect();
  if (r0.top < 0 || r0.bottom > innerHeight - 120) el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + Math.min(r.height / 2, 40);
  const at = document.elementFromPoint(x, y);
  if (!force) assert(at && el.contains(at), `the swipe starts on ${describe(el)}, not ${describe(at)}`);
  return swipeAt(x, y, dx, dy, { path, on: force ? el : null });
}

// A plain place to swipe from on each tab: not an island, not a control.
const SPOTS = { subs: '#money-summary', calendar: '#calendar .cal-flow', insights: '#panel-insights .month-label', settings: '#panel-settings .group-title' };
const spot = (tab) => $(SPOTS[tab]);
const setCatView = async (v) => { $(`[data-catview="${v}"]`)?.click(); await tick(250); };
const setMode = async (m) => { $(`#insights-actions [data-insights-mode="${m}"]`).click(); await tick(250); };
const setView = async (v) => { $('#view-btn').click(); $(`#view-menu [data-view="${v}"]`).click(); await tick(120); };

/* ---------------------------------------------------------------- tests */

test('each tab: a swipe to the left goes to the next tab, to the right the previous, as a tap does', async () => {
  await goTab('subs');
  await setMode('month');
  for (let i = 0; i < ORDER.length - 1; i++) {
    const from = ORDER[i];
    const to = ORDER[i + 1];
    await swipeOn(spot(from), -120);
    eq(appTab(), to, `left on ${from}`);
    await until(() => pillOn(to), `the pill on ${to}`, 1500);
    eq(storage.getPref('tab'), to, `${to} saved, as a tap saves it`);
    assert(!$(`#panel-${to}`).hidden && $$('.tab-panel').filter((p) => !p.hidden).length === 1, `only ${to}'s panel shown`);
    eq($('#fab-stack').hidden, !['subs', 'calendar'].includes(to), `the + as for a tap on ${to}`);
  }
  for (let i = ORDER.length - 1; i > 0; i--) {
    await swipeOn(spot(ORDER[i]), 120);
    eq(appTab(), ORDER[i - 1], `right on ${ORDER[i]}`);
    await until(() => pillOn(ORDER[i - 1]), `the pill on ${ORDER[i - 1]}`, 1500);
  }
});

test('Back and the rolling totals after a swipe are as after a tap', async () => {
  const roller = $('#money-summary').roller;
  const replay = roller.replay;
  let replays = 0;
  roller.replay = (...a) => { replays++; return replay.apply(roller, a); };
  try {
    await goTab('subs');
    replays = 0;
    await goTab('calendar');
    const byTap = replays;
    await goTab('subs');
    replays = 0;
    await swipeOn(spot('subs'), -120);
    eq(appTab(), 'calendar', 'swiped to Calendar');
    eq(replays, byTap, 'the totals replay as for a tap');
    assert(byTap >= 1, 'a tap to Calendar replays them');
  } finally { roller.replay = replay; }
  await swipeOn(spot('calendar'), -120);
  eq(appTab(), 'insights', 'swiped on to Insights');
  pressBack();
  await tick(80);
  eq(appTab(), 'subs', 'Back goes to Money');
  await until(() => pillOn('subs'), 'and the pill with it', 1500);
});

test('no wrap-around: left on Settings and right on Money do nothing', async () => {
  await goTab('settings');
  await until(() => pillOn('settings'), 'pill on Settings', 1500);
  await swipeOn(spot('settings'), -140);
  eq(appTab(), 'settings', 'left on Settings');
  assert(pillOn('settings'), 'the pill stays');
  await goTab('subs');
  await until(() => pillOn('subs'), 'pill on Money', 1500);
  await swipeOn(spot('subs'), 140);
  eq(appTab(), 'subs', 'right on Money');
  assert(pillOn('subs'), 'the pill stays');
  eq(storage.getPref('tab'), 'subs', 'nothing saved');
});

test('the tab bar is unchanged: roles, labels and the one tab stop', async () => {
  const attrs = () => [$('.tabbar'), ...$$('.tab')].map((el) => [...el.attributes]
    .filter((a) => !['aria-selected', 'tabindex', 'style'].includes(a.name))
    .map((a) => `${a.name}=${a.value}`).sort());
  await goTab('subs');
  const before = attrs();
  await swipeOn(spot('subs'), -120);
  eq(attrs(), before, 'the same attributes on the tab list and tabs');
  eq($('.tabbar').getAttribute('role'), 'tablist', 'a tab list');
  eq($$('.tab[aria-selected="true"]').map((b) => b.dataset.tab), ['calendar'], 'one selected tab');
  eq($$('.tab').filter((b) => b.tabIndex === 0).map((b) => b.dataset.tab), ['calendar'], 'one tab stop, on it');
  assert(document.activeElement === document.body || !document.activeElement?.closest('.tabbar'), 'a swipe moves no focus to the tab bar');
});

test('islands on Insights: the Ring, the flat donut, the year chart and the currency chips', async () => {
  await goTab('insights');
  await setMode('month');
  for (const view of ['ring', 'donut']) {
    await setCatView(view);
    // With Reduce motion and effects (or without WebGL) the Ring view is the flat donut.
    await until(() => $('#insights .ring-stage canvas') || $('#insights .donut'), `the ${view} drawn`);
    const el = view === 'ring' ? ($('#insights .ring-stage') ?? $('#insights .donut')) : $('#insights .donut');
    assert(el.hasAttribute('data-no-page-swipe'), `${describe(el)} is an island`);
    await swipeOn(el, -120);
    eq(appTab(), 'insights', `left on the ${view}`);
    await swipeOn(el, 120);
    eq(appTab(), 'insights', `right on the ${view}`);
  }
  const chips = $('#currency-chips');
  assert(chips?.hasAttribute('data-no-page-swipe'), 'the chips row is an island');
  await swipeOn(chips, -120);
  eq(appTab(), 'insights', 'on the chips row (month)');
  await setMode('year');
  await until(() => $('#year-chart svg'), 'the year chart drawn');
  const yc = $('#year-chart');
  assert(yc.hasAttribute('data-no-page-swipe'), 'the year chart is an island');
  await swipeOn($('#year-chart svg'), -120);
  eq(appTab(), 'insights', 'left on the year chart');
  await swipeOn($('#year-chart svg'), 120);
  eq(appTab(), 'insights', 'right on the year chart');
  await swipeOn($('#currency-chips'), 120);
  eq(appTab(), 'insights', 'on the chips row (year)');
  await setMode('month');
  await setCatView('ring');
  // The page still swipes from outside them.
  await swipeOn(spot('insights'), -120);
  eq(appTab(), 'settings', 'from the month label, it switches');
});

// The Wallet: where each card sits in the stack, and how many are open.
const wCards = () => $$('#wallet .w-card');
const wBand = (i = 0) => wCards()[i]?.querySelector('.w-band');
const stackPose = () => {
  const top = $('#wallet').getBoundingClientRect().top;
  return wCards().map((c) => Math.round(c.getBoundingClientRect().top - top));
};
const openCards = () => wCards().filter((c) => c.classList.contains('is-open')).length;
const toWallet = async () => { await goTab('subs'); await setView('wallet'); await tick(300); };

test('a sideways swipe from a Wallet card changes the tab; the stack stays where it was and no card opens', async () => {
  await toWallet();
  const w = $('#wallet');
  assert(!w.closest('[data-no-page-swipe]'), 'the Wallet is not an island');
  eq(w.classList.contains('is-reduced'), reduced(), 'a plain list exactly when motion is reduced');
  const pose = stackPose();
  // Left from the front card's band, with the few pixels of up-and-down drift a thumb makes.
  const drift = [2, 4, 5, 4, 3, 2].map((dy, i) => [-20 * (i + 1), dy]);
  await swipeOn(wBand(0), 0, 0, { path: drift });
  eq(appTab(), 'calendar', 'left from a card: the next tab');
  await toWallet();
  eq(stackPose(), pose, 'the stack did not move');
  eq(openCards(), 0, 'no card opened');
  // From the middle of the stack too.
  await swipeOn(w, -120);
  eq(appTab(), 'calendar', 'left from the middle of the stack');
  await toWallet();
  // Right on Money: no wrap-around, and still nothing moves or opens.
  await swipeOn(wBand(0), 120);
  eq(appTab(), 'subs', 'right from a card on Money: no wrap');
  await tick(300);
  eq(stackPose(), pose, 'the stack still did not move');
  eq(openCards(), 0, 'and no card opened');
});

test('a vertical drag on the Wallet stack moves the stack, not the tab', async () => {
  await toWallet();
  const pose = stackPose();
  await swipeOn(wBand(0), 4, -150);
  eq(appTab(), 'subs', 'up: still Money');
  if (!reduced()) { // the plain list scrolls with the page, which a made-up touch doesn't move
    await until(() => JSON.stringify(stackPose()) !== JSON.stringify(pose), 'the stack moved', 1500);
    await tick(900);
    eq(openCards(), 0, 'no card opened');
    await swipeOn($('#wallet'), -4, 400);
    eq(appTab(), 'subs', 'down: still Money');
    await until(() => JSON.stringify(stackPose()) === JSON.stringify(pose), 'back at the top', 2500);
  }
  eq(openCards(), 0, 'no card open');
});

test('a tap on a Wallet card still opens it, with or without a small sideways wobble', async () => {
  await toWallet();
  const pose = stackPose();
  // A sideways drag under the 64px: no tab change, the stack stays (and the browser sends no click).
  await swipeOn(wBand(0), -40, 2);
  eq(appTab(), 'subs', 'under the threshold: still Money');
  await tick(300);
  eq(stackPose(), pose, 'the stack did not move');
  for (const path of [[[0, 0]], [[3, 1], [6, 2], [5, 1]]]) {
    const card = wCards()[0];
    const band = wBand(0);
    await swipeOn(band, 0, 0, { path });
    band.click(); // the browser's click for a tap
    await until(() => card.classList.contains('is-open'), `the card opens (${path.length > 1 ? 'a wobble' : 'a plain tap'})`);
    eq(band.getAttribute('aria-expanded'), 'true', 'expanded');
    eq(appTab(), 'subs', 'still Money');
    await tick(600);
    band.click();
    await until(() => !card.classList.contains('is-open'), 'a second tap closes it');
    await tick(700);
  }
  eq(openCards(), 0, 'all closed');
});

test('the Calendar grid: a swipe changes the month, not the tab', async () => {
  await goTab('calendar');
  const grid = $('#calendar .cal-grid');
  assert(grid.hasAttribute('data-no-page-swipe'), 'the grid is an island');
  const was = heading();
  await swipeOn($('#calendar .cal-weeks'), -160);
  await until(() => heading() !== was, 'the next month');
  eq(appTab(), 'calendar', 'still Calendar');
  await tick(400);
  const next = heading();
  await swipeOn($('#calendar .cal-weeks'), 160);
  await until(() => heading() !== next, 'back a month');
  eq(heading(), was, 'this month again');
  eq(appTab(), 'calendar', 'still Calendar');
  await tick(400);
});

test('on Calendar, a swipe from the In, Out and Left over figures, the day list or the space below changes the tab', async () => {
  await goTab('calendar');
  await swipeOn($('#calendar .cal-flow'), -120);
  eq(appTab(), 'insights', 'from the figures');
  await goTab('calendar');
  await swipeOn($('#calendar .cal-flow-left') ?? $('#calendar .cal-flow'), 120);
  eq(appTab(), 'subs', 'from Left over, to the right');
  await goTab('calendar');
  day(20).click();
  await tick(60);
  const list = $('#calendar .cal-list');
  assert(list, 'the 20th has its list');
  await swipeOn(list, -120);
  eq(appTab(), 'insights', 'from the day list');
  await goTab('calendar');
  day(20).click(); // the 20th stays selected; a second tap may close it
  await tick(60);
  if (!$('#calendar .cal-list')) { day(20).click(); await tick(60); }
  scrollTo(0, document.documentElement.scrollHeight);
  await tick(80);
  // The space under the day list: the page's own room above the + and the tab bar.
  const last = $('#calendar').lastElementChild.getBoundingClientRect();
  const x = innerWidth * 0.3;
  const y = Math.min(last.bottom + 12, $('.tabbar').getBoundingClientRect().top - 12);
  const at = document.elementFromPoint(x, y);
  assert(at && !at.closest('[data-no-page-swipe], button, .cal-list'), `empty space at ${Math.round(y)}: ${describe(at)}`);
  await swipeAt(x, y, -120);
  eq(appTab(), 'insights', `from the space below (${describe(at)})`);
});

test('the 24px strips at both edges never start a swipe', async () => {
  eq(SWIPE_NAV.edgePx, 24, 'the strip is 24px');
  await goTab('calendar');
  const r = $('#calendar .cal-flow').getBoundingClientRect();
  const y = r.top + r.height / 2;
  for (const x of [2, 10, 23]) {
    await swipeAt(x, y, 120);
    eq(appTab(), 'calendar', `from x=${x}, to the right`);
  }
  // The page's own width, as js/swipe-nav.js measures it (a desktop runner's scrollbar isn't page).
  const W = document.documentElement.clientWidth;
  for (const x of [W - 2, W - 10, W - 23]) {
    await swipeAt(x, y, -120);
    eq(appTab(), 'calendar', `from x=${Math.round(x)} (right edge), to the left`);
  }
  await swipeAt(25, y, 120);
  eq(appTab(), 'subs', 'just inside the left strip, it switches');
  await goTab('calendar');
  await swipeAt(W - 25, y, -120);
  eq(appTab(), 'insights', 'just inside the right strip, it switches');
});

test('an open overlay blocks it: the add sheet, the View menu, any overlay on screen', async () => {
  await goTab('subs');
  $('#fab').click();
  await until(() => $('#sub-dialog').open, 'the add sheet open');
  const r = $('#sub-dialog').getBoundingClientRect();
  await swipeAt(r.left + r.width / 2, r.top + 40, -120);
  eq(appTab(), 'subs', 'a swipe on the sheet');
  await swipeOn(spot('subs'), -120, 0, { force: true });
  eq(appTab(), 'subs', 'a swipe sent to the page behind it');
  assert($('#sub-dialog').open, 'the sheet is still open');
  await closeSheets();
  // The View menu closes on a touch outside it (pointerdown); that touch doesn't switch tabs.
  $('#view-btn').click();
  await tick(40);
  assert(!$('#view-menu').hidden && overlays.has('view-menu'), 'the View menu open');
  await swipeOn(spot('subs'), -120, 0, { force: true });
  eq(appTab(), 'subs', 'a swipe that closes the menu');
  assert($('#view-menu').hidden, 'the menu closed');
  // Any overlay on screen blocks it; one left open out of sight (another tab's) does not, as for Back.
  overlays.open('test-shown', { close: () => overlays.remove('test-shown') });
  await swipeOn(spot('subs'), -120);
  eq(appTab(), 'subs', 'an overlay on screen');
  overlays.remove('test-shown');
  overlays.open('test-hidden', { close: () => overlays.remove('test-hidden'), isShown: () => false });
  await swipeOn(spot('subs'), -120);
  eq(appTab(), 'calendar', 'an overlay out of sight does not block it');
  overlays.remove('test-hidden');
  await goTab('subs');
});

test('a scroll or a swipe below the ratio never switches; a steep diagonal at the ratio does', async () => {
  eq({ minPx: SWIPE_NAV.minPx, ratio: SWIPE_NAV.ratio }, { minPx: 64, ratio: 2 }, 'the thresholds');
  await goTab('calendar');
  const el = $('#calendar .cal-flow');
  await swipeOn(el, 8, 220);
  eq(appTab(), 'calendar', 'a scroll down');
  await swipeOn(el, -10, -220);
  eq(appTab(), 'calendar', 'a scroll up');
  await swipeOn(el, -70, 40);
  eq(appTab(), 'calendar', 'a diagonal under the ratio (70 across, 40 down)');
  await swipeOn(el, -50, 0);
  eq(appTab(), 'calendar', 'too short (50)');
  await swipeOn(el, 0, 0, { path: [[0, 45], [0, 90], [-40, 60], [-80, 20], [-110, 0]] });
  eq(appTab(), 'calendar', 'down 90 and back up: the most up-and-down travel counts');
  await swipeOn(el, -130, 60);
  eq(appTab(), 'insights', 'a diagonal past the ratio (130 across, 60 down) switches');
});

test('Reduce motion and effects: the tab changes and the pill moves plainly, with no animation frames', async () => {
  await goTab('subs');
  await until(() => pillOn('subs'), 'pill on Money', 1500);
  await tick(200);
  const raf = window.requestAnimationFrame;
  let frames = 0;
  window.requestAnimationFrame = (cb) => { frames++; return raf.call(window, cb); };
  let onAtOnce;
  try {
    await swipeOn(spot('subs'), -120);
    onAtOnce = pillOn('calendar');
    await tick(250);
  } finally { window.requestAnimationFrame = raf; }
  eq(appTab(), 'calendar', 'the tab changed');
  if (reduced()) {
    assert(onAtOnce, 'the pill is on Calendar at once');
    eq(frames, 0, 'no animation frames');
    eq(pillEl().getAnimations().length, 0, 'no animation on the pill');
  } else {
    assert(frames > 0, 'with motion the pill slides (animation frames)');
    await until(() => pillOn('calendar'), 'and lands on Calendar', 1500);
  }
});

test('a swipe starting on an input, a range, a select or a checkbox, or with two fingers, does nothing', async () => {
  await goTab('settings');
  const panel = $('#panel-settings .panel');
  const extra = document.createElement('div');
  extra.innerHTML = '<input type="range" min="0" max="10" value="5" class="input" style="width: 100%"><input type="text" class="input" value="text">';
  panel.prepend(extra);
  try {
    for (const el of [...extra.children, $('#set-currency'), $('#set-motion')]) {
      await swipeOn(el, 120);
      eq(appTab(), 'settings', `from ${describe(el)}[type=${el.type}]`);
    }
  } finally { extra.remove(); }
  // Two fingers down together, both moving across.
  const r = spot('settings').getBoundingClientRect();
  const y = r.top + r.height / 2;
  const target = document.elementFromPoint(innerWidth / 2, y);
  const a = nextId++;
  const b = nextId++;
  const T = (id, x) => mkTouch(id, target, x, y);
  const xa = innerWidth / 2 - 30;
  const xb = innerWidth / 2 + 30;
  pointer(target, 'pointerdown', a, xa, y);
  touchEvent(target, 'touchstart', [T(a, xa)], [T(a, xa)]);
  pointer(target, 'pointerdown', b, xb, y, false);
  touchEvent(target, 'touchstart', [T(a, xa), T(b, xb)], [T(b, xb)]);
  for (let i = 1; i <= 6; i++) { touchEvent(target, 'touchmove', [T(a, xa + i * 20), T(b, xb + i * 20)], [T(a, xa + i * 20), T(b, xb + i * 20)]); await tick(16); }
  touchEvent(target, 'touchend', [T(b, xb + 120)], [T(a, xa + 120)]);
  touchEvent(target, 'touchend', [], [T(b, xb + 120)]);
  await tick(60);
  eq(appTab(), 'settings', 'two fingers across');
  // A second finger put down during a swipe and lifted again: the swipe is cancelled.
  const c = nextId++;
  const d = nextId++;
  touchEvent(target, 'touchstart', [T(c, xa)], [T(c, xa)]);
  touchEvent(target, 'touchmove', [T(c, xa + 60)], [T(c, xa + 60)]);
  touchEvent(target, 'touchstart', [T(c, xa + 60), T(d, xb)], [T(d, xb)]);
  touchEvent(target, 'touchend', [T(c, xa + 60)], [T(d, xb)]);
  touchEvent(target, 'touchmove', [T(c, xa + 130)], [T(c, xa + 130)]);
  touchEvent(target, 'touchend', [], [T(c, xa + 130)]);
  await tick(60);
  eq(appTab(), 'settings', 'a second finger during the swipe');
  await swipeOn(spot('settings'), 120);
  eq(appTab(), 'insights', 'one finger again: it switches');
});

test('audit: every sideways scroller in every view is an island, and the page never scrolls sideways', async () => {
  const found = new Map();
  const unmarked = [];
  // Whether a finger can pan `el` sideways: its touch-action and every ancestor's allow it.
  const panX = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const ta = getComputedStyle(n).touchAction;
      if (ta !== 'auto' && ta !== 'manipulation' && !/pan-(x|left|right)/.test(ta)) return false;
    }
    return true;
  };
  const look = (where) => {
    for (const el of $$('#app-host *')) {
      if (!el.getClientRects().length) continue;
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
        const key = describe(el);
        const touch = panX(el);
        found.set(key, { where, island: !!el.closest('[data-no-page-swipe]'), panX: touch });
        // One a finger can't pan sideways (touch-action pan-y or none) can't take a sideways swipe.
        if (touch && !el.closest('[data-no-page-swipe]')) unmarked.push(`${where}: ${key}`);
      }
    }
    const sx = document.scrollingElement.scrollWidth;
    assert(sx <= innerWidth + 1, `${where}: the page is ${sx}px wide at ${innerWidth}px`);
  };
  await goTab('subs');
  for (const v of ['wallet', 'grid', 'list']) { await setView(v); look(`Money ${v}`); }
  await setView('wallet');
  await goTab('calendar');
  look('Calendar');
  await goTab('insights');
  await setMode('month');
  for (const v of ['ring', 'donut', 'list']) { await setCatView(v); look(`Insights ${v}`); }
  await setCatView('ring');
  await setMode('year');
  look('Insights year');
  await setMode('month');
  await goTab('settings');
  look('Settings');
  window.testAudit = {
    scrollers: Object.fromEntries(found),
    islands: [...new Set($$('[data-no-page-swipe]').map(describe))],
  };
  eq(unmarked, [], 'no sideways scroller outside an island');
  await goTab('subs');
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  storage.setPref('catView', 'ring');
  storage.setPref('insightsMode', 'month');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  for (const p of ['groupSort', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed', 'weekStart', 'yearKey', 'yearRange', 'yearStack']) localStorage.removeItem(`substracker.${p}`);

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#wallet .w-band'), 'app drawn');
  await tick(300);

  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; } catch (err) { failures.push({ name, error: err.message }); }
    await closeSheets();
    for (const id of overlays.ids()) if (id.startsWith('test-')) overlays.remove(id);
  }
  for (const [p, v] of Object.entries(savedPrefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
  $('#t-report').hidden = false;
  $('#summary').textContent = failures.length ? `${failures.length} of ${results.length} failed` : `All ${results.length} passed`;
  $('#summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  $('#results').innerHTML = results.map(({ name }) => {
    const fl = failures.find((x) => x.name === name);
    return `<li class="${fl ? 't-fail' : 't-pass'}">${fl ? '✗' : '✓'} ${name}${fl ? `<div class="t-detail">${fl.error.replace(/</g, '&lt;')}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-swipe-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
