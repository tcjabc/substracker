// In-browser tests for the Money card's due-soon chip and its sheet (js/due-soon.js, js/app.js),
// run by tests/due-soon.html with a fixed clock (18 November 2026) against a throwaway database.
// The app runs with index.html's markup. Run the page at 320, 360 and 393px: the layout tests
// check the width they're given. The tests run in order, as one session in the app. Until 1.21.0
// this was a banner under the strip, with a close button for the day; the chip has neither.

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';
import { overlays, pressBack } from '../js/overlays.js';
import { parseColour, contrast } from '../js/wallet-math.js';

const results = [];
const dbName = `substracker-test-due-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed'];
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
const text = (el) => el?.textContent.replace(/\s+/g, ' ').trim() ?? '';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t = 0; t < ms; t += 25) { if (cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}
const T = (n) => money(n, 'TWD');

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// "Today" is 18 November 2026. In the next 7 days (to the 25th): Streaming today 390, the long
// name tomorrow 250, Phone on the 20th 499, Old plan on the 21st 100 (stored in 2025, rolled
// forward for display) = 1,239 TWD; Tool on the 22nd, 10 USD (not in the total). Salary on the
// 25th is income (only with "Include upcoming income"). Concert (28th) and Rent (1 Dec) are
// outside the window; Dinner (a one-off yesterday) is past; Gym has no date.
const LONG = 'A very long subscription name that keeps going, Premium Family Plan';
const SEED = [
  { ...base, type: 'income', id: 't-salary', name: 'Salary', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, id: 't-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 't-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 't-old', name: 'Old plan', price: 100, cycle: 'monthly', nextRenewal: '2025-06-21', category: 'Utilities' },
  { ...base, id: 't-stream', name: 'Streaming', emoji: '🎬', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
  { ...base, id: 't-long', name: LONG, price: 250, cycle: 'monthly', nextRenewal: '2026-11-19', category: 'Entertainment' },
  { ...base, id: 't-concert', name: 'Concert', price: 1500, cycle: 'once', date: '2026-11-28', category: 'Entertainment' },
  { ...base, id: 't-dinner', name: 'Dinner', price: 800, cycle: 'once', date: '2026-11-17', category: 'Entertainment' },
  { ...base, id: 't-gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
  { ...base, currency: 'USD', id: 't-tool', name: 'Tool', price: 10, cycle: 'monthly', nextRenewal: '2026-11-22', category: 'Utilities' },
  { ...base, id: 't-a', name: 'Apps', price: 30, cycle: 'monthly', nextRenewal: '2026-12-09', category: 'Apps' },
  { ...base, id: 't-b', name: 'Books', price: 40, cycle: 'monthly', nextRenewal: '2026-12-10', category: 'Books' },
  { ...base, id: 't-c', name: 'Cafe', price: 50, cycle: 'monthly', nextRenewal: '2026-12-11', category: 'Coffee' },
];

const card = () => $('#money-summary');
const chip = () => $('#due-chip');
const shown = () => !!chip() && !chip().hidden && chip().getClientRects().length > 0;
const dueDialog = () => $('#due-dialog');
const open = (d) => d.open || d.hasAttribute('open');
const subDialog = () => $('#sub-dialog');
const rows = () => $$('#due-list .due-row');
const openSheet = async () => { chip().click(); await until(() => open(dueDialog()), 'the due-soon sheet'); };
/** Show a Money view through the header's View menu (js/app.js bindViewMenu). */
const view = async (v) => {
  $('#tab-subs').click();
  $('#view-btn').click();
  $(`#view-menu [data-view="${v}"]`).click();
  await tick(60);
};
// Draw the Money tab again the way the app does when it comes back to the front.
const comeBack = async () => { document.dispatchEvent(new Event('visibilitychange')); await tick(60); };
const closeSheets = async () => {
  for (const d of $$('dialog[open]')) d.close();
  await tick(30);
};

/* ---------------------------------------------------------------- tests */

