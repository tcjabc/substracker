import { esc, hash } from './util.js';

const AVATAR_COLOURS = 8; // matches --avatar-1 … --avatar-8 in app.css

export const faviconUrl = (domain) =>
  `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;

/**
 * Logo markup. A chosen emoji wins and sits on a neutral tile. Otherwise a coloured initial
 * sits underneath and the favicon fades in on top only if it loads at a usable size.
 * Offline or unknown domains keep the initial.
 */
export function logoHTML(sub, size = 'md', { neutral = false, defer = false } = {}) {
  const tone = neutral ? ' logo-neutral' : '';
  if (sub.emoji) {
    return `<span class="logo logo-${size} logo-emoji${tone}" aria-hidden="true">${esc(sub.emoji)}</span>`;
  }
  const name = (sub.name || '?').trim();
  const initial = esc([...name][0]?.toUpperCase() || '?');
  const colour = (hash(name.toLowerCase()) % AVATAR_COLOURS) + 1;
  // defer: the address waits in data-src until loadDeferredLogos() (the Wallet loads a card's
  // logos only once it is on or near the screen).
  const src = sub.domain ? esc(faviconUrl(sub.domain)) : '';
  const img = src
    ? `<img class="logo-img" ${defer ? 'data-src' : 'src'}="${src}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : '';
  // neutral: a plain tile (the Wallet puts logos on coloured cards, where a coloured initial would clash).
  const style = neutral ? '' : ` style="--logo-bg: var(--avatar-${colour})"`;
  return `<span class="logo logo-${size}${tone}"${style} aria-hidden="true"><span class="logo-initial">${initial}</span>${img}</span>`;
}

/** Start loading the deferred logos inside `root` (see logoHTML's `defer`). */
export function loadDeferredLogos(root) {
  root.querySelectorAll('img.logo-img[data-src]').forEach((img) => {
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  });
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
