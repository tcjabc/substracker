import * as storage from './storage.js';
import { deliverFile } from './files.js';
import { isNative, platformName, plugin, setStatusBarStyle } from './platform.js';
import { overlays, createBackHandler, setBackHandler, pressBack } from './overlays.js';
import { DEFAULT_GROUPS, matchService, cleanDomain } from './services.js';
import { suggestMerges, mergeChanges, groupCounts } from './group-merge.js';
import { planSlots, slotsFromRecord, slotFields } from './group-slots.js';
import { categoryOptions, resolveNewGroup, NEW_GROUP } from './category-select.js';
import { createCardsUI, nextCardColour, cardNameError, cardGlyphHTML } from './cards-ui.js';
import { cardDatesSoon } from './card-dates.js';
import { listCards, cardNameProblem, cardByName, newCardId, payToSave, payCard, PAY_NEW_CARD, PAY_NOT_SET, PAY_CASH } from './cards.js';
import { CATEGORY_MAX } from './import-ai.js';
import { logoHTML, initLogoHandling, loadDeferredLogos } from './logos.js';
import { createWallet } from './wallet.js';
import {
  walletGroups, assignAutoColours, isWalletKey, WALLET_NAMES, WALLET_KEYS, sortGroups, groupSortFrom, othersText,
  frontGauge, totalGauge, gaugeNeedsRing, parseColour, MOTION,
} from './wallet-math.js';
import { springStep } from './tab-pill.js';
import { createSyncEngine } from './sync.js';
import { initSyncScreen } from './sync-ui.js';
import { initSyncSheet } from './sync-sheet.js';
import { initImportAiSheet, copyText } from './import-ai-sheet.js';
import { createTabPill } from './tab-pill.js';
import { bindSwipeNav } from './swipe-nav.js';
import { itemsCsv, itemsCsvText, csvItems } from './csv-export.js';
import { createRoller } from './count-anim.js';
import { initLanguage, applyI18n, formatLocale, t, tHTML, LOCALES, getLangSetting, saveLangSetting, relativeDays, dateWords, compareNames } from './i18n.js';
import { dueSoon, WINDOWS, windowFrom, chipOnFrom, includeIncomeFrom } from './due-soon.js';
import { createCalendar } from './calendar.js';
import { WEEK_STARTS, weekStartFrom, resolveWeekStart, localeWeekStart } from './calendar-math.js';
import { createKeyVault, nativeSecureStore } from './secure-key.js';
import { eraseBlock, runErase, staleExports, LOGO_CACHE, ERASE_CHANNEL } from './erase.js';
import { createSlideConfirm } from './slide-confirm.js';
import { createYearChart } from './year-chart.js';
import { rangeMonths, nowIndex, chartMonths } from './year-chart-math.js';
import { donutSlices, donutHTML, emptyDonutHTML, legendHTML, applyDonutHighlight, shareText } from './donut-flat.js';
import {
  CURRENCIES, localeCurrency, uid, esc, money, moneyParts, cycleLabel, isIncome, isOnce, firstEmoji,
  nextRenewal, daysUntil, renewalText, parseDate, shortDate, todayStamp,
  chooseImportMode, reduceMotionFrom, catViewFrom, yearStackFrom, viewFrom, backupLabel,
} from './util.js';
import {
  groupOf, byGroupName, breakdown, undatedRecurring, incomeDue, undatedIncome, yearSummary,
  stripSummary, undatedItems, groupLabel,
} from './insights-calc.js';

const APP_VERSION = '1.28.0';
// Format 5's first-launch step writes it into this device's version note (js/storage.js migrateFormat).
storage.setAppVersion(APP_VERSION);

// The old picked colours, g1 … g10 (--group-1 … --group-10 in app.css): still read and drawn exactly
// as they were picked, but no longer offered. New picks are palette slots (WALLET_KEYS, w1 … w15),
// saved as { name, swatch: wN, slot: N − 1 }.
const SWATCHES = [
  { key: 'g1', name: 'colour.g1' }, { key: 'g2', name: 'colour.g2' }, { key: 'g3', name: 'colour.g3' },
  { key: 'g4', name: 'colour.g4' }, { key: 'g5', name: 'colour.g5' }, { key: 'g6', name: 'colour.g6' },
  { key: 'g7', name: 'colour.g7' }, { key: 'g8', name: 'colour.g8' }, { key: 'g9', name: 'colour.g9' },
  { key: 'g10', name: 'colour.g10' },
]; // `name` is the colour's key in js/locales/
// The automatic Wallet colours' names, in palette order (js/wallet-math.js WALLET_NAMES is English).
const WALLET_COLOUR_KEYS = ['colour.w1', 'colour.w2', 'colour.w3', 'colour.w4', 'colour.w5', 'colour.w6', 'colour.w7',
  'colour.w8', 'colour.w9', 'colour.w10', 'colour.w11', 'colour.w12', 'colour.w13', 'colour.w14', 'colour.w15'];
const SWATCH_KEYS = new Set(SWATCHES.map((s) => s.key));
// Automatic colours come from the Wallet palette instead (w1 … w15, --wallet-1 … --wallet-15; see
// js/wallet-math.js). With settings shared they are palette slots in the household's record (synced,
// and in backups); only a device whose format 5 step hasn't run yet keeps some of its own.
const validSwatch = (k) => SWATCH_KEYS.has(k) || isWalletKey(k);
const swatchVarName = (key) => (isWalletKey(key) ? `--wallet-${key.slice(1)}` : `--group-${String(key).slice(1)}`);
const swatchVar = (key) => `var(${swatchVarName(key)})`;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  subs: [],
  settings: { defaultCurrency: localeCurrency('TWD'), groupColors: {} }, // groupColors: category name → swatch key
  view: viewFrom(storage.getPref('view')), // Money: Wallet (default) | Grid | List, per device (a saved Calendar is Wallet now)
  groupSort: groupSortFrom(storage.getPref('groupSort')), // Money: Sort groups A–Z (default) | Total | Items, per device
  colorPicks: new Set(), // groups with a colour in the household's record: picked, or a shared slot (left alone by this device's automatic colours)
  settingsRecord: null, // the shared settings record, read for group slots (js/group-slots.js); null before settings are shared
  cardsWritable: false, // cards can be written here (js/storage.js cardsWritable: settings are shared)
  formatMigrated: false, // format 5's first-launch step is verified here: this device's automatic colours are shared slots
  yearKey: storage.getPref('yearKey') === 'on', // year chart: Show key, per device
  // Insights "By category": the 3D Ring (default), the flat Donut or the List. A saved choice is kept.
  catView: catViewFrom(storage.getPref('catView')),
  donutActive: null, // highlighted donut slice key (the Ring's front slice), or null
  tab: ['subs', 'calendar', 'insights', 'settings'].includes(storage.getPref('tab')) ? storage.getPref('tab') : 'subs',
  period: storage.getPref('period') === 'annual' ? 'annual' : 'monthly', // the Money card's Monthly | Annual
  insightsCurrency: null,
  insightsMonth: startOfMonth(new Date()),
  insightsMode: storage.getPref('insightsMode') === 'year' ? 'year' : 'month', // Insights Month | Year
  yearRange: storage.getPref('yearRange') === 'year' ? 'year' : 'roll',     // This year | Rolling (default)
  yearStack: yearStackFrom(storage.getPref('yearStack')), // year chart: By category (default) | By type; a saved choice is kept
  yearIncome: false,   // year chart: Show income
  yearPos: null,       // year chart position, kept across redraws
  editingId: null,
  formType: 'expense', // what the open add/edit sheet is editing
};

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

/* --------------------------------------------------------------------------
   On-screen error reporter — an installed PWA has no console to look at.
   -------------------------------------------------------------------------- */
// The error itself (the browser's or the code's message) stays as it is; only the words around it
// are the app's. These are for reporting a bug, so they're short and plain.
function reportError(prefix, err) {
  const msg = (err && (err.message || String(err))) || t('error.unknown');
  try {
    toast(t('error.report', { prefix, message: msg }), { label: t('common.dismiss'), sticky: true, run: () => {} });
  } catch { /* toast markup missing — nothing more we can do */ }
}
window.addEventListener('error', (e) => {
  const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
  reportError(t('error.error'), { message: `${e.message || e.error?.message || t('error.script')}${where}` });
});
window.addEventListener('unhandledrejection', (e) => reportError(t('error.unhandled'), e.reason));

/* --------------------------------------------------------------------------
   Dialog helpers — fall back to a positioned [open] element where
   HTMLDialogElement.showModal is missing (older iOS Safari).
   -------------------------------------------------------------------------- */
const HAS_MODAL = typeof HTMLDialogElement === 'function'
  && typeof HTMLDialogElement.prototype.showModal === 'function';

const dialogOpen = (dlg) => dlg.open || dlg.hasAttribute('open');
const trackedDialogs = new WeakSet();

/**
 * Show a dialog and put it on the overlay stack (js/overlays.js). `back` is what Android Back does
 * with it: by default the same as its Cancel / X (closeDialog, which for the confirm dialog means
 * its first, least destructive action). The Sync sheet passes its own close, which waits while busy.
 */
function openDialog(dlg, { back } = {}) {
  if (!trackedDialogs.has(dlg)) {
    trackedDialogs.add(dlg);
    // However it closes (a button, Escape, a form submit), it leaves the stack.
    dlg.addEventListener('close', () => { if (!dialogOpen(dlg)) overlays.remove(dlg.id); });
  }
  // The add/edit sheet hides the floating buttons; see .sheet-open in app.css.
  if (dlg.classList.contains('sheet')) document.body.classList.add('sheet-open');
  if (HAS_MODAL) { if (!dlg.open) dlg.showModal(); } else {
    dlg.setAttribute('open', '');
    dlg.classList.add('dialog-fallback');
  }
  overlays.open(dlg.id, { close: back ?? (() => closeDialog(dlg)), isOpen: () => dialogOpen(dlg) });
}

function closeDialog(dlg, returnValue) {
  overlays.remove(dlg.id);
  if (HAS_MODAL) { if (returnValue === undefined) dlg.close(); else dlg.close(returnValue); return; }
  if (!dlg.hasAttribute('open')) return;
  if (returnValue !== undefined) dlg.returnValue = returnValue;
  dlg.removeAttribute('open');
  dlg.classList.remove('dialog-fallback');
  dlg.dispatchEvent(new Event('close'));
}

// Without native dialogs, method="dialog" forms would navigate. Emulate them,
// except #sub-form, whose own submit handler validates and closes.
function bindDialogFormFallback() {
  if (HAS_MODAL) return;
  $$('dialog form[method="dialog"]').forEach((f) => {
    if (f.id === 'sub-form') return;
    let last = '';
    f.addEventListener('click', (e) => {
      const b = e.target.closest('button[type="submit"]');
      if (b) last = b.value;
    });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      closeDialog(f.closest('dialog'), e.submitter?.value ?? last);
      last = '';
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = $$('dialog.dialog-fallback[open]').pop();
    if (open) closeDialog(open);
  });
}

/* --------------------------------------------------------------------------
   Android Back button: the topmost overlay closes (as its Cancel / X would); with none open,
   Back goes to the Money tab, and from there it sends the app to the background. Web and PWA
   are unchanged: there's no listener there, so the browser's own Back behaves as before.
   -------------------------------------------------------------------------- */
function bindBackButton() {
  const app = plugin('App');
  setBackHandler(createBackHandler({
    stack: overlays,
    getTab: () => state.tab,
    goRoot: () => setTab('subs'),
    // Minimise rather than exit: the app stays as it was (a sync or import in progress carries on)
    // and opens again where it was left, like Android's own Back on a home screen.
    minimize: () => { Promise.resolve(app?.minimizeApp?.()).catch((err) => console.error(err)); },
  }));
  if (!app || platformName() !== 'android') return;
  Promise.resolve(app.addListener('backButton', () => {
    try { pressBack(); } catch (err) { console.error(err); }
  })).catch((err) => console.error(err));
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */
async function init() {
  // The language first (English is bundled; another locale loads here), then its words in the markup.
  try { await initLanguage(); } catch (err) { console.error(err); }
  applyI18n();
  initLogoHandling();
  bindTabs();
  bindForm();
  bindSettings();
  bindErase();
  bindGroupMerge();
  // Settings → Payment cards and the card sheet (1.27.0). A write reads the data again, so the
  // Wallet, the item sheet's options and the list all follow.
  cardsUI = createCardsUI({
    storage, openDialog, closeDialog, confirmDialog, toast, keyboardLikely,
    record: () => state.settingsRecord, items: () => state.subs, writable: () => state.cardsWritable,
    changed: () => reloadData(),
  });
  initImportAiSheet({
    storage,
    ui: {
      openDialog, closeDialog, confirmDialog, toast, overlays, exportData, reloadData,
      items: () => state.subs, isSynced: syncIsSetUp, reduceMotion: () => reduceEffects(),
      cards: () => listCards(state.settingsRecord),
    },
  });
  bindEditTaps();
  bindDue();
  bindMoneyCard();
  bindInsightsMode();
  // The header's height, for Insights' first screen (app.css .ins-hero-fill): it grows when the
  // system bar is tall or a long title wraps.
  const header = $('.app-header');
  new ResizeObserver(() => document.documentElement.style.setProperty('--header-now', `${header.offsetHeight}px`)).observe(header);
  bindIncomeCard();
  bindGroupColors();
  bindViewMenu();
  // For tests, like the wallet's host.wallet: the rolling totals, and reading the data again.
  $('#money-summary').roller = roller;
  $('#money-summary').reload = () => reloadData();
  $('#income-card').gauge = gauge;
  $('#income-card').gaugeRing = (colour) => gaugeRing(colour);
  bindDialogFormFallback();
  bindBackButton();
  $$('[data-action="add"]').forEach((b) => b.addEventListener('click', () => openForm()));
  $$('[data-action="add-income"]').forEach((b) => b.addEventListener('click', () => openForm(null, 'income')));
  // The one +: an expense to start with (the sheet switches to income), on the Calendar tab on the
  // selected day.
  $('#fab').addEventListener('click', () => openForm(null, 'expense', { date: state.tab === 'calendar' ? calendarDay() : '' }));

  storage.setBlockedHandler(() => toast(t('toast.blocked'), {
    label: t('common.dismiss'), sticky: true, run: () => {},
  }));
  let syncUnavailable = t('sync.unavailable.storage');
  try {
    const [subs, settings, picks, record] = await Promise.all([storage.getAll(), storage.getSettings(), storage.getPickedGroupColors(), storage.getSettingsRecord()]);
    state.colorPicks = new Set(Object.keys(picks));
    state.settingsRecord = record;
    const st = await storage.status();
    state.formatMigrated = st.formatMigration?.verified === true;
    state.cardsWritable = await storage.cardsWritable();
    const usingLegacy = st.usingLegacy;
    syncUnavailable = usingLegacy ? t('sync.unavailable.legacy') : '';
    if (usingLegacy) {
      toast(t('toast.legacy'), {
        label: t('common.dismiss'), sticky: true, run: () => {},
      });
    }
    state.subs = subs;
    // Before 1.2.1 the default was always TWD and only stored once changed. Existing data keeps TWD so the
    // Money card doesn't switch currency; a fresh install takes the device's locale. Either way it's
    // kept as this device's own pick: it isn't synced, and a currency the household chose replaces it.
    if (!settings.defaultCurrency) {
      settings.defaultCurrency = subs.length ? 'TWD' : localeCurrency('TWD');
      storage.saveLocalDefaults({ defaultCurrency: settings.defaultCurrency }).catch(console.error);
    }
    Object.assign(state.settings, settings);
    state.settings.groupColors = sanitizeGroupColors(state.settings.groupColors);
    // Ask for persistent storage once there's data worth keeping (a first save asks too).
    if (subs.length) storage.requestPersistence();
  } catch (err) {
    console.error(err);
    toast(isNative()
      ? t('toast.noStorage.native')
      : t('toast.noStorage.web'));
  }

  if (isNative()) {
    // The native app has no install step and no use for the PWA install instructions.
    $$('[data-web-only]').forEach((el) => { el.hidden = true; });
    // App wording where the web copy talks about the browser or downloads (data-i18n-native).
    $$('[data-i18n-native]').forEach((el) => { el.textContent = t(el.dataset.i18nNative); });
  }
  fillStaticLists();
  applyTheme(storage.getPref('theme') || 'system');
  applyMotion();
  setTab(state.tab, { focus: false });
  render();
  registerSW();
  $('#app-version').textContent = t('settings.version', { app: t('app.name'), version: APP_VERSION });
  startSync(syncUnavailable).catch((err) => console.error(err));
}

/* --------------------------------------------------------------------------
   Sync (off until set up in Settings → Sync, or on the developer screen)
   -------------------------------------------------------------------------- */
// The sync parts Erase data on this device needs ({ engine, vault, available }): it asks the vault
// whether this device can sync, and stops the engine first. Null until startSync runs.
let syncParts = null;

async function startSync(unavailable) {
  let engine = null;
  // The household key: phone secure storage (Keystore/Keychain) where there is one, else IndexedDB.
  const vault = createKeyVault({ store: storage });
  // For Erase data on this device: whether sync can run here, the vault to ask, and (below) the engine to stop.
  syncParts = { engine: null, vault, available: !unavailable };
  if (!unavailable) {
    // Phones: move a key still in IndexedDB into secure storage (verified; a failure changes nothing).
    try { await vault.migrate(); } catch (err) { console.error(err); }
    if (storage.wasErased()) return; // erased meanwhile: the app opens again as a fresh launch
    engine = createSyncEngine({
      store: { ...storage.syncStore, getConfig: vault.readConfig, setConfig: vault.setConfig, replaceWithRemote: vault.replaceWithRemote },
    });
    // Changes from other devices (items, the default currency, group colours): refresh the screens
    // the same way an import or edit does.
    engine.onRemoteChanges(() => reloadData({ remote: true }));
    syncParts.engine = engine;
    engine.start().catch((err) => console.error(err)); // never blocks the app; failures show as status
  }
  let sheet = null;
  const dev = initSyncScreen({ engine, vault, unavailable, store: storage, ui: { toast, confirmDialog, setTab, onConfigChanged: () => sheet?.refresh() } });
  sheet = initSyncSheet({
    engine, storage, vault, unavailable,
    ui: { toast, confirmDialog, openDialog, closeDialog, exportData, overlays, onConfigChanged: () => dev.reload() },
  });
}

/**
 * Read items and settings again and redraw (after an import or changes from another device).
 * A remote change leaves the open add/edit form alone; only the Settings currency menu follows.
 */
async function reloadData({ remote = false } = {}) {
  const [subs, settings, picks, record] = await Promise.all([storage.getAll(), storage.getSettings(), storage.getPickedGroupColors(), storage.getSettingsRecord()]);
  state.colorPicks = new Set(Object.keys(picks));
  state.settingsRecord = record;
  const before = state.settings.defaultCurrency;
  state.subs = subs;
  Object.assign(state.settings, settings);
  if (!state.settings.defaultCurrency) state.settings.defaultCurrency = before;
  state.settings.groupColors = sanitizeGroupColors(state.settings.groupColors);
  if (remote) fillCurrencySelect($('#set-currency'), state.settings.defaultCurrency);
  else fillStaticLists();
  if (!remote || state.settings.defaultCurrency !== before) state.insightsCurrency = null;
  render();
}

/* --------------------------------------------------------------------------
   Tabs
   -------------------------------------------------------------------------- */
// The first tab keeps its internal id `subs` so a saved tab choice still restores.
const TAB_TITLES = { subs: 'tab.money', calendar: 'tab.calendar', insights: 'tab.insights', settings: 'tab.settings' };
/** The tabs with the + button: the ones that list items. */
const FAB_TABS = new Set(['subs', 'calendar']);

// The pill behind the active tab (js/tab-pill.js): it slides with every tab change, Back included.
let tabPill = null;
// Settings → Payment cards and the card sheet (js/cards-ui.js), bound in init().
let cardsUI = null;

function bindTabs() {
  tabPill = createTabPill($('.tabbar'), { reduceMotion: () => reduceEffects() });
  const tabs = $$('.tab');
  tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  $('.tabbar').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.dataset.tab);
    next.focus();
  });
  // A sideways swipe on a page goes to the next or previous tab (js/swipe-nav.js): a shortcut through
  // setTab, exactly as a tap. Not while an overlay is shown (a sheet, a menu, an open Wallet card);
  // an overlay left open on another tab and out of sight doesn't count, as for Back.
  bindSwipeNav({
    order: () => tabs.map((t) => t.dataset.tab),
    current: () => state.tab,
    go: (tab) => setTab(tab),
    blocked: () => overlays.top() !== null || !!document.querySelector('dialog[open]'),
  });
}

