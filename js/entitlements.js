// What this copy of Peek Budget unlocks. The only place the app asks "is Pro on?", so a real
// purchase can be wired in here later without touching the rest of the app.
//
// Pro is cosmetic only: emoji icons, automatic logos and colour palettes. Never gate data,
// export/import, reminders or the biometric lock (the last two don't exist yet; keep them free).
//
// - Web (the PWA): always Pro.
// - Android: Basic, unless a debuggable build has the debug flag on.
//   TODO(purchase): also return true here once a store purchase is verified.

import * as storage from './storage.js';
import { isNative } from './platform.js';

let debugFlag = false;
const listeners = new Set();

/** True in Android builds made with `assembleDebug` (Capacitor sets DEBUG from FLAG_DEBUGGABLE). */
export function isDebugBuild() {
  return isNative() && globalThis.Capacitor?.DEBUG === true;
}

/** Whether the cosmetic Pro features are unlocked. Synchronous; call initEntitlements() first. */
export function isPro() {
  if (!isNative()) return true;
  // The flag only counts in debug builds, so a release build can never be unlocked by it.
  return isDebugBuild() && debugFlag;
}

/** Read the stored debug flag. Pass already-loaded settings to avoid a second read. */
export async function initEntitlements(settings) {
  const s = settings ?? await storage.getSettings();
  debugFlag = s[storage.DEBUG_PRO_SETTING] === true;
}

/**
 * Turn the debug flag on or off (Pro screen toggle in debug builds, and tests). Stored in
 * settings under storage.DEBUG_PRO_SETTING, which backups never include.
 */
export async function setProForTesting(on) {
  const before = isPro();
  debugFlag = Boolean(on);
  await storage.saveSettings({ [storage.DEBUG_PRO_SETTING]: debugFlag });
  if (isPro() !== before) notify();
}

/** Call fn(isPro) whenever the Pro state changes. Returns a function that removes the listener. */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  const pro = isPro();
  for (const fn of listeners) {
    try { fn(pro); } catch (err) { console.error(err); }
  }
}
