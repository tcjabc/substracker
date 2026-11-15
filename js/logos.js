import { esc, hash } from './util.js';
import { isPro } from './entitlements.js';

const AVATAR_COLOURS = 8; // matches --avatar-1 … --avatar-8 in app.css

export const faviconUrl = (domain) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

/**
 * Logo markup. With Pro, a chosen emoji wins and sits on a neutral tile; otherwise a coloured
 * initial sits underneath and the favicon fades in on top only if it loads at a usable size.
 * Offline or unknown domains keep the initial. Basic always shows the initial (and so never
 * contacts the favicon service); the item keeps its emoji and domain either way.
 */
export function logoHTML(sub, size = 'md') {
  const pro = isPro();
  if (pro && sub.emoji) {
    return `<span class="logo logo-${size} logo-emoji" aria-hidden="true">${esc(sub.emoji)}</span>`;
  }
  const name = (sub.name || '?').trim();
  const initial = esc([...name][0]?.toUpperCase() || '?');
  const colour = (hash(name.toLowerCase()) % AVATAR_COLOURS) + 1;
  const img = pro && sub.domain
    ? `<img class="logo-img" src="${esc(faviconUrl(sub.domain))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : '';
  return `<span class="logo logo-${size}" style="--logo-bg: var(--avatar-${colour})" aria-hidden="true"><span class="logo-initial">${initial}</span>${img}</span>`;
}

// One capturing listener handles every logo on the page, however it was rendered.
export function initLogoHandling(root = document) {
  root.addEventListener('load', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('logo-img')) return;
    // Google returns a 16px generic globe for unknown domains; treat that as "no logo".
    if (img.naturalWidth && img.naturalWidth < 32) img.remove();
    else img.parentElement?.classList.add('has-img');
  }, true);
  root.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.classList.contains('logo-img')) img.remove();
  }, true);
}
