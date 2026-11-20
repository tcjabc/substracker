// In-browser tests for the notes of "Import with AI" (1.22.2: js/import-ai-sheet.js, js/import-ai.js,
// css/app.css), run by tests/import-notes.html with a fixed clock against a throwaway database. The
// app runs with index.html's markup. Run the page at 320, 360 and 393px, in English and the
// pseudo-locale (?lang=xx). Expected words come from t(), so every language checks the same things;
// the notes themselves are the person's own words and stay as written. The tests run in order, as one
// session in the app. The rules themselves are in tests/import-notes.node.test.js.

import * as storage from '../js/storage.js';
import { t } from '../js/i18n.js';

const results = [];
const dbName = `substracker-test-notes-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang'];
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
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const text = (el) => norm(el?.textContent ?? '');
/** The review's summary line, as js/import-ai-sheet.js summaryText builds it from its parts. */
const summary = (...parts) => norm(t('ai.summary', { parts: parts.join(' · ') }));
/** A row's problem as the review shows it (js/import-ai.js), in the app's language. */
const problem = (n, key, params) => norm(t('ai.row.problem', { n, problem: t(key, params) }));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t = 0; t < ms; t += 25) { if (cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}
// Characters by code, so none hide in this file.
const ch = (...codes) => String.fromCodePoint(...codes);
const LDQ = ch(0x201c);
const RDQ = ch(0x201d);
const LSQ = ch(0x2018);
const RSQ = ch(0x2019);
const NOTE_1 = `Family plan, shared with ${LDQ}the flat${RDQ} ${ch(0x1f3ac)}`;
const NOTE_2 = `Paid from the ${LSQ}Joint account${RSQ}`;
const NOTE_3 = `After tax, ${LDQ}Main job${RDQ} ${ch(0x1f4bc)} ${ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)}`;

const SEED = [{
  id: 't-phone', type: 'expense', name: 'Phone', domain: '', emoji: '', plan: '', price: 499, currency: 'TWD', cycle: 'monthly',
  nextRenewal: '2026-11-20', date: '', category: 'Utilities', notes: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}];

const aiDlg = () => $('#ai-dialog');
const aiView = () => $$('#ai-dialog [data-ai-view]').find((v) => !v.hidden)?.dataset.aiView;
const row = (n) => $(`#ai-rows [data-row="${n}"]`);
const noteOf = (n) => $('.ai-row-note', row(n));
/** The note as it is seen: without the label that only screen readers get. */
const seen = (el) => { const c = el.cloneNode(true); $$('.sr-only', c).forEach((s) => s.remove()); return c.textContent; };
const isOpen = (d) => d.open || d.hasAttribute('open');
const goTab = async (name) => { $(`#tab-${name}`).click(); await tick(60); };
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };
const confirmOpen = () => $('#confirm-dialog').open;
const confirmButton = (label) => $$('#confirm-actions button').find((b) => text(b) === label);
const aiReply = (rows) => JSON.stringify({ version: 1, rows });
const aiRow = (over = {}) => ({
  name: 'Test Streaming', amount: 390, currency: 'TWD', cycle: 'monthly', nextDate: '2026-12-05', category: 'Entertainment', type: 'expense', ...over,
});

/** Open the sheet from Settings, confirm the warning, and review `reply` (pasted). */
async function review(reply) {
  await goTab('settings');
  $('#btn-import-ai').click();
  await until(() => aiDlg().open && aiView() === 'warning', 'the warning step');
  await until(() => !$('#ai-slide').classList.contains('is-locked'), 'the lock to end', 3500);
  $('#ai-slide [data-slide-check]').click();
  await until(() => !$('#ai-continue').disabled, 'Continue enabled');
  $('#ai-continue').click();
  await until(() => aiView() === 'prompt', 'the prompt step');
  $('#ai-reply').value = reply;
  $('#ai-review').click();
  await until(() => aiView() === 'review', 'the review step');
  await tick(30);
}
/** Whether `el` draws on one line: one box, no taller than one line of its own text. */
function oneLine(el) {
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6;
  return el.getClientRects().length === 1 && el.getBoundingClientRect().height <= line * 1.2;
}
async function openEdit(id, income) {
  await goTab('subs');
  $('#view-btn').click();
  $('#view-menu [data-view="list"]').click();
  await tick(80);
  if (income && $('#income-toggle').getAttribute('aria-expanded') !== 'true') { $('#income-toggle').click(); await tick(60); }
  $(`${income ? '#income-list' : '#subs-list'} [data-id="${id}"]`).click();
  await until(() => isOpen($('#sub-dialog')), 'the edit sheet opens');
  await tick(30);
}
const copied = [];
function setClipboard(on) {
  if (!on) { delete navigator.clipboard; return; }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } },
  });
}

/* ---------------------------------------------------------------- tests */

