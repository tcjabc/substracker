// In-browser tests for the export's on-screen note (js/app.js exportData, js/storage.js
// exportBackupFrom): a backup that passes format 5's check gives the usual short note; one that
// falls back to format 4 (as 1.19.0 wrote it) says so, in the language in use, and stays until
// dismissed, with the file still holding every item. Run by tests/export-note.html with a fixed clock
// against a throwaway database, with index.html's markup, at 320, 360 and 393px, in English, the
// pseudo-locale (?lang=xx) and zh-TW (?lang=zh-TW). Expected words come from t(). The tests run in
// order, as one session in the app. The format rules themselves are in tests/format5.node.test.js.

import * as storage from '../js/storage.js';
import { t } from '../js/i18n.js';

const results = [];
const dbName = `substracker-test-export-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang'];
const savedPrefs = Object.fromEntries(PREFS.map((p) => [p, storage.getPref(p)]));
const LANG = new URLSearchParams(location.search).get('lang') || 'en';

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
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t0 = 0; t0 < ms; t0 += 25) { if (await cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}
const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: 'Pets', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const SEED = [{ ...base, id: 'e-vet', name: 'Vet plan', price: 300, cycle: 'monthly', nextRenewal: '2026-12-01' }];

// The browser download (js/files.js) is caught here: the file's text, never a real download.
const downloads = [];
const realClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function click() {
  if (this.download) { downloads.push(fetch(this.href).then((r) => r.text())); return; }
  realClick.call(this);
};
const lastFile = async () => JSON.parse(await downloads.at(-1));
const toastShown = () => !$('#toast').hidden;
const toastText = () => text($('#toast-text'));

async function exportNow() {
  $('#toast').hidden = true;
  const before = downloads.length;
  $('#btn-export').click();
  await until(() => downloads.length > before && toastShown(), 'the export and its note');
  return lastFile();
}

test('a format 5 backup: the usual short note, gone after a few seconds', async () => {
  const file = await exportNow();
  eq(file.schemaVersion, 5, 'format 5');
  eq(toastText(), norm(t('settings.export.done', { items: t('common.items', { count: 1 }) })), 'the usual note');
  assert($('#toast-action').hidden, 'no button');
  await until(() => !toastShown(), 'it goes by itself', 4500);
});

test('a backup that falls back to format 4: says so in the language in use, stays until dismissed, and has every item', async () => {
  // An item 1.19.0's import would refuse (a cycle it doesn't know, written by a later version):
  // format 5's check fails, so the file is written as 1.19.0 wrote it.
  const odd = { ...base, id: 'e-odd', name: 'Pottery', price: 150, cycle: 'weekly', nextRenewal: '2026-11-19' };
  await storage.save(odd);
  const file = await exportNow();
  eq(file.schemaVersion, 4, 'format 4');
  eq(file.items.map((s) => s.id).sort(), ['e-odd', 'e-vet'], 'every item is in it');
  eq(toastText(), norm(t('settings.export.doneOlder', { items: t('common.items', { count: 2 }) })), 'the older-format note');
  eq(text($('#toast-action')), norm(t('common.dismiss')), 'a Dismiss button');
  await tick(3600);
  assert(toastShown(), 'still there after the usual time');
  const box = $('#toast').getBoundingClientRect();
  assert(box.left >= 0 && box.right <= innerWidth + 0.5, `inside the screen (${box.left}–${box.right} of ${innerWidth})`);
  assert($('#toast-text').scrollWidth <= $('#toast-text').clientWidth + 1, 'the text wraps, never cut');
  $('#toast-action').click();
  assert(!toastShown(), 'dismissed');
  await storage.remove('e-odd');
});

async function run() {
  indexedDB.deleteDatabase(dbName);
  storage.useDatabase(dbName);
  for (const s of SEED) await storage.save(s);
  storage.setPref('tab', 'settings');
  for (const p of ['view', 'groupSort', 'period', 'theme', 'reduceMotion']) localStorage.removeItem(`substracker.${p}`);
  if (LANG === 'zh-TW') storage.setPref('lang', 'zh-TW'); else localStorage.removeItem('substracker.lang');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => !$('#panel-settings').hidden, 'Settings shown', 8000);
  await tick(200);

  let passed = 0;
  const failures = [];
  for (const { name, fn } of results) {
    try { await fn(); passed++; } catch (err) { failures.push({ name, error: err.message }); }
  }
  for (const [p, v] of Object.entries(savedPrefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
  HTMLAnchorElement.prototype.click = realClick;
  $('#t-report').hidden = false;
  $('#summary').textContent = failures.length ? `${failures.length} of ${results.length} failed` : `All ${results.length} passed`;
  $('#summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  $('#results').innerHTML = results.map(({ name }) => {
    const fl = failures.find((x) => x.name === name);
    return `<li class="${fl ? 't-fail' : 't-pass'}">${fl ? '✗' : '✓'} ${esc(name)}${fl ? `<div class="t-detail">${esc(fl.error)}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-export-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
