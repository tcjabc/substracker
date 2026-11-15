import * as db from './db.js';
import { SERVICES, DEFAULT_CATEGORIES, matchService, cleanDomain } from './services.js';
import { logoHTML, initLogoHandling } from './logos.js';
import {
  CURRENCIES, uid, esc, money, cycleLabel, isIncome, isOnce,
  amountInMonth, amountInYear, nextRenewal, daysUntil, renewalText, parseDate, shortDate, todayStamp,
} from './util.js';

const APP_VERSION = '1.1.0';
const EXPORT_FORMAT = 'substracker';
const EXPORT_VERSION = 2; // v2 adds `type` (income/expense), the "once" cycle and `date`. Import reads v1 and v2.
const LS = {
  theme: 'substracker.theme', view: 'substracker.view', tab: 'substracker.tab', period: 'substracker.period',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  subs: [],
  settings: { defaultCurrency: 'TWD' },
  view: lsGet(LS.view) === 'list' ? 'list' : 'grid',
  tab: ['subs', 'insights', 'settings'].includes(lsGet(LS.tab)) ? lsGet(LS.tab) : 'subs',
  period: lsGet(LS.period) === 'annual' ? 'annual' : 'monthly', // Money summary strip
  insightsCurrency: null,
  insightsMonth: startOfMonth(new Date()),
  editingId: null,
  formType: 'expense', // what the open add/edit sheet is editing
};

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

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
  bindDialogFormFallback();
  $$('[data-action="add"]').forEach((b) => b.addEventListener('click', () => openForm()));
  $$('[data-action="add-income"]').forEach((b) => b.addEventListener('click', () => openForm(null, 'income')));
  $('#money-summary').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (!b) return;
    state.period = b.dataset.period;
    lsSet(LS.period, state.period);
    renderSubs();
  });

  try {
    const [subs, settings] = await Promise.all([db.getAllSubs(), db.getAllSettings()]);
    state.subs = subs;
    Object.assign(state.settings, settings);
  } catch (err) {
    console.error(err);
    toast('Could not open local storage. Data will not be saved in this browser mode.');
  }

  fillStaticLists();
  applyTheme(lsGet(LS.theme) || 'system');
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
  lsSet(LS.tab, tab);
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
  });
  $('#panel-subs').hidden = tab !== 'subs';
  $('#panel-insights').hidden = tab !== 'insights';
  $('#panel-settings').hidden = tab !== 'settings';
  $('#subs-actions').hidden = tab !== 'subs';
  $('#fab-dock').hidden = tab === 'settings';
  $('#page-title').textContent = TAB_TITLES[tab];
  document.title = tab === 'subs' ? 'SubsTracker' : `${TAB_TITLES[tab]} · SubsTracker`;
  if (focus) window.scrollTo({ top: 0 });
  if (tab === 'insights') renderInsights();
}

function bindViewToggle() {
  $$('.seg-btn[data-view]').forEach((b) =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view;
      lsSet(LS.view, state.view);
      renderSubs();
    })
  );
}

/* --------------------------------------------------------------------------
   Rendering
   -------------------------------------------------------------------------- */
function render() {
  renderSubs();
  if (state.tab === 'insights') renderInsights();
  fillCategoryList();
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

function renewalTag(sub) {
  const d = nextRenewal(sub);
  if (!d) return '';
  const soon = daysUntil(d) <= 7;
  return `<span class="tag${soon ? ' tag-soon' : ''}">${esc(renewalText(d))}</span>`;
}

const UNCATEGORISED = 'Uncategorised';
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
    const k = s.category?.trim() || UNCATEGORISED;
    if (!cats.has(k)) cats.set(k, []);
    cats.get(k).push(s);
  }
  [...cats.keys()]
    .sort((a, b) => (a === UNCATEGORISED) - (b === UNCATEGORISED) || a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .forEach((k) => groups.push({ name: k, items: cats.get(k).sort(byName) }));

  const isList = state.view === 'list';
  list.innerHTML = groups.map((g, i) => `
    <section class="money-group" aria-labelledby="group-${i}">
      <h2 class="section-title" id="group-${i}">${esc(g.name)} <span class="optional">${g.items.length}</span></h2>
      <div class="${isList ? 'subs-list' : 'subs-grid'}">${g.items.map(isList ? rowHTML : cardHTML).join('')}</div>
    </section>`).join('');
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
      <h2 class="section-title" id="cat-title">By category <span class="optional">${esc(monthName)}</span></h2>
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
      </div>
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
    renderInsights();
  }));
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

    const income = state.formType === 'income';
    const noun = income ? 'income stream' : 'expense';
    $('#sub-dialog-title').textContent = `${sub ? 'Edit' : 'Add'} ${noun}`;
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
  $('#form-logo').innerHTML = logoHTML({ name: f.name.value || '?', domain: cleanDomain(f.domain.value) }, 'md');
}