function setTab(tab, { focus = true } = {}) {
  const was = state.tab;
  state.tab = tab;
  storage.setPref('tab', tab);
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
  });
  tabPill?.moveTo($(`.tab[data-tab="${tab}"]`));
  $('#panel-subs').hidden = tab !== 'subs';
  document.body.classList.toggle('wallet-view', walletShown() && !reduceEffects());
  $('#panel-calendar').hidden = tab !== 'calendar';
  $('#panel-insights').hidden = tab !== 'insights';
  $('#panel-settings').hidden = tab !== 'settings';
  $('#subs-actions').hidden = tab !== 'subs';
  syncInsightsActions();
  $('#fab-stack').hidden = !FAB_TABS.has(tab);
  // Insights has no + button, so it keeps its own bottom room (app.css .insights-view), not the
  // Money and Calendar tabs' room for the button.
  document.body.classList.toggle('insights-view', tab === 'insights');
  $('#page-title').textContent = t(TAB_TITLES[tab]);
  document.title = tab === 'subs' ? t('app.name') : t('app.title', { tab: t(TAB_TITLES[tab]), app: t('app.name') });
  if (focus) window.scrollTo({ top: 0 });
  if (tab === 'insights') { if (was !== 'insights') roller.replay(); renderInsights(); }
  // Coming to the Calendar tab plays the month's figure again, like the Money card.
  if (tab === 'calendar') { if (was !== 'calendar') roller.replay(); renderCalendar(); }
  // Coming to the Money tab plays the rolling totals again (the Money card here, the Wallet cards in
  // relayout). The chip too: the day may have changed while another tab was showing.
  if (tab === 'subs' && was !== 'subs') { roller.replay(); renderMoneySummary(); renderDue(); }
  // The stack is sized from where it sits on screen, which it can't know while its tab is hidden.
  if (walletShown()) wallet?.relayout();
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */
function render() {
  ensureGroupColors();
  renderSubs();
  cardsUI?.render();
  if (state.tab === 'calendar') renderCalendar();
  if (state.tab === 'insights') renderInsights();
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// Groups (category or Uncategorised) and their order come from insights-calc.js.

/* Group colours ------------------------------------------------------------- */
/**
 * Give every expense group a colour. A colour someone chose stays exactly as it is (an old g one
 * too). With the household's settings shared, a group with no colour gets a shared palette slot
 * (js/group-slots.js: a default group's fixed slot, else the hash probe; past 15 groups the colours
 * repeat), written to the record so every device draws it the same; and the household's repair
 * moves a later automatic slot off one another group already uses. Format 5's first-launch step
 * (js/storage.js migrateFormat) adopts this device's own automatic colours from before as shared
 * slots; until it has been verified here, a group with such a colour keeps it on this device only,
 * as before (js/wallet-math.js assignAutoColours, never the same as its A–Z neighbour). Income has
 * no colour. Sort never changes a colour; close neighbours get the Wallet's divider. See the README.
 */
function ensureGroupColors() {
  const map = state.settings.groupColors;
  const names = [...new Set(state.subs.filter((s) => !isIncome(s)).map(groupOf))].sort(byGroupName);
  const rec = state.settingsRecord;
  if (rec) {
    const { shared, picks } = slotsFromRecord(rec);
    const held = new Map();
    for (const n of names) {
      if (shared.has(n)) continue;
      if (picks.has(n)) held.set(n, null); // an old g pick: holds no slot
      // Once the format 5 step has shared this device's own automatic colours, none is kept here alone.
      else if (state.formatMigrated) continue;
      else if (isWalletKey(map[n])) held.set(n, Number(map[n].slice(1)) - 1); // this device's own automatic colour
    }
    const plan = planSlots({ live: names, shared: new Map([...shared].filter(([n]) => names.includes(n))), held });
    const writes = [...plan.assign, ...plan.moves];
    if (writes.length) {
      const fields = slotFields(writes);
      for (const [k, v] of Object.entries(fields)) { rec.fields[k] = v; rec.ts[k] = '~'; } // as written, newest
      for (const { name, slot } of writes) { map[name] = `w${slot + 1}`; state.colorPicks.add(name); }
      storage.saveColourValues(fields).catch((err) => console.error(err));
    }
  }
  const picked = new Set(names.filter((n) => state.colorPicks.has(n) && validSwatch(map[n])));
  const patch = assignAutoColours(names, map, picked);
  Object.assign(map, patch);
  // An automatic pick stays on this device; only a colour someone chooses is shared.
  if (Object.keys(patch).length) storage.saveLocalDefaults({ groupColors: patch }).catch((err) => console.error(err));
}

const groupSwatch = (name) => (validSwatch(state.settings.groupColors[name]) ? state.settings.groupColors[name] : 'w1');
const swatchName = (key) => {
  const k = isWalletKey(key) ? WALLET_COLOUR_KEYS[Number(key.slice(1)) - 1] : SWATCHES.find((s) => s.key === key)?.name;
  return k ? t(k) : WALLET_NAMES[Number(String(key).slice(1)) - 1] ?? '';
};

/** Keep only valid `name → swatch key` pairs (picked swatches and automatic Wallet colours). */
function sanitizeGroupColors(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw)
    .filter(([k, v]) => typeof k === 'string' && k.trim() && k.length <= 40 && validSwatch(v))
    .map(([k, v]) => [k.trim(), v]));
}

// Swatch popover: opened from the colour dot beside a group heading on the Money page.
function bindGroupColors() {
  const pop = $('#swatch-pop');
  let group = null;
  let opener = null;

  const close = (refocus) => {
    overlays.remove('swatch-pop');
    if (pop.hidden) return;
    pop.hidden = true;
    opener?.setAttribute('aria-expanded', 'false');
    if (refocus) opener?.focus();
    group = null;
  };

  const open = (dot) => {
    group = dot.dataset.group;
    opener = dot;
    const current = groupSwatch(group);
    $('#swatch-pop-title').textContent = t('money.colour.title', { group: groupLabel(group) });
    // The 15 slot colours; one another group shows already gets a small mark (a duplicate is a choice).
    const others = new Set([...new Set(state.subs.filter((s) => !isIncome(s)).map(groupOf))].filter((g) => g !== group).map(groupSwatch));
    $('#swatch-grid').innerHTML = WALLET_KEYS.map((key) => {
      const label = others.has(key) ? t('money.colour.used', { colour: swatchName(key) }) : swatchName(key);
      return `
      <button type="button" class="swatch${others.has(key) ? ' is-used' : ''}" data-swatch="${key}" style="--swatch: ${swatchVar(key)}"
        aria-label="${esc(label)}" title="${esc(label)}" aria-pressed="${key === current}"></button>`;
    }).join('');
    pop.hidden = false;
    overlays.open('swatch-pop', { close: () => close(true), isOpen: () => !pop.hidden });
    dot.setAttribute('aria-expanded', 'true');
    // Below the dot, kept inside the viewport's side gutters.
    const r = dot.getBoundingClientRect();
    const gutter = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const left = Math.min(Math.max(gutter, r.left - gutter / 2), innerWidth - pop.offsetWidth - gutter);
    pop.style.left = `${left + scrollX}px`;
    pop.style.top = `${r.bottom + scrollY + gutter / 4}px`;
    $('.swatch[aria-pressed="true"]', pop)?.focus();
  };

  $('#subs-list').addEventListener('click', (e) => {
    const dot = e.target.closest('.group-dot');
    if (!dot) return;
    if (!pop.hidden && group === dot.dataset.group) close(true); else { close(false); open(dot); }
  });

  pop.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-swatch]');
    if (!b || !group) return;
    const name = group;
    state.settings.groupColors[name] = b.dataset.swatch;
    state.colorPicks.add(name); // chosen now: the automatic colours leave it alone
    const pickedSlot = WALLET_KEYS.indexOf(b.dataset.swatch);
    if (state.settingsRecord && pickedSlot >= 0) { // a pick, not automatic: the repair leaves it alone
      const k = storage.colorField(name);
      state.settingsRecord.fields[k] = { name, swatch: b.dataset.swatch, slot: pickedSlot };
      state.settingsRecord.ts[k] = '~';
    }
    close(false);
    renderSubs();
    $(`.group-dot[data-group="${CSS.escape(name)}"]`)?.focus();
    // A slot colour: its slot goes with it, so every device draws the group in the same slot.
    const slot = WALLET_KEYS.indexOf(b.dataset.swatch);
    try { await storage.saveSettings({ groupColors: { [name]: b.dataset.swatch }, ...(slot >= 0 ? { groupSlots: { [name]: slot } } : {}) }); } catch (err) {
      console.error(err);
      toast(t('money.colour.saveFailed'));
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.group-dot')) close(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) close(true); });
  window.addEventListener('resize', () => close(false));
}

/* View and Sort groups ------------------------------------------------------- */
const SORT_NAMES = { az: 'sort.name.az', total: 'sort.name.total', items: 'sort.name.items' };
const VIEW_NAMES = { wallet: 'money.view.wallet', grid: 'money.view.grid', list: 'money.view.list' };

/**
 * The View button shows what's in use: its icon is the view, its label names the view and the
 * order, and it turns the accent colour when the order isn't A–Z.
 */
function renderViewButton() {
  const btn = $('#view-btn');
  btn.dataset.view = state.view;
  btn.dataset.sort = state.groupSort;
  btn.setAttribute('aria-label', t('money.view.button', { view: t(VIEW_NAMES[state.view]), order: t(SORT_NAMES[state.groupSort]) }));
  $$('#view-menu [data-view]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.view === state.view)));
  $$('#view-menu [data-sort]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sort === state.groupSort)));
}

// The View menu: opened from the header's View button on the Money tab. One menu, two groups of
// radio items, View (Wallet, Grid, List) then Sort groups (arrow keys, Home, End, Enter or Space;
// Escape, Tab or Back close it). On the overlay stack, so Android Back closes it, and focus goes
// back to the button. Both choices are this device's own (localStorage); never synced or exported.
function bindViewMenu() {
  const btn = $('#view-btn');
  const menu = $('#view-menu');
  const items = () => $$('.menu-item', menu);

  const close = (refocus) => {
    overlays.remove('view-menu');
    if (menu.hidden) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  };
  const open = () => {
    renderViewButton();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    overlays.open('view-menu', { close: () => close(true), isOpen: () => !menu.hidden, isShown: () => state.tab === 'subs' });
    // Under the button, right edges lined up, inside the side gutter.
    const r = btn.getBoundingClientRect();
    const gutter = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    menu.style.top = `${r.bottom + gutter / 4}px`;
    menu.style.left = `${Math.max(gutter, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - gutter))}px`;
    // Focus on the view in use (the first checked item).
    (items().find((b) => b.getAttribute('aria-checked') === 'true') ?? items()[0]).focus();
  };
  const chooseSort = (sort) => {
    close(true);
    const next = groupSortFrom(sort);
    if (next === state.groupSort) return;
    state.groupSort = next;
    storage.setPref('groupSort', next);
    renderSubs({ reorder: true });
  };
  const chooseView = (view) => {
    close(true);
    const next = viewFrom(view);
    if (next === state.view) return;
    state.view = next;
    storage.setPref('view', next);
    if (next === 'wallet') window.scrollTo({ top: 0 });
    renderSubs();
  };

  btn.addEventListener('click', () => { if (menu.hidden) open(); else close(true); });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.menu-item');
    if (b?.dataset.sort) chooseSort(b.dataset.sort);
    else if (b?.dataset.view) chooseView(b.dataset.view);
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % list.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    else if (e.key === 'Tab') { close(false); return; }
    if (j === null) return;
    e.preventDefault();
    list[j].focus();
  });
  btn.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && menu.hidden) { e.preventDefault(); open(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(false);
  });
  window.addEventListener('resize', () => close(false));
  renderViewButton();
}

function renewalTag(sub) {
  const d = nextRenewal(sub);
  if (!d) return '';
  const soon = daysUntil(d) <= 7;
  return `<span class="tag${soon ? ' tag-soon' : ''}">${esc(renewalText(d, isIncome(sub)))}</span>`;
}

const oneOffTag = () => `<span class="tag tag-once">${esc(t('money.oneOff'))}</span>`;

/* Wallet view (js/wallet.js) ------------------------------------------------ */
let wallet = null;
let walletHost = null;

