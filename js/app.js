import * as storage from './storage.js';
import { deliverFile } from './files.js';
import { isNative, platformName, plugin, setStatusBarStyle } from './platform.js';
import { overlays, createBackHandler, setBackHandler, pressBack } from './overlays.js';
import { SERVICES, DEFAULT_CATEGORIES, matchService, cleanDomain } from './services.js';
import { logoHTML, initLogoHandling } from './logos.js';
import { createSyncEngine } from './sync.js';
import { initSyncScreen } from './sync-ui.js';
import { initSyncSheet } from './sync-sheet.js';
import { createKeyVault } from './secure-key.js';
import { createYearChart } from './year-chart.js';
import { rangeMonths, nowIndex, chartMonths } from './year-chart-math.js';
import { donutSlices, donutHTML, emptyDonutHTML, legendHTML, applyDonutHighlight, shareText } from './donut-flat.js';
import {
  CURRENCIES, localeCurrency, uid, esc, money, cycleLabel, isIncome, isOnce, firstEmoji,
  nextRenewal, daysUntil, renewalText, parseDate, shortDate, todayStamp,
  chooseImportMode, reduceMotionFrom, catViewFrom,
} from './util.js';
import {
  groupOf, byGroupName, breakdown, monthlyAverage, undatedRecurring, incomeDue, undatedIncome, yearSummary,
  stripSummary, undatedItems,
} from './insights-calc.js';

const APP_VERSION = '1.11.0';

// Group colour swatches: keys map to --group-1 … --group-10 in app.css. The order is the
// auto-assign order, most distinct first (including for colour-blind viewers).
const SWATCHES = [
  { key: 'g1', name: 'Gold' }, { key: 'g2', name: 'Steel blue' }, { key: 'g3', name: 'Terracotta' },
  { key: 'g4', name: 'Sky' }, { key: 'g5', name: 'Rose' }, { key: 'g6', name: 'Plum' },
  { key: 'g7', name: 'Olive' }, { key: 'g8', name: 'Brown' }, { key: 'g9', name: 'Teal' },
  { key: 'g10', name: 'Brick' },
];
const SWATCH_KEYS = new Set(SWATCHES.map((s) => s.key));
const swatchVar = (key) => `var(--group-${String(key).slice(1)})`;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  subs: [],
  settings: { defaultCurrency: localeCurrency('TWD'), groupColors: {} }, // groupColors: category name → swatch key
  view: storage.getPref('view') === 'list' ? 'list' : 'grid',
  // Insights "By category": the 3D Ring (default), the flat Donut or the List. A saved choice is kept.
  catView: catViewFrom(storage.getPref('catView')),
  donutActive: null, // highlighted donut slice key (the Ring's front slice), or null
  tab: ['subs', 'insights', 'settings'].includes(storage.getPref('tab')) ? storage.getPref('tab') : 'subs',
  period: storage.getPref('period') === 'annual' ? 'annual' : 'monthly', // Money summary strip
  insightsCurrency: null,
  insightsMonth: startOfMonth(new Date()),
  insightsMode: storage.getPref('insightsMode') === 'year' ? 'year' : 'month', // Insights Month | Year
  yearRange: storage.getPref('yearRange') === 'year' ? 'year' : 'roll',     // This year | Rolling (default)
  yearStack: 'type',   // year chart: By type | By category
  yearIncome: false,   // year chart: Show income
  yearPos: null,       // year chart position, kept across redraws
  editingId: null,
  formType: 'expense', // what the open add/edit sheet is editing
};

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

/* --------------------------------------------------------------------------
   On-screen error reporter — an installed PWA has no console to look at.
   -------------------------------------------------------------------------- */
function reportError(prefix, err) {
  const msg = (err && (err.message || String(err))) || 'Unknown error';
  try {
    toast(`${prefix}: ${msg}`, { label: 'Dismiss', sticky: true, run: () => {} });
  } catch { /* toast markup missing — nothing more we can do */ }
}
window.addEventListener('error', (e) => {
  const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
  reportError('Error', { message: `${e.message || e.error?.message || 'Script error'}${where}` });
});
window.addEventListener('unhandledrejection', (e) => reportError('Unhandled', e.reason));

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
  initLogoHandling();
  bindTabs();
  bindViewToggle();
  bindForm();
  bindSettings();
  bindEditTaps();
  bindGroupColors();
  bindDialogFormFallback();
  bindBackButton();
  $$('[data-action="add"]').forEach((b) => b.addEventListener('click', () => openForm()));
  $$('[data-action="add-income"]').forEach((b) => b.addEventListener('click', () => openForm(null, 'income')));
  $('#money-summary').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    state.period = b.dataset.period;
    storage.setPref('period', state.period);
    renderSubs();
  });

  storage.setBlockedHandler(() => toast('Close other Peek Budget tabs or windows to finish updating.', {
    label: 'Dismiss', sticky: true, run: () => {},
  }));
  let syncUnavailable = 'Local storage could not be opened.';
  try {
    const [subs, settings] = await Promise.all([storage.getAll(), storage.getSettings()]);
    const usingLegacy = (await storage.status()).usingLegacy;
    syncUnavailable = usingLegacy ? 'Sync needs the storage update to finish first.' : '';
    if (usingLegacy) {
      toast('Storage update could not be verified, so the previous copy of your data is in use.', {
        label: 'Dismiss', sticky: true, run: () => {},
      });
    }
    state.subs = subs;
    // Before 1.2.1 the default was always TWD and only stored once changed. Existing data keeps TWD so the
    // summary strip doesn't switch currency; a fresh install takes the device's locale. Either way it's
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
      ? 'Could not open local storage. Data will not be saved on this device.'
      : 'Could not open local storage. Data will not be saved in this browser mode.');
  }

  if (isNative()) {
    // The native app has no install step and no use for the PWA install instructions.
    $$('[data-web-only]').forEach((el) => { el.hidden = true; });
    // App wording where the web copy talks about the browser or downloads (data-native-text).
    $$('[data-native-text]').forEach((el) => { el.textContent = el.dataset.nativeText; });
  }
  fillStaticLists();
  applyTheme(storage.getPref('theme') || 'system');
  applyMotion();
  setTab(state.tab, { focus: false });
  render();
  registerSW();
  $('#app-version').textContent = `Peek Budget ${APP_VERSION}`;
  startSync(syncUnavailable).catch((err) => console.error(err));
}

