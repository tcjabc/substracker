// The hidden developer sync screen in Settings: relay URL, household key, enable, status, Sync now
// and Disconnect. Opened with ?dev=1 in the URL or 7 taps on the version line; never shown otherwise.
// There's no pairing UI yet; the key is pasted or generated here.

import { generateKey, parseKey } from './crypto.js';
import { normalizeRelayUrl } from './sync.js';

const $ = (sel) => document.querySelector(sel);

const STATE_TEXT = {
  off: 'Off',
  syncing: 'Syncing…',
  ok: 'Up to date',
  offline: 'Offline',
  error: 'Error',
};

function when(ms) {
  if (!ms) return 'Never';
  const d = new Date(ms);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/**
 * Wire up the screen. `engine` is the sync engine, or null when sync can't run on this device
 * (for example while storage is on a fallback copy). `ui` provides the app's toast, confirmDialog
 * and setTab helpers.
 */
export function initSyncScreen({ engine, storage, ui, unavailable = '' }) {
  const section = $('#dev-sync');
  const relay = $('#dev-relay');
  const key = $('#dev-key');
  const enabled = $('#dev-enabled');
  const error = $('#dev-error');
  let savedKey = '';

  const reveal = () => {
    section.hidden = false;
    ui.setTab('settings');
    section.scrollIntoView({ block: 'start' });
  };

  // ?dev=1, or 7 taps on the version line within a few seconds.
  if (new URLSearchParams(location.search).get('dev') === '1') section.hidden = false;
  let taps = 0;
  let tapTimer;
  $('#app-version').addEventListener('click', () => {
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 3000);
    if (++taps >= 7) { taps = 0; reveal(); }
  });

  const showStatus = (s) => {
    const text = STATE_TEXT[s.state] ?? s.state;
    $('#dev-status').textContent = s.lastError ? `${text}: ${s.lastError}` : text;
    $('#dev-pending').textContent = String(s.pendingCount ?? 0);
    $('#dev-last').textContent = when(s.lastSyncedAt);
  };

  if (!engine) {
    $('#dev-status').textContent = unavailable || 'Sync is not available on this device.';
    for (const id of ['#dev-save', '#dev-sync-now', '#dev-disconnect', '#dev-key-generate', '#dev-enabled']) $(id).disabled = true;
    return;
  }

  const load = async () => {
    try {
      const cfg = await storage.getSyncConfig();
      relay.value = cfg.relayUrl;
      key.value = cfg.householdKey;
      enabled.checked = cfg.enabled;
      savedKey = cfg.householdKey;
    } catch (err) {
      error.textContent = err.message;
    }
  };
  load();
  showStatus(engine.getStatus());
  engine.onStatus(showStatus);

  $('#dev-key-show').addEventListener('click', (e) => {
    const show = key.type === 'password';
    key.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide key' : 'Show key';
    e.currentTarget.setAttribute('aria-pressed', String(show));
  });

  $('#dev-key-generate').addEventListener('click', async () => {
    if (key.value.trim()) {
      const ok = await ui.confirmDialog({
        title: 'Replace the household key?',
        message: 'Devices that use the current key will stop syncing with this one. Copy the new key to each device you want in the household.',
        actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, kind: 'danger' }],
      });
      if (!ok) return;
    }
    key.value = generateKey();
    key.type = 'text';
    $('#dev-key-show').textContent = 'Hide key';
    error.textContent = '';
    ui.toast('New key generated. Save to use it.');
  });

  $('#dev-save').addEventListener('click', async () => {
    error.textContent = '';
    const url = relay.value.trim();
    const k = key.value.trim();
    if (url && !normalizeRelayUrl(url)) { error.textContent = 'Use an https:// relay URL (http:// only for localhost).'; relay.focus(); return; }
    if (k) { try { parseKey(k); } catch (err) { error.textContent = err.message; key.focus(); return; } }
    if (enabled.checked && (!url || !k)) { error.textContent = 'Sync needs a relay URL and a household key.'; return; }
    if (savedKey && k !== savedKey) {
      const ok = await ui.confirmDialog({
        title: 'Switch household?',
        message: "This device will stop syncing with the old household and send all its items to the new one.",
        actions: [{ label: 'Cancel', value: false }, { label: 'Switch', value: true, kind: 'primary' }],
      });
      if (!ok) return;
    }
    await engine.configure({ relayUrl: url ? normalizeRelayUrl(url) : '', householdKey: k, enabled: enabled.checked });
    savedKey = k;
    relay.value = url ? normalizeRelayUrl(url) : '';
    ui.toast(enabled.checked ? 'Sync settings saved.' : 'Sync settings saved. Sync is off.');
  });

  $('#dev-sync-now').addEventListener('click', () => engine.syncNow());

  $('#dev-disconnect').addEventListener('click', async () => {
    const ok = await ui.confirmDialog({
      title: 'Disconnect this device?',
      message: 'Syncing stops and the household key is removed from this device. Your items stay here. To join again you need the key from another device.',
      actions: [{ label: 'Cancel', value: false }, { label: 'Disconnect', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    await engine.disconnect();
    key.value = '';
    key.type = 'password';
    enabled.checked = false;
    savedKey = '';
    ui.toast('Disconnected. Your items are still on this device.');
  });
}
