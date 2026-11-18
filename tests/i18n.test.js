// Language tests in the browser, run inside tests/i18n-frame.html (tests/i18n.html runs the frames).
// The app runs with index.html's markup against a throwaway database, with a fixed clock
// (18 November 2026) and fixed items, so every screen reads the same on every run.
//
// ?mode=en      walks the key screens and compares their English text and labels with the recording
//               in tests/fixtures/i18n-en-snapshot.json, made from 1.15.0 before any text moved into
//               js/locales/en.js: English must read exactly as it did. It also checks the language
//               setting (per device, never exported or synced) and the document's lang.
// ?mode=pseudo  (with ?lang=xx) walks the same screens in the pseudo-locale and reports any text or
//               label that isn't wrapped in [ ], i.e. text that would stay English in a translation.
//
// To record the snapshot again (only when English wording is meant to change): run tests/i18n.html,
// then save window.testDump over tests/fixtures/i18n-en-snapshot.json.

import * as storage from '../js/storage.js';
import { overlays, pressBack } from '../js/overlays.js';
import * as util from '../js/util.js';
import * as pairing from '../js/pairing.js';
import * as aiImport from '../js/import-ai.js';
import { wordProblems } from '../js/words.js';
import { ScanError, notRecoveryMessage } from '../js/qr-scan.js';
import { keyNeededMessage } from '../js/sync.js';
import * as i18n from '../js/i18n.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'pseudo' ? 'pseudo' : 'en';
const results = [];
const dbName = `substracker-test-i18n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'catView', 'view', 'groupSort', 'period', 'insightsMode', 'yearRange', 'yearStack', 'yearKey', 'theme', 'reduceMotion', 'lang'];
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
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t = 0; t < ms; t += 25) { if (cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
// Fixed dates around "today", 18 November 2026. No domains, so no logo requests.
const SEED = [
  { ...base, type: 'income', id: 't-salary', name: 'Salary', emoji: '💼', price: 40000, cycle: 'monthly', nextRenewal: '2026-11-25' },
  { ...base, type: 'income', id: 't-bonus', name: 'Bonus', price: 12000, cycle: 'annual', nextRenewal: '2027-01-10' },
  { ...base, id: 't-rent', name: 'Rent', price: 30000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'House' },
  { ...base, id: 't-phone', name: 'Phone', plan: 'Unlimited', price: 499, cycle: 'monthly', nextRenewal: '2026-11-20', category: 'Utilities' },
  { ...base, id: 't-cloud', name: 'Cloud', price: 1200, cycle: 'annual', nextRenewal: '2027-03-15', category: 'Utilities' },
  { ...base, id: 't-stream', name: 'Streaming', emoji: '🎬', price: 390, cycle: 'monthly', nextRenewal: '2026-11-18', category: 'Entertainment' },
  { ...base, id: 't-concert', name: 'Concert', price: 1500, cycle: 'once', date: '2026-11-28', category: 'Entertainment' },
  { ...base, id: 't-gym', name: 'Gym', price: 900, cycle: 'monthly', nextRenewal: '', category: 'Health' },
  { ...base, id: 't-misc', name: 'Stamps', price: 60, cycle: 'once', date: '2027-02-02' },
  { ...base, currency: 'USD', id: 't-tool', name: 'Tool', price: 10, cycle: 'monthly', nextRenewal: '2026-11-22', category: 'Utilities' },
];
// What the person typed: never translated, so the pseudo-locale check allows it.
const USER_TEXT = [...new Set(SEED.flatMap((s) => [s.name, s.plan, s.category]).filter(Boolean))];

const AI_REPLY = JSON.stringify({
  version: 1,
  rows: [
    { name: 'Example Streaming', amount: 390, currency: 'TWD', cycle: 'monthly', nextDate: '2026-12-05', category: 'Entertainment', type: 'expense' },
    { name: 'Water bill', amount: 800, currency: 'TWD', cycle: 'monthly', nextDate: '', category: 'Utilities', type: 'expense' },
    { name: 'Magazine', amount: 120, currency: 'TWD', cycle: 'weekly', nextDate: '2026-12-01', category: 'News', type: 'expense' },
    { name: 'Phone', amount: 499, currency: 'TWD', cycle: 'monthly', nextDate: '2026-11-20', category: 'Utilities', type: 'expense' },
    { name: 'Mystery', amount: -5, currency: 'XYZ', cycle: 'monthly', nextDate: '2026-12-01', category: '', type: 'expense' },
    { name: 'Side job', amount: 5000, currency: 'TWD', cycle: 'one-off', nextDate: '2026-12-10', category: '', type: 'income' },
  ],
});
const AI_TEXT = ['Example Streaming', 'Water bill', 'Magazine', 'Mystery', 'Side job', 'News', 'weekly', 'XYZ'];

/* ------------------------------------------------------------------ the walk */

const LABEL_ATTRS = ['aria-label', 'title', 'placeholder', 'aria-valuetext', 'aria-roledescription', 'alt'];
/** The text of `root` (whitespace collapsed) and every label inside it, as lines. */
function grab(root, { skip = [] } = {}) {
  if (!root) return ['(missing)'];
  const copy = root.cloneNode(true);
  for (const sel of skip) $$(sel, copy).forEach((e) => e.remove());
  const lines = [norm(copy.textContent)];
  for (const e of [copy, ...copy.querySelectorAll('*')]) {
    for (const a of LABEL_ATTRS) {
      const v = e.getAttribute?.(a);
      if (v) lines.push(`${a}=${norm(v)}`);
    }
  }
  return lines;
}
const snap = {};
const put = (key, lines) => { snap[key] = Array.isArray(lines) ? lines.map(norm) : [norm(lines)]; };
const dialogShown = (id) => { const d = $(`#${id}`); return d.open || d.hasAttribute('open'); };

