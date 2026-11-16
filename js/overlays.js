// The open overlays (sheets, dialogs, sub-steps, popovers, the year chart's focus mode), topmost
// last, and what the Android Back button does with them. Every overlay registers itself when it
// opens and unregisters when it closes, however it closes. Back closes only the topmost one, through
// the same function as its own Cancel / X, so its guards and clean-up still run.
// No DOM here, so Node tests cover the logic (tests/overlays.node.test.js).

/**
 * A stack of open overlays. open(id, { close, isOpen, isShown }) puts `id` on top (moving it there
 * if it's already open); remove(id) takes it off wherever it is. Removing twice is harmless.
 *   close()   the overlay's own Cancel / X path. It removes the entry when it really closes, and
 *             may refuse (for example while a sync is running), leaving the overlay open.
 *   isOpen()  optional safety net: false means the overlay is gone without saying so; the entry is
 *             dropped, so Back can never get stuck on something that isn't there.
 *   isShown() optional: false means it's open but out of sight (on another tab); Back skips it.
 */
export function createOverlayStack() {
  let entries = [];
  const alive = (e) => {
    try { return e.isOpen ? e.isOpen() !== false : true; } catch { return false; }
  };
  const shown = (e) => {
    try { return e.isShown ? e.isShown() !== false : true; } catch { return true; }
  };
  const prune = () => { entries = entries.filter(alive); };

  const stack = {
    open(id, { close, isOpen, isShown } = {}) {
      entries = entries.filter((e) => e.id !== id);
      entries.push({ id, close, isOpen, isShown });
    },
    remove(id) { entries = entries.filter((e) => e.id !== id); },
    has(id) { prune(); return entries.some((e) => e.id === id); },
    /** Ids of the open overlays, bottom first. */
    ids() { prune(); return entries.map((e) => e.id); },
    /** The topmost overlay Back would close, or null. */
    top() {
      prune();
      for (let i = entries.length - 1; i >= 0; i--) if (shown(entries[i])) return entries[i].id;
      return null;
    },
    /**
     * Close the topmost overlay through its own close path. Resolves nothing; returns
     * 'closed' (it's gone), 'kept' (its close path refused, e.g. busy) or null (none open).
     */
    closeTop() {
      const id = stack.top();
      if (id === null) return null;
      const entry = entries.find((e) => e.id === id);
      try {
        entry.close?.();
      } catch (err) {
        console.error(err);
      }
      if (!alive(entry)) stack.remove(id);
      return entries.includes(entry) ? 'kept' : 'closed';
    },
    /** Close every overlay, topmost first. Stops at one that refuses, which stays open. */
    closeAll() {
      for (let guard = entries.length + 1; guard > 0; guard--) {
        const r = stack.closeTop();
        if (r !== 'closed') return r === null;
      }
      return stack.top() === null;
    },
    /** Forget every entry without closing anything (tests). */
    clear() { entries = []; },
  };
  return stack;
}

/**
 * What Back does: close the topmost overlay; with none open, go to the root tab; on the root tab
 * with nothing open, leave the app (`minimize`). Never leaves while an overlay is open, even one
 * that refuses to close. Returns 'closed', 'kept', 'root' or 'minimize'.
 */
export function createBackHandler({ stack, getTab, goRoot, minimize, rootTab = 'subs' }) {
  return function back() {
    const r = stack.closeTop();
    if (r) return r;
    if (getTab() !== rootTab) { goRoot(); return 'root'; }
    minimize();
    return 'minimize';
  };
}

/** The app's one overlay stack. */
export const overlays = createOverlayStack();

let backHandler = null;
/** Set by js/app.js once the tabs exist. */
export function setBackHandler(fn) { backHandler = fn; }
/** What the native backButton listener calls (and the tests). Returns the handler's result. */
export function pressBack() { return backHandler ? backHandler() : 'none'; }