/* Due soon: the chip on the Money card and its sheet ------------------------------------------- */
/**
 * A small "3 due" chip on the Money card (js/due-soon.js): how many items come due in the next N
 * days. Tapping it opens the list in a sheet (on the overlay stack, so Android Back closes it),
 * with the totals at the top ("3 due in the next 7 days", the default currency's total, income
 * coming in, other currencies counted, undated items) and a row per item that opens its edit
 * sheet. The chip isn't there at all when nothing is due or when it's turned off in Settings.
 * Plain text: its figures don't roll. Its settings are per-device preferences, never synced or
 * exported.
 *
 * Card dates (1.29.0, js/card-dates.js): a payment card's statement closing and payment due days in
 * the same window are listed under their own "Card dates" heading, with no amounts, after the items.
 * They show the chip too, but never change its number (the items in the window, as dueSoon() counts
 * them): with no item due and a card date, it reads "Card dates" with no number. They are in no
 * total, count or "need a date" line.
 */
const dueSettings = () => ({
  on: chipOnFrom(storage.getPref('dueSoon')),
  windowDays: windowFrom(storage.getPref('dueSoonDays')),
  includeIncome: includeIncomeFrom(storage.getPref('dueSoonIncome')),
});
let dueNow = null; // what the chip counts now (dueSoon()'s result), or null when it's hidden
let dueCards = []; // the card dates in the same window (cardDatesSoon()), listed apart in the sheet

/** "Today", "Tomorrow", "In 3 days" within the week, else the date; `inline` for a sentence. */
const dueWhen = (r, { inline = false } = {}) => (r.days < 7 ? relativeDays(r.days, undefined, { capital: !inline }) : shortDate(r.date));

function renderDue() {
  const chip = $('#due-chip');
  const set = dueSettings();
  const cur = state.settings.defaultCurrency;
  const now = new Date();
  const res = dueSoon(state.subs, now, { windowDays: set.windowDays, includeIncome: set.includeIncome, currency: cur });
  // Beside the items, never among them: no amount, in no total or count.
  const cards = cardDatesSoon(listCards(state.settingsRecord), now, { windowDays: res.windowDays });
  const show = state.subs.length > 0 && set.on && (res.count > 0 || cards.length > 0);
  dueNow = show ? res : null;
  dueCards = show ? cards : [];
  if (chip) chip.hidden = !show;
  if (!show) {
    if (dialogOpen($('#due-dialog'))) closeDialog($('#due-dialog'));
    return;
  }
  // The sheet's top: how many and the default currency's total due; then, quiet, income coming in,
  // other currencies (not in any total) and undated items.
  const hasDue = res.rows.some((r) => r.currency === cur && !r.income);
  const summary = res.count
    ? t('dueSoon.summary', { count: res.count, days: res.windowDays })
    : t('dueSoon.summaryNone', { days: res.windowDays });
  const cardsWord = cards.length ? t('dueSoon.cardCount', { count: cards.length }) : '';
  const extra = [res.hasIncome ? t('dueSoon.income', { amount: money(res.incomeTotal, cur) }) : '', othersText(res.others)].filter(Boolean);
  $('#due-text').textContent = summary;
  $('#due-sum').textContent = hasDue ? t('dueSoon.total', { amount: money(res.total, cur) }) : '';
  $('#due-extra').textContent = extra.join(' · ');
  const undated = $('#due-undated');
  undated.hidden = !res.undated.length;
  if (res.undated.length) {
    undated.textContent = t('dueSoon.undated', { count: res.undated.length });
    undated.dataset.id = res.undated[0].id;
  }
  $('#due-notes').hidden = !extra.length && !res.undated.length;
  $('#due-notes').classList.toggle('has-both', extra.length > 0 && res.undated.length > 0);
  // The chip: "3 due", read out with the totals; "Card dates" when only card dates are in the window.
  $('#due-chip-text').textContent = res.count ? t('dueSoon.chip', { count: res.count }) : t('dueSoon.chipCards');
  chip.setAttribute('aria-label', [summary, hasDue ? t('dueSoon.total', { amount: money(res.total, cur) }) : '', ...extra, cardsWord].filter(Boolean).join(' · '));
  if (dialogOpen($('#due-dialog'))) fillDueList();
}

function fillDueList() {
  const res = dueNow;
  if (!res) return;
  const cur = state.settings.defaultCurrency;
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + res.windowDays);
  $('#due-range').textContent = t('dueSoon.range', { date: shortDate(end) });
  $('#due-list').innerHTML = res.rows.map((r) => {
    const s = r.item;
    const amount = money(r.amount, r.currency);
    const label = t(r.income ? 'dueSoon.row.income' : 'dueSoon.row', { name: s.name, when: dueWhen(r, { inline: true }), amount });
    const sub = [dueWhen(r), r.income ? t('group.income') : ''].filter(Boolean).map(esc).join(' · ');
    const note = r.currency === cur ? '' : `<span class="cycle">${esc(t('wallet.notInTotals', { currency: cur }))}</span>`;
    return `<li><button type="button" class="sub-row due-row${r.days === 0 ? ' due-today' : ''}" data-id="${esc(s.id)}" aria-label="${esc(label)}">
      ${logoHTML(s, 'sm')}
      <span class="sub-text"><span class="sub-name">${esc(s.name)}</span><span class="sub-plan">${sub}</span></span>
      <span class="sub-row-price"><span class="amount">${esc(amount)}</span>${note}</span>
    </button></li>`;
  }).join('');
  // The card dates, under their own heading after the items: the card, its kind and when, no amount.
  // Buttons to the card's sheet only where cards can be edited.
  const box = $('#due-cards');
  const writable = state.cardsWritable;
  box.hidden = !dueCards.length;
  box.innerHTML = dueCards.length ? `
    <h3 class="due-cards-title" id="due-cards-title">${esc(t('cardDates.title'))}</h3>
    <ul class="subs-list due-list" aria-labelledby="due-cards-title">${dueCards.map((r) => {
      const text = t(r.kind === 'due' ? 'cardDates.due' : 'cardDates.cut', { name: r.card.name });
      const label = t('cardDates.row', { text, when: dueWhen(r, { inline: true }) });
      const inner = `<span class="card-date-mark">${cardGlyphHTML(r.card)}</span>
      <span class="sub-text"><span class="sub-name">${esc(text)}</span><span class="sub-plan">${esc(dueWhen(r))}</span></span>`;
      return writable
        ? `<li><button type="button" class="sub-row due-row card-date-row${r.days === 0 ? ' due-today' : ''}" data-card="${esc(r.card.id)}" aria-label="${esc(t('cardDates.edit', { text: label }))}">${inner}</button></li>`
        : `<li><div class="sub-row due-row card-date-row${r.days === 0 ? ' due-today' : ''}" aria-label="${esc(label)}" role="group">${inner}</div></li>`;
    }).join('')}</ul>` : '';
  // "Tap an item to edit it.", naming cards too when card dates can be tapped; none when nothing can.
  const hint = $('#due-hint');
  const tapCards = dueCards.length > 0 && writable;
  const hintKey = res.rows.length ? (tapCards ? 'dueSoon.hintCards' : 'dueSoon.hint') : tapCards ? 'dueSoon.hintCardsOnly' : '';
  hint.hidden = !hintKey;
  if (hintKey) { hint.dataset.i18n = hintKey; hint.textContent = t(hintKey); }
}

function bindDue() {
  const dlg = $('#due-dialog');
  // The chip is drawn again with the Money card, so its tap is caught on the card.
  $('#money-summary').addEventListener('click', (e) => {
    if (!e.target.closest('#due-chip') || !dueNow) return;
    fillDueList();
    openDialog(dlg);
    $('#due-chip')?.setAttribute('aria-expanded', 'true');
  });
  dlg.addEventListener('close', () => {
    $('#due-chip')?.setAttribute('aria-expanded', 'false');
    // The edit sheet, opened from a row, may be open by now: it keeps the buttons hidden.
    if (!$$('dialog.sheet').some(dialogOpen)) document.body.classList.remove('sheet-open');
  });
  $$('[data-due-close]', dlg).forEach((b) => b.addEventListener('click', () => closeDialog(dlg)));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) { closeDialog(dlg); return; } // the backdrop
    const cardRow = e.target.closest('[data-card]');
    if (cardRow) { openCardDate(cardRow.dataset.card); return; } // closes this sheet first
    const row = e.target.closest('[data-id]');
    const sub = row && state.subs.find((s) => s.id === row.dataset.id);
    if (!sub) return;
    closeDialog(dlg);
    openForm(sub);
  });
}

/** Settings → Due soon: show the chip, how many days ahead, and whether income is listed. */
function bindDueSettings() {
  const show = $('#set-due');
  const days = $('#set-due-days');
  const income = $('#set-due-income');
  days.innerHTML = WINDOWS.map((n) => `<option value="${n}">${esc(t('settings.dueSoon.days', { count: n }))}</option>`).join('');
  const set = dueSettings();
  show.checked = set.on;
  days.value = String(set.windowDays);
  income.checked = set.includeIncome;
  show.addEventListener('change', () => { storage.setPref('dueSoon', show.checked ? 'on' : 'off'); renderSubs(); });
  days.addEventListener('change', () => { storage.setPref('dueSoonDays', days.value); renderSubs(); });
  income.addEventListener('change', () => { storage.setPref('dueSoonIncome', income.checked ? 'on' : 'off'); renderSubs(); });
}

/** Whether the Wallet is what the Money tab shows right now. */
const walletShown = () => state.tab === 'subs' && state.view === 'wallet' && state.subs.length > 0;

/**
 * The stack's height: from its top (under the header, the Money card and the income card, so it's
 * measured again whenever one of those changes height) down to the tab bar, so the page itself
 * doesn't scroll; and `inset`, the strip at its bottom covered by the one + button, which the last
 * card clears once the stack is scrolled to its end.
 */
function walletViewport() {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const top = walletHost.getBoundingClientRect().top + window.scrollY;
  const bar = $('.tabbar').getBoundingClientRect().height;
  const height = Math.max(20 * rem, innerHeight - top - bar - rem / 2);
  const fab = $('#fab-stack');
  const inset = fab.hidden ? 0 : Math.max(0, innerHeight - bar - rem / 2 - fab.getBoundingClientRect().top + rem / 2);
  return { height, inset };
}

function renderWallet(list, { reorder = false } = {}) {
  if (!walletHost) {
    walletHost = document.createElement('div');
    walletHost.id = 'wallet';
    wallet = createWallet(walletHost, {
      overlays,
      isShown: walletShown,
      reduced: () => reduceEffects(),
      viewport: walletViewport,
      logo: (s, size) => logoHTML(s, size, { neutral: true, defer: true }),
      loadLogos: loadDeferredLogos,
      // The item's live payment card, for the chip on its logo and its label (1.27.0); null otherwise.
      payCard: (s) => { const c = payCard(s, state.settingsRecord); return c ? { name: c.name, colour: c.colour } : null; },
      // A card's total rolls when it changes (js/count-anim.js); only cards on or near the screen.
      total: (el, g, near) => roller.show(g.total > 0 ? el : null, `wallet:${g.key}`, g.total, state.settings.defaultCurrency, { visible: near && moneyOnScreen() }),
      // The income card's gauge follows the front card, and names it once the stack stops.
      onFront: (g, { settled }) => onWalletFront(g, settled),
    });
    walletHost.wallet = wallet; // for tests, like the year chart's host.yearChart
  }
  if (walletHost.parentElement !== list || list.children.length !== 1) { list.textContent = ''; list.append(walletHost); }
  const cur = state.settings.defaultCurrency;
  const now = new Date();
  // Expense groups only: Income has its own card above the stack, never a Wallet card.
  const groups = moneyGroups().map((g) => ({ ...g, fillVar: swatchVarName(groupSwatch(g.name)) }));
  // A stronger divider between neighbours whose colours are close, in every sort (A–Z looks as
  // before unless two neighbours are close).
  const dividers = true;
  wallet.update({ groups, currency: cur, period: state.period, year: now.getFullYear(), month: now.getMonth(), dividers }, { reorder });
}

/* Income card and its gauge ------------------------------------------------------------------ */
/**
 * Income has its own compact card above the stack (pinned in the Wallet, where the stack scrolls
 * beneath it; first in Grid and List, scrolling with them), never part of the stack or of Sort.
 * Collapsed it shows its title and a gauge: how much of the period's income the front Wallet card
 * takes (in Grid and List, all the outgoings), in the default currency on the Money card's cash
 * basis (js/wallet-math.js incomeGauge). No income total: the Money card shows it. A tap opens the
 * income items (name and amount; a tap on one opens its edit sheet). Open or closed isn't saved.
 * The segment moves with the critically damped spring the stack uses (springStep), and jumps with
 * Reduce motion and effects; a segment colour under 3:1 against the track gets a thin ring.
 */
const gauge = { x: 0, v: 0, target: 0, raf: 0, last: 0, frames: 0 }; // frames: for tests
let incomeOpen = false;
let gaugeAnnounced; // the front card last announced; undefined until the stack first settles
let ringCache = new Map();

const yearlyPeriod = () => state.period === 'annual';

/** The Money card's figures for the period, in the default currency (stripSummary). */
function moneySummary() {
  const now = new Date();
  const cur = state.settings.defaultCurrency;
  return stripSummary(state.subs.filter((s) => s.currency === cur), state.period, now.getFullYear(), now.getMonth());
}

/** What the gauge shows now: { gauge, colour (a CSS colour), label }. */
function gaugeNow() {
  const income = moneySummary().income;
  // The Wallet: the open card, else the card in the front slot (js/wallet.js front()). With no front
  // card (Reduce motion and effects with every card closed, or no cards) it's the totals, as in Grid
  // and List.
  const g = state.view !== 'wallet' ? null
    : wallet && walletHost?.isConnected ? wallet.front() : reduceEffects() ? null : moneyGroups()[0] ?? null;
  if (g) {
    const k = frontGauge(g, income);
    return { gauge: k, colour: swatchVar(groupSwatch(g.name)), label: gaugeLabel(k, g.label) };
  }
  const k = totalGauge(moneyGroups(), income);
  return { gauge: k, colour: 'var(--accent)', label: gaugeLabel(k, null) };
}

/** The gauge's words: "House · 75% of income", "Outgoings · <1% of income", "No income this month"… */
function gaugeLabel(k, group) {
  if (k.kind === 'noIncome') return t(yearlyPeriod() ? 'income.gauge.noIncome.year' : 'income.gauge.noIncome.month');
  if (k.kind === 'empty') return t(yearlyPeriod() ? 'wallet.nothingDue.year' : 'wallet.nothingDue.month');
  if (k.kind === 'foreign') return t('income.gauge.foreign', { group });
  if (group === null) return k.tiny ? t('income.gauge.outgoingsTiny') : t('income.gauge.outgoings', { pct: k.pct });
  return k.tiny ? t('income.gauge.shareTiny', { group }) : t('income.gauge.share', { group, pct: k.pct });
}

/** Whether `colour` needs the ring against the gauge's track, in the theme in use (probed once a draw). */
function gaugeRing(colour) {
  if (!ringCache.has(colour)) {
    const probe = document.createElement('span');
    probe.style.color = colour;
    $('#income-card').append(probe);
    const fg = parseColour(getComputedStyle(probe).color);
    probe.remove();
    const back = parseColour(getComputedStyle($('#income-track')).backgroundColor);
    ringCache.set(colour, !!fg && !!back && gaugeNeedsRing(fg, back));
  }
  return ringCache.get(colour);
}

function setGaugeWidth(x) { $('#income-seg').style.width = `${(Math.max(0, Math.min(1, x)) * 100).toFixed(3)}%`; }
function gaugeTick(now) {
  gauge.raf = 0;
  const dt = gauge.last ? Math.min((now - gauge.last) / 1000, 1 / 30) : 1 / 60;
  gauge.last = now;
  [gauge.x, gauge.v] = springStep(gauge.x, gauge.v, gauge.target, MOTION.gaugeOmega, dt);
  if (Math.abs(gauge.x - gauge.target) < MOTION.gaugeRest && Math.abs(gauge.v) < MOTION.gaugeRest * 10) { gauge.x = gauge.target; gauge.v = 0; }
  setGaugeWidth(gauge.x);
  gauge.frames++;
  if (gauge.x !== gauge.target) gauge.raf = requestAnimationFrame(gaugeTick); else gauge.last = 0;
}
/** Move the segment to `ratio`: on the spring, or at once with Reduce motion and effects. */
function moveGauge(ratio) {
  gauge.target = ratio;
  if (reduceEffects() || !moneyOnScreen()) {
    if (gauge.raf) cancelAnimationFrame(gauge.raf);
    gauge.raf = 0; gauge.last = 0; gauge.x = ratio; gauge.v = 0;
    setGaugeWidth(ratio);
    return;
  }
  if (gauge.x !== ratio && !gauge.raf) gauge.raf = requestAnimationFrame(gaugeTick);
}