test('a "5 due" chip on the Money card in Wallet, Grid and List; the totals are in its sheet', async () => {
  for (const v of ['wallet', 'grid', 'list']) {
    await view(v);
    assert(shown(), `${v}: the chip is shown`);
    assert(card().contains(chip()), `${v}: on the Money card`);
    assert(!$('#due-banner'), `${v}: no banner any more`);
    eq(text(chip()), '5 due', `${v}: the count`);
    assert($('svg', chip()), `${v}: with the calendar icon`);
    eq(chip().getAttribute('aria-label'), `5 due in the next 7 days · ${T(1239)} due · +1 in USD`, `${v}: read out with the totals`);
  }
  await openSheet();
  eq(text($('#due-text')), '5 due in the next 7 days', 'the sheet: the count');
  eq(text($('#due-sum')), `${T(1239)} due`, 'the TWD total of the listed items');
  eq(text($('#due-extra')), '+1 in USD', 'other currencies, counted apart');
  eq(text($('#due-undated')), '1 item needs a date', 'the undated line');
  pressBack();
  await view('wallet');
});

test('ARIA: the chip is a button with aria-expanded that opens a dialog; no live region; no close button', async () => {
  eq(chip().tagName, 'BUTTON', 'a button');
  eq(chip().getAttribute('aria-expanded'), 'false', 'collapsed');
  eq(chip().getAttribute('aria-haspopup'), 'dialog', 'opens a dialog');
  eq(chip().getAttribute('aria-controls'), 'due-dialog', 'the sheet');
  assert(!$('#due-close') && !$$('#money-summary [aria-label*="tomorrow"]').length, 'nothing hides it for the day');
  eq($$('[aria-live], [role="status"], [role="alert"]', card()).length + $$('[aria-live], [role="status"], [role="alert"]', dueDialog()).length, 0, 'announces nothing by itself');
});

test('the sheet: by date, then name, with relative days; full row labels; Back closes it', async () => {
  await openSheet();
  eq(chip().getAttribute('aria-expanded'), 'true', 'expanded while open');
  eq(overlays.top(), 'due-dialog', 'on the overlay stack');
  eq(text($('#due-range')), `Today to ${new Date(2026, 10, 25).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`, 'the range');
  eq(rows().map((r) => text($('.sub-name', r))), ['Streaming', LONG, 'Phone', 'Old plan', 'Tool'], 'today first, by date');
  eq(rows().map((r) => text($('.sub-plan', r))), ['Today', 'Tomorrow', 'In 2 days', 'In 3 days', 'In 4 days'], 'relative days');
  eq(rows().map((r) => text($('.amount', r))), [T(390), T(250), T(499), T(100), money(10, 'USD')], 'each in its own currency');
  eq(text($('.cycle', rows()[4])), 'not in TWD totals', 'the USD row says it is not in the total');
  eq(rows().map((r) => r.getAttribute('aria-label')), [`Streaming, today, ${T(390)}`, `${LONG}, tomorrow, ${T(250)}`, `Phone, in 2 days, ${T(499)}`,
    `Old plan, in 3 days, ${T(100)}`, `Tool, in 4 days, ${money(10, 'USD')}`], 'full labels');
  assert(rows().every((r) => r.tagName === 'BUTTON'), 'rows are buttons');
  assert(rows()[0].classList.contains('due-today'), 'today stands out');
  eq(pressBack(), 'closed', 'Back');
  assert(!open(dueDialog()), 'Back closed the sheet');
  await until(() => chip().getAttribute('aria-expanded') === 'false', 'the close event', 1000).catch(() => {});
  eq(chip().getAttribute('aria-expanded'), 'false', 'collapsed again');
  eq($('#tab-subs').getAttribute('aria-selected'), 'true', 'the chip never opened Insights');
});

test('a row opens the item in the edit sheet; the need-a-date line opens the undated item', async () => {
  await openSheet();
  rows()[2].click();
  await until(() => open(subDialog()), 'the edit sheet');
  assert(!open(dueDialog()), 'the list closed');
  eq($('#sub-form').elements.name.value, 'Phone', 'the tapped item');
  assert(document.body.classList.contains('sheet-open'), 'the floating buttons stay hidden under the edit sheet');
  pressBack();
  await tick(60);
  assert(!open(subDialog()), 'closed');
  await openSheet();
  $('#due-undated').click();
  await until(() => open(subDialog()), 'the edit sheet for the undated item');
  assert(!open(dueDialog()), 'the list closed for it');
  eq($('#sub-form').elements.name.value, 'Gym', 'the first undated item');
  pressBack();
  await tick(60);
});

