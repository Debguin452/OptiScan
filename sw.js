/**
 * OptiScan Pro -- Service Worker (Fix 13: PWA / offline support)
 *
 * Strategy: cache-first for all static assets, network-first for
 * navigation requests (so updates are picked up promptly).
 *
 * On install:   pre-cache all assets listed in STATIC_ASSETS.
 * On activate:  delete old caches from previous versions.
 * On fetch:     serve cached asset or fall back to network.
 *
 * To bust the cache after a code update, increment CACHE_VERSION.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME    = `optiscan-${CACHE_VERSION}`;

/* Assets to pre-cache on install. Paths are relative to the SW scope. */
const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './camera.js',
  './optics.js',
  './ui.js',
  './style.css',
  './sharpness.wasm',
];

/* ---- Install: pre-cache all static assets ---- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())   /* activate immediately, don't wait for old SW to retire */
  );
});

/* ---- Activate: clean up old cache versions ---- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('optiscan-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())  /* take control of existing pages */
  );
});

/* ---- Fetch: cache-first for static assets ---- */
self.addEventListener('fetch', event => {
  const { request } = event;

  /* Only handle GET requests */
  if (request.method !== 'GET') return;

  /* Skip cross-origin requests (e.g., CDN fonts, analytics) */
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      /* Not in cache: fetch from network and cache the response */
      return fetch(request).then(response => {
        /* Only cache successful opaque-or-basic responses */
        if (!response || response.status !== 200 || response.type === 'error') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, toCache));
        return response;
      }).catch(() => {
        /* Network unavailable and not in cache: return a simple offline page
           only for navigation requests (HTML), not for sub-resources. */
        if (request.headers.get('accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});
