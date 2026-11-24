// In-browser tests for Erase data on this device (1.28.0; js/erase.js, js/storage.js eraseDatabase,
// removeAllPrefs and markErased, js/app.js bindErase, index.html #device-settings and #erase-dialog).
// Run by tests/erase.html. First storage on its own, then the app with index.html's markup against a
// throwaway database, as one session. Run it at 320, 360 and 393px, with and without reduced motion
// emulated, and in English, the pseudo-locale (?lang=xx) and zh-TW (?lang=zh-TW). Expected words come
// from t(), so every language checks the same things. This page lists the origin's databases
// (indexedDB.databases()) to check what an erase left; the erase itself never does.

import * as storage from '../js/storage.js';
import { overlays, pressBack } from '../js/overlays.js';
import { t } from '../js/i18n.js';
import { backupLabel } from '../js/util.js';
import { generateKey } from '../js/crypto.js';
import { ERASE_CHANNEL, LOGO_CACHE } from '../js/erase.js';

const results = [];
const PREFIX = 'substracker-test-erase-';
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const dbName = `${PREFIX}app-${stamp}`;
const otherDb = `${PREFIX}other-${stamp}`; // must survive every erase on this page
const created = [otherDb];
const LANG = new URLSearchParams(location.search).get('lang') || 'en';
// This origin's own preferences (the developer's, on localhost): put back at the end.
const savedPrefs = Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith('substracker.')).map((k) => [k, localStorage.getItem(k)]));

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
async function until(cond, msg, ms = 5000) {
  for (let t0 = 0; t0 < ms; t0 += 25) { if (await cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}
async function rejects(fn, msg) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  assert(threw, msg);
}
const dbNames = async () => (await indexedDB.databases()).map((d) => d.name);
const ownKeys = () => Object.keys(localStorage).filter((k) => k.startsWith('substracker.'));

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: 'Hobbies', notes: '',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
};
const item = (id, over = {}) => ({ ...base, id, name: `Item ${id}`, price: 100, cycle: 'monthly', nextRenewal: '2026-12-05', ...over });

/** Fail the next indexedDB.deleteDatabase calls (as a browser error would), until restored. */
function failDeletes() {
  indexedDB.deleteDatabase = () => {
    const req = {};
    setTimeout(() => { req.error = new DOMException('test: delete failed', 'UnknownError'); req.onerror?.(); }, 0);
    return req;
  };
  return () => { delete indexedDB.deleteDatabase; };
}