async function walk() {
  // The header, tabs and Money tab (Wallet).
  $('#tab-subs').click();
  await until(() => $('#wallet .w-band'), 'wallet drawn');
  put('doc', [document.title, `lang=${document.documentElement.lang}`]);
  put('header', grab($('.app-header')));
  put('tabbar', grab($('.tabbar')));
  put('fab', grab($('#fab-stack')));
  put('money.strip.monthly', grab($('#money-summary')));
  put('wallet.host', [$('#wallet').getAttribute('aria-label')]);
  $$('#wallet .w-band').forEach((b, i) => put(`wallet.card.${i}`, grab(b.closest('.w-card') ?? b.parentElement, { skip: ['.w-logos'] })));
  const firstBand = $('#wallet .w-band');
  firstBand.click();
  await tick(120);
  put('wallet.announce.open', [$('#wallet > p.sr-only')?.textContent]);
  pressBack();
  await tick(120);
  put('wallet.announce.close', [$('#wallet > p.sr-only')?.textContent]);

  $('#money-summary [data-period="annual"]').click();
  await tick(20);
  put('money.strip.annual', grab($('#money-summary')));
  $$('#wallet .w-band').forEach((b, i) => put(`wallet.annual.band.${i}`, [b.getAttribute('aria-label'), norm(b.textContent)]));
  $('#money-summary [data-period="monthly"]').click();

  // Sort.
  put('sort.button', [$('#sort-btn').getAttribute('aria-label'), $('#sort-btn').title]);
  $('#sort-btn').click();
  await tick(20);
  put('sort.menu', grab($('#sort-menu')));
  $('#sort-menu [data-sort="total"]').click();
  await tick(20);
  put('sort.total', [$('#sort-btn').getAttribute('aria-label')]);
  $('#sort-btn').click();
  $('#sort-menu [data-sort="items"]').click();
  await tick(20);
  put('sort.items', [$('#sort-btn').getAttribute('aria-label')]);
  $('#sort-btn').click();
  $('#sort-menu [data-sort="az"]').click();
  await tick(20);

  // Grid and List.
  $('.seg-btn[data-view="grid"]').click();
  await tick(20);
  put('money.grid', grab($('#subs-list')));
  $('.group-dot').click();
  await tick(20);
  put('money.swatches', grab($('#swatch-pop')));
  pressBack();
  $('.seg-btn[data-view="list"]').click();
  await tick(20);
  put('money.list', grab($('#subs-list')));

  // The add / edit sheet.
  $('#fab').click();
  await until(() => dialogShown('sub-dialog'), 'add sheet');
  put('form.new.expense', grab($('#sub-dialog')));
  $('#sub-form button[type="submit"]').click();
  await tick(20);
  put('form.errors.expense', $$('#sub-form .field-error').map((e) => e.textContent));
  $('#sub-form input[name="kind"][value="income"]').click();
  await tick(20);
  put('form.new.income', grab($('#sub-dialog')));
  $('#sub-form button[type="submit"]').click();
  await tick(20);
  put('form.errors.income', $$('#sub-form .field-error').map((e) => e.textContent));
  $('#sub-form input[name="cycle"][value="once"]').click();
  await tick(20);
  put('form.new.income.once', grab($('#sub-dialog')));
  $('#sub-dialog [data-close]').click();
  await tick(20);
  $('#subs-list .sub-row[data-id="t-phone"]').click();
  await until(() => dialogShown('sub-dialog'), 'edit sheet');
  put('form.edit', [$('#sub-dialog-title').textContent, $('#btn-delete').textContent]);
  $('#btn-delete').click();
  await until(() => dialogShown('confirm-dialog'), 'delete confirmation');
  put('confirm.delete', grab($('#confirm-dialog')));
  $('#confirm-actions button').click();
  await tick(20);
  $('#sub-dialog [data-close]').click();
  await tick(20);
  $('.seg-btn[data-view="wallet"]').click();
  await tick(20);

  // Insights, month: the flat donut standing in for the Ring (Reduce motion is on), Donut, List.
  $('#tab-insights').click();
  await until(() => $('#insights .stat-primary'), 'Insights drawn');
  put('doc.insights', [document.title, $('#page-title').textContent]);
  put('insights.chips', grab($('#currency-chips')));
  put('insights.month.ring', grab($('#insights')));
  $('#insights [data-catview="donut"]').click();
  await tick(20);
  put('insights.month.donut', grab($('#insights')));
  $('#insights [data-catview="list"]').click();
  await tick(20);
  put('insights.month.list', grab($('#insights')));
  $('#insights [data-month-step="-1"]').click();
  await tick(20);
  put('insights.month.previous', grab($('#insights .headline')).concat(grab($('#insights .stats'))));
  $('#insights [data-month-step="1"]').click();
  await tick(20);
  $('#currency-chips [data-currency="USD"]').click();
  await tick(20);
  put('insights.month.usd', grab($('#insights .headline')).concat(grab($('#insights .stats'))));
  $('#currency-chips [data-currency="TWD"]').click();
  await tick(20);

  // Insights, year: the chart, its key, and the yearly card.
  $('#insights [data-insights-mode="year"]').click();
  await until(() => $('#year-chart svg'), 'year chart drawn');
  await tick(50);
  put('insights.year', grab($('#insights')));
  $('#year-chart .yc-keybtn').click();
  await tick(20);
  put('insights.year.key', grab($('#year-chart .yc-keybox')));
  $('#year-chart .yc-keybtn').click();
  $('#insights [data-year-income]').click();
  await until(() => $('#year-chart svg'), 'year chart with income');
  await tick(50);
  put('insights.year.income', grab($('#year-chart')));
  $('#insights [data-year-income]').click();
  await tick(20);
  $('#insights [data-insights-mode="month"]').click();
  await tick(20);

  // Settings (not the developer screen, not the version line).
  $('#tab-settings').click();
  await tick(20);
  put('doc.settings', [document.title, $('#page-title').textContent]);
  // The language picker is hidden until a second locale exists; hidden, it isn't part of the screen.
  put('settings', grab($('#panel-settings'), { skip: ['#dev-sync', '#app-version', '#lang-row[hidden]'] }));

  // Sync sheet: every step's text, then a Join with wrong words.
  $('#btn-sync').click();
  await until(() => dialogShown('sync-dialog'), 'sync sheet');
  put('sync.sheet', grab($('#sync-dialog')));
  put('sync.summary', [$('#sync-summary').textContent, $('#btn-sync').textContent]);
  $('#sync-join-open').click();
  await tick(20);
  $('#sync-join-words').value = 'abandon abilty zebra';
  $('#sync-join').click();
  await tick(50);
  put('sync.join.problems', $$('#sync-join-problems li').map((li) => li.textContent));
  $('[data-sync-view="join"] [data-sync-back]').click();
  await tick(20);
  $('[data-sync-close]').click();
  await tick(20);

  // Import with AI: the warning (locked, then unlocked), the prompt step, a bad reply, the review.
  $('#btn-import-ai').click();
  await until(() => dialogShown('ai-dialog'), 'AI sheet');
  put('ai.sheet', grab($('#ai-dialog'), { skip: ['#ai-prompt-text'] }));
  await until(() => !$('#ai-slide [data-slide-check]').disabled, 'slider unlocked', 4000);
  put('ai.warning.unlocked', grab($('#ai-slide')));
  $('#ai-slide [data-slide-check]').click();
  await tick(20);
  put('ai.warning.confirmed', grab($('#ai-slide')));
  $('#ai-continue').click();
  await tick(20);
  $('#ai-reply').value = 'hello';
  $('#ai-review').click();
  await tick(20);
  put('ai.reply.error', grab($('#ai-reply-error')));
  $('#ai-reply').value = '{"version": 2, "rows": []}';
  $('#ai-review').click();
  await tick(20);
  put('ai.reply.error.version', grab($('#ai-reply-error')));
  $('#ai-reply').value = AI_REPLY;
  $('#ai-review').click();
  await until(() => !$('[data-ai-view="review"]').hidden, 'review step');
  put('ai.review', grab($('[data-ai-view="review"]')));
  $('#ai-import').click();
  await until(() => dialogShown('confirm-dialog'), 'import choice');
  put('ai.choice', grab($('#confirm-dialog')));
  $('#confirm-actions button').click();
  await tick(20);
  $('[data-ai-close]').click();
  await tick(20);

  // Wording that comes from functions rather than a screen.
  const preview = (o) => ({
    merge: { total: 5, existing: 3, added: 2, updated: 1, kept: 2, removed: 0, newerVersion: false, withSettings: true, ...o },
    replace: { total: 5, existing: 3, added: 2, updated: 3, kept: 0, removed: 1, newerVersion: false, withSettings: true, ...o },
  });
  put('fn.importMessage', [
    util.importMessage(preview({})), util.importMessage(preview({}), { synced: true }),
    util.importMessage(preview({ existing: 0, kept: 0 })), util.importMessage(preview({ newerVersion: true, total: 1, added: 1, kept: 0 })),
  ]);
  put('fn.replaceConfirm', [JSON.stringify(util.replaceConfirm()), JSON.stringify(util.replaceConfirm({ synced: true }))]);
  put('fn.backupLabel', [util.backupLabel(0), util.backupLabel(1), util.backupLabel(4), util.backupLabel(4, true)]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const inDays = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
  put('fn.renewalText', [0, 1, 3, 6, 9, 60].flatMap((n) => [util.renewalText(inDays(n)), util.renewalText(inDays(n), true)]));
  put('fn.shortDate', [util.shortDate(inDays(10)), util.shortDate(inDays(400))]);
  put('fn.cycleLabel', ['monthly', 'annual', 'once'].map(util.cycleLabel));
  const asked = [];
  await pairing.confirmStart({ wasPaired: true }, async (o) => { asked.push(JSON.stringify(o)); return false; });
  put('fn.pairing', [
    JSON.stringify(pairing.replaceConfirm(1)), JSON.stringify(pairing.replaceConfirm(3)), ...asked,
    JSON.stringify(pairing.TURN_OFF_CONFIRM), JSON.stringify(pairing.SHOW_WORDS_CONFIRM),
    ...['off', 'syncing', 'ok', 'offline', 'error'].map((s) => pairing.statusText({ state: s })),
    pairing.statusText({ state: 'error', lastError: 'Boom.' }), pairing.statusText({ state: 'ok', lastError: 'Late.' }),
    pairing.summaryText(null), pairing.summaryText({ paired: true, keyUnavailable: true }),
    pairing.summaryText({ paired: true, enabled: false }), pairing.summaryText({ paired: true, enabled: true }, { state: 'ok' }),
  ]);
  put('fn.aiImport', [
    aiImport.aiImportMessage({ total: 3, existing: 0 }), aiImport.aiImportMessage({ total: 3, existing: 7 }, { synced: true }),
    JSON.stringify(aiImport.aiReplaceConfirm()), JSON.stringify(aiImport.aiReplaceConfirm({ synced: true })), aiImport.AI_CHOICE_TITLE,
  ]);
  put('fn.words', ['', 'abandon', 'abandon abilty able about above absent absorb abstract absurd abuse access accident']
    .flatMap((w) => wordProblems(w).map((p) => p.message)));
  put('fn.scan', [notRecoveryMessage(), ...['denied', 'unavailable', 'noPlayServices', 'installing', 'installFailed', 'failed', 'other'].map((c) => new ScanError(c).message)]);
  put('fn.sync', [keyNeededMessage()]);
  put('fn.importErrors', ['', '[]', '{"app":"x"}', '{"app":"substracker","schemaVersion":4,"items":[]}',
    '{"app":"substracker","schemaVersion":4,"items":[{"id":"a","name":"A","price":-1,"currency":"TWD","cycle":"monthly"}]}']
    .map((j) => { try { storage.parseBackup(j); return 'ok'; } catch (err) { return err.message; } }));
}

/* ------------------------------------------------------------------ tests */

if (MODE === 'en') {
  test('English reads exactly as it did in 1.15.0 on every recorded screen', async () => {
    const res = await fetch('fixtures/i18n-en-snapshot.json', { cache: 'no-store' });
    assert(res.ok, 'tests/fixtures/i18n-en-snapshot.json is missing (record it: see the top of this file)');
    const fixture = await res.json();
    if (fixture.locale !== navigator.language) {
      throw new Error(`the recording was made in a ${fixture.locale} browser and this one is ${navigator.language}: dates and numbers differ, so compare in ${fixture.locale}`);
    }
    const diffs = [];
    for (const key of new Set([...Object.keys(fixture.screens), ...Object.keys(snap)])) {
      const a = JSON.stringify(snap[key] ?? null);
      const e = JSON.stringify(fixture.screens[key] ?? null);
      if (a !== e) diffs.push(`${key}\n    expected ${e}\n    actual   ${a}`);
    }
    assert(!diffs.length, `${diffs.length} screen(s) differ:\n  ${diffs.join('\n  ')}`);
  });

  test("index.html's own English is the dictionary's, so the page reads the same before the script runs", async () => {
    const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const roots = [doc, ...[...doc.querySelectorAll('template')].map((tpl) => tpl.content)];
    const own = (el) => norm(el.children.length ? [...el.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim())?.nodeValue : el.textContent);
    const bad = [];
    let n = 0;
    for (const r of roots) {
      for (const el of r.querySelectorAll('[data-i18n]')) { n++; if (own(el) !== i18n.t(el.dataset.i18n)) bad.push(`${el.dataset.i18n}: "${own(el)}" vs "${i18n.t(el.dataset.i18n)}"`); }
      for (const el of r.querySelectorAll('[data-i18n-html]')) { n++; if (norm(el.innerHTML) !== norm(i18n.tHTML(el.dataset.i18nHtml))) bad.push(el.dataset.i18nHtml); }
      for (const el of r.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of el.dataset.i18nAttr.split(';')) {
          const [a, k] = pair.split(':').map((x) => x.trim());
          n++;
          if (el.getAttribute(a) !== i18n.t(k)) bad.push(`${k} (${a}): "${el.getAttribute(a)}" vs "${i18n.t(k)}"`);
        }
      }
    }
    assert(n > 150, `found the markup keys (${n})`);
    eq(bad, [], 'markup text that differs from js/locales/en.js');
  });

  test('the language: English, lang="en", per device, never in a backup, the settings or the sync outbox', async () => {
    eq(document.documentElement.lang, 'en', 'document lang');
    eq(i18n.getLocale(), 'en', 'active locale');
    eq(i18n.getLangSetting(), 'auto', 'a fresh device follows the device');
    assert($('#lang-row').hidden, 'the picker is hidden while English is the only language');
    eq($$('#set-lang option').map((o) => o.value), ['auto', 'en'], 'Same as device, then each locale');
    eq($('#set-lang').value, 'auto', 'showing the setting');
    const opsBefore = await storage.pendingCount();
    eq(i18n.saveLangSetting('en'), 'en', 'saved');
    eq(localStorage.getItem('substracker.lang'), 'en', 'kept on this device');
    const backup = JSON.stringify(await storage.exportAll());
    assert(!/"lang"|substracker\.lang|"language"/.test(backup), 'not in a backup');
    const settings = await storage.getSettings();
    assert(!('lang' in settings) && !('language' in settings), 'not a shared setting');
    eq(await storage.pendingCount(), opsBefore, 'no op for sync');
    assert(!/lang/.test(JSON.stringify(await storage.pendingOps())), 'nothing about it queued');
    eq(i18n.saveLangSetting('auto'), 'auto', 'back to the device');
    eq(localStorage.getItem('substracker.lang'), null, 'auto is not stored');
  });
}

