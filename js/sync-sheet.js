// The Sync sheet in Settings: start a household (with the required recovery-words step), join one
// with the 12 words, and, once set up, status, Sync now, Show recovery words and Turn off.
// The decisions live in js/pairing.js; the work in the engine (js/sync.js). The words are only
// in the page while they're on screen: closing the sheet or hiding them removes them.

import qrcode from './qrcode.js';
import { generateKey } from './crypto.js';
import { keyToWords, parseRecovery, wordProblems, WordsError } from './words.js';
import * as pairing from './pairing.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** An SVG QR code of `text` (dark modules in currentColor, a 4-module quiet zone). */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
}

function when(ms) {
  if (!ms) return 'Never';
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * `engine` is the sync engine, or null when sync can't run here (`unavailable` says why).
 * `ui` provides toast, confirmDialog, openDialog, closeDialog, exportData and onConfigChanged
 * (called after this sheet changes the sync config, e.g. to refresh the developer screen).
 */
export function initSyncSheet({ engine, storage, vault, ui, unavailable = '' }) {
  const dlg = $('#sync-dialog');
  const summary = $('#sync-summary');
  const openBtn = $('#btn-sync');
  const busyLine = $('#sync-busy');
  const joinInput = $('#sync-join-words');
  const problemsList = $('#sync-join-problems');
  const startError = $('#sync-start-error');
  const saved = $('#sync-saved');
  const startDone = $('#sync-start-done');
  let config = null;
  let status = engine?.getStatus() ?? { state: 'off' };
  let pendingKey = ''; // a new household's key, between "Start sync" and "I've saved these words"
  let busy = false;
  let choiceResolve = null;
  let joinTried = false;

  if (!engine) {
    summary.textContent = unavailable || 'Sync is not available on this device.';
    openBtn.disabled = true;
    return { refresh() {} };
  }

  /* ---------------- helpers ---------------- */
  // A summary without the key (js/secure-key.js status()); the key itself is only read for Show recovery words.
  const loadConfig = async () => { config = await vault.status(); return config; };

  const renderSummary = () => {
    summary.textContent = pairing.summaryText(config, status);
    openBtn.textContent = config?.paired && !config.keyUnavailable ? 'Manage' : 'Set up';
    $('#sync-needs-words').hidden = !(config?.paired && config.keyUnavailable);
  };

  const renderStatus = () => {
    $('#sync-status').textContent = pairing.statusText(status);
    $('#sync-last').textContent = when(status.lastSyncedAt);
    $('#sync-pending').textContent = String(status.pendingCount ?? 0);
  };

  const show = (name) => {
    for (const v of $$('[data-sync-view]', dlg)) v.hidden = v.dataset.syncView !== name;
  };

  const setBusy = (text) => {
    busy = Boolean(text);
    busyLine.hidden = !busy;
    busyLine.textContent = text || '';
    for (const el of $$('button, textarea, input', dlg)) {
      if (busy) { el.dataset.wasDisabled = String(el.disabled); el.disabled = true; } else if ('wasDisabled' in el.dataset) {
        el.disabled = el.dataset.wasDisabled === 'true';
        delete el.dataset.wasDisabled;
      }
    }
  };

  /** Draw the words (numbered), a Copy button and the QR code into a [data-words-slot]. */
  const renderWords = (slot, words) => {
    slot.replaceChildren($('#sync-words-template').content.cloneNode(true));
    const list = $('.word-grid', slot);
    for (const w of words) {
      const li = document.createElement('li');
      li.textContent = w;
      list.append(li);
    }
    $('.qr', slot).innerHTML = qrSvg(words.join(' '));
    $('[data-copy-words]', slot).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(words.join(' '));
        ui.toast('Copied the 12 words. Paste them somewhere safe.');
      } catch {
        ui.toast("Couldn't copy. Write the words down instead.");
      }
    });
    slot.hidden = false;
  };

  /** Remove every trace of the words from the page. */
  const clearWords = () => {
    for (const slot of $$('[data-words-slot]', dlg)) slot.replaceChildren();
    $('#sync-show-words').hidden = false;
    $('#sync-hide-words').hidden = true;
    $('[data-sync-view="active"] [data-words-slot]').hidden = true;
    pendingKey = '';
  };

  const setProblems = (messages) => {
    problemsList.replaceChildren(...messages.map((m) => Object.assign(document.createElement('li'), { textContent: m })));
    joinInput.setAttribute('aria-invalid', String(messages.length > 0));
  };

  const changed = async () => {
    await loadConfig();
    renderSummary();
    try { ui.onConfigChanged?.(); } catch (err) { console.error(err); }
  };

  /* ---------------- open / close ---------------- */
  async function open() {
    await loadConfig();
    clearWords();
    status = engine.getStatus();
    renderStatus();
    renderSummary();
    show(pairing.sheetView(config));
    ui.openDialog(dlg);
  }

  const close = () => { if (!busy) ui.closeDialog(dlg); };

  openBtn.addEventListener('click', () => open().catch((err) => { console.error(err); ui.toast('Sync settings could not be opened.'); }));
  $$('[data-sync-close]', dlg).forEach((b) => b.addEventListener('click', close));
  dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  dlg.addEventListener('close', () => {
    document.body.classList.remove('sheet-open');
    choiceResolve?.(null);
    clearWords();
    joinInput.value = '';
    joinTried = false;
    setProblems([]);
    startError.textContent = '';
  });
  $$('[data-sync-back]', dlg).forEach((b) => b.addEventListener('click', () => {
    clearWords();
    show(pairing.sheetView(config));
  }));

  /* ---------------- start a household ---------------- */
  $('#sync-start').addEventListener('click', async () => {
    if (!(await pairing.confirmStart(config, ui.confirmDialog))) return;
    pendingKey = generateKey();
    renderWords($('[data-sync-view="recovery"] [data-words-slot]'), await keyToWords(pendingKey));
    saved.checked = false;
    startDone.disabled = true;
    startError.textContent = '';
    show('recovery');
    $('[data-sync-view="recovery"] .sheet-body').scrollTop = 0;
  });

  saved.addEventListener('change', () => { startDone.disabled = !saved.checked; });

  startDone.addEventListener('click', async () => {
    if (!saved.checked || !pendingKey) return;
    startError.textContent = '';
    setBusy('Starting sync…');
    try {
      await engine.startHousehold(pendingKey);
    } catch (err) {
      setBusy('');
      startError.textContent = err.message;
      return;
    }
    setBusy('');
    clearWords();
    await changed();
    show('active');
    ui.toast('Sync is on. Add another device with the 12 words.');
  });

  /* ---------------- join a household ---------------- */
  $('#sync-join-open').addEventListener('click', () => {
    setProblems([]);
    joinTried = false;
    show('join');
    joinInput.focus();
  });

  // Messages appear once someone has tried to join, then follow their typing.
  joinInput.addEventListener('input', () => { if (joinTried) setProblems(wordProblems(joinInput.value).map((p) => p.message)); });

  /** Show the choice for a device with items; resolves 'replace', 'merge', 'export' or null. */
  function askChoice(localItems) {
    $('#sync-choice-lead').textContent = `This device already has ${localItems} item${localItems === 1 ? '' : 's'}. How should it join the household?`;
    $('input[name="join-mode"][value="replace"]', dlg).checked = true;
    show('choice');
    return new Promise((resolve) => {
      choiceResolve = (v) => { choiceResolve = null; resolve(v); };
    });
  }
  $('#sync-choice-go').addEventListener('click', () => choiceResolve?.($('input[name="join-mode"]:checked', dlg)?.value ?? null));
  $('#sync-choice-cancel').addEventListener('click', () => choiceResolve?.(null));
  $('#sync-choice-export').addEventListener('click', () => choiceResolve?.('export'));

  $('#sync-join').addEventListener('click', async () => {
    joinTried = true;
    const typed = wordProblems(joinInput.value);
    if (typed.length) { setProblems(typed.map((p) => p.message)); joinInput.focus(); return; }
    let key;
    try {
      key = await parseRecovery(joinInput.value);
    } catch (err) {
      setProblems(err instanceof WordsError ? err.problems.map((p) => p.message) : [err.message]);
      return;
    }
    setProblems([]);
    setBusy('Looking for the household…');
    try {
      const { exists } = await engine.checkHousehold(key);
      if (!exists) { setBusy(''); setProblems(['No household found for these words. Check them and try again.']); return; }
    } catch (err) {
      setBusy('');
      setProblems([err.message]);
      return;
    }
    setBusy('');
    const localItems = await storage.liveItemCount();
    const mode = await pairing.chooseJoinMode({
      localItems,
      ask: askChoice,
      confirm: ui.confirmDialog,
      exportBackup: () => ui.exportData(),
    });
    if (!dlg.open) return; // closed while choosing
    if (!mode) { show('join'); return; }
    show('join');
    setBusy(mode === pairing.JOIN_REPLACE ? "Getting the household's data…" : 'Joining the household…');
    try {
      await engine.joinHousehold(key, mode);
    } catch (err) {
      setBusy('');
      setProblems([err.message]);
      return;
    }
    setBusy('');
    joinInput.value = '';
    joinTried = false;
    await changed();
    show('active');
    ui.toast(mode === pairing.JOIN_MERGE
      ? "Joined. This device's items are being added to the household."
      : "Joined. This device now has the household's data.");
  });

  /* ---------------- set up: status, words, sync now, turn off ---------------- */
  $('#sync-show-words').addEventListener('click', async () => {
    if ((await ui.confirmDialog(pairing.SHOW_WORDS_CONFIRM)) !== true) return;
    let key = '';
    try { key = await vault.get(); } catch { ui.toast('The recovery words are not available on this device.'); return; }
    if (!key) return;
    renderWords($('[data-sync-view="active"] [data-words-slot]'), await keyToWords(key));
    key = '';
    $('#sync-show-words').hidden = true;
    $('#sync-hide-words').hidden = false;
  });
  $('#sync-hide-words').addEventListener('click', clearWords);

  $('#sync-now').addEventListener('click', () => engine.syncNow());

  $('#sync-turn-off').addEventListener('click', async () => {
    if ((await ui.confirmDialog(pairing.TURN_OFF_CONFIRM)) !== true) return;
    clearWords();
    await engine.disconnect();
    await changed();
    show('setup');
    ui.toast('Sync is off on this device. Your items are still here.');
  });

  engine.onStatus((s) => {
    status = s;
    renderStatus();
    loadConfig().then(renderSummary).catch(() => {});
  });
  loadConfig().then(renderSummary).catch((err) => { console.error(err); summary.textContent = 'Sync settings could not be read.'; });

  return {
    /** Re-read the config (after the developer screen changed it). */
    refresh() { loadConfig().then(renderSummary).catch(() => {}); },
  };
}
