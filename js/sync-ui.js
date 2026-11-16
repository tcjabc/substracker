// The hidden developer sync screen in Settings: relay URL override, household key, enable, status,
// Sync now and Disconnect. Opened with ?dev=1 in the URL or 7 taps on the version line; never shown
// otherwise. People set sync up in the Sync sheet (js/sync-sheet.js); this screen is for debugging,
// and the only place the relay URL can be changed (empty = DEFAULT_RELAY_URL).
// The key goes through js/secure-key.js and is never put in the page unless Show key is tapped;
// an empty key field on Save keeps the stored key.

import { generateKey, parseKey } from './crypto.js';
import { normalizeRelayUrl, DEFAULT_RELAY_URL } from './sync.js';

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
export function initSyncScreen({ engine, vault, ui, unavailable = '' }) {
  const section = $('#dev-sync');
  const relay = $('#dev-relay');
  const key = $('#dev-key');
  const enabled = $('#dev-enabled');
  const error = $('#dev-error');

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
    return { reload() {} };
  }
  relay.placeholder = `${DEFAULT_RELAY_URL} (default)`;

  const keyShow = $('#dev-key-show');
  const keyStore = $('#dev-key-store');
  let hasKey = false; // a key is stored on this device (it is never put in the field unless Show key)
  let revealed = false;

  const hideKey = () => {
    if (revealed) key.value = '';
    revealed = false;
    key.type = 'password';
    keyShow.textContent = 'Show key';
    keyShow.setAttribute('aria-pressed', 'false');
  };

  const STORE_TEXT = { 'native-secure': 'Android Keystore / iOS Keychain', 'web-indexeddb': 'IndexedDB (this browser)' };
  const load = async () => {
    try {
      const st = await vault.status();
      relay.value = st.relayUrl;
      enabled.checked = st.enabled;
      hasKey = st.paired && !st.keyUnavailable;
      hideKey();
      key.value = '';
      key.placeholder = st.keyUnavailable ? 'The stored key cannot be read here' : hasKey ? 'A key is stored (hidden)' : '22 characters';
      const where = st.keyLocation === 'secure' ? STORE_TEXT['native-secure'] : 'IndexedDB';
      keyStore.textContent = `Key storage: ${vault.kind} (${hasKey || st.keyUnavailable ? `key in ${where}` : 'no key'}; migration: ${vault.migration})`;
    } catch (err) {
      error.textContent = err.message;
    }
  };
  load();
  showStatus(engine.getStatus());
  engine.onStatus(showStatus);

  keyShow.addEventListener('click', async () => {
    if (key.type === 'text') { hideKey(); return; }
    if (!key.value.trim() && hasKey) {
      try { key.value = await vault.get(); revealed = true; } catch { error.textContent = 'The stored key cannot be read on this device.'; return; }
    }
    key.type = 'text';
    keyShow.textContent = 'Hide key';
    keyShow.setAttribute('aria-pressed', 'true');
  });

  $('#dev-key-generate').addEventListener('click', async () => {
    if (key.value.trim() || hasKey) {
      const ok = await ui.confirmDialog({
        title: 'Replace the household key?',
        message: 'Devices that use the current key will stop syncing with this one. Copy the new key to each device you want in the household.',
        actions: [{ label: 'Cancel', value: false }, { label: 'Replace', value: true, kind: 'danger' }],
      });
      if (!ok) return;
    }
    key.value = generateKey();
    revealed = false;
    key.type = 'text';
    keyShow.textContent = 'Hide key';
    error.textContent = '';
    ui.toast('New key generated. Save to use it.');
  });

  $('#dev-save').addEventListener('click', async () => {
    error.textContent = '';
    const url = relay.value.trim();
    const k = revealed ? '' : key.value.trim(); // an unchanged revealed key is "keep the stored one"
    if (url && !normalizeRelayUrl(url)) { error.textContent = 'Use an https:// relay URL (http:// only for localhost).'; relay.focus(); return; }
    if (k) { try { parseKey(k); } catch (err) { error.textContent = err.message; key.focus(); return; } }
    if (enabled.checked && !k && !hasKey) { error.textContent = 'Sync needs a household key.'; return; }
    let current = '';
    if (k && hasKey) { try { current = await vault.get(); } catch { /* unreadable: treat as different */ } }
    if (k && hasKey && k !== current) {
      const ok = await ui.confirmDialog({
        title: 'Switch household?',
        message: "This device will stop syncing with the old household and send all its items to the new one.",
        actions: [{ label: 'Cancel', value: false }, { label: 'Switch', value: true, kind: 'primary' }],
      });
      if (!ok) return;
    }
    current = '';
    const patch = { relayUrl: url ? normalizeRelayUrl(url) : '', enabled: enabled.checked };
    if (k) patch.householdKey = k; // an empty field keeps the stored key
    await engine.configure(patch);
    ui.onConfigChanged?.();
    await load();
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
    ui.onConfigChanged?.();
    await load();
    ui.toast('Disconnected. Your items are still on this device.');
  });

  return {
    /** Re-read the fields (after the Sync sheet changed the config). */
    reload() { return load(); },
  };
}
