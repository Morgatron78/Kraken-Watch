const CACHE = 'kraken-watch-v2.63';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=2.63',
  './app.js?v=2.63',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls — always go to the network so data stays live
  // rather than serving a stale cached copy.
  if (url.hostname.includes('octopus.energy') || url.hostname.includes('googleapis.com')) {
    return;
  }

  // Navigation requests (index.html) — network-first. index.html has no
  // cache-busting query string like styles.css/app.js do, so under a pure
  // cache-first strategy a stale cached copy could keep being served
  // indefinitely, even after a new service worker version activates and
  // the JS layer (version footer etc.) has already updated. Falls back to
  // the cache only when actually offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          caches.open(CACHE).then(cache => cache.put(event.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (static assets): cache-first, falling back to network.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
