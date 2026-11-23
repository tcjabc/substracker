// The "Import with AI" sheet in Settings: a warning to read and confirm, the prompt to copy and
// the reply to paste or pick, a review of every row, then the usual Merge / Replace all choice.
// The app never sends anything anywhere: the person copies the prompt into an AI chat of their
// own choosing and brings the reply back. Nothing is written until they confirm the import.
// The rules live in js/import-ai.js; the slider in js/slide-confirm.js.

import { esc, money, cycleLabel, parseDate, shortDate, chooseImportMode, backupLabel } from './util.js';
import {
  AiImportError, parseAiImport, reviewRows, backupFromRows, itemFromFields, totalsOf, TOTAL_LABELS, errorReport,
  aiImportMessage, aiReplaceConfirm, aiChoiceTitle, MAX_AI_CHARS, PROBLEM, rowPay,
} from './import-ai.js';
import { PAY_CASH, PAY_NOT_SET } from './cards.js';
import { t } from './i18n.js';
import { AI_IMPORT_PROMPT } from './import-ai-prompt.js';
import { createSlideConfirm } from './slide-confirm.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const items = (n) => t('common.items', { count: n });

const STATUS_TAG = {
  [PROBLEM.error]: () => `<span class="tag tag-danger">${esc(t('ai.tag.error'))}</span>`,
  [PROBLEM.cycle]: () => `<span class="tag tag-warn">${esc(t('ai.tag.cycle'))}</span>`,
  [PROBLEM.date]: () => `<span class="tag tag-warn">${esc(t('ai.tag.date'))}</span>`,
  [PROBLEM.duplicate]: () => `<span class="tag">${esc(t('ai.tag.duplicate'))}</span>`,
  [PROBLEM.note]: () => `<span class="tag tag-warn">${esc(t('ai.tag.note'))}</span>`,
};

/**
 * Copy `text`. Resolves true when it reached the clipboard; false when clipboard access is blocked,
 * in which case `fallback` (a read-only textarea) is shown with the text selected, to copy by hand.
 */
export async function copyText(text, fallback) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text);
    if (fallback) fallback.hidden = true;
    return true;
  } catch {
    if (fallback) {
      fallback.value = text;
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
    }
    return false;
  }
}

/**
 * `ui` provides openDialog, closeDialog, confirmDialog, toast, overlays, exportData (resolves true
 * when a backup was delivered), items() (the live items), isSynced(), reloadData(),
 * reduceMotion() (the "Reduce motion and effects" setting) and cards() (the household's live
 * payment cards, js/cards.js listCards: the review's Paid with options, 1.27.0).
 */
