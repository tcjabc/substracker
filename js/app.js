import * as db from './db.js';
import { SERVICES, DEFAULT_CATEGORIES, matchService, cleanDomain } from './services.js';
import { logoHTML, initLogoHandling } from './logos.js';
import {
  CURRENCIES, uid, esc, money, monthlyCost, annualCost, cycleLabel,
  nextRenewal, daysUntil, renewalText, todayStamp,
} from './util.js';

const APP_VERSION = '1.0.1';
const EXPORT_FORMAT = 'substracker';
const LS = { theme: 'substracker.theme', view: 'substracker.view', tab: 'substracker.tab' };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  subs: [],
  settings: { defaultCurrency: 'TWD' },
  view: lsGet(LS.view) === 'list' ? 'list' : 'grid',
  tab: ['subs', 'insights', 'settings'].includes(lsGet(LS.tab)) ? lsGet(LS.tab) : 'subs',
  insightsCurrency: null,
  editingId: null,
};

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
const TAB_TITLES = { subs: 'Subscriptions', insights: 'Insights', settings: 'Settings' };

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
  $('#fab').hidden = tab === 'settings';
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

function renderSubs() {
  const list = $('#subs-list');
  const subs = [...state.subs].sort(byName);

  $$('.seg-btn[data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === state.view));
  $('#subs-empty').hidden = subs.length > 0;
  list.hidden = subs.length === 0;
  $('#subs-summary').hidden = subs.length === 0;
  $('#subs-summary').textContent = summaryLine(subs);

  list.className = state.view === 'list' ? 'subs-list' : 'subs-grid';
  list.innerHTML = subs.map(state.view === 'list' ? rowHTML : cardHTML).join('');
}

function summaryLine(subs) {
  const n = subs.length;
  const cur = state.settings.defaultCurrency;
  const inCur = subs.filter((s) => s.currency === cur);
  const total = inCur.reduce((t, s) => t + monthlyCost(s), 0);
  let line = `${n} subscription${n === 1 ? '' : 's'}`;
  if (inCur.length) line += ` · ${money(total, cur)} / month`;
  if (inCur.length < n && inCur.length) line += ` (${cur} only)`;
  return line;
}

function cardHTML(s) {
  const meta = [renewalTag(s), s.category ? `<span class="tag">${esc(s.category)}</span>` : ''].join('');
  return `
    <button type="button" class="sub-card" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.name)}">
      ${logoHTML(s, 'md')}
      <span class="sub-text">
        <span class="sub-name">${esc(s.name)}</span>
        ${s.plan ? `<span class="sub-plan">${esc(s.plan)}</span>` : ''}
      </span>
      <span class="sub-price"><span class="amount">${esc(money(s.price, s.currency))}</span><span class="cycle">${cycleLabel(s.cycle)}</span></span>
      ${meta ? `<span class="sub-meta">${meta}</span>` : ''}
    </button>`;
}

function rowHTML(s) {
  const sub = [s.plan, s.category].filter(Boolean).map(esc).join(' · ');
  const d = nextRenewal(s);
  return `
    <button type="button" class="sub-row" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.name)}">
      ${logoHTML(s, 'sm')}
      <span class="sub-text">
        <span class="sub-name">${esc(s.name)}</span>
        ${sub || d ? `<span class="sub-plan">${sub}${sub && d ? ' · ' : ''}${d ? esc(renewalText(d)) : ''}</span>` : ''}
      </span>
      <span class="sub-row-price">
        <span class="amount">${esc(money(s.price, s.currency))}</span>
        <span class="cycle">${s.cycle === 'annual' ? 'yearly' : 'monthly'}</span>
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
        <p>Add a subscription and your monthly and yearly totals will appear here.</p>
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

  const subs = state.subs.filter((s) => s.currency === cur);
  const monthly = subs.reduce((t, s) => t + monthlyCost(s), 0);
  const annual = subs.reduce((t, s) => t + annualCost(s), 0);
  const nMonthly = subs.filter((s) => s.cycle !== 'annual').length;
  const nAnnual = subs.length - nMonthly;

  // Category breakdown by monthly-equivalent cost.
  const cats = new Map();
  for (const s of subs) {
    const k = s.category?.trim() || 'Uncategorised';
    const c = cats.get(k) || { name: k, total: 0, count: 0 };
    c.total += monthlyCost(s);
    c.count += 1;
    cats.set(k, c);
  }
  const catList = [...cats.values()].sort((a, b) => b.total - a.total);
  const maxCat = catList[0]?.total || 1;

  const ranked = [...subs].sort((a, b) => monthlyCost(b) - monthlyCost(a) || byName(a, b));

  root.innerHTML = `
    ${currencies.length > 1 ? `<p class="notice">Totals are per currency — amounts in other currencies aren't converted.</p>` : ''}
    <div class="stats">
      <div class="stat stat-primary">
        <div class="stat-label">Per month</div>
        <div class="stat-value">${esc(money(monthly, cur))}</div>
        <div class="stat-sub">Annual plans counted as ÷ 12</div>
      </div>
      <div class="stat">
        <div class="stat-label">Per year</div>
        <div class="stat-value">${esc(money(annual, cur))}</div>
        <div class="stat-sub">Monthly plans counted as × 12</div>
      </div>
      <div class="stat">
        <div class="stat-label">Subscriptions</div>
        <div class="stat-value">${subs.length}</div>
        <div class="stat-sub">${nMonthly} monthly · ${nAnnual} annual</div>
      </div>
    </div>

    <section class="section" aria-labelledby="cat-title">
      <h2 class="section-title" id="cat-title">By category <span class="optional">per month</span></h2>
      <div class="panel">
        ${catList.map((c) => {
          const pct = monthly ? Math.round((c.total / monthly) * 100) : 0;
          return `
          <div class="cat-row">
            <div class="cat-head">
              <span class="cat-name">${esc(c.name)} <span class="cat-count">${c.count}</span></span>
              <span class="cat-amount">${esc(money(c.total, cur))}<span class="pct">${pct}%</span></span>
            </div>
            <div class="bar" role="img" aria-label="${esc(c.name)}: ${pct}% of monthly spend"><div class="bar-fill" style="width:${Math.max(2, (c.total / maxCat) * 100).toFixed(1)}%"></div></div>
          </div>`;
        }).join('')}
      </div>
    </section>

    <section class="section" aria-labelledby="rank-title">
      <h2 class="section-title" id="rank-title">Most expensive <span class="optional">monthly equivalent</span></h2>
      <div class="panel">
        ${ranked.map((s, i) => `
          <button type="button" class="rank-row" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.name)}">
            <span class="rank-num">${i + 1}</span>
            ${logoHTML(s, 'sm')}
            <span class="sub-text">
              <span class="sub-name">${esc(s.name)}</span>
              <span class="sub-plan">${esc(money(s.price, s.currency))} ${cycleLabel(s.cycle)}${s.plan ? ' · ' + esc(s.plan) : ''}</span>
            </span>
            <span class="sub-row-price">
              <span class="amount">${esc(money(monthlyCost(s), cur))}</span>
              <span class="cycle">/ mo</span>
            </span>
          </button>`).join('')}
      </div>
    </section>`;
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
  const used = state.subs.map((s) => s.category).filter(Boolean);
  const all = [...new Set([...used, ...DEFAULT_CATEGORIES])];
  $('#category-names').innerHTML = all.map((c) => `<option value="${esc(c)}">`).join('');
}

function openForm(sub = null) {
  try {
    state.editingId = sub?.id ?? null;
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
      f.category.value = sub.category || '';
      f.notes.value = sub.notes || '';
    }
    auto.domain = !f.domain.value;
    auto.category = !f.category.value;

    $('#sub-dialog-title').textContent = sub ? 'Edit subscription' : 'Add subscription';
    $('#btn-delete').hidden = !sub;
    updateFormLogo();
    openDialog(dialog);
    if (!sub && !matchMedia('(pointer: coarse)').matches) f.name.focus();
  } catch (err) {
    console.error(err);
    reportError('Could not open the form', err);
  }
}

function updateFormLogo() {
  const f = form.elements;
  $('#form-logo').innerHTML = logoHTML({ name: f.name.value || '?', domain: cleanDomain(f.domain.value) }, 'md');
}

let logoTimer;
function bindForm() {
  const f = form.elements;

  f.name.addEventListener('input', () => {
    const svc = matchService(f.name.value);
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

  if (!name) { setError('name', 'Enter a service name.'); valid = false; }
  if (priceRaw === '' || !Number.isFinite(price) || price < 0) { setError('price', 'Enter a price of 0 or more.'); valid = false; }
  if (!valid) { form.querySelector('[aria-invalid="true"]')?.focus(); return null; }

  const existing = state.subs.find((s) => s.id === state.editingId);
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? uid(),
    name,
    domain: cleanDomain(f.domain.value),
    plan: f.plan.value.trim(),
    price: Math.round(price * 100) / 100,
    currency: f.currency.value || state.settings.defaultCurrency,
    cycle: f.cycle.value === 'annual' ? 'annual' : 'monthly',
    nextRenewal: f.nextRenewal.value || '',
    category: f.category.value.trim(),
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
  const fields = field ? [field] : ['name', 'price'];
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
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { defaultCurrency: state.settings.defaultCurrency },
    subscriptions: [...state.subs].sort(byName),
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
  toast(`Exported ${state.subs.length} subscription${state.subs.length === 1 ? '' : 's'}`);
}

/** Coerce an imported record into a valid subscription, or null if unusable. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? raw.serviceName ?? '').trim().slice(0, 80);
  const price = Number(raw.price);
  if (!name || !Number.isFinite(price) || price < 0) return null;
  const currency = /^[A-Za-z]{3}$/.test(raw.currency ?? '') ? raw.currency.toUpperCase() : state.settings.defaultCurrency;
  const cycle = /^(annual|yearly|year)$/i.test(raw.cycle ?? raw.billingCycle ?? '') ? 'annual' : 'monthly';
  const nextRenewal = /^\d{4}-\d{2}-\d{2}$/.test(raw.nextRenewal ?? '') ? raw.nextRenewal : '';
  const now = new Date().toISOString();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 64) : uid(),
    name,
    domain: cleanDomain(String(raw.domain ?? '')).slice(0, 120),
    plan: String(raw.plan ?? raw.planName ?? '').trim().slice(0, 80),
    price: Math.round(price * 100) / 100,
    currency,
    cycle,
    nextRenewal,
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
  const rows = Array.isArray(data) ? data : data?.subscriptions;
  if (!Array.isArray(rows)) {
    toast('No subscriptions found in that file.');
    return;
  }
  const subs = rows.map(sanitize).filter(Boolean);
  const skipped = rows.length - subs.length;
  if (!subs.length) {
    toast('No valid subscriptions found in that file.');
    return;
  }

  const existingIds = new Set(state.subs.map((s) => s.id));
  const updates = subs.filter((s) => existingIds.has(s.id)).length;
  const skippedNote = skipped ? ` ${skipped} invalid entr${skipped === 1 ? 'y' : 'ies'} will be skipped.` : '';
  const mode = await confirmDialog({
    title: `Import ${subs.length} subscription${subs.length === 1 ? '' : 's'}?`,
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
    toast(`${mode === 'replace' ? 'Replaced with' : 'Merged'} ${subs.length} subscription${subs.length === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}`);
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
