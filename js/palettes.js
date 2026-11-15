// Accent palettes. The colours live in css/app.css ("Accent palettes"); this is the list the
// Settings picker shows. Indigo is the default and free; the others are Pro (see entitlements.js).
// The choice is a per-device preference like the theme, so backups don't include it.

export const DEFAULT_PALETTE = 'indigo';

export const PALETTES = [
  { id: 'indigo', name: 'Indigo', pro: false },
  { id: 'ocean', name: 'Ocean', pro: true },
  { id: 'teal', name: 'Teal', pro: true },
  { id: 'sunset', name: 'Sunset', pro: true },
  { id: 'berry', name: 'Berry', pro: true },
  { id: 'plum', name: 'Plum', pro: true },
  { id: 'graphite', name: 'Graphite', pro: true },
];

export const findPalette = (id) => PALETTES.find((p) => p.id === id) ?? null;

/** Show a palette on the page. Doesn't save anything. */
export function applyPalette(id) {
  const root = document.documentElement;
  if (!findPalette(id) || id === DEFAULT_PALETTE) delete root.dataset.palette;
  else root.dataset.palette = id;
}