/** A connection with no versionchange handler, as an old tab that never lets go. */
function holdOpen(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ================================ Storage ================================ */

const storageTests = [];
const stest = (name, fn) => storageTests.push({ name, fn });

stest('eraseDatabase deletes only its own database: a second substracker-test-* database survives, data and all', async () => {
  storage.useDatabase(otherDb);
  await storage.save(item('o1'));
  const a = `${PREFIX}a-${stamp}`;
  created.push(a);
  storage.useDatabase(a);
  await storage.save(item('a1'));
  await storage.saveCard('k_test', { name: 'Test card' });
  let names = await dbNames();
  assert(names.includes(a) && names.includes(otherDb), 'both exist');
  await storage.eraseDatabase();
  names = await dbNames();
  assert(!names.includes(a), 'its own database is gone');
  assert(names.includes(otherDb), 'the other one is still there');
  storage.useDatabase(otherDb);
  eq((await storage.getAll()).map((x) => x.id), ['o1'], 'with its data');
});

stest('after the erase nothing reopens the database: every storage call refuses, and no new database appears', async () => {
  const b = `${PREFIX}b-${stamp}`;
  created.push(b);
  storage.useDatabase(b);
  await storage.save(item('b1'));
  const inFlight = storage.save(item('b2')); // a write already on its way when the erase starts
  await storage.eraseDatabase();
  await Promise.allSettled([inFlight]);
  assert(storage.wasErased(), 'guarded');
  for (const [label, call] of [
    ['getAll', () => storage.getAll()], ['save', () => storage.save(item('b3'))], ['getSettings', () => storage.getSettings()],
    ['saveSettings', () => storage.saveSettings({ defaultCurrency: 'USD' })], ['status', () => storage.status()],
    ['pendingOps', () => storage.pendingOps()], ['setLastSynced', () => storage.setLastSynced(1)], ['saveCard', () => storage.saveCard('k_x', { name: 'X' })],
  ]) await rejects(call, `${label} refuses`);
  await tick(150);
  assert(!(await dbNames()).includes(b), 'no new database');
});

stest('blocked: a connection that won\'t let go makes the delete wait (onBlocked), refusing meanwhile; it finishes once that closes', async () => {
  const c = `${PREFIX}c-${stamp}`;
  created.push(c);
  storage.useDatabase(c);
  await storage.save(item('c1'));
  const raw = await holdOpen(c);
  let blocked = 0;
  let deleted = false;
  const run = storage.eraseDatabase({ onBlocked: () => { blocked++; } }).then(() => { deleted = true; });
  await until(() => blocked > 0, 'onBlocked');
  await tick(200);
  assert(!deleted, 'still waiting');
  await rejects(() => storage.getAll(), 'refuses while waiting');
  raw.close();
  await run;
  assert(deleted, 'deleted once it closed');
  assert(!(await dbNames()).includes(c), 'gone');
});

stest('a delete that fails erases nothing: the guard lifts, every item is there, and the same erase then runs', async () => {
  const d = `${PREFIX}d-${stamp}`;
  created.push(d);
  storage.useDatabase(d);
  await storage.save(item('d1'));
  await storage.save(item('d2'));
  const restore = failDeletes();
  try { await rejects(() => storage.eraseDatabase(), 'the erase rejects'); } finally { restore(); }
  assert(!storage.wasErased(), 'the guard is lifted');
  eq((await storage.getAll()).map((x) => x.id).sort(), ['d1', 'd2'], 'nothing was erased');
  await storage.save(item('d3'));
  await storage.eraseDatabase();
  assert(!(await dbNames()).includes(d), 'the retry deleted it');
});

stest('removeAllPrefs removes every substracker. key (theme and language too) and nothing else', async () => {
  const foreign = { 'other.site.erase-test': '1', 'substracker-not-prefix': '2', 'SUBSTRACKER.theme': '3', substracker: '4' };
  for (const [k, v] of Object.entries(foreign)) localStorage.setItem(k, v);
  localStorage.setItem('substracker.theme', 'dark');
  localStorage.setItem('substracker.lang', 'zh-TW');
  localStorage.setItem('substracker.eraseTest', 'x');
  const n = storage.removeAllPrefs();
  assert(n >= 3, `removed ${n}`);
  eq(ownKeys(), [], 'no substracker. key left');
  for (const [k, v] of Object.entries(foreign)) { eq(localStorage.getItem(k), v, `${k} kept`); localStorage.removeItem(k); }
});

/** What a launch finds in storage, with what differs between any two installs taken out. */
async function launchState() {
  const st = await storage.status();
  const ss = await storage.syncState();
  const rec = await storage.getSettingsRecord();
  const note = (f) => (f.startsWith('app_') ? 'app_<this device>' : f);
  const fields = Object.fromEntries(Object.entries(rec.fields).map(([f, v]) => [note(f), f.startsWith('app_') ? { v: v.v, fmt: v.fmt } : v]));
  return {
    deviceId: ss.deviceId,
    state: {
      schemaVersion: st.schemaVersion, usingLegacy: st.usingLegacy, settingsShared: st.settingsShared,
      migration: st.migration, syncMigration: { from: st.syncMigration?.from, records: st.syncMigration?.records, verified: st.syncMigration?.verified },
      settingsMigration: { fields: st.settingsMigration?.fields, verified: st.settingsMigration?.verified },
      formatMigration: st.formatMigration && { verified: st.formatMigration.verified, fields: st.formatMigration.fields, groups: st.formatMigration.groups, items: st.formatMigration.items },
      cursor: ss.syncCursor, outbox: ss.outbox.map((o) => [o.rec, note(o.f), o.dev === ss.deviceId]),
      fields, items: await storage.getAll(), settings: await storage.getSettings(), sync: await storage.getSyncConfig(),
      lastSynced: await storage.getLastSynced(), cards: await storage.cardsWritable(),
    },
  };
}

stest('what an erase leaves equals a fresh first launch, apart from the device id', async () => {
  const fresh = `${PREFIX}fresh-${stamp}`;
  const used = `${PREFIX}used-${stamp}`;
  created.push(fresh, used);
  storage.useDatabase(fresh);
  const F = await launchState();
  storage.useDatabase(used);
  await storage.save(item('u1', { pay: 'k_visa' }));
  await storage.save(item('u2', { category: 'Health' }));
  await storage.remove('u2');
  await storage.saveCard('k_visa', { name: 'Visa', colour: 'c7' });
  await storage.saveSettings({ defaultCurrency: 'USD', groupColors: { Hobbies: 'w3' }, groupSlots: { Hobbies: 2 } });
  await storage.saveLocalDefaults({ defaultCurrency: 'JPY', groupColors: { Health: 'w5' } });
  await storage.setSyncConfig({ relayUrl: 'http://127.0.0.1:9', householdKey: generateKey(), enabled: false });
  await storage.setLastSynced(Date.now());
  const before = (await storage.syncState()).deviceId;
  await storage.eraseDatabase();
  storage.useDatabase(used); // the reload: a new page opens it again
  const U = await launchState();
  eq(U.state, F.state, 'the same as a database that was never used');
  assert(typeof U.deviceId === 'string' && U.deviceId.length > 8, 'a device id');
  assert(U.deviceId !== before && U.deviceId !== F.deviceId, 'a new one');
});

/* ================================ The app ================================ */

const isOpen = (d) => d.open || d.hasAttribute('open');
const reduced = () => document.documentElement.classList.contains('reduce-motion');
const dlg = () => $('#erase-dialog');
const view = () => $$('[data-erase-view]', dlg()).filter((v) => !v.hidden).map((v) => v.dataset.eraseView).join(',');
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };
const confirmButton = (label) => $$('#confirm-actions button').find((b) => text(b) === label);
const settled = (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
const SEED = [
  item('e1', { name: 'Streaming', pay: 'k_visa' }),
  item('e2', { name: 'Gym', category: 'Health' }),
  { ...item('i1', { name: 'Salary', category: 'Salary', price: 50000 }), type: 'income' },
];
let reloads = 0;
const heard = []; // what other tabs are told (this page listens as another tab would)

async function openSettings() {
  if ($('.tab[aria-selected="true"]')?.dataset.tab !== 'settings') { $('#tab-settings').click(); await tick(60); }
}
async function openErase(expect) {
  await openSettings();
  $('#btn-erase').click();
  await until(() => isOpen(dlg()) && view() === expect, `the erase sheet opens on ${expect}`);
  await settled(dlg());
  await tick(30);
}
async function toStep2(answer = '#erase-no-backup') {
  await openErase('backup');
  $(answer).click();
  await until(() => view() === 'confirm', 'step 2');
}
const thumb = () => $('#erase-slide [data-slide-thumb]');
const check = () => $('#erase-slide [data-slide-check]');
const slideText = () => text($('#erase-slide [data-slide-label]'));
const key = (k) => thumb().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
async function confirmSlide() {
  await until(() => !check().disabled, 'the slide unlocks', 4000);
  key('End');
  await until(() => !$('#erase-go').disabled, 'Erase enabled');
}

/** Everything visible in the sheet fits it, and the page doesn't scroll sideways. */
function fits(where) {
  const box = dlg().getBoundingClientRect();
  for (const b of $$('button, .slide-track, p', dlg()).filter((el) => el.offsetParent !== null)) {
    const r = b.getBoundingClientRect();
    assert(r.left >= box.left - 0.5 && r.right <= box.right + 0.5, `${where}: ${b.id || b.className || b.tagName} inside the sheet`);
    if (b.tagName === 'BUTTON') assert(b.scrollWidth <= b.clientWidth + 1, `${where}: ${b.id || text(b)} text not cut off`);
  }
  assert(document.documentElement.scrollWidth <= innerWidth, `${where}: no sideways scroll`);
}

function luminance(c) {
  const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map((x) => { const v = Number(x) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('Settings → This device is the last group: the hint, and a danger button "Erase data on this device" that fits', async () => {
  await openSettings();
  const groups = $$('#panel-settings .settings-group');
  const group = $('#device-settings');
  assert(groups.at(-1) === group, `the last group (is ${groups.at(-1)?.id})`);
  eq(text(group.querySelector('.group-title')), t('settings.device'), 'its title');
  eq(text(group.querySelector('p')), t('settings.erase.hint'), 'the hint');
  const btn = $('#btn-erase');
  eq(text(btn), t('settings.erase'), 'the button');
  assert(btn.classList.contains('btn-danger') && btn.type === 'button', 'danger-styled');
  const panel = group.querySelector('.panel').getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  assert(r.right <= panel.right + 0.5 && btn.scrollWidth <= btn.clientWidth + 1, 'fits its panel');
  assert(document.documentElement.scrollWidth <= innerWidth, 'no sideways scroll');
});

test('while this device can sync the erase is refused: the sync-on words, Open Sync, Cancel first; Back closes it; nothing goes', async () => {
  await openErase('blocked');
  eq(text($('#erase-blocked-text')), t('erase.syncOn'), 'why');
  assert(!$('#erase-open-sync').hidden, 'Open Sync');
  eq(text($('#erase-open-sync')), t('erase.openSync'), 'its words');
  eq(document.activeElement?.id, 'erase-blocked-cancel', 'Cancel is focused');
  eq(overlays.ids(), ['erase-dialog'], 'on the overlay stack');
  fits('refused');
  eq(pressBack(), 'closed', 'Back');
  assert(!isOpen(dlg()), 'closed');
  eq((await storage.getAll()).length, SEED.length, 'nothing erased');
  await openErase('blocked');
  $('#erase-open-sync').click();
  await until(() => isOpen($('#sync-dialog')), 'Open Sync opens the Sync sheet');
  assert(!isOpen(dlg()), 'and the erase sheet closes');
  await until(() => !$('#sync-turn-off').closest('[data-sync-view]').hidden, 'on its set-up view, with Turn off');
});

test('after Turn off sync on this device the erase opens on step 1: the counts, the backup, the two answers, Cancel first', async () => {
  if (!isOpen($('#sync-dialog'))) { await openSettings(); $('#btn-sync').click(); await until(() => isOpen($('#sync-dialog')), 'the Sync sheet'); }
  $('#sync-turn-off').click();
  await until(() => isOpen($('#confirm-dialog')) && confirmButton(t('sync.turnOff.confirm')), 'the Turn off question');
  confirmButton(t('sync.turnOff.confirm')).click();
  await until(async () => (await storage.getSyncConfig()).householdKey === '', 'sync turned off');
  await closeSheets();
  await openErase('backup');
  const items = t('common.items', { count: SEED.length });
  eq(text($('#erase-counts')), t('erase.counts', { items, cards: t('erase.cards', { count: 1 }) }), 'the counts');
  eq(text($('#erase-backup')), backupLabel(SEED.length, false), 'Export a backup first');
  eq(text($('#erase-backup-hint')), t('erase.backup.hint', { items }), 'its hint');
  eq(text($('#erase-have-backup')), t('erase.ack.have'), 'I have a backup');
  eq(text($('#erase-no-backup')), t('erase.ack.without'), 'Continue without one');
  eq(document.activeElement?.id, 'erase-backup-cancel', 'Cancel is focused');
  eq(overlays.ids(), ['erase-dialog'], 'one overlay');
  fits('step 1');
  eq(pressBack(), 'closed', 'Back on step 1 closes the sheet');
  assert(!isOpen(dlg()), 'closed');
});

test('Export a backup first saves the file and stays on step 1 (it never moves on by itself), then says it was saved', async () => {
  await openErase('backup');
  const downloads = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); else click.call(this); };
  try {
    $('#erase-backup').click();
    await until(() => downloads.length === 1, 'a backup file');
  } finally { HTMLAnchorElement.prototype.click = click; }
  assert(/^substracker-\d{4}-\d{2}-\d{2}\.json$/.test(downloads[0]), downloads[0]);
  await tick(100);
  eq(view(), 'backup', 'still step 1');
  eq(text($('#erase-backup')), backupLabel(SEED.length, true), 'saved');
  eq((await storage.getAll()).length, SEED.length, 'nothing erased');
});

test('step 2: this device only, the slide locked for a moment (Erase off), Cancel first; Back returns to step 1', async () => {
  await toStep2('#erase-have-backup');
  eq(text($('#erase-dialog [data-erase-view="confirm"] .sync-warning')), t('erase.message'), 'this device only, can\'t be undone');
  eq(overlays.ids(), ['erase-dialog', 'erase-step'], 'the step is on the overlay stack');
  eq(document.activeElement?.id, 'erase-confirm-cancel', 'Cancel is focused');
  eq(slideText(), t('erase.slide.locked'), 'locked');
  eq(thumb().getAttribute('aria-label'), t('erase.slide.label'), 'the slider\'s label');
  eq(thumb().getAttribute('aria-valuetext'), t('erase.slide.value.locked'), 'read as locked');
  assert(check().disabled && $('#erase-go').disabled, 'the tick and Erase are off');
  key('End');
  await tick(50);
  assert($('#erase-go').disabled, 'End does nothing while locked');
  eq(pressBack(), 'closed', 'Back');
  eq(view(), 'backup', 'step 1 again');
  eq(overlays.ids(), ['erase-dialog'], 'the step left the stack');
  eq(document.activeElement?.id, 'erase-backup-cancel', 'Cancel focused');
  $('#erase-no-backup').click();
  await until(() => view() === 'confirm', 'step 2 again');
  eq(slideText(), t('erase.slide.locked'), 'locked again');
  await until(() => !check().disabled, 'unlocks', 4000);
  eq(slideText(), t('erase.slide.label'), 'the slide\'s words');
  eq(thumb().getAttribute('aria-valuetext'), t('erase.slide.value.not'), 'read as not confirmed');
  check().click();
  assert(!$('#erase-go').disabled, 'the tick turns Erase on');
  check().click();
  assert($('#erase-go').disabled, 'and off');
  key('End');
  assert(!$('#erase-go').disabled, 'End on the slider confirms');
  eq(slideText(), t('erase.slide.done'), 'confirmed');
  eq(thumb().getAttribute('aria-valuetext'), t('erase.slide.value.confirmed'), 'read as confirmed');
  eq(text($('#erase-go')), t('erase.confirm'), 'Erase');
  assert($('#erase-go').classList.contains('btn-danger'), 'danger-styled');
  fits('step 2');
  $('#erase-back').click();
  eq(view(), 'backup', 'its Back button');
  $('#erase-backup-cancel').click();
  assert(!isOpen(dlg()), 'Cancel closes it');
  eq((await storage.getAll()).length, SEED.length, 'nothing erased');
});

test('Reduce motion and effects: the sheet and the slide don\'t animate when it is on, and do when off', async () => {
  eq(reduced(), matchMedia('(prefers-reduced-motion: reduce)').matches, 'follows the setting');
  await toStep2();
  const ms = (el) => Math.max(...getComputedStyle(el).transitionDuration.split(',').map((s) => parseFloat(s) * (s.trim().endsWith('ms') ? 1 : 1000)));
  if (reduced()) {
    assert(ms(thumb()) <= 0.02, `the thumb springs back at once (${ms(thumb())}ms)`);
    assert(dlg().getAnimations({ subtree: true }).every((a) => (a.effect?.getTiming().duration ?? 0) <= 0.02), 'no sheet animation');
  } else assert(ms(thumb()) > 0, 'the thumb springs back');
  await closeSheets();
});

test('both themes: the danger buttons and the warning are readable (contrast at least 4.5)', async () => {
  for (const theme of ['light', 'dark']) {
    document.documentElement.dataset.theme = theme;
    await toStep2();
    await confirmSlide();
    for (const el of [$('#btn-erase'), $('#erase-go'), $('#erase-dialog [data-erase-view="confirm"] .sync-warning')]) {
      const cs = getComputedStyle(el);
      const c = contrast(cs.color, cs.backgroundColor);
      assert(c >= 4.5, `${theme}: ${el.id || el.className} contrast ${c.toFixed(2)}`);
    }
    await closeSheets();
  }
  document.documentElement.dataset.theme = 'light';
});

test('another tab erasing: storage refuses while it runs, works again if it fails, and the app opens again once done', async () => {
  const tab = new BroadcastChannel(ERASE_CHANNEL);
  try {
    tab.postMessage({ type: 'erasing', db: `${PREFIX}someone-else` });
    await tick(100);
    assert(!storage.wasErased(), 'another database: nothing');
    tab.postMessage({ type: 'erasing', db: dbName });
    await until(() => storage.wasErased(), 'guarded');
    await rejects(() => storage.getAll(), 'refuses');
    tab.postMessage({ type: 'cancelled', db: dbName });
    await until(() => !storage.wasErased(), 'unguarded');
    eq((await storage.getAll()).length, SEED.length, 'works again');
    const before = reloads;
    tab.postMessage({ type: 'erased', db: dbName });
    await until(() => reloads === before + 1, 'opens again');
  } finally { tab.close(); }
});

test('an erase whose delete fails: "Nothing was erased", the sheet stays, every item is there, and Erase can run again', async () => {
  heard.length = 0;
  await toStep2();
  await confirmSlide();
  const restore = failDeletes();
  const before = reloads;
  try {
    $('#erase-go').click();
    await until(() => text($('#erase-error')) === t('erase.failed'), 'the failure');
  } finally { restore(); }
  assert(isOpen(dlg()) && view() === 'confirm', 'the sheet stays');
  assert($('#erase-busy').hidden, 'not busy');
  assert(!$('#erase-go').disabled && !$('#erase-confirm-cancel').disabled, 'Erase and Cancel work again');
  eq(reloads, before, 'no reload');
  assert(!storage.wasErased(), 'storage works');
  eq((await storage.getAll()).length, SEED.length, 'every item is there');
  await until(() => heard.length === 2, 'other tabs told');
  eq(heard.map((m) => m.type), ['erasing', 'cancelled'], 'erasing, then cancelled');
  await closeSheets();
});

test('Erase: waits while another window holds the data (Back and Cancel do nothing), removes only this app\'s database, keys and logo cache, says what it couldn\'t reset, opens again', async () => {
  heard.length = 0;
  for (const name of [LOGO_CACHE, 'substracker-shell-erase-test', 'other-site-erase-test']) await (await caches.open(name)).put('/erase-test', new Response('x'));
  localStorage.setItem('other.site.erase-test', 'kept');
  localStorage.setItem('substracker.eraseSentinel', 'stuck');
  const removeItem = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (k) { if (k === 'substracker.eraseSentinel') throw new Error('test: blocked'); return removeItem.call(this, k); };
  const holder = await holdOpen(dbName);
  const before = reloads;
  try {
    await toStep2();
    await confirmSlide();
    $('#erase-go').click();
    await until(() => text($('#erase-busy')) === t('toast.blocked'), 'waiting for the other window');
    assert(!$('#erase-busy').hidden, 'said');
    assert($('#erase-confirm-cancel').disabled && $('#erase-back').disabled && $('[data-erase-close]').disabled && $('#erase-go').disabled, 'nothing to press');
    eq(pressBack(), 'kept', 'Back does nothing');
    dlg().dispatchEvent(new Event('cancel', { cancelable: true }));
    assert(isOpen(dlg()), 'Escape does nothing');
    eq(reloads, before, 'no reload while waiting');
    assert(storage.wasErased(), 'storage refuses meanwhile');
    holder.close();
    await until(() => isOpen($('#confirm-dialog')) && text($('#confirm-message')) === t('erase.partial'), 'some settings could not be reset');
    eq(reloads, before, 'the reload waits for OK');
    confirmButton(t('common.ok')).click();
    await until(() => reloads === before + 1, 'opens again');
  } finally {
    Storage.prototype.removeItem = removeItem;
    try { holder.close(); } catch { /* closed */ }
  }
  const names = await dbNames();
  assert(!names.includes(dbName), 'the app\'s database is gone');
  assert(names.includes(otherDb), 'another substracker-test-* database is not');
  eq(ownKeys(), ['substracker.eraseSentinel'], 'every substracker. key went, but the one that couldn\'t');
  eq(localStorage.getItem('other.site.erase-test'), 'kept', 'another site\'s key stays');
  const cacheNames = await caches.keys();
  assert(!cacheNames.includes(LOGO_CACHE), 'the logo cache is gone');
  assert(cacheNames.includes('substracker-shell-erase-test') && cacheNames.includes('other-site-erase-test'), 'every other cache stays');
  eq(heard.map((m) => m.type), ['erasing', 'erased'], 'other tabs told');
  assert(heard.every((m) => m.db === dbName), 'naming this database');
  await rejects(() => $('#money-summary').reload(), 'the page\'s own reads refuse');
  await rejects(() => storage.save(item('late')), 'and its writes');
  await tick(200);
  assert(!(await dbNames()).includes(dbName), 'nothing reopened it');
  localStorage.removeItem('substracker.eraseSentinel');
  localStorage.removeItem('other.site.erase-test');
  for (const name of ['substracker-shell-erase-test', 'other-site-erase-test']) await caches.delete(name);
});

/* ------------------------------------------------------------------------------------------- */

async function runList(list, failures) {
  let passed = 0;
  for (const { name, fn } of list) {
    try { await fn(); passed++; } catch (err) { failures.push({ name, error: err.message }); }
    if (list === results) await closeSheets();
  }
  return passed;
}

async function run() {
  // No request leaves the page: the relay address below is unused, and anything off this origin fails.
  const realFetch = window.fetch;
  window.fetch = (url, init) => (new URL(String(url?.url ?? url), location.href).origin === location.origin
    ? realFetch(url, init) : Promise.reject(new TypeError('offline (test page)')));
  window.WebSocket = class { constructor() { throw new TypeError('offline (test page)'); } };

  storage.setAppVersion('1.28.0');
  const failures = [];
  let passed = await runList(storageTests, failures);

  storage.useDatabase(dbName);
  created.push(dbName);
  for (const s of SEED) await storage.save(s);
  await storage.saveCard('k_visa', { name: 'Visa', colour: 'c7' });
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  // Sync on (a household key, an unused local relay): the erase must refuse until it's turned off.
  await storage.setSyncConfig({ relayUrl: 'http://127.0.0.1:9', householdKey: generateKey(), enabled: true });
  for (const k of ownKeys()) localStorage.removeItem(k);
  storage.setPref('tab', 'settings');
  storage.setPref('theme', 'light');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) storage.setPref('reduceMotion', 'off');
  if (LANG === 'zh-TW') storage.setPref('lang', 'zh-TW');

  const listen = new BroadcastChannel(ERASE_CHANNEL);
  listen.addEventListener('message', (e) => heard.push(e.data));
  const html = await (await realFetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#tab-settings[aria-selected="true"]'), 'app drawn', 8000);
  dlg().testReload = () => { reloads++; };
  await tick(300);

  passed += await runList(results, failures);
  listen.close();
  for (const k of ownKeys()) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(savedPrefs)) localStorage.setItem(k, v);

  const all = [...storageTests, ...results];
  $('#t-report').hidden = false;
  $('#summary').textContent = failures.length ? `${failures.length} of ${all.length} failed` : `All ${all.length} passed`;
  $('#summary').className = `t-summary ${failures.length ? 't-fail' : 't-pass'}`;
  $('#results').innerHTML = all.map(({ name }) => {
    const fl = failures.find((x) => x.name === name);
    return `<li class="${fl ? 't-fail' : 't-pass'}">${fl ? '✗' : '✓'} ${name}${fl ? `<div class="t-detail">${fl.error.replace(/</g, '&lt;')}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: all.length, passed, failures, reduced: reduced() };
  addEventListener('pagehide', () => { for (const name of created) indexedDB.deleteDatabase(name); });
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith(PREFIX) && !name.endsWith(stamp)) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
