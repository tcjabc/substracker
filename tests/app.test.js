// In-browser tests for the app screens (js/app.js): the Insights month view on a cash basis and
// the "needs a renewal date" notice. Open tests/app.html from a local server. The app runs with
// index.html's markup against a throwaway database, seeded with made-up items dated relative to
// today, so the tests work in any month. The tests run in order, as one session in the app.

import * as storage from '../js/storage.js';
import { money } from '../js/util.js';

const results = [];
const dbName = `substracker-test-app-${Date.now()}`;
const PREFS = ['tab', 'catView', 'view', 'period'];
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

const now = new Date();
const Y = now.getFullYear();
const M = now.getMonth();
const pad = (n) => String(n).padStart(2, '0');
const day = (y, m, d) => { const x = new Date(y, m, d); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// Due this month: Phone 499 + Cloud 1,200 (annual, stored two years ago, rolled forward) = 1,699.
// Not due: Domain (annual, six months away). Undated: Gym 900 /mo and Yoga 1,200 /yr.
// Year: (499 + 900) × 12 + 1,200 + 360 + 1,200 = 19,548, so Avg = 1,629.
const SEED = [
  { ...base, id: 'test-phone', name: 'Phone', price: 499, cycle: 'monthly', nextRenewal: day(Y, M, 5), category: 'Utilities' },
  { ...base, id: 'test-cloud', name: 'Cloud', price: 1200, cycle: 'annual', nextRenewal: day(Y - 2, M, 15), category: 'Utilities' },
  { ...base, id: 'test-domain', name: 'Domain', price: 360, cycle: 'annual', nextRenewal: day(Y, M + 6, 1) },
  { ...base, id: 'test-gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
  { ...base, id: 'test-yoga', name: 'Yoga', price: 1200, cycle: 'annual', nextRenewal: '', category: 'Health' },
];

const dialog = () => $('#sub-dialog');
const isOpen = () => dialog().open || dialog().hasAttribute('open');
const notice = () => $('#insights .notice-action');

/* ---------------------------------------------------------------- Insights */

test('headline card shows the cash due this month, with the Avg line', async () => {
  const card = $('#insights .stat-primary');
  eq(text($('.stat-value', card)), T(1699), 'cash due');
  eq($$('.stat-sub', card).map(text), ['Cash due this month', `Avg ${T(1629)}/mo`], 'subtitle and Avg');
});

test('the yearly card keeps its figure (monthly × 12 + annual + one-offs)', async () => {
  const year = $$('#insights .stat')[1];
  eq(text($('.stat-label', year)), String(Y), 'year label');
  eq(text($('.stat-value', year)), T(19548), 'year total');
});

test('the income bar, the donut and the category list all use the month cash total', async () => {
  assert(text($('#insights .headline-text')).includes(T(1699)), 'headline uses the cash total');
  $('#insights [data-catview="donut"]').click();
  eq(text($('#insights .donut-total')), T(1699), 'donut centre');
  const legend = $$('#insights .legend-row .legend-name').map(text);
  eq(legend, ['Utilities'], 'only categories with something due');
  $('#insights [data-catview="list"]').click();
  eq($$('#insights .cat-row .cat-amount').map((el) => el.firstChild.textContent.trim()), [T(1699)], 'category list total');
  eq(text($$('#insights .stat')[2].querySelector('.stat-sub')), '1 monthly · 1 annual · 0 one-off', 'items due');
});

test('the notice names the undated plans and their amount', async () => {
  eq(text(notice()), `2 plans need a renewal date, ${T(2100)} not shown`, 'notice text');
});

test('tapping the notice opens the first undated plan for editing', async () => {
  notice().click();
  await until(isOpen, 'edit sheet opens');
  eq(text($('#sub-dialog-title')), 'Edit expense', 'edit title');
  eq(dialog().querySelector('[name="name"]').value, 'Gym', 'first undated plan, A–Z');
  eq(dialog().querySelector('[name="nextRenewal"]').value, '', 'date not filled in');
  $('#sub-dialog [data-close]').click();
  await until(() => !isOpen(), 'sheet closes');
});

/* ------------------------------------------------------------------ Runner */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  storage.setPref('tab', 'insights');
  storage.setPref('catView', 'donut');

  // Bring in the app's own markup, then the app itself (which starts on import).
  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#insights .stat-primary'), 'Insights rendered');

  const list = document.getElementById('results');
  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    const li = document.createElement('li');
    try {
      await fn();
      passed++;
      li.className = 't-pass';
      li.textContent = `✓ ${name}`;
    } catch (err) {
      failures.push({ name, error: err.message });
      li.className = 't-fail';
      li.append(`✗ ${name}`);
      const d = document.createElement('div');
      d.className = 't-detail';
      d.textContent = err.message;
      li.append(d);
    }
    list.append(li);
  }
  for (const [p, v] of Object.entries(savedPrefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
  const total = results.length;
  document.getElementById('summary').textContent = failures.length
    ? `${failures.length} of ${total} failed` : `All ${total} passed`;
  document.getElementById('summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  window.testResults = { total, passed, failures, dbName };
  // The app keeps its database open; delete it once the page is gone (next load clears old ones).
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

// Clear databases left by earlier runs of this page.
(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-app-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => {
    document.getElementById('summary').textContent = `Setup failed: ${err.message}`;
    document.getElementById('summary').className = 't-summary t-fail';
    window.testResults = { total: results.length, passed: 0, failures: [{ name: 'setup', error: err.message }] };
  });
})();