/** Draw the gauge for the front card (or the totals in Grid and List). */
function updateGauge() {
  const card = $('#income-card');
  if (card.hidden) return;
  const { gauge: k, colour, label } = gaugeNow();
  const seg = $('#income-seg');
  seg.hidden = k.kind !== 'share';
  seg.style.setProperty('--gauge-fill', colour);
  seg.classList.toggle('ic-seg-ring', k.kind === 'share' && gaugeRing(colour));
  $('#income-label').textContent = label;
  card.dataset.gauge = k.kind;
  moveGauge(k.kind === 'share' ? k.ratio : 0);
}

/** The stack moved to another front card, or stopped: the gauge follows, and names it once settled. */
function onWalletFront(g, settled) {
  if (!walletShown() || $('#income-card').hidden) return;
  updateGauge();
  if (!settled) return;
  const key = g?.key ?? null;
  if (gaugeAnnounced === undefined) { gaugeAnnounced = key; return; } // the first draw isn't news
  if (key === gaugeAnnounced) return;
  gaugeAnnounced = key;
  const live = $('#income-live');
  live.textContent = '';
  setTimeout(() => { live.textContent = $('#income-label').textContent; }, 30);
}

function renderIncomeCard() {
  const card = $('#income-card');
  const cur = state.settings.defaultCurrency;
  card.hidden = state.subs.length === 0;
  if (card.hidden) return;
  ringCache = new Map();
  const items = state.subs.filter(isIncome).sort(byName);
  const toggle = $('#income-toggle');
  toggle.setAttribute('aria-expanded', String(incomeOpen));
  card.classList.toggle('is-open', incomeOpen);
  const list = $('#income-list');
  list.hidden = !incomeOpen;
  list.innerHTML = items.length
    ? items.map((s) => `<li><button type="button" class="sub-row ic-row" data-id="${esc(s.id)}" aria-label="${esc(t('common.editItem', { name: s.name }))}">
      ${logoHTML(s, 'sm')}
      <span class="sub-text"><span class="sub-name">${esc(s.name)}</span></span>
      <span class="sub-row-price"><span class="amount">${esc(money(s.price, s.currency))}</span>${s.currency === cur ? '' : `<span class="cycle">${esc(t('wallet.notInTotals', { currency: cur }))}</span>`}</span>
    </button></li>`).join('')
    : `<li><button type="button" class="sub-row ic-row ic-add" data-add-income>${esc(t('money.addIncome'))}</button></li>`;
  if (incomeOpen) loadDeferredLogos(list);
}

function bindIncomeCard() {
  const card = $('#income-card');
  $('#income-toggle').addEventListener('click', () => {
    incomeOpen = !incomeOpen;
    renderIncomeCard();
    // The stack sits below the card: it measures its room again.
    if (walletShown()) wallet?.resize();
  });
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-add-income]')) { openForm(null, 'income'); return; }
    const row = e.target.closest('[data-id]');
    const sub = row && state.subs.find((s) => s.id === row.dataset.id);
    if (sub) openForm(sub);
  });
}

/* Calendar tab (js/calendar.js, js/calendar-math.js) -------------------------------------------- */
let calendar = null;
let calendarHost = null;

/** Whether the Calendar tab is what's on screen (its month figure may roll). */
const calendarOnScreen = () => state.tab === 'calendar' && document.visibilityState === 'visible';
/**
 * Open card `id`'s sheet from one of its dates (the Calendar's day list, the due-soon sheet), on the
 * overlay stack over the tab in use, so Back closes it there. The due-soon sheet closes first, as it
 * does for an item row. Only where cards can be edited (the rows are plain text otherwise).
 */
function openCardDate(id) {
  if (!state.cardsWritable || !cardsUI) return;
  const due = $('#due-dialog');
  if (dialogOpen(due)) closeDialog(due);
  cardsUI.open(id);
}

/** The calendar's selected day as YYYY-MM-DD (for the + button), or '' when no day is selected. */
function calendarDay() {
  const s = calendar?.state;
  if (!s?.selected) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${s.year}-${pad(s.month + 1)}-${pad(s.selected)}`;
}

/** Settings → Calendar → Week starts on: 'auto' (the default), 'mon' or 'sun'. Per device. */
const weekStartPref = () => weekStartFrom(storage.getPref('weekStart'));
/** The locale whose conventions "Automatic" follows: the formatting locale, else the device's. */
const weekLocale = () => formatLocale() ?? new Intl.DateTimeFormat().resolvedOptions().locale;
const weekStart = () => resolveWeekStart(weekStartPref(), weekLocale());

function renderCalendar() {
  if (!calendarHost) {
    calendarHost = document.createElement('div');
    calendarHost.id = 'calendar';
    // In the page before the first draw: the dots' rings are measured against the real styles.
    $('#panel-calendar').append(calendarHost);
    calendar = createCalendar(calendarHost, {
      items: () => state.subs,
      currency: () => state.settings.defaultCurrency,
      weekStart,
      reduced: () => reduceEffects(),
      dotColour: (group) => swatchVar(groupSwatch(group)),
      logo: (s) => logoHTML(s, 'sm'),
      onEdit: (s) => openForm(s),
      // Card dates (1.29.0, js/card-dates.js): beside the items, never among them.
      cards: () => listCards(state.settingsRecord),
      cardsWritable: () => state.cardsWritable,
      onCard: (id) => openCardDate(id),
      // Only the month's In, Out and Left over roll (from the old month's to the new one's); the
      // days are text. Left over rolls its size: it shows no sign.
      roll: (el, key, value, cur) => roller.show(value > 0 ? el : null, `calendar:${key}`, value, cur, { visible: calendarOnScreen() }),
    });
    calendarHost.calendar = calendar; // for tests, like the wallet's host.wallet
    return; // createCalendar has drawn it
  }
  calendar.update();
}

/**
 * Settings → Calendar → Week starts on: Automatic (the region's own first day, named in brackets),
 * Monday or Sunday. Weekday names come from Intl in the UI's language. Per device, never synced or
 * exported.
 */
function bindWeekStart() {
  const select = $('#set-week-start');
  // 16 November 2026 is a Monday, the 15th a Sunday.
  const dayName = (n) => dateWords(new Date(2026, 10, n === 1 ? 16 : 15), { weekday: 'long' });
  const names = { auto: t('settings.weekStart.auto', { day: dayName(localeWeekStart(weekLocale())) }), mon: dayName(1), sun: dayName(0) };
  select.innerHTML = WEEK_STARTS.map((v) => `<option value="${v}">${esc(names[v])}</option>`).join('');
  select.value = weekStartPref();
  select.addEventListener('change', () => {
    storage.setPref('weekStart', weekStartFrom(select.value));
    calendar?.update();
  });
}

/**
 * The Money tab's expense groups in the order Sort asks for, on the Money card's cash basis for the
 * period: js/wallet-math.js walletGroups and sortGroups. The Wallet, Grid and List all draw from
 * this, so they always agree. Income isn't one of them: it has its own card (renderIncomeCard).
 */
function moneyGroups() {
  const now = new Date();
  const cur = state.settings.defaultCurrency;
  const groups = walletGroups(state.subs, { currency: cur, period: state.period, year: now.getFullYear(), month: now.getMonth() });
  return sortGroups(groups, state.groupSort, cur);
}

function renderSubs({ reorder = false } = {}) {
  const list = $('#subs-list');
  const all = state.subs;

  renderViewButton();
  $('#subs-empty').hidden = all.length > 0;
  list.hidden = all.length === 0;
  $('#money-summary').hidden = all.length === 0;
  renderMoneySummary();
  renderDue();         // the chip on the Money card
  renderIncomeCard();  // before the Wallet, which sizes itself from where it sits below the income card
  document.body.classList.toggle('wallet-view', walletShown() && !reduceEffects());
  if (state.view === 'wallet') {
    if (all.length) renderWallet(list, { reorder }); else { wallet?.close(); list.textContent = ''; }
    updateGauge();
    return;
  }
  wallet?.close();
  gaugeAnnounced = undefined; // back in the Wallet, its first front card isn't news

  // The expense groups by category, in the order Sort asks for (items A–Z within each group).
  // Income has its own card above them.
  const groups = moneyGroups();

  const isList = state.view === 'list';
  list.innerHTML = groups.map((g, i) => {
    const key = groupSwatch(g.name);
    const dot = `<button type="button" class="group-dot" data-group="${esc(g.name)}" style="--swatch: ${swatchVar(key)}"
      aria-label="${esc(t('money.colour.dot', { group: g.label, colour: swatchName(key) }))}" aria-haspopup="dialog" aria-expanded="false"></button>`;
    return `
    <section class="money-group" aria-labelledby="group-${i}">
      <h2 class="section-title group-head" id="group-${i}">${dot}<span>${esc(g.label)} <span class="optional">${g.items.length}</span></span></h2>
      <div class="${isList ? 'subs-list' : 'subs-grid'}">${g.items.map(isList ? rowHTML : cardHTML).join('')}</div>
    </section>`;
  }).join('');
  updateGauge();
}

/**
 * The Money card: the period (this month, or this year in Annual), its Cash due as the big figure,
 * and Income and Left over, all from stripSummary(), so they are the Insights headline and yearly
 * card by construction. The Monthly | Annual toggle (it drives the Wallet totals too) and the
 * due-soon chip are their own controls; a tap anywhere else on the card opens Insights. Undated
 * items are left out and counted on one line that opens the first of them.
 */
function renderMoneySummary() {
  const host = $('#money-summary');
  const cur = state.settings.defaultCurrency;
  const inCur = state.subs.filter((s) => s.currency === cur);
  const others = state.subs.length - inCur.length;
  const now = new Date();
  const sum = stripSummary(inCur, state.period, now.getFullYear(), now.getMonth());
  const undated = undatedItems(inCur);
  const yearly = yearlyPeriod();
  const when = yearly
    ? t('common.year', { year: now.getFullYear() })
    : now.toLocaleDateString(formatLocale(), { month: 'long', year: 'numeric' });
  const short = sum.leftOver < 0;
  // The control that had focus keeps it through the redraw (a period button, the chip, the card).
  const focusKey = document.activeElement?.closest?.('#money-summary [data-focus]')?.dataset.focus;
  // `data-roll` names the figure for the rolling totals (stable in every language).
  host.innerHTML = `
    <button type="button" class="mc-open" data-focus="open" aria-label="${esc(t(yearly ? 'money.card.open.year' : 'money.card.open.month', { amount: money(sum.outgoings, cur) }))}"></button>
    <div class="mc-head">
      <span class="mc-when">${esc(when)}</span>
      <div class="segmented mc-period" role="group" aria-label="${esc(t('money.period.label'))}">
        <button type="button" class="seg-btn seg-btn-text" data-period="monthly" data-focus="monthly" aria-pressed="${!yearly}">${esc(t('money.period.monthly'))}</button>
        <button type="button" class="seg-btn seg-btn-text" data-period="annual" data-focus="annual" aria-pressed="${yearly}">${esc(t('money.period.annual'))}</button>
      </div>
    </div>
    <div class="mc-due">
      <span class="mc-label">${esc(t('money.card.cashDue'))}</span>
      <button type="button" class="mc-chip" id="due-chip" data-focus="chip" aria-haspopup="dialog" aria-expanded="false" aria-controls="due-dialog" hidden>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
        <span id="due-chip-text"></span>
      </button>
    </div>
    <div class="mc-value" data-roll="cash" data-value="${sum.outgoings}">${esc(money(sum.outgoings, cur))}</div>
    <dl class="mc-cells">
      <div class="mc-cell"><dt>${esc(t('money.income'))}</dt><dd data-roll="income" data-value="${sum.income}">${esc(money(sum.income, cur))}</dd></div>
      <div class="mc-cell${short ? ' mc-short' : ''}"><dt>${esc(t('money.leftOver'))}</dt><dd data-roll="left" data-value="${sum.leftOver}">${esc(money(sum.leftOver, cur))}</dd>${short ? `<dd class="mc-note">${esc(t('common.moreOutThanIn'))}</dd>` : ''}</div>
    </dl>
    ${undated.length ? `<button type="button" class="mc-undated" data-focus="undated" data-id="${esc(undated[0].id)}">${esc(t('common.excludesUndated', { count: undated.length }))}</button>` : ''}
    ${others ? `<p class="mc-note">${esc(t('money.otherCurrencies', { currency: cur, count: others }))}</p>` : ''}`;
  if (focusKey) $(`#money-summary [data-focus="${focusKey}"]`)?.focus({ preventScroll: true });
  // The three figures roll when they change, when the tab comes to the front and when the app comes back.
  $$('#money-summary [data-roll]').forEach((el) => roller.show(el, `card:${el.dataset.roll}`, Number(el.dataset.value), cur, { visible: moneyOnScreen() }));
}

/** The Money card: the period toggle, and a tap anywhere else (bar the chip and the undated line) opens Insights. */
function bindMoneyCard() {
  $('#money-summary').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (b) {
      state.period = b.dataset.period;
      storage.setPref('period', state.period);
      renderSubs();
      return;
    }
    if (e.target.closest('.mc-open')) openInsights();
  });
}

/** Insights on this month in the default currency: the figures the Money card shows. */
function openInsights() {
  state.insightsMonth = startOfMonth(new Date());
  state.insightsCurrency = null;
  state.donutActive = null;
  setTab('insights');
  $('#tab-insights').focus();
}

/* Rolling totals (js/count-anim.js) ------------------------------------------ */
// Up to 10 at once: the Money card's three and the Wallet cards on screen. Never with Reduce motion and effects.
const roller = createRoller({ reduced: () => reduceEffects(), parts: moneyParts, text: money, cap: 10, locale: formatLocale });
/** Whether the Money tab is what's on screen (so a total that changes can be seen to change). */
const moneyOnScreen = () => state.tab === 'subs' && document.visibilityState === 'visible';
// Coming back to the app on the Money tab plays them again, like coming back to the tab.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.subs.length) return;
  if (state.tab === 'subs') { roller.replay(); renderSubs(); }
  if (state.tab === 'calendar') { roller.replay(); renderCalendar(); }
  // Insights rolls its figures where they are, without drawing the tab again (the Ring stays put).
  if (state.tab === 'insights') { roller.replay(); rollInsights(); }
});

/**
 * Insights' single figures (data-roll: the month's total and Avg, the yearly card, the donut's
 * centre) roll by the same rules as the Money tab's. Per-slice amounts, legend rows, the Ring's
 * caption and the year chart's readout don't: the readout changes on every frame of a swipe.
 * Only figures on screen roll; the others just show their value.
 */
function rollInsights() {
  const shown = state.tab === 'insights' && document.visibilityState === 'visible';
  const vh = innerHeight;
  $$('#insights [data-roll]').forEach((el) => {
    const r = el.getBoundingClientRect();
    const onScreen = shown && r.width > 0 && r.bottom > 0 && r.top < vh;
    roller.show(el, `insights:${el.dataset.roll}`, Number(el.dataset.value), el.dataset.cur, { visible: onScreen });
  });
}

function onceDate(s) {
  const d = isOnce(s) ? parseDate(s.date) : null;
  return d ? shortDate(d) : '';
}

function cardHTML(s) {
  const meta = isOnce(s)
    ? [oneOffTag(), onceDate(s) ? `<span class="tag">${esc(onceDate(s))}</span>` : ''].join('')
    : renewalTag(s);
  return `
    <button type="button" class="sub-card" data-id="${esc(s.id)}" aria-label="${esc(t('common.editItem', { name: s.name }))}">
      ${logoHTML(s, 'md')}
      <span class="sub-text">
        <span class="sub-name">${esc(s.name)}</span>
        ${s.plan && !isIncome(s) ? `<span class="sub-plan">${esc(s.plan)}</span>` : ''}
      </span>
      <span class="sub-price"><span class="amount">${esc(money(s.price, s.currency))}</span><span class="cycle">${esc(cycleLabel(s.cycle))}</span></span>
      ${meta ? `<span class="sub-meta">${meta}</span>` : ''}
    </button>`;
}