/* --------------------------------------------------------------------------
   Sync (off until set up in Settings → Sync, or on the developer screen)
   -------------------------------------------------------------------------- */
async function startSync(unavailable) {
  let engine = null;
  // The household key: phone secure storage (Keystore/Keychain) where there is one, else IndexedDB.
  const vault = createKeyVault({ store: storage });
  if (!unavailable) {
    // Phones: move a key still in IndexedDB into secure storage (verified; a failure changes nothing).
    try { await vault.migrate(); } catch (err) { console.error(err); }
    engine = createSyncEngine({
      store: { ...storage.syncStore, getConfig: vault.readConfig, setConfig: vault.setConfig, replaceWithRemote: vault.replaceWithRemote },
    });
    // Changes from other devices (items, the default currency, group colours): refresh the screens
    // the same way an import or edit does.
    engine.onRemoteChanges(() => reloadData({ remote: true }));
    engine.start().catch((err) => console.error(err)); // never blocks the app; failures show as status
  }
  let sheet = null;
  const dev = initSyncScreen({ engine, vault, unavailable, ui: { toast, confirmDialog, setTab, onConfigChanged: () => sheet?.refresh() } });
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
  const [subs, settings] = await Promise.all([storage.getAll(), storage.getSettings()]);
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
const TAB_TITLES = { subs: 'Money', insights: 'Insights', settings: 'Settings' };

function bindTabs() {
  const tabs = $$('.tab');
  tabs.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));
  $('.tabbar').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.dataset.tab);
    next.focus();
  });
}

function setTab(tab, { focus = true } = {}) {
  state.tab = tab;
  storage.setPref('tab', tab);
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
  });
  $('#panel-subs').hidden = tab !== 'subs';
  $('#panel-insights').hidden = tab !== 'insights';
  $('#panel-settings').hidden = tab !== 'settings';
  $('#subs-actions').hidden = tab !== 'subs';
  $('#fab-stack').hidden = tab === 'settings';
  $('#page-title').textContent = TAB_TITLES[tab];
  document.title = tab === 'subs' ? 'Peek Budget' : `${TAB_TITLES[tab]} · Peek Budget`;
  if (focus) window.scrollTo({ top: 0 });
  if (tab === 'insights') renderInsights();
}

