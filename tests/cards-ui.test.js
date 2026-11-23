// In-browser tests for the payment cards UI (1.27.0; js/cards-ui.js, index.html #card-settings and
// #card-dialog, js/app.js, js/storage.js saveCard / saveItemWithCard / deleteCard). Run by
// tests/cards-ui.html with a fixed clock (24 November 2026) against a throwaway database, with
// index.html's markup. Run it at 320, 360 and 393px, with and without reduced motion emulated, and in
// English, the pseudo-locale (?lang=xx) and zh-TW (?lang=zh-TW). Expected words come from t(), so
// every language checks the same things. The tests run in order, as one session in the app.

import * as storage from '../js/storage.js';
import { overlays, pressBack } from '../js/overlays.js';
import { t } from '../js/i18n.js';
import { listCards, CARD_COLOUR_KEYS } from '../js/cards.js';
import { CARD_COLOUR_NAMES } from '../js/cards-ui.js';
import * as syncCore from '../js/sync-core.js';

const results = [];
const dbName = `substracker-test-cards-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const PREFS = ['tab', 'view', 'groupSort', 'period', 'theme', 'reduceMotion', 'lang', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed', 'insightsMode'];
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
const text = (el) => el?.textContent.replace(/\s+/g, ' ').trim() ?? '';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(cond, msg, ms = 4000) {
  for (let t0 = 0; t0 < ms; t0 += 25) { if (await cond()) return; await tick(25); }
  throw new Error(`Timed out: ${msg}`);
}
const fullWidth = (s) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));

const base = {
  type: 'expense', domain: '', emoji: '', plan: '', currency: 'TWD', date: '', category: '', notes: '',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};
const LONG_NAME = `Streaming bundle ${'x'.repeat(40)}`;
const SEED = [
  { ...base, type: 'income', id: 'i-pay', name: 'Salary', price: 50000, cycle: 'monthly', nextRenewal: '2026-11-30', category: 'Salary' },
  { ...base, id: 'e-netflix', name: 'Netflix', price: 390, cycle: 'monthly', nextRenewal: '2026-11-28', category: 'Entertainment', pay: 'k_visa' },
  { ...base, id: 'e-gym', name: 'Gym', price: 1200, cycle: 'monthly', nextRenewal: '2026-11-29', category: 'Health', pay: 'k_visa' },
  { ...base, id: 'e-rent', name: 'Rent', price: 18000, cycle: 'monthly', nextRenewal: '2026-12-01', category: 'Housing', pay: 'cash' },
  { ...base, id: 'e-misc', name: 'Misc', price: 150, cycle: 'monthly', nextRenewal: '2026-11-26' },
  { ...base, id: 'e-long', name: LONG_NAME, price: 99, cycle: 'monthly', nextRenewal: '2026-11-27', category: 'Entertainment', pay: 'k_line' },
  // Paid with a card this device has never received (another device's, not synced yet).
  { ...base, id: 'e-ghost', name: 'Ghost card item', price: 10, cycle: 'monthly', nextRenewal: '2026-11-27', pay: 'k_unknown' },
];

const isOpen = (d) => d.open || d.hasAttribute('open');
const reduced = () => document.documentElement.classList.contains('reduce-motion');
const appTab = () => $('.tab[aria-selected="true"]')?.dataset.tab;
const goTab = async (name) => { if (appTab() !== name) { $(`#tab-${name}`).click(); await tick(60); } };
const closeSheets = async () => { for (const d of $$('dialog[open]')) d.close(); await tick(30); };
const cardSheet = () => $('#card-dialog');
const cf = () => $('#card-form').elements;
const record = () => storage.getSettingsRecord();
const cardsNow = async () => listCards(await record());
const setValue = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
const cardError = () => text($('#card-form [data-error-for="cardName"]'));
const toastText = () => text($('#toast-text'));
async function openSettings() { await goTab('settings'); await tick(30); }
/** Let a sheet finish sliding in (sheet-in), so what's measured is where it stays. */
const settled = (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
async function openAddCard() {
  await openSettings();
  $('#btn-card-add').click();
  await until(() => isOpen(cardSheet()), 'the card sheet opens');
  await settled(cardSheet());
  await tick(30);
}
async function openCard(name) {
  await openSettings();
  const row = $$('#card-list [data-card]').find((b) => text(b.querySelector('.card-row-name')) === name);
  assert(row, `a row for ${name}`);
  row.click();
  await until(() => isOpen(cardSheet()), 'the card sheet opens');
  await tick(30);
}
async function saveCardSheet({ closes = true } = {}) {
  $('#card-form button[type="submit"]').click();
  if (closes) await until(() => !isOpen(cardSheet()), 'the card sheet saves and closes');
  await tick(80);
}

/* --------------------------------------------------------------------------------------------- */

test('Settings → Payment cards sits between Groups and Sync: a row per card A–Z, labelled "Edit card …", then Add card', async () => {
  await openSettings();
  const section = $('#card-settings');
  assert(!section.hidden, 'the section shows (settings are shared on this device)');
  const groups = $$('#panel-settings .settings-group');
  const i = groups.indexOf(section);
  eq(groups[i - 1]?.id, 'group-settings', 'right after Groups');
  eq(text(groups[i + 1]?.querySelector('.group-title')), t('settings.sync.title'), 'and before Sync');
  eq(text(section.querySelector('.group-title')), t('settings.cards'), 'its title');
  const rows = $$('#card-list [data-card]');
  eq(rows.map((b) => b.dataset.card), ['k_line', 'k_visa'], 'live cards only, by name');
  eq(rows.map((b) => b.getAttribute('aria-label')), [t('settings.cards.editLabel', { name: 'LINE Bank' }), t('settings.cards.editLabel', { name: 'Visa' })], 'each row reads Edit card {name}');
  assert(rows.every((b) => b.tagName === 'BUTTON' && b.type === 'button'), 'row buttons');
  eq($('#card-list [data-card="k_visa"] .card-glyph').dataset.colour, 'c7', 'Visa draws its colour');
  assert(!('colour' in $('#card-list [data-card="k_line"] .card-glyph').dataset), 'a colour this version can\'t draw (w3): the muted outline');
  eq($$('#card-list .card-glyph').map((g) => g.getAttribute('aria-hidden')), ['true', 'true'], 'the glyphs are hidden from screen readers');
  eq(text($('#card-list [data-card="k_visa"] .setting-hint')), `${t('settings.cards.due', { day: 10 })} · ${t('settings.cards.cut', { day: 25 })}`, 'the days, when set');
  assert(!$('#card-list [data-card="k_line"] .setting-hint'), 'no line when no day is set');
  assert($('#card-empty').hidden, 'no empty text with cards');
  eq(text($('#btn-card-add')), t('settings.cards.add'), 'Add card');
  eq(text(section.querySelector('.panel > .setting-row .setting-hint')), t('settings.cards.hint'), 'never enter a card number');
  assert(!$('#card-settings').textContent.includes('remind'), 'nothing promises reminders');
});

test('the card sheet: Nickname, ten colours as named radios under a legend, two days 1–31, no delete when adding; Back closes it', async () => {
  await openAddCard();
  eq(text($('#card-dialog-title')), t('card.title.new'), 'title');
  eq(overlays.ids(), ['card-dialog'], 'on the overlay stack');
  const radios = $$('#card-colours input[type="radio"]');
  eq(radios.map((r) => r.value), [...CARD_COLOUR_KEYS], 'c1 … c10');
  assert(radios.every((r) => r.name === 'cardColour'), 'one group');
  eq(radios.map((r) => r.getAttribute('aria-label')), CARD_COLOUR_KEYS.map((k) => t(CARD_COLOUR_NAMES[k])), 'each named');
  eq(text($('#card-colours').closest('fieldset').querySelector('legend')), t('card.colour'), 'under a legend');
  eq(radios.filter((r) => r.checked).map((r) => r.value), ['c1'], 'a new card starts with the first colour no card uses');
  for (const sel of [cf().cardCut, cf().cardDue]) {
    eq(sel.options.length, 32, `${sel.name}: Not set plus 1–31`);
    eq([sel.options[0].value, sel.options[0].textContent], ['', t('card.day.none')], `${sel.name}: Not set first`);
    eq(sel.options[31].textContent, t('card.day', { day: 31 }), `${sel.name}: 31 last`);
    eq(sel.value, '', `${sel.name}: Not set by default`);
  }
  assert($('#btn-card-delete').hidden, 'no Delete when adding');
  eq(cf().cardName.getAttribute('autocomplete'), 'off', 'no autofill (never a card number field)');
  pressBack();
  await tick(60);
  assert(!isOpen(cardSheet()), 'one Back closes it');
  eq(overlays.ids(), [], 'nothing left open');
});

test('nickname checks: empty, over 40, 13+ digits (spaced, dashed, full-width) are refused; "Visa 2024 2025 2026" is fine', async () => {
  await openAddCard();
  const before = (await cardsNow()).length;
  const tryName = async (name) => { setValue(cf().cardName, name); await saveCardSheet({ closes: false }); return cardError(); };
  eq(await tryName('   '), t('card.error.name'), 'empty');
  eq(cf().cardName.getAttribute('aria-invalid'), 'true', 'marked invalid');
  eq(document.activeElement, cf().cardName, 'focus on the field');
  eq(await tryName('x'.repeat(41)), t('card.error.long', { max: 40 }), 'over 40');
  for (const n of ['4111 1111 1111 1111', '4111-1111-1111-1', fullWidth('4111111111111'), `Visa ${fullWidth('4111 1111 1111 1111')}`]) {
    eq(await tryName(n), t('card.error.digits'), `digits: ${n}`);
  }
  assert(isOpen(cardSheet()), 'still open');
  eq((await cardsNow()).length, before, 'nothing written');
  setValue(cf().cardName, 'x');
  eq(cardError(), '', 'typing clears the message');
  eq(cf().cardName.hasAttribute('aria-invalid'), false, 'and the mark');
  setValue(cf().cardName, ' Visa 2024 2025 2026 ');
  $('#card-colours input[value="c4"]').click();
  cf().cardDue.value = '5';
  await saveCardSheet();
  eq(toastText(), t('card.toast.added', { name: 'Visa 2024 2025 2026' }), 'the toast');
  const added = (await cardsNow()).find((c) => c.name === 'Visa 2024 2025 2026');
  assert(added, 'stored, trimmed');
  assert(/^[0-9a-f]{32}$/.test(added.id), `a 32-hex id (${added.id})`);
  eq([added.colour, added.cut, added.due], ['c4', null, 5], 'colour and days stored');
  const raw = (await record()).fields[`card_${added.id}`];
  eq(raw, { name: 'Visa 2024 2025 2026', colour: 'c4', cut: null, due: 5 }, 'read back from the record');
  assert($(`#card-list [data-card="${added.id}"]`), 'the list shows it');
});

test('a nickname that is already a card picks that card: nothing is added, the sheet shows it', async () => {
  const before = await cardsNow();
  await openAddCard();
  setValue(cf().cardName, '  vIsA ');
  await saveCardSheet({ closes: false });
  assert(isOpen(cardSheet()), 'still open');
  eq(text($('#card-dialog-title')), t('card.title.edit'), 'now editing');
  eq(cf().cardName.value, 'Visa', 'the existing card');
  assert(!$('#btn-card-delete').hidden, 'with its Delete');
  eq((await cardsNow()).map((c) => c.id), before.map((c) => c.id), 'no card added');
  await closeSheets();
});

test('editing a card whose colour this version can\'t draw: no swatch picked, a rename keeps that colour; a pick replaces it', async () => {
  await openCard('LINE Bank');
  eq($$('#card-colours input:checked').length, 0, 'no swatch selected');
  assert(!('colour' in $('#card-form-glyph').dataset), 'the header glyph is the muted outline');
  setValue(cf().cardName, 'LINE');
  await saveCardSheet();
  eq((await record()).fields.card_k_line, { name: 'LINE', colour: 'w3', note: 'future', cut: null, due: null }, 'renamed; colour and a later version\'s key kept');
  await openCard('LINE');
  $('#card-colours input[value="c9"]').click();
  eq($('#card-form-glyph').dataset.colour, 'c9', 'the header follows the pick');
  await saveCardSheet();
  eq((await record()).fields.card_k_line.colour, 'c9', 'the picked colour');
});

test('delete: the confirm says how many items use it; Back closes the confirm first; delete clears them to Not set in one go', async () => {
  await openCard('Visa');
  $('#btn-card-delete').click();
  await until(() => isOpen($('#confirm-dialog')), 'the confirm opens');
  eq(text($('#confirm-title')), t('card.delete.title', { name: 'Visa' }), 'title');
  eq(text($('#confirm-message')), t('card.delete.message', { count: 2 }), 'two items use it');
  eq(overlays.ids(), ['card-dialog', 'confirm-dialog'], 'stacked over the sheet');
  pressBack();
  await tick(60);
  assert(!isOpen($('#confirm-dialog')) && isOpen(cardSheet()), 'Back closes the confirm, not the sheet');
  eq((await cardsNow()).some((c) => c.id === 'k_visa'), true, 'nothing deleted');
  $('#btn-card-delete').click();
  await until(() => isOpen($('#confirm-dialog')), 'the confirm opens again');
  $$('#confirm-actions button')[1].click();
  await until(() => !isOpen(cardSheet()), 'the sheet closes');
  await tick(100);
  eq(toastText(), t('card.toast.deleted', { name: 'Visa' }), 'the toast');
  const rec = await record();
  eq(rec.fields.card_k_visa.gone, true, 'the tombstone');
  const items = await storage.getAll();
  const pay = (id) => items.find((s) => s.id === id).pay;
  eq([pay('e-netflix'), pay('e-gym'), pay('e-rent'), pay('e-misc'), pay('e-ghost')], ['', '', 'cash', undefined, 'k_unknown'], 'its items back to Not set; nothing else touched');
  eq(items.find((s) => s.id === 'e-netflix').name, 'Netflix', 'the rest of the item as it was');
  assert(!$('#card-list [data-card="k_visa"]'), 'gone from the list');
});

test('a card no item uses: the confirm says so', async () => {
  await openCard('Visa 2024 2025 2026');
  $('#btn-card-delete').click();
  await until(() => isOpen($('#confirm-dialog')), 'the confirm opens');
  eq(text($('#confirm-message')), t('card.delete.messageUnused'), 'no item uses it');
  $$('#confirm-actions button')[0].click();
  await tick(60);
  assert(isOpen(cardSheet()), 'Cancel keeps the sheet');
  await closeSheets();
});

test('storage: an item and a new card are one commit (a bad card id stores neither); read back', async () => {
  const item = { ...base, id: 'e-atomic', name: 'Atomic', price: 1, cycle: 'monthly', nextRenewal: '2026-12-02', pay: 'bad-id' };
  let threw = false;
  try { await storage.saveItemWithCard(item, 'bad-id', { name: 'Bad' }); } catch { threw = true; }
  assert(threw, 'refused');
  eq((await storage.getAll()).some((s) => s.id === 'e-atomic'), false, 'no item stored');
  eq(Object.keys((await record()).fields).some((k) => k === 'card_bad-id'), false, 'no card stored');
  await storage.saveItemWithCard({ ...item, pay: 'k_atomic' }, 'k_atomic', { name: 'Atomic card', colour: 'c2' });
  eq((await storage.getAll()).find((s) => s.id === 'e-atomic').pay, 'k_atomic', 'the item, read back');
  eq((await record()).fields.card_k_atomic, { name: 'Atomic card', colour: 'c2', cut: null, due: null }, 'the card, read back');
  await storage.remove('e-atomic');
  await storage.deleteCard('k_atomic');
  await $('#money-summary').reload();
});

test('layout: the sheet and the Settings list stay inside the screen; a long nickname ellipsises; no animation with Reduce motion', async () => {
  await openAddCard();
  const body = $('#card-dialog .sheet-body');
  assert(body.scrollWidth <= body.clientWidth + 1, 'no sideways scroll in the sheet');
  for (const el of [cf().cardName, $('#card-colours'), cf().cardCut, cf().cardDue]) {
    const r = el.getBoundingClientRect();
    const b = body.getBoundingClientRect();
    assert(r.left >= b.left - 0.5 && r.right <= b.right + 0.5, `${el.name || el.id} inside the sheet`);
  }
  const save = $('#card-form button[type="submit"]').getBoundingClientRect();
  assert(save.bottom <= innerHeight + 0.5 && save.top >= 0, 'Save is on screen');
  if (reduced()) {
    const anims = cardSheet().getAnimations({ subtree: true }).filter((a) => a.playState === 'running');
    const long = anims.filter((a) => (a.effect?.getTiming().duration ?? 0) > 0.01);
    eq(long.map((a) => a.animationName ?? a.transitionProperty), [], 'Reduce motion and effects: nothing animates');
  }
  await closeSheets();
  await openSettings();
  await storage.saveCard('k_wide', { name: 'W'.repeat(40), colour: 'c3', due: 31, cut: 31 });
  await $('#money-summary').reload();
  await tick(60);
  const row = $('#card-list [data-card="k_wide"]');
  const name = row.querySelector('.card-row-name');
  assert(name.scrollWidth > name.clientWidth || name.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5, 'the long name stays in its row');
  assert(row.getBoundingClientRect().right <= $('#card-settings .panel').getBoundingClientRect().right + 0.5, 'the row stays in the panel');
  assert(document.documentElement.scrollWidth <= innerWidth, 'the page doesn\'t scroll sideways');
});

/* --------------------------------------------------------------------------------------------- */

async function run() {
  storage.useDatabase(dbName);
  for (const item of SEED) await storage.save(item);
  await storage.saveCard('k_visa', { name: 'Visa', colour: 'c7', cut: 25, due: 10 });
  // LINE Bank came from a later version: a colour this one can't draw (w3) and a key it doesn't know.
  {
    const r = { clock: syncCore.newClock('later-device'), records: new Map() };
    const ops = syncCore.setFields(r, 'settings', { card_k_line: { name: 'LINE Bank', colour: 'w3', note: 'future' } }, { now: Date.now() - 60_000 });
    await storage.applyRemote(ops, 1);
    assert((await storage.getSettingsRecord()).fields.card_k_line?.note === 'future', 'seeded');
  }
  await storage.saveLocalDefaults({ defaultCurrency: 'TWD' });
  storage.setPref('tab', 'subs');
  storage.setPref('view', 'wallet');
  storage.setPref('period', 'monthly');
  storage.setPref('theme', 'light');
  storage.setPref('insightsMode', 'month');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) localStorage.removeItem('substracker.reduceMotion');
  else storage.setPref('reduceMotion', 'off');
  for (const p of ['groupSort', 'dueSoon', 'dueSoonDays', 'dueSoonIncome', 'dueSoonDismissed']) localStorage.removeItem(`substracker.${p}`);
  if (LANG === 'zh-TW') storage.setPref('lang', 'zh-TW'); else localStorage.removeItem('substracker.lang');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#subs-list .w-item, #subs-list [data-id]'), 'app drawn', 8000);
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
    const fl = failures.find((x) => x.name === name);
    return `<li class="${fl ? 't-fail' : 't-pass'}">${fl ? '✗' : '✓'} ${name}${fl ? `<div class="t-detail">${fl.error.replace(/</g, '&lt;')}</div>` : ''}</li>`;
  }).join('');
  window.testResults = { total: results.length, passed, failures, reduced: reduced() };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
}

(async () => {
  try {
    for (const { name } of await indexedDB.databases?.() ?? []) {
      if (name?.startsWith('substracker-test-cards-') && name !== dbName) indexedDB.deleteDatabase(name);
    }
  } catch { /* databases() is missing in some browsers */ }
  run().catch((err) => { window.testResults = { total: 1, passed: 0, failures: [{ name: 'setup', error: err.message }] }; });
})();
