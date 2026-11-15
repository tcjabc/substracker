// Native (Capacitor) detection and plugin access. The web build never loads Capacitor code:
// inside the native app the bridge injects `window.Capacitor`, including a proxy for every
// installed native plugin. On the web none of that exists, so everything here returns
// "not native" / null and callers fall back to web behaviour.

const cap = () => globalThis.Capacitor;

/** True only inside the native app (feature-detected, never from the user agent). */
export function isNative() {
  try { return Boolean(cap()?.isNativePlatform?.()); } catch { return false; }
}

/** The native plugin called `name` (e.g. "Filesystem"), or null on the web or if it isn't installed. */
export function plugin(name) {
  if (!isNative()) return null;
  const c = cap();
  if (c.isPluginAvailable && !c.isPluginAvailable(name)) return null;
  return c.Plugins?.[name] ?? null;
}

/** Status-bar icons to suit the app's background: light icons on dark, dark icons on light. */
export async function setStatusBarStyle(darkBackground) {
  const bar = plugin('StatusBar');
  if (!bar) return;
  try { await bar.setStyle({ style: darkBackground ? 'DARK' : 'LIGHT' }); } catch { /* not fatal */ }
}
