// Settings → This device → Erase data on this device (1.28.0): when it may run, what it may touch, and
// the order of its steps, with no DOM and no storage of its own, so Node tests cover all of it
// (tests/erase.node.test.js). js/app.js draws the sheet and passes in the real steps: the sync
// engine, js/storage.js, the phone's secure store, Cache Storage and the native Filesystem.
//
// The erase reaches this device only. It never writes a record or an op: the database is deleted
// whole (storage.eraseDatabase), so nothing can ever be sent to another device as a deletion, and it
// is refused while this device can sync (eraseBlock). The app may share its origin with other sites
// (every project page on the same GitHub Pages host, the test pages on localhost), so it names only
// what is its own: its database, the `substracker.` localStorage prefix, the logo cache and its own
// cached export files. Never localStorage.clear(), indexedDB.databases() or every cache.
// Nothing is left behind to resume an erase on the next launch: a launch never erases anything.

/** The localStorage prefix of this app's per-device preferences (js/storage.js getPref, js/i18n.js). */
export const PREF_PREFIX = 'substracker.';

/** The service worker's logo cache (sw.js LOGO_CACHE): favicons of the items' domains. */
export const LOGO_CACHE = 'substracker-logos';

/** The BroadcastChannel other open tabs of this app listen on, so none of them writes after an erase. */
export const ERASE_CHANNEL = 'substracker-erase';

/** A cached export file (js/files.js, Android) is deleted only once it's older than this: a share may still be reading it. */
export const EXPORT_MAX_AGE_MS = 10 * 60_000;

// The names js/app.js gives exported files: substracker-YYYY-MM-DD.json (backup) or .csv.
const EXPORT_NAME = /^substracker-\d{4}-\d{2}-\d{2}\.(json|csv)$/;

/**
 * Why the erase can't run now, or null when it can:
 *   'sync'    this device can sync: it is in a household and can read its key (the erase must never
 *             reach the other devices, so sync is turned off first);
 *   'unknown' sync could run here but its status couldn't be read.
 * `syncAvailable` is false where sync can't run at all (no engine: an older store still in use), and
 * `status` is the key-free summary of js/secure-key.js status(). A device in a household whose key
 * can't be read (keyUnavailable) can't send anything, so it may erase.
 */
export function eraseBlock({ syncAvailable = false, status = null, statusFailed = false } = {}) {
  if (!syncAvailable) return null;
  if (statusFailed || !status) return 'unknown';
  return status.paired && !status.keyUnavailable ? 'sync' : null;
}

/** The keys among `keys` that are this app's own preferences (the `substracker.` prefix only). */
export const ownPrefKeys = (keys) => [...keys].filter((k) => typeof k === 'string' && k.startsWith(PREF_PREFIX));

/**
 * The cached export files to delete (names), from a Filesystem readdir listing: this app's own export
 * names only, files only, and only those modified more than EXPORT_MAX_AGE_MS before `now`.
 */
export function staleExports(files, now) {
  return (Array.isArray(files) ? files : [])
    .filter((f) => f && f.type !== 'directory' && typeof f.name === 'string' && EXPORT_NAME.test(f.name)
      && Number.isFinite(f.mtime) && now - f.mtime > EXPORT_MAX_AGE_MS)
    .map((f) => f.name);
}

/** The steps, in order. runErase runs them in this order and no other. */
export const ERASE_STEPS = Object.freeze(['stop', 'database', 'secure', 'prefs', 'logos', 'exports', 'reload']);

/** The steps whose failure is reported to the person ("some settings could not be reset"). Exports are ignored. */
const REPORTED = ['secure', 'prefs', 'logos'];

/**
 * Run the erase with `steps`, one function per step of ERASE_STEPS (a missing one is skipped, except
 * `database`):
 *   stop()                  stop the sync engine (its timers and socket); best effort
 *   database({ onBlocked }) guard storage, close and delete this app's database. Rejects when it could
 *                           not be deleted; while another tab or window holds it, calls onBlocked and waits.
 *   secure(), prefs(), logos(), exports()   best effort, in this order
 *   reload()                open the app again, as a fresh first launch
 * `beforeReload(result)` runs between the last step and the reload (the "could not be reset" note).
 * Resolves { outcome, failed }: 'failed' when the database was not deleted (nothing was erased, no
 * reload, and it may simply run again), else 'erased' or 'partial' (failed names the steps).
 */
export async function runErase(steps, { onBlocked = () => {}, beforeReload = async () => {} } = {}) {
  try { steps.stop?.(); } catch { /* stopping is best effort: this device can't sync anyway (eraseBlock) */ }
  if (typeof steps.database !== 'function') return { outcome: 'failed', failed: ['database'] };
  try {
    await steps.database({ onBlocked });
  } catch {
    return { outcome: 'failed', failed: ['database'] };
  }
  const failed = [];
  for (const name of ['secure', 'prefs', 'logos', 'exports']) {
    try { await steps[name]?.(); } catch { if (REPORTED.includes(name)) failed.push(name); }
  }
  const result = { outcome: failed.length ? 'partial' : 'erased', failed };
  try { await beforeReload(result); } catch { /* the reload still follows */ }
  steps.reload?.();
  return result;
}