let logoTimer;
function bindForm() {
  const f = form.elements;

  f.name.addEventListener('input', () => {
    const svc = state.formType === 'income' ? null : matchService(f.name.value);
    if (auto.domain) f.domain.value = svc ? svc.domain : '';
    if (auto.category) f.category.value = svc ? svc.category : '';
    clearErrors('name');
    updateFormLogo();
  });
  f.domain.addEventListener('input', () => {
    auto.domain = !f.domain.value;
    clearTimeout(logoTimer);
    logoTimer = setTimeout(updateFormLogo, 400);
  });
  f.category.addEventListener('input', () => { auto.category = !f.category.value; });
  f.price.addEventListener('input', () => clearErrors('price'));
  f.date.addEventListener('input', () => clearErrors('date'));
  $$('input[name="cycle"]', form).forEach((r) => r.addEventListener('change', syncFormMode));

  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => closeDialog(dialog)));
  // Tap on the backdrop closes the sheet.
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeDialog(dialog); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const sub = readForm();
    if (!sub) return;
    try {
      await db.putSub(sub);
      const i = state.subs.findIndex((s) => s.id === sub.id);
      if (i >= 0) state.subs[i] = sub; else state.subs.push(sub);
      closeDialog(dialog);
      render();
      toast(i >= 0 ? `Saved ${sub.name}` : `Added ${sub.name}`);
      requestPersistence();
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
    await db.deleteSub(sub.id);
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
    await db.setSetting('defaultCurrency', e.target.value);
    state.insightsCurrency = null;
    render();
    toast(`Default currency set to ${e.target.value}`);
  });

  $('#set-theme').addEventListener('change', (e) => {
    lsSet(LS.theme, e.target.value);
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

function exportData() {
  const payload = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: { defaultCurrency: state.settings.defaultCurrency },
    // Renamed from v1's `subscriptions`, so older app versions (which would turn income
    // into expenses) refuse a v2 file instead of importing it wrongly.
    items: [...state.subs].sort(byName),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `substracker-${todayStamp()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${plural(state.subs.length, 'item')}`);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Coerce an imported record (v1 or v2) into a valid item, or null if unusable. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? raw.serviceName ?? '').trim().slice(0, 80);
  const price = Number(raw.price);
  if (!name || !Number.isFinite(price) || price < 0) return null;
  const type = raw.type === 'income' ? 'income' : 'expense';
  const currency = /^[A-Za-z]{3}$/.test(raw.currency ?? '') ? raw.currency.toUpperCase() : state.settings.defaultCurrency;
  const rawCycle = String(raw.cycle ?? raw.billingCycle ?? '');
  const cycle = /^(once|one-?off)$/i.test(rawCycle) ? 'once'
    : /^(annual|yearly|year)$/i.test(rawCycle) ? 'annual' : 'monthly';
  const nextRenewal = cycle !== 'once' && isDay(raw.nextRenewal) ? raw.nextRenewal : '';
  // A one-off needs a date to be counted anywhere; fall back to when it was created, then today.
  const date = cycle !== 'once' ? ''
    : isDay(raw.date) ? raw.date
    : isDay(String(raw.createdAt ?? '').slice(0, 10)) ? raw.createdAt.slice(0, 10) : todayStamp();
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : uid(),
    type,
    name,
    domain: cleanDomain(String(raw.domain ?? '')).slice(0, 120),
    plan: String(raw.plan ?? raw.planName ?? '').trim().slice(0, 80),
    price: Math.round(price * 100) / 100,
    currency,
    cycle,
    nextRenewal,
    date,
    category: String(raw.category ?? '').trim().slice(0, 40),
    notes: String(raw.notes ?? '').trim().slice(0, 1000),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  };
}

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast("That file isn't valid JSON.");
    return;
  }
  if (!Array.isArray(data) && Number(data?.version) > EXPORT_VERSION) {
    toast('That backup is from a newer version of SubsTracker. Update the app, then import it.');
    return;
  }
  // v2 files hold `items`; v1 files and bare arrays hold subscriptions.
  const rows = Array.isArray(data) ? data : (data?.items ?? data?.subscriptions);
  if (!Array.isArray(rows)) {
    toast('No items found in that file.');
    return;
  }
  const subs = rows.map(sanitize).filter(Boolean);
  const skipped = rows.length - subs.length;
  if (!subs.length) {
    toast('No valid items found in that file.');
    return;
  }

  const existingIds = new Set(state.subs.map((s) => s.id));
  const updates = subs.filter((s) => existingIds.has(s.id)).length;
  const skippedNote = skipped ? ` ${skipped} invalid entr${skipped === 1 ? 'y' : 'ies'} will be skipped.` : '';
  const mode = await confirmDialog({
    title: `Import ${plural(subs.length, 'item')}?`,
    message: state.subs.length
      ? `Merge adds new entries and updates ${updates} with matching IDs, keeping the rest of your ${state.subs.length}. Replace deletes everything here first.${skippedNote}`
      : `Your list is empty, so both options give the same result.${skippedNote}`,
    stacked: true,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Replace all', value: 'replace', kind: 'danger' },
      { label: 'Merge', value: 'merge', kind: 'primary' },
    ],
  });
  if (!mode) return;

  try {
    await db.bulkPutSubs(subs, { replace: mode === 'replace' });
    if (mode === 'replace' && data?.settings?.defaultCurrency && /^[A-Z]{3}$/.test(data.settings.defaultCurrency)) {
      state.settings.defaultCurrency = data.settings.defaultCurrency;
      await db.setSetting('defaultCurrency', state.settings.defaultCurrency);
    }
    state.subs = await db.getAllSubs();
    fillStaticLists();
    state.insightsCurrency = null;
    render();
    toast(`${mode === 'replace' ? 'Replaced with' : 'Merged'} ${plural(subs.length, 'item')}${skipped ? `, skipped ${skipped}` : ''}`);
    requestPersistence();
  } catch (err) {
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

// Ask the browser not to evict our data under storage pressure (best effort).
let persistAsked = false;
async function requestPersistence() {
  if (persistAsked || !navigator.storage?.persist) return;
  persistAsked = true;
  try { if (!(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* ignore */ }
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
