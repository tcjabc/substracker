// Decisions and wording for starting, joining and leaving a household, with no DOM, so Node tests
// cover them. js/sync-sheet.js draws the screens and passes in the dialogs.

import { t } from './i18n.js';

export const JOIN_REPLACE = 'replace';
export const JOIN_MERGE = 'merge';

/**
 * Which screen the Sync sheet opens on, from the key-free summary (js/secure-key.js status()):
 * 'active' when this device is in a household and can read its key, else 'setup' (which offers
 * Join again when the key can't be read on this device).
 */
export function sheetView(info) {
  return info?.paired && !info.keyUnavailable ? 'active' : 'setup';
}

/**
 * How a device joins. An empty device just joins (the household's data, nothing to lose). One with
 * items asks first: `ask(localItems)` resolves 'replace', 'merge', 'export' (save a backup, then ask
 * again) or null (cancel). Replace needs one more yes from `confirm`, since this device's items go.
 * Resolves 'replace', 'merge' or null.
 */
export async function chooseJoinMode({ localItems, ask, confirm, exportBackup }) {
  if (!localItems) return JOIN_REPLACE;
  for (;;) {
    const choice = await ask(localItems);
    if (choice === 'export') { await exportBackup(); continue; }
    if (choice === JOIN_MERGE) return JOIN_MERGE;
    if (choice !== JOIN_REPLACE) return null;
    return (await confirm(replaceConfirm(localItems))) === true ? JOIN_REPLACE : null;
  }
}

export function replaceConfirm(localItems) {
  return {
    title: t('sync.replace.title'),
    message: t('sync.replace.message', { count: localItems }),
    actions: [{ label: t('common.cancel'), value: false }, { label: t('sync.replace.confirm'), value: true, kind: 'danger' }],
  };
}

/**
 * Before starting a new household: a device that was in one before warns that its other devices
 * stay there. Resolves true to go ahead.
 */
export async function confirmStart(config, confirm) {
  if (!config?.wasPaired) return true;
  return (await confirm({
    title: t('sync.startNew.title'),
    message: t('sync.startNew.message'),
    actions: [{ label: t('common.cancel'), value: false }, { label: t('sync.startNew.confirm'), value: true, kind: 'primary' }],
  })) === true;
}

// The two confirmations' wording is read when they're shown (getters), in the language in use then.
export const TURN_OFF_CONFIRM = Object.freeze({
  get title() { return t('sync.turnOff.title'); },
  get message() { return t('sync.turnOff.message'); },
  get actions() { return [{ label: t('common.cancel'), value: false }, { label: t('sync.turnOff.confirm'), value: true, kind: 'danger' }]; },
});

export const SHOW_WORDS_CONFIRM = Object.freeze({
  get title() { return t('sync.showWords.title'); },
  get message() { return t('sync.showWords.message'); },
  get actions() { return [{ label: t('common.cancel'), value: false }, { label: t('sync.showWords.confirm'), value: true, kind: 'primary' }]; },
});

const STATE_KEYS = { off: 'sync.state.off', syncing: 'sync.state.syncing', ok: 'sync.state.ok', offline: 'sync.state.offline', error: 'sync.state.error' };
const stateText = (state) => t(STATE_KEYS[state] ?? 'sync.state.off');

/** The status line for a status from the engine: "Up to date", "Offline", "Error: …". */
export function statusText(status) {
  const text = stateText(status?.state);
  if (status?.state === 'error' && status.lastError) return t('sync.status.withError', { state: text, error: status.lastError });
  if (status?.state === 'ok' && status.lastError) return t('sync.status.withNote', { state: text, note: status.lastError });
  return text;
}

/** The hint under "Sync between devices" in Settings. */
export function summaryText(info, status) {
  if (info?.paired && info.keyUnavailable) return t('sync.summary.needsWords');
  if (!info?.paired) return t('sync.summary.off');
  if (!info.enabled) return t('sync.summary.paused');
  return t('sync.summary.on', { state: stateText(status?.state) });
}