function bindViewToggle() {
  $$('.seg-btn[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      storage.setPref('view', state.view);
      renderSubs();
    })
  );
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */
function render() {
  ensureGroupColors();
  renderSubs();
  if (state.tab === 'insights') renderInsights();
  fillCategoryList();
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// Groups (category or Uncategorised) and their order come from insights-calc.js.

/* Group colours ------------------------------------------------------------- */
/**
 * Give every expense group a swatch, in display order so the first assignment is stable.
 * Groups keep the colour they have; a new group takes the next unused swatch (the least used
 * one once all ten are taken). Income has no colour.
 */
function ensureGroupColors() {
  const map = state.settings.groupColors;
  const names = [...new Set(state.subs.filter((s) => !isIncome(s)).map(groupOf))].sort(byGroupName);
  const assigned = {};
  for (const name of names) {
    if (SWATCH_KEYS.has(map[name])) continue;
    const uses = new Map(SWATCHES.map((s) => [s.key, 0]));
    for (const n of names) if (SWATCH_KEYS.has(map[n])) uses.set(map[n], uses.get(map[n]) + 1);
    map[name] = SWATCHES.reduce((best, s) => (uses.get(s.key) < uses.get(best) ? s.key : best), SWATCHES[0].key);
    assigned[name] = map[name];
  }
  // An automatic pick stays on this device; only a colour someone chooses is shared.
  if (Object.keys(assigned).length) storage.saveLocalDefaults({ groupColors: assigned }).catch((err) => console.error(err));
}

const groupSwatch = (name) => (SWATCH_KEYS.has(state.settings.groupColors[name]) ? state.settings.groupColors[name] : 'g1');
const swatchName = (key) => SWATCHES.find((s) => s.key === key)?.name ?? '';

/** Keep only valid `name → swatch key` pairs from an imported settings.groupColors. */
function sanitizeGroupColors(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw)
    .filter(([k, v]) => typeof k === 'string' && k.trim() && k.length <= 40 && SWATCH_KEYS.has(v))
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
    $('#swatch-pop-title').textContent = `Colour for ${group}`;
    $('#swatch-grid').innerHTML = SWATCHES.map((s) => `
      <button type="button" class="swatch" data-swatch="${s.key}" style="--swatch: ${swatchVar(s.key)}"
        aria-label="${esc(s.name)}" title="${esc(s.name)}" aria-pressed="${s.key === current}"></button>`).join('');
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
    close(false);
    renderSubs();
    $(`.group-dot[data-group="${CSS.escape(name)}"]`)?.focus();
    try { await storage.saveSettings({ groupColors: { [name]: b.dataset.swatch } }); } catch (err) {
      console.error(err);
      toast('Could not save the colour.');
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.group-dot')) close(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) close(true); });
  window.addEventListener('resize', () => close(false));
}

function renewalTag(sub) {
  const d = nextRenewal(sub);
  if (!d) return '';
  const soon = daysUntil(d) <= 7;
  return `<span class="tag${soon ? ' tag-soon' : ''}">${esc(renewalText(d, isIncome(sub)))}</span>`;
}

const ONE_OFF_TAG = '<span class="tag tag-once">One-off</span>';

function renderSubs() {
  const list = $('#subs-list');
  const all = state.subs;

  $$('.seg-btn[data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === state.view));
  $('#subs-empty').hidden = all.length > 0;
  list.hidden = all.length === 0;
  $('#money-summary').hidden = all.length === 0;
  renderMoneySummary();

  // Income first (an implicit section, no categories), then expenses grouped by category.
  const groups = [];
  const income = all.filter(isIncome).sort(byName);
  if (income.length) groups.push({ name: 'Income', items: income });
  const cats = new Map();
  for (const s of all) {
    if (isIncome(s)) continue;
    const k = groupOf(s);
    if (!cats.has(k)) cats.set(k, []);
    cats.get(k).push(s);
  }
  [...cats.keys()].sort(byGroupName)
    .forEach((k) => groups.push({ name: k, items: cats.get(k).sort(byName), colour: true }));

  const isList = state.view === 'list';
  list.innerHTML = groups.map((g, i) => {
    const key = g.colour ? groupSwatch(g.name) : null;
    const dot = key ? `<button type="button" class="group-dot" data-group="${esc(g.name)}" style="--swatch: ${swatchVar(key)}"
      aria-label="Colour for ${esc(g.name)}: ${esc(swatchName(key))}" aria-haspopup="dialog" aria-expanded="false"></button>` : '';
    return `
    <section class="money-group" aria-labelledby="group-${i}">
      <h2 class="section-title${dot ? ' group-head' : ''}" id="group-${i}">${dot}<span>${esc(g.name)} <span class="optional">${g.items.length}</span></span></h2>
      <div class="${isList ? 'subs-list' : 'subs-grid'}">${g.items.map(isList ? rowHTML : cardHTML).join('')}</div>
    </section>`;
  }).join('');
}

function renderMoneySummary() {
  const cur = state.settings.defaultCurrency;
  const inCur = state.subs.filter((s) => s.currency === cur);
  const others = state.subs.length - inCur.length;
  const now = new Date();
  // This month or year on the same cash basis as Insights (see stripSummary); undated items are
  // left out and counted on one line that opens the first of them.
  const t = stripSummary(inCur, state.period, now.getFullYear(), now.getMonth());
  const undated = undatedItems(inCur);
  const when = state.period === 'annual'
    ? String(now.getFullYear())
    : now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const cell = (label, value, cls = '', sub = '') => `
    <div class="summary-cell${cls}">
      <div class="stat-label">${label}</div>
      <div class="summary-value">${esc(money(value, cur))}</div>
      ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
    </div>`;

  $('#money-summary').innerHTML = `
    <div class="summary-head">
      <span class="summary-when">${esc(when)}</span>
      <div class="segmented" role="group" aria-label="Summary period">
        <button type="button" class="seg-btn seg-btn-text" data-period="monthly" aria-pressed="${state.period === 'monthly'}">Monthly</button>
        <button type="button" class="seg-btn seg-btn-text" data-period="annual" aria-pressed="${state.period === 'annual'}">Annual</button>
      </div>
    </div>
    <div class="summary-cells">
      ${cell('Income', t.income, ' summary-income')}
      ${cell('Outgoings', t.outgoings, '', state.period === 'annual' ? '' : `Avg ${esc(money(t.average, cur))}/mo`)}
      ${cell('Left over', t.leftOver, t.leftOver < 0 ? ' summary-short' : '', t.leftOver < 0 ? 'More going out than coming in' : '')}
    </div>
    ${undated.length ? `<button type="button" class="summary-note summary-note-action" data-id="${esc(undated[0].id)}">Excludes ${plural(undated.length, 'undated item')}</button>` : ''}
    ${others ? `<p class="summary-note">${esc(cur)} only. ${plural(others, 'item')} in other currencies ${others === 1 ? "isn't" : "aren't"} included.</p>` : ''}`;
}

function onceDate(s) {
  const d = isOnce(s) ? parseDate(s.date) : null;
  return d ? shortDate(d) : '';
}

function cardHTML(s) {
  const meta = isOnce(s)
    ? [ONE_OFF_TAG, onceDate(s) ? `<span class="tag">${esc(onceDate(s))}</span>` : ''].join('')
    : renewalTag(s);
  return `
    <button type="button" class="sub-card" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.name)}">
      ${logoHTML(s, 'md')}
      <span class="sub-text">
        <span class="sub-name">${esc(s.name)}</span>
        ${s.plan && !isIncome(s) ? `<span class="sub-plan">${esc(s.plan)}</span>` : ''}
      </span>
      <span class="sub-price"><span class="amount">${esc(money(s.price, s.currency))}</span><span class="cycle">${cycleLabel(s.cycle)}</span></span>
      ${meta ? `<span class="sub-meta">${meta}</span>` : ''}
    </button>`;
}

function rowHTML(s) {
  const d = nextRenewal(s);
  const parts = [isIncome(s) ? '' : s.plan, isOnce(s) ? onceDate(s) : d ? renewalText(d, isIncome(s)) : ''];
  const sub = parts.filter(Boolean).map(esc).join(' · ');
  return `
    <button type="button" class="sub-row" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.name)}">
      ${logoHTML(s, 'sm')}
      <span class="sub-text">
        <span class="sub-name">${esc(s.name)}</span>
        ${sub ? `<span class="sub-plan">${sub}</span>` : ''}
      </span>
      <span class="sub-row-price">
        <span class="amount">${esc(money(s.price, s.currency))}</span>
        ${isOnce(s) ? ONE_OFF_TAG : `<span class="cycle">${s.cycle === 'annual' ? 'yearly' : 'monthly'}</span>`}
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

function renderInsights() {
  detachRing();
  const root = $('#insights');
  const chips = $('#currency-chips');
  const currencies = currenciesInUse();

  if (!state.subs.length) {
    chips.innerHTML = '';
    root.innerHTML = `
      <div class="empty-state">
        <div class="empty-mark" aria-hidden="true"><svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></div>
        <h2>Nothing to analyse yet</h2>
        <p>Add your income and outgoings and your monthly and yearly totals will appear here.</p>
      </div>`;
    return;
  }

  if (!currencies.includes(state.insightsCurrency)) state.insightsCurrency = currencies[0];
  const cur = state.insightsCurrency;

  chips.innerHTML = currencies.length > 1
    ? currencies.map((c) => `<button type="button" class="chip" data-currency="${esc(c)}" aria-pressed="${c === cur}">${esc(c)}</button>`).join('')
    : '';
  $$('.chip', chips).forEach((c) => c.addEventListener('click', () => {
    state.insightsCurrency = c.dataset.currency;
    state.donutActive = null;
    renderInsights();
  }));

  const inCur = state.subs.filter((s) => s.currency === cur);
  const modeHTML = `
    <div class="insights-mode">
      <div class="segmented" role="group" aria-label="Insights view">
        <button type="button" class="seg-btn seg-btn-text" data-insights-mode="month" aria-pressed="${state.insightsMode === 'month'}">Month</button>
        <button type="button" class="seg-btn seg-btn-text" data-insights-mode="year" aria-pressed="${state.insightsMode === 'year'}">Year</button>
      </div>
    </div>`;
  const bindMode = () => $$('[data-insights-mode]', root).forEach((b) => b.addEventListener('click', () => {
    if (state.insightsMode === b.dataset.insightsMode) return;
    state.insightsMode = b.dataset.insightsMode;
    storage.setPref('insightsMode', state.insightsMode);
    renderInsights();
  }));
  if (state.insightsMode === 'year') {
    renderYearView(root, { inCur, cur, currencies, modeHTML });
    bindMode();
    return;
  }
  stopYearChart();

  const month = state.insightsMonth;
  const y = month.getFullYear();
  const m = month.getMonth();
  const monthName = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const incomeItems = inCur.filter(isIncome);
  const subs = inCur.filter((s) => !isIncome(s)); // expenses only from here on

  // Outgoings and income on a cash basis: what falls due or is paid in this month (see
  // insights-calc.js). The two are compared, never added together.
  const incomeMonth = incomeDue(incomeItems, y, m);
  const due = breakdown(subs, y, m);
  const monthly = due.total;
  // The year of the viewed month from its twelve cash months; undated items are left out, as in
  // the month figures. Avg keeps its own definition (the yearly total ÷ 12, see monthlyAverage).
  const year = yearSummary(inCur, y);
  const avg = monthlyAverage(subs, y);
  const countOf = (key) => due.byType.find((t) => t.key === key)?.names.length ?? 0;
  const nMonthly = countOf('monthly');
  const nAnnual = countOf('annual');
  const nOnce = countOf('once');
  const inMonth = due.byCategory.flatMap((c) => c.items); // each with its `due` amount
  const undated = undatedRecurring(subs);
  const undatedTotal = undated.reduce((t, s) => t + s.price, 0);
  const undatedIn = undatedIncome(incomeItems);
  const undatedInTotal = undatedIn.reduce((t, s) => t + s.price, 0);
  const nUndated = undated.length + undatedIn.length; // a count of items; amounts are never mixed

  const catList = due.byCategory.map((c) => ({ name: c.group, total: c.amount, count: c.items.length }));
  const maxCat = catList[0]?.total || 1;
  const slices = donutSlices(catList, monthly, (name) => swatchVar(groupSwatch(name)));
  // The Ring, unless something rules it out; then the flat donut stands in, saying why.
  const ringWhy = state.catView === 'ring' && slices.length ? ringBlocker() : '';
  const showRing = state.catView === 'ring' && slices.length && !ringWhy;
  const catViewBtn = (view, title, icon) => `
          <button type="button" class="seg-btn" data-catview="${view}" aria-pressed="${state.catView === view}" title="${title}">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>
            <span class="sr-only">${title}</span>
          </button>`;

  const ranked = [...inMonth].sort((a, b) => b.due - a.due || byName(a, b));

  const pct = incomeMonth ? Math.round((monthly / incomeMonth) * 100) : 0;
  const headline = incomeMonth
    ? `Outgoings <strong>${esc(money(monthly, cur))}</strong> of <strong>${esc(money(incomeMonth, cur))}</strong> income <span class="pct">(${pct}%)</span>`
    // No percentage without income this month: say whether there's none at all or none paid now.
    : `Outgoings <strong>${esc(money(monthly, cur))}</strong> <span class="pct">· ${incomeItems.length
      ? `no ${esc(cur)} income paid in ${esc(monthName)}, so no percentage`
      : `no ${esc(cur)} income recorded`}</span>`;

  root.innerHTML = `${modeHTML}
    <div class="month-nav">
      <button type="button" class="icon-btn" data-month-step="-1" aria-label="Previous month">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>
      </button>
      <span class="month-label" aria-live="polite">${esc(monthName)}</span>
      <button type="button" class="icon-btn" data-month-step="1" aria-label="Next month">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
      </button>
    </div>

    <div class="headline">
      <p class="headline-text">${headline}</p>
      ${incomeMonth ? `<div class="bar" role="img" aria-label="Outgoings are ${pct}% of income"><div class="bar-fill${pct > 100 ? ' bar-fill-over' : ''}" style="width:${Math.min(100, Math.max(2, pct))}%"></div></div>` : ''}
    </div>

    ${currencies.length > 1 ? `<p class="notice">Totals are per currency — amounts in other currencies aren't converted.</p>` : ''}
    ${undated.length ? `
    <button type="button" class="notice-action" data-notice="plans" data-id="${esc(undated[0].id)}">
      ${esc(`${plural(undated.length, 'plan')} ${undated.length === 1 ? 'needs' : 'need'} a renewal date, ${money(undatedTotal, cur)} not shown`)}
    </button>` : ''}
    ${undatedIn.length ? `
    <button type="button" class="notice-action" data-notice="income" data-id="${esc(undatedIn[0].id)}">
      ${esc(`${plural(undatedIn.length, 'income item')} ${undatedIn.length === 1 ? 'needs' : 'need'} a payment date, ${money(undatedInTotal, cur)} not shown`)}
    </button>` : ''}
    <div class="stats">
      <div class="stat stat-primary">
        <div class="stat-label">${esc(monthName)}</div>
        <div class="stat-value">${esc(money(monthly, cur))}</div>
        <div class="stat-sub">Cash due this month</div>
        <div class="stat-sub">Avg ${esc(money(avg, cur))}/mo</div>
      </div>
      ${yearCardHTML(year, y, cur, nUndated)}
      <div class="stat">
        <div class="stat-label">Outgoings</div>
        <div class="stat-value">${inMonth.length}</div>
        <div class="stat-sub">${nMonthly} monthly · ${nAnnual} annual · ${nOnce} one-off</div>
      </div>
    </div>

    <section class="section" aria-labelledby="cat-title">
      <div class="section-head">
        <h2 class="section-title" id="cat-title">By category <span class="optional">${esc(monthName)}</span></h2>
        <div class="segmented" role="group" aria-label="Category view">
          ${catViewBtn('ring', '3D ring', '<ellipse cx="12" cy="11" rx="9" ry="4.5"/><ellipse cx="12" cy="11" rx="4" ry="1.8"/><path d="M3 11v2.5c0 2.5 4 4.5 9 4.5s9-2 9-4.5V11"/>')}
          ${catViewBtn('donut', 'Donut chart', '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5V8.5"/>')}
          ${catViewBtn('list', 'List view', '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>')}
        </div>
      </div>
      ${showRing ? ringHTML(slices, monthly, cur, monthName)
        : state.catView === 'ring' ? (slices.length ? donutHTML(slices, monthly, cur, monthName, { note: ringWhy, keys: true }) : emptyDonutHTML(cur, monthName))
        : state.catView === 'donut' ? donutHTML(slices, monthly, cur, monthName) : `
      <div class="panel">
        ${catList.length ? catList.map((c) => {
          const share = monthly ? Math.round((c.total / monthly) * 100) : 0;
          return `
          <div class="cat-row">
            <div class="cat-head">
              <span class="cat-name">${esc(c.name)} <span class="cat-count">${c.count}</span></span>
              <span class="cat-amount">${esc(money(c.total, cur))}<span class="pct">${share}%</span></span>
            </div>
            <div class="bar" role="img" aria-label="${esc(c.name)}: ${share}% of spend in ${esc(monthName)}"><div class="bar-fill" style="width:${Math.max(2, (c.total / maxCat) * 100).toFixed(1)}%"></div></div>
          </div>`;
        }).join('') : `<p class="panel-empty">No ${esc(cur)} outgoings in ${esc(monthName)}.</p>`}
      </div>`}
    </section>

    ${ranked.length ? `
    <section class="section" aria-labelledby="rank-title">
      <h2 class="section-title" id="rank-title">Most expensive <span class="optional">${esc(monthName)}</span></h2>
      <div class="panel">
        ${ranked.map((s, i) => `
          <button type="button" class="rank-row" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.name)}">
            <span class="rank-num">${i + 1}</span>
            ${logoHTML(s, 'sm')}
            <span class="sub-text">
              <span class="sub-name">${esc(s.name)}</span>
              <span class="sub-plan">${isOnce(s) ? `One-off · ${esc(onceDate(s))}` : `${esc(money(s.price, s.currency))} ${cycleLabel(s.cycle)}`}${s.plan ? ' · ' + esc(s.plan) : ''}</span>
            </span>
            <span class="sub-row-price">
              <span class="amount">${esc(money(s.due, cur))}</span>
              <span class="cycle">${isOnce(s) ? 'one-off' : cycleLabel(s.cycle)}</span>
            </span>
          </button>`).join('')}
      </div>
    </section>` : ''}`;

  bindMode();
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
let ringFailure = '';
let ring = null;
let ringAnnounced = null;

/** Why the Ring can't show right now (a sentence for the note above the flat donut), or ''. */
function ringBlocker() {
  if (reduceEffects()) return 'Showing the flat donut: Reduce motion and effects is on in Settings.';
  if (new URLSearchParams(location.search).get('flat') === '1') return 'Showing the flat donut (flat=1).';
  if (ringFailure) return ringFailure;
  if (!webglWorks()) return "Showing the flat donut: this device can't show the 3D ring.";
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

function ringHTML(slices, total, cur, monthName) {
  return `
    <div class="panel">
      <div class="ring-stage" tabindex="0" role="group" aria-roledescription="rotating donut chart"
        aria-label="Outgoings by category for ${esc(monthName)}" aria-describedby="ring-help">
        <div class="ring-caption" aria-hidden="true">
          <span class="ring-name"></span>
          <span class="ring-amount"></span>
          <span class="ring-share"></span>
        </div>
      </div>
      <p class="sr-only" id="ring-help">Drag to spin. Left and right arrow keys bring the previous or next category to the front. Amounts are listed below.</p>
      <p class="sr-only" id="ring-live" aria-live="polite" aria-atomic="true"></p>
      ${legendHTML(slices, total, cur)}
    </div>`;
}

async function mountRing(root, slices, total, cur, monthName) {
  const stage = $('.ring-stage', root);
  const rows = $$('.legend-row', root);
  const describe = (s) => `${s.name}, ${money(s.total, cur)}, ${shareText(s.total, total)}`;
  let front = Math.max(0, slices.findIndex((s) => s.key === state.donutActive));
  let announceTimer = 0;
  const show = (i) => {
    front = i;
    const s = slices[i];
    state.donutActive = s.key;
    $('.ring-name', stage).textContent = s.name;
    $('.ring-amount', stage).textContent = money(s.total, cur);
    $('.ring-share', stage).textContent = `${shareText(s.total, total)} of ${monthName}`;
    stage.setAttribute('aria-label', `Outgoings by category for ${monthName}. Front: ${describe(s)}`);
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
    fallBack("Showing the flat donut: the 3D ring couldn't load (are you offline?).");
    return;
  }
  if (!stage.isConnected) return; // re-rendered while loading
  if (!ringModule.ringAvailable()) {
    fallBack("Showing the flat donut: this device can't show the 3D ring.");
    return;
  }
  try {
    ring = ringModule.createRing(stage, {
      slices, selected: front,
      onFront: show,
      onSettle: announce,
      onFail: () => { ring = null; fallBack('Showing the flat donut: the 3D view stopped working.'); },
    });
  } catch (err) {
    console.error(err);
    fallBack("Showing the flat donut: this device can't show the 3D ring.");
  }
}

/** The yearly card: Income, Outgoings and Left over from yearSummary(), for `y`. */
function yearCardHTML(year, y, cur, nUndated) {
  const yearShort = year.income > 0 && year.leftOver < 0;
  const yearLine = (label, value, cls = '') => `
          <div class="year-line${cls}"><dt>${label}</dt><dd>${esc(money(value, cur))}</dd></div>`;
  return `
      <div class="stat stat-year">
        <div class="stat-label">${y}</div>
        <dl class="year-lines">${year.income > 0 ? yearLine('Income', year.income) : ''}${yearLine('Outgoings', year.outgoings)}${year.income > 0
          ? yearLine('Left over', year.leftOver, ` year-line-total${yearShort ? ' year-short' : ''}`) : ''}
        </dl>
        ${year.income > 0 ? '' : `<div class="stat-sub">No income dated in ${y}</div>`}
        ${yearShort ? '<div class="stat-sub year-short-note">More going out than coming in</div>' : ''}
        ${nUndated ? `<div class="stat-sub">Excludes ${plural(nUndated, 'undated item')}</div>` : ''}
      </div>`;
}

/* Year view ---------------------------------------------------------------- */
let yearChart = null;
function stopYearChart() {
  yearChart?.destroy();
  yearChart = null;
}

/**
 * Insights → Year: the range and stack controls, the year chart (js/year-chart.js) for the
 * months shown, one line for undated items, and the yearly card for the current calendar year.
 * Figures come from the calculation layer through chartMonths (monthSeries and breakdown).
 */
function renderYearView(root, { inCur, cur, currencies, modeHTML }) {
  const now = new Date();
  const fadeIn = !!state.yearFadeIn;
  state.yearFadeIn = false;
  const undated = undatedItems(inCur);
  const pressed = (on) => `aria-pressed="${on}"`;
  root.innerHTML = `${modeHTML}
    ${currencies.length > 1 ? `<p class="notice">Totals are per currency — amounts in other currencies aren't converted.</p>` : ''}
    <div class="yc-controls">
      <div class="segmented" role="group" aria-label="Months shown">
        <button type="button" class="seg-btn seg-btn-text" data-year-range="year" ${pressed(state.yearRange === 'year')}>This year</button>
        <button type="button" class="seg-btn seg-btn-text" data-year-range="roll" ${pressed(state.yearRange === 'roll')}>Rolling ±6 months</button>
      </div>
      <div class="segmented" role="group" aria-label="Colour the bars by">
        <button type="button" class="seg-btn seg-btn-text" data-year-stack="type" ${pressed(state.yearStack === 'type')}>By type</button>
        <button type="button" class="seg-btn seg-btn-text" data-year-stack="category" ${pressed(state.yearStack === 'category')}>By category</button>
      </div>
      <button type="button" class="chip" data-year-income ${pressed(state.yearIncome)}>Show income</button>
    </div>
    <div id="year-chart"></div>
    ${undated.length ? `<button type="button" class="summary-note summary-note-action yc-undated" data-id="${esc(undated[0].id)}">Excludes ${plural(undated.length, 'undated item')}</button>` : ''}
    <div class="stats yc-year-stats">${yearCardHTML(yearSummary(inCur, now.getFullYear()), now.getFullYear(), cur, 0)}</div>`;

  stopYearChart();
  const months = rangeMonths(state.yearRange, now);
  const data = chartMonths(inCur, months);
  yearChart = createYearChart($('#year-chart', root), {
    months: data.months, average: data.average, nowIndex: nowIndex(months, now),
    rolling: state.yearRange === 'roll', stack: state.yearStack, showIncome: state.yearIncome,
    money: (v) => money(v, cur), categoryColour: (g) => swatchVar(groupSwatch(g)),
    pos: state.yearPos, onSettle: (p) => { state.yearPos = p; }, fadeIn, overlays, reduced: reduceEffects(),
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
  $('#service-names').innerHTML = SERVICES.map((s) => `<option value="${esc(s.name)}">`).join('');
  fillCurrencySelect(form.elements.currency, state.settings.defaultCurrency);
  fillCurrencySelect($('#set-currency'), state.settings.defaultCurrency);
}

function fillCurrencySelect(select, selected) {
  const codes = new Set([...CURRENCIES, ...state.subs.map((s) => s.currency), selected]);
  select.innerHTML = [...codes].filter(Boolean)
    .map((c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

function fillCategoryList() {
  const used = state.subs.filter((s) => !isIncome(s)).map((s) => s.category).filter(Boolean);
  const all = [...new Set([...used, ...DEFAULT_CATEGORIES])];
  $('#category-names').innerHTML = all.map((c) => `<option value="${esc(c)}">`).join('');
}

function openForm(sub = null, type = 'expense') {
  try {
    state.editingId = sub?.id ?? null;
    formBase = sub ? { ...sub } : null;
    state.formType = sub ? (isIncome(sub) ? 'income' : 'expense') : type;
    form.reset();
    clearErrors();
    const f = form.elements;
    fillCurrencySelect(f.currency, sub?.currency || state.settings.defaultCurrency);

    if (sub) {
      f.name.value = sub.name;
      f.domain.value = sub.domain || '';
      f.emoji.value = sub.emoji || '';
      f.plan.value = sub.plan || '';
      f.price.value = sub.price;
      f.cycle.value = sub.cycle;
      f.nextRenewal.value = sub.nextRenewal || '';
      f.date.value = sub.date || '';
      f.category.value = sub.category || '';
      f.notes.value = sub.notes || '';
    }
    auto.domain = !f.domain.value;
    auto.category = !f.category.value;

    f.kind.value = state.formType;
    $('#btn-delete').hidden = !sub;
    syncFormMode();
    updateFormLogo();
    openDialog(dialog);
    if (!sub && !matchMedia('(pointer: coarse)').matches) f.name.focus();
  } catch (err) {
    console.error(err);
    reportError('Could not open the form', err);
  }
}

/** Show the fields that apply to the item type and cycle being edited. */
function syncFormMode() {
  const f = form.elements;
  const income = state.formType === 'income';
  const once = f.cycle.value === 'once';
  $('#sub-dialog-title').textContent = `${state.editingId ? 'Edit' : 'New'} ${income ? 'income' : 'expense'}`;
  $$('[data-expense-only]', form).forEach((el) => { el.hidden = income; });
  $('#field-renewal').hidden = once;
  $('#label-renewal').textContent = income ? 'Next payment' : 'Next renewal';
  $('#field-date').hidden = !once;
  $('#field-row-dates').hidden = $$('#field-row-dates > .field', form).every((el) => el.hidden);
  if (once && !f.date.value) f.date.value = todayStamp();
  if (!once) clearErrors('date');
  if (once) clearErrors('nextRenewal');

  f.name.placeholder = income ? 'e.g. My salary' : 'e.g. Netflix';
  // Service suggestions only make sense for expenses.
  if (income) f.name.removeAttribute('list'); else f.name.setAttribute('list', 'service-names');
  f.notes.placeholder = income ? 'e.g. Paid on the 5th, after tax' : 'Shared with family, billed to card ending 1234…';
  $('#label-price').textContent = income ? 'Amount' : 'Price';
  $('#label-cycle').textContent = income ? 'How often' : 'Billing cycle';
}

function updateFormLogo() {
  const f = form.elements;
  $('#form-logo').innerHTML = logoHTML({
    name: f.name.value || '?', domain: cleanDomain(f.domain.value), emoji: firstEmoji(f.emoji.value),
  }, 'md');
}

let logoTimer;
function bindForm() {
  const f = form.elements;

  // Fill domain/category from a known service name, unless the user has typed their own.
  const suggestFromName = () => {
    const svc = state.formType === 'income' ? null : matchService(f.name.value);
    if (auto.domain) f.domain.value = svc ? svc.domain : '';
    if (auto.category) f.category.value = svc ? svc.category : '';
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
  f.category.addEventListener('input', () => { auto.category = !f.category.value; });
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
  // Expense | Income toggle: swaps the type-specific fields and keeps everything typed so far.
  // Saving an existing item with the other type selected converts it (readForm uses formType).
  $$('input[name="kind"]', form).forEach((r) => r.addEventListener('change', () => {
    state.formType = f.kind.value === 'income' ? 'income' : 'expense';
    clearErrors('nextRenewal'); // its message names a renewal or a payment
    syncFormMode();
    suggestFromName();
  }));
  dialog.addEventListener('close', () => document.body.classList.remove('sheet-open'));

  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => closeDialog(dialog)));
  // Tap on the backdrop closes the sheet.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(dialog); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fromForm = readForm();
    if (!fromForm) return;
    const sub = mergeFormEdit(fromForm);
    try {
      await storage.save(sub);
      const i = state.subs.findIndex((s) => s.id === sub.id);
      if (i >= 0) state.subs[i] = sub; else state.subs.push(sub);
      closeDialog(dialog);
      render();
      toast(i >= 0 ? `Saved ${sub.name}` : `Added ${sub.name}`);
      storage.requestPersistence();
    } catch (err) {
      console.error(err);
      toast('Could not save. Is storage full or disabled?');
    }
  });

  $('#btn-delete').addEventListener('click', async () => {
    const sub = state.subs.find((s) => s.id === state.editingId);
    if (!sub) return;
    const ok = await confirmDialog({
      title: `Delete ${sub.name}?`,
      message: 'This deletes it here and on any devices you sync with. Export a backup first if you might want it back.',
      actions: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    try {
      await storage.remove(sub.id);
    } catch (err) {
      console.error(err);
      toast('Could not delete. Is storage full or disabled?');
      return;
    }
    state.subs = state.subs.filter((s) => s.id !== sub.id);
    closeDialog(dialog);
    render();
    toast(`Deleted ${sub.name}`);
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

  if (!name) { setError('name', 'Enter a name.'); valid = false; }
  if (priceRaw === '' || !Number.isFinite(price) || price < 0) {
    setError('price', `Enter ${income ? 'an amount' : 'a price'} of 0 or more.`); valid = false;
  }
  if (cycle === 'once' && !isDay(f.date.value)) { setError('date', 'Pick the date it happens.'); valid = false; }
  // Recurring items need a date to show in a month: a renewal for an expense, a payment for income
  // (both kept in nextRenewal). An item saved before this was required keeps working without one
  // until it's edited; then the date has to be picked.
  if (cycle !== 'once' && !isDay(f.nextRenewal.value)) {
    setError('nextRenewal', income ? 'Pick a payment date.' : 'Pick a renewal date.'); valid = false;
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
  return {
    id: existing?.id ?? uid(),
    type: income ? 'income' : 'expense',
    name,
    // Income streams don't use domain, plan or category.
    domain: income ? '' : cleanDomain(f.domain.value),
    emoji: firstEmoji(f.emoji.value),
    plan: income ? '' : f.plan.value.trim(),
    price: Math.round(price * 100) / 100,
    currency: f.currency.value || state.settings.defaultCurrency,
    cycle,
    nextRenewal: cycle === 'once' ? '' : f.nextRenewal.value || '',
    date: cycle === 'once' ? f.date.value : '',
    category: income ? '' : f.category.value.trim(),
    notes: f.notes.value.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function setError(field, msg) {
  form.elements[field].setAttribute('aria-invalid', 'true');
  $(`[data-error-for="${field}"]`, form).textContent = msg;
}
function clearErrors(field) {
  const fields = field ? [field] : ['name', 'price', 'date', 'nextRenewal'];
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
function bindSettings() {
  $('#set-currency').addEventListener('change', async (e) => {
    state.settings.defaultCurrency = e.target.value;
    await storage.saveSettings({ defaultCurrency: e.target.value });
    state.insightsCurrency = null;
    render();
    toast(`Default currency set to ${e.target.value}`);
  });

  $('#set-theme').addEventListener('change', (e) => {
    storage.setPref('theme', e.target.value);
    applyTheme(e.target.value);
  });

  // Per device, like the theme: a localStorage preference, never synced or exported.
  $('#set-motion').addEventListener('change', (e) => {
    storage.setPref('reduceMotion', e.target.checked ? 'on' : 'off');
    applyMotion();
  });

  $('#btn-export').addEventListener('click', exportData);
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
  });
}

async function exportData() {
  try {
    const payload = await storage.exportAll();
    payload.items.sort(byName);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const delivered = await deliverFile(blob, `substracker-${todayStamp()}.json`);
    if (delivered) toast(`Exported ${plural(payload.items.length, 'item')}`);
  } catch (err) {
    console.error(err);
    toast('Export failed.');
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// A file that can't be imported gets a dialog naming the problem; existing data is never touched.
function importProblem(message) {
  return confirmDialog({
    title: "Can't import this file",
    message: `${message} Nothing was changed.`,
    actions: [{ label: 'OK', value: true, kind: 'primary' }],
  });
}

async function importFile(file) {
  if (file.size > 5_000_000) return importProblem('That file is too large to be a Peek Budget backup.');
  let text;
  let preview;
  try {
    text = await file.text();
    preview = await storage.previewImport(text);
  } catch (err) {
    if (err instanceof storage.ImportError) return importProblem(err.message);
    console.error(err);
    return importProblem("The file couldn't be read.");
  }

  // Sync set up here (a key and sync turned on): both choices reach every device, so say so.
  let synced = false;
  try {
    const cfg = await storage.getSyncConfig();
    synced = Boolean(cfg.enabled && storage.householdIdentity(cfg)); // no need to read the key itself
  } catch { /* no sync on a fallback store */ }
  // Merge or Replace all; Replace asks once more. Cancelling at either step applies nothing.
  const mode = await chooseImportMode(preview, { synced, confirm: confirmDialog });
  if (!mode) return;

  try {
    const done = await storage.importAll(text, mode);
    await reloadData();
    toast(mode === 'replace'
      ? `Replaced with ${plural(done.total, 'item')}`
      : `Merged: ${done.added} new, ${done.updated} updated`);
    storage.requestPersistence();
  } catch (err) {
    if (err instanceof storage.ImportError) { importProblem(err.message); return; }
    console.error(err);
    toast('Import failed. Nothing was changed.');
  }
}

/* --------------------------------------------------------------------------
   Toast, storage persistence, service worker
   -------------------------------------------------------------------------- */
let toastTimer;
function toast(text, action) {
  const el = $('#toast');
  const btn = $('#toast-action');
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
    const offerUpdate = (worker) => toast('A new version is ready.', {
      label: 'Reload', sticky: true,
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
