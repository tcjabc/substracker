import * as storage from './storage.js';
import { deliverFile } from './files.js';
import { SERVICES, DEFAULT_CATEGORIES, matchService, cleanDomain } from './services.js';
import { logoHTML, initLogoHandling } from './logos.js';
import {
  CURRENCIES, localeCurrency, uid, esc, money, cycleLabel, isIncome, isOnce, firstEmoji,
  amountInMonth, amountInYear, nextRenewal, daysUntil, renewalText, parseDate, shortDate, todayStamp,
} from './util.js';

const APP_VERSION = '1.2.1';

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
  catView: storage.getPref('catView') === 'list' ? 'list' : 'donut', // Insights "By category"
  donutActive: null, // highlighted donut slice key, or null
  tab: ['subs', 'insights', 'settings'].includes(storage.getPref('tab')) ? storage.getPref('tab') : 'subs',
  period: storage.getPref('period') === 'annual' ? 'annual' : 'monthly', // Money summary strip
  insightsCurrency: null,
  insightsMonth: startOfMonth(new Date()),
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

function openDialog(dlg) {
  // The add/edit sheet hides the floating buttons; see .sheet-open in app.css.
  if (dlg.classList.contains('sheet')) document.body.classList.add('sheet-open');
  if (HAS_MODAL) { dlg.showModal(); return; }
  dlg.setAttribute('open', '');
  dlg.classList.add('dialog-fallback');
}

function closeDialog(dlg, returnValue) {
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
  $$('[data-action="add"]').forEach((b) => b.addEventListener('click', () => openForm()));
  $$('[data-action="add-income"]').forEach((b) => b.addEventListener('click', () => openForm(null, 'income')));
  $('#money-summary').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    state.period = b.dataset.period;
    storage.setPref('period', state.period);
    renderSubs();
  });

  storage.setBlockedHandler(() => toast('Close other SubsTracker tabs or windows to finish updating.', {
    label: 'Dismiss', sticky: true, run: () => {},
  }));
  try {
    const [subs, settings] = await Promise.all([storage.getAll(), storage.getSettings()]);
    if ((await storage.status()).usingLegacy) {
      toast('Storage update could not be verified, so the previous copy of your data is in use.', {
        label: 'Dismiss', sticky: true, run: () => {},
      });
    }
    state.subs = subs;
    // Before 1.2.1 the default was always TWD and only stored once changed. Existing data keeps TWD so the
    // summary strip doesn't switch currency; a fresh install takes the device's locale. Stored either way.
    if (!settings.defaultCurrency) {
      settings.defaultCurrency = subs.length ? 'TWD' : localeCurrency('TWD');
      storage.saveSettings({ defaultCurrency: settings.defaultCurrency }).catch(console.error);
    }
    Object.assign(state.settings, settings);
    state.settings.groupColors = sanitizeGroupColors(state.settings.groupColors);
    // Ask for persistent storage once there's data worth keeping (a first save asks too).
    if (subs.length) storage.requestPersistence();
  } catch (err) {
    console.error(err);
    toast('Could not open local storage. Data will not be saved in this browser mode.');
  }

  fillStaticLists();
  applyTheme(storage.getPref('theme') || 'system');
  setTab(state.tab, { focus: false });
  render();
  registerSW();
  $('#app-version').textContent = `SubsTracker ${APP_VERSION}`;
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
  document.title = tab === 'subs' ? 'SubsTracker' : `${TAB_TITLES[tab]} · SubsTracker`;
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

const UNCATEGORISED = 'Uncategorised';
const groupOf = (s) => s.category?.trim() || UNCATEGORISED;
// Group display order: A–Z, with Uncategorised last.
const byGroupName = (a, b) =>
  (a === UNCATEGORISED) - (b === UNCATEGORISED) || a.localeCompare(b, undefined, { sensitivity: 'base' });

/* Group colours ------------------------------------------------------------- */
/**
 * Give every expense group a swatch, in display order so the first assignment is stable.
 * Groups keep the colour they have; a new group takes the next unused swatch (the least used
 * one once all ten are taken). Income has no colour.
 */