export function initImportAiSheet({ storage, ui }) {
  const dlg = $('#ai-dialog');
  const promptText = $('#ai-prompt-text');
  const replyInput = $('#ai-reply');
  const fileInput = $('#ai-file');
  const replyProblems = $('#ai-reply-problems');
  const replyErrorBox = $('#ai-reply-error');
  const replyErrorText = $('#ai-reply-error-text');
  const reviewErrorBox = $('#ai-review-error');
  const reviewErrorText = $('#ai-review-error-text');
  const list = $('#ai-rows');
  const importBtn = $('#ai-import');
  const continueBtn = $('#ai-continue');
  const backupBtns = $$('[data-ai-backup]', dlg);
  let rawRows = [];
  let rows = [];
  let chosen = new Map(); // row number → include, for rows the person ticked or unticked
  // Paid with (1.27.0): one choice for every expense row, and a row's own pick over it. Kept by row
  // number, like `chosen`, because refreshReview rebuilds the rows after every fix.
  const payAllSelect = $('#ai-pay');
  let payAll = PAY_NOT_SET;
  let payChosen = new Map();
  let payOptions = [];
  const livePay = () => new Set(payOptions.map((o) => o.value));
  const payOptionsHTML = (selected) => payOptions.map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  let busy = false;
  let backupSaved = false;
  let view = '';

  promptText.value = AI_IMPORT_PROMPT;
  // Enter in a field (the date fixes) must not submit the sheet's form, which would close it.
  $('#ai-form').addEventListener('submit', (e) => e.preventDefault());

  const slider = createSlideConfirm($('#ai-slide'), {
    onChange: (on) => { continueBtn.disabled = !on; },
    reduceMotion: () => ui.reduceMotion?.() === true,
  });

  /* ---------------- steps ---------------- */
  // Each step past the warning is an overlay too (js/overlays.js): Android Back presses that step's
  // own Back button. On the warning, Back is the sheet's Cancel. Nothing is imported either way.
  const STEP_BACK = { prompt: '#ai-prompt-back', review: '#ai-review-back' };
  const show = (name) => {
    view = name;
    for (const v of $$('[data-ai-view]', dlg)) v.hidden = v.dataset.aiView !== name;
    if (STEP_BACK[name]) {
      ui.overlays?.open('ai-step', {
        close: () => { if (!busy) $(STEP_BACK[name], dlg).click(); },
        isOpen: () => dlg.open && view === name,
      });
    } else ui.overlays?.remove('ai-step');
    if (name === 'warning') {
      renderBackup();
      slider.reset(); // shown every time: confirmed again, after the lock
      continueBtn.disabled = true;
      requestAnimationFrame(() => slider.layout());
    }
    $('.sheet-body', $(`[data-ai-view="${name}"]`, dlg))?.scrollTo?.(0, 0);
  };

  const close = () => { if (!busy) ui.closeDialog(dlg); };

  function open() {
    rawRows = [];
    rows = [];
    chosen = new Map();
    payAll = PAY_NOT_SET;
    payChosen = new Map();
    backupSaved = false;
    replyInput.value = '';
    setReplyProblem('');
    $('#ai-prompt-fallback').hidden = true;
    $('#ai-prompt-details').open = false;
    ui.openDialog(dlg, { back: close });
    show('warning');
  }

  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('close', () => {
    // The close event comes after the dialog has closed; if it was opened again in between, this
    // event belongs to the earlier visit and must not stop the new lock or clear the new reply.
    if (dlg.open) return;
    ui.overlays?.remove('ai-step');
    slider.stop();
    document.body.classList.remove('sheet-open');
    rawRows = [];
    rows = [];
    replyInput.value = ''; // the pasted reply leaves the page with the sheet
    list.innerHTML = '';
  });
  $('#btn-import-ai').addEventListener('click', open);
  $('[data-ai-close]', dlg).addEventListener('click', close);
  $('#ai-warning-cancel').addEventListener('click', close);
  continueBtn.addEventListener('click', () => { if (slider.confirmed) show('prompt'); });
  $('#ai-prompt-back').addEventListener('click', () => show('warning'));
  $('#ai-review-back').addEventListener('click', () => { if (!busy) show('prompt'); });

  /* ---------------- optional backup ---------------- */
  function renderBackup() {
    const count = ui.items().length;
    for (const b of backupBtns) b.textContent = backupLabel(count, backupSaved);
    $('#ai-backup-hint').textContent = count ? t('ai.backup.hint', { items: items(count) }) : t('ai.backup.hintEmpty');
  }
  const runBackup = async () => {
    const ok = (await ui.exportData()) === true;
    if (ok) backupSaved = true;
    renderBackup();
    return ok;
  };
  for (const b of backupBtns) b.addEventListener('click', runBackup);

  /* ---------------- prompt and reply ---------------- */
  $('#ai-copy-prompt').addEventListener('click', async () => {
    const ok = await copyText(AI_IMPORT_PROMPT, null);
    if (ok) { ui.toast(t('ai.toast.promptCopied')); return; }
    // Clipboard blocked: show the prompt, selected, to copy by hand.
    $('#ai-prompt-details').open = true;
    $('#ai-prompt-fallback').hidden = false;
    promptText.focus();
    promptText.select();
  });

  function setReplyProblem(message) {
    replyProblems.innerHTML = message ? `<li>${esc(message)}</li>` : '';
    replyErrorBox.hidden = !message;
    replyErrorText.hidden = true;
    if (message) replyInput.setAttribute('aria-invalid', 'true'); else replyInput.removeAttribute('aria-invalid');
    replyErrorBox.dataset.report = message ? errorReport(message) : '';
  }
  $('#ai-reply-copy-error').addEventListener('click', async () => {
    if (await copyText(replyErrorBox.dataset.report, replyErrorText)) ui.toast(t('ai.toast.errorCopied'));
  });
  replyInput.addEventListener('input', () => { if (!replyErrorBox.hidden) setReplyProblem(''); });

  function readReply(text) {
    try {
      rawRows = parseAiImport(text);
    } catch (err) {
      if (!(err instanceof AiImportError)) console.error(err);
      setReplyProblem(err instanceof AiImportError ? err.message : t('ai.reply.unreadable'));
      replyInput.focus();
      return;
    }
    setReplyProblem('');
    chosen = new Map();
    payAll = PAY_NOT_SET;
    payChosen = new Map();
    refreshReview();
    show('review');
  }
  $('#ai-review').addEventListener('click', () => readReply(replyInput.value));
  $('#ai-pick-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_AI_CHARS * 4) { setReplyProblem(t('ai.reply.fileTooLarge')); return; }
    try {
      const text = await file.text();
      replyInput.value = text;
      readReply(text);
    } catch (err) {
      console.error(err);
      setReplyProblem(t('import.error.unreadable'));
    }
  });

  /* ---------------- review ---------------- */
  function refreshReview() {
    rows = reviewRows(rawRows, ui.items());
    // Not set, Cash, then the household's live cards (never "Add new card…" here).
    payOptions = [
      { value: PAY_NOT_SET, label: t('form.pay.notSet') },
      { value: PAY_CASH, label: t('form.pay.cash') },
      ...(ui.cards?.() ?? []).map((c) => ({ value: c.id, label: c.name })),
    ];
    if (!livePay().has(payAll)) payAll = PAY_NOT_SET;
    for (const r of rows) if (r.importable && chosen.has(r.n)) r.include = chosen.get(r.n);
    renderReview();
  }

  const selectedItems = () => rows.filter((r) => r.include && r.importable).map((r) => itemFromFields(r.fields, '', () => 'preview'));

  function dateText(f) {
    if (!f.nextDate) return '';
    const date = shortDate(parseDate(f.nextDate));
    return f.cycle === 'once' ? t('ai.row.when.once', { date }) : f.type === 'income' ? t('ai.row.when.payment', { date }) : t('ai.row.when.renewal', { date });
  }

  function rowHTML(r) {
    const f = r.fields;
    const name = f.name ?? (typeof r.raw?.name === 'string' && r.raw.name.trim() ? r.raw.name.trim().slice(0, 80) : t('ai.row.unnamed', { n: r.n }));
    const amount = f.amount !== null && f.currency ? `${money(f.amount, f.currency)}${f.cycle ? ` ${cycleLabel(f.cycle)}` : ''}` : '';
    const meta = [
      f.type === 'income' ? t('ai.row.income') : f.type === 'expense' ? t('ai.row.expense') : '',
      f.cycle === 'once' ? t('ai.cycle.once') : f.cycle === 'annual' ? t('ai.cycle.annual') : f.cycle === 'monthly' ? t('ai.cycle.monthly')
        : f.cycleText ? t('ai.row.cycleAsGiven', { cycle: f.cycleText }) : '',
      dateText(f), f.category,
    ].filter(Boolean).map(esc).join(' · ');
    const problems = r.problems.filter((p) => p.code !== PROBLEM.duplicate || r.status === PROBLEM.duplicate);
    const codes = new Set(r.problems.map((p) => p.code));
    const fixDate = codes.has(PROBLEM.date) && !codes.has(PROBLEM.error)
      ? `<label class="field ai-fix"><span class="field-label">${esc(f.cycle === 'once' ? t('ai.fix.date.once') : f.type === 'income' ? t('ai.fix.date.payment') : t('ai.fix.date.renewal'))}</span>
          <input type="date" class="input" data-fix-date="${r.n}" aria-label="${esc(t('ai.fix.date.label', { n: r.n }))}"></label>` : '';
    const fixCycle = codes.has(PROBLEM.cycle) && !codes.has(PROBLEM.error)
      ? `<label class="field ai-fix"><span class="field-label">${esc(t('ai.fix.cycle'))}</span>
          <select class="input" data-fix-cycle="${r.n}" aria-label="${esc(t('ai.fix.cycle.label', { n: r.n }))}">
            <option value="">${esc(t('ai.fix.choose'))}</option><option value="monthly">${esc(t('ai.cycle.monthly'))}</option><option value="annual">${esc(t('ai.cycle.annual'))}</option><option value="one-off">${esc(t('ai.cycle.once'))}</option>
          </select></label>` : '';
    // Paid with, for an expense row that can be imported: the choice for every row unless this
    // row has its own.
    const pay = r.importable && f.type === 'expense'
      ? `<label class="field ai-fix ai-pay-row"><span class="field-label">${esc(t('ai.pay'))}</span>
          <select class="input" data-pay="${r.n}" aria-label="${esc(t('ai.pay.row', { n: r.n }))}">${payOptionsHTML(payChosen.has(r.n) ? payChosen.get(r.n) : payAll)}</select></label>` : '';
    return `<li class="ai-row${r.importable ? '' : ' is-blocked'}" data-row="${r.n}">
      <label class="ai-row-main">
        <input type="checkbox" class="check" data-include="${r.n}" ${r.include ? 'checked' : ''} ${r.importable ? '' : 'disabled'}
          aria-label="${esc(t('ai.row.include', { n: r.n, name }))}">
        <span class="ai-row-body">
          <span class="ai-row-name"><span class="ai-row-n">${r.n}.</span> ${esc(name)}</span>
          ${meta ? `<span class="ai-row-meta">${meta}</span>` : ''}
          ${f.notes ? `<span class="ai-row-note"><span class="sr-only">${esc(t('ai.row.notes.label'))} </span>${esc(f.notes)}</span>` : ''}
        </span>
        <span class="ai-row-amount">${esc(amount)}</span>
      </label>
      ${r.status !== 'ok' ? `<div class="ai-row-tags">${STATUS_TAG[r.status]()}</div>` : ''}
      ${problems.length ? `<ul class="ai-row-problems">${problems.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul>` : ''}
      ${fixDate || fixCycle || pay ? `<div class="ai-fixes">${fixCycle}${fixDate}${pay}</div>` : ''}
    </li>`;
  }

  function renderTotals(selected) {
    const el = $('#ai-totals');
    if (!selected.length) { el.innerHTML = `<p class="sync-text">${esc(t('ai.totals.none'))}</p>`; return; }
    // Cash basis, as everywhere in the app: each group as it is paid, never an average.
    const every = (k, amounts) => (k === 'monthly' ? t('ai.totals.eachMonth', { amounts }) : k === 'annual' ? t('ai.totals.eachYear', { amounts }) : amounts);
    const lines = totalsOf(selected).map((tot) => {
      const groups = ['monthly', 'annual', 'once'].filter((k) => tot[k].count).map((k) => {
        const g = tot[k];
        const amounts = [g.out || !g.in ? t('ai.totals.out', { amount: money(g.out, tot.currency) }) : '', g.in ? t('ai.totals.in', { amount: money(g.in, tot.currency) }) : '']
          .filter(Boolean).join(t('common.listSep'));
        return `<li><span class="ai-total-label">${esc(t('ai.totals.label', { label: TOTAL_LABELS[k], count: g.count }))}</span> ${esc(every(k, amounts))}</li>`;
      }).join('');
      return `<li><span class="ai-total-cur">${esc(tot.currency)}</span><ul class="ai-totals-groups">${groups}</ul></li>`;
    }).join('');
    el.innerHTML = `<ul class="ai-totals-list">${lines}</ul>`;
  }

  /** "6 rows · 2 selected · 1 needs a date …." for the review, from the rows as they are now. */
  function summaryText(selected) {
    const count = (s) => rows.filter((r) => r.status === s).length;
    const parts = [t('ai.summary.rows', { count: rows.length }), t('ai.summary.selected', { count: selected })];
    if (count(PROBLEM.date)) parts.push(t('ai.summary.needDate', { count: count(PROBLEM.date) }));
    if (count(PROBLEM.cycle)) parts.push(t('ai.summary.cycle', { count: count(PROBLEM.cycle) }));
    if (count(PROBLEM.duplicate)) parts.push(t('ai.summary.duplicates', { count: count(PROBLEM.duplicate) }));
    // Any row with a shortened note, whatever else its status says.
    const shortened = rows.filter((r) => r.problems.some((p) => p.code === PROBLEM.note)).length;
    if (shortened) parts.push(t('ai.summary.notes', { count: shortened }));
    if (count(PROBLEM.error)) parts.push(t('ai.summary.blocked', { count: count(PROBLEM.error) }));
    return t('ai.summary', { parts: parts.join(' · ') });
  }
  const importLabel = (n) => (n ? t('ai.import.count', { items: items(n) }) : t('ai.import'));

  function renderReview() {
    const selected = selectedItems();
    $('#ai-review-summary').textContent = summaryText(selected.length);
    payAllSelect.innerHTML = payOptionsHTML(payAll);
    payAllSelect.value = payAll;
    $('#ai-pay-field').hidden = !rows.some((r) => r.importable && r.fields.type === 'expense');
    list.innerHTML = rows.map(rowHTML).join('');
    renderTotals(selected);
    const report = errorReport(rows);
    reviewErrorBox.hidden = !report;
    reviewErrorBox.dataset.report = report;
    reviewErrorText.hidden = true;
    importBtn.disabled = !selected.length;
    importBtn.textContent = importLabel(selected.length);
  }

  // The choice for every row: rows without their own pick follow it.
  payAllSelect.addEventListener('change', () => {
    payAll = payAllSelect.value;
    for (const s of $$('[data-pay]', list)) if (!payChosen.has(Number(s.dataset.pay))) s.value = payAll;
  });

  list.addEventListener('change', (e) => {
    const field = e.target;
    // A row's own Paid with, before the fixes below (which would end here on a value they don't know).
    if (field.matches('[data-pay]')) {
      payChosen.set(Number(field.dataset.pay), field.value);
      return;
    }
    if (field.matches('[data-include]')) {
      const n = Number(field.dataset.include);
      chosen.set(n, field.checked);
      const r = rows.find((x) => x.n === n);
      if (r) r.include = field.checked && r.importable;
      const selected = selectedItems();
      renderTotals(selected);
      importBtn.disabled = !selected.length;
      importBtn.textContent = importLabel(selected.length);
      $('#ai-review-summary').textContent = summaryText(selected.length);
      return;
    }
    const n = Number(field.dataset.fixDate || field.dataset.fixCycle);
    if (!n || !field.value) return;
    const key = field.dataset.fixDate ? 'nextDate' : 'cycle';
    rawRows[n - 1] = { ...rawRows[n - 1], [key]: field.value };
    refreshReview();
    // Focus stays with the row that was fixed: its next fix, or its checkbox.
    const li = $(`[data-row="${n}"]`, list);
    ($('[data-fix-cycle], [data-fix-date]', li) ?? $('[data-include]', li))?.focus();
  });

  $('#ai-review-copy-error').addEventListener('click', async () => {
    if (await copyText(reviewErrorBox.dataset.report, reviewErrorText)) ui.toast(t('ai.toast.errorCopied'));
  });

  /* ---------------- import ---------------- */
  importBtn.addEventListener('click', async () => {
    if (busy) return;
    let backup;
    let preview;
    try {
      const live = livePay();
      backup = backupFromRows(rows, { payOf: (n) => rowPay(n, { all: payAll, perRow: payChosen, live }) });
      preview = await storage.previewImport(backup);
    } catch (err) {
      console.error(err);
      ui.toast(err instanceof AiImportError ? err.message : t('ai.toast.prepareFailed'));
      return;
    }
    const synced = await ui.isSynced();
    // The usual choice: Merge or Replace all, and Replace asks once more. Cancel or Back at either
    // step imports nothing. The optional backup sits beside Replace all.
    const mode = await chooseImportMode(preview, {
      synced, confirm: ui.confirmDialog, title: aiChoiceTitle(),
      message: aiImportMessage(preview.merge, { synced }), replace: aiReplaceConfirm({ synced }),
      backup: runBackup, count: ui.items().length,
    });
    if (!mode || !dlg.open) return;
    busy = true;
    importBtn.disabled = true;
    try {
      const done = await storage.importAll(backup, mode);
      busy = false;
      ui.closeDialog(dlg);
      await ui.reloadData();
      ui.toast(mode === 'replace' ? t('import.toast.replaced', { items: items(done.total) }) : t('ai.toast.added', { items: items(done.added) }));
      storage.requestPersistence?.();
    } catch (err) {
      console.error(err);
      ui.toast(t('import.toast.failed'));
    } finally {
      busy = false;
      importBtn.disabled = !selectedItems().length;
    }
  });

  return { open };
}