/* ------------------------------------------------------------------ run */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('insightsMode', 'month');
  storage.setPref('yearRange', 'roll');
  storage.setPref('reduceMotion', 'on'); // no animations: every figure is plain text at once
  storage.setPref('theme', 'light');
  for (const p of ['catView', 'yearStack', 'yearKey', 'groupSort', 'lang']) localStorage.removeItem(`substracker.${p}`);

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#wallet .w-band'), 'app drawn');

  let walkError = null;
  try { await walk(); } catch (err) { walkError = err; }
  const all = walkError ? [{ name: 'walk the screens', fn: () => { throw walkError; } }] : results;

  let passed = 0;
  const failures = [];
  for (const { name, fn } of all) {
    try { await fn(); passed++; } catch (err) { failures.push({ name: `${MODE}: ${name}`, error: err.message }); }
  }
  for (const [p, v] of Object.entries(savedPrefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
  window.frameResults = {
    total: all.length, passed, failures,
    snapshot: { locale: navigator.language, recordedFrom: 'Peek Budget 1.15.0 (7782895)', screens: snap },
  };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-i18n-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => {
    window.frameResults = { total: 1, passed: 0, failures: [{ name: `${MODE}: setup`, error: err.message }], snapshot: null };
  });
})();

export { USER_TEXT, AI_TEXT };