test('Grid and List: the chip opens the same sheet; it takes no room of its own', async () => {
  for (const v of ['grid', 'list']) {
    await view(v);
    await openSheet();
    eq(rows().length, 5, `${v}: the same rows`);
    pressBack();
    await tick(30);
    assert(!open(dueDialog()), `${v}: Back closed it`);
    const before = [card().getBoundingClientRect().height, $('#subs-list').getBoundingClientRect().top];
    storage.setPref('dueSoon', 'off');
    await comeBack();
    assert(!shown(), `${v}: turned off`);
    eq([card().getBoundingClientRect().height, $('#subs-list').getBoundingClientRect().top], before, `${v}: the card and the groups don't move`);
    storage.setPref('dueSoon', 'on');
    await comeBack();
    assert(shown(), `${v}: back`);
  }
  await view('wallet');
});

test('nothing is written: a rolled-forward date stays as stored, and no sync op is made', async () => {
  const before = await storage.pendingCount();
  await comeBack();
  await openSheet();
  pressBack();
  await tick(30);
  eq(await storage.pendingCount(), before, 'no ops');
  const old = (await storage.getAll()).find((s) => s.id === 't-old');
  eq(old.nextRenewal, '2025-06-21', 'the stored date is untouched');
});

/** The last Wallet card, scrolled to the end of the stack, sits clear of the + button. */
async function lastCardClear(label) {
  await view('wallet');
  const bands = $$('#wallet .w-band');
  bands[0].focus({ preventScroll: true });
  bands[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  await tick(1400);
  window.scrollTo(0, document.documentElement.scrollHeight);
  await tick(80);
  const last = bands.at(-1).closest('.w-card');
  const fab = $('#fab-stack').getBoundingClientRect();
  const bar = $('.tabbar').getBoundingClientRect();
  const face = [bands.at(-1), ...$$('.w-pv-row', last)].map((e) => e.getBoundingClientRect()).filter((r) => r.height);
  const bottom = Math.max(...face.map((r) => r.bottom));
  assert(bottom <= fab.top + 1, `${label}: the last card's face ends at ${Math.round(bottom)}, above the button at ${Math.round(fab.top)}`);
  // The stack's room at its end is measured from the one button (js/app.js walletViewport).
  const { maxScroll } = await import('../js/wallet-math.js');
  const st = $('#wallet').wallet.state();
  eq(st.maxScroll, maxScroll(st.count, st.height, Math.max(0, bar.top - fab.top)), `${label}: the stack's end is measured from the one button`);
  assert(bottom <= bar.top + 1, `${label}: and above the tab bar (${Math.round(bar.top)})`);
  assert(document.documentElement.scrollWidth <= innerWidth + 1, `${label}: no sideways scroll`);
  const top = $('#wallet').getBoundingClientRect().top + scrollY;
  bands[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await tick(900);
  window.scrollTo(0, 0);
  await tick(40);
  return top;
}

test('Wallet: the last card clears the + button with the chip shown and turned off; the stack stays put', async () => {
  const withChip = await lastCardClear('chip shown');
  storage.setPref('dueSoon', 'off');
  await comeBack();
  assert(!shown(), 'turned off: hidden');
  eq(await lastCardClear('chip off'), withChip, 'the stack starts in the same place: the chip has no row of its own');
  storage.setPref('dueSoon', 'on');
  await comeBack();
  assert(shown(), 'on again');
  eq(await lastCardClear('chip shown again'), withChip, 'back where it was');
});

test('no dismiss: the chip stays all day and follows the window; nothing is saved for the day', async () => {
  eq(storage.getPref('dueSoonDismissed'), null, 'no dismissal is ever saved');
  window.testClock.set(2026, 10, 18, 23);
  await comeBack();
  assert(shown(), 'still there at 23:00');
  window.testClock.set(2026, 10, 19, 0);
  await comeBack();
  assert(shown(), 'and just after midnight');
  eq(text(chip()), '4 due', 'Streaming has moved to next month; the window now ends on the 26th');
  window.testClock.reset();
  await comeBack();
  $('#tab-settings').click();
  await tick(40);
  const days = $('#set-due-days');
  days.value = '14';
  days.dispatchEvent(new Event('change', { bubbles: true }));
  $('#tab-subs').click();
  await tick(80);
  eq(text(chip()), '7 due', 'a new window counts at once');
  eq(chip().getAttribute('aria-label').split(' · ')[0], '7 due in the next 14 days', 'and says so');
});

test('settings: on, 7 days and income off by default; relabelled for the chip; per device; never in a backup, the settings or the sync outbox', async () => {
  $('#tab-settings').click();
  await tick(40);
  const show = $('#set-due');
  const days = $('#set-due-days');
  const income = $('#set-due-income');
  eq(text(show.closest('.setting-row').querySelector('.setting-label')), 'Show the due-soon chip A chip on the Money card with how many items come due soon. Tap it for the list.', 'the setting names the chip');
  eq([...days.options].map((o) => [o.value, o.textContent]), [['3', '3 days'], ['7', '7 days'], ['14', '14 days']], 'the windows');
  eq(days.value, '14', 'shows the setting');
  days.value = '7';
  days.dispatchEvent(new Event('change', { bubbles: true }));
  assert(show.checked && !income.checked, 'shown, income off');
  const opsBefore = await storage.pendingCount();
  income.click();
  await tick(40);
  eq(storage.getPref('dueSoonIncome'), 'on', 'kept on this device');
  $('#tab-subs').click();
  await tick(80);
  eq(text(chip()), '6 due', 'Salary on day 7 is in');
  await openSheet();
  eq(text($('#due-text')), '6 due in the next 7 days', 'the sheet says so');
  eq(text($('#due-sum')), `${T(1239)} due`, 'the expenses total is unchanged: income is never added to it');
  eq(text($('#due-extra')), `${T(40000)} coming in · +1 in USD`, 'income has its own figure');
  const salary = rows().find((r) => text($('.sub-name', r)) === 'Salary');
  const d25 = new Date(2026, 10, 25).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  eq(text($('.sub-plan', salary)), `${d25} · Income`, 'a week or more ahead: the date; marked as income');
  eq(salary.getAttribute('aria-label'), `Salary, income, ${d25}, ${T(40000)}`, 'and says so');
  pressBack();
  await tick(30);
  $('#tab-settings').click();
  await tick(30);
  income.click();
  show.click();
  await tick(30);
  eq([storage.getPref('dueSoon'), storage.getPref('dueSoonDays'), storage.getPref('dueSoonIncome')], ['off', '7', 'off'], 'saved as preferences');
  $('#tab-subs').click();
  await tick(60);
  assert(!shown(), 'off: no chip');
  $('#tab-settings').click();
  await tick(30);
  const backup = JSON.stringify(await storage.exportAll());
  assert(!/dueSoon|due-soon|dueSoonDays/.test(backup), 'not in a backup');
  const settings = await storage.getSettings();
  assert(!Object.keys(settings).some((k) => /due/i.test(k)), 'not a shared setting');
  eq(await storage.pendingCount(), opsBefore, 'no op for sync');
  assert(!/due/i.test(JSON.stringify(await storage.pendingOps())), 'nothing about it queued');
  show.click();
  await tick(30);
  $('#tab-subs').click();
  await tick(60);
  assert(shown(), 'on again');
});

test('empty: with nothing due in the window, no chip and the card keeps its size', async () => {
  const height = card().getBoundingClientRect().height;
  $('#tab-settings').click();
  await tick(30);
  const days = $('#set-due-days');
  days.value = '3';
  days.dispatchEvent(new Event('change', { bubbles: true }));
  window.testClock.set(2026, 10, 23); // the 23rd: next is Salary (income, off), Concert on the 28th
  try {
    $('#tab-subs').click();
    await tick(60);
    for (const v of ['wallet', 'grid', 'list']) {
      await view(v);
      assert(!shown(), `${v}: no chip`);
      assert(chip().hidden, `${v}: hidden, not just empty`);
      eq(card().getBoundingClientRect().height, height, `${v}: the card is the same height`);
    }
  } finally {
    window.testClock.reset();
    days.value = '7';
    days.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await view('wallet');
  await comeBack();
  assert(shown(), 'back with things due');
});

test(`fits this ${innerWidth}px screen: the chip beside Cash due, long names end in an ellipsis; nothing runs out or scrolls sideways`, async () => {
  const problems = [];
  const check = (root) => {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!el.getClientRects().length || el.closest('svg')) continue;
      const cs = getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) problems.push(`${el.className} scrolls sideways`);
      const words = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (words && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 1) problems.push(`${el.tagName}.${el.className} is ${el.scrollWidth}px for ${el.clientWidth}px`);
    }
  };
  for (const v of ['wallet', 'grid', 'list']) { await view(v); check(card()); }
  const c = chip().getBoundingClientRect();
  const r = card().getBoundingClientRect();
  assert(c.right <= r.right && c.left >= r.left, `the chip is inside the card (${c.left}–${c.right} in ${r.left}–${r.right})`);
  const label = $('.mc-label', card()).getBoundingClientRect();
  assert(Math.abs((c.top + c.bottom) / 2 - (label.top + label.bottom) / 2) < 2 && c.left > label.right, 'on the Cash due line, after the label');
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'the page doesn\'t scroll sideways');
  await openSheet();
  check(dueDialog());
  const sum = $('#due-sum');
  assert(sum.scrollWidth <= sum.clientWidth + 1, 'the total is never cut short');
  const name = $('.sub-name', rows().find((x) => x.dataset.id === 't-long'));
  eq(getComputedStyle(name).textOverflow, 'ellipsis', 'a long name truncates');
  assert(name.scrollWidth > name.clientWidth, 'and is cut at this width');
  pressBack();
  await tick(30);
  eq(problems, [], 'text that runs out of its box');
});

