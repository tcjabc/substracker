// The "Import with AI" sheet in Settings: a warning to read and confirm, the prompt to copy and
// the reply to paste or pick, a review of every row, then the usual Merge / Replace all choice.
// The app never sends anything anywhere: the person copies the prompt into an AI chat of their
// own choosing and brings the reply back. Nothing is written until they confirm the import.
// The rules live in js/import-ai.js; the slider in js/slide-confirm.js.

import { esc, money, cycleLabel, parseDate, shortDate, chooseImportMode, backupLabel } from './util.js';
import {
  AiImportError, parseAiImport, reviewRows, backupFromRows, itemFromFields, totalsOf, errorReport,
  aiImportMessage, aiReplaceConfirm, AI_CHOICE_TITLE, MAX_AI_CHARS, PROBLEM,
} from './import-ai.js';
import { AI_IMPORT_PROMPT } from './import-ai-prompt.js';
import { createSlideConfirm } from './slide-confirm.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const STATUS_TAG = {
  [PROBLEM.error]: '<span class="tag tag-danger">Can’t import</span>',
  [PROBLEM.cycle]: '<span class="tag tag-warn">Unsupported cycle</span>',
  [PROBLEM.date]: '<span class="tag tag-warn">Needs a date</span>',
  [PROBLEM.duplicate]: '<span class="tag">Duplicate, skipped</span>',
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
 * when a backup was delivered), items() (the live items), isSynced() and reloadData().
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
  let busy = false;
  let backupSaved = false;
  let view = '';

  promptText.value = AI_IMPORT_PROMPT;
  // Enter in a field (the date fixes) must not submit the sheet's form, which would close it.
  $('#ai-form').addEventListener('submit', (e) => e.preventDefault());

  const slider = createSlideConfirm($('#ai-slide'), {
    onChange: (on) => { continueBtn.disabled = !on; },
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
    $('#ai-backup-hint').textContent = count
      ? `Optional. Saves your ${plural(count, 'item')} as a file you can import again.`
      : 'Optional. You have no items yet, so there is nothing to lose.';
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
    if (ok) { ui.toast('Prompt copied'); return; }
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
    if (await copyText(replyErrorBox.dataset.report, replyErrorText)) ui.toast('Error copied');
  });
  replyInput.addEventListener('input', () => { if (!replyErrorBox.hidden) setReplyProblem(''); });

  function readReply(text) {
    try {
      rawRows = parseAiImport(text);
    } catch (err) {
      if (!(err instanceof AiImportError)) console.error(err);
      setReplyProblem(err instanceof AiImportError ? err.message : "That couldn't be read.");
      replyInput.focus();
      return;
    }
    setReplyProblem('');
    chosen = new Map();
    refreshReview();
    show('review');
  }
  $('#ai-review').addEventListener('click', () => readReply(replyInput.value));
  $('#ai-pick-file').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (file.size > MAX_AI_CHARS * 4) { setReplyProblem('That file is too large to import.'); return; }
    try {
      const text = await file.text();
      replyInput.value = text;
      readReply(text);
    } catch (err) {
      console.error(err);
      setReplyProblem("The file couldn't be read.");
    }
  });

  /* ---------------- review ---------------- */
  function refreshReview() {
    rows = reviewRows(rawRows, ui.items());
    for (const r of rows) if (r.importable && chosen.has(r.n)) r.include = chosen.get(r.n);
    renderReview();
  }

  const selectedItems = () => rows.filter((r) => r.include && r.importable).map((r) => itemFromFields(r.fields, '', () => 'preview'));

  function dateText(f) {
    if (!f.nextDate) return '';
    const word = f.cycle === 'once' ? 'Date' : f.type === 'income' ? 'Next payment' : 'Next renewal';
    return `${word} ${shortDate(parseDate(f.nextDate))}`;
  }

  function rowHTML(r) {
    const f = r.fields;
    const name = f.name ?? (typeof r.raw?.name === 'string' && r.raw.name.trim() ? r.raw.name.trim().slice(0, 80) : `Row ${r.n}`);
    const amount = f.amount !== null && f.currency ? `${money(f.amount, f.currency)}${f.cycle ? ` ${cycleLabel(f.cycle)}` : ''}` : '';
    const meta = [
      f.type === 'income' ? 'Income' : f.type === 'expense' ? 'Expense' : '',
      f.cycle === 'once' ? 'One-off' : f.cycle === 'annual' ? 'Annual' : f.cycle === 'monthly' ? 'Monthly' : f.cycleText ? `“${f.cycleText}”` : '',
      dateText(f), f.category,
    ].filter(Boolean).map(esc).join(' · ');
    const problems = r.problems.filter((p) => p.code !== PROBLEM.duplicate || r.status === PROBLEM.duplicate);
    const codes = new Set(r.problems.map((p) => p.code));
    const fixDate = codes.has(PROBLEM.date) && !codes.has(PROBLEM.error)
      ? `<label class="field ai-fix"><span class="field-label">${f.cycle === 'once' ? 'Date' : f.type === 'income' ? 'Next payment date' : 'Next renewal date'}</span>
          <input type="date" class="input" data-fix-date="${r.n}" aria-label="Date for row ${r.n}"></label>` : '';
    const fixCycle = codes.has(PROBLEM.cycle) && !codes.has(PROBLEM.error)
      ? `<label class="field ai-fix"><span class="field-label">Cycle</span>
          <select class="input" data-fix-cycle="${r.n}" aria-label="Cycle for row ${r.n}">
            <option value="">Choose…</option><option value="monthly">Monthly</option><option value="annual">Annual</option><option value="one-off">One-off</option>
          </select></label>` : '';
    return `<li class="ai-row${r.importable ? '' : ' is-blocked'}" data-row="${r.n}">
      <label class="ai-row-main">
        <input type="checkbox" class="check" data-include="${r.n}" ${r.include ? 'checked' : ''} ${r.importable ? '' : 'disabled'}
          aria-label="Import row ${r.n}: ${esc(name)}">
        <span class="ai-row-body">
          <span class="ai-row-name"><span class="ai-row-n">${r.n}.</span> ${esc(name)}</span>
          ${meta ? `<span class="ai-row-meta">${meta}</span>` : ''}
        </span>
        <span class="ai-row-amount">${esc(amount)}</span>
      </label>
      ${r.status !== 'ok' ? `<div class="ai-row-tags">${STATUS_TAG[r.status]}</div>` : ''}
      ${problems.length ? `<ul class="ai-row-problems">${problems.map((p) => `<li>${esc(p.message)}</li>`).join('')}</ul>` : ''}
      ${fixDate || fixCycle ? `<div class="ai-fixes">${fixCycle}${fixDate}</div>` : ''}
    </li>`;
  }

  function renderTotals(items) {
    const el = $('#ai-totals');
    if (!items.length) { el.innerHTML = '<p class="sync-text">No rows selected.</p>'; return; }
    const lines = totalsOf(items).map((t) => {
      const parts = [
        t.expenseMonthly ? `${money(t.expenseMonthly, t.currency)} / mo out` : '',
        t.incomeMonthly ? `${money(t.incomeMonthly, t.currency)} / mo in` : '',
        t.onceExpense ? `${money(t.onceExpense, t.currency)} one-off out` : '',
        t.onceIncome ? `${money(t.onceIncome, t.currency)} one-off in` : '',
      ].filter(Boolean);
      return `<li><span class="ai-total-cur">${esc(t.currency)}</span> ${esc(parts.join(' · ') || money(0, t.currency))}</li>`;
    }).join('');
    el.innerHTML = `<ul class="ai-totals-list">${lines}</ul>`;
  }

  function renderReview() {
    const count = (s) => rows.filter((r) => r.status === s).length;
    const items = selectedItems();
    const parts = [`${plural(rows.length, 'row')}`, `${items.length} selected`];
    if (count(PROBLEM.date)) parts.push(`${count(PROBLEM.date)} need${count(PROBLEM.date) === 1 ? 's' : ''} a date`);
    if (count(PROBLEM.cycle)) parts.push(`${count(PROBLEM.cycle)} with an unsupported cycle`);
    if (count(PROBLEM.duplicate)) parts.push(`${count(PROBLEM.duplicate)} duplicate${count(PROBLEM.duplicate) === 1 ? '' : 's'} skipped`);
    if (count(PROBLEM.error)) parts.push(`${count(PROBLEM.error)} can’t be imported`);
    $('#ai-review-summary').textContent = `${parts.join(' · ')}.`;
    list.innerHTML = rows.map(rowHTML).join('');
    renderTotals(items);
    const report = errorReport(rows);
    reviewErrorBox.hidden = !report;
    reviewErrorBox.dataset.report = report;
    reviewErrorText.hidden = true;
    importBtn.disabled = !items.length;
    importBtn.textContent = items.length ? `Import ${plural(items.length, 'item')}` : 'Import';
  }

  list.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-include]')) {
      const n = Number(t.dataset.include);
      chosen.set(n, t.checked);
      const r = rows.find((x) => x.n === n);
      if (r) r.include = t.checked && r.importable;
      const items = selectedItems();
      renderTotals(items);
      importBtn.disabled = !items.length;
      importBtn.textContent = items.length ? `Import ${plural(items.length, 'item')}` : 'Import';
      $('#ai-review-summary').textContent = $('#ai-review-summary').textContent.replace(/\d+ selected/, `${items.length} selected`);
      return;
    }
    const n = Number(t.dataset.fixDate || t.dataset.fixCycle);
    if (!n || !t.value) return;
    const key = t.dataset.fixDate ? 'nextDate' : 'cycle';
    rawRows[n - 1] = { ...rawRows[n - 1], [key]: t.value };
    refreshReview();
    // Focus stays with the row that was fixed: its next fix, or its checkbox.
    const li = $(`[data-row="${n}"]`, list);
    ($('[data-fix-cycle], [data-fix-date]', li) ?? $('[data-include]', li))?.focus();
  });

  $('#ai-review-copy-error').addEventListener('click', async () => {
    if (await copyText(reviewErrorBox.dataset.report, reviewErrorText)) ui.toast('Error copied');
  });

  /* ---------------- import ---------------- */
  importBtn.addEventListener('click', async () => {
    if (busy) return;
    let backup;
    let preview;
    try {
      backup = backupFromRows(rows);
      preview = await storage.previewImport(backup);
    } catch (err) {
      console.error(err);
      ui.toast(err instanceof AiImportError ? err.message : "These rows couldn't be prepared. Nothing was changed.");
      return;
    }
    const synced = await ui.isSynced();
    // The usual choice: Merge or Replace all, and Replace asks once more. Cancel or Back at either
    // step imports nothing. The optional backup sits beside Replace all.
    const mode = await chooseImportMode(preview, {
      synced, confirm: ui.confirmDialog, title: AI_CHOICE_TITLE,
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
      ui.toast(mode === 'replace' ? `Replaced with ${plural(done.total, 'item')}` : `Added ${plural(done.added, 'item')}`);
      storage.requestPersistence?.();
    } catch (err) {
      console.error(err);
      ui.toast('Import failed. Nothing was changed.');
    } finally {
      busy = false;
      importBtn.disabled = !selectedItems().length;
    }
  });

  return { open };
}
