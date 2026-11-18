// In-browser tests for the Money tab's due-soon banner (js/due-soon.js, js/app.js), run by
// tests/due-soon.html with a fixed clock (18 November 2026) against a throwaway database. The app
// runs with index.html's markup. Run the page at 320, 360 and 393px: the layout tests check the
// width they're given. The tests run in order, as one session in the app.

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

const banner = () => $('#due-banner');
const shown = () => !banner().hidden && banner().getClientRects().length > 0;
const dueDialog = () => $('#due-dialog');
const open = (d) => d.open || d.hasAttribute('open');
const subDialog = () => $('#sub-dialog');
const rows = () => $$('#due-list .due-row');
const view = async (v) => { $(`.seg-btn[data-view="${v}"]`).click(); await tick(60); };
// Draw the Money tab again the way the app does when it comes back to the front.
const comeBack = async () => { document.dispatchEvent(new Event('visibilitychange')); await tick(60); };
const closeSheets = async () => {
  for (const d of $$('dialog[open]')) d.close();
  await tick(30);
};

/* ---------------------------------------------------------------- tests */

test('shown under the strip in Wallet, Grid and List: the count, the TWD total, +1 in USD, the need-a-date line', async () => {
  for (const v of ['wallet', 'grid', 'list']) {
    await view(v);
    assert(shown(), `${v}: the banner is shown`);
    const strip = $('#money-summary').getBoundingClientRect();
    const b = banner().getBoundingClientRect();
    const list = $('#subs-list').getBoundingClientRect();
    assert(b.top >= strip.bottom && b.bottom <= list.top, `${v}: between the strip (${strip.bottom}) and the groups (${list.top}): ${b.top}–${b.bottom}`);
    eq(text($('#due-text')), '5 due in the next 7 days', `${v}: the count`);
    eq(text($('#due-sum')), T(1239), `${v}: the TWD total of the listed items`);
    eq(text($('#due-extra')), '+1 in USD', `${v}: other currencies, counted apart`);
    eq(text($('#due-undated')), '1 item needs a date', `${v}: the undated line`);
    eq($('#due-toggle').getAttribute('aria-label'), `5 due in the next 7 days · ${T(1239)} due · +1 in USD`, `${v}: the toggle's full label`);
  }
  await view('wallet');
});

test('ARIA: a labelled region; the toggle has aria-expanded and opens a dialog; no live region', async () => {
  eq(banner().tagName, 'SECTION', 'a section');
  eq(banner().getAttribute('aria-label'), 'Due soon', 'labelled, so it is a region');
  eq($('#due-toggle').getAttribute('aria-expanded'), 'false', 'collapsed');
  eq($('#due-toggle').getAttribute('aria-haspopup'), 'dialog', 'opens a dialog');
  eq($('#due-close').getAttribute('aria-label'), 'Hide until tomorrow', 'the close button says what it does');
  eq($$('[aria-live], [role="status"], [role="alert"]', banner()).length + $$('[aria-live], [role="status"], [role="alert"]', dueDialog()).length, 0, 'announces nothing by itself');
});

test('the sheet: by date, then name, with relative days; full row labels; Back closes it', async () => {
  $('#due-toggle').click();
  await until(() => open(dueDialog()), 'the due-soon sheet');
  eq($('#due-toggle').getAttribute('aria-expanded'), 'true', 'expanded while open');
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
  await tick(30);
  assert(!open(dueDialog()), 'Back closed the sheet');
  eq($('#due-toggle').getAttribute('aria-expanded'), 'false', 'collapsed again');
});

test('a row opens the item in the edit sheet; the need-a-date line opens the undated item', async () => {
  $('#due-toggle').click();
  await until(() => open(dueDialog()), 'the due-soon sheet');
  rows()[2].click();
  await until(() => open(subDialog()), 'the edit sheet');
  assert(!open(dueDialog()), 'the list closed');
  eq($('#sub-form').elements.name.value, 'Phone', 'the tapped item');
  assert(document.body.classList.contains('sheet-open'), 'the floating buttons stay hidden under the edit sheet');
  pressBack();
  await tick(60);
  assert(!open(subDialog()), 'closed');
  $('#due-undated').click();
  await until(() => open(subDialog()), 'the edit sheet for the undated item');
  eq($('#sub-form').elements.name.value, 'Gym', 'the first undated item');
  pressBack();
  await tick(60);
});