test('review: each note on one line under its row, read out with a label; no line for rows without one', async () => {
  const reply = await (await fetch('fixtures/ai-reply-notes.txt', { cache: 'no-store' })).text();
  await review(reply);
  eq(text($('#ai-review-summary')), summary(t('ai.summary.rows', { count: 5 }), t('ai.summary.selected', { count: 5 })), 'all five read and selected');
  eq([1, 2, 3].map((n) => seen(noteOf(n))), [NOTE_1, NOTE_2, NOTE_3], 'the notes, curly quotes and emoji as written');
  eq([4, 5].map((n) => !!noteOf(n)), [false, false], 'no note line without a note');
  eq(text($('.sr-only', noteOf(1))), norm(t('ai.row.notes.label')), 'screen readers hear what it is');
  for (const n of [1, 2, 3]) {
    const el = noteOf(n);
    assert($('.ai-row-body', row(n)).contains(el), `row ${n}: under the name and details`);
    const cs = getComputedStyle(el);
    eq([cs.whiteSpace, cs.overflow, cs.textOverflow], ['nowrap', 'hidden', 'ellipsis'], `row ${n}: one line, with an ellipsis`);
    assert(oneLine(el), `row ${n}: draws on one line`);
    assert(el.getBoundingClientRect().right <= row(n).getBoundingClientRect().right + 0.5, `row ${n}: inside the row`);
  }
  eq(getComputedStyle(noteOf(1)).color, getComputedStyle($('.ai-row-meta', row(1))).color, 'muted like the details line');
  assert($('#ai-review-error').hidden, 'nothing to copy for the AI');
  assert(document.documentElement.scrollWidth <= innerWidth, 'no sideways scroll');
});

test('import: the notes land in each item\u2019s More details, income too', async () => {
  const before = (await storage.getAll()).length;
  await review(await (await fetch('fixtures/ai-reply-notes.txt', { cache: 'no-store' })).text()); // each test starts with the sheets closed
  $('#ai-import').click();
  const merge = norm(t('import.merge'));
  await until(() => confirmOpen() && confirmButton(merge), 'the choice');
  confirmButton(merge).click();
  await until(() => text($('#toast-text')) === norm(t('ai.toast.added', { items: t('common.items', { count: 5 }) })), 'merged');
  const all = await storage.getAll();
  eq(all.length, before + 5, 'five added');
  const by = (name) => all.find((s) => s.name === name);
  eq(['Example Streaming', 'Sample Gym', 'Sample Salary', 'Cloud Notes', 'Concert'].map((n) => by(n).notes), [NOTE_1, NOTE_2, NOTE_3, '', ''], 'stored');
  await openEdit(by('Example Streaming').id, false);
  eq($('#more-toggle').getAttribute('aria-expanded'), 'true', 'More details opens for an item with a note');
  eq($('#sub-form').elements.notes.value, NOTE_1, 'the note in the Notes field');
  await closeSheets();
  await openEdit(by('Sample Salary').id, true);
  eq($('#more-toggle').getAttribute('aria-expanded'), 'true', 'income: More details opens too');
  eq($('#sub-form').elements.notes.value, NOTE_3, 'income: the note in the Notes field');
  await closeSheets();
});

test('a long note: shortened, flagged, still selected, one line; a notes error goes in the copied report', async () => {
  const long = 'Shared with your family. '.repeat(26); // 650 characters; character 500 is a space
  await review(aiReply([aiRow({ notes: long }), aiRow({ name: 'Test Lamp', cycle: 'one-off', nextDate: '2026-11-02', notes: 42 })]));
  eq(text($('#ai-review-summary')), summary(t('ai.summary.rows', { count: 2 }), t('ai.summary.selected', { count: 1 }),
    t('ai.summary.notes', { count: 1 }), t('ai.summary.blocked', { count: 1 })), 'summary');
  assert(text(row(1)).includes(norm(t('ai.tag.note'))), 'the tag');
  const shortened = problem(1, 'ai.row.notes.long', { max: 500 });
  assert(text(row(1)).includes(shortened), 'what happened');
  assert($('[data-include="1"]').checked && !$('[data-include="1"]').disabled, 'still selected');
  assert(!row(1).classList.contains('is-blocked'), 'not blocked');
  const el = noteOf(1);
  eq([...seen(el)].length, 500 - 1, 'the shortened note is shown (cut at 500, the space at the cut trimmed)');
  assert(oneLine(el) && el.scrollWidth > el.clientWidth, 'one line, the rest behind the ellipsis');
  const wrong = problem(2, 'ai.row.notes.text');
  assert(text(row(2)).includes(wrong), 'the wrong note says how to fix it');
  assert(row(2).classList.contains('is-blocked') && $('[data-include="2"]').disabled, 'and blocks its row');
  assert(!$('#ai-review-error').hidden, 'Copy error for your AI is offered');
  copied.length = 0;
  setClipboard(true);
  try {
    $('#ai-review-copy-error').click();
    await until(() => copied.length === 1, 'the report copied');
  } finally { setClipboard(false); }
  const report = copied[0].split('\n').map(norm);
  assert(report.includes(`- ${wrong}`), 'the notes error, like any other field');
  assert(!report.some((l) => l.includes(shortened)), 'the shortened note is not an error for the AI');
});

test('Reduce motion and effects: the review with notes draws with no animations', async () => {
  await goTab('settings');
  if (!$('#set-motion').checked) $('#set-motion').click();
  await tick(30);
  try {
    const reply = await (await fetch('fixtures/ai-reply-notes.txt', { cache: 'no-store' })).text();
    await review(reply);
    const longest = Math.max(0, ...document.getAnimations()
      .filter((a) => aiDlg().contains(a.effect?.target) || a.effect?.target === aiDlg())
      .map((a) => a.effect.getComputedTiming().duration));
    assert(longest <= 0.01, `nothing in the sheet animates (${longest} ms)`);
    eq($$('#ai-rows .ai-row-note').length, 3, 'the notes are there');
  } finally {
    await closeSheets();
    await goTab('settings');
    if ($('#set-motion').checked) $('#set-motion').click();
    await tick(30);
  }
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
  for (const p of ['groupSort', 'lang']) localStorage.removeItem(`substracker.${p}`);

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
      if (name?.startsWith('substracker-test-notes-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