function ensureGroupColors() {
  const map = state.settings.groupColors;
  const names = [...new Set(state.subs.filter((s) => !isIncome(s)).map(groupOf))].sort(byGroupName);
  let changed = false;
  for (const name of names) {
    if (SWATCH_KEYS.has(map[name])) continue;
    const uses = new Map(SWATCHES.map((s) => [s.key, 0]));
    for (const n of names) if (SWATCH_KEYS.has(map[n])) uses.set(map[n], uses.get(map[n]) + 1);
    map[name] = SWATCHES.reduce((best, s) => (uses.get(s.key) < uses.get(best) ? s.key : best), SWATCHES[0].key);
    changed = true;
  }
  if (changed) storage.saveSettings({ groupColors: map }).catch((err) => console.error(err));
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
    try { await storage.saveSettings({ groupColors: state.settings.groupColors }); } catch (err) {
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
  return `<span class="tag${soon ? ' tag-soon' : ''}">${esc(renewalText(d))}</span>`;
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

/** Totals for the Money summary strip, in the default currency only (amounts are never converted). */
function periodTotals(items, period, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const amount = (s) => (period === 'annual' ? amountInYear(s, y) : amountInMonth(s, y, m));
  let income = 0;
  let out = 0;
  for (const s of items) {
    if (isIncome(s)) income += amount(s); else out += amount(s);
  }
  return { income, out, left: income - out };
}

function renderMoneySummary() {
  const cur = state.settings.defaultCurrency;
  const inCur = state.subs.filter((s) => s.currency === cur);
  const others = state.subs.length - inCur.length;
  const t = periodTotals(inCur, state.period);
  const now = new Date();
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
      ${cell('Outgoings', t.out)}
      ${cell('Left over', t.left, t.left < 0 ? ' summary-short' : '', t.left < 0 ? 'More going out than coming in' : '')}
    </div>
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
  const parts = [isIncome(s) ? '' : s.plan, isOnce(s) ? onceDate(s) : d ? renewalText(d) : ''];
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

  const month = state.insightsMonth;
  const y = month.getFullYear();
  const m = month.getMonth();
  const monthName = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const inCur = state.subs.filter((s) => s.currency === cur);
  const incomeItems = inCur.filter(isIncome);
  const subs = inCur.filter((s) => !isIncome(s)); // expenses only from here on

  const incomeMonth = incomeItems.reduce((t, s) => t + amountInMonth(s, y, m), 0);
  const monthly = subs.reduce((t, s) => t + amountInMonth(s, y, m), 0);
  const annual = subs.reduce((t, s) => t + amountInYear(s, y), 0);
  const recurring = subs.filter((s) => !isOnce(s));
  const nAnnual = recurring.filter((s) => s.cycle === 'annual').length;
  const nMonthly = recurring.length - nAnnual;
  // Items that count this month: every recurring expense, plus one-offs dated in it.
  const inMonth = subs.filter((s) => !isOnce(s) || amountInMonth(s, y, m) > 0);
  const nOnce = inMonth.length - recurring.length;

  // Category breakdown for the selected month (recurring at monthly equivalent, one-offs in their month).
  const cats = new Map();
  for (const s of inMonth) {
    const k = s.category?.trim() || UNCATEGORISED;
    const c = cats.get(k) || { name: k, total: 0, count: 0 };
    c.total += amountInMonth(s, y, m);
    c.count += 1;
    cats.set(k, c);
  }
  const catList = [...cats.values()].sort((a, b) => b.total - a.total);
  const maxCat = catList[0]?.total || 1;

  const ranked = [...inMonth].sort((a, b) => amountInMonth(b, y, m) - amountInMonth(a, y, m) || byName(a, b));

  const pct = incomeMonth ? Math.round((monthly / incomeMonth) * 100) : 0;
  const headline = incomeMonth
    ? `Outgoings <strong>${esc(money(monthly, cur))}</strong> of <strong>${esc(money(incomeMonth, cur))}</strong> income <span class="pct">(${pct}%)</span>`
    : `Outgoings <strong>${esc(money(monthly, cur))}</strong> <span class="pct">· no ${esc(cur)} income recorded</span>`;

  root.innerHTML = `
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
    <div class="stats">
      <div class="stat stat-primary">
        <div class="stat-label">${esc(monthName)}</div>
        <div class="stat-value">${esc(money(monthly, cur))}</div>
        <div class="stat-sub">Annual plans counted as ÷ 12, plus one-offs this month</div>
      </div>
      <div class="stat">
        <div class="stat-label">${y}</div>
        <div class="stat-value">${esc(money(annual, cur))}</div>
        <div class="stat-sub">Monthly × 12, annual, and one-offs dated ${y}</div>
      </div>
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
          <button type="button" class="seg-btn" data-catview="donut" aria-pressed="${state.catView === 'donut'}" title="Donut chart">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M12 3.5V8.5"/></svg>
            <span class="sr-only">Donut</span>
          </button>
          <button type="button" class="seg-btn" data-catview="list" aria-pressed="${state.catView === 'list'}" title="List view">
            <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/></svg>
            <span class="sr-only">List</span>
          </button>
        </div>
      </div>
      ${state.catView === 'donut' ? donutHTML(donutSlices(catList, monthly), monthly, cur, monthName) : `
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
              <span class="amount">${esc(money(amountInMonth(s, y, m), cur))}</span>
              <span class="cycle">${isOnce(s) ? 'one-off' : '/ mo'}</span>
            </span>
          </button>`).join('')}
      </div>
    </section>` : ''}`;

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
  // Tap a slice or legend row to highlight it; tap it again to clear.
  $$('[data-slice]', root).forEach((el) => el.addEventListener('click', () => {
    state.donutActive = state.donutActive === el.dataset.slice ? null : el.dataset.slice;
    applyDonutHighlight(root);
  }));
  applyDonutHighlight(root);
}

/* Donut ------------------------------------------------------------------- */
const DONUT = { r: 80, gap: 2 }; // SVG user units in a 200 × 200 viewBox; stroke width lives in app.css
const SMALL_SLICE = 0.03; // categories under 3% of the month are pooled into "Other"

/** Slices for the month, largest first. Two or more categories under 3% become one neutral "Other". */
function donutSlices(catList, total) {
  const big = [];
  const small = [];
  for (const c of catList) (total && c.total / total < SMALL_SLICE ? small : big).push(c);
  // Pooling a single category would only hide its name, so keep it as its own slice.
  if (small.length < 2) big.push(...small.splice(0));
  const slices = big.map((c) => ({
    key: `cat:${c.name}`, name: c.name, total: c.total, sub: plural(c.count, 'item'),
    swatch: swatchVar(groupSwatch(c.name)),
  }));
  if (small.length) {
    slices.push({
      key: 'other', name: 'Other', total: small.reduce((t, c) => t + c.total, 0),
      sub: small.map((c) => c.name).join(', '), swatch: 'var(--group-other)',
    });
  }
  return slices;
}

const shareText = (v, total) => {
  const p = total ? (v / total) * 100 : 0;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
};

function donutHTML(slices, total, cur, monthName) {
  if (!slices.length) {
    return `
      <div class="panel donut-empty">
        <div class="donut-empty-ring" aria-hidden="true"></div>
        <p class="donut-empty-title">No ${esc(cur)} outgoings in ${esc(monthName)}</p>
        <p class="donut-empty-text">Add an expense, or step to another month.</p>
      </div>`;
  }
  const C = 2 * Math.PI * DONUT.r;
  const gap = slices.length > 1 ? DONUT.gap : 0; // a single category is a full ring
  let offset = 0;
  const arcs = slices.map((s) => {
    const len = total ? (s.total / total) * C : C / slices.length;
    const dash = Math.max(len - gap, 0.5);
    const arc = `<circle class="donut-slice" data-slice="${esc(s.key)}" cx="100" cy="100" r="${DONUT.r}"
      style="--swatch: ${s.swatch}" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}"
      stroke-dashoffset="${(-offset).toFixed(2)}"><title>${esc(s.name)}: ${esc(money(s.total, cur))} (${shareText(s.total, total)})</title></circle>`;
    offset += len;
    return arc;
  }).join('');

  return `
    <div class="panel">
      <div class="donut-wrap">
        <div class="donut">
          <svg viewBox="0 0 200 200" role="img" aria-label="Donut chart of outgoings by category for ${esc(monthName)}. Amounts are listed below.">${arcs}</svg>
          <div class="donut-center">
            <span class="donut-total">${esc(money(total, cur))}</span>
            <span class="donut-label">${esc(monthName)}</span>
          </div>
        </div>
      </div>
      <div class="legend">
        ${slices.map((s) => `
        <button type="button" class="legend-row" data-slice="${esc(s.key)}" aria-pressed="false">
          <span class="legend-dot" style="--swatch: ${s.swatch}" aria-hidden="true"></span>
          <span class="legend-text">
            <span class="legend-name">${esc(s.name)}</span>
            <span class="legend-sub">${esc(s.sub)}</span>
          </span>
          <span class="cat-amount">${esc(money(s.total, cur))}<span class="pct">${shareText(s.total, total)}</span></span>
        </button>`).join('')}
      </div>
    </div>`;
}

function applyDonutHighlight(root) {
  const key = state.donutActive;
  const has = !!key && $$('[data-slice]', root).some((el) => el.dataset.slice === key);
  if (!has) state.donutActive = null;
  $$('.donut, .legend', root).forEach((el) => el.classList.toggle('has-active', has));
  $$('[data-slice]', root).forEach((el) => {
    const on = has && el.dataset.slice === key;
    el.classList.toggle('is-active', on);
    if (el.tagName === 'BUTTON') el.setAttribute('aria-pressed', String(on));
  });
}

/* --------------------------------------------------------------------------
   Add / edit form
   -------------------------------------------------------------------------- */
const dialog = $('#sub-dialog');
const form = $('#sub-form');
// Tracks whether domain/category still hold auto-suggested values (safe to overwrite).
const auto = { domain: false, category: false };

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
  $('#field-renewal').hidden = income || once;
  $('#field-date').hidden = !once;
  $('#field-row-dates').hidden = $$('#field-row-dates > .field', form).every((el) => el.hidden);
  if (once && !f.date.value) f.date.value = todayStamp();
  if (!once) clearErrors('date');

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
  $$('input[name="cycle"]', form).forEach((r) => r.addEventListener('change', syncFormMode));
  // Expense | Income toggle: swaps the type-specific fields and keeps everything typed so far.
  // Saving an existing item with the other type selected converts it (readForm uses formType).
  $$('input[name="kind"]', form).forEach((r) => r.addEventListener('change', () => {
    state.formType = f.kind.value === 'income' ? 'income' : 'expense';
    syncFormMode();
    suggestFromName();
  }));
  dialog.addEventListener('close', () => document.body.classList.remove('sheet-open'));

  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => closeDialog(dialog)));
  // Tap on the backdrop closes the sheet.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(dialog); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sub = readForm();
    if (!sub) return;
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
      message: 'This removes it from this device. Export a backup first if you might want it back.',
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
  if (!valid) { form.querySelector('[aria-invalid="true"]')?.focus(); return null; }

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
    nextRenewal: income || cycle === 'once' ? '' : f.nextRenewal.value || '',
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
  const fields = field ? [field] : ['name', 'price', 'date'];
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

  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await importFile(file);
  });

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
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

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
  else delete root.dataset.theme;
  $('#set-theme').value = ['light', 'dark'].includes(mode) ? mode : 'system';
  // Keep the browser chrome in step with the chosen theme.
  requestAnimationFrame(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    $$('meta[name="theme-color"]').forEach((m) => {
      if (mode === 'system') {
        m.content = m.media.includes('dark') ? '#111216' : '#f6f6f9';
      } else m.content = bg;
    });
  });
}

async function exportData() {
  try {
    const payload = await storage.exportAll();
    payload.items.sort(byName);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    await deliverFile(blob, `substracker-${todayStamp()}.json`);
    toast(`Exported ${plural(payload.items.length, 'item')}`);
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
  if (file.size > 5_000_000) return importProblem('That file is too large to be a SubsTracker backup.');
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

  const { merge, replace } = preview;
  const newer = merge.newerVersion
    ? ' It comes from a newer version of SubsTracker; fields this version doesn\'t know are ignored.' : '';
  const message = merge.existing
    ? `${plural(merge.total, 'item')}, ${merge.added} new.${newer} Merge adds the new ones, updates ${merge.updated} where the file's copy is newer`
      + `${merge.kept ? ` and keeps ${merge.kept} where yours is the same or newer` : ''}. `
      + `Replace deletes your ${plural(merge.existing, 'item')} and uses the file's items and settings`
      + `${replace.removed ? ` (${replace.removed} of yours aren't in the file)` : ''}.`
    : `${plural(merge.total, 'item')}, ${merge.added} new.${newer} Your list is empty, so both options give the same result.`;
  const mode = await confirmDialog({
    title: 'Import this backup?',
    message,
    stacked: true,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Replace all', value: 'replace', kind: 'danger' },
      { label: 'Merge', value: 'merge', kind: 'primary' },
    ],
  });
  if (!mode) return;

  try {
    const done = await storage.importAll(text, mode);
    const [subs, settings] = await Promise.all([storage.getAll(), storage.getSettings()]);
    state.subs = subs;
    Object.assign(state.settings, settings);
    state.settings.groupColors = sanitizeGroupColors(state.settings.groupColors);
    fillStaticLists();
    state.insightsCurrency = null;
    render();
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
  if (!('serviceWorker' in navigator)) return;
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
