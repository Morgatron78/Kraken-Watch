const CACHE = 'kraken-watch-v2.13';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=2.13',
  './app.js?v=2.13',
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

  // Never cache API calls, or the EV status file (now fetched cross-origin
  // from raw.githubusercontent.com/.../state branch) — always go to the
  // network so data stays live rather than serving a stale cached copy.
  if (url.hostname.includes('octopus.energy') || url.hostname.includes('googleapis.com') || url.hostname.includes('raw.githubusercontent.com')) {
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

// Push notifications from the EV dispatch checker (see .github/workflows/ev-notify.yml).
// Always shown silently — no sound/vibration — per how this was designed to be used.
self.addEventListener('push', (event) => {
  let data = { title: 'Kraken Watch', body: 'EV status update' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* keep default */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      silent: true,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'ev-status' // replaces any previous EV notification rather than stacking
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