function rowHTML(s) {
  const d = nextRenewal(s);
  const parts = [isIncome(s) ? '' : s.plan, isOnce(s) ? onceDate(s) : d ? renewalText(d, isIncome(s)) : ''];
  const sub = parts.filter(Boolean).map(esc).join(' · ');
  return `
    <button type="button" class="sub-row" data-id="${esc(s.id)}" aria-label="${esc(t('common.editItem', { name: s.name }))}">
      ${logoHTML(s, 'sm')}
      <span class="sub-text">
        <span class="sub-name">${esc(s.name)}</span>
        ${sub ? `<span class="sub-plan">${sub}</span>` : ''}
      </span>
      <span class="sub-row-price">
        <span class="amount">${esc(money(s.price, s.currency))}</span>
        ${isOnce(s) ? oneOffTag() : `<span class="cycle">${esc(s.cycle === 'annual' ? t('money.row.yearly') : t('money.row.monthly'))}</span>`}
      </span>
    </button>`;
}

// Tap a card / row / ranked item to edit. Bound on the list containers
// (which persist across re-renders) rather than on document.
function bindEditTaps() {
  const onTap = (e) => {
    const el = e.target.closest('[data-id]');
    if (!el || !e.currentTarget.contains(el)) return;
    const sub = state.subs.find((s) => s.id === el.dataset.id);
    if (sub) openForm(sub);
  };
  $('#subs-list').addEventListener('click', onTap);
  $('#insights').addEventListener('click', onTap);
  $('#money-summary').addEventListener('click', onTap); // the "Excludes N undated items" line
}

/* Insights ------------------------------------------------------------------ */
function currenciesInUse() {
  const counts = new Map();
  for (const s of state.subs) counts.set(s.currency, (counts.get(s.currency) || 0) + 1);
  const def = state.settings.defaultCurrency;
  return [...counts.keys()].sort((a, b) =>
    (a === def ? -1 : b === def ? 1 : counts.get(b) - counts.get(a))
  );
}

/** Month | Year in the header: shown on the Insights tab once there is something to analyse. */
function syncInsightsActions() {
  const box = $('#insights-actions');
  box.hidden = state.tab !== 'insights' || !state.subs.length;
  $$('[data-insights-mode]', box).forEach((b) => b.setAttribute('aria-pressed', String(state.insightsMode === b.dataset.insightsMode)));
}

function bindInsightsMode() {
  $('#insights-actions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-insights-mode]');
    if (!b || state.insightsMode === b.dataset.insightsMode) return;
    state.insightsMode = b.dataset.insightsMode;
    storage.setPref('insightsMode', state.insightsMode);
    renderInsights();
  });
}

/**
 * Insights. Month: the month arrows, one line with the month's outgoings as a share of its income,
 * then the chart with the month total in it: the Ring or flat donut in a card capped at about 40% of
 * the screen and pinned under the header while the legend (with the month's plan counts) scrolls
 * beneath it, or the List. Then the notices, the yearly card and the most expensive items. Year: the year chart first (renderYearView). Every figure is on a cash basis
 * from js/insights-calc.js.
 */
