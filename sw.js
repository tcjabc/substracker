// Service worker: precaches the app shell so SubsTracker works fully offline.
// Bump VERSION whenever any shell file changes so clients pick up the update.
const VERSION = 'v1.11.0';
const SHELL_CACHE = `substracker-shell-${VERSION}`;
const LOGO_CACHE = 'substracker-logos';
const LOGO_LIMIT = 200;
// three.js (js/three.module.min.js, about 690 KB) is not in the shell: only the Insights Ring uses it, so
// it is cached the first time the Ring loads it (RUNTIME below), in a cache named for its release so app
// updates don't fetch it again. Offline before that first use, the Ring falls back to the flat donut.
const THREE_CACHE = 'substracker-three-r170';
const RUNTIME = ['./js/three.module.min.js'];

// Relative to the worker's location, so this works at / and at /substracker/.
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/storage.js',
  './js/sync-core.js',
  './js/crypto.js',
  './js/secure-key.js',
  './js/wordlist.js',
  './js/words.js',
  './js/sync.js',
  './js/sync-ui.js',
  './js/sync-sheet.js',
  './js/pairing.js',
  './js/qrcode.js',
  './js/qr-scan.js',
  './js/jsqr.js',
  './js/files.js',
  './js/platform.js',
  './js/overlays.js',
  './js/services.js',
  './js/logos.js',
  './js/util.js',
  './js/insights-calc.js',
  './js/year-chart-math.js',
  './js/year-chart.js',
  './js/donut-math.js',
  './js/donut-flat.js',
  './js/donut-3d.js',
  './js/import-ai.js',
  './js/import-ai-prompt.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => (k.startsWith('substracker-shell-') && k !== SHELL_CACHE)
        || (k.startsWith('substracker-three-') && k !== THREE_CACHE)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Favicon logos: serve from cache, refresh in the background.
  if (url.hostname === 'www.google.com' && url.pathname.startsWith('/s2/favicons')) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Navigations to the app itself: the cached shell, so it opens offline. Other pages in scope
  // (such as tests/storage.html) go to the network.
  if (req.mode === 'navigate') {
    const root = new URL(self.registration.scope).pathname;
    if (url.pathname !== root && url.pathname !== `${root}index.html`) return;
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      return (await cache.match('./index.html')) || fetch(req);
    })());
    return;
  }

  // three.js: cache first; fetched and kept the first time it's needed.
  if (RUNTIME.some((p) => url.pathname === new URL(p, self.location).pathname)) {
    event.respondWith(cacheOnFirstUse(req));
    return;
  }

  // Everything else same-origin: cache first, then network.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req))
  );
});

async function cacheOnFirstUse(req) {
  const cache = await caches.open(THREE_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req); // offline: this rejects and the import fails, so the flat donut shows
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(LOGO_CACHE);
  const cached = await cache.match(req);
  const network = fetch(req, { mode: 'no-cors', credentials: 'omit' })
    .then(async (res) => {
      // Opaque (no-cors) responses report status 0; keep them, they render fine in <img>.
      if (res && (res.ok || res.type === 'opaque')) {
        await cache.put(req, res.clone());
        trimCache(cache);
      }
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function trimCache(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - LOGO_LIMIT; i++) await cache.delete(keys[i]);
}
