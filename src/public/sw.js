const CACHE = 'tix-v1.1.58';

// Static assets to cache on install
const PRECACHE = [
  '/css/style.css',
  '/js/tix.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept SSE, API, or POST requests
  if (
    url.pathname === '/events' ||
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/tickets/attachments')
  ) {
    return;
  }

  // CSS/JS: cache-first
  if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
    return;
  }

  // HTML pages: always fetch from network, never cache
  // (data changes too frequently; offline mode isn't useful for a live ticketing app)
});