function renderInsights() {
  detachRing();
  syncInsightsActions();
  const root = $('#insights');
  const currencies = currenciesInUse();

  if (!state.subs.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-mark" aria-hidden="true"><svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></div>
        <h2>${esc(t('insights.empty.title'))}</h2>
        <p>${esc(t('insights.empty.text'))}</p>
      </div>`;
    return;
  }

  if (!currencies.includes(state.insightsCurrency)) state.insightsCurrency = currencies[0];
  const cur = state.insightsCurrency;
  const chipsHTML = currencies.length > 1 ? `
    <div class="chips" id="currency-chips" data-no-page-swipe role="group" aria-label="${esc(t('insights.currency.label'))}">
      ${currencies.map((c) => `<button type="button" class="chip" data-currency="${esc(c)}" aria-pressed="${c === cur}">${esc(c)}</button>`).join('')}
    </div>` : '';
  const currencyNotice = currencies.length > 1 ? `<p class="notice">${esc(t('insights.notice.currencies'))}</p>` : '';
  const bindChips = () => $$('#currency-chips .chip', root).forEach((c) => c.addEventListener('click', () => {
    state.insightsCurrency = c.dataset.currency;
    state.donutActive = null;
    renderInsights();
  }));

  const inCur = state.subs.filter((s) => s.currency === cur);
  if (state.insightsMode === 'year') {
    renderYearView(root, { inCur, cur, chipsHTML, currencyNotice });
    bindChips();
    rollInsights();
    return;
  }
  stopYearChart();

  const month = state.insightsMonth;
  const y = month.getFullYear();
  const m = month.getMonth();
  const monthName = month.toLocaleDateString(formatLocale(), { month: 'long', year: 'numeric' });
  const incomeItems = inCur.filter(isIncome);
  const subs = inCur.filter((s) => !isIncome(s)); // expenses only from here on

  // Outgoings and income on a cash basis: what falls due or is paid in this month (see
  // insights-calc.js). The two are compared, never added together.
  const incomeMonth = incomeDue(incomeItems, y, m);
  const due = breakdown(subs, y, m);
  const monthly = due.total;
  // The year of the viewed month from its twelve cash months; undated items are left out, as in
  // the month figures.
  const year = yearSummary(inCur, y);
  const countOf = (key) => due.byType.find((t) => t.key === key)?.names.length ?? 0;
  const inMonth = due.byCategory.flatMap((c) => c.items); // each with its `due` amount
  const undated = undatedRecurring(subs);
  const undatedTotal = undated.reduce((t, s) => t + s.price, 0);
  const undatedIn = undatedIncome(incomeItems);
  const undatedInTotal = undatedIn.reduce((t, s) => t + s.price, 0);
  const nUndated = undated.length + undatedIn.length; // a count of items; amounts are never mixed

  // `name` is the group's key (its colour is keyed by it); `label` is what shows.
  const catList = due.byCategory.map((c) => ({ name: c.group, label: groupLabel(c.group), total: c.amount, count: c.items.length }));
  const maxCat = catList[0]?.total || 1;
  const slices = donutSlices(catList, monthly, (name) => swatchVar(groupSwatch(name)));
  // The Ring, unless something rules it out; then the flat donut stands in, saying why.
  const ringWhy = state.catView === 'ring' && slices.length ? ringBlocker() : '';
  const showRing = state.catView === 'ring' && slices.length && !ringWhy;
  const isList = state.catView === 'list';
  const catViewBtn = (view, title, icon) => `
          <button type="button" class="seg-btn" data-catview="${view}" aria-pressed="${state.catView === view}" title="${esc(title)}">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>
            <span class="sr-only">${esc(title)}</span>
          </button>`;

  const ranked = [...inMonth].sort((a, b) => b.due - a.due || byName(a, b));

  // The month's outgoings as a share of its income (the figure the old headline card showed). No
  // percentage without income this month: the line says whether there's none at all or none paid now.
  const pct = incomeMonth ? Math.round((monthly / incomeMonth) * 100) : 0;
  const pctLine = incomeMonth
    ? t('insights.pctOfIncome', { pct })
    : incomeItems.length
      ? t('insights.headline.noIncomePaid', { currency: cur, month: monthName })
      : t('insights.headline.noIncomeRecorded', { currency: cur });
  // How many of the month's outgoings are monthly, annual and one-off: under the legend (or the list).
  const countsHTML = inMonth.length
    ? `<p class="legend-foot">${esc(t('insights.stat.counts', { monthly: countOf('monthly'), annual: countOf('annual'), once: countOf('once') }))}</p>` : '';
  const totalHTML = `<span class="ins-total" data-roll="month-due" data-value="${monthly}" data-cur="${esc(cur)}">${esc(money(monthly, cur))}</span>`;

  const listHTML = `
      <div class="panel ins-chart ins-list">
        <div class="ins-list-head">${totalHTML}<span class="donut-label">${esc(monthName)}</span></div>
        ${catList.length ? catList.map((c) => {
          const share = monthly ? Math.round((c.total / monthly) * 100) : 0;
          return `
          <div class="cat-row">
            <div class="cat-head">
              <span class="cat-name">${esc(c.label)} <span class="cat-count">${c.count}</span></span>
              <span class="cat-amount">${esc(money(c.total, cur))}<span class="pct">${share}%</span></span>
            </div>
            <div class="bar" role="img" aria-label="${esc(t('insights.catBar.label', { name: c.label, pct: share, month: monthName }))}"><div class="bar-fill" style="width:${Math.max(2, (c.total / maxCat) * 100).toFixed(1)}%"></div></div>
          </div>`;
        }).join('') : `<p class="panel-empty">${esc(t('insights.list.empty', { currency: cur, month: monthName }))}</p>`}
        ${countsHTML}
      </div>`;
  const chartHTML = isList ? listHTML
    : !slices.length ? emptyDonutHTML(cur, monthName)
    : showRing ? ringHTML(monthly, cur, monthName)
    : donutHTML(slices, monthly, cur, monthName, state.catView === 'ring' ? { note: ringWhy, keys: true } : {});
  // Ring and Donut: the chart card is capped in height and pinned under the header while the legend
  // scrolls beneath it (app.css .ins-pinned), so a row's slice turns or lights up right above it.
  const pinned = !isList && slices.length > 0;
  const legend = pinned ? `
    <section class="panel ins-legend" aria-label="${esc(t('insights.byCategory'))}">
      ${legendHTML(slices, monthly, cur)}
      ${countsHTML}
    </section>` : '';

  root.innerHTML = `
    <div class="ins-hero${isList ? '' : ' ins-month-chart'}${pinned ? ' ins-pinned' : ''}">
      <div class="month-nav">
        <button type="button" class="icon-btn" data-month-step="-1" aria-label="${esc(t('insights.month.previous'))}">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <span class="month-label" aria-live="polite">${esc(monthName)}</span>
        <button type="button" class="icon-btn" data-month-step="1" aria-label="${esc(t('insights.month.next'))}">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
        </button>
      </div>
      <p class="ins-pct${incomeMonth ? '' : ' ins-pct-none'}">${esc(pctLine)}</p>
      ${chipsHTML}
      <div class="section-head ins-chart-head">
        <h2 class="section-title" id="cat-title">${esc(t('insights.byCategory'))}</h2>
        <div class="segmented" role="group" aria-label="${esc(t('insights.catView.label'))}">
          ${catViewBtn('ring', t('insights.catView.ring'), '<ellipse cx="12" cy="11" rx="9" ry="4.5"/><ellipse cx="12" cy="11" rx="4" ry="1.8"/><path d="M3 11v2.5c0 2.5 4 4.5 9 4.5s9-2 9-4.5V11"/>')}
          ${catViewBtn('donut', t('insights.catView.donut'), '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5V8.5"/>')}
          ${catViewBtn('list', t('insights.catView.list'), '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>')}
        </div>
      </div>
      ${chartHTML}
      ${legend}
    </div>

    ${currencyNotice}
    ${undated.length ? `
    <button type="button" class="notice-action" data-notice="plans" data-id="${esc(undated[0].id)}">
      ${esc(t('insights.notice.plans', { count: undated.length, amount: money(undatedTotal, cur) }))}
    </button>` : ''}
    ${undatedIn.length ? `
    <button type="button" class="notice-action" data-notice="income" data-id="${esc(undatedIn[0].id)}">
      ${esc(t('insights.notice.income', { count: undatedIn.length, amount: money(undatedInTotal, cur) }))}
    </button>` : ''}
    <div class="stats ins-stats">${yearCardHTML(year, y, cur, nUndated)}</div>

    ${ranked.length ? `
    <section class="section" aria-labelledby="rank-title">
      <h2 class="section-title" id="rank-title">${esc(t('insights.ranked'))} <span class="optional">${esc(monthName)}</span></h2>
      <div class="panel">
        ${ranked.map((s, i) => `
          <button type="button" class="rank-row" data-id="${esc(s.id)}" aria-label="${esc(t('common.editItem', { name: s.name }))}">
            <span class="rank-num">${i + 1}</span>
            ${logoHTML(s, 'sm')}
            <span class="sub-text">
              <span class="sub-name">${esc(s.name)}</span>
              <span class="sub-plan">${isOnce(s) ? esc(t('insights.ranked.oneOff', { date: onceDate(s) })) : `${esc(money(s.price, s.currency))} ${esc(cycleLabel(s.cycle))}`}${s.plan ? ' · ' + esc(s.plan) : ''}</span>
            </span>
            <span class="sub-row-price">
              <span class="amount">${esc(money(s.due, cur))}</span>
              <span class="cycle">${esc(isOnce(s) ? t('insights.ranked.oneOffShort') : cycleLabel(s.cycle))}</span>
            </span>
          </button>`).join('')}
      </div>
    </section>` : ''}`;

  rollInsights();
  bindChips();
  $$('[data-month-step]', root).forEach((b) => b.addEventListener('click', () => {
    state.insightsMonth = new Date(y, m + Number(b.dataset.monthStep), 1);
    state.donutActive = null;
    renderInsights();
  }));
  $$('[data-catview]', root).forEach((b) => b.addEventListener('click', () => {
    state.catView = b.dataset.catview;
    storage.setPref('catView', state.catView);
    renderInsights();
  }));
  if (showRing) {
    mountRing(root, slices, monthly, cur, monthName);
    return;
  }
  // Tap a slice or legend row to highlight it; tap it again to clear.
  $$('[data-slice]', root).forEach((el) => el.addEventListener('click', () => {
    state.donutActive = applyDonutHighlight(root, state.donutActive === el.dataset.slice ? null : el.dataset.slice);
  }));
  // Standing in for the Ring, the flat donut takes the same arrow keys to move the highlight.
  $('[data-donut-keys]', root)?.addEventListener('keydown', (e) => {
    const i = slices.findIndex((s) => s.key === state.donutActive);
    const next = keyStep(e, i, slices.length);
    if (next === null) return;
    e.preventDefault();
    state.donutActive = applyDonutHighlight(root, slices[next].key);
  });
  state.donutActive = applyDonutHighlight(root, state.donutActive);
}

/* Ring (3D) ---------------------------------------------------------------- */
// js/donut-3d.js and three.js load on first use. Until then, and whenever the Ring can't run, the
// flat donut stands in. A failure (no WebGL, the module didn't load, a lost context) lasts the session.
let ringModule = null;
let ringFailure = ''; // the key of the note saying why the Ring can't show, for the session
let ring = null;
let ringAnnounced = null;

/** Why the Ring can't show right now (a sentence for the note above the flat donut), or ''. */
function ringBlocker() {
  if (reduceEffects()) return t('donut.flat.reduced');
  if (new URLSearchParams(location.search).get('flat') === '1') return t('donut.flat.param');
  if (ringFailure) return t(ringFailure);
  if (!webglWorks()) return t('donut.flat.noWebgl');
  return '';
}

let webglChecked = null;
function webglWorks() {
  if (webglChecked === null) {
    try {
      const c = document.createElement('canvas');
      webglChecked = !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { webglChecked = false; }
  }
  return webglChecked;
}

function detachRing() {
  ring?.detach();
  ring = null;
}

/** Arrow keys (and Home / End) as a step through n slices from index i; null for other keys. */
function keyStep(e, i, n) {
  const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (e.key === 'Home') return 0;
  if (e.key === 'End') return n - 1;
  if (d === undefined) return null;
  return i < 0 ? 0 : (i + d + n) % n;
}

/**
 * The Ring's stage, sized to the room its panel has (.ins-fit). The month total sits in the ring's
 * hole: js/donut-3d.js measures where that is (--ring-cx, --ring-cy, --ring-hole-w on the stage);
 * one caption line under the ring names the front slice, its amount and share. The legend is apart,
 * under the card.
 */
function ringHTML(total, cur, monthName) {
  return `
    <div class="panel ins-chart">
      <div class="ins-fit">
        <div class="ring-stage" data-no-page-swipe tabindex="0" role="group" aria-roledescription="${esc(t('donut.ring.role'))}"
          aria-label="${esc(t('donut.ring.label', { month: monthName }))}" aria-describedby="ring-help">
          <div class="ring-total"><span class="ins-total" data-roll="month-due" data-value="${total}" data-cur="${esc(cur)}">${esc(money(total, cur))}</span></div>
          <div class="ring-caption" aria-hidden="true"><span class="ring-name"></span><span class="ring-amount"></span><span class="ring-share"></span></div>
        </div>
      </div>
      <p class="sr-only" id="ring-help">${esc(t('donut.ring.help'))}</p>
      <p class="sr-only" id="ring-live" aria-live="polite" aria-atomic="true"></p>
    </div>`;
}

async function mountRing(root, slices, total, cur, monthName) {
  const stage = $('.ring-stage', root);
  const rows = $$('.legend-row', root);
  const describe = (s) => t('donut.ring.describe', { name: s.name, amount: money(s.total, cur), share: shareText(s.total, total) });
  let front = Math.max(0, slices.findIndex((s) => s.key === state.donutActive));
  let announceTimer = 0;
  const show = (i) => {
    front = i;
    const s = slices[i];
    state.donutActive = s.key;
    $('.ring-name', stage).textContent = s.name;
    $('.ring-amount', stage).textContent = money(s.total, cur);
    $('.ring-share', stage).textContent = shareText(s.total, total);
    stage.setAttribute('aria-label', t('donut.ring.labelFront', { month: monthName, front: describe(s) }));
    rows.forEach((r, k) => r.setAttribute('aria-pressed', String(k === i)));
  };
  // Announce once the ring is at rest, and only a slice that wasn't announced last.
  const announce = (i) => {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      if (!stage.isConnected || ringAnnounced === slices[i].key) return;
      ringAnnounced = slices[i].key;
      $('#ring-live', root).textContent = describe(slices[i]);
    }, 250);
  };
  const goTo = (i) => {
    if (ring) ring.goTo(i);
    else { show(i); announce(i); }
  };
  show(front);
  rows.forEach((r, k) => r.addEventListener('click', () => goTo(k)));
  stage.addEventListener('keydown', (e) => {
    const next = keyStep(e, front, slices.length);
    if (next === null) return;
    e.preventDefault();
    goTo(next);
  });

  const fallBack = (why) => {
    ringFailure = why;
    if (stage.isConnected) renderInsights();
  };
  try {
    ringModule ||= await import('./donut-3d.js');
  } catch (err) {
    console.error(err);
    fallBack('donut.flat.offline');
    return;
  }
  if (!stage.isConnected) return; // re-rendered while loading
  if (!ringModule.ringAvailable()) {
    fallBack('donut.flat.noWebgl');
    return;
  }
  try {
    ring = ringModule.createRing(stage, {
      slices, selected: front,
      onFront: show,
      onSettle: announce,
      onFail: () => { ring = null; fallBack('donut.flat.stopped'); },
    });
  } catch (err) {
    console.error(err);
    fallBack('donut.flat.noWebgl');
  }
}

/** The yearly card: Income, Outgoings and Left over from yearSummary(), for `y`. */
function yearCardHTML(year, y, cur, nUndated) {
  const yearShort = year.income > 0 && year.leftOver < 0;
  // `id` names the figure for the rolling totals (stable in every language); `label` is shown.
  const yearLine = (id, label, value, cls = '') => `
          <div class="year-line${cls}"><dt>${esc(label)}</dt><dd data-roll="year-${id}" data-value="${value}" data-cur="${esc(cur)}">${esc(money(value, cur))}</dd></div>`;
  return `
      <div class="stat stat-year">
        <div class="stat-label">${esc(t('common.year', { year: y }))}</div>
        <dl class="year-lines">${year.income > 0 ? yearLine('Income', t('insights.year.income'), year.income) : ''}${yearLine('Outgoings', t('insights.year.outgoings'), year.outgoings)}${year.income > 0
          ? yearLine('Left over', t('insights.year.leftOver'), year.leftOver, ` year-line-total${yearShort ? ' year-short' : ''}`) : ''}
        </dl>
        ${year.income > 0 ? '' : `<div class="stat-sub">${esc(t('insights.year.noIncome', { year: y }))}</div>`}
        ${yearShort ? `<div class="stat-sub year-short-note">${esc(t('common.moreOutThanIn'))}</div>` : ''}
        ${nUndated ? `<div class="stat-sub">${esc(t('common.excludesUndated', { count: nUndated }))}</div>` : ''}
      </div>`;
}

/* Year view ---------------------------------------------------------------- */
let yearChart = null;
function stopYearChart() {
  yearChart?.destroy();
  yearChart = null;
}

/**
 * Insights → Year: the range and stack controls and the year chart (js/year-chart.js) for the
 * months shown, filling the first screen; under them one line for undated items and the yearly
 * card for the current calendar year. Figures come from the calculation layer through chartMonths
 * (monthSeries and breakdown).
 */
function renderYearView(root, { inCur, cur, chipsHTML, currencyNotice }) {
  const now = new Date();
  const fadeIn = !!state.yearFadeIn;
  state.yearFadeIn = false;
  const undated = undatedItems(inCur);
  const pressed = (on) => `aria-pressed="${on}"`;
  root.innerHTML = `
    <div class="ins-hero ins-hero-fill">
    ${chipsHTML}
    <div class="yc-controls">
      <div class="segmented" role="group" aria-label="${esc(t('insights.range.label'))}">
        <button type="button" class="seg-btn seg-btn-text" data-year-range="year" ${pressed(state.yearRange === 'year')}>${esc(t('insights.range.year'))}</button>
        <button type="button" class="seg-btn seg-btn-text" data-year-range="roll" ${pressed(state.yearRange === 'roll')}>${esc(t('insights.range.roll'))}</button>
      </div>
      <div class="segmented" role="group" aria-label="${esc(t('insights.stack.label'))}">
        <button type="button" class="seg-btn seg-btn-text" data-year-stack="type" ${pressed(state.yearStack === 'type')}>${esc(t('insights.stack.type'))}</button>
        <button type="button" class="seg-btn seg-btn-text" data-year-stack="category" ${pressed(state.yearStack === 'category')}>${esc(t('insights.stack.category'))}</button>
      </div>
      <button type="button" class="chip" data-year-income ${pressed(state.yearIncome)}>${esc(t('insights.showIncome'))}</button>
    </div>
    <div class="yc-fit"><div id="year-chart" data-no-page-swipe></div></div>
    </div>
    ${currencyNotice}
    ${undated.length ? `<button type="button" class="summary-note summary-note-action yc-undated" data-id="${esc(undated[0].id)}">${esc(t('common.excludesUndated', { count: undated.length }))}</button>` : ''}
    <div class="stats yc-year-stats">${yearCardHTML(yearSummary(inCur, now.getFullYear()), now.getFullYear(), cur, 0)}</div>`;

  stopYearChart();
  const months = rangeMonths(state.yearRange, now);
  const data = chartMonths(inCur, months);
  yearChart = createYearChart($('#year-chart', root), {
    months: data.months, average: data.average, nowIndex: nowIndex(months, now),
    rolling: state.yearRange === 'roll', stack: state.yearStack, showIncome: state.yearIncome,
    money: (v) => money(v, cur), categoryColour: (g) => swatchVar(groupSwatch(g)), groupLabel,
    pos: state.yearPos, onSettle: (p) => { state.yearPos = p; }, fadeIn, overlays, reduced: reduceEffects(),
    showKey: state.yearKey, onKey: (on) => { state.yearKey = on; storage.setPref('yearKey', on ? 'on' : 'off'); },
  });

  $$('[data-year-range]', root).forEach((b) => b.addEventListener('click', () => {
    if (state.yearRange === b.dataset.yearRange) return;
    state.yearRange = b.dataset.yearRange;
    storage.setPref('yearRange', state.yearRange);
    state.yearPos = null; // a new range starts on the current month
    state.yearFadeIn = true;
    renderInsights();
  }));
  $$('[data-year-stack]', root).forEach((b) => b.addEventListener('click', () => {
    state.yearStack = b.dataset.yearStack;
    storage.setPref('yearStack', state.yearStack);
    $$('[data-year-stack]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    yearChart?.setStack(state.yearStack); // crossfade, no redraw
  }));
  $('[data-year-income]', root).addEventListener('click', () => {
    state.yearIncome = !state.yearIncome;
    renderInsights(); // the scale may change; the position is kept
  });
}

/* --------------------------------------------------------------------------
   Add / edit form
   -------------------------------------------------------------------------- */
// What was used last: 'key', or a pointer's type ('mouse', 'touch', 'pen'). The add sheet starts at
// Name only when a hardware keyboard is likely: a key was the last thing pressed, or the device has a
// fine pointer that hovers (a mouse) and wasn't just touched.
let lastInput = '';
document.addEventListener('keydown', () => { lastInput = 'key'; }, { capture: true });
document.addEventListener('pointerdown', (e) => { lastInput = e.pointerType || 'mouse'; }, { capture: true });
const keyboardLikely = () => lastInput === 'key'
  || (lastInput !== 'touch' && lastInput !== 'pen' && matchMedia('(hover: hover) and (pointer: fine)').matches);

const dialog = $('#sub-dialog');
const form = $('#sub-form');
// Tracks whether domain/category still hold auto-suggested values (safe to overwrite).
const auto = { domain: false, category: false };
// The item as it was when the edit sheet opened. Saving writes only the fields changed since then,
// so an edit synced from another device in the meantime isn't overwritten by the stale form value.
let formBase = null;

/** The item to save: the latest stored copy plus only the fields edited in the form. */
function mergeFormEdit(fromForm) {
  const latest = state.subs.find((s) => s.id === fromForm.id);
  if (!formBase || !latest) return fromForm;
  const out = { ...latest };
  for (const [k, v] of Object.entries(fromForm)) {
    if (k === 'id' || k === 'createdAt') continue;
    if (k === 'updatedAt' || v !== (formBase[k] ?? (k === 'type' ? 'expense' : ''))) out[k] = v;
  }
  return out;
}

function fillStaticLists() {
  fillCurrencySelect(form.elements.currency, state.settings.defaultCurrency);
  fillCurrencySelect($('#set-currency'), state.settings.defaultCurrency);
}

function fillCurrencySelect(select, selected) {
  const codes = new Set([...CURRENCIES, ...state.subs.map((s) => s.currency), selected]);
  select.innerHTML = [...codes].filter(Boolean)
    .map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

/**
 * The Category drop-down's options (js/category-select.js), built each time the sheet opens, with
 * `current` (the edited item's category, trimmed as the form saves it) selected. Choosing a default
 * group writes its name as plain text, as before; nothing is renamed or added by itself.
 */
let categoryChoices = [];
function fillCategorySelect(current = '') {
  const select = form.elements.category;
  categoryChoices = categoryOptions(state.subs, { nameOf: t, labelOf: groupLabel, compare: compareNames, current });
  select.innerHTML = categoryChoices.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  select.value = String(current ?? '').trim();
}

/** Show or hide the new group's name field ("New group…" chosen, and an expense). */
function syncNewGroup() {
  const f = form.elements;
  $('#field-new-group').hidden = state.formType === 'income' || f.category.value !== NEW_GROUP;
}

/**
 * The Payment method drop-down's options (1.27.0, js/cards.js), built each time the sheet opens: Not
 * set, Cash, the household's live cards by name, then "Add new card…" where cards can be written.
 * `current` (the edited item's pay) is selected when it is one of them; a pay that isn't (a card this
 * device hasn't received yet, a deleted one, a later version's value) shows as Not set and is kept as
 * it is unless the person changes the drop-down (readForm, js/cards.js payToSave).
 */
function fillPaySelect(current = '') {
  const select = form.elements.pay;
  const options = [
    { value: PAY_NOT_SET, label: t('form.pay.notSet') },
    { value: PAY_CASH, label: t('form.pay.cash') },
    ...listCards(state.settingsRecord).map((c) => ({ value: c.id, label: c.name })),
    ...(state.cardsWritable ? [{ value: PAY_NEW_CARD, label: t('form.pay.new') }] : []),
  ];
  select.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  select.value = options.some((o) => o.value === current && o.value !== PAY_NEW_CARD) ? current : PAY_NOT_SET;
  select.dataset.touched = '';
}

/** Show or hide the new card's nickname field ("Add new card…" chosen, and an expense). */
function syncNewCard() {
  const f = form.elements;
  $('#field-new-card').hidden = state.formType === 'income' || f.pay.value !== PAY_NEW_CARD;
}

/**
 * Open the add sheet (no `sub`; `type` is where its Expense | Income switch starts) or the edit
 * sheet for `sub`, which keeps its type: the switch is only there when adding. `date`
 * (YYYY-MM-DD, from the Calendar tab's selected day) fills in a new item's date; the date rules
 * are the usual ones.
 */
function openForm(sub = null, type = 'expense', { date = '' } = {}) {
  try {
    state.editingId = sub?.id ?? null;
    formBase = sub ? { ...sub } : null;
    state.formType = sub ? (isIncome(sub) ? 'income' : 'expense') : type;
    form.reset();
    clearErrors();
    const f = form.elements;
    fillCurrencySelect(f.currency, sub?.currency || state.settings.defaultCurrency);
    fillCategorySelect(sub?.category ?? '');
    fillPaySelect(sub?.pay ?? '');

    if (sub) {
      f.name.value = sub.name;
      f.domain.value = sub.domain || '';
      f.emoji.value = sub.emoji || '';
      f.plan.value = sub.plan || '';
      f.price.value = sub.price;
      f.cycle.value = sub.cycle;
      f.nextRenewal.value = sub.nextRenewal || '';
      f.date.value = sub.date || '';
      f.notes.value = sub.notes || '';
    } else if (isDay(date)) {
      // Both date fields, so the day stays whichever cycle is picked.
      f.nextRenewal.value = date;
      f.date.value = date;
    }
    auto.domain = !f.domain.value;
    auto.category = !f.category.value;

    f.kind.value = state.formType;
    $('#field-kind').hidden = !!sub;
    $('#btn-delete').hidden = !sub;
    // More details: folded when adding; open when the edited item has a value in one of the fields it
    // shows (income: only Notes). Open or closed isn't saved.
    const shownMore = state.formType === 'income' ? ['notes'] : MORE_FIELDS;
    setMoreDetails(!!sub && shownMore.some((k) => String(sub[k] ?? '').trim() !== ''));
    syncFormMode();
    updateFormLogo();
    openDialog(dialog);
    // showModal() focuses the first focusable control, the close button, so it would open with a
    // focus ring there. Adding starts at Name when a hardware keyboard is likely; otherwise (a touch
    // screen) and when editing, at the sheet itself (it has tabindex="-1"), so a phone's keyboard
    // doesn't open with the sheet. A tap on Name opens it as usual.
    if (!sub && keyboardLikely()) f.name.focus({ preventScroll: true }); else dialog.focus({ preventScroll: true });
  } catch (err) {
    console.error(err);
    reportError(t('form.error.open'), err);
  }
}

/** Show the fields that apply to the item type and cycle being edited. */
function syncFormMode() {
  const f = form.elements;
  const income = state.formType === 'income';
  const once = f.cycle.value === 'once';
  $('#sub-dialog-title').textContent = state.editingId
    ? t(income ? 'form.title.editIncome' : 'form.title.editExpense')
    : t(income ? 'form.title.newIncome' : 'form.title.newExpense');
  $$('[data-expense-only]', form).forEach((el) => { el.hidden = income; });
  syncNewGroup();
  syncNewCard();
  $('#field-renewal').hidden = once;
  $('#label-renewal').textContent = t(income ? 'form.renewal.income' : 'form.renewal.expense');
  $('#field-date').hidden = !once;
  $('#field-row-dates').hidden = $$('#field-row-dates > .field', form).every((el) => el.hidden);
  if (once && !f.date.value) f.date.value = todayStamp();
  if (!once) clearErrors('date');
  if (once) clearErrors('nextRenewal');

  f.name.placeholder = t(income ? 'form.name.placeholder.income' : 'form.name.placeholder.expense');
  f.notes.placeholder = t(income ? 'form.notes.placeholder.income' : 'form.notes.placeholder.expense');
  $('#label-price').textContent = t(income ? 'form.price.income' : 'form.price.expense');
  $('#label-cycle').textContent = t(income ? 'form.cycle.income' : 'form.cycle.expense');
}

/** The fields under More details. */
const MORE_FIELDS = ['domain', 'emoji', 'plan', 'category', 'pay', 'notes'];
function setMoreDetails(open) {
  $('#more-toggle').setAttribute('aria-expanded', String(open));
  $('#more-details').hidden = !open;
}

/**
 * The header tile: the item's logo, emoji or initial. Income has no logo or emoji fields in the
 * form, so a new income item's tile doesn't use what was typed there as an expense; an edited one
 * shows what it holds. Before there's anything to show, the "?" tile takes the type's tint.
 */
function updateFormLogo() {
  const f = form.elements;
  const income = state.formType === 'income';
  const hide = income && !state.editingId;
  const shown = { name: f.name.value.trim(), domain: hide ? '' : cleanDomain(f.domain.value), emoji: hide ? '' : firstEmoji(f.emoji.value) };
  const host = $('#form-logo');
  host.innerHTML = logoHTML({ ...shown, name: shown.name || '?' }, 'md');
  if (!shown.name && !shown.domain && !shown.emoji) host.dataset.placeholder = state.formType;
  else delete host.dataset.placeholder;
}

let logoTimer;
function bindForm() {
  const f = form.elements;

  // Fill domain/category from a known service name, unless the user has typed their own. When adding,
  // a field filled that way is under More details, so it opens by itself to show it (as it opens for
  // an edited item with a value there). Only opens, never folds; open or closed isn't saved. Name is
  // typed by hand: it has no suggestion list (no datalist, autocomplete off), so nothing opens over
  // a phone's keyboard; a typed known name fills these silently.
  const suggestFromName = () => {
    const svc = state.formType === 'income' ? null : matchService(f.name.value);
    const before = [f.domain.value, f.category.value];
    if (auto.domain) f.domain.value = svc ? svc.domain : '';
    if (auto.category) f.category.value = svc ? t(DEFAULT_GROUPS.find((g) => g.id === svc.group).key) : '';
    if (svc && !state.editingId && (f.domain.value !== before[0] || f.category.value !== before[1])) setMoreDetails(true);
    updateFormLogo();
  };
  f.name.addEventListener('input', () => {
    clearErrors('name');
    suggestFromName();
  });
  f.domain.addEventListener('input', () => {
    auto.domain = !f.domain.value;
    clearTimeout(logoTimer);
    logoTimer = setTimeout(updateFormLogo, 400);
  });
  // Category: a pick is the person's own (a known name no longer refills it), except Uncategorised.
  // "New group…" shows the name field and moves focus there, unless the pick came from the arrow
  // keys on the closed drop-down (a desktop keyboard steps through the options one change at a
  // time; the field is next in Tab order then).
  let categoryKeyed = false;
  const STEP_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  // Alt+Down opens the picker (Windows), so it isn't a step; a pick in the open picker moves focus.
  f.category.addEventListener('keydown', (e) => { categoryKeyed = STEP_KEYS.has(e.key) && !e.altKey; });
  f.category.addEventListener('pointerdown', () => { categoryKeyed = false; });
  const pickCategory = () => {
    auto.category = !f.category.value;
    clearErrors('newGroup');
    syncNewGroup();
    if (f.category.value === NEW_GROUP && !categoryKeyed) f.newGroup.focus();
    categoryKeyed = false;
  };
  f.category.addEventListener('change', pickCategory);
  f.category.addEventListener('input', () => { auto.category = !f.category.value; syncNewGroup(); });
  f.newGroup.addEventListener('input', () => clearErrors('newGroup'));
  // Payment method (1.27.0): the same rule. A change marks the drop-down as the person's (a pay it
  // didn't show is replaced only then); "Add new card…" shows the nickname field and moves focus
  // there, unless the pick came from the arrow keys on the closed drop-down.
  let payKeyed = false;
  f.pay.addEventListener('keydown', (e) => { payKeyed = STEP_KEYS.has(e.key) && !e.altKey; });
  f.pay.addEventListener('pointerdown', () => { payKeyed = false; });
  f.pay.addEventListener('change', () => {
    f.pay.dataset.touched = '1';
    clearErrors('newCard');
    syncNewCard();
    if (f.pay.value === PAY_NEW_CARD && !payKeyed) f.newCard.focus();
    payKeyed = false;
  });
  f.pay.addEventListener('input', () => { f.pay.dataset.touched = '1'; syncNewCard(); });
  f.newCard.addEventListener('input', () => clearErrors('newCard'));
  // Emoji: keep only the first emoji (whole grapheme), drop anything else. Selecting on focus
  // means a newly typed emoji replaces the old one instead of being appended and discarded.
  const keepEmoji = () => {
    const e = firstEmoji(f.emoji.value);
    if (f.emoji.value !== e) f.emoji.value = e;
    updateFormLogo();
  };
  f.emoji.addEventListener('input', (e) => { if (!e.isComposing) keepEmoji(); });
  f.emoji.addEventListener('compositionend', keepEmoji);
  f.emoji.addEventListener('focus', () => f.emoji.select());
  f.price.addEventListener('input', () => clearErrors('price'));
  f.date.addEventListener('input', () => clearErrors('date'));
  f.nextRenewal.addEventListener('input', () => clearErrors('nextRenewal'));
  $$('input[name="cycle"]', form).forEach((r) => r.addEventListener('change', syncFormMode));
  // Expense | Income switch (adding only): swaps the type-specific fields and keeps everything
  // typed so far. readForm uses formType.
  $$('input[name="kind"]', form).forEach((r) => r.addEventListener('change', () => {
    state.formType = f.kind.value === 'income' ? 'income' : 'expense';
    clearErrors('nextRenewal'); // its message names a renewal or a payment
    syncFormMode();
    suggestFromName();
  }));
  $('#more-toggle').addEventListener('click', () => setMoreDetails($('#more-toggle').getAttribute('aria-expanded') !== 'true'));
  dialog.addEventListener('close', () => document.body.classList.remove('sheet-open'));

  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => closeDialog(dialog)));
  // Tap on the backdrop closes the sheet.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(dialog); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fromForm = readForm();
    if (!fromForm) return;
    // "Add new card…": the card readForm described is stored with the item, in one commit.
    const newCard = fromForm.newCard ?? null;
    delete fromForm.newCard;
    const sub = mergeFormEdit(fromForm);
    try {
      if (newCard) await storage.saveItemWithCard(sub, newCard.id, newCard.card);
      else await storage.save(sub);
      if (newCard) state.settingsRecord = await storage.getSettingsRecord();
      const i = state.subs.findIndex((s) => s.id === sub.id);
      if (i >= 0) state.subs[i] = sub; else state.subs.push(sub);
      closeDialog(dialog);
      render();
      toast(t(i >= 0 ? 'form.toast.saved' : 'form.toast.added', { name: sub.name }));
      storage.requestPersistence();
    } catch (err) {
      console.error(err);
      toast(t('form.toast.saveFailed'));
    }
  });

  $('#btn-delete').addEventListener('click', async () => {
    const sub = state.subs.find((s) => s.id === state.editingId);
    if (!sub) return;
    const ok = await confirmDialog({
      title: t('form.delete.title', { name: sub.name }),
      message: t('form.delete.message'),
      actions: [{ label: t('common.cancel'), value: false }, { label: t('form.delete'), value: true, kind: 'danger' }],
    });
    if (!ok) return;
    try {
      await storage.remove(sub.id);
    } catch (err) {
      console.error(err);
      toast(t('form.toast.deleteFailed'));
      return;
    }
    state.subs = state.subs.filter((s) => s.id !== sub.id);
    closeDialog(dialog);
    render();
    toast(t('form.toast.deleted', { name: sub.name }));
  });
}

function readForm() {
  const f = form.elements;
  const name = f.name.value.trim();
  const priceRaw = f.price.value.trim().replace(',', '.');
  const price = Number(priceRaw);
  let valid = true;

  const income = state.formType === 'income';
  const cycle = ['annual', 'once'].includes(f.cycle.value) ? f.cycle.value : 'monthly';

  if (!name) { setError('name', t('form.error.name')); valid = false; }
  if (priceRaw === '' || !Number.isFinite(price) || price < 0) {
    setError('price', t(income ? 'form.error.price.income' : 'form.error.price.expense')); valid = false;
  }
  if (cycle === 'once' && !isDay(f.date.value)) { setError('date', t('form.error.date')); valid = false; }
  // Recurring items need a date to show in a month: a renewal for an expense, a payment for income
  // (both kept in nextRenewal). An item saved before this was required keeps working without one
  // until it's edited; then the date has to be picked.
  if (cycle !== 'once' && !isDay(f.nextRenewal.value)) {
    setError('nextRenewal', t(income ? 'form.error.renewal.income' : 'form.error.renewal.expense')); valid = false;
  }
  // Category: the option picked, or under "New group…" the name typed (js/category-select.js): empty
  // is Uncategorised, a name that is already an option picks that option, too long is refused.
  let category = f.category.value === NEW_GROUP ? '' : f.category.value.trim();
  if (!income && f.category.value === NEW_GROUP) {
    const picked = resolveNewGroup(f.newGroup.value, categoryChoices, { max: CATEGORY_MAX });
    if (picked.error) {
      setMoreDetails(true); // the field is under More details, which may have been folded since
      setError('newGroup', t('form.error.groupLong', { max: CATEGORY_MAX })); valid = false;
    } else if (!picked.created) {
      category = picked.value;
      f.category.value = picked.value;
      f.newGroup.value = '';
      syncNewGroup();
    } else category = picked.value;
  }
  // Payment method: the option picked, or under "Add new card…" the nickname typed (js/cards.js):
  // empty is Not set, a nickname that is already a card picks that card, one that looks like a card
  // number or is too long is refused. A new card is described here and stored with the item (submit).
  let pay = f.pay.value;
  let newCard = null;
  if (!income && pay === PAY_NEW_CARD) {
    const typed = f.newCard.value.trim();
    const cards = listCards(state.settingsRecord);
    const problem = typed ? cardNameProblem(typed) : '';
    const same = typed && !problem ? cardByName(cards, typed) : null;
    if (!typed) pay = PAY_NOT_SET;
    else if (problem) {
      setMoreDetails(true);
      setError('newCard', cardNameError(problem)); valid = false;
    } else if (same) {
      pay = same.id;
      f.pay.value = same.id;
      f.newCard.value = '';
      syncNewCard();
    } else {
      const id = newCardId(state.settingsRecord);
      newCard = { id, card: { name: typed, colour: nextCardColour(cards) } };
      pay = id;
    }
  }
  if (!valid) {
    const bad = form.querySelector('[aria-invalid="true"]');
    bad?.focus();
    // Focus scrolls the field into view, but its message underneath can stay hidden at the bottom.
    if (bad) $(`[data-error-for="${bad.name}"]`, form)?.scrollIntoView({ block: 'nearest' });
    return null;
  }

  const existing = state.subs.find((s) => s.id === state.editingId);
  const now = new Date().toISOString();
  // The form hides domain, emoji, plan and category for income. A new income item gets none of them
  // (whatever was typed while it was an expense stays out); an edited one keeps what it holds, so
  // saving never clears a field the form didn't show (mergeFormEdit then sees it unchanged).
  const hidden = (k, v) => (income ? (formBase?.[k] ?? '') : v);
  // Income has no Payment method: an edited item keeps whatever it holds, a new one gets none. An
  // expense saves the pick only once the drop-down was changed (js/cards.js payToSave).
  const payValue = income ? formBase?.pay : payToSave({ stored: formBase?.pay, chosen: pay, touched: f.pay.dataset.touched === '1' });
  return {
    id: existing?.id ?? uid(),
    type: income ? 'income' : 'expense',
    name,
    domain: hidden('domain', cleanDomain(f.domain.value)),
    emoji: hidden('emoji', firstEmoji(f.emoji.value)),
    plan: hidden('plan', f.plan.value.trim()),
    price: Math.round(price * 100) / 100,
    currency: f.currency.value || state.settings.defaultCurrency,
    cycle,
    nextRenewal: cycle === 'once' ? '' : f.nextRenewal.value || '',
    date: cycle === 'once' ? f.date.value : '',
    category: hidden('category', category),
    notes: f.notes.value.trim(),
    ...(payValue !== undefined ? { pay: payValue } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(newCard ? { newCard } : {}),
  };
}

function setError(field, msg) {
  form.elements[field].setAttribute('aria-invalid', 'true');
  $(`[data-error-for="${field}"]`, form).textContent = msg;
}
function clearErrors(field) {
  const fields = field ? [field] : ['name', 'price', 'date', 'nextRenewal', 'newGroup'];
  for (const k of fields) {
    form.elements[k].removeAttribute('aria-invalid');
    $(`[data-error-for="${k}"]`, form).textContent = '';
  }
}

/* --------------------------------------------------------------------------
   Confirm / choice dialog
   -------------------------------------------------------------------------- */
function confirmDialog({ title, message, actions, stacked = false }) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  const wrap = $('#confirm-actions');
  wrap.classList.toggle('stacked', stacked);
  wrap.innerHTML = '';
  actions.forEach((a, i) => {
    const b = document.createElement('button');
    b.type = 'submit';
    b.value = String(i);
    b.className = 'btn' + (a.kind === 'danger' ? ' btn-danger' : a.kind === 'primary' ? ' btn-primary' : '');
    b.textContent = a.label;
    wrap.append(b);
  });
  dlg.returnValue = '';
  openDialog(dlg);
  // Focus the least destructive option.
  wrap.querySelector('button')?.focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const i = dlg.returnValue === '' ? -1 : Number(dlg.returnValue);
      resolve(i >= 0 ? actions[i].value : actions[0].value);
    }, { once: true });
  });
}

/* --------------------------------------------------------------------------
   Settings: currency, theme, export, import
   -------------------------------------------------------------------------- */
/**
 * Settings → Groups → Tidy up groups (js/group-merge.js): show the suggested merges and, on Merge,
 * apply them as ordinary category edits (they sync like any edit). Undo saves the old categories back.
 */
function bindGroupMerge() {
  $('#btn-group-merge').addEventListener('click', async () => {
    const suggestions = suggestMerges(state.subs, { nameOf: t, compare: compareNames });
    if (!suggestions.length) { toast(t('groups.merge.none')); return; }
    const { before, after } = groupCounts(state.subs, suggestions);
    const lines = suggestions.map((s) => t('groups.merge.line', { from: s.from.join(t('common.listSep')), to: s.to }));
    const ok = await confirmDialog({
      title: t('groups.merge.title'),
      message: [...lines, t('groups.merge.summary', { before, after })].join('\n'),
      actions: [{ label: t('common.cancel'), value: false }, { label: t('groups.merge.confirm'), value: true, kind: 'primary' }],
    });
    if (!ok) return;
    const changes = mergeChanges(state.subs, suggestions);
    const saveAll = async (list) => {
      const now = new Date().toISOString();
      for (const item of list) await storage.save({ ...item, updatedAt: now });
    };
    try {
      await saveAll(changes.map(({ item, category }) => ({ ...item, category })));
    } catch (err) {
      console.error(err);
      await reloadData();
      toast(t('groups.merge.failed'));
      return;
    }
    await reloadData();
    toast(t('groups.merge.done', { count: changes.length }), {
      label: t('groups.merge.undo'),
      run: async () => {
        try { await saveAll(changes.map(({ item }) => item)); } catch (err) { console.error(err); }
        await reloadData();
        toast(t('groups.merge.undone'));
      },
    });
  });
}

function bindSettings() {
  $('#set-currency').addEventListener('change', async (e) => {
    state.settings.defaultCurrency = e.target.value;
    await storage.saveSettings({ defaultCurrency: e.target.value });
    state.insightsCurrency = null;
    render();
    toast(t('settings.currency.set', { currency: e.target.value }));
  });

  $('#set-theme').addEventListener('change', (e) => {
    storage.setPref('theme', e.target.value);
    applyTheme(e.target.value);
  });

  bindLanguage();
  bindDueSettings();
  bindWeekStart();

  // Per device, like the theme: a localStorage preference, never synced or exported.
  $('#set-motion').addEventListener('change', (e) => {
    storage.setPref('reduceMotion', e.target.checked ? 'on' : 'off');
    applyMotion();
  });

  $('#btn-export').addEventListener('click', exportData);
  $('#btn-export-csv').addEventListener('click', exportCsv);
  $('#btn-copy-csv').addEventListener('click', copyCsv);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await importFile(file);
  });

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    if (isNative()) return;
    e.preventDefault();
    deferredPrompt = e;
    $('#btn-install').hidden = false;
  });
  $('#btn-install').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#btn-install').hidden = true;
  });
}

/* --------------------------------------------------------------------------
   Settings → This device → Erase data on this device (js/erase.js: the rules and the order)
   -------------------------------------------------------------------------- */
// Open the app again, as a fresh first launch: the address without ?dev=1 or ?lang=. Tests replace it
// (the erase sheet's testReload), since a test page must stay where it is.
const eraseReload = () => { const fn = $('#erase-dialog').testReload; if (fn) fn(); else location.replace('./'); };

// Other open tabs of this app (web): told before the database goes, so none of them writes into a new
// one, and told to open again once it has gone. A channel never hears its own messages, so this tab's
// erase reaches only the others. Null where there's no BroadcastChannel (one tab only, as on a phone).
const eraseChannel = (() => {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(ERASE_CHANNEL) : null; } catch { return null; }
})();
eraseChannel?.addEventListener('message', (e) => {
  const m = e.data;
  if (!m || m.db !== storage.databaseName()) return;
  if (m.type === 'erasing') { try { syncParts?.engine?.stop(); } catch { /* nothing to stop */ } storage.markErased(true); }
  if (m.type === 'cancelled') storage.markErased(false);
  if (m.type === 'erased') eraseReload();
});
const tellOtherTabs = (type) => { try { eraseChannel?.postMessage({ type, db: storage.databaseName() }); } catch { /* no other tabs to tell */ } };

/** Android: the cached export files (js/files.js) older than 10 minutes. Failures are ignored. */
async function removeCachedExports() {
  const fs = plugin('Filesystem');
  if (!fs) return;
  const { files } = await fs.readdir({ path: '', directory: 'CACHE' });
  for (const path of staleExports(files, Date.now())) {
    try { await fs.deleteFile({ path, directory: 'CACHE' }); } catch { /* left for the system to clear */ }
  }
}

/**
 * The erase sheet: refused while this device can sync (with Open Sync); else step 1, what is here and
 * an optional backup, answered either way ("I have a backup" / "Continue without one": the erase never
 * follows an export by itself); step 2, this device only, the slide (locked at first) and Erase. Each
 * step is on the overlay stack, so Android Back is its Cancel / Back; nothing closes while erasing.
 */
function bindErase() {
  const dlg = $('#erase-dialog');
  const busyLine = $('#erase-busy');
  const errorLine = $('#erase-error');
  const go = $('#erase-go');
  const holds = ['[data-erase-close]', '#erase-confirm-cancel', '#erase-back'].map((s) => $(s, dlg));
  let busy = false;
  let view = '';
  let backupSaved = false;

  const slider = createSlideConfirm($('#erase-slide'), {
    onChange: (on) => { go.disabled = busy || !on; },
    reduceMotion: () => reduceEffects(),
    label: t('erase.slide.label'), doneLabel: t('erase.slide.done'), lockedLabel: t('erase.slide.locked'),
    confirmedValue: t('erase.slide.value.confirmed'), lockedValue: t('erase.slide.value.locked'), notValue: t('erase.slide.value.not'),
  });

  /** Why the erase can't run now (js/erase.js eraseBlock): asked when the sheet opens and again at Erase. */
  async function block() {
    if (!syncParts) return 'unknown'; // sync hasn't started yet: can't tell
    let status = null;
    let statusFailed = false;
    if (syncParts.available) { try { status = await syncParts.vault.status(); } catch { statusFailed = true; } }
    return eraseBlock({ syncAvailable: syncParts.available, status, statusFailed });
  }

  function renderBackup() {
    const count = state.subs.length;
    const items = t('common.items', { count });
    const cards = t('erase.cards', { count: listCards(state.settingsRecord).length });
    $('#erase-counts').textContent = t('erase.counts', { items, cards });
    $('#erase-backup').textContent = backupLabel(count, backupSaved);
    $('#erase-backup-hint').textContent = count ? t('erase.backup.hint', { items }) : t('erase.backup.hintEmpty');
  }

  const FOCUS = { blocked: '#erase-blocked-cancel', backup: '#erase-backup-cancel', confirm: '#erase-confirm-cancel' };
  function show(name, reason = null) {
    view = name;
    for (const v of $$('[data-erase-view]', dlg)) v.hidden = v.dataset.eraseView !== name;
    if (name === 'blocked') {
      $('#erase-blocked-text').textContent = t(reason === 'sync' ? 'erase.syncOn' : 'erase.syncUnknown');
      $('#erase-open-sync').hidden = reason !== 'sync';
    }
    if (name === 'backup') renderBackup();
    if (name === 'confirm') {
      // Back on step 2 goes to step 1, as its own Back button does; refused while erasing.
      overlays.open('erase-step', { close: () => { if (!busy) show('backup'); }, isOpen: () => dialogOpen(dlg) && view === 'confirm' });
      errorLine.textContent = '';
      slider.reset(); // every time: confirmed again, after the lock
      go.disabled = true;
      requestAnimationFrame(() => slider.layout());
    } else overlays.remove('erase-step');
    $('.sheet-body', $(`[data-erase-view="${name}"]`, dlg))?.scrollTo?.(0, 0);
    $(FOCUS[name], dlg)?.focus(); // the least destructive choice first
  }

  // The busy line is a polite live region: its words are written only when they change, so "Erasing…"
  // is said once, and the other-window words only when the delete is really held up (runErase).
  function say(message) {
    if (busyLine.textContent !== message) busyLine.textContent = message;
    busyLine.hidden = !message;
  }

  function setBusy(message) {
    busy = Boolean(message);
    say(message);
    for (const b of holds) b.disabled = busy;
    go.disabled = busy || !slider.confirmed;
  }

  const close = () => { if (!busy) closeDialog(dlg); };

  async function open() {
    if (busy || dialogOpen(dlg)) return;
    backupSaved = false;
    setBusy('');
    const reason = await block();
    openDialog(dlg, { back: close });
    if (reason) show('blocked', reason); else show('backup');
  }

  async function erase() {
    if (busy || !slider.confirmed) return;
    errorLine.textContent = '';
    setBusy(t('erase.busy'));
    // Once more, now: sync may have been set up in another window since the sheet opened.
    const reason = await block();
    if (reason) { setBusy(''); show('blocked', reason); return; }
    tellOtherTabs('erasing');
    const result = await runErase({
      stop: () => syncParts?.engine?.stop(),
      database: ({ onBlocked }) => storage.eraseDatabase({ onBlocked }),
      secure: () => nativeSecureStore()?.remove(), // web: none (the key was in the database)
      prefs: () => storage.removeAllPrefs(),
      logos: () => globalThis.caches?.delete(LOGO_CACHE),
      exports: () => removeCachedExports(),
      reload: eraseReload,
    }, {
      onBlocked: () => setBusy(t('toast.blocked')), // another window still holds the data after a moment: wait, no reload
      onUnblocked: () => say(''), // it let go: those words go, and nothing can be pressed still
      beforeReload: async (r) => {
        tellOtherTabs('erased');
        if (r.outcome !== 'partial') return;
        await confirmDialog({ title: t('erase.title'), message: t('erase.partial'), actions: [{ label: t('common.ok'), value: true, kind: 'primary' }] });
      },
    });
    if (result.outcome !== 'failed') return; // the app is opening again
    tellOtherTabs('cancelled');
    setBusy('');
    errorLine.textContent = t('erase.failed'); // nothing was erased; Erase may run again
  }

  $('#btn-erase').addEventListener('click', open);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('close', () => {
    if (dialogOpen(dlg)) return; // opened again in between: this event belongs to the earlier visit
    overlays.remove('erase-step');
    slider.stop();
    document.body.classList.remove('sheet-open');
  });
  $('[data-erase-close]', dlg).addEventListener('click', close);
  for (const id of ['#erase-blocked-cancel', '#erase-backup-cancel', '#erase-confirm-cancel']) $(id, dlg).addEventListener('click', close);
  $('#erase-open-sync').addEventListener('click', () => { closeDialog(dlg); $('#btn-sync').click(); });
  $('#erase-backup').addEventListener('click', async () => {
    const ok = (await exportData()) === true;
    if (ok) backupSaved = true;
    if (view === 'backup') renderBackup(); // and stays on this step
  });
  $('#erase-have-backup').addEventListener('click', () => show('confirm'));
  $('#erase-no-backup').addEventListener('click', () => show('confirm'));
  $('#erase-back').addEventListener('click', () => { if (!busy) show('backup'); });
  go.addEventListener('click', erase);
}

/**
 * Settings → Language: Same as device, or one of the locales (each named in its own language).
 * Per device, like the theme (localStorage, js/i18n.js), never synced or exported. Hidden while
 * English is the only locale. A change reloads the app, so every screen is drawn in the new one.
 */
function bindLanguage() {
  const row = $('#lang-row');
  const select = $('#set-lang');
  const tags = Object.keys(LOCALES);
  row.hidden = tags.length < 2;
  select.innerHTML = [`<option value="auto">${esc(t('settings.language.auto'))}</option>`,
    ...tags.map((tag) => `<option value="${esc(tag)}" lang="${esc(tag)}">${esc(LOCALES[tag].name)}</option>`)].join('');
  select.value = getLangSetting();
  select.addEventListener('change', () => {
    saveLangSetting(select.value);
    location.reload();
  });
}

const darkScheme = matchMedia('(prefers-color-scheme: dark)');
// In "system" mode, follow the device when it switches between light and dark.
darkScheme.addEventListener?.('change', () => applyTheme(storage.getPref('theme') || 'system'));

/* "Reduce motion and effects": on, off, or (never set) the system's prefers-reduced-motion. On, the
   Insights Ring shows as the flat donut, the year chart's springs settle at once and CSS transitions
   and animations are cut (the .reduce-motion rule in app.css). */
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const reduceEffects = () => reduceMotionFrom(storage.getPref('reduceMotion'), motionQuery.matches);
motionQuery.addEventListener?.('change', () => { if (!storage.getPref('reduceMotion')) applyMotion(); });

let motionApplied = null;
function applyMotion() {
  const on = reduceEffects();
  document.documentElement.classList.toggle('reduce-motion', on);
  $('#set-motion').checked = on;
  if (motionApplied !== null && motionApplied !== on && state.tab === 'insights') renderInsights();
  if (motionApplied !== null && motionApplied !== on) { wallet?.relayout(); document.body.classList.toggle('wallet-view', walletShown() && !on); updateGauge(); }
  motionApplied = on;
}

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
  else delete root.dataset.theme;
  $('#set-theme').value = ['light', 'dark'].includes(mode) ? mode : 'system';
  // Native status bar: light or dark icons to suit the background (the app draws behind the bar).
  setStatusBarStyle(mode === 'dark' || (mode !== 'light' && darkScheme.matches));
  // Keep the browser chrome in step with the chosen theme.
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    $$('meta[name="theme-color"]').forEach((m) => {
      if (mode === 'system') {
        m.content = m.media.includes('dark') ? '#111216' : '#f6f6f9';
      } else m.content = bg;
    });
    ring?.theme(); // the Ring reads its colours from the theme tokens
    wallet?.recolour(); // so does the Wallet (and refits each card's text colour)
    ringCache = new Map(); // and the income gauge's rings, measured against the theme's track
    updateGauge();
  });
}

/** Export a backup file. Resolves true when it was delivered (saved or shared), else false. */
async function exportData() {
  try {
    // Format 5 when its check passes, else format 4 as 1.19.0 wrote it (storage.exportBackupFrom).
    const { payload, format, wanted } = await storage.exportBackup();
    payload.items.sort(byName);
    // A backup carries the household's colours (everything in the settings record: picked ones, old
    // g and slot alike, and the shared automatic slots), never this device's own automatic colours.
    const colours = payload.settings?.groupColors;
    if (colours) payload.settings.groupColors = Object.fromEntries(Object.entries(colours).filter(([k]) => state.colorPicks.has(k)));
    const slots = payload.settings?.groupSlots;
    if (slots) payload.settings.groupSlots = Object.fromEntries(Object.entries(slots).filter(([k]) => state.colorPicks.has(k)));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const delivered = await deliverFile(blob, `substracker-${todayStamp()}.json`);
    const items = t('common.items', { count: payload.items.length });
    // The older format leaves the palette slots out: say so, calmly (the items are all there), and
    // keep it up until dismissed, as it's longer than the usual note. When format 6 was wanted, the
    // file also has no cards in it (storage.exportBackupFrom): that's the note then.
    if (delivered && format < wanted && wanted >= 6) {
      toast(t('settings.export.doneNoCards', { items }), { label: t('common.dismiss'), sticky: true, run: () => {} });
    } else if (delivered && format < wanted) {
      toast(t('settings.export.doneOlder', { items }), { label: t('common.dismiss'), sticky: true, run: () => {} });
    } else if (delivered) toast(t('settings.export.done', { items }));
    return delivered === true;
  } catch (err) {
    console.error(err);
    toast(t('settings.export.failed'));
    return false;
  }
}

/** "Download CSV": the live items for a spreadsheet, through the same share sheet or download as a backup. */
async function exportCsv() {
  try {
    const items = await storage.getAll();
    const name = `substracker-${todayStamp()}.csv`;
    const blob = new Blob([itemsCsv(items)], { type: 'text/csv;charset=utf-8' });
    const delivered = await deliverFile(blob, name, { dialogTitle: t('settings.csv.dialogTitle') });
    if (delivered) toast(t('settings.csv.saved', { name }), null, { again: true });
    return delivered === true;
  } catch (err) {
    console.error(err);
    toast(t('settings.csv.failed'));
    return false;
  }
}

/**
 * "Copy CSV": the same rows, columns and escaping as Download CSV, without the byte-order mark,
 * on the clipboard. Where the clipboard is blocked (some browsers, iPhone Safari, Android WebView)
 * the CSV is shown selected under the row, to copy by hand, as Import with AI does with its prompt.
 */
async function copyCsv() {
  const fallback = $('#csv-fallback');
  const box = $('#csv-copy-text');
  try {
    const items = await storage.getAll();
    const text = itemsCsvText(items);
    const n = csvItems(items).length;
    if (await copyText(text, null)) {
      fallback.hidden = true;
      toast(t('settings.csv.copied', { items: t('common.items', { count: n }) }), null, { again: true });
      return true;
    }
    box.value = text;
    fallback.hidden = false;
    box.focus();
    box.select();
    toast(t('settings.csv.copyBlocked'), null, { again: true });
    return false;
  } catch (err) {
    console.error(err);
    toast(t('settings.csv.copyFailed'));
    return false;
  }
}

/** Whether sync is set up here (a key and sync turned on); then an import reaches every device. */
async function syncIsSetUp() {
  try {
    const cfg = await storage.getSyncConfig();
    return Boolean(cfg.enabled && storage.householdIdentity(cfg)); // no need to read the key itself
  } catch { return false; } // no sync on a fallback store
}

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// A file that can't be imported gets a dialog naming the problem; existing data is never touched.
function importProblem(message) {
  return confirmDialog({
    title: t('import.problem.title'),
    message: t('import.problem.message', { problem: message }),
    actions: [{ label: t('common.ok'), value: true, kind: 'primary' }],
  });
}

async function importFile(file) {
  if (file.size > 5_000_000) return importProblem(t('import.error.tooLarge'));
  let text;
  let preview;
  try {
    text = await file.text();
    preview = await storage.previewImport(text);
  } catch (err) {
    if (err instanceof storage.ImportError) return importProblem(err.message);
    console.error(err);
    return importProblem(t('import.error.unreadable'));
  }

  // Sync set up here (a key and sync turned on): both choices reach every device, so say so.
  const synced = await syncIsSetUp();
  // Merge or Replace all; Replace asks once more. Cancelling at either step applies nothing.
  const mode = await chooseImportMode(preview, { synced, confirm: confirmDialog });
  if (!mode) return;

  try {
    const done = await storage.importAll(text, mode);
    await reloadData();
    toast(mode === 'replace'
      ? t('import.toast.replaced', { items: t('common.items', { count: done.total }) })
      : t('import.toast.merged', { added: done.added, updated: done.updated }));
    storage.requestPersistence();
  } catch (err) {
    if (err instanceof storage.ImportError) { importProblem(err.message); return; }
    console.error(err);
    toast(t('import.toast.failed'));
  }
}

/* --------------------------------------------------------------------------
   Toast, storage persistence, service worker
   -------------------------------------------------------------------------- */
let toastTimer;
/**
 * Show `text` for a moment (or until its `action` is used, when sticky). `again`: a confirmation
 * that may repeat (Copied, Saved): when the same text is already showing it goes away and comes
 * back, so a second click is seen (and announced) to have worked too.
 */
function toast(text, action, { again = false } = {}) {
  const el = $('#toast');
  const btn = $('#toast-action');
  if (again && !el.hidden && $('#toast-text').textContent === text) {
    el.hidden = true;
    $('#toast-text').textContent = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast(text, action), 60);
    return;
  }
  $('#toast-text').textContent = text;
  btn.hidden = !action;
  btn.onclick = action ? () => { el.hidden = true; action.run(); } : null;
  if (action) btn.textContent = action.label;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!action?.sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function registerSW() {
  // Web only. The native app ships its files inside the app (offline already), and updates come
  // through the app store, so a worker would only risk serving a stale cached copy.
  if (isNative() || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offerUpdate = (worker) => toast(t('toast.update'), {
      label: t('toast.update.reload'), sticky: true,
      run: () => worker.postMessage({ type: 'SKIP_WAITING' }),
    });
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(nw);
      });
    });
  }).catch((err) => console.warn('Service worker registration failed', err));

  // Only reload when an existing worker was replaced, not on the very first install.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !hadController) return;
    reloading = true;
    location.reload();
  });
}

init();