test('light and dark: the chip keeps 4.5:1 on the card, the sheet\'s totals on the sheet', async () => {
  for (const theme of ['light', 'dark']) {
    const s = $('#set-theme');
    s.value = theme;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(30);
    // The chip's fill is opaque (a mix of the accent and its ink, --on-accent-soft), so it is the backdrop.
    const back = parseColour(getComputedStyle(chip()).backgroundColor);
    const fg = parseColour(getComputedStyle(chip()).color);
    assert(back && fg && contrast(fg, back) >= 4.5, `${theme}: the chip ${back && fg ? contrast(fg, back).toFixed(2) : '?'}:1`);
    await openSheet();
    const bg = parseColour(getComputedStyle(dueDialog()).backgroundColor);
    for (const el of [$('#due-text'), $('#due-sum'), $('#due-extra')]) {
      const c = parseColour(getComputedStyle(el).color);
      assert(contrast(c, bg) >= 4.5, `${theme}: ${el.id} ${contrast(c, bg).toFixed(2)}:1`);
    }
    pressBack();
    await tick(30);
  }
  const s = $('#set-theme');
  s.value = 'light';
  s.dispatchEvent(new Event('change', { bubbles: true }));
});

test('Reduce motion and effects: the sheet opens and closes, and the chip hides, with no animation frames', async () => {
  // With motion, the sheet slides in.
  await openSheet();
  const moving = document.getAnimations().filter((a) => dueDialog().contains(a.effect?.target) || a.effect?.target === dueDialog());
  assert(moving.some((a) => a.effect.getComputedTiming().duration > 50), 'with motion, the sheet animates');
  pressBack();
  await tick(400);
  $('#tab-settings').click();
  await tick(20);
  if (!$('#set-motion').checked) $('#set-motion').click();
  $('#tab-subs').click();
  await tick(60);
  const longest = () => Math.max(0, ...document.getAnimations()
    .filter((a) => [card(), dueDialog()].some((r) => r.contains(a.effect?.target) || a.effect?.target === r))
    .map((a) => a.effect.getComputedTiming().duration));
  await openSheet();
  assert(longest() <= 0.01, `opening: nothing animates (${longest()} ms)`);
  pressBack();
  assert(longest() <= 0.01, 'closing: nothing animates');
  storage.setPref('dueSoon', 'off');
  await comeBack();
  eq(card().getAnimations({ subtree: true }).length, 0, 'the card has no animations of its own');
  assert(!shown(), 'hidden at once');
  storage.setPref('dueSoon', 'on');
  $('#tab-settings').click();
  await tick(20);
  $('#set-motion').click();
  $('#tab-subs').click();
  await tick(60);
});

/* ---------------------------------------------------------------- run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('reduceMotion', 'off');
  storage.setPref('theme', 'light');
  for (const p of ['groupSort', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed']) localStorage.removeItem(`substracker.${p}`);

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
  }
  for (const [p, v] of Object.entries(savedPrefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
  window.testClock.reset();
  $('#t-report').hidden = false;
  $('#summary').textContent = failures.length ? `${failures.length} of ${results.length} failed` : `All ${results.length} passed`;
  $('#summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  $('#results').innerHTML = results.map(({ name }) => {
    const f = failures.find((x) => x.name === name);
    return `<li class="${f ? 't-fail' : 't-pass'}">${f ? '✗' : '✓'} ${name}${f ? `<div class="t-detail">${f.error.replace(/</g, '&lt;')}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-due-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