test('Grid and List: the banner expands to the same sheet, and closing it gives its space back', async () => {
  for (const v of ['grid', 'list']) {
    await view(v);
    $('#due-toggle').click();
    await until(() => open(dueDialog()), `${v}: the sheet`);
    eq(rows().length, 5, `${v}: the same rows`);
    pressBack();
    await tick(30);
    assert(!open(dueDialog()), `${v}: Back closed it`);
    const before = $('#subs-list').getBoundingClientRect().top;
    $('#due-close').click();
    await tick(60);
    assert(!shown(), `${v}: dismissed`);
    const after = $('#subs-list').getBoundingClientRect().top;
    assert(after < before, `${v}: the groups move up (${before} → ${after})`);
    storage.setPref('dueSoonDismissed', '');
    await comeBack();
    assert(shown(), `${v}: back`);
  }
  await view('wallet');
});

test('nothing is written: a rolled-forward date stays as stored, and no sync op is made', async () => {
  const before = await storage.pendingCount();
  await comeBack();
  $('#due-toggle').click();
  await until(() => open(dueDialog()), 'sheet');
  pressBack();
  await tick(30);
  eq(await storage.pendingCount(), before, 'no ops');
  const old = (await storage.getAll()).find((s) => s.id === 't-old');
  eq(old.nextRenewal, '2025-06-21', 'the stored date is untouched');
});

/** The last Wallet card, scrolled to the end of the stack, sits clear of the + / - buttons. */
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
  assert(bottom <= fab.top + 1, `${label}: the last card's face ends at ${Math.round(bottom)}, above the buttons at ${Math.round(fab.top)}`);
  assert(bottom <= bar.top + 1, `${label}: and above the tab bar (${Math.round(bar.top)})`);
  assert(document.documentElement.scrollWidth <= innerWidth + 1, `${label}: no sideways scroll`);
  const top = $('#wallet').getBoundingClientRect().top + scrollY;
  bands[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  await tick(900);
  window.scrollTo(0, 0);
  await tick(40);
  return top;
}

test('Wallet: the last card clears the + / - buttons with the banner shown, turned off and dismissed', async () => {
  const withBanner = await lastCardClear('banner shown');
  storage.setPref('dueSoon', 'off');
  await comeBack();
  assert(!shown(), 'turned off: hidden');
  const without = await lastCardClear('banner off');
  assert(without < withBanner, `the stack moves up without the banner (${without} < ${withBanner})`);
  eq(getComputedStyle($('#money-summary')).marginBottom, '24px', 'without the banner the strip keeps its usual gap');
  storage.setPref('dueSoon', 'on');
  await comeBack();
  assert(shown(), 'on again');
  eq(await lastCardClear('banner shown again'), withBanner, 'back where it was');
  $('#due-close').click();
  await tick(80);
  assert(!shown(), 'dismissed: hidden');
  eq(await lastCardClear('banner dismissed'), without, 'the stack takes the space at once, no gap');
});

test('dismiss: hidden for the rest of today on this device; back the next day; back at once when the window changes', async () => {
  eq(storage.getPref('dueSoonDismissed'), '2026-11-18', 'today\'s local date, on this device');
  await comeBack();
  assert(!shown(), 'still hidden later today');
  window.testClock.set(2026, 10, 18, 23);
  await comeBack();
  assert(!shown(), 'still hidden at 23:00');
  window.testClock.set(2026, 10, 19, 0);
  await comeBack();
  assert(shown(), 'back the next day, just after midnight');
  eq(text($('#due-text')), '4 due in the next 7 days', 'Streaming has moved to next month; the window now ends on the 26th');
  window.testClock.reset();
  await comeBack();
  $('#due-close').click();
  await tick(60);
  assert(!shown(), 'dismissed again');
  $('#tab-settings').click();
  await tick(40);
  const days = $('#set-due-days');
  days.value = '14';
  days.dispatchEvent(new Event('change', { bubbles: true }));
  $('#tab-subs').click();
  await tick(80);
  assert(shown(), 'a new window shows it again at once');
  eq(text($('#due-text')), '7 due in the next 14 days', 'and uses the new window');
});

