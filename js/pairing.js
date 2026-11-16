// Decisions and wording for starting, joining and leaving a household, with no DOM, so Node tests
// cover them. js/sync-sheet.js draws the screens and passes in the dialogs.

export const JOIN_REPLACE = 'replace';
export const JOIN_MERGE = 'merge';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
    title: "Replace this device's items?",
    message: `The ${plural(localItems, 'item')} on this device will be replaced by the household's. Items that are only on this device will be lost. This can't be undone.`,
    actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, kind: 'danger' }],
  };
}

/**
 * Before starting a new household: a device that was in one before warns that its other devices
 * stay there. Resolves true to go ahead.
 */
export async function confirmStart(config, confirm) {
  if (!config?.wasPaired) return true;
  return (await confirm({
    title: 'Start a new household?',
    message: "This device was synced with a household before. Your other devices stay on that household and won't see this one. To sync with them again, join with that household's 12 words instead.",
    actions: [{ label: 'Cancel', value: false }, { label: 'Start new', value: true, kind: 'primary' }],
  })) === true;
}

export const TURN_OFF_CONFIRM = Object.freeze({
  title: 'Turn off sync on this device?',
  message: 'This device stops syncing and forgets the recovery words. Your items stay here, and your other devices keep syncing. To sync again, join with the 12 words.',
  actions: [{ label: 'Cancel', value: false }, { label: 'Turn off', value: true, kind: 'danger' }],
});

export const SHOW_WORDS_CONFIRM = Object.freeze({
  title: 'Show the recovery words?',
  message: 'Anyone who sees them can read your data. Make sure no one is looking at your screen.',
  actions: [{ label: 'Cancel', value: false }, { label: 'Show', value: true, kind: 'primary' }],
});

const STATE_TEXT = { off: 'Off', syncing: 'Syncing…', ok: 'Up to date', offline: 'Offline', error: 'Error' };

/** The status line for a status from the engine: "Up to date", "Offline", "Error: …". */
export function statusText(status) {
  const text = STATE_TEXT[status?.state] ?? 'Off';
  if (status?.state === 'error' && status.lastError) return `${text}: ${status.lastError}`;
  if (status?.state === 'ok' && status.lastError) return `${text}. ${status.lastError}`;
  return text;
}

/** The hint under "Sync between devices" in Settings. */
export function summaryText(info, status) {
  if (info?.paired && info.keyUnavailable) return 'Needs the 12 words on this device';
  if (!info?.paired) return 'Off';
  if (!info.enabled) return 'Paused on this device';
  return `On · ${STATE_TEXT[status?.state] ?? 'Off'}`;
}
