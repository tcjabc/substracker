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
// ?mode=zh      picks Traditional Chinese (zh-TW) in Settings → Language, with Chinese item and
//               category names, and walks the same screens: no raw keys, no English left beyond the
//               explained list (ZH_LATIN), nothing running out of its box, lang="zh-TW", the
//               picker per device, and the rolling totals ending on the formatted text. With
//               &reload=1 it also changes the language back to English through the picker and
//               checks the app reloads in English.
// &w=<px> is the frame's width (the overflow checks say so); &geom=1 records every element's box
// per screen in frameResults.geometry, to compare English layouts before and after a CSS change.
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
import en from '../js/locales/en.js';
import { WORDLIST } from '../js/wordlist.js';

const params = new URLSearchParams(location.search);
const MODE = ['pseudo', 'zh'].includes(params.get('mode')) ? params.get('mode') : 'en';
const WIDTH = Number(params.get('w')) || null;
const GEOM = params.get('geom') === '1';
const RELOAD = MODE === 'zh' && params.get('reload') === '1';
const RELOAD_KEY = 'substracker-test-i18n-reload';
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
const SEED_EN = [
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
// zh-TW: the same items as someone in Taiwan would name them, a long name and category included,
// so Chinese text wraps (no spaces to break at) in the person's data as well as the app's.
const ZH_NAMES = {
  't-salary': ['薪水'], 't-bonus': ['年終獎金'], 't-rent': ['房租', '居家'], 't-phone': ['中華電信 5G 行動上網', '水電瓦斯與網路', '吃到飽'],
  't-cloud': ['雲端儲存空間', '水電瓦斯與網路'], 't-stream': ['串流影音', '娛樂'], 't-concert': ['演唱會門票', '娛樂'],
  't-gym': ['健身房', '健康'], 't-misc': ['郵票'], 't-tool': ['開發工具', '水電瓦斯與網路'],
};
const SEED = MODE === 'zh'
  ? SEED_EN.map((s) => { const [name, category = s.category, plan = s.plan] = ZH_NAMES[s.id]; return { ...s, name, category, plan }; })
  : SEED_EN;
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
let dueSettingsEn = null; // English: Settings → Due soon, checked on its own (not in the recording)
const overflow = [];
const geometry = {};
const put = (key, lines) => {
  snap[key] = Array.isArray(lines) ? lines.map(norm) : [norm(lines)];
  if (MODE !== 'en') overflow.push(...overflowAt(key));
  if (GEOM) geometry[key] = boxesAt();
};

/**
 * Where every shown element is (rounded to half a pixel), to compare a layout before and after.
 * Anything inside an element that's animating (a sheet sliding in, a menu growing) is left out:
 * where it is depends on the moment, not the layout.
 */
function boxesAt() {
  const out = [];
  const moving = document.getAnimations().filter((a) => a.playState === 'running').map((a) => a.effect?.target).filter(Boolean);
  for (const el of document.querySelectorAll('#app-host *')) {
    if (el.closest('[hidden]') || !el.getClientRects().length) continue;
    if (moving.some((m) => m === el || m.contains?.(el))) continue;
    const r = el.getBoundingClientRect();
    const h = (v) => Math.round(v * 2) / 2;
    out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList[0] ? `.${el.classList[0]}` : ''} ${h(r.left)},${h(r.top + scrollY)} ${h(r.width)}x${h(r.height)}`);
  }
  return out;
}

/**
 * Where text doesn't fit at this moment (pseudo-locale, phone width): the page wider than the
 * screen, or a shown element whose content is wider than its box. Boxes meant to scroll or to cut
 * text on purpose (overflow auto or scroll, text-overflow: ellipsis, the screen-reader-only text,
 * the year chart's SVG, the Wallet stack's own clipping) don't count.
 */
function overflowAt(key) {
  const out = [];
  const root = document.documentElement;
  if (root.scrollWidth > innerWidth + 1) out.push(`${key}: the page is ${root.scrollWidth}px wide on a ${innerWidth}px screen`);
  for (const el of document.querySelectorAll('#app-host *')) {
    if (el.closest('[hidden], .sr-only, svg, #dev-sync, .odo-roll') || !el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    // A box that scrolls (a sheet's body) should only ever scroll up and down.
    if (/auto|scroll/.test(cs.overflowX) && el.clientWidth && el.scrollWidth > el.clientWidth + 1) {
      out.push(`${key}: ${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} scrolls sideways (${el.scrollWidth}px for ${el.clientWidth}px)`);
      continue;
    }
    // Otherwise only elements holding words of their own: a container wider than its box because of
    // a decoration it clips on purpose (the Wallet card's sheen) isn't text running out.
    if (![...el.childNodes].some((n) => n.nodeType === 3 && /\p{L}/u.test(n.nodeValue))) continue;
    if (cs.display === 'contents' || /auto|scroll/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') continue;
    if (el.clientWidth && el.scrollWidth > el.clientWidth + 1) {
      out.push(`${key}: ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${String(el.className).split(' ')[0]} is ${el.scrollWidth}px for ${el.clientWidth}px ("${norm(el.textContent).slice(0, 50)}")`);
    }
  }
  return out;
}
const dialogShown = (id) => { const d = $(`#${id}`); return d.open || d.hasAttribute('open'); };
/** A Money view from the header's View menu (js/app.js bindViewMenu). */
const pickView = (v) => { $('#view-btn').click(); $(`#view-menu [data-view="${v}"]`).click(); };

async function walk() {
  // The header, tabs and Money tab (Wallet).
  $('#tab-subs').click();
  await until(() => $('#wallet .w-band'), 'wallet drawn');
  put('doc', [document.title, `lang=${document.documentElement.lang}`]);
  // 1.20.0: Money's header is the title and one View button, and there's one + (both on new keys);
  // the Calendar tab is new, so English records the tab bar without it and the tab on its own key.
  put('header.money', grab($('.app-header')));
  put('tabbar', grab($('.tabbar'), { skip: MODE === 'en' ? ['#tab-calendar'] : [] }));
  put('tab.calendar', grab($('#tab-calendar')));
  put('fab.add', grab($('#fab-stack')));
  // 1.21.0: the Money card replaces the strip, the due-soon chip on it the banner (its totals moved
  // into the sheet), and income has its own card above the stack. All on new keys; the strip's and
  // the banner's are gone. The open-card announcement is on a new key too: the first card used to
  // be Income.
  put('money.card.monthly', grab($('#money-summary')));
  put('money.chip', [$('#due-chip').getAttribute('aria-label')]);
  $('#due-chip').click();
  await until(() => dialogShown('due-dialog'), 'due-soon sheet');
  put('money.due.sheet', grab($('#due-dialog')));
  pressBack();
  await tick(20);
  put('money.income', grab($('#income-card'), { skip: ['#income-list'] }));
  $('#income-toggle').click();
  await tick(20);
  put('money.income.open', grab($('#income-card'), { skip: ['.logo'] }));
  $('#income-toggle').click();
  await tick(20);
  put('wallet.host', [$('#wallet').getAttribute('aria-label')]);
  // The expense cards keep their keys from before 1.21.0 (Income was card 0 then).
  $$('#wallet .w-band').forEach((b, i) => put(`wallet.card.${i + 1}`, grab(b.closest('.w-card') ?? b.parentElement, { skip: ['.w-logos'] })));
  const firstBand = $('#wallet .w-band');
  firstBand.click();
  await tick(120);
  put('wallet.announce.open.group', [$('#wallet > p.sr-only')?.textContent]);
  pressBack();
  await tick(120);
  put('wallet.announce.close.group', [$('#wallet > p.sr-only')?.textContent]);

  $('#money-summary [data-period="annual"]').click();
  await tick(20);
  put('money.card.annual', grab($('#money-summary')));
  // (In the pseudo-locale, without the logo initials, which are the items' own first letters.)
  $$('#wallet .w-band').forEach((b, i) => put(`wallet.annual.band.${i + 1}`, [b.getAttribute('aria-label'),
    MODE === 'pseudo' ? grab(b, { skip: ['.w-logos'] })[0] : norm(b.textContent)]));
  put('money.income.annual', [norm($('#income-label').textContent)]);
  $('#money-summary [data-period="monthly"]').click();

  // The View button and its menu (1.20.0: the view and Sort in one menu; the Sort button's keys are gone).
  put('view.button', [$('#view-btn').getAttribute('aria-label'), $('#view-btn').title]);
  $('#view-btn').click();
  await tick(20);
  put('view.menu', grab($('#view-menu')));
  $('#view-menu [data-sort="total"]').click();
  await tick(20);
  put('view.sort.total', [$('#view-btn').getAttribute('aria-label')]);
  $('#view-btn').click();
  $('#view-menu [data-sort="items"]').click();
  await tick(20);
  put('view.sort.items', [$('#view-btn').getAttribute('aria-label')]);
  $('#view-btn').click();
  $('#view-menu [data-sort="az"]').click();
  await tick(20);

  // Grid and List (1.21.0: on new keys, without the Income section, and the gauge's words for all
  // the outgoings).
  pickView('grid');
  await tick(20);
  put('money.grid.groups', grab($('#subs-list')));
  put('money.income.grid', [norm($('#income-label').textContent)]);
  $('.group-dot').click();
  await tick(20);
  put('money.swatches', grab($('#swatch-pop')));
  pressBack();
  pickView('list');
  await tick(20);
  put('money.list.groups', grab($('#subs-list')));

  // The calendar (new in 1.19.0), recorded on its own keys: this month with today's list, a day
  // with income, an empty day and the next month. Its own tab since 1.20.0, with one summary line:
  // the month and the next month are on new keys.
  $('#tab-calendar').click();
  await until(() => $('#calendar .cal-grid'), 'calendar drawn');
  put('doc.calendar', [document.title, $('#page-title').textContent]);
  put('calendar.month', grab($('#calendar')));
  $('#calendar .cal-day[data-day="25"]').click();
  await tick(20);
  put('money.calendar.day', grab($('#calendar .cal-list')));
  $('#calendar .cal-day[data-day="19"]').click();
  await tick(20);
  put('money.calendar.empty', grab($('#calendar .cal-list')));
  $('#calendar [data-cal-step="1"]').click();
  await tick(20);
  put('calendar.next', grab($('#calendar')));
  $('#calendar [data-cal-today]').click();
  $('#tab-subs').click();
  await tick(20);

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
  pickView('wallet');
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
  // The language picker and the Due soon and Calendar settings are new since the 1.15.0 recording,
  // so English leaves them out of the screen (their own tests and keys check them); the other
  // languages walk them.
  put('settings', grab($('#panel-settings'), { skip: ['#dev-sync', '#app-version', ...(MODE === 'en' ? ['#lang-row', '#due-settings', '#calendar-settings'] : [])] }));
  if (MODE === 'en') dueSettingsEn = grab($('#due-settings'));
  put('settings.calendar', grab($('#calendar-settings')));

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
    JSON.stringify(aiImport.aiReplaceConfirm()), JSON.stringify(aiImport.aiReplaceConfirm({ synced: true })), aiImport.aiChoiceTitle(),
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

  test('Settings → Due soon in English: the three settings, with their defaults', async () => {
    eq(dueSettingsEn, ['Due soon Show the due-soon chip A chip on the Money card with how many items come due soon. Tap it for the list. Look ahead 3 days7 days14 days Include upcoming income Also list income with a payment date coming up.'], 'the words');
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
    await languageIsPerDevice('en');
    eq(i18n.saveLangSetting('auto'), 'auto', 'back to the device');
    eq(localStorage.getItem('substracker.lang'), null, 'auto is not stored');
  });
}

/**
 * Settings → Language: shown, Same as device then each language in its own name (never
 * translated), showing the current setting; the choice kept on this device only, never in a
 * backup, the shared settings or the sync outbox.
 */
async function languageIsPerDevice(pick) {
  const row = $('#lang-row');
  assert(!row.hidden && row.getClientRects().length, 'Settings → Language is shown');
  eq(norm($('.setting-label', row).textContent), i18n.t('settings.language'), 'its label');
  eq($$('#set-lang option').map((o) => o.value), ['auto', 'en', 'zh-TW'], 'Same as device, then each locale');
  eq($$('#set-lang option').map((o) => o.textContent), [i18n.t('settings.language.auto'), 'English', '繁體中文'], 'each language named in its own language');
  eq($$('#set-lang option').slice(1).map((o) => o.lang), ['en', 'zh-TW'], 'and marked with it, for the right glyphs');
  eq($('#set-lang').value, i18n.getLangSetting(), 'showing the setting');
  const opsBefore = await storage.pendingCount();
  eq(i18n.saveLangSetting(pick), pick, 'saved');
  eq(localStorage.getItem('substracker.lang'), pick, 'kept on this device');
  const backup = JSON.stringify(await storage.exportAll());
  assert(!/"lang"|substracker\.lang|"language"|zh-TW/.test(backup), 'not in a backup');
  const settings = await storage.getSettings();
  assert(!('lang' in settings) && !('language' in settings), 'not a shared setting');
  eq(await storage.pendingCount(), opsBefore, 'no op for sync');
  assert(!/lang|zh-TW/.test(JSON.stringify(await storage.pendingOps())), 'nothing about it queued');
}

/* ------------------------------------------------------------------ pseudo-locale */

/**
 * Text left over in `line` once everything that may stand as it is has been taken out: whatever
 * is inside [ ] (the pseudo-locale's words, with anything filled into them), money and other
 * numbers, currency codes, the person's own data, month names from the formatter, and
 * punctuation. Anything with two or more letters that's left would stay English in a translation.
 *
 * What this heuristic can't see, so it doesn't vouch for:
 * - screens and states the walk doesn't open (each is listed in walk(); a rare error message may
 *   never be shown there),
 * - text drawn into the WebGL Ring (the walk runs with Reduce motion, so the flat donut shows) and
 *   CSS generated content (the rolling digits),
 * - English hidden inside the person's data or formatter output (an item called "Monthly" passes),
 * - text built by joining two translated pieces in an English order: each piece is bracketed, so
 *   the order isn't checked (whole sentences are keys to avoid this, but it isn't proven here),
 * - one-letter words, and wording that reads oddly but is wrapped.
 */
function leftovers(line, allowed, months) {
  let s = String(line).replace(/^[a-z-]+=/, ''); // the label lines' "aria-label=" prefix is the test's own
  for (const a of allowed) s = s.split(a).join(' ');
  // The wording functions' dialogs are recorded as JSON: their property names and kinds are the test's.
  s = s.replace(/"(title|message|actions|label|value|kind)":/g, ' ').replace(/"(danger|primary)"/g, ' ');
  for (let prev = ''; prev !== s;) { prev = s; s = s.replace(/\[[^[\]]*\]/g, ' '); }
  // The year chart cuts long names to 17 characters with "…" (by design): a bracket opened and cut.
  s = s.replace(/\[[^[\]]*…/g, ' ');
  for (const m of months) s = s.split(m).join(' ');
  s = s.replace(/(?:NT|US|HK|A|C|NZ|S)?\$|[€£¥₩฿₫₹₱]|\bRM\b|\bRp\b|\bCHF\b/g, ' ');
  s = s.replace(/\d[\d.,]*\s?[KkMBT]?/g, ' ');
  return (s.match(/\p{L}{2,}/gu) || []);
}

if (MODE === 'pseudo') {
  test('the pseudo-locale is on: lang en-XA, the words in brackets', async () => {
    eq(i18n.getLocale(), 'xx', 'active locale');
    eq(document.documentElement.lang, 'en-XA', 'document lang');
    assert(/^\[.+\]$/.test($('#page-title').textContent), `page title "${$('#page-title').textContent}"`);
    eq(localStorage.getItem('substracker.lang'), null, 'never saved');
  });

  test('no text or label outside the dictionary on the key screens (see leftovers() for what this can miss)', async () => {
    const months = [];
    for (let m = 0; m < 12; m++) {
      for (const month of ['long', 'short']) months.push(new Date(2026, m, 1).toLocaleDateString(i18n.formatLocale(), { month }));
    }
    // The carousel's labels: three letters, or two where it's tight.
    months.push(...months.flatMap((m) => [m.replace('.', '').slice(0, 3), m.replace('.', '').slice(0, 2)]));
    months.sort((a, b) => b.length - a.length);
    const allowed = [...USER_TEXT, ...AI_TEXT, ...util.CURRENCIES, 'XYZ', 'Boom', 'Late', // the walk's own inputs
      '{"version": 1, "rows": [...]}', // the reply field's placeholder is JSON for the AI
      ...Object.values(i18n.LOCALES).map((l) => l.name), // Settings → Language names each language in its own
    ].sort((a, b) => b.length - a.length);
    const found = [];
    for (const [key, lines] of Object.entries(snap)) {
      for (const line of lines) {
        if (key === 'doc' && line.startsWith('lang=')) continue;
        const left = leftovers(line, allowed, months);
        if (left.length) found.push(`${key}: ${left.join(' ')}  ←  ${line.slice(0, 160)}`);
      }
    }
    eq(found, [], 'text that would stay English');
  });

  test(`every recorded screen fits a ${WIDTH ?? 360}px phone in the pseudo-locale (about 30% longer text)`, async () => {
    eq(innerWidth, WIDTH ?? 360, 'the frame is the width asked for');
    eq([...new Set(overflow)], [], 'text that runs out of its box');
  });
}

/* ------------------------------------------------------------------ zh-TW */

// Latin-script words that stay as they are in zh-TW, on purpose: names, codes and the JSON the
// import messages quote for the AI (the dictionary's own rule, docs/glossary-zh-TW.md).
const ZH_LATIN = new Set([
  'Peek', 'Budget', // the app's name
  'Android', 'Chrome', 'iPhone', 'iPad', 'Safari', 'IndexedDB', 'Google', 'favicon', 'Play', // products and the web storage's name
  'CSV', 'JSON', 'QR', 'AI', 'PDF', 'App', 'Enter', 'Esc', 'flat', // formats, keys and the ?flat=1 switch
  'Page', 'Up', 'Down', // the keys Page Up and Page Down, as printed on keyboards (the calendar's key hint)
  'English', // Settings → Language names each language in its own
  'Netflix', 'example', 'com', // the form's examples
  'name', 'amount', 'currency', 'cycle', 'nextDate', 'category', 'type', 'id', 'YYYY', 'MM', 'DD', // the AI's JSON names (ai.row.*)
]);
const KEYS = new Set(Object.keys(en).flatMap((k) => [k, k.replace(/\.(zero|one|two|few|many|other)$/, '')]));

/** A recorded line as plain text: the wording functions' dialogs are recorded as JSON. */
function plainLine(line) {
  const s = String(line).replace(/^[a-z-]+=/, '');
  if (!/^[{[]/.test(s)) return s;
  try {
    const out = [];
    JSON.parse(s, (k, v) => { if (typeof v === 'string' && k !== 'kind') out.push(v); return v; });
    return out.join(' | ');
  } catch { return s; }
}
/** Dictionary keys that reached the screen as they are. */
const rawKeys = (line) => [...String(line).matchAll(/[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+/g)].map((m) => m[0]).filter((k) => KEYS.has(k));
/**
 * Latin-script words left in a zh-TW line once the person's data, the walk's inputs, money and
 * numbers, the straight-quoted JSON names and values, the recovery words and ZH_LATIN are out.
 */
function englishLeft(line, allowed) {
  let s = plainLine(line);
  for (const a of allowed) s = s.split(a).join(' ');
  s = s.replace(/"[^"]*"/g, ' ');
  s = s.replace(/(?:NT|US|HK|A|C|NZ|S)?\$|[€£¥₩฿₫₹₱]|\bRM\b|\bRp\b|\bCHF\b/g, ' ');
  return (s.match(/[A-Za-z]{2,}/g) || []).filter((w) => !ZH_LATIN.has(w) && !WORDLIST.includes(w.toLowerCase()));
}

if (MODE === 'zh') {
  test('zh-TW is on: lang="zh-TW", its words, and its formats', async () => {
    eq(i18n.getLocale(), 'zh-TW', 'active locale');
    eq(document.documentElement.lang, 'zh-TW', 'document lang, so Traditional glyphs are used');
    eq(snap.doc, ['Peek Budget', 'lang=zh-TW'], 'the Money tab: document title (the app\'s name, as in English) and lang');
    eq(snap['doc.settings'], ['設定 · Peek Budget', '設定'], 'Settings: document and page title');
    const device = new Intl.DateTimeFormat().resolvedOptions().locale;
    eq(i18n.formatLocale(), /^zh\b/.test(device) ? undefined : 'zh-TW', `formatting locale on a ${device} browser`);
    eq(util.money(30000, 'TWD'), /^zh\b/.test(device) ? util.money(30000, 'TWD', device) : '$30,000', 'Taiwan dollars');
    eq(getComputedStyle(document.body).fontFamily.split(',')[0].trim(), 'system-ui', 'the system UI font first');
    assert(/JhengHei|PingFang TC|Noto Sans (CJK )?TC/.test(getComputedStyle(document.body).fontFamily), 'a Traditional Chinese UI font in the stack');
  });

  test('no dictionary key reaches the screen, and no English is left beyond ZH_LATIN', async () => {
    const allowed = [...new Set([...SEED.flatMap((s) => [s.name, s.plan, s.category]), ...AI_TEXT, ...util.CURRENCIES, 'XYZ', 'Boom', 'Late',
      '{"version": 1, "rows": [...]}', 'abilty', // the walk's mistyped recovery word
      'Entertainment', 'Utilities', // the AI reply's own categories (the person's data once imported)
    ])].filter(Boolean).sort((a, b) => b.length - a.length);
    const keys = [];
    const left = [];
    for (const [key, lines] of Object.entries(snap)) {
      for (const line of lines) {
        if (key === 'doc' && line.startsWith('lang=')) continue;
        const k = rawKeys(line);
        if (k.length) keys.push(`${key}: ${k.join(' ')}`);
        const w = englishLeft(line, allowed);
        if (w.length) left.push(`${key}: ${w.join(' ')}  ←  ${plainLine(line).slice(0, 160)}`);
      }
    }
    eq(keys, [], 'raw keys');
    eq(left, [], 'English that should be Chinese');
  });

  test(`every recorded screen fits a ${WIDTH}px phone in zh-TW`, async () => {
    eq(innerWidth, WIDTH, 'the frame is the width asked for');
    eq([...new Set(overflow)], [], 'text that runs out of its box, or a sheet that scrolls sideways');
  });

  test('Settings → Language: shown, per device, never in a backup, the settings or the sync outbox', async () => {
    eq(i18n.getLangSetting(), 'zh-TW', 'picked here');
    eq($('#set-lang').value, 'zh-TW', 'showing it');
    eq($$('#set-lang option')[0].textContent, '與裝置相同', 'Same as device, in Chinese');
    await languageIsPerDevice('zh-TW');
  });

  test('the rolling totals end on the formatted text, in place, with no glyph cut off', async () => {
    // Reduce motion off for this one check, then the Money tab to the front: the strip rolls.
    $('#tab-settings').click();
    await tick(20);
    $('#set-motion').click();
    await tick(20);
    $('#tab-subs').click();
    await until(() => $('#money-summary .odo-roll'), 'the strip rolling');
    const cur = 'TWD'; // the seeded default currency
    const rolls = $$('#money-summary [data-roll]').filter((el) => $('.odo-roll', el));
    assert(rolls.length, 'figures rolling');
    for (const el of rolls) {
      const txt = $('.odo-txt', el);
      const end = [...$('.odo-roll', el).children].map((c) => {
        if (c.classList.contains('odo-l')) return c.dataset.t;
        const s = $('.odo-s', c);
        const cells = s.dataset.s.split('\n');
        const pct = Number(/translateY\((-?[\d.]+)%\)/.exec(s.style.transform)?.[1] ?? 0);
        return cells[Math.round((-pct * cells.length) / 100)];
      }).join('');
      eq(end, txt.textContent, `${el.dataset.roll}: the roll ends on the text`);
      eq(txt.textContent, util.money(Number(el.dataset.value), el.dataset.cur || cur), `${el.dataset.roll}: the formatter's text`);
      const a = $('.odo-roll', el).getBoundingClientRect(), b = txt.getBoundingClientRect();
      assert(Math.abs(a.width - b.width) <= 1, `${el.dataset.roll}: the digits take the text's width (${a.width} vs ${b.width})`);
      assert(el.scrollHeight <= el.clientHeight + 1, `${el.dataset.roll}: no digit cut off (${el.scrollHeight} for ${el.clientHeight})`);
    }
    $('#tab-settings').click();
    await tick(20);
    $('#set-motion').click();
    $('#tab-subs').click();
    await tick(20);
  });
}

/** After the reload that changing the language causes: the app came back in English. */
async function afterReload(saved) {
  const out = { ...saved.result };
  const check = (name, fn) => { out.total++; try { fn(); out.passed++; } catch (err) { out.failures.push({ name: `zh: ${name}`, error: err.message }); } };
  check('changing the language reloads the app in the new one', () => {
    eq(localStorage.getItem('substracker.lang'), 'en', 'the new choice, on this device');
    eq(i18n.getLocale(), 'en', 'active locale after the reload');
    eq(document.documentElement.lang, 'en', 'document lang');
    eq($('#page-title').textContent, 'Money', 'drawn in English');
    eq($('#set-lang').value, 'en', 'the picker shows it');
    eq(saved.reloads, 1, 'one reload');
  });
  return out;
}

/* ------------------------------------------------------------------ run */

async function run() {
  // Back from the reload that the language change caused (?mode=zh&reload=1): check, then report.
  let reloaded = null;
  try { reloaded = JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? 'null'); } catch { /* none */ }
  sessionStorage.removeItem(RELOAD_KEY);
  if (reloaded) reloaded.reloads = (reloaded.reloads ?? 0) + 1;

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
  for (const p of ['catView', 'yearStack', 'yearKey', 'groupSort', ...(reloaded ? [] : ['lang'])]) localStorage.removeItem(`substracker.${p}`);
  // zh-TW is picked in Settings → Language (what the app reads at start-up), on a browser in any language.
  if (MODE === 'zh' && !reloaded) localStorage.setItem('substracker.lang', 'zh-TW');

  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  $$('script', doc.body).forEach((s) => s.remove());
  $('#app-host').append(...doc.body.childNodes);
  await import('../js/app.js');
  await until(() => $('#wallet .w-band'), 'app drawn');

  if (reloaded) {
    const res = await afterReload(reloaded);
    restorePrefs(reloaded.savedPrefs);
    window.frameResults = res;
    addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
    return;
  }

  let walkError = null;
  try { await walk(); } catch (err) { walkError = err; }
  const all = walkError ? [{ name: 'walk the screens', fn: () => { throw walkError; } }] : results;

  let passed = 0;
  const failures = [];
  for (const { name, fn } of all) {
    try { await fn(); passed++; } catch (err) { failures.push({ name: `${MODE}: ${name}`, error: err.message }); }
  }
  const result = {
    total: all.length, passed, failures,
    snapshot: MODE === 'en' ? { locale: navigator.language, recordedFrom: 'Peek Budget 1.15.0 (7782895)', screens: snap } : { locale: i18n.getLocale(), screens: snap },
    geometry: GEOM ? geometry : undefined,
  };
  addEventListener('pagehide', () => indexedDB.deleteDatabase(dbName));
  if (RELOAD && !walkError) {
    // Change the language back to English through the picker: the app saves it and reloads.
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ result, savedPrefs }));
    $('#tab-settings').click();
    await tick(20);
    const select = $('#set-lang');
    select.value = 'en';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await tick(3000); // the reload replaces this page; if it doesn't come, say so
    sessionStorage.removeItem(RELOAD_KEY);
    result.total++;
    result.failures.push({ name: 'zh: changing the language reloads the app in the new one', error: 'no reload within 3 s' });
  }
  restorePrefs(savedPrefs);
  window.frameResults = result;
}

function restorePrefs(prefs) {
  for (const [p, v] of Object.entries(prefs)) {
    if (v === null) localStorage.removeItem(`substracker.${p}`); else storage.setPref(p, v);
  }
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