test('settings: on, 7 days and income off by default; per device; never in a backup, the settings or the sync outbox', async () => {
  $('#tab-settings').click();
  await tick(40);
  const show = $('#set-due');
  const days = $('#set-due-days');
  const income = $('#set-due-income');
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
  eq(text($('#due-text')), '6 due in the next 7 days', 'Salary on day 7 is in');
  eq(text($('#due-sum')), T(1239), 'the expenses total is unchanged: income is never added to it');
  eq(text($('#due-extra')), `${T(40000)} coming in · +1 in USD`, 'income has its own figure');
  $('#due-toggle').click();
  await until(() => open(dueDialog()), 'sheet');
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

test('empty: with nothing due in the window, no banner and no gap', async () => {
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
      assert(!shown(), `${v}: no banner`);
      const strip = $('#money-summary').getBoundingClientRect();
      const list = $('#subs-list').getBoundingClientRect();
      // As without a banner: the Wallet's pile uses the strip's 24px margin (4px left), Grid and List leave it.
      eq(Math.round(list.top - strip.bottom), v === 'wallet' ? 4 : 24, `${v}: the usual gap under the strip, no empty strip`);
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

test(`fits this ${innerWidth}px screen: long names end in an ellipsis; nothing runs out or scrolls sideways`, async () => {
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
  for (const v of ['wallet', 'grid', 'list']) { await view(v); check(banner()); }
  const b = banner().getBoundingClientRect();
  assert(b.right <= innerWidth + 0.5 && b.left >= 0, `the banner is on screen (${b.left}–${b.right})`);
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'the page doesn\'t scroll sideways');
  const sum = $('#due-sum');
  assert(sum.scrollWidth <= sum.clientWidth + 1, 'the total is never cut short');
  $('#due-toggle').click();
  await until(() => open(dueDialog()), 'sheet');
  check(dueDialog());
  const name = $('.sub-name', rows().find((r) => r.dataset.id === 't-long'));
  eq(getComputedStyle(name).textOverflow, 'ellipsis', 'a long name truncates');
  assert(name.scrollWidth > name.clientWidth, 'and is cut at this width');
  pressBack();
  await tick(30);
  eq(problems, [], 'text that runs out of its box');
});

test('light and dark: the banner\'s text keeps 4.5:1 on its card', async () => {
  for (const theme of ['light', 'dark']) {
    const s = $('#set-theme');
    s.value = theme;
    s.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(30);
    const bg = parseColour(getComputedStyle(banner()).backgroundColor);
    for (const el of [$('#due-text'), $('#due-sum'), $('#due-extra')]) {
      const fg = parseColour(getComputedStyle(el).color);
      assert(contrast(fg, bg) >= 4.5, `${theme}: ${el.id} ${contrast(fg, bg).toFixed(2)}:1`);
    }
  }
  const s = $('#set-theme');
  s.value = 'light';
  s.dispatchEvent(new Event('change', { bubbles: true }));
});

test('Reduce motion and effects: the sheet opens and closes, and the banner hides, with no animation frames', async () => {
  // With motion, the sheet slides in.
  $('#due-toggle').click();
  await until(() => open(dueDialog()), 'sheet');
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
    .filter((a) => [banner(), dueDialog()].some((r) => r.contains(a.effect?.target) || a.effect?.target === r))
    .map((a) => a.effect.getComputedTiming().duration));
  $('#due-toggle').click();
  await until(() => open(dueDialog()), 'sheet');
  assert(longest() <= 0.01, `opening: nothing animates (${longest()} ms)`);
  pressBack();
  assert(longest() <= 0.01, 'closing: nothing animates');
  const before = banner().getAnimations({ subtree: true }).length;
  $('#due-close').click();
  eq(before + banner().getAnimations({ subtree: true }).length, 0, 'the banner has no animations of its own');
  assert(!shown(), 'hidden at once, in the same frame');
  $('#tab-settings').click();
  await tick(20);
  $('#set-motion').click();
  storage.setPref('dueSoonDismissed', '');
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
